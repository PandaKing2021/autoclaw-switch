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
 * Stateless like trae/ and doubao/: every NEW question creates a fresh
 * conversation+task, the caller re-sends the full history flattened into
 * `query`. The one exception is the tool loop (below): it is bounded and
 * transparent, nothing session-shaped is ever reused across user turns.
 *
 * Tools: the agent runs its own toolset SERVER-SIDE — FUNCTION_CALL_START /
 * _PARAMS_APPEND / _END frames carry `toolUse:[{id,name,input}]` (params
 * stream in as per-key string fragments, concatenated, see
 * appendParamContent in dist/zulu-cli). We translate those into OpenAI
 * `tool_calls` / Anthropic `tool_use`, and the results the client executes
 * come back in the request's `toolUseResults` field — the upstream's own
 * channel, on the SAME conversation+task with query:"" and isFirstQuery:false
 * (that is what the IDE kernel does). Frame names are Claude vocabulary
 * (Write/Read/Bash); TOOL_ALIASES below maps them to the canonical snake_case
 * names the CLI uses when reporting results (V10_TOOL_ALIASES in the bundle).
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
// What the cloud agent is told about the caller's workspace (sysInfo). The
// tools run CLIENT-side, so this is cosmetic — but a wrong root makes the
// agent probe with absolute paths it cannot know. Point it at the ZCode
// workspace when that differs from the relay's own cwd.
const WORKSPACE = process.env.COMATE_RELAY_WORKSPACE || argOf("--workspace", process.cwd());

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

// ------------------------------------------------------------------ tool loop
// Frame tool names are the Claude-style vocabulary the cloud agent speaks;
// results are reported back under the canonical names below (mirrors
// V10_TOOL_ALIASES for agentVersion>=10 in the IDE's zulu-cli bundle).
const TOOL_ALIASES = {
  Bash: "run_command", Read: "read_file", Write: "write_file", Edit: "edit_file",
  Grep: "grep_content", Glob: "glob_path", Agent: "delegate_subagent", Skill: "skill",
  WebFetch: "web_fetch", WebSearch: "web_search", RealtimeSearch: "web_search",
  TodoWrite: "todo_write", ListDir: "list_dir", Delete: "delete_file",
  CodebaseSearch: "codebase_search", UseMcpTool: "use_mcp_tool", StopTask: "stop_task",
  AskUserQuestion: "ask_user_question", SendUserMessage: "send_user_message",
  CreatePlan: "create_plan", DocRead: "doc_read", DocList: "doc_list", DocSearch: "doc_search",
  GetGoal: "get_goal", CreateGoal: "create_goal", UpdateGoal: "update_goal",
  TaskCreate: "create_task", TaskUpdate: "update_task", TaskGet: "get_task", TaskList: "list_task",
  SetVMEnv: "setup_vm_environment",
};
function canonicalToolName(name) {
  return TOOL_ALIASES[name] || name || "";
}

// The IDE kernel answers these itself and never bothers the model caller
// (buildMergedParams filters them out of toolUseResults). Same here: they are
// answered relay-side so they never reach the client, which has no handler.
const INTERNAL_TOOL_NAMES = new Set(["compress_message", "task_complete", "memory_extract"]);

// Tool results must go back to the SAME conversation+task that produced the
// call, so the mapping call-id -> conversation/task has to survive between two
// HTTP requests. Bounded + TTL'd + only ever holds ids this relay handed out:
// a routing table, not a conversation pool. A miss (restart, expiry) degrades
// to the plain stateless path instead of failing.
const TOOL_ROUTING_TTL_MS = 30 * 60 * 1000;
const TOOL_ROUTING_MAX = 256;
const toolRouting = new Map();

function rememberToolRouting(calls, conversationId, taskId) {
  const now = Date.now();
  for (const [k, v] of toolRouting) if (now - v.at > TOOL_ROUTING_TTL_MS) toolRouting.delete(k);
  while (toolRouting.size + calls.length > TOOL_ROUTING_MAX && toolRouting.size)
    toolRouting.delete(toolRouting.keys().next().value);
  for (const c of calls) {
    const prev = toolRouting.get(c.id);
    toolRouting.set(c.id, {
      conversationId, taskId, at: now,
      name: c.name || prev?.name || "",
      params: c.params || prev?.params,
      internal: !!c.internal,
      internalResult: c.internalResult || prev?.internalResult,
    });
  }
}
function lookupToolRouting(ids) {
  for (const id of ids) {
    const e = toolRouting.get(id);
    if (e) return e;
  }
  return null;
}
function forgetToolRouting(ids) {
  for (const id of ids) toolRouting.delete(id);
}

