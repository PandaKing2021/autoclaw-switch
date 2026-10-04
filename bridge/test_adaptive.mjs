// Adaptive bisect: wait for the 406 gate to open, then immediately test
// multiple (X-Request-Model, body.model) pairs within the same open window.
// Logs resolved IP + response headers to test the edge-correlation theory.
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const BASE = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const SESSION = crypto.randomUUID(); // one fixed session for the whole batch (affinity)

const lookupIp = () => new Promise((res) => dns.lookup("autoglm-acceleration-api.zhipuai.cn", { family: 4 }, (e, a) => res(e ? "?" : a)));

function headersFor(xReqModel) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = crypto.randomUUID();
  return {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "X-Version": "2.0.1",
    "X-Tm": "win",
    "X-Product": "autoclaw",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Trace-Id": reqId,
    "X-Request-Id": reqId,
    "X-Request-Model": xReqModel,
    "X-Client-Type": "pc",
    "x_trace_id": "autoclaw-desktop",
    "X-Session-Id": SESSION,
    "X-Authorization": token,
  };
}

async function fire(tag, xReqModel, body, extraHeaders = {}) {
  const ip = await lookupIp();
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { ...headersFor(xReqModel), ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    const srv = r.headers.get("server") || "-";
    const via = r.headers.get("via") || r.headers.get("x-served-by") || "-";
    let brief = t.slice(0, 90) || "(empty)";
    if (r.status === 200) {
      const m = t.match(/"content"\s*:\s*"([^"]{0,60})/);
      brief = "CONTENT: " + (m ? m[1] : t.slice(0, 80));
    }
    console.log(`[${tag}] ${r.status} (${Date.now() - t0}ms) ip=${ip} srv=${srv} via=${via} :: ${brief}`);
    return r.status;
  } catch (e) {
    console.log(`[${tag}] ERR ip=${ip}: ${e.message}`);
    return 0;
  }
}

const userMsg = [{ role: "user", content: "用一句话解释什么是幂等性。" }];
const base = (model) => ({ model, messages: userMsg, stream: true, max_tokens: 32 });

// Phase 0: probe until the gate opens (max 6 tries). Control = known 400 pair.
const gate = [];
let opened = false;
for (let i = 0; i < 6; i++) {
  const st = await fire(`W${i}`, "zai_glm-5.3-flash", base("zai_glm-5.3-flash"));
  gate.push(st);
  if (st !== 406 && st !== 0) { opened = true; break; }
  await new Promise((s) => setTimeout(s, 5000));
}
console.log("gate sequence:", gate.join(","), "| opened:", opened);

// Phase 1: bisect candidates (fire regardless; each may catch a window)
const candidates = [
  ["C1 auto-router+meta", "zai_auto", "deepseek-v4-pro", {}],
  ["C2 equal-prefixed", "zai_glm-5.3-flash", "zai_glm-5.3-flash", {}],
  ["C3 prefixed+thinking", "zai_glm-5.3-flash", "zai_glm-5.3-flash",
    { thinking: { type: "enabled" }, reasoning_effort: "low", max_tokens: 512 }],
  ["C4 coding-route", "zaicoding_glm-5.3", "glm-5.3", {}],
  ["C5 autofast+ds", "zai_auto-fast", "deepseek-v4-flash-202605", {}],
];
let win = 0;
for (const [tag, xrm, bm, extra] of candidates) {
  win = await fire(tag, xrm, { ...base(bm), ...(extra.max_tokens ? { max_tokens: extra.max_tokens } : {}), ...(extra.thinking ? { thinking: extra.thinking } : {}), ...(extra.reasoning_effort ? { reasoning_effort: extra.reasoning_effort } : {}) }, {});
  if (win === 200) break;
  await new Promise((s) => setTimeout(s, 4000));
}
process.exit(win === 200 ? 0 : 1);
