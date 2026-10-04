// Standalone repro of the relay's httpsFetch shim.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

function httpsFetch(urlStr, init = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    if (u.protocol !== "https:") return globalThis.fetch(urlStr, init).then(resolve, reject);
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (body != null && typeof body !== "string" && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
      body = Buffer.from(String(body));
    }
    if (body != null) headers["content-length"] = String(Buffer.byteLength(body));
    console.log("shim: issuing request, content-length =", headers["content-length"]);
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: init.method || "GET", headers, servername: u.hostname,
    }, (res) => {
      console.log("shim: response", res.statusCode);
      const hmap = new Map();
      for (const [k, v] of Object.entries(res.headers)) hmap.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v);
      let closed = false;
      const stream = new ReadableStream({
        start(ctrl) {
          res.on("data", (c) => { if (!closed) ctrl.enqueue(new Uint8Array(c)); });
          res.on("end", () => { if (!closed) { closed = true; ctrl.close(); } });
          res.on("error", (e) => { if (!closed) { closed = true; ctrl.error(e); } });
          res.pause();
        },
        pull() { res.resume(); },
        cancel() { closed = true; res.destroy(); },
      });
      let textBuf = null;
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || "",
        headers: { get: (k) => hmap.get(String(k).toLowerCase()) ?? null },
        body: stream,
        text: () => new Promise((r2, j2) => {
          if (textBuf !== null) return r2(textBuf);
          res.on("data", (c) => (textBuf = (textBuf || "") + c.toString("utf8")));
          res.on("end", () => { textBuf = textBuf || ""; r2(textBuf); });
          res.on("error", j2);
        }),
      });
    });
    req.on("error", (e) => { console.log("shim: req error", e.message); reject(e); });
    if (init.signal) {
      const sig = init.signal;
      if (sig.aborted) req.destroy(sig.reason || new Error("aborted"));
      else sig.addEventListener("abort", () => req.destroy(sig.reason || new Error("aborted")), { once: true });
    }
    if (body != null) req.write(body);
    req.end();
  });
}

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
  "x-request-model": "zai_glm-5.3-flash",
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
const body = JSON.stringify({
  model: "zai_glm-5.3-flash",
  messages: [{ role: "user", content: "reply OK" }],
  stream: true, stream_options: { include_usage: true }, store: false,
  max_completion_tokens: 128, reasoning_effort: "low",
});

const t0 = Date.now();
const res = await httpsFetch("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions", {
  method: "POST", headers, body, signal: AbortSignal.timeout(60000),
});
console.log("status:", res.status, `(${Date.now() - t0}ms)`);
const text = await res.text();
console.log("body head:", text.slice(0, 200));
