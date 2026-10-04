// AutoClaw → ZCode 反代控制台 — Electron 主进程
// 职责：relay 与凭证同步器的生命周期、状态聚合、按需查询（积分/注册/日志）。
// 设计约束：所有对上游的出站请求仅由用户在界面点击触发（无固定节奏轮询）。
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const RELAY_DIR = path.join(HOME, ".autoclaw-relay");
const RELAY_SERVER = path.join(RELAY_DIR, "server.mjs");
const RELAY_LOG = path.join(RELAY_DIR, "relay.log");
const WATCH_LOG = path.join(RELAY_DIR, "watch_auth.log");
const AUTH_COMPAT = path.join(RELAY_DIR, "auth-compat", "auth.json");
const STATE_DIR = path.join(HOME, ".openclaw-autoclaw");
const REQ_HEADERS = path.join(STATE_DIR, "request-headers.json");
const ZCODE_CFG = path.join(HOME, ".zcode", "v2", "provider_config.json");
const PROVIDER_ID = "autoclaw-glm-provider";
const PROJECT_DIR = path.join(__dirname, "..");
const BRIDGE_DIR = path.join(__dirname, "..", "bridge");
const PYTHON = "python";

const RELAY_ENV = {
  ...process.env,
  AUTOCLAW_CONTRACT: "2x",
  AUTOCLAW_CLOUD_LANE: "cn",
  AUTOCLAW_CLIENT_VERSION: "2.0.1",
  AUTOCLAW_X_CHANNEL: "official",
  AUTOCLAW_X_TRACE_ID: "autoclaw-desktop",
  AUTOCLAW_HARNESS_MARKER: "0",
  AUTOCLAW_MAX_OUTPUT_TOKENS: "0",
};

let relayProc = null;
let watchProc = null;
let mainWindow = null;

