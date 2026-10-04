// Bisect which header flips chat/completions between 401 and 200 with Authorization auth.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const BASE = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";

async function fire(label, extra = {}) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "X-Version": "2.0.1",
    "X-Tm": "win",
    "X-Product": "autoclaw",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Client-Type": "pc",
    "Authorization": token,
    ...extra,
  };
  const body = {
    model: "zai_glm-5.3-flash",
    messages: [{ role: "user", content: "用一句话解释什么是幂等性。" }],
    stream: true,
    max_tokens: 32,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    let brief = t.slice(0, 130) || "(empty)";
    if (r.status === 200) {
      const m = t.match(/"content"\s*:\s*"([^"]{0,80})/);
      brief = "CONTENT: " + (m ? m[1] : t.slice(0, 100));
    }
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms):`, brief);
    return r.status;
  } catch (e) {
    console.log(`[${label}] ERR:`, e.message);
    return 0;
  }
}

const seq = [
  ["N1 auth-only", {}],
  ["N2 +X-Request-Model", { "X-Request-Model": "zai_glm-5.3-flash" }],
  ["N3 +trace", { "X-Request-Model": "zai_glm-5.3-flash", "X-Trace-Id": crypto.randomUUID(), "X-Request-Id": crypto.randomUUID(), "x_trace_id": "autoclaw-desktop" }],
  ["N4 +session", { "X-Request-Model": "zai_glm-5.3-flash", "X-Trace-Id": crypto.randomUUID(), "X-Request-Id": crypto.randomUUID(), "x_trace_id": "autoclaw-desktop", "X-Session-Id": crypto.randomUUID() }],
];
let ok = 0;
for (const [label, extra] of seq) {
  ok = await fire(label, extra);
  if (ok === 200) break;
  await new Promise((s) => setTimeout(s, 6000));
}
process.exit(ok === 200 ? 0 : 1);
