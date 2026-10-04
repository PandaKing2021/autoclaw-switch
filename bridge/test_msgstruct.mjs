// Message-structure bisect: count/multi-turn vs content size.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const HOST = "autoglm-acceleration-api.zhipuai.cn";
const PATH_URL = "/autoclaw-proxy/proxy/autoclaw/chat/completions";

const lines = fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/capture.log"), "utf8").split("\n").filter(Boolean);
const appBody = JSON.parse(lines.map((l) => JSON.parse(l)).filter((d) => /chat\/completions/.test(d.url)).pop().body);
const appSystem = (appBody.messages.find((m) => m.role === "system") || {}).content || "";

function fire(label, body) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1e3));
    const reqId = crypto.randomUUID();
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
      "x-request-model": body.model,
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
      "content-length": Buffer.byteLength(bodyStr),
    };
    const t0 = Date.now();
    const req = https.request({ host: HOST, path: PATH_URL, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", (c) => { if (data.length < 300) data += c.toString("utf8"); });
      res.on("end", () => {
        let brief = data.slice(0, 110) || "(empty)";
        if (res.statusCode === 200) {
          const m = data.match(/"content"\s*:\s*"([^"]{0,60})/);
          brief = "CONTENT: " + (m ? m[1] : data.slice(0, 80));
        }
        console.log(`[${label}] ${res.statusCode} (${Date.now() - t0}ms): ${brief}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (e) => { console.log(`[${label}] ERR: ${e.message}`); resolve(0); });
    req.setTimeout(120000, () => req.destroy(new Error("timeout")));
    req.write(bodyStr);
    req.end();
  });
}

const pad = fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/pad.txt"), "utf8");
const base = { model: "zaicoding_glm-5.3", stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 307200, reasoning_effort: "high", tools: appBody.tools };

// C1: app system + 4 small messages (multi-turn, small)
const c1 = { ...base, messages: [
  { role: "system", content: appSystem },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好！请问需要我帮你做什么？" },
  { role: "user", content: "帮我总结一下今天的日程安排。" },
  { role: "assistant", content: "今天暂无日程。需要我创建一个提醒吗？" },
  { role: "user", content: "请只回复OK" },
] };

// C2: app system + 4 messages where first user carries the pad
const c2 = { ...base, messages: [
  { role: "system", content: appSystem },
  { role: "user", content: "以下是工作区上下文：\n" + pad + "\n（上下文结束）" },
  { role: "assistant", content: "已了解工作区上下文。" },
  { role: "user", content: "请只回复OK" },
] };

let s1 = await fire("C1 small-multiturn", c1);
await new Promise((s) => setTimeout(s, 4000));
let s2 = await fire("C2 first-user-pad", c2);
process.exit(s1 === 200 || s2 === 200 ? 0 : 1);
