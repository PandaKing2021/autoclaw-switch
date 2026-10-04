// Fetch hook: logs AutoClaw-related requests to capture the app's real wire format.
// Loaded via NODE_OPTIONS="--require <this file>" into the Electron main process.
const fs = require("fs");
const path = require("path");
const LOG = path.join(process.env.USERPROFILE || os.homedir(), ".autoclaw-relay", "capture.log");

function redact(v) {
  if (typeof v !== "string") return v;
  return v
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer <JWT>")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "<JWT>");
}
// full-fidelity mode: keep the token tail for rotation comparison (chat requests only)
function redactKeepTail(v) {
  if (typeof v !== "string") return v;
  return v.replace(/^(Bearer\s+\S+\.)(\S+)\.(\S+)$/i, (m, p1, p2, p3) => p1 + "<P2>." + p3.slice(-16));
}

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  try {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (/autoclaw|zhipuai|autoglm/i.test(url) && init && init.method === "POST") {
      const headers = init.headers || {};
      const isChat = /chat\/completions/.test(url);
      const flat = {};
      if (typeof headers.forEach === "function") headers.forEach((v, k) => (flat[k] = isChat ? redactKeepTail(v) : redact(v)));
      else for (const k of Object.keys(headers)) flat[k] = isChat ? redactKeepTail(String(headers[k])) : redact(String(headers[k]));
      let body = init.body;
      if (typeof body !== "string" && body) {
        try { body = Buffer.from(body).toString("utf8"); } catch { body = String(body); }
      }
      const line = JSON.stringify({ at: new Date().toISOString(), url, method: "POST", headers: flat, body: redact(typeof body === "string" ? body : "") });
      fs.appendFileSync(LOG, line + "\n");
    }
  } catch { /* never break the app */ }
  return origFetch.call(this, input, init);
};
module.exports = {};
