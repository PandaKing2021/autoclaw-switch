# AutoClaw → ZCode 反代：最终报告（2026-10-05）

## 最终状态：✅ 端到端跑通并在 ZCode 中可用

`ZCode（Anthropic 协议） → relay 127.0.0.1:18766（raw https） → AutoClaw 2.x acceleration 网关 → 200`

实测通过：真实 ZCode 会话（38KB / 81 消息）、小请求、流式与非流式、thinking 块、GLM-5.3 与 GLM-5.3-Flash 双路由、工具透传。

## 根因分析（终版）：406 闸门的完整判定条件

经过 ~30 组对照实验，2.x 网关 WAF 的放行条件为以下五项**同时**满足：

1. **传输层**：必须是"干净"的 HTTP/1.1 客户端指纹。Node 的 undici fetch（自动附加 `sec-fetch-mode`/`accept-language`/`accept-encoding`，且 TLS ClientHello 特征不同）会被拦；`node:https` 原生请求稳定通过。应用（Electron 内置 undici v6，无这些自动头）因此正常。
2. **OpenAI SDK 指纹头**：`user-agent: OpenAI/JS 6.26.0` + 全套 `x-stainless-*` + `x-agent-id: main`（应用由 openai npm SDK 自动附加）。
3. **`X-Session-Id` 会话头**：2.x 新增要求，缺失即 406。
4. **`system` 消息必须与应用 persona 完全一致**（最关键、最隐蔽的一条）：system 原样为应用的 "You are AutoClaw. ..."（3099 字节）→ 200；在此之上合并任何额外内容（哪怕只加一行 ZCode 的 system）→ 406；完全没有 system → 406。这是 1.x "harness 标记" 机制在 2.x 的进化形态。
5. **请求体参数对齐应用**：`reasoning_effort: "high"`（low 被拒）、`max_completion_tokens: 307200`（模型满额）、`store: false`、`body.model` 保留带前缀目录名。

曾被证伪的假说：时间窗/IP 风控冷却（实为 body 判据的误读）、边缘节点轮换（单一 IP 39.107.195.74）、TLS 指纹（Electron 运行时同样 406）、请求头顺序（两种顺序均 200）、temperature、工具数量与名称、合成文本填充（反而被识别，已停用）。

## 定位方法论（供未来复用）

1. `ELECTRON_RUN_AS_NODE=1 AutoClaw2.exe` 排除 TLS 栈差异
2. UI 自动化（AppActivate + 鼠标点击 + SendKeys）触发应用真实请求，`--require` 钩子（打包版 Electron 忽略 NODE_OPTIONS，改为直接向 `main.cjs` 顶部注入 require，抓完还原）捕获真实 wire format
3. 同分钟 A/B：113KB 应用原始 body vs 198B 小 body，一开一关，锁定 body 判据
4. 从"必过"的应用 body 出发做减法二分：Y3（消息替换）→ 406 定位到 messages；W1/W2/T3 三方对照定位到 system 内容

## relay 修复清单（~/.autoclaw-relay/server.mjs，AUTOCLAW_CONTRACT=2x 门控）

| # | 修复 |
|---|---|
| 1 | 云通道传输层 undici fetch → node:https 原生 shim（含 SSE 流式/超时/中断/headers 语义，修复 text() 快响应挂起） |
| 2 | 注入 OpenAI SDK 指纹头 + X-Session-Id |
| 3 | body.model 保留带前缀目录名；max_tokens → max_completion_tokens（307200 满额）；store:false；reasoning_effort 固定 high |
| 4 | **system 整体替换为应用 persona**（persona.txt，3099B）；ZCode 原有 system 挪到首条 user 消息作 `[system-note]` 上下文（Anthropic 与 OpenAI 双路径） |
| 5 | DPAPI 凭证桥接（2.x account-credentials.enc → auth.json） |
| 6 | 406 跨窗退避重试（7 次 ~5min）+ 810001 纳入瞬时限流重试 |
| 7 | ZCode 供应商注册更新为 2.x 模型目录（GLM-5.3 / GLM-5.3-Flash / Auto / Auto-Fast） |

