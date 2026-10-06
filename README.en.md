# A-SWITCH · All-in-One relay platform

[English](README.en.md) | [中文](README.md) | [A-SWITCH 1.x standalone tool (releases)](../../releases/latest)

**One job: turn the built-in credits of seven Chinese AI clients/platforms into models you can select directly in your IDE.**

The prebuilt Windows console exe is on the [Releases](../../releases/latest) page; you can also run the console from source (Node only). The seven gateways themselves are plain files in this repo — Node scripts for five of them, pure-stdlib Python for the sixth, and one `wb2api.exe` that ships as a release asset.

| Platform | Credits | Gateway exposes | Upstream protocol † | Port | Models * | Tools |
|---|---|---|---|---|---|---|
| **AutoClaw** (Zhipu Z.ai) | account points, multi-account pool | anthropic + openai + responses | **native chat completions** (persona gate) | 18766 | 6 | ✅ structured |
| **WorkBuddy** (Tencent CodeBuddy) | ~100 credits/month + 30/day (free tier) | openai | **native chat completions** (body passed through verbatim) | 7863 | 46 | ✅ structured |
| **Trae SOLO CN** (ByteDance) | free session quota | openai + anthropic | remote agent session protocol (history flattened to text) | 18768 | 27 | ❌ text only |
| **豆包工作 / Doubao Work** (ByteDance) | client-bundled quota | openai + anthropic | web IM protocol (history flattened to text) | 18770 | 2 (synthetic) | ❌ text only |
| **Comate 文心快码** (Baidu) | Comate IDE quota | openai + anthropic | three-step cloud-agent chain (history flattened to text) | 18774 | 15 | ❌ text only |
| **Qoder CN** (Alibaba) | client-bundled quota (Qwen3.8 line works on Free) | openai + responses | COSY envelope agent SSE (history flattened, **real tools list**) | 8791 | 14 | ✅ forwarded |
| **千问办公 / QwenWork CN** (Alibaba) | same Qoder platform, separate gateway | openai + responses | same as Qoder (qwork scene + workbench declaration) | 8791 | 3 | ✅ forwarded |