// PARAMS_APPEND frames carry per-key FRAGMENTS: strings concatenate, anything
// else replaces/merges (appendParamContent in the CLI bundle only handles the
// string case and drops the rest; keeping the rest beats losing parameters).
function mergeToolParams(params, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const prev = params[k];
    if (typeof prev === "string" && typeof v === "string") params[k] = prev + v;
    else if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev))
      params[k] = { ...prev, ...v };
    else params[k] = v;
  }
  return params;
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
  // Tool turns from the caller's history are rendered as readable lines so a
  // replay (or a fallback after the routing cache misses) still makes sense.
  const parts = [];
  for (const m of messages) {
    const role = m?.role === "assistant" ? "Assistant" : m?.role === "system" ? "System instructions" : m?.role === "tool" ? "Tool result" : "User";
    const text = typeof m?.content === "string" ? m.content : "";
    if (text.trim()) parts.push(`[${role}]\n${text.trim()}`);
    if (m?.toolCalls?.length) {
      parts.push("[Assistant tool call]\n" + m.toolCalls.map((c) => `${c.name}(${c.arguments || "{}"})`).join("\n"));
    }
    if (m?.toolResult) {
      const body = String(m.toolResult.text || "").trim();
      parts.push(`[Tool result${m.toolResult.name ? " " + m.toolResult.name : ""}]\n${body || "(empty)"}`);
    }
  }
  return parts.join("\n\n") || "hello";
}

async function executeSync(license, conversationId, taskId, query, modelKey, opts = {}) {
  const toolUseResults = opts.toolUseResults || [];
  const isFirstQuery = opts.isFirstQuery !== false;
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
      workspacePath: WORKSPACE, workspaceRoots: [WORKSPACE],
    },
    skillInfos: [], hasMcp: false, isUserQuery: opts.isUserQuery !== false, isMockQuery: false,
    localIndex: false, contexts: [], toolUseResults, subAgents: [],
    agentVersion: "12", isFirstQuery, enableMemory: false, systemReminder: "",
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
  return reduceFrames(j?.frames);
}

// Pure frame reduction (split out so it can be regression-tested offline).
function reduceFrames(frames) {
  let text = "", reasoning = "", end = false, usage = null, rollbackMessageId = "";
  const toolMap = new Map();
  // content.detail is the frame payload (content.text is the same object
  // stringified); toolUse rides on FUNCTION_CALL_* AND on ANSWER frames.
  const detailOf = (c) => {
    if (c && typeof c.detail === "object" && c.detail) return c.detail;
    try { const d = JSON.parse(c?.text || "{}"); return d.detail || d; } catch { return {}; }
  };
  for (const raw of frames || []) {
    let f;
    try { f = JSON.parse(raw); } catch { continue; }
    const c = f?.content || {};
    const d = detailOf(c);
    if (c.type === "ANSWER") {
      text += d.delta || "";
      reasoning += d.reasoningDelta || "";
      if (d.end || c.end) end = true;
    } else if (c.type === "TOKEN_USAGE") {
      try {
        const u = (typeof c.detail === "object" && c.detail) || JSON.parse(c.text || "{}");
        const src = u?.usage || u?.data || u;
        const num = (...keys) => { for (const k of keys) { const v = src?.[k]; if (Number.isFinite(v)) return v; } return undefined; };
        usage = {
          input_tokens: num("input_tokens", "prompt_tokens", "inputTokens", "promptTokens") ?? 0,
          output_tokens: num("output_tokens", "completion_tokens", "outputTokens", "completionTokens") ?? 0,
          raw: u,
        };
      } catch {}
    }
    if (d.rollbackMessageId) rollbackMessageId = d.rollbackMessageId;
    for (const tu of d.toolUse || []) {
      if (!tu || !tu.id) continue;
      let cur = toolMap.get(tu.id);
      if (!cur) { cur = { id: tu.id, name: tu.name || "", params: {} }; toolMap.set(tu.id, cur); }
      if (tu.name && !cur.name) cur.name = tu.name;
      mergeToolParams(cur.params, tu.input);
    }
  }
  return { text, reasoning, end, usage, rollbackMessageId, toolCalls: [...toolMap.values()].filter((t) => t.name) };
}

