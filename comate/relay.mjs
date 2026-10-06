#!/usr/bin/env node
/**
 * Comate(文心快码) agent -> OpenAI/Anthropic compatible relay.
 *
 * Shape of the upstream (reversed 2026-10-06, see comate/probe_*.mjs):
 * Comate's Zulu agent runs SERVER-SIDE. The IDE/CLI drives it through
 * three calls against https://comate.baidu.com, auth = the license UUID the
 * IDE stores in %APPDATA%\Comate\User\settings.json (baidu.comate.license;
 * NOT the legacy 32-hex secret in state.vscdb — /api/key/valid rejects it):
 *
 *   GET  /api/key/valid/:license                              preflight
 *   POST /api/aidevops/autocomate/rest/autowork/v2/conversation  -> data.id
 *   POST /api/aidevops/autocomate/rest/autowork/v2/task          -> data.taskId
 *   POST /api/aidevops/autocomate/rest/autowork/v2/execute-sync  -> {frames:[...]}
 *
 * execute-sync returns the WHOLE answer as a JSON array of stringified
 * "frames"; ANSWER frames carry detail.delta / reasoningDelta, the last one
 * ends with end:true, and a TOKEN_USAGE frame carries usage.
 *
 * Transport matters: Baidu's WAF 406s python-urllib TLS fingerprints. The
 * CLI is Node/axios, so we speak node:https with the same header set
 * (User-Agent axios/1.16.1, Accept-Encoding with br, Connection keep-alive).
 *
 * Stateless like trae/ and doubao/: every request creates a fresh
 * conversation+task, the caller re-sends the full history flattened into
 * `query`; nothing session-shaped survives between requests.
 *
 * Tools: caller tools are NOT forwarded (the agent runs its own toolset
 * server-side), same class as Trae.
 *
 *   node relay.mjs [--port 18774] [--host 127.0.0.1]
 */
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://comate.baidu.com";
const API = BASE + "/api/aidevops/autocomate/rest/autowork";
const CLI_VERSION = "1.8.1";
const PLUGIN_VERSION = "4.13.0";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : fallback;
};
const PORT = Number(process.env.COMATE_RELAY_PORT || argOf("--port", 18774));
const HOST = process.env.COMATE_RELAY_HOST || argOf("--host", "127.0.0.1");

const SETTINGS_FILE = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Comate", "User", "settings.json",
);
const STATE_DIR = join(homedir(), ".comate-relay");

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

// ------------------------------------------------------------------ credentials
let credCache = { mtime: 0, license: "", username: "" };

function readCredentials() {
  let mtime = 0;
  try { mtime = statSync(SETTINGS_FILE).mtimeMs; } catch {}
  if (mtime && mtime === credCache.mtime && credCache.license) return credCache;
  const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  const license = settings["baidu.comate.license"];
  const username = settings["baidu.comate.username"] || "";
  if (!license) throw new Error("settings.json missing baidu.comate.license (Comate not logged in?)");
  credCache = { mtime, license, username };
  return credCache;
}

function deviceId() {
  // The CLI derives a stable device id; keep ours stable per install too.
  const f = join(STATE_DIR, "device.json");
  try { return JSON.parse(readFileSync(f, "utf8")).device; } catch {}
  const device = randomUUID();
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(f, JSON.stringify({ device })); } catch {}
  return device;
}