function log(...args) {
  const line = `[console ${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(path.join(RELAY_DIR, "console.log"), line + "\n"); } catch {}
}

function relayAlive() {
  try {
    const out = execSync("netstat -ano | findstr :18766 | findstr LISTENING", { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function spawnDetached(cmd, args, opts = {}) {
  const p = spawn(cmd, args, {
    cwd: opts.cwd || RELAY_DIR,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => log("[stderr]", String(d).slice(0, 200)));
  return p;
}

function healthOnce(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18766/health", { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, ...JSON.parse(d) }); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  });
}

function watcherRunning() {
  if (watchProc) return true;
  try {
    const pid = Number(fs.readFileSync(path.join(RELAY_DIR, "watch_auth.pid"), "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);  // 探测存活，不杀
    return true;
  } catch { return false; }
}

function readTokenExp() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_COMPAT, "utf8"));
    const tok = (a.token || "").replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString("utf8"));
    return { exp: payload.exp || 0, iat: payload.iat || 0, uid: payload.user_id || "" };
  } catch { return { exp: 0, iat: 0, uid: "" }; }
}

function readZcodeRegistration() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ZCODE_CFG, "utf8"));
    const conf = cfg.config || {};
    const rule = (conf.providerConfigRules?.providerRules || []).find((r) => r.providerId === PROVIDER_ID);
    if (!rule) return { registered: false };
    return {
      registered: true,
      enabled: !!rule.enabled,
      baseUrl: rule.config?.api?.baseUrl || "",
      models: rule.config?.personalModelIds || [],
      inOrder: (conf.providerOrder || []).includes(PROVIDER_ID),
    };
  } catch (e) { return { registered: false, error: String(e) }; }
}

function pythonOneShot(script, extraEnv = {}, timeoutMs = 90000) {
  // 用 importlib 加载 a_switch.py 并执行片段；单次按需调用，非固定节奏。
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ["-c", script], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, AUTOCLAW_AUTH_DIR: path.join(RELAY_DIR, "auth-compat"), PYTHONIOENCODING: "utf-8", ...extraEnv },
      windowsHide: true,
    });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: "timeout", out, err }); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  });
}

const POINTS_SNIPPET = `
import sys, json; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','../a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.BASE = "https://autoglm-api.zhipuai.cn"  # CN 账号余额在 CN identity 网关
accs=m.discover_accounts()
if not accs:
    print(json.dumps({"ok": False, "error": "no account"}))
else:
    a=accs[0]
    pts=a.points() or {}
    exp=a.access_expires_at()
    print(json.dumps({"ok": True, "nickname": a.nickname, "user_id": a.user_id,
                      "total": pts.get("total"), "wallets": pts.get("wallets"),
                      "expiring": pts.get("expiring"), "token_exp": exp}))
`;

const REGISTER_SNIPPET = `
import sys, json, subprocess, os; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','../a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.subprocess=subprocess
r=m.zcode_register_provider()
# [asw-2x] 2.x acceleration 网关只有 4 个模型；a_switch 内置 1.x 目录含 tdpsk DeepSeek（2.x 不存在），注册后统一修正
models = [("GLM-5.3", "zaicoding_glm-5.3", False, 1048576), ("GLM-5.3-Flash", "zai_glm-5.3-flash", True, 1048576),
          ("Auto", "zai_auto", True, 1048576), ("Auto-Fast", "zai_auto-fast", True, 1048576)]
p = os.path.expanduser("~/.zcode/v2/provider_config.json")
cfg = json.load(open(p, encoding="utf-8"))
conf = cfg.setdefault("config", {})
pid = "autoclaw-glm-provider"
for rule in conf.get("providerConfigRules", {}).get("providerRules", []):
    if rule.get("providerId") == pid:
        rule["config"]["personalModelIds"] = [mm[0] for mm in models]
mcr = conf.get("modelConfigRules", {}).get("providerModelRules", [])
mcr[:] = [x for x in mcr if x.get("providerId") != pid]
for display, _route, image, ctx in models:
    mcr.append({"providerId": pid, "modelId": display, "config": {"enabled": True, "properties": {
        "contextWindow": ctx, "inputFormat": {"supportsText": True, "supportsImage": image,
        "supportsVideo": False, "supportsAudio": False, "supportsPdf": False}, "outputFormat": {"supportsText": True}}}})
json.dump(cfg, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
r["models"] = [mm[0] for mm in models]
print(json.dumps(r, ensure_ascii=False))
`;

const SYNC_SNIPPET = `
import sys, json; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','../a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ok=m.write_single_credential()
print(json.dumps({"ok": bool(ok)}))
`;

function tailFile(file, n = 200) {
  try {
    const data = fs.readFileSync(file, "utf8");
    const lines = data.split("\n").filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch { return "(日志文件不存在或为空)"; }
}

const handlers = {};
function handle(channel, fn) { handlers[channel] = fn; ipcMain.handle(channel, (e, ...args) => fn(e, ...args)); }

function setupIpc() {
  handle("status:query", async () => {
    const health = relayAlive() ? await healthOnce() : { ok: false, running: false };
    const zcode = readZcodeRegistration();
    const token = readTokenExp();
    let credential = "缺失";
    try { credential = JSON.parse(fs.readFileSync(REQ_HEADERS, "utf8")).headers["X-Authorization"].slice(0, 16) + "…"; } catch {}
    return {
      relay: {
        running: !!health.running || relayAlive(),
        ok: health.ok,
        status: health.status || "-",
        upstream: health.upstream || null,
        uptimeS: health.uptime_s || 0,
        models: health.aliases || [],
      },
      watcher: { running: watcherRunning() },
      zcode,
      token,
      credential,
    };
  });

  handle("relay:start", async () => {
    if (relayAlive()) return { ok: true, already: true };
    if (!fs.existsSync(RELAY_SERVER)) return { ok: false, error: "未找到 relay（~/.autoclaw-relay/server.mjs）" };
    relayProc = spawn("node", [RELAY_SERVER], {
      cwd: RELAY_DIR, env: RELAY_ENV, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(RELAY_LOG, "a"), fs.openSync(RELAY_LOG, "a")],
    });
    relayProc.unref();  // 关闭控制台后 relay 继续作为后台服务存活
    relayProc.on("exit", (code) => { log("relay exited", code); relayProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (relayAlive()) return { ok: true };
    }
    return { ok: false, error: "10 秒内未就绪，查看 relay.log" };
  });

  handle("relay:stop", async () => {
    try {
      const out = execSync("netstat -ano | findstr :18766 | findstr LISTENING", { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (relayProc) { try { relayProc.kill(); } catch {} relayProc = null; }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("watcher:start", async () => {
    if (watchProc) return { ok: true, already: true };
    watchProc = spawnDetached(PYTHON, [path.join(BRIDGE_DIR, "watch_auth.py")], { cwd: BRIDGE_DIR });
    watchProc.on("exit", (code) => { log("watcher exited", code); watchProc = null; });
    await new Promise((r) => setTimeout(r, 800));
    return { ok: !!watchProc };
  });

  handle("watcher:stop", async () => {
    if (watchProc) { try { watchProc.kill(); } catch {} watchProc = null; }
    try {
      const pid = Number(fs.readFileSync(path.join(RELAY_DIR, "watch_auth.pid"), "utf8").trim());
      if (pid) {
        // 防 Windows PID 复用误杀：确认该 PID 的进程名是 python 才杀
        try {
          const img = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { shell: "cmd.exe", timeout: 8000 }).toString();
          if (/python/i.test(img)) process.kill(pid);
        } catch {}
        fs.unlinkSync(path.join(RELAY_DIR, "watch_auth.pid"));
      }
    } catch {}
    return { ok: true };
  });

  handle("points:refresh", async () => {
    const r = await pythonOneShot(POINTS_SNIPPET);
    try {
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      return JSON.parse(line || "{}");
    } catch { return { ok: false, error: r.err || r.out || "解析失败" }; }
  });

  handle("zcode:register", async () => {
    const r = await pythonOneShot(REGISTER_SNIPPET, {}, 120000);
    try {
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      const res = JSON.parse(line || "{}");
      return { ...res, raw: r.out.slice(0, 300) };
    } catch { return { ok: false, error: r.err || r.out || "解析失败" }; }
  });

  handle("credential:sync", async () => {
    const r = await pythonOneShot(SYNC_SNIPPET, {}, 120000);
    try {
      const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      return JSON.parse(line || "{}");
    } catch { return { ok: false, error: r.err || r.out || "解析失败" }; }
  });

  handle("smoke:test", async () => {
    return new Promise((resolve) => {
      const body = JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 64, stream: false,
        messages: [{ role: "user", content: "请只回复OK" }] });
      const req = http.request({
        host: "127.0.0.1", port: 18766, path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "autoclaw-local", "anthropic-version": "2023-06-01",
                   "content-length": Buffer.byteLength(body) },
        timeout: 180000,
      }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let reply = "", stop = "";
          try {
            const j = JSON.parse(d);
            reply = (j.content || []).map((b) => b.text || (b.thinking ? "[thinking]" : "")).join("").slice(0, 120);
            stop = j.stop_reason || "";
          } catch { reply = d.slice(0, 120); }
          resolve({ ok: res.statusCode === 200, status: res.statusCode, reply, stop });
        });
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, reply: e.message }));
      req.write(body); req.end();
    });
  });

  handle("logs:tail", async (_e, which) => {
    if (which === "watch") return tailFile(WATCH_LOG, 120);
    if (which === "console") return tailFile(path.join(RELAY_DIR, "console.log"), 120);
    return tailFile(RELAY_LOG, 200);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080, height: 820,
    backgroundColor: "#0f1115",
    title: "AutoClaw → ZCode 控制台",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  log("console started");
  setupIpc();
  if (process.env.ASWITCH_SELFTEST === "1") {
    // 自测模式：顺序执行各 IPC 处理器（等同逐个点击按钮），结果输出到 stdout
    const invoke = (ch, ...args) => {
      const h = handlers[ch];
      if (!h) return Promise.reject(new Error("no handler " + ch));
      return Promise.resolve(h({ _selftest: true }, ...args));
    };
    (async () => {
      const results = [];
      const t = async (name, ok) => { results.push([name, !!ok]); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
      const s1 = await invoke("status:query");
      await t("status:query", s1.relay.running && s1.zcode.registered);
      const p1 = await invoke("points:refresh");
      await t("points:refresh", p1.ok && p1.total != null);
      const c1 = await invoke("credential:sync");
      await t("credential:sync", c1.ok === true);
      await invoke("watcher:stop");
      await new Promise((r) => setTimeout(r, 1500));
      const w0 = await invoke("status:query");
      await t("watcher:stop", w0.watcher.running === false);
      await invoke("watcher:start");
      await new Promise((r) => setTimeout(r, 2500));
      const w1 = await invoke("status:query");
      await t("watcher:start", w1.watcher.running === true);
      const sm = await invoke("smoke:test");
      await t("smoke:test", sm.ok === true && sm.reply,);
      const rg = await invoke("zcode:register");
      await t("zcode:register", rg.ok === true && Array.isArray(rg.models) && rg.models.length === 4);
      const l1 = await invoke("logs:tail", "relay");
      const l2 = await invoke("logs:tail", "watch");
      await t("logs:tail", l1.length > 50 && l2.length > 0);
      await invoke("relay:stop");
      await new Promise((r) => setTimeout(r, 2500));
      const h0 = await new Promise((res) => {
        const q = http.get("http://127.0.0.1:18766/health", { timeout: 3000 }, (r2) => { res(true); r2.resume(); });
        q.on("error", () => res(false)); q.on("timeout", () => { q.destroy(); res(false); });
      });
      await t("relay:stop (失联)", h0 === false);
      await invoke("relay:start");
      await new Promise((r) => setTimeout(r, 2500));
      const s2 = await invoke("status:query");
      await t("relay:start (恢复)", s2.relay.ok === true);
      const pass = results.filter((r) => r[1]).length;
      console.log(`==== SELFTEST ${pass}/${results.length} ====`);
      try { fs.writeFileSync(path.join(RELAY_DIR, "selftest-result.txt"),
        JSON.stringify({ time: new Date().toISOString(), pass, total: results.length,
          results: results.map(([n, ok]) => ({ name: n, ok })) }, null, 1)); } catch {}
      app.exit(pass === results.length ? 0 : 1);
    })();
    return;
  }
  createWindow();
});
app.on("window-all-closed", () => {
  // relay 与同步器为后台服务，关闭窗口不停止它们
  app.quit();
});