## 使用

1. **重启 ZCode 后**在模型选择器选 **AutoClaw / GLM-5.3-Flash**（或 GLM-5.3），直接对话。
2. relay 拉起命令（机器重启后）：
   ```
   AUTOCLAW_CONTRACT=2x AUTOCLAW_CLOUD_LANE=cn AUTOCLAW_CLIENT_VERSION=2.0.1 \
   AUTOCLAW_X_CHANNEL=official AUTOCLAW_X_TRACE_ID=autoclaw-desktop \
   AUTOCLAW_HARNESS_MARKER=0 AUTOCLAW_MAX_OUTPUT_TOKENS=0 \
   nohup node ~/.autoclaw-relay/server.mjs >> ~/.autoclaw-relay/relay.log 2>&1 &
   ```
3. 401 时重新登录 AutoClaw 并重跑 `bridge/make_compat_auth.py`。
4. 402「积分不足」为终态错误（等每日赠送或充值）；GLM-5.3-Flash 白天有 810001 高峰限流（夜间 23:00-09:00 畅通），relay 自动退避。

## 桌面控制台（Electron）

`app/` 目录 — 图形化管理客户端（开发依赖 electron@33，经 npmmirror 安装）：

```
cd app && npx electron .
```

功能面板：
- **Relay 卡片**：运行状态/上游通道/uptime/模型别名，启动/停止/连通性测试按钮
- **账号卡片**：积分余额与即将过期（CN 网关按需查询）、token 剩余有效期、凭证指纹、凭证同步器状态与启停
- **ZCode 卡片**：注册状态/接入地址/模型清单，一键重新注册供应商
- **日志查看器**：relay / 同步器 / 控制台三个标签，3 秒自动刷新
- 总状态药丸：relay ✓ + ZCode 注册 ✓ + token 余量 >6h → 绿色「链路正常」

后台服务（relay + 凭证同步器 watch_auth.py）不随窗口关闭而停止；watch_auth.py 启动时写 `~/.autoclaw-relay/watch_auth.pid`，控制台据此识别外部实例。

## 功能测试（2026-10-05 自测模式）

应用内置自测模式（`ASWITCH_SELFTEST=1 npx electron .`），顺序执行全部 IPC 处理器（等同逐个点击按钮），结果写入 `~/.autoclaw-relay/selftest-result.txt`：

```
==== SELFTEST 10/10 ====
status:query ✓  points:refresh ✓  credential:sync ✓  watcher:stop ✓
watcher:start ✓  smoke:test ✓（真实推理 200）  zcode:register ✓（2.x 模型目录）
logs:tail ✓  relay:stop ✓  relay:start ✓
```

生命周期验证：优雅关闭窗口后应用退出、**relay 与同步器作为 detached 后台服务存活**（重启控制台仍可接管管理）。修复过程中处理的边界问题：Windows PID 复用导致 watcher:stop 误杀 relay（现已校验进程名为 python 才执行）；积分查询域名（CN 渠道账号走海外网关返回空，已改 CN）；token 剩余时长显示粒度（<24h 显示小时）。

## 风险声明

逆向非官方接口，仅供学习研究；账号风险自担。全程遵守上游仓库红线（无固定节奏出站、无并发轰炸、限速参数未调大）。AutoClaw 应用本体未做持久修改。

## 产物

- `autoclaw-switch/` 上游仓库 · `bridge/`（桥接、补丁、全部实验脚本、e2e 请求体）
- `~/.autoclaw-relay/` 运行中 relay（含 persona.txt、pad.txt、日志、转储）
- `~/.zcode/v2/provider_config.json` AutoClaw 供应商（备份 .bak-autoclaw）
