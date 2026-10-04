// Matrix: exact captured body + runtime/transport variants.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

// Exact captured body (last chat entry)
const lines = fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/capture.log"), "utf8").split("\n").filter(Boolean);
const chatEntry = lines.map((l) => JSON.parse(l)).filter((d) => /chat\/completions/.test(d.url)).pop();
const exactBody = chatEntry.body;
const HOST = "autoglm-acceleration-api.zhipuai.cn";
const PATH = "/autoclaw-proxy/proxy/autoclaw/chat/completions";

function buildHeaders() {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = crypto.randomUUID();
  // Insertion order copied from the captured request (as logged)
  return {
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
}

// Raw https request so we can pin transport details and reuse the socket.
function rawRequest(httpsAgent, bodyStr, label) {
  return new Promise((resolve) => {
    const headers = buildHeaders();
    headers["content-length"] = Buffer.byteLength(bodyStr);
    const t0 = Date.now();
    const req = https.request({
      host: HOST, port: 443, path: PATH, method: "POST", headers,
      agent: httpsAgent, servername: HOST,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { if (data.length < 400) data += c.toString("utf8"); });
      res.on("end", () => {
        let brief = data.slice(0, 120) || "(empty)";
        if (res.statusCode === 200) {
          const m = data.match(/"content"\s*:\s*"([^"]{0,60})/);
          brief = "CONTENT: " + (m ? m[1] : data.slice(0, 80));
        }
        console.log(`[${label}] ${res.statusCode} (${Date.now() - t0}ms): ${brief}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (e) => { console.log(`[${label}] ERR: ${e.message}`); resolve(0); });
    req.setTimeout(90000, () => { req.destroy(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

const mode = process.argv[2] || "all";
if (mode === "exact" || mode === "all") {
  const st = await rawRequest(new https.Agent({ keepAlive: true, maxSockets: 1 }), exactBody, "R1 node25+exact-body");
  if (st === 200) process.exit(0);
  await new Promise((s) => setTimeout(s, 5000));
}
if (mode === "keepalive" || mode === "all") {
  // Same socket, 3 sequential requests: does a warmed connection pass the gate?
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  for (let i = 1; i <= 3; i++) {
    const st = await rawRequest(agent, exactBody, `R3-keepalive#${i}`);
    if (st === 200) process.exit(0);
    await new Promise((s) => setTimeout(s, 4000));
  }
}
process.exit(1);
