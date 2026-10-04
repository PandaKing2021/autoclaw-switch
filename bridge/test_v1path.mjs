// /v1 path variant probe (after cooldown), J-shape.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const ACC = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";

async function fire(label, base, model) {
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
    "X-Request-Model": model,
    "X-Client-Type": "pc",
    "x_trace_id": "autoclaw-desktop",
    "X-Session-Id": crypto.randomUUID(),
    "X-Authorization": token,
  };
  const body = { model, messages: [{ role: "user", content: "用一句话解释什么是幂等性。" }], stream: true, max_tokens: 32 };
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms):`, t.slice(0, 160) || "(empty)");
  } catch (e) {
    console.log(`[${label}] ERR:`, e.message);
  }
}

await fire("L1 v1-path", ACC + "/v1", "glm-5.3-flash");
await new Promise((s) => setTimeout(s, 6000));
await fire("L2 v1-path-prefixed", ACC + "/v1", "zai_glm-5.3-flash");