\* Model catalogs are pulled live per account; counts are what this machine measured in Oct 2026. Doubao's catalog lives server-side and is not enumerable — the gateway exposes two synthetic entries.
† This is how the **upstream** actually talks, which is not the same thing as what the gateway exposes. All seven gateways accept `POST /v1/chat/completions`; only the first two talk chat completions to their upstream. Per-platform evidence in [Protocol fidelity](#protocol-fidelity-which-links-are-really-chat-completions).

Everything runs on `127.0.0.1`, credentials never leave your machine. In ZCode the seven platforms are sibling providers (`autoclaw-glm-provider`, `workbuddy-openai-provider`, `trae-openai-provider`, `doubao-openai-provider`, `comate-openai-provider`, `qoder-openai-provider`, `qwenwork-openai-provider`) with no model-name collisions, so you can switch between them freely inside one session.

Qoder CN and QwenWork CN share **one** gateway process on `8791` (same account pool, same COSY signing). On the ZCode side they are two providers, selected by API key: ZCode's provider config has no custom-request-header field, so binding a key to a realm is the only supported way to choose an exit. The console generates both keys, writes them into the gateway, and turns that gateway's key check off (it listens on loopback only and was unauthenticated before anyway).

## What it is / isn't

All seven upstreams are **consumer agent clients**, not public model APIs. Each spends its own credits inside its own official client; the relays here let a standard IDE (ZCode, or anything speaking OpenAI/Anthropic) spend those credits too.

- **It is** a local protocol translation layer: IDE → standard request → gateway translates to the upstream's real protocol → streams back.
- **It is not** an official API. Every link is reverse-engineered from the client (credential storage format, gateway hostnames, request signing, WAF gates, session protocols). When an upstream changes, the adapter must be re-reverse-engineered.
- **The cost**: unofficial usage carries a ban risk (AutoClaw in particular looks at the *shape* of your inference traffic), and billing follows each platform's own rules.

## Protocol fidelity: which links are really chat completions

Judging by the **gateway entry point**, you would conclude all seven are chat completions — they all serve `POST /v1/chat/completions`. Look at what each gateway sends **upstream** and the picture splits into three tiers.

**Tier A · upstream is natively chat completions (structured `messages`/`tools`, tool loops work)**

| Platform | Upstream endpoint | Payload |
|---|---|---|
| WorkBuddy | `POST copilot.tencent.com/v2/chat/completions` | The client body is **passed through verbatim**; only the model name is rewritten (the prefix is the gateway's own routing convention, the upstream takes bare names). `messages`, `tools`, `tool_calls` and reasoning fields all survive — the main reason it feels best as an agent pool |
| AutoClaw | `POST autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions` | OpenAI-shaped body (`messages` + `max_completion_tokens` + `stream_options.include_usage` + `store:false` + `reasoning_effort:high`). The Anthropic entry converts first (`anthropicToOpenai()`, tools via `anthropicToolsToOpenai()`); the Responses entry likewise (`responsesToolsToChat()`). **Protocol-wise it is WorkBuddy's equal — when it is unusable today that is a credits problem (402), not a protocol one** |

**Tier B · custom protocol that still carries real tools (tool calls translate, history is flattened)**

- **Qoder CN / QwenWork CN**: the outbound body is a deep copy of the official `baseprompt.json`. It *does* contain a `messages` array — but it is `[{role:"system"}, ...flattened history]`: `flatten_messages()` serializes assistant `tool_calls` into text markers. The one genuinely structured part is the tool declaration: a client-supplied `tools` list is placed into the envelope as-is, and the upstream parses it and answers `finish_reason:tool_calls`. So it is a **hybrid: real tools, fake message history**.
- **Comate / Trae**: there is nowhere to put tools at all. Comate's `execute-sync` has a single text `query` field (its header comment says *caller tools are NOT forwarded*); Trae's `initial_message.query` is `JSON.stringify(prompt(text))`. It is not that we drop tools — the protocol has no field for them.

**Tier C · web/product chat endpoints (simulation only)**

- **豆包工作 / Doubao Work**: `POST www.doubao.com/chat/completion` SSE with editor-block payloads (`messages[0].content_block[0].content.text_block.text`) — the furthest thing from chat completions here.

**What this means in practice.** Ranked by "can it drive an agent tool loop": **WorkBuddy ≈ AutoClaw (structurally faithful, tool loop closed) > Qoder CN ≈ QwenWork CN (tools get through, but history is flattened and re-sent as full text every turn — repeated round-trips of the same tool are noticeably less faithful) > Comate ≈ Trae (their own agent does the work; your tools are invisible) > Doubao (chat credits only)**. Symptom-wise, flattened links tend to be accurate on turn one and start drifting later; this is the root cause.

## Quick start

```
git clone <this repo> && cd <repo>/app    # the repo root *is* the runtime resource root; don't copy app/ alone
npm install                               # single dependency: electron (npmmirror mirror is fine)
npm start
```

Then, in the console, three steps:

1. **Environment check** (top bar) — read-only probing; anything missing is listed with its impact and how to fix it.
2. **Start all** — brings up every gateway and the credential watcher in dependency order (Qoder CN and QwenWork CN share one process).
3. **Register** — writes all seven providers into ZCode's model catalog.

**Restart ZCode** afterwards and the models appear.

Cold-start is handled: the relay's runtime files (`~/.autoclaw-relay/server.mjs`, `persona.txt`) are deployed from `bridge/` automatically on every "start", no manual copying.

### Prerequisites

| Dependency | Needed for | If missing |
|---|---|---|
| Node.js 18+ | AutoClaw relay, Trae / Doubao / Comate gateways | "relay needs Node.js in PATH"; the packaged exe has a fallback runtime (PATH → AutoClaw's bundled node → the console itself) |
| Python 3.10+ with `pip install cryptography` | one-click register / balance query / credential sync (loads `a_switch.py`, found either at the repo root or under `autoclaw-switch/`) | button reports "no executable: python"; without `cryptography` the watcher spawns and dies instantly — the symptom is "the button does nothing" |
| Python 3.9+ (pure stdlib) | Qoder CN / QwenWork CN gateway (`qoder/qoder_proxy.py`) | Qoder card reports a missing gateway file or crashes on start (same `python` as above) |
| AutoClaw desktop app, logged in | credential source for the relay (2.x reads `%APPDATA%\AutoClaw-official\`) | relay starts but has no usable upstream |
| ZCode installed and run at least once | registration target `~/.zcode/v2/provider_config.json` | prompt to install ZCode first |
| Trae SOLO CN, logged in | Trae gateway credentials (decrypted offline) | Trae card shows "not started" |
| 豆包工作 client, logged in | Doubao credentials (CDP cookie capture; first time use "restart client and sync") | card shows missing cookie, requests return 401 |
| Comate (文心快码) IDE, logged in | reads `baidu.comate.license` from `%APPDATA%\Comate\User\settings.json` (re-login needs no relay restart) | Comate card shows "not started" / 401 |
| Qoder CN app, logged in | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`; import with the console's "Sync accounts" | that exit reports `no usable account for realm` |
| QwenWork CN app, logged in | `%APPDATA%\QwenWorkCN\auth-v2.dat`; same sync imports it | that exit finds no catalog, requests fail with `503 Model catalog unavailable` |
| `wb2api.exe` | the WorkBuddy gateway binary | card reports a missing file; it ships as a **Release** asset, not in git — unpack to `workbuddy/workbuddy-manager-v1.0.79/upstream/` |

## Desktop console (`app/`)

An Electron panel: **seven platform cards + a ZCode registration card + a log viewer + top bar**.

- **AutoClaw card** — status / upstream route / uptime / model aliases; start, stop, connectivity test (a real inference).
- **Account card** (same row) — points balance and expiring amount (queried on demand), token expiry, credential-watcher state and start/stop.
- **WorkBuddy card** — gateway status / credits / account / model catalog; start, stop, connectivity test.
- **Trae card** — status / account / credential expiry / mode (stateless) / catalog; start, stop, connectivity test.
- **Doubao Work card** — status / cookie health / pinned conversation (transport only) / mode / catalog; start, stop, connectivity test, **sync login state**, **restart client and sync**.
- **Comate card** — status / license state / mode / catalog; start, stop, connectivity test.
- **Qoder CN card** — status / account pool / exit (`cn`) / listener / catalog (only models the account can use); start, stop, connectivity test, **sync accounts**.
- **QwenWork CN card** — the *other exit of the same gateway process* (card shows `出口 qworkcn (qwenwork.cn)` and the shared port); catalog shows the three `qwork`-scene models; same four buttons.
- **ZCode registration card** — registration state / per-provider endpoint and model count / full model list / one-click register / **config check** (read-only validation of `provider_config.json`).
- **Log viewer** — eight tabs: `relay` / watcher / WorkBuddy / Trae / Doubao Work / Comate / Qoder / console.
- **Top bar** — **Start all** (dependency-ordered; a missing prerequisite only affects its own link, and failures surface the environment-check output) and **Environment check**.

The environment check probes: Node runtime, Python, `cryptography`, every gateway's source and runtime files, the `a_switch.py` backend (what register/balance/sync load), every platform's login state (AutoClaw credentials, Trae `storage.json`, Doubao cookies, Comate `settings.json`, Qoder `auth.v1.dat`, QwenWork `auth-v2.dat`) and the ZCode config — each with "what it costs you" and "how to fix it".

Closing the window does not stop the background services (relays, gateways and the watcher are detached processes).

```
cd app && npm start                     # equal to: npx electron .
ASWITCH_SELFTEST=1 npx electron .       # 26-case functional self-test (7 connectivity + 7 registrations + env check + gate assertions + logs + relay stop/start)
ASWITCH_SELFTEST=1 ASWITCH_SELFTEST_ONLY="zcode:register" npx electron .   # run a single handler
node app/test_zcode_config.js           # sandbox regression test for the config-write gate (synthetic fixtures, 14 cases)
```

The self-test covers `env:check`, `status:query`, `points:refresh`, `credential:sync`, watcher stop/start, all seven `*:smoke` handlers (real inference, not liveness pings), `all:start`, `zcode:register` (with per-provider assertions), `zcode:realm-keys`, `zcode:register:未被闸门拦下`, `zcode:check`, `logs:tail` and `relay:stop/start`. Results are written to `~/.autoclaw-relay/selftest-result.txt` (per-case pass/fail); `selftest-progress.txt` next to it is the running log. **Running the full self-test from the exe produces no stdout** — Electron is a GUI-subsystem process there, so read that JSON file instead. Two caveats: the full run restarts the relay (that is what the two relay cases assert), and editing `app/main.js` or `preload.js` requires restarting the Electron process — a running window never hot-reloads.

## Per-link notes

**All seven links are stateless gateways**, semantically aligned with AutoClaw's relay: no session state is kept anywhere, the caller sends the full history every request, and the answer depends only on that request. The AutoClaw link was always like this; Trae creates a fresh remote session per request and throws it away; Doubao has no "create session" API, so it uses one pinned conversation as **transport scratch paper** and never reuses server-side context; Comate replays the IDE kernel's three-step chain per request; Qoder CN and QwenWork CN flatten `messages` into a plain transcript inside the envelope's `messages` array (tools, in contrast, are sent as a real list). The benefit is predictability (same `messages`, same answer, no cross-request pollution); the cost is two-layered — protocol-level fidelity (above) plus each link's fixed per-turn overhead (Trae re-pays its agent system prompt every turn, Doubao re-sends the whole history).

**AutoClaw** — 2.0.1 moved credentials to `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc` (DPAPI-protected AES-256-GCM key in Local State), moved inference to an acceleration host, added `X-Auth-Sign`/`X-Channel`/`X-Session-Id` headers, and gates requests behind a WAF that demands a "real OpenAI SDK" shape. The 406 gate has five factors (clean HTTP/1.1 fingerprint via `node:https`, full OpenAI SDK fingerprint headers, `X-Session-Id`, a system message byte-identical to the app persona, and the exact body parameters) — missing any one returns an empty 406. The gateway substitutes the persona and moves your own system instructions into the first user message, so the model still sees them.

**WorkBuddy** — a local Go gateway (`wb2api`, api_key `wb-local-key`, config in the same directory), CLI OAuth login (`wb2api-login.exe url|poll --realm=cn`), 38-day tokens, account pool / circuit breaker / check-in keep-alive built in. Model names must be lowercase or `cn:`-prefixed. Credits shown and free quota are two separate ledgers (0 credits still completes).

**Trae SOLO CN** — the client does not call models directly; it drives a remote agent sandbox. Credentials are decrypted **offline** from `storage.json`'s `iCubeAuthInfo://icube.cloudide` blob (`byteCrypto`, pure JS, hard-coded tables) — no client patching, no IDE restart. The real user token is the only thing that passes auth (temp JWTs get 401). Each request creates a remote session, flattens history into a role-tagged transcript, answers, and discards — about 17.6k–20.8k prompt tokens of fixed overhead per turn. The catalog needs `functions=...&show_custom_model=true` or you only get the default 12 models; the gateway unions both calls (27 models here).

**豆包工作 / Doubao Work** — no signing parameters and no local gateway: cookie authentication only (`a_bogus` can be omitted, `msToken` comes from the cookie), so the relay runs standalone without the client open. Cookies come from CDP (`Network.getAllCookies`) rather than DPAPI. The request must carry the client's fingerprint query parameters and UA. Ten SSE event types were enumerated; the body text is assembled from the `CHUNK_DELTA` increments. The catalog is not enumerable, so two synthetic models are exposed (`doubao`, `doubao-think`). Tool calls are not supported (`tools` is ignored, not rejected). Note the relay's traffic really does show up in your local Doubao conversation list — point it at a dedicated conversation via `POST /admin/conversation` if that bothers you.

**Comate 文心快码** — the license is plaintext in the IDE's `settings.json` (a UUID under `baidu.comate.license`); the 32-hex `comate_login_ID` in globalStorage is *not* valid, and the DPAPI/AES-GCM path is a dead end documented in `comate/decrypt_auth.py`. The relay replays the kernel→cloud three-step chain (conversation → task → execute-sync), which requires real conversation/task ids (the official CLI's `-1/-1` placeholders are rejected by OpenRASP). Response frames are stitched locally into OpenAI/Anthropic SSE. 15 models, `auto` plus real model keys.

**Qoder CN / QwenWork CN** — COSY signing (RSA-wrapped AES session key + MD5 signature + custom Base64 body encoding), vendored from the community [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) (MIT) with local patches for the `qworkcn` realm. Desktop credentials are imported into a pool; the panel login (default password `admin`, loopback only) plus `/accounts/import/desktop` does it in two steps. Free accounts get `Qwen3.8-Max/Flash` at 0 credits; other models return 403 code 112, and the catalog marks them `enabled:false` so registration filters them out. QwenWork CN's two traps both surface as a **503 embedded in a 200 SSE stream**: its catalog is scene-partitioned (`chat` is empty for qworkcn; the models live under `qwork`), and the outbound body must declare the workbench shape (`session_type` / `business.product = qoder_work`). Its model names are a **closed catalog** — CN aliases of the same name point at different keys and return 403 `Model is not available for this user`, so that realm resolves only within its own catalog and alias table.

## ZCode provider registration: the write gate (important)

`~/.zcode/v2/provider_config.json` belongs to **ZCode**; the console is only allowed to touch the seven providers it registered. Two historical incidents shared one root cause: writing an invalid `api.type` (treating the internal kind `openai-compatible` as legal, which broke provider loading entirely), and "normalizing to the set I know" deleting other people's entries (dropping the required `manualProviderModelRules`, and shrinking AutoClaw's catalog to 4 models). The rules now live in `app/zcode-config.js`:

- **`api.type` accepts exactly three values**: `anthropic-messages` / `openai-responses` / `openai-chat-completions`.
- **Structural key-set assertion before and after writing**: losing any pre-existing key or entry rejects the whole write. The allow-list only covers the seven catalogs.
  - The allow-list has a trap: array elements are identified as `providerId/modelId` in structural paths, and a **malformed entry missing `modelId` yields only `providerId`** — so each provider must allow both the `…providerModelRules[<pid>]` and `…providerModelRules[<pid>/` prefixes. Otherwise the very write that repairs bad data gets rejected by your own gate, and the bad entry can never be fixed.
- **`ok` in the registration result only means "the catalog was fetched"**; whether the write survived the gate is a separate `registerError` field. There was a "all green but the config never changed" incident; a dedicated self-test case now asserts `registerError` is empty.
- **Catalogs are union-only**: `personalModelIds` grows, never shrinks; capabilities like `supportsImage` are preserved, only `contextWindow` is refreshed.
- **Atomic write + read-back + rollback**: temp file then rename, re-parse, and roll back to `*.bak-<timestamp>` on failure.
- **AutoClaw's catalog truth is `a_switch.py`'s `ZCODE_MODELS`** (6 models with per-route vision flags measured live), not a hard-coded list in the console.
- **Exit selection is by key, not by header**: the console asks the gateway panel to mint two realm-bound keys (`~/.autoclaw-relay/qoder-realm-keys.json`, mode 0600, plaintext local-only) and pushes `auth_disabled: true` — otherwise the existence of any key would make `/v1` require one and break pre-existing registrations. When writing the panel config, empty `key` values preserve other people's entries.

The sandbox regression test `node app/test_zcode_config.js` (**14 cases**, synthetic fixtures in a temp directory, never touching your real config) reproduces both historical incidents (A1/A2/A3), covers the malformed-entry rewrite (A4), and includes a source-hygiene check (G1): `app/main.js` must not declare two top-level functions with the same name — JavaScript silently overrides the later one (no error, `node --check` passes), which once turned `comateModels()` into a version returning plain strings and wrote `modelId: null` for all 15 Comate models while still reporting success.

## Verifying

```
# AutoClaw relay (:18766, anthropic)
curl http://127.0.0.1:18766/health
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'

# WorkBuddy gateway (:7863, openai; api_key wb-local-key)
curl http://127.0.0.1:7863/v1/models -H "Authorization: Bearer wb-local-key"

# Trae (:18768) / Doubao (:18770) / Comate (:18774), all openai + anthropic
curl http://127.0.0.1:18768/health
curl -X POST http://127.0.0.1:18770/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer doubao-local-key' \
  --data-binary @req.json            # {"model":"doubao","messages":[...]} — use a file for non-ASCII bodies

# Qoder CN / QwenWork CN gateway (:8791, openai; one process, two exits)
python qoder/qoder_proxy.py --port 8791 --accounts-dir ~/.qoder-relay/accounts &
curl http://127.0.0.1:8791/health
curl http://127.0.0.1:8791/v1/models -H "X-Realm: qworkcn"    # the three QwenWork models
```

Regression tests: `node trae/test_relay.mjs`, `node trae/test_robust.mjs`, `node doubao/test-relay.mjs`, `node doubao/test-zcode-shape.mjs`, `python qoder/_test_qoder.py`, `python qoder/_test_leak_guard.py` (asserts tokens never leak), and the console's per-card connectivity buttons for Comate/Qoder/QwenWork end-to-end. In Git Bash, `curl -d '中文'` sends GBK bytes (the console code page) — use a Node script or `--data-binary @utf8file` for non-ASCII.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| 401 Invalid token (AutoClaw) | The app rotated its access token. The credential watcher follows it automatically; if it is not running, log into AutoClaw once or re-run `bridge/make_compat_auth.py` |
| 402 insufficient credits | Terminal error — wait for the daily grant (1000/day on login) or top up; the relay does not retry |
| 406 empty response | One of the five 2.x gate factors is missing — most often `persona.txt` was never deployed (the console's "start" button fixes that) |
| 810001 "system busy" | GLM-5.3-Flash is rate-limited at peak hours; 23:00–09:00 is clear. The relay backs off and retries; use GLM-5.3 or an Auto route during the day |
| Trae 401 | Credentials expire in ~5 days; log into Trae again. The gateway re-reads `storage.json` on 401 without a restart |
| Qoder/QwenWork 401 or `no usable account for realm` | The realm's account pool is empty or expired. Press "Sync accounts"; cooling-down accounts become usable when the cooldown ends (or restart the gateway) |
| QwenWork returns `503 Model catalog unavailable` inside an SSE body (HTTP 200) | The catalog is scene-partitioned and the request must declare the workbench shape. Watch the payload, not the status code |
| Doubao 401 / missing cookie | The client's login state expired. Use "sync login state" (debug port already open) or "restart client and sync" |
| Doubao replies garbled or empty | Check that the request body really is UTF-8 (see the curl note above); if the pinned conversation was deleted, pick another with `POST /admin/conversation` |
| Button does nothing | Almost always Python missing `cryptography` — spawn succeeds, then the watcher dies instantly. Run the environment check |
| Console frozen | Rare, in old builds: an uncaught spawn error blocked the event loop. Current builds route through `trySpawn`; if it recurs, check PATH |

## Inherent limits

**Shared by all seven**: only WorkBuddy and AutoClaw keep the message history structured upstream. The other five flatten history into text before feeding their agent protocols, so multi-turn tool round-trips, structured roles and attachment references can lose fidelity — most visible in long conversations. Qoder CN and QwenWork CN are the exception among those five (tools are a real list, only history is text), so tool loops still hold.

**Vision** is configured per route from live tests: GLM-5.3-Flash, DeepSeek-V4.1-Flash and the Auto routes take images; GLM-5.3 (coding variant) and DeepSeek-V4-Pro do not and will say they cannot see.

**Trae**: tools are not forwarded (the agent decides for itself; OpenAI's `tools` field is ignored and the model only returns text); ~17.6k prompt tokens of fixed overhead per turn makes short Q&A uneconomical.

**Doubao Work**: no tool calls; only two synthetic catalog entries; request content stays in the local Doubao conversation.

**Comate**: no tool forwarding (the cloud agent decides); 8–40 s three-step chain latency per turn; the upstream agent's self-image comes from its own system prompt (it calls itself a Cursor-family assistant), not from your IDE.

**Qoder CN**: most models sit behind a paywall on Free accounts (filtered out at registration via `enabled:false`); the usable ones still suffer flattened history. QwenWork CN's three-model catalog is **not interchangeable** with CN's — it only understands its own keys, so under the `qworkcn` exit none of CN's model names work (and vice versa). That is the upstream's closed catalog, not gateway filtering.

## Layout

```
(repo root — this is also the runtime resource root)
├── app/            Electron console (main.js / preload.js / zcode-config.js / test_zcode_config.js / renderer/)
├── bridge/         AutoClaw 2.x adapter: credential bridging, watcher, server_2x.mjs, persona.txt, 406 experiments
├── trae/           Trae SOLO CN relay + offline credential decryptor + regression tests
├── doubao/         Doubao Work relay + CDP tooling + protocol probes
├── comate/         Comate relay + license decryptor
├── qoder/          Qoder CN / QwenWork CN gateway (vendored qoder2api-hub + local patches)
├── a_switch.py     A-SWITCH 1.x backend (accounts, check-in, DPAPI, one-click relay, warming) — also what the
│                   console's register / balance / credential-sync handlers load
├── a_switch_app.py A-SWITCH 1.x GUI (pywebview)
├── relay/          1.x relay (2.x users: use bridge/server_2x.mjs)
├── workbuddy/      WorkBuddy gateway — NOT in git; unpack from Releases into workbuddy/workbuddy-manager-v1.0.79/upstream/
└── A-SWITCH.spec / tools/ / assets/ / docs / LICENSE
```

Runtime data is generated locally and never committed: `~/.autoclaw-relay/` (deployed relay, persona, logs, the Qoder realm keys), `~/.openclaw-autoclaw/` (credential source), `~/.trae-relay/`, `~/.doubao-relay/`, `~/.comate-relay/`, `~/.qoder-relay/` (account pool, real tokens — never share these), and the ZCode config itself (backed up as `.bak-autoclaw`).

## A-SWITCH 1.x (legacy, still working)

The original tool — a multi-account manager for AutoClaw with a local relay — is still in this repo and still works.

1. **Multi-account.** Add, switch and monitor balances from one window, plus batch check-in for daily points (the AutoClaw client itself only logs in one account at a time).
2. **Ban prevention.** Upstream risk control watches the *shape* of your traffic: an account making nothing but 1-token probes, or hammered at hundreds of requests per minute, gets banned. Hence account warming (8 rounds of real technical conversation for new accounts), rate limiting (12/min per account), a concurrency gate (≤4 in-flight per pool) and a daily budget (6000/day per account, counted locally). These numbers came from forensics on actually-banned accounts — don't tune them up.
3. **Relay.** One button deploys the local relay and registers AutoClaw in ZCode.

**Install (1.x)**: `pip install pywebview cryptography && python a_switch_app.py` (Windows only — token decryption uses DPAPI; Python 3.10+), or build the exe with `pip install pyinstaller && pyinstaller A-SWITCH.spec --noconfirm` → `dist/A-SWITCH.exe`.

**Usage (1.x)**: AutoClaw must be installed and logged in at least once. "Add via desktop login" pops the official login window and archives the account — fully quit AutoClaw first (tray icon included). "One-click relay" deploys the relay to `~/.autoclaw-relay/`, registers the provider and fires one verification request. "Warm-up" chats 8 rounds on real technical topics (skip it and the account won't last long). International accounts can register by email (CN is phone-only); new accounts receive 10,000 points over 7 days. The 1.x relay (`relay/server.mjs`) is the predecessor of `bridge/server_2x.mjs` — 2.x users should use the latter.

## Disclaimer

This project talks to AutoClaw, WorkBuddy, Trae SOLO CN, Doubao Work, Comate 文心快码, Qoder CN and QwenWork CN through reverse-engineered, unofficial interfaces, for study and research only. Account bans and credit losses are on you. Not for commercial use. AutoClaw is a Zhipu/Z.ai product, WorkBuddy's service comes from Tencent Cloud, Trae and Doubao Work are ByteDance products, Comate 文心快码 is a Baidu product, Qoder and QwenWork are Alibaba products. This project is not affiliated with any of them.
