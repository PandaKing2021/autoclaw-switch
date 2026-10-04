// Replay the exact captured desktop request shape (OpenAI SDK fingerprint included).
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
  "accept": "application/json",
  "content-type": "application/json",
  "user-agent": "OpenAI/JS 6.26.0",
  "x-agent-id": "main",
  "x-auth-appid": APP_ID,
  "x-auth-sign": crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
  "x-auth-timestamp": ts,
  "x-authorization": token,
  "x-channel": "official",
  "x-client-type": "pc",
  "x-lang": "zh-CN",
  "x-product": "autoclaw",
  "x-request-id": reqId,
  "x-request-model": "zaicoding_glm-5.3",
  "x-session-id": crypto.randomUUID(),
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "6.26.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.18.0",
  "x-tm": "win",
  "x-trace-id": reqId,
  "x-version": "2.0.1",
  "x_trace_id": "autoclaw-desktop",
};

const body = {
  model: "zaicoding_glm-5.3",
  messages: [{ role: "user", content: "请只回复两个字母：OK" }],
  stream: true,
  stream_options: { include_usage: true },
  store: false,
  max_completion_tokens: 1024,
  reasoning_effort: "high",
};

const t0 = Date.now();
const r = await fetch(`${BASE}/chat/completions`, {
  method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
});
console.log("HTTP", r.status, `(${Date.now() - t0}ms)`, "| ct:", r.headers.get("content-type"));
if (r.status === 200) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", printed = 0;
  while (printed < 200) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("data:") && !line.includes("[DONE]")) {
        try {
          const j = JSON.parse(line.slice(5));
          const d = j.choices?.[0]?.delta;
          if (d?.reasoning_content) continue;
          if (d?.content) { process.stdout.write(d.content); printed += d.content.length; }
        } catch { /* partial json */ }
      }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
    if (buf.includes("[DONE]")) break;
  }
  reader.cancel().catch(() => {});
  console.log("\n>>> SUCCESS: real model output streamed");
} else {
  console.log("body:", (await r.text()).slice(0, 300) || "(empty)");
}
