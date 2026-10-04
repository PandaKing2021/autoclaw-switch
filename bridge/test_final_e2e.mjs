// Final e2e: realistic long conversation through the relay (Anthropic format).
import fs from "node:fs";

const body = fs.readFileSync("D:/projects/autoclaw-to-zcode/bridge/e2e_long.json", "utf8");
const t0 = Date.now();
const r = await fetch("http://127.0.0.1:18766/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": "autoclaw-local", "anthropic-version": "2023-06-01" },
  body,
  signal: AbortSignal.timeout(400000),
});
console.log("HTTP", r.status, `(${Date.now() - t0}ms)`);
const t = await r.text();
try {
  const j = JSON.parse(t);
  const txt = (j.content?.map((b) => b.text || "").join("") || "").slice(0, 300);
  console.log("reply:", txt);
  console.log("stop:", j.stop_reason, "| usage:", JSON.stringify(j.usage || {}));
  console.log(txt ? ">>> E2E SUCCESS" : ">>> stream empty");
} catch {
  console.log("raw:", t.slice(0, 300));
}
