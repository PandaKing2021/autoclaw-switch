# A-SWITCH · All-in-One 反代平台

[中文](README.md) · [English](README.en.md) · [1.x 单账号工具发布页](../../releases/latest)

**这个项目做一件事：把四个 AI 客户端的内置额度，变成你本地 IDE 里可以直接选用的模型。**

| 平台 | 额度来源 | 接入方式 | 协议 | 端口 | 模型数* | 工具调用 |
|---|---|---|---|---|---|---|
| **AutoClaw**（智谱 Z.ai） | 账号积分，支持多号池 | 桥接客户端登录态 → 自建 relay | anthropic + openai | 18766 | 6 | ✅ 透传 |
| **WorkBuddy**（腾讯 CodeBuddy） | Free 档每月 100 + 每日 30 积分 | 本地 Go 网关（wb2api） | openai | 7863 | 46 | ✅ 透传 |
| **Trae SOLO CN**（字节） | 免费会话额度 | 离线解密客户端凭证 → 驱动其远端 agent 会话 | openai + anthropic | 18768 | 27 | ❌ 仅文本 |
| **豆包工作**（字节 DoubaoWork） | 客户端内置额度 | CDP 取登录 cookie → 直连 `/chat/completion` | openai（+anthropic） | 18770 | 2（合成） | ❌ 仅文本 |

\* 模型目录随账号动态拉取，表中为 2026-10 本机实测值；豆包的目录在服务端且不可枚举，网关只能给出两个合成条目。

所有组件都跑在 `127.0.0.1`，凭证不离开你的电脑；四个平台在 ZCode 里是四个并列供应商（`autoclaw-glm-provider` / `workbuddy-openai-provider` / `trae-openai-provider` / `doubao-openai-provider`），模型名不冲突，同一个会话里可以自由切换。

## 这是什么 / 不是什么

四个上游都是**消费级 agent 客户端**，不是模型厂商的公开 API。它们各自把自家积分/免费额度消耗在官方客户端里，本项目的反代让 ZCode 之类的标准 IDE 也能吃到这些额度。

- **是**：本地协议翻译层。ZCode 发标准 anthropic/openai 请求 → 网关翻译成各上游的真实协议 → 流式回填。
- **不是**：官方接口。四条链路全部来自对客户端的逆向（凭证存储格式、网关域名、请求头签名、WAF 闸门、会话协议）。上游一旦改版，接入层就要跟着逆向更新——2.x 适配、Trae 的 functions 目录参数、豆包的 SSE 事件语法都是这么来的。
- **代价**：非官方调用有封号风险（AutoClaw 尤其看推理流水的"形状"，见防封一节）；额度计费按各平台自己的规则走。

## 快速开始

```
git clone <本仓库>
cd autoclaw-to-zcode/app
npm install          # 只装 electron 一个依赖（npmmirror 源即可）
npm start
```

打开控制台后**就三步**：

1. **环境体检**：顶栏按钮，只读探测，缺什么会逐项告诉你影响和补法；
2. **一键启动全部**：按依赖顺序拉起四家网关与凭证同步器；
3. **一键注册**：把四个供应商写进 ZCode 的模型目录。

然后**重启 ZCode**，模型列表里就能看到四个平台的模型了。

冷启动加固已做：反代的运行时文件（`~/.autoclaw-relay/server.mjs` 与 `persona.txt`）由控制台自动从 `bridge/` 部署，第一次也是每次点「启动」时都会补齐，不需要手工 cp。

### 前置条件

