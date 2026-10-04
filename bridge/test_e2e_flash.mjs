// End-to-end test: ZCode-style Anthropic request through the local relay.
// Mirrors what ZCode actually sends: system prompt + tools + messages.
import fs from "node:fs";

const body = {
  model: "GLM-5.3",
  max_tokens: 8192,
  stream: true,
  system: [
    { type: "text", text: "You are ZCode, an interactive coding agent running in a terminal. Help the user with software engineering tasks: read and edit code, run commands, run tests. Be concise and technical. Match the codebase's style. Today is 2026-10-03, platform win32." },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "用一句话解释什么是幂等性，然后回复OK。" }] },
  ],
  tools: [
    { name: "Read", description: "Read a file from the local filesystem. Supports text files and images.", input_schema: { type: "object", properties: { file_path: { type: "string", description: "Absolute path to the file" }, limit: { type: "number", description: "Max lines to read" } }, required: ["file_path"] } },
    { name: "Bash", description: "Execute a bash command and return stdout/stderr.", input_schema: { type: "object", properties: { command: { type: "string", description: "The command to run" }, timeout: { type: "number", description: "Timeout in ms" } }, required: ["command"] } },
    { name: "Edit", description: "Exact string replacement in a file.", input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  ],
  temperature: 1,
};

const t0 = Date.now();
const r = await fetch("http://127.0.0.1:18766/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "autoclaw-local",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(480000),
});
console.log("HTTP", r.status, `(${Date.now() - t0}ms)`, "| ct:", r.headers.get("content-type"));

if (r.status === 200) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", usage = null, blockType = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === "content_block_start") blockType = ev.content_block?.type || "";
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text;
        if (ev.type === "message_delta" && ev.usage) usage = ev.usage;
        if (ev.type === "error") { console.log("STREAM ERROR:", JSON.stringify(ev).slice(0, 200)); }
      } catch { /* partial */ }
    }
  }
  console.log("assistant text:", JSON.stringify(text.slice(0, 300)));
  console.log("usage:", JSON.stringify(usage));
  console.log(text.trim() ? ">>> E2E SUCCESS: model replied through the relay" : ">>> stream ended without text");
} else {
  console.log("body:", (await r.text()).slice(0, 300));
}
