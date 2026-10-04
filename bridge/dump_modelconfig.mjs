import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".autoclaw-relay/auth-compat/auth.json"), "utf8"));
const token = /^Bearer\s/i.test(auth.token) ? auth.token : `Bearer ${auth.token}`;
const ts = String(Math.floor(Date.now() / 1e3));
const h = {
  "X-Version": "2.0.1", "X-Tm": "win", "X-Product": "autoclaw",
  "X-Auth-Appid": "100003", "X-Auth-TimeStamp": ts,
  "X-Auth-Sign": crypto.createHash("md5").update(`100003&${ts}&38d2391985e2369a5fb8227d8e6cd5e5`).digest("hex"),
  "X-Lang": "zh-CN", "X-Channel": "official", "X-Client-Type": "pc",
  "Authorization": token,
};
const r = await fetch("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw-model-config", { headers: h, signal: AbortSignal.timeout(30000) });
const t = await r.text();
console.log("status:", r.status);
try {
  const j = JSON.parse(t);
  for (const m of j.models) {
    console.log("\n==", m.id, "(", m.name, ")");
    console.log("  metadata:", JSON.stringify(m.metadata));
  }
  if (j.default_model) console.log("\ndefault_model:", JSON.stringify(j.default_model));
  for (const k of Object.keys(j)) if (k !== "models") console.log("top-level:", k, "=", JSON.stringify(j[k]).slice(0, 300));
} catch {
  console.log(t.slice(0, 800));
}
