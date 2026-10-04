// Systematic single-variable probes from the best-so-far shape (C).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const ACC = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const API = "https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const uuid = () => crypto.randomUUID();
const MARKER = "OpenClaw plugin-injected system context. This block is part of the harness protocol.";

async function probe(label, base_, { version = "2.0.1", authHeader = "X-Authorization", marker = false, body = {}, extraHeaders = {} }) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = uuid();
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
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
    "X-Request-Model": "zai_glm-5.3-flash",
    "X-Client-Type": "pc",
    x_trace_id: "autoclaw-desktop",
    "X-Session-Id": uuid(),
    [authHeader]: token,
    ...extraHeaders,
  };
  const b = { model: "glm-5.3-flash", max_tokens: 8, stream: false, messages: [{ role: "user", content: "reply READY" }], ...body };
  if (marker) b.messages = [{ role: "system", content: MARKER }, ...b.messages];
  const t0 = Date.now();
  try {
    const r = await fetch(`${base_}/chat/completions`, {
      method: "POST", headers: h, body: JSON.stringify(b), signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    let brief = txt.slice(0, 150) || "(empty body)";
    try {
      const j = JSON.parse(txt);
      brief = (j.choices?.[0]?.message?.content ?? JSON.stringify(j)).slice(0, 150);
    } catch { /* raw */ }
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms): ${brief}`);
    return r.status;
  } catch (e) {
    console.log(`[${label}] ERR: ${e.message}`);
    return 0;
  }
}

const tests = [
  ["I1 baseline(C)", ACC, {}],
  ["I2 +marker", ACC, { marker: true }],
  ["I3 version=1.17.8", ACC, { version: "1.17.8" }],
  ["I4 auth-in-Authorization", ACC, { authHeader: "Authorization" }],
  ["I5 old-api-cn+marker+1.17.8", API, { marker: true, version: "1.17.8" }],
];

let last = 0;
for (const [label, base_, opts] of tests) {
  last = await probe(label, base_, opts);
  if (last === 200) break;
  await new Promise((s) => setTimeout(s, 4000));
}
process.exit(last === 200 ? 0 : 1);
