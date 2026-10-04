// One-shot contract verification for AutoClaw 2.x managed model gateway.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const DEVICE_ID = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, "AutoClaw-official/device/device-id.json"), "utf8")).deviceId;

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const BASE = "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw";
const uuid = () => crypto.randomUUID();

async function readBrief(r) {
  const ct = r.headers.get("content-type") || "";
  if (r.status === 200 && ct.includes("event-stream")) {
    const reader = r.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return "SSE: " + Buffer.from(value).toString("utf8").slice(0, 200);
  }
  const txt = await r.text();
  try {
    const j = JSON.parse(txt);
    const c = j.choices?.[0]?.message?.content ?? j.error ?? "";
    return (typeof c === "string" ? c : JSON.stringify(c)).slice(0, 160)
      + ` | usage=${JSON.stringify(j.usage ?? {})}`;
  } catch { return txt.slice(0, 160) || "(empty body)"; }
}

async function attempt(label, { headers, body }) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const reqId = uuid();
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
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
    "X-Client-Type": "pc",
    x_trace_id: "autoclaw-desktop",
    ...headers,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const brief = await readBrief(r);
    console.log(`[${label}] HTTP ${r.status} (${Date.now() - t0}ms): ${brief}`);
    return r.status === 200;
  } catch (e) {
    console.log(`[${label}] ERR (${Date.now() - t0}ms): ${e.message}${e.cause ? " / " + e.cause : ""}`);
    return false;
  }
}

const MARKER = "OpenClaw plugin-injected system context. This block is part of the harness protocol.";
const base = {
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "reply READY" }],
  max_tokens: 8,
  stream: false,
};
const authH = { "X-Authorization": token, "X-Request-Model": "zai_glm-5.3-flash", "X-Device-Id": DEVICE_ID };

const variants = [
  ["E unprefixed+device", { headers: authH, body: base }],
  ["F stream:true", { headers: { ...authH, Accept: "text/event-stream" }, body: { ...base, stream: true } }],
  ["G harness-marker", { headers: { ...authH, Accept: "text/event-stream" }, body: { ...base, stream: true, messages: [{ role: "system", content: MARKER }, base.messages[0]] } }],
  ["H legacy-version", { headers: { ...authH, "X-Version": "1.18.5.851" }, body: base }],
];

let ok = false;
for (const [label, v] of variants) {
  ok = await attempt(label, v);
  if (ok) break;
  await new Promise((s) => setTimeout(s, 4000));
}
process.exit(ok ? 0 : 1);