// One upstream turn, plus the relay-side answer loop for control tools the
// client cannot execute (bounded: at most 2 extra hops per client request).
async function runTurn({ license, conversationId, taskId, query, toolUseResults, isFirstQuery, isUserQuery, modelKey }) {
  let out = await executeSync(license, conversationId, taskId, query, modelKey, { toolUseResults, isFirstQuery, isUserQuery });
  for (let hop = 0; hop < 2; hop++) {
    const internal = out.toolCalls.filter((t) => INTERNAL_TOOL_NAMES.has(canonicalToolName(t.name)));
    if (!internal.length || internal.length !== out.toolCalls.length) break;
    log(`internal call answered relay-side: ${internal.map((t) => t.name).join(",")}`);
    out = await executeSync(license, conversationId, taskId, "", modelKey, {
      toolUseResults: internal.map((t) => ({
        id: t.id, name: canonicalToolName(t.name), success: true, params: t.params, message: "ok",
      })),
      isFirstQuery: false, isUserQuery: false,
    });
  }
  const internalCalls = out.toolCalls.filter((t) => INTERNAL_TOOL_NAMES.has(canonicalToolName(t.name)));
  const clientCalls = out.toolCalls.filter((t) => !INTERNAL_TOOL_NAMES.has(canonicalToolName(t.name)));
  // Calls the client must answer: remember where to deliver their results.
  // Internal ones (mixed into the same batch) get a pre-built result so the
  // next continuation can hand them over together with the client's.
  rememberToolRouting(
    clientCalls.map((t) => ({ id: t.id, name: canonicalToolName(t.name), params: t.params })),
    conversationId, taskId,
  );
  if (internalCalls.length) {
    rememberToolRouting(internalCalls.map((t) => ({
      id: t.id, internal: true,
      internalResult: { id: t.id, name: canonicalToolName(t.name), success: true, params: t.params, message: "ok" },
    })), conversationId, taskId);
  }
  return { ...out, toolCalls: clientCalls };
}

async function comateChat({ messages, modelKey, pending }) {
  const cred = readCredentials();
  const license = cred.license;
  const model = modelKey || "auto";

  if (pending?.results?.length) {
    // The client is answering tool calls: continue the SAME conversation+task
    // (upstream keeps the agent state; query stays empty, like the IDE).
    const route = lookupToolRouting(pending.results.map((r) => r.id));
    if (route) {
      const ids = pending.results.map((r) => r.id);
      const results = pending.results.map((r) => {
        const e = toolRouting.get(r.id);
        return {
          id: r.id,
          name: canonicalToolName(r.name) || e?.name || "",
          success: r.isError ? false : true,
          params: r.params || e?.params || {},
          message: String(r.text ?? ""),
        };
      });
      const internal = ids.map((id) => toolRouting.get(id)).filter((e) => e?.internalResult).map((e) => e.internalResult);
      forgetToolRouting(ids);
      const all = [...results, ...internal];
      log(`tool-loop continue conv=${route.conversationId} task=${route.taskId} results=${all.length} (${all.map((r) => r.name).join(",")})`);
      return await runTurn({
        license, conversationId: route.conversationId, taskId: route.taskId,
        query: "", toolUseResults: all, isFirstQuery: false, isUserQuery: false, modelKey: model,
      });
    }
    log(`tool-loop miss for [${pending.results.map((r) => r.id).join(",")}] — cache expired or relay restarted, flattening instead`);
  }

  const trace = randomUUID();
  const conversationId = await createConversation(license, trace);
  const taskId = await createTask(license, conversationId, trace);
  const query = flattenQuery(messages);
  const out = await runTurn({
    license, conversationId, taskId, query, toolUseResults: [], isFirstQuery: true, isUserQuery: true, modelKey: model,
  });
  log(`chat model=${model} conv=${conversationId} task=${taskId} chars=${out.text.length} tools=${out.toolCalls.length}${out.toolCalls.length ? " [" + out.toolCalls.map((t) => t.name).join(",") + "]" : ""}`);
  return out;
}


