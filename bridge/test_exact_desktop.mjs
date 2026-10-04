// Exact desktop-shape attempt: prefixed model + streaming + SSE accept + managed header contract.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const BASE = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const reqId = crypto.randomUUID();
const ts = String(Math.floor(Date.now() / 1e3));

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
  "X-Request-Model": "zai_glm-5.3-flash",
  "X-Client-Type": "pc",
  "x_trace_id": "autoclaw-desktop",
  "X-Session-Id": crypto.randomUUID(),
  "X-Authorization": token,
};

const body = {
  model: "zai_glm-5.3-flash",
  stream: true,
  messages: [{ role: "user", content: "reply READY" }],
  max_tokens: 8,
};

const t0 = Date.now();
const r = await fetch(`${BASE}/chat/completions`, {
  method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
});
const ct = r.headers.get("content-type") || "";
console.log("HTTP", r.status, `(${Date.now() - t0}ms)`, "| ct:", ct);
if (r.status === 200 && ct.includes("event-stream")) {
  const reader = r.body.getReader();
  let got = 0;
  while (got < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value).toString("utf8");
    process.stdout.write(chunk.slice(0, 300));
    if (chunk.includes("[DONE]")) break;
    got++;
  }
  reader.cancel().catch(() => {});
  console.log("\n>>> SUCCESS: model stream flowing");
} else {
  console.log("body:", (await r.text()).slice(0, 200) || "(empty)");
}