| 依赖 | 用途 | 缺了会怎样 |
|------|---|---|
| Node.js 18+ | 启动 AutoClaw 反代与 Trae 网关 | 两个「启动」按钮报「relay 需要 Node.js 在 PATH 中」 |
| Python 3.10+ 且 `pip install cryptography` | 一键注册 / 余额查询 / 凭证同步 | 按钮报「未找到可执行文件：python」；缺 cryptography 时同步器 spawn 成功但立刻崩，症状是「点了没反应」 |
| AutoClaw 桌面端已登录 | 反代的凭证来源（2.x 走 `%APPDATA%\AutoClaw-official\`） | 反代能起但没有上游可用 |
| ZCode 已安装并运行过一次 | 「一键注册」的落点 `~/.zcode/v2/provider_config.json` | 提示先装 ZCode 再来注册 |
| Trae SOLO CN 已登录 | Trae 网关凭证（离线解密其登录态） | Trae 卡片显示未启动 |
| 豆包工作已登录 | 豆包网关凭证（CDP 取 cookie。首次需点一次「重启客户端并同步」，之后可只点「同步登录态」） | 卡片显示 cookie 缺失，启动后请求 401 |
| `wb2api.exe` | WorkBuddy 网关本体 | 卡片报缺文件；`*.exe` 不入库，按 `upstream/UPSTREAM-SRC.txt` 自行编译或取 release |

## 桌面控制台（`app/`）

Electron 管理面板，六个卡片 + 顶栏：

- **Relay 卡片**（AutoClaw）：运行状态 / 上游通道 / 运行时长 / 模型别名；启动、停止、连通性测试（真实推理）
- **账号卡片**：积分余额与即将过期（CN 网关按需查询）、token 剩余有效期、凭证同步器状态与启停
- **WorkBuddy 卡片**：网关状态 / 积分 / 账号 / 模型目录；启动、停止、连通性测试
- **Trae 卡片**：网关状态 / 账号 / 凭证到期 / 会话池大小 / 模型目录；启动、停止、连通性测试
- **豆包工作卡片**：网关状态 / cookie 健康度 / 固定会话 / 会话池 / 模型目录；启动、停止、连通性测试、**同步登录态**、**重启客户端并同步**
- **ZCode 卡片**：注册状态 / 四家接入地址与模型数 / 模型清单 / 一键注册（同步模型目录）/ **配置体检**（只读检查 `provider_config.json` 的枚举与必需字段）
- **日志查看器**：反代 / 同步器 / WorkBuddy / Trae / 豆包 / 控制台六标签，自动刷新
- **顶栏**：**一键启动全部**（某项缺前置只影响它自己，失败时自动把体检结果摆出来）与**环境体检**

冷启动时如果服务都没起来，标题栏下方会直接提示点「一键启动全部」。关闭窗口不会停止后台服务（反代、网关与同步器是 detached 常驻进程）。

```
cd app && npm start                     # 启动（等价于 npx electron .）
ASWITCH_SELFTEST=1 npx electron .       # 18 项功能自检（覆盖体检、一键启动、四家连通性与注册）
ASWITCH_SELFTEST=1 ASWITCH_SELFTEST_ONLY="zcode:register" npx electron .   # 只跑指定处理器
node app/test_zcode_config.js           # 配置写入闸门的沙箱回归测试（合成 fixture，12 条用例）
```

结果落盘在 `~/.autoclaw-relay/selftest-result.txt`。注意全量自测会重启 relay，改单个按钮时用定向自测；改完 `app/main.js` 或 `preload.js` 必须重启 electron 进程——运行中的窗口不会热更新。

## 四条链路各自的原理

### AutoClaw：凭证桥接 + 2.x 网关契约

AutoClaw 2.0.1 相比 1.17.8 有五处结构性变化，每一处都会让旧版反代直接失效，这也是本平台要维护一个 `bridge/` 适配层的原因：

1. **凭证换载体**：登录态从 `%APPDATA%\autoclaw\auth.json` 改为 `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc`（裸 v10 + AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key 里，DPAPI 保护）。
2. **推理网关换域名**：模型推理走 `autoglm-acceleration-api.zhipuai.cn`（加速域名）；账号/积分等 identity 接口仍在 `autoglm-api.zhipuai.cn`，两者不互通。
3. **请求头加签**：模型请求需携带 `X-Auth-Sign`（md5(appId&ts&appKey)，appId=100003）、`X-Channel: official`、`X-Session-Id`，token 走 `X-Authorization`。
4. **请求体契约**：`body.model` 保留带前缀目录名（如 `zaicoding_glm-5.3`）；输出用 `max_completion_tokens`（307200 满额）+ `store:false` + `reasoning_effort:"high"`。
5. **WAF 形状校验**：加速网关在鉴权之前校验请求必须是"真机 OpenAI SDK"形状。

**406 闸门的判定条件（同分钟 A/B 对照实验证实的五要素，缺一即 406 空响应体）**：

1. 传输层为干净的 HTTP/1.1 指纹——undici fetch（自动附加 `sec-fetch-mode` 等头、TLS ClientHello 亦有差异）被拦，`node:https` 原生请求稳定通过；
2. 完整 OpenAI SDK 指纹头（`user-agent: OpenAI/JS 6.26.0` + `x-stainless-*` + `x-agent-id: main`）；
3. `X-Session-Id` 会话头；
4. system 消息与应用 persona **完全一致**（3099 字节，合并任何额外内容都会被拒，完全没有 system 同样被拒）；
5. 请求体参数同上第 4 条。

曾被证伪的假说：时间窗 / IP 风控冷却 / 边缘节点轮换 / TLS 栈差异 / 头顺序 / temperature / 工具数量与名称 / 合成文本填充。完整实验记录见 [../TEST_REPORT.md](../TEST_REPORT.md)。

反代自动把 persona 整体替换为 system，并把调用方（ZCode）原有的 system 指令挪到首条 user 消息里作上下文——模型仍然看得到全部指令。

| 组件 | 作用 |
|---|---|
| `bridge/make_compat_auth.py` | 凭证桥接：DPAPI 解密 2.x 凭证 → 合成旧版 auth.json |
| `bridge/watch_auth.py` | 凭证自动同步器（常驻，应用轮换 token 即自动跟进） |
| `bridge/server_2x.mjs` | ★ 2.x 权威反代（部署到 `~/.autoclaw-relay/server.mjs`） |
| `bridge/persona.txt` | 应用 persona system prompt（闸门硬要求，随反代一起部署） |

### WorkBuddy：本地 Go 网关

社区反代 workbuddy2api（Go），源码随 workbuddy-manager 发布包分发（独立仓库已 404），位于 `workbuddy/workbuddy-manager-v1.0.79/upstream/`：

```
# 构建（Go 1.24，golang.google.cn 下载；GOPROXY 用 goproxy.cn）
cd workbuddy/workbuddy-manager-v1.0.79/upstream
go build -o wb2api.exe ./cmd/server
```

- 网关 `:7863`（api_key=wb-local-key，config.json），上游 copilot.tencent.com
- 认证：CLI OAuth（`wb2api-login.exe url|poll --realm=cn`），浏览器 OAuth 1 分钟搞定；token 38 天
- **tools 透传已验证 ✓**（finish_reason:tool_calls）；自带账号池 / 熔断 / 签到保活调度，Redis 可选（默认 noop）
- **模型名必须小写或 `cn:` 前缀**（`GLM-5.3` 大写会失败）；共 46 个模型（glm / kimi / deepseek / minimax / hunyuan / cn:auto 等）
- 积分显示与免费额度是两套账（积分 0 也能出字）

### Trae SOLO CN：凭证离线解密 + 远端 agent 会话

Trae 与前两个平台结构不同：**客户端不直接调模型**，而是拿用户 token 在远端拉起 agent 沙箱会话，模型跑在字节的沙箱里（`agent-sandbox-bj-*.trae.cn`，`/workspace` 工作区）。所以网关不能翻译成"一次 chat completion"，要驱动它的一整套会话协议：

```
POST /api/remote/v1/chat_sessions               创建会话（env=local, mode=work, session_type=assistant_chat）
POST /api/remote/v1/chat_sessions/:id/messages  追加一轮
GET  /api/remote/v1/chat_sessions/:id/events    SSE：plan_item 增量 / token_usage / done
```

host 为 `https://trae-api-cn.mchost.guru`，鉴权头 `Authorization: Cloud-IDE-JWT <user token>`（外加 `X-Trae-Client-Type: lite` / `X-App-Id` / `X-User-Region: CN`），无需签名头。