// -------------------------------------------------------------------- flatten helpers for OpenAI/Anthropic
// Normalized message shape: {role, content, toolCalls?:[{id,name,arguments,params}],
// toolResult?:{id,name,text,isError}}. Only text + tool bookkeeping survives —
// images etc. have nowhere to go in the upstream's text `query`.
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text || "").join("\n");
  return "";
}

function normalizeOpenAIMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    const text = textOfContent(m.content);
    if (m.role === "tool") {
      out.push({ role: "tool", content: "", toolResult: {
        id: m.tool_call_id || "", name: m.name || "", text,
      } });
      continue;
    }
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls.map((c) => ({
          id: c?.id || "",
          name: c?.function?.name || c?.name || "",
          arguments: typeof c?.function?.arguments === "string" ? c.function.arguments
            : JSON.stringify(c?.function?.arguments ?? {}),
        })).filter((c) => c.id || c.name)
      : [];
    if (!text.trim() && !toolCalls.length) continue;
    out.push({ role: m.role, content: text, ...(toolCalls.length ? { toolCalls } : {}) });
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
    const role = m?.role === "assistant" ? "assistant" : "user";
    if (typeof m?.content === "string") {
      if (m.content.trim()) out.push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m?.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
    const toolCalls = blocks.filter((b) => b?.type === "tool_use")
      .map((b) => ({ id: b.id || "", name: b.name || "", arguments: JSON.stringify(b.input ?? {}), params: b.input }))
      .filter((c) => c.id || c.name);
    if (text.trim() || toolCalls.length) out.push({ role, content: text, ...(toolCalls.length ? { toolCalls } : {}) });
    for (const b of blocks.filter((b) => b?.type === "tool_result")) {
      const c = Array.isArray(b.content) ? b.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n")
        : typeof b.content === "string" ? b.content : "";
      out.push({ role: "tool", content: "", toolResult: { id: b.tool_use_id || "", name: "", text: c, isError: !!b.is_error } });
    }
  }
  return out;
}

// A request is a tool continuation iff it ENDS with tool results (the batch
// the client just executed for the assistant turn right before them).
function extractPending(msgs) {
  const results = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.toolResult) { results.unshift(msgs[i].toolResult); continue; }
    break;
  }
  if (!results.length) return null;
  const calls = msgs[msgs.length - results.length - 1]?.toolCalls || [];
  return { results, calls };
}


// ---------------------------------------------------------------------- SSE
function sseChunk(res, model, text, reasoning, opts) {
  const d = { id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] };
  if (reasoning) d.choices[0].delta.reasoning_content = reasoning;
  if (text) d.choices[0].delta.content = text;
  if (opts?.toolCalls) d.choices[0].delta.tool_calls = opts.toolCalls;
  if (opts?.usage) d.usage = opts.usage;
  if (opts?.finish) { d.choices[0].delta = {}; d.choices[0].finish_reason = opts.finishReason || "stop"; }
  res.write(`data: ${JSON.stringify(d)}\n\n`);
}

// Caller's declared tools -> Map(name -> Set(property names) | null). The
// property set lets us drop upstream-only extras (e.g. Bash's prefix_rule /
// description) that a strict client schema would reject.
function clientToolIndex(tools, shape) {
  const idx = new Map();
  for (const t of tools || []) {
    const name = shape === "anthropic" ? t?.name : t?.function?.name || t?.name;
    const schema = shape === "anthropic" ? t?.input_schema : t?.function?.parameters || t?.parameters;
    const props = Object.keys(schema?.properties || {});
    if (name) idx.set(name, props.length ? new Set(props) : null);
  }
  return idx;
}

// Upstream frame names (Claude vocabulary) vs. the names the caller declared.
// Prefer the caller's own spelling so its tool router recognises the call;
// fall back to the upstream name when the canonical forms don't match either.
function toolNameForClient(rawName, clientTools) {
  if (!clientTools || !clientTools.size) return rawName;
  if (clientTools.has(rawName)) return rawName;
  const canon = canonicalToolName(rawName);
  for (const n of clientTools.keys()) if (canonicalToolName(n) === canon) return n;
  return rawName;
}

