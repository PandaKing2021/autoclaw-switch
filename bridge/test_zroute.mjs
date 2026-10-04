// Replay ZCode's real translated body on the GLM-5.3 (zaicoding) route.
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

// ZCode's real translated body from the latest failure dump
const dumpDir = path.join(os.homedir(), ".autoclaw-relay/dumps");
const dumps = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".outbound.json"));
const zbody = JSON.parse(fs.readFileSync(path.join(dumpDir, dumps[dumps.length - 1]), "utf8"));
zbody.model = "zaicoding_glm-5.3"; // 仅换路由：其余与 relay 发出的完全一致

function fire(label, model, bodyObj) {
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
      "x-request-model": model,
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
        let brief = data.slice(0, 130) || "(empty)";
        if (res.statusCode === 200) {
          const m = data.match(/"content"\s*:\s*"([^"]{0,80})/);
          brief = "CONTENT: " + (m ? m[1] : data.slice(0, 100));
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

const s1 = await fire("Z1 zcode-body/zaicoding-route", "zaicoding_glm-5.3", zbody);
if (s1 !== 200) { await new Promise((s) => setTimeout(s, 4000)); }
const s2 = s1 === 200 ? 200 : await fire("Z2 zcode-body/flash-route(对照)", "zai_glm-5.3-flash", { ...zbody, model: "zai_glm-5.3-flash" });
process.exit(s1 === 200 || s2 === 200 ? 0 : 1);
