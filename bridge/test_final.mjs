// Final two probe combos, then stop.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const uuid = () => crypto.randomUUID();
const MARKER = "OpenClaw plugin-injected system context. This block is part of the harness protocol.";

function buildHeaders(version) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = uuid();
  return {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "X-Version": version,
    "X-Tm": "win",
    "X-Product": "autoclaw",
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
    "X-Lang": "zh-CN",
    "X-Channel": "official",
    "X-Trace-Id": reqId,
    "X-Request-Id": reqId,
    "X-Client-Type": "pc",
    "x_trace_id": "autoclaw-desktop",
    "X-Session-Id": uuid(),
    "X-Authorization": token,
  };
}

async function fire(label, base, version, model, withMarker) {
  const body = {
    model,
    stream: true,
    max_tokens: 32,
    messages: [
      ...(withMarker ? [{ role: "system", content: MARKER }] : []),
      { role: "user", content: "用一句话说明什么是幂等性。" },
    ],
  };
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: buildHeaders(version), body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms): ${(t.slice(0, 180) || "(empty)")}`);
    return r.status;
  } catch (e) {
    console.log(`[${label}] ERR: ${e.message}`);
    return 0;
  }
}

const ACC = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const API = "https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";

let s1 = await fire("J1 old-api+patched-shape", API, "2.0.1", "glm-5.3-flash", false);
await new Promise((r) => setTimeout(r, 5000));
let s2 = await fire("J2 acc+marker+prefixed", ACC, "2.0.1", "zai_glm-5.3-flash", true);
process.exit(s1 === 200 || s2 === 200 ? 0 : 1);