**凭证是离线解出来的。** Trae 把登录态存在 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` 字段，加密模块是 `out/main.js` 里内嵌的 `byteCrypto`——纯 JS 实现、码表硬编码、没有原生绑定，因此可以**不改客户端、不重启 IDE** 直接把 token 解出来（`trae/decrypt_auth.py`，relay 内有等价实现）：

```
blob      = magic(6) + keymat(32) + AES-128-CBC(payload)
key/iv    = sha512( sha512(keymat) || (qoe XOR zoe) )[0:32] 拆成 16+16
plaintext = sha512(body)(64) || body        # PKCS7 填充，头部哈希用于完整性校验
```

只有这个 **user token** 能过鉴权；`GenerateTempToken` 签发的临时 JWT 打远程 API 一律 401。线上真实生效的 query 是 `[{"type":"text","data":{"content":...}}]`——服务端**回显/落库**时会规范化成 `text_content` 形态，照抄回显格式发出去，提示词会被静默丢弃。

**会话池。** 每轮都新建会话既浪费（每轮约 17.6k prompt token 的固定系统开销）又丢上下文，所以网关按 `sha1(system + 首条 user 消息)` 维护会话池：下一轮命中且轮数连续就复用同一会话（响应里标 `mode:continue`），否则把历史展开成带角色标注的转录后新建会话。SSE 的 `plan_item` 增量翻译成 OpenAI 的 `delta` 与 Anthropic 的 `content_block_delta`，`token_usage` 翻译成 `usage`。

**模型目录要带参数问**：`GET /api/remote/v1/models` 不带参数只回默认的 `solo_coder` 一组（12 个模型），客户端实际发的是 `functions=solo_coder,solo_agent_lite,solo_agent_remote,solo_work_lite,solo_work_remote,solo_design_lite,solo_design_remote,builder&show_custom_model=true`，带上才会返回 7 个分组。网关现在两次都取、并集去重（同名模型会在多组出现），本账号当前共 **27 个**可选模型：除 solo_coder 的 12 个外，还有 glm-5.3、glm-5.2、deepseek-v4.1-flash、DeepSeek-V4-Flash/Pro 正式版、kimi-k3、kimi-k2.7-code、minimax-m3、qwen3.8-max、qwen-3.7-plus、step-5-preview、Doubao-Seed-Evolving、Doubao-Seed-2.1-Pro/Turbo。`show_custom_model=true` 带出的自定义条目里 `z-ai/glm-5.2` 实测返回 200 但 content 为空，已在网关里排除（能选但不出字比没有更糟）。目录随账号与客户端版本变化，控制台与注册流程每次都从网关动态拉取。

### 豆包工作：CDP 读登录态 + 直连完成接口

豆包工作（DoubaoWork，Electron/Chromium 147）的对话页是客户端内的本地页（`chrome://doubaowork-chat/chat`），页面背后真正打的是 `POST https://www.doubao.com/chat/completion`（SSE 流）。这一条链路比前三条都简单——**没有签名参数、没有本地网关**，`doubao/relay.mjs` 一个文件就是全部：

