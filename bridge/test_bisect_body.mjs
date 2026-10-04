// Bisect the zaicoding-route gate starting from the always-pass app body.
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
      res.on("data", (c) => { if (data.length < 400) data += c.toString("utf8"); });
      res.on("end", () => {
        let brief = data.slice(0, 110) || "(empty)";
        if (res.statusCode === 200) brief = "CONTENT ok: " + data.slice(0, 60);
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

const y1 = JSON.parse(JSON.stringify(appBody));
const y2 = JSON.parse(JSON.stringify(appBody)); y2.max_completion_tokens = 8192;
const y3 = JSON.parse(JSON.stringify(appBody)); y3.messages = [{ role: "user", content: "请只回复OK" }];
const y4 = JSON.parse(JSON.stringify(appBody)); y4.tools = [{ type: "function", function: { name: "noop", description: "No-op.", parameters: { type: "object", properties: {}, required: [] } } }];

let st = await fire("Y1 verbatim", y1);
if (st === 200) { st = await fire("Y2 budget-8192", y2); }
if (st === 200) { st = await fire("Y3 single-msg", y3); }
if (st === 200) { st = await fire("Y4 single-tool", y4); }
process.exit(st === 200 ? 0 : 1);
