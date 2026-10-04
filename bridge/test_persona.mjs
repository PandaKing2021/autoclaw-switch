// Persona-gate bisect: what exactly must the system prompt contain?
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
const firstSentence = appSystem.split("\n")[0]; // "You are AutoClaw. Answer the user directly and concisely. Delivered files: ..."

function fire(label, system) {
  return new Promise((resolve) => {
    const body = { model: "zaicoding_glm-5.3", messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: "请只回复OK" },
    ], stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 307200, reasoning_effort: "high", tools: appBody.tools };
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
    req.setTimeout(150000, () => req.destroy(new Error("timeout")));
    req.write(bodyStr);
    req.end();
  });
}

let st;
st = await fire("D1 zcode-persona", "You are ZCode, an interactive coding agent running in a terminal. Help the user with software engineering tasks.");
await new Promise((s) => setTimeout(s, 3000));
st = await fire("D2 app-first-sentence", firstSentence);
await new Promise((s) => setTimeout(s, 3000));
st = await fire("D3 app-system-no-first-sentence", appSystem.split("\n").slice(1).join("\n"));
await new Promise((s) => setTimeout(s, 3000));
st = await fire("D4 zcode+app-first-sentence", firstSentence + "\n\nYou are ZCode, an interactive coding agent running in a terminal. Help the user with software engineering tasks. Be concise.");
process.exit(st === 200 ? 0 : 1);