- **鉴权只有 cookie**：正式客户端还会带 `a_bogus` 签名参数，实测该参数可以缺省，`msToken` 直接从 cookie 里取即可，所以网关完全独立运行，**不需要豆包工作客户端开着**。
- **登录态通过 CDP 抓取**：客户端以 `--remote-debugging-port=9222` 启动后，用 `Network.getAllCookies` 可以直接拿到明文 cookie（省去 DPAPI 解密），落到 `~/.doubao-relay/cookies-cdp.json`。控制台的两种取法：「同步登录态」（客户端已带调试端口在跑）与「重启客户端并同步」（先 taskkill 再带端口重启，然后抓取）。
- **请求要在 query 上带足客户端指纹**：`aid/channel/client_platform/device_platform/pc_version=2.31.10/pkg_type/region=CN/runtime=web/runtime_version=3.39.0/samantha_web=1/use-olympus-account=1/web_tab_id=<uuid>` 等，UA 形如 `…SamanthaDoubaoWork/2.31.10`，body 里带着 `bot_id` 与 `client_meta`。（可工作的最小集合已经固化在 relay 里。）
- **SSE 事件语法**（完整枚举过）：`SSE_HEARTBEAT` / `SSE_ACK`（回执里的 `ack_client_meta.conversation_id` 才是权威会话 id）/ `FULL_MSG_NOTIFY`（用户消息回显）/ `STREAM_MSG_NOTIFY` / `STREAM_CHUNK`（`patch_op` 增量）/ **`CHUNK_DELTA`（正文增量，主要来源）** / `STREAM_TIMEOUT_CONTROL` / `SSE_REPLY_END`（`end_type` 1/2/3 表示不同阶段的结束）。正文按到达顺序拼接三个来源的增量即可得到完整回答；`end_type=1` 里的 `brief` 只是**截断摘要**，仅在没有增量时兜底。
- **会话**：服务端默认把请求路由到本机「最近一个会话」，所以 relay 把一个专用 `conversation_id` 固定下来（配置文件 `~/.doubao-relay/config.json`，也可 `POST /admin/conversation` 改），多轮上下文由服务端维护；没有固定会话时才把历史展开成带角色的转录一次性发。**会话只能由客户端界面创建**（新建会话 + 发一句话），接口层创建不出来。
- **模型目录不可枚举**：模型是服务端下发的（客户端 bundle 里没有目录，`model_item_key` 也没找到枚举接口），网关只暴露两个合成条目——`doubao`（标准）与 `doubao-think`（深思考，`conversation_init_ext` 用 `need_deep_think=9` + `reasoning_effort="5"`）。
- **注意**：反代的调用会真实出现在你本机的豆包工作会话列表里（就是那个固定会话）。不想要痕迹就在客户端里另建一个专用会话，再用 `POST /admin/conversation` 指过去。
- **工具调用不支持**（与 Trae 同为仅文本），`tools` 字段会被忽略而不是报错。

