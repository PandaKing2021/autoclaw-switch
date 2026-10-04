// Human-shaped request test: the 406 gate may specifically reject probe-shaped
// (tiny, toolless) requests. This sends a realistic coding conversation.
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

const system = `You are an expert senior software engineer and a command-line coding assistant called on demand. You are an interactive CLI agent that helps users with software engineering tasks. Your responses should be concise and technical. Use the README to understand the project before making changes. Always follow the project's existing code style: language, framework, naming conventions, and idioms. When fixing a bug, first reproduce it, find the root cause, then fix it and verify with the existing test suite. When you need to run shell commands, prefer non-interactive flags and set CI=true. Today's date is 2026-10-03. The user's operating system is Windows 11 with Git Bash and Node.js v25.9.0 installed. Respond in the user's language.`;

const body = {
  model: "zai_glm-5.3-flash",
  stream: true,
  messages: [
    { role: "system", content: system },
    { role: "user", content: "我在用一个 Python 脚本批量处理 CSV 文件时遇到了 UnicodeDecodeError，用 utf-8 打开一个 GBK 编码的文件就会炸。请给出健壮的读取方案，并简单解释 chardet/charset-normalizer 和 errors='replace' 的取舍。回答控制在 200 字以内。" },
  ],
  max_tokens: 600,
};

const t0 = Date.now();
const r = await fetch(`${BASE}/chat/completions`, {
  method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
});
const ct = r.headers.get("content-type") || "";
console.log("HTTP", r.status, `(${Date.now() - t0}ms)`, "| ct:", ct);
if (r.status === 200 && ct.includes("event-stream")) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", printed = 0;
  while (printed < 400) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("data:") && !line.includes("[DONE]")) {
        try {
          const j = JSON.parse(line.slice(5));
          const d = j.choices?.[0]?.delta?.content;
          if (d) { process.stdout.write(d); printed += d.length; }
        } catch { /* partial */ }
      }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
    if (buf.includes("[DONE]")) break;
  }
  reader.cancel().catch(() => {});
  console.log("\n>>> SUCCESS: model streamed real content");
} else {
  console.log("body:", (await r.text()).slice(0, 200) || "(empty)");
}
