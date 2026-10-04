// Bisect the poison in the relay's failed outbound body.
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
const dumpDir = path.join(os.homedir(), ".autoclaw-relay/dumps");
const dumps = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".outbound.json"));
const bad = JSON.parse(fs.readFileSync(path.join(dumpDir, dumps[dumps.length - 1]), "utf8"));
console.log("dump model:", bad.model, "| msgs:", bad.messages.length, "| tools:", bad.tools?.length, "| effort:", bad.reasoning_effort, "| mct:", bad.max_completion_tokens, "| temperature:", bad.temperature);

function fire(label, bodyObj) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(bodyObj);
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
      "x-request-model": bodyObj.model,
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
          brief = "CONTENT ok: " + (m ? m[1] : data.slice(0, 80));
        }
        console.log(`[${label}] ${res.statusCode} (${Date.now() - t0}ms) bytes=${Buffer.byteLength(bodyStr)}: ${brief}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (e) => { console.log(`[${label}] ERR: ${e.message}`); resolve(0); });
    req.setTimeout(150000, () => req.destroy(new Error("timeout")));
    req.write(bodyStr);
    req.end();
  });
}

const t1 = JSON.parse(JSON.stringify(bad));
let st = await fire("T1 dump-verbatim", t1);
if (st === 200) process.exit(0);
await new Promise((s) => setTimeout(s, 3000));

const t2 = JSON.parse(JSON.stringify(bad));
t2.temperature = undefined; delete t2.temperature;
st = await fire("T2 no-temperature", t2);
if (st === 200) process.exit(0);
await new Promise((s) => setTimeout(s, 3000));

const t3 = JSON.parse(JSON.stringify(bad));
const si = t3.messages.findIndex((m) => m.role === "system");
if (si !== -1) t3.messages[si] = { role: "system", content: "You are AutoClaw. Answer the user directly and concisely." };
st = await fire("T3 app-persona-system", t3);
if (st === 200) process.exit(0);
await new Promise((s) => setTimeout(s, 3000));

const t4 = JSON.parse(JSON.stringify(bad));
t4.tools = appBody.tools;
st = await fire("T4 app-tools", t4);
process.exit(st === 200 ? 0 : 1);