## ZCode 供应商注册：写入安全边界（重要）

`~/.zcode/v2/provider_config.json` 是 **ZCode 自己的配置文件**，控制台只被允许增量修改自己注册的三个供应商。历史上这里踩过两次同一个根因的坑：写入非法的 `api.type`（把内部 kind `openai-compatible` 当成合法值，导致整个供应商加载失败），以及"规范化成我认识的集合"把别人的条目删掉（丢掉必填的 `manualProviderModelRules`；又把 AutoClaw 目录削成 4 个模型）。现在的规则写死在 `app/zcode-config.js` 里：

- **api.type 只认三个值**：`anthropic-messages` / `openai-responses` / `openai-chat-completions`（取自 ZCode 自身代码的 switch 分支）
- **写入前后做结构键集断言**：丢了任何既有键/条目就整体拒绝落盘，白名单只有三家自己的模型目录
- **目录只做并集**：`personalModelIds` 只加不删，模型条目缺则补；已存在条目的能力声明（如 `supportsImage`）保留，只刷新 `contextWindow`
- **原子写 + 读回校验 + 回滚**：先写临时文件再 rename，写完重新解析，失败自动回滚到 `*.bak-<时间戳>`
- **AutoClaw 的目录真源是 `a_switch.py` 的 `ZCODE_MODELS`**（6 个模型，带逐路由实测的视觉矩阵），控制台不自带写死的列表

沙箱回归测试 `node app/test_zcode_config.js` 里，A1/A2/A3 三条用例正好是上面两个历史错误，旧实现必失败、现实现必通过。

## 防封与额度经营（AutoClaw）

上游风控看的是**推理流水的形态**：一个号如果全是 1-token 的探针调用、或者被并发打到每分钟几百次，就会封。A-SWITCH 的防封参数是拿封掉的号的真实流水对出来的，别随便改大：

