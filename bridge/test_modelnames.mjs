// Model-name mapping probes with full pi-ai zai-shape params.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const BASE = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";

async function fire(label, xReqModel, bodyModel) {
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
    "X-Trace-Id": reqId,
    "X-Request-Id": reqId,
    "X-Request-Model": xReqModel,
    "X-Client-Type": "pc",
    "x_trace_id": "autoclaw-desktop",
    "X-Session-Id": crypto.randomUUID(),
    "X-Authorization": token,
  };
  const body = {
    model: bodyModel,
    messages: [{ role: "user", content: "用一句话解释什么是幂等性。" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 64,
    thinking: { type: "disabled" },
  };
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    let brief = t.slice(0, 150) || "(empty)";
    if (r.status === 200) {
      const m = t.match(/"content"\s*:\s*"([^"]{0,80})/);
      brief = "CONTENT: " + (m ? m[1] : t.slice(0, 120));
    }
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms): ${brief}`);
    return r.status;
  } catch (e) {
    console.log(`[${label}] ERR: ${e.message}`);
    return 0;
  }
}

const tests = [
  ["K1 auto", "zai_auto", "auto"],
  ["K2 coding-glm", "zaicoding_glm-5.3", "glm-5.3"],
  ["K3 prefixed+fullparams", "zai_glm-5.3-flash", "zai_glm-5.3-flash"],
];
let ok = 0;
for (const [label, xrm, bm] of tests) {
  ok = await fire(label, xrm, bm);
  if (ok === 200) break;
  await new Promise((s) => setTimeout(s, 5000));
}
process.exit(ok === 200 ? 0 : 1);
