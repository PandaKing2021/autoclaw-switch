// Electron 控制台全功能自动化测试（CDP 驱动渲染层，等同逐个点击按钮）。
// 用法：node test_client.mjs
const DEBUG_PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function getTargetWs() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && /ZCode/.test(t.title));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error("找不到调试目标");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      eval: async (expr) => {
        const myId = ++id;
        ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate",
          params: { expression: expr, awaitPromise: true, returnByValue: true } }));
        return new Promise((res, rej) => pending.set(myId, { res, rej }));
      },
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else if (msg.result?.exceptionDetails) rej(new Error(msg.result.exceptionDetails.exception?.description || "page exception"));
        else res(msg.result?.result?.value);
      }
    };
  });
}

async function main() {
  console.log("== 连接控制台 ==");
  const wsUrl = await getTargetWs();
  const cdp = await connect(wsUrl);
  console.log("已连接:", wsUrl.slice(0, 60) + "…");

  const api = (call) => cdp.eval(`window.api.${call}`);
  const dom = (id) => cdp.eval(`document.getElementById("${id}")?.textContent`);

  // ---- T1 状态查询 ----
  const s1 = await api("queryStatus()");
  report("T1 状态查询", s1?.relay && s1?.zcode && "token" in s1,
    `relay=${s1.relay.status} upstream=${s1.relay.upstream} zcode=${s1.zcode.registered}`);

  // ---- T2 初始总状态药丸 ----
  const overall1 = await dom("overall");
  report("T2 状态药丸渲染", typeof overall1 === "string" && overall1.length > 0, overall1);

  // ---- T3 积分刷新 ----
  const pts = await api("refreshPoints()");
  report("T3 积分查询", pts?.ok && pts.total != null, `余额 ${pts.total} 分`);

  // ---- T4 凭证同步 ----
  const sync = await api("syncCredential()");
  report("T4 凭证同步", sync?.ok === true);

  // ---- T5 同步器启停 ----
  await api("watcherStop()");
  await sleep(1500);
  const wOff = await api("queryStatus()");
  const stoppedOk = wOff.watcher.running === false;
  await api("watcherStart()");
  await sleep(2500);
  const wOn = await api("queryStatus()");
  report("T5 同步器停止/启动", stoppedOk && wOn.watcher.running === true,
    `停止后=${wOff.watcher.running} 启动后=${wOn.watcher.running}`);

  // ---- T6 连通性测试（真实推理）----
  const smoke = await api("smokeTest()");
  report("T6 连通性测试（真实推理）", smoke?.ok === true && smoke.reply, `status=${smoke.status} reply=${String(smoke.reply).slice(0, 40)}`);

  // ---- T7 重新注册供应商 ----
  const reg = await api("registerZcode()");
  report("T7 重新注册供应商", reg?.ok === true && Array.isArray(reg.models) && reg.models.length === 4,
    `模型 ${(reg.models || []).join("/")}`);

  // ---- T8 日志查看器三个标签 ----
  const logRelay = await api("tailLog('relay')");
  const logWatch = await api("tailLog('watch')");
  const logConsole = await api("tailLog('console')");
  report("T8 日志查看器", logRelay.length > 50 && logWatch.length > 0 && logConsole.length > 0,
    `relay=${logRelay.length}B watch=${logWatch.length}B console=${logConsole.length}B`);

  // ---- T9 relay 生命周期：停止 → 失联 → 启动 → 恢复 ----
  await api("relayStop()");
  await sleep(2500);
  const stopped = await fetch("http://127.0.0.1:18766/health", { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false);
  await api("relayStart()");
  await sleep(2500);
  const s2 = await api("queryStatus()");
  report("T9 relay 停止/启动", stopped === false && s2.relay.ok === true,
    `停止后可达=${stopped} 重启后=${s2.relay.status}/${s2.relay.upstream}`);

  // ---- T10 UI DOM 状态渲染（重启后各药丸）----
  await sleep(3500); // 等一轮状态刷新
  const relayPill = await dom("relay-pill");
  const zcPill = await dom("zcode-pill");
  const overall = await dom("overall");
  report("T10 UI 状态渲染", relayPill === "运行中" && zcPill === "已注册" && overall === "链路正常",
    `relay=${relayPill} zcode=${zcPill} overall=${overall}`);

  // ---- T11 关闭窗口：应用退出但后台服务存活（系统级优雅关闭）----
  const { execSync: exe } = await import("node:child_process");
  try { exe(`taskkill /IM electron.exe`, { shell: "cmd.exe", timeout: 10000 }); } catch {}
  await sleep(4000);
  let electronAlive = true;
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`, { signal: AbortSignal.timeout(2000) }); electronAlive = (await r.json()).length > 0; } catch { electronAlive = false; }
  const relayAfterClose = await fetch("http://127.0.0.1:18766/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  report("T11 关闭窗口", electronAlive === false && relayAfterClose?.status === "ok",
    `应用退出=${electronAlive === false} relay 存活=${relayAfterClose?.status}`);

  console.log(`\n==== 结果: ${results.filter((r) => r.pass).length}/${results.length} 通过 ====`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => { console.error("测试脚本异常:", e.message); process.exit(1); });
