// Capture server: logs whatever the relay sends, responds 200 SSE.
import http from "node:http";
import fs from "node:fs";

const LOG = "D:/projects/autoclaw-to-zcode/bridge/relay_outbound.json";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.writeFileSync(LOG, JSON.stringify({
      url: req.url, method: req.method,
      headers: req.headers,
      bodyPreview: body.slice(0, 300),
    }, null, 1));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cap", object: "chat.completion", created: 1, model: "zaicoding_glm-5.3",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
}).listen(18999, "127.0.0.1", () => console.log("capture server on 18999"));