- **暖号**：新注册的号先点一次「🔥 暖号」，用真实技术问题跟模型聊 8 轮，把流水刷成正常人的形状。跳过这步的号用不了几天。
- **限速**：单号 12 次/分；**并发闸**：整池同时在途 ≤4；**日预算**：每号 6000 次/天（本地计数）。
- **多号**：反代按积分余额和空闲度选号，一个号的积分打空自动换下一个。加号用 GUI 的「桌面端登录添加」（加号前完全退出 AutoClaw 主程序，含托盘）。
- 国际端支持邮箱注册（国内端只有手机号），新号送 10000 积分分 7 天到账。

## 验证

```
# AutoClaw relay（:18766，anthropic）
curl http://127.0.0.1:18766/health
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'

# Trae 网关（:18768，openai）
node trae/relay.mjs &
curl http://127.0.0.1:18768/health        # 凭证账号/到期、模型目录、会话池大小
curl -X POST http://127.0.0.1:18768/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.1","messages":[{"role":"user","content":"用一句话解释反向代理"}]}'

# 豆包工作网关（:18770，openai，另有 /v1/messages）
node doubao/relay.mjs &
curl http://127.0.0.1:18770/health        # cookie 健康度、固定会话、会话池、模型
curl -X POST http://127.0.0.1:18770/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer doubao-local-key' \
  --data-binary @req.json                  # {"model":"doubao","messages":[...]}，中文务必走文件
```

回归测试：`node trae/test_relay.mjs`（openai/anthropic × 流式/非流式 + 多轮续接）、`node trae/test_robust.mjs`（system/tools 兼容、会话隔离、多轮记忆）、`node doubao/test-relay.mjs`（豆包 openai/anthropic × 流式/非流式）、`node doubao/test-zcode-shape.mjs`（带 `tools`/`stream_options` 的 ZCode 形状请求 + 多轮）。注意在 Git Bash 里用 `curl -d '中文'` 会因为控制台代码页是 GBK 而发出乱码字节，测试中文请用 Node 脚本或 `--data-binary @utf8文件`。

## 故障速查

| 症状 | 原因与处置 |
|---|---|
| 401 Invalid token | 应用轮换了 access token。凭证同步器正常时会自动跟进；若没在跑，重新打开 AutoClaw 登录一次，或重跑 `bridge/make_compat_auth.py` |
| 402 积分不足 | 终态错误，等每日赠送（每日登录 1000 分）或充值，反代不会重试 |
| 406 空响应 | 2.x 闸门五要素缺一（见上文）；最常见是 persona.txt 没部署——控制台点「启动」会自动补 |
| 810001 系统繁忙 | GLM-5.3-Flash 白天高峰限流，夜间 23:00-09:00 畅通；反代已自动退避重试，白天建议改用 GLM-5.3 或 Auto 路由 |
| Trae 401 | 凭证约 5 天过期，重新打开 Trae 登录一次；网关遇 401 自动重读 storage.json，无需重启 |
| 豆包 401 / cookie 缺失 | 客户端登录态过期。控制台点「同步登录态」（需客户端已带调试端口运行）或「重启客户端并同步」重新抓 cookie |
| 豆包回复乱码 / 空 | 先确认请求正文本身是 UTF-8（Git Bash 的 `curl -d '中文'` 会发 GBK 乱码，见「验证」一节）；固定会话被删时用 `POST /admin/conversation` 换一个 |
| 点按钮没反应 | 大概率是 Python 缺 cryptography——spawn 成功但同步器立刻崩。点「环境体检」确认 |
| 控制台整个冻住 | 罕见：老版本 spawn 找不到命令时未捕获异常会阻塞事件循环；现版本已统一走 trySpawn。若复现，先体检 PATH |
| WB 模型报错 | 模型名要小写或 `cn:` 前缀；确认 wb2api.exe 在 `workbuddy/.../upstream/` 且已 OAuth |

**模型的视觉能力按路由实测配置**：GLM-5.3-Flash、DeepSeek-V4.1-Flash、Auto 系列可以看图；GLM-5.3（coding 版）和 DeepSeek-V4-Pro 不行，发图它会说看不见。

**Trae 的固有限制**：工具调用不透传（agent 自行决定，OpenAI 的 `tools` 字段被忽略，模型只回文本）；每轮固定开销约 17.6k prompt token（Trae 自己的 agent system prompt），短问答不划算，更适合长任务、长上下文场景。