function clientToolCall(c, clientTools) {
  const name = toolNameForClient(c.name, clientTools);
  const props = clientTools?.get?.(name);
  if (!props) return { id: c.id, name, params: c.params || {} };
  const kept = {};
  for (const [k, v] of Object.entries(c.params || {})) if (props.has(k)) kept[k] = v;
  return { id: c.id, name, params: Object.keys(kept).length ? kept : c.params || {} };
}

function clientToolCalls(out, clientTools) {
  return out.toolCalls.map((c) => clientToolCall(c, clientTools));
}

function openaiToolCalls(out, clientTools) {
  return clientToolCalls(out, clientTools).map((c, i) => ({
    index: i, id: c.id, type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.params) },
  }));
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
        tool_loop: "conversation-continuation (bounded routing cache)",
        tool_routing_cached: toolRouting.size,
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
      const clientTools = clientToolIndex(payload.tools, "anthropic");
      const pending = extractPending(msgs);
      const wantStream = !!payload.stream;
      const out = await comateChat({ messages: msgs, modelKey: model, pending });
      const outTokens = out.usage?.output_tokens || Math.ceil(out.text.length / 4);
      const stopReason = out.toolCalls.length ? "tool_use" : "end_turn";
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model, content: [] } })}\n\n`);
        if (out.reasoning) res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: out.reasoning } })}\n\n`);
        for (const piece of splitChunks(out.text)) {
          res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } })}\n\n`);
        }
        out.toolCalls.forEach((c0, i) => {
          const c = clientToolCall(c0, clientTools);
          res.write(`data: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.params) } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outTokens } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const content = [];
        if (out.text) content.push({ type: "text", text: out.text });
        for (const c of clientToolCalls(out, clientTools)) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.params });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_" + randomUUID(), type: "message", role: "assistant", model,
          content: content.length ? content : [{ type: "text", text: "" }],
          stop_reason: stopReason,
          usage: { input_tokens: out.usage?.input_tokens || 0, output_tokens: outTokens },
        }));
      }
      return;
    }

    if (p === "/v1/chat/completions" || p === "/chat/completions") {
      const model = payload.model || "auto";
      const msgs = normalizeOpenAIMessages(payload.messages);
      const clientTools = clientToolIndex(payload.tools, "openai");
      const pending = extractPending(msgs);
      const wantStream = !!payload.stream;
      const out = await comateChat({ messages: msgs, modelKey: model, pending });
      const usage = {
        prompt_tokens: out.usage?.input_tokens || 0,
        completion_tokens: out.usage?.output_tokens || Math.ceil(out.text.length / 4),
        total_tokens: (out.usage?.input_tokens || 0) + (out.usage?.output_tokens || Math.ceil(out.text.length / 4)),
      };
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const piece of splitChunks(out.text)) sseChunk(res, model, piece, "");
        if (out.toolCalls.length) sseChunk(res, model, "", "", { toolCalls: openaiToolCalls(out, clientTools) });
        sseChunk(res, model, "", "", { finish: true, finishReason: out.toolCalls.length ? "tool_calls" : "stop", usage });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const message = { role: "assistant", content: out.text || (out.toolCalls.length ? null : "") };
        if (out.toolCalls.length) message.tool_calls = openaiToolCalls(out, clientTools).map(({ index, ...c }) => c);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-" + randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message, finish_reason: out.toolCalls.length ? "tool_calls" : "stop" }],
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

const LISTEN = !process.env.COMATE_RELAY_NO_LISTEN;
if (LISTEN) server.listen(PORT, HOST, () => {
  log(`comate-relay listening on http://${HOST}:${PORT} (mode: stateless, tool loop: relay-side continuation)`);
  try {
    const c = readCredentials();
    log(`credential ok: ${c.username}`);
  } catch (e) {
    log(`credential MISSING: ${e.message}`);
  }
});

export {
  server, TOOL_ALIASES, INTERNAL_TOOL_NAMES, canonicalToolName, mergeToolParams,
  toolRouting, rememberToolRouting, lookupToolRouting, forgetToolRouting,
  reduceFrames, extractPending, flattenQuery, normalizeOpenAIMessages, normalizeAnthropicMessages,
  clientToolIndex, toolNameForClient, clientToolCalls, openaiToolCalls,
};
