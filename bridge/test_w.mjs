// W-test: persona-merged system + REAL ZCode content (no synthetic pad).
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

// The 15:14 dump = ZCode real request WITHOUT padding (pre-padding-patch).
// Find the oldest dump containing the real ZCode user content.
const dumpDir = path.join(os.homedir(), ".autoclaw-relay/dumps");
const dumps = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".outbound.json")).sort();
let zbody = null;
for (const f of dumps) {
  const d = JSON.parse(fs.readFileSync(path.join(dumpDir, f), "utf8"));
  const user = (d.messages || []).find((m) => m.role === "user");
  if (user && user.content.length > 5000 && !/workspace-skill/.test(user.content)) {
    zbody = d; // first unpadded real ZCode body
    break;
  }
}
if (!zbody) { console.log("no unpadded ZCode dump found"); process.exit(1); }
const zUser = zbody.messages.find((m) => m.role === "user").content;
const zSystem = (zbody.messages.find((m) => m.role === "system") || {}).content || "";
console.log("zUser len:", zUser.length, "| zSystem len:", zSystem.length, "| tools:", zbody.tools?.length);

const persona = "You are AutoClaw. Answer the user directly and concisely.";

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

const b = JSON.parse(JSON.stringify(zbody));
b.model = "zaicoding_glm-5.3";
b.max_completion_tokens = 307200;
b.reasoning_effort = "high";
b.store = false;
const si = b.messages.findIndex((m) => m.role === "system");
if (si !== -1) b.messages[si] = { role: "system", content: persona + "\n\n" + zSystem };

let st = await fire("W1 persona+realContent", b);
if (st !== 200) {
  await new Promise((s) => setTimeout(s, 4000));
  const b2 = JSON.parse(JSON.stringify(zbody));
  b2.model = "zaicoding_glm-5.3";
  b2.max_completion_tokens = 307200;
  b2.reasoning_effort = "high";
  b2.store = false;
  const si2 = b2.messages.findIndex((m) => m.role === "system");
  if (si2 !== -1) b2.messages.splice(si2, 1);
  b2.messages.unshift({ role: "user", content: "[系统说明]\n" + zSystem + "\n[系统说明结束]\n" });
  st = await fire("W2 persona-only-sys", b2);
}
process.exit(st === 200 ? 0 : 1);
