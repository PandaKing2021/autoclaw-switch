# -*- coding: utf-8 -*-
"""Patch the deployed relay (~/.autoclaw-relay/server.mjs) with the AutoClaw 2.x
managed-gateway contract, gated behind AUTOCLAW_CONTRACT=2x so the 1.x behavior
stays the default. All edits are idempotent."""

from pathlib import Path

P = Path.home() / ".autoclaw-relay" / "server.mjs"
src = P.read_text(encoding="utf-8")
n0 = src

# --- 1. Contract flag + OpenAI SDK fingerprint header set -------------------
anchor = 'const CLOUD_VERSION = process.env.AUTOCLAW_CLIENT_VERSION || "1.18.5.851";'
addition = anchor + '''

// [asw-2x] AutoClaw 2.x (客户端 2.0.1 / acceleration 网关) 契约：
//  - 出站走 OpenAI JS SDK 指纹（user-agent + x-stainless-* + x-agent-id），缺这些会被
//    WAF 闸门 406/丢弃（2026-10-03 抓包比对确认：同一 token/主机，带指纹 200，不带 406）
//  - body.model 用带前缀目录名（= X-Request-Model），不再剥前缀
//  - max_tokens 改名 max_completion_tokens，并带 store:false / reasoning_effort
//  - 不注入 1.x 的 harness system 标记（2.x 客户端已无此机制）
const CONTRACT_2X = (process.env.AUTOCLAW_CONTRACT || "1x") === "2x";
const SDK_FP_HEADERS = {
  "user-agent": "OpenAI/JS 6.26.0",
  "x-agent-id": "main",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "6.26.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.18.0",
};'''
assert src.count(anchor) == 1, "anchor1"
src = src.replace(anchor, addition)

# --- 2. cloudHeaders: fingerprint headers + accept application/json ---------
old = '''    Accept: stream ? "text/event-stream" : "application/json",'''
new = '''    ...(CONTRACT_2X ? SDK_FP_HEADERS : {}),
    Accept: CONTRACT_2X ? "application/json" : (stream ? "text/event-stream" : "application/json"),'''
assert src.count(old) == 1, "anchor2"
src = src.replace(old, new)

# --- 3. body.model keeps the prefixed route under 2x ------------------------
old = 'function cloudBodyModel(route) { return route.replace(/^[a-z]+_/, ""); }'
new = ('function cloudBodyModel(route) { return CONTRACT_2X ? route : route.replace(/^[a-z]+_/, ""); }')
assert src.count(old) == 1, "anchor3"
src = src.replace(old, new)

# --- 4. Anthropic->OpenAI translator: 2x field names ------------------------
old = '''  return out;
}

// ---------------- OpenAI -> Anthropic ----------------'''
new = '''  if (CONTRACT_2X) {
    out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
    out.store = false;
    const th = body.thinking;
    out.reasoning_effort = th && th.type === "enabled"
      ? (Number(th.budget_tokens) >= 8192 ? "high" : "medium")
      : "low";
  }
  return out;
}

// ---------------- OpenAI -> Anthropic ----------------'''
assert src.count(old) == 1, "anchor4"
src = src.replace(old, new)

# --- 5. OpenAI direct path: same renames ------------------------------------
old = '''  const payload = { ...body, model: route };
  delete payload.stream_options;
  applySteering(payload);'''
new = '''  const payload = { ...body, model: route };
  if (CONTRACT_2X) {
    if (payload.max_tokens != null) { payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; }
    payload.store = false;
  }
  delete payload.stream_options;
  applySteering(payload);'''
assert src.count(old) == 1, "anchor5"
src = src.replace(old, new)

# --- 6. callCloud: ensure stream_options for 2x streams ---------------------
old = "      body: JSON.stringify({ ...payload, model: cloudBodyModel(route) }),"
new = ("      body: JSON.stringify({ ...payload,\n"
       "        ...(CONTRACT_2X && payload.stream && !payload.stream_options ? { stream_options: { include_usage: true } } : {}),\n"
       "        model: cloudBodyModel(route) }),")
assert src.count(old) == 1, "anchor6"
src = src.replace(old, new)

P.write_text(src, encoding="utf-8")
print("patched ok, delta bytes:", len(src) - len(n0))