**豆包的固有限制**：同样不支持工具调用；模型目录只有两个合成条目（服务端不可枚举）；请求内容会留在本机豆包工作的固定会话里。

## 目录结构

```
autoclaw-to-zcode/                 ← 工作区根目录
├── app/                           ← Electron 管理控制台（三平台统一面板，活体代码）
│   ├── main.js / preload.js       生命周期管理 + IPC（含 ASWITCH_SELFTEST 自测模式）
│   ├── zcode-config.js            ★ ZCode 配置写入闸门（纯 Node：枚举/结构/原子/回滚）
│   ├── test_zcode_config.js       闸门的沙箱回归测试（合成 fixture，12 条用例）
│   └── renderer/                  状态面板 UI
├── bridge/                        ← AutoClaw 2.x 适配层
│   ├── make_compat_auth.py        凭证桥接（DPAPI 解密 → auth.json）
│   ├── watch_auth.py              凭证自动同步器（常驻）
│   ├── server_2x.mjs              ★ 2.x 权威反代（全部补丁就绪）
│   ├── persona.txt                ★ 应用 persona system prompt
│   └── test_*.mjs / probe_*.mjs   406 闸门的实验、验证与二分脚本
├── trae/                          ← Trae SOLO CN 反代
│   ├── relay.mjs                  ★ 网关本体（openai + anthropic，凭证解密 + 会话池）
│   ├── decrypt_auth.py            离线解密 storage.json 的参考实现
│   ├── remote_api_spec.json       枚举出的 198 个远程端点（逆向记录）
│   ├── dump_events.mjs            原始 SSE 事件转储（协议分析用）
│   └── test_relay.mjs / test_robust.mjs  回归测试
├── workbuddy/                     ← WorkBuddy 网关（wb2api 源码 + config.json）
│   └── workbuddy-manager-v1.0.79/upstream/   Go 源码，UPSTREAM-SRC.txt 说明来源
├── doubao/                        ← 豆包工作反代
│   ├── relay.mjs                  ★ 网关本体（openai + anthropic，cookie 鉴权 + SSE 解析 + 会话池）
│   ├── cdp.js                     CDP 工具（cookies 抓取 / 请求头与网络转储 / drive 注入脚本）
│   ├── probe.mjs / im.mjs / raw.mjs        协议探针（SSE 事件、IM cmd 协议、任意端点）
│   ├── test-relay.mjs / test-zcode-shape.mjs  回归测试
│   └── t-*.mjs                    协议实验脚本（会话、ACK、多轮、深思考对照）
├── autoclaw-switch/               ← A-SWITCH 1.x（上游：多账号管理 + 暖号 + 老版反代）
│   ├── a_switch.py                后端：账号管理、签到、DPAPI 解密、一键反代、暖号
│   ├── a_switch_app.py            GUI（pywebview）
│   ├── relay/server.mjs           1.x 反代（2.x 用户请用 ../bridge/server_2x.mjs）
│   └── A-SWITCH.spec              PyInstaller 打包配置
└── TEST_REPORT.md                 完整测试报告（根因分析、实验记录、证据链）
```

运行时数据（自动生成，均带敏感信息，不入库）：`~/.autoclaw-relay/`（部署的反代、persona、日志）、`~/.openclaw-autoclaw/`（凭证源）、`~/.trae-relay/`（Trae 日志与会话转储）、`~/.doubao-relay/`（豆包 cookie、固定会话、日志）、`~/.zcode/v2/provider_config.json`（ZCode 注册，备份为 `.bak-autoclaw`）。

## 免责声明

本项目通过逆向 AutoClaw / WorkBuddy / Trae / 豆包工作 客户端实现了对非官方接口的调用，仅供学习研究。使用本项目导致的账号封禁、积分损失由使用者自行承担。请勿用于商业用途。AutoClaw 是智谱/Z.ai 的产品，WorkBuddy 相关服务来自腾讯云，Trae 与豆包工作是字节跳动的产品，本项目与上述公司均无关。