// ------------------------------------------------------------------- transport
function httpsJson(method, url, body, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = httpsRequest(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Source": "COMATE",
        "User-Agent": "axios/1.16.1",
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, compress, deflate, br",
        Connection: "keep-alive",
        "Accept-Language": "zh-CN,zh",
        ...(data ? { "Content-Length": data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`comate upstream timeout after ${timeoutMs}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

function cliHeaders(license) {
  return {
    "login-name": license,
    "Uuap-login-name": license,
    "plugin-version": "zulucli-" + PLUGIN_VERSION,
    "x-skip-fcnap": "yes",
  };
}

// ------------------------------------------------------------------- catalog
let catalogCache = { at: 0, models: [] };

async function fetchModels(license, username) {
  if (catalogCache.models.length && Date.now() - catalogCache.at < 600_000) return catalogCache.models;
  const r = await httpsJson("POST", BASE + "/api/v2/api/models/available",
    { username: license, key: license }, cliHeaders(license));
  let models = [];
  try {
    const j = JSON.parse(r.text);
    models = (j?.data?.models || [])
      .filter((m) => m && m.modelId)
      .map((m) => ({ id: m.modelId, name: m.displayName || m.modelId }));
  } catch {}
  if (models.length) catalogCache = { at: Date.now(), models };
  return models;
}

// ------------------------------------------------------------- upstream chain
async function createConversation(license, trace) {
  const r = await httpsJson("POST", API + "/v2/conversation", {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION, agentId: 1,
  }, { ...cliHeaders(license), "X-Trace-Id": trace });
  const j = JSON.parse(r.text);
  if (j?.code !== 200 || !j?.data?.id) throw new Error(`conversation create failed: ${r.status} ${r.text.slice(0, 200)}`);
  return j.data.id;
}

async function createTask(license, conversationId, trace) {
  const r = await httpsJson("POST", API + "/v2/task", {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION,
    agentId: 1, conversationId, agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false },
  }, { ...cliHeaders(license), "X-Trace-Id": trace });
  const j = JSON.parse(r.text);
  if (j?.code !== 200 || !j?.data?.taskId) throw new Error(`task create failed: ${r.status} ${r.text.slice(0, 200)}`);
  return j.data.taskId;
}

function flattenQuery(messages) {
  // Stateless flatten, same spirit as trae/: system becomes a bracketed
  // transcript header so the agent sees it as instructions, not its own.
  const parts = [];
  for (const m of messages) {
    const role = m?.role === "assistant" ? "Assistant" : m?.role === "system" ? "System instructions" : "User";
    const text = typeof m?.content === "string" ? m.content : "";
    if (text.trim()) parts.push(`[${role}]\n${text.trim()}`);
  }
  return parts.join("\n\n") || "hello";
}

async function executeSync(license, conversationId, taskId, query, modelKey) {
  const body = {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION,
    taskId, conversationId, agentId: 1,
    uploadBaseInfo: {
      os: "Windows 10", osVersion: "Windows 10", extName: "zulucli", extVersion: PLUGIN_VERSION,
      ideType: "zulucli", ideName: "zulucli", ideVersion: CLI_VERSION, vcsRepo: "", vcsBranchName: "",
      username: license, license, pluginVersion: PLUGIN_VERSION, device: deviceId(), triggerSource: "Agent",
    },
    query, modelKey,
    sysInfo: {
      os: "Windows 10", defaultShell: "cmd.exe", homeDir: homedir(),
      installedCommands: ["node", "npm", "python"], notInstalledCommands: [],
      workspacePath: process.cwd(), workspaceRoots: [process.cwd()],
    },
    skillInfos: [], hasMcp: false, isUserQuery: true, isMockQuery: false,
    localIndex: false, contexts: [], toolUseResults: [], subAgents: [],
    agentVersion: "12", isFirstQuery: true, enableMemory: false, systemReminder: "",
    extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
    extend: { isMultiWorkspace: false, useWorkflow: false },
    sendMode: "normal", queryId: randomUUID(), langfuseTraceId: "", langfuseTraceparent: "",
    agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false },
  };
  const r = await httpsJson("POST", API + "/v2/execute-sync", body,
    { ...cliHeaders(license), "X-Trace-Id": randomUUID() }, 240000);
  let j;
  try { j = JSON.parse(r.text); } catch { throw new Error(`execute-sync non-JSON (${r.status}): ${r.text.slice(0, 200)}`); }
  if (Array.isArray(j?.detail) || j?.detail?.exceptionMsg || j?.type === "EXCEPTION") {
    throw new Error(`execute-sync rejected: ${r.text.slice(0, 240)}`);
  }
  let text = "", reasoning = "", end = false, usage = null;
  for (const raw of j?.frames || []) {
    let f;
    try { f = JSON.parse(raw); } catch { continue; }
    const c = f?.content || {};
    if (c.type === "ANSWER") {
      const d = (() => { try { return JSON.parse(c.text || "{}"); } catch { return {}; } })();
      const dd = d.detail || d;
      text += dd.delta || "";
      reasoning += dd.reasoningDelta || "";
      if (dd.end || f.end) end = true;
    } else if (c.type === "TOKEN_USAGE") {
      try {
        const u = JSON.parse(c.text || "{}");
        const num = (...keys) => { for (const k of keys) { const v = u?.[k] ?? u?.data?.[k]; if (Number.isFinite(v)) return v; } return undefined; };
        usage = {
          input_tokens: num("input_tokens", "prompt_tokens", "inputTokens", "promptTokens") ?? 0,
          output_tokens: num("output_tokens", "completion_tokens", "outputTokens", "completionTokens") ?? 0,
          raw: u,
        };
      } catch {}
    }
  }
  return { text, reasoning, end, usage };
}

async function comateChat({ messages, modelKey }) {
  const cred = readCredentials();
  const license = cred.license;
  const trace = randomUUID();
  const conversationId = await createConversation(license, trace);
  const taskId = await createTask(license, conversationId, trace);
  const query = flattenQuery(messages);
  const out = await executeSync(license, conversationId, taskId, query, modelKey || "auto");
  log(`chat model=${modelKey || "auto"} conv=${conversationId} task=${taskId} chars=${out.text.length}`);
  return out;
}

// -------------------------------------------------------------------- flatten helpers for OpenAI/Anthropic
function normalizeOpenAIMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((p) => p?.type === "text" || typeof p?.text === "string")
        .map((p) => p.text || "").join("\n");
    }
    if (text.trim()) out.push({ role: m.role, content: text });
  }
  return out;
}

function normalizeAnthropicMessages(body) {
  const out = [];
  if (body?.system) {
    const s = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => b?.text || "").join("\n") : "";
    if (s.trim()) out.push({ role: "system", content: s });
  }
  for (const m of body?.messages || []) {
    const text = Array.isArray(m.content)
      ? m.content.filter((p) => p?.type === "text" || typeof p === "string")
          .map((p) => (typeof p === "string" ? p : p.text || "")).join("\n")
      : m.content || "";
    if (String(text).trim()) out.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(text) });
  }
  return out;
}

// ---------------------------------------------------------------------- SSE
function sseChunk(res, model, text, reasoning, opts) {
  const d = { id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] };
  if (reasoning) d.choices[0].delta.reasoning_content = reasoning;
  if (text) d.choices[0].delta.content = text;
  if (opts?.usage) d.usage = opts.usage;
  if (opts?.finish) { d.choices[0].delta = {}; d.choices[0].finish_reason = "stop"; }
  res.write(`data: ${JSON.stringify(d)}\n\n`);
}

function splitChunks(text, n = 24) {
  if (!text) return [];
  const size = Math.max(8, Math.ceil(text.length / n));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// --------------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/health" || p === "/") {
      let ok = false, user = "";
      try { const c = readCredentials(); ok = !!c.license; user = c.username; } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok, service: "comate-relay", mode: "stateless",
        credential: ok ? `ok (${user})` : "missing (Comate not logged in)",
        models_cached: catalogCache.models.length,
      }));
      return;
    }
    if (p === "/v1/models") {
      const cred = readCredentials();
      const models = await fetchModels(cred.license, cred.username);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: "comate", display_name: m.name })) }));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));
    const payload = body ? JSON.parse(body) : {};

    if (p === "/v1/messages" || p === "/messages") {
      // Anthropic shape
      const model = payload.model || "auto";
      const msgs = normalizeAnthropicMessages(payload);
      const wantStream = !!payload.stream;
      const out = await comateChat({ messages: msgs, modelKey: model });
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model, content: [] } })}\n\n`);
        if (out.reasoning) res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: out.reasoning } })}\n\n`);
        for (const piece of splitChunks(out.text)) {
          res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(out.text.length / 4) } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_" + randomUUID(), type: "message", role: "assistant", model,
          content: [{ type: "text", text: out.text }],
          stop_reason: "end_turn",
          usage: { input_tokens: out.usage?.input_tokens || 0, output_tokens: out.usage?.output_tokens || Math.ceil(out.text.length / 4) },
        }));
      }
      return;
    }

    if (p === "/v1/chat/completions" || p === "/chat/completions") {
      const model = payload.model || "auto";
      const msgs = normalizeOpenAIMessages(payload.messages);
      const wantStream = !!payload.stream;
      const out = await comateChat({ messages: msgs, modelKey: model });
      const usage = {
        prompt_tokens: out.usage?.input_tokens || 0,
        completion_tokens: out.usage?.output_tokens || Math.ceil(out.text.length / 4),
        total_tokens: (out.usage?.input_tokens || 0) + (out.usage?.output_tokens || Math.ceil(out.text.length / 4)),
      };
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const piece of splitChunks(out.text)) sseChunk(res, model, piece, "");
        sseChunk(res, model, "", "", { finish: true, usage });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-" + randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }],
          usage,
          comate: { mode: "stateless" },
        }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${p}` } }));
  } catch (e) {
    log("error:", e.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `comate-relay: ${e.message}` } }));
  }
});

server.listen(PORT, HOST, () => {
  log(`comate-relay listening on http://${HOST}:${PORT} (mode: stateless)`);
  try {
    const c = readCredentials();
    log(`credential ok: ${c.username}`);
  } catch (e) {
    log(`credential MISSING: ${e.message}`);
  }
});
