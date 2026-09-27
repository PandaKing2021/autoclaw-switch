// Cloudflare Email Worker —— 自建域名验证码邮箱（兼容 unive.fun getcode 用途）
//
// 功能：
//   1. email 事件：接收任意 *@szpuedu.dpdns.org 的邮件，解码 MIME、提取验证码、存 KV
//   2. fetch 事件：HTTP 取码 API
//        GET /api/getcode?addr=xxx@szpuedu.dpdns.org&key=<API_KEY>
//        返回 JSON: {"ok":true,"code":"123456","codes":[...],"subject":"...","text":"..."}
//   3. GET /api/list 调试端点：列出最近信封形状与已存键
//   4. GET /ping 健康检查
//
// 无第三方依赖（CF 面板编辑器不支持 npm/URL 导入，MIME 解码内置轻量实现）。
// 注意：必须 `import crypto from "node:crypto"`（全局 webcrypto 没有 createHash）——本文件未用到。

const API_KEY = "asw_RLdO-4xPUeZ8Z2oG";           // 取码口令（自己保管）
const TTL = 86400;                                 // 验证码保留 1 天
const EMAIL_DOMAIN = "szpuedu.dpdns.org";          // ← 你的域名

// ---------- 轻量 MIME 解码 ----------
function b64ToText(b64) {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return ""; }
}
function decodeQP(s) {
  try {
    const bytes = [];
    const raw = s.replace(/=\r?\n/g, "");
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
        bytes.push(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2;
      } else bytes.push(raw.charCodeAt(i));
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch { return s; }
}
// 把整封 raw 邮件拆成可读文本：递归处理 multipart/base64/quoted-printable
function mimeToText(raw, depth) {
  depth = depth || 0;
  if (depth > 4) return "";
  let out = "";
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw);
  if (boundary) {
    const b = "--" + boundary[1];
    const parts = raw.split(b).slice(1, -1);
    for (const p of parts) out += mimeToText(p, depth + 1) + "\n";
    return out;
  }
  const sep = raw.match(/\r?\n\r?\n/);
  if (!sep) return raw;
  const head = raw.slice(0, sep.index);
  const body = raw.slice(sep.index + sep[0].length);
  const cte = (/content-transfer-encoding:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "";
  let text = body;
  if (/base64/i.test(cte)) text = b64ToText(body.split(/\r?\n\r?\n/)[0] || body);
  else if (/quoted-printable/i.test(cte)) text = decodeQP(body);
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return out + " " + text;
}

// 从文本提取验证码：优先独立 6 位数字
function extractCodes(text) {
  const codes = [];
  const six = text.match(/(?<!\d)(\d{6})(?!\d)/g);
  if (six) codes.push(...new Set(six));
  if (!codes.length) {
    const any = text.match(/(?<!\d)(\d{4,8})(?!\d)/g);
    if (any) codes.push(...new Set(any).slice(0, 5));
  }
  return codes;
}

export default {
  // ---- 收信 ----
  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const local = to.split("@")[0];
      const from = message.from || "";
      const subject = decodeQP(message.headers.get("subject") || "");
      const raw = await new Response(message.raw).text();
      const text = mimeToText(raw);
      const codes = extractCodes(text);
      const record = { from, subject, codes, code: codes[0] || "",
                       text: text.replace(/\s+/g, " ").slice(0, 4000), ts: Date.now() };
      const v = JSON.stringify(record);
      // 多键冗余：信封地址小写 / 本地部分 / 原始形状——取码按查询串逐个命中
      await env.MAILCODE.put("m:" + to, v, { expirationTtl: TTL });
      await env.MAILCODE.put("m:" + local, v, { expirationTtl: TTL });
      try {
        const rawTo = message.to;
        if (rawTo && rawTo.toLowerCase() !== to) {
          await env.MAILCODE.put("m:" + rawTo, v, { expirationTtl: TTL });
        }
      } catch {}
      // 调试快照：/api/list 可见最近 5 封的信封信息
      await env.MAILCODE.put("dbg:" + Date.now(), JSON.stringify({
        to: message.to, local, from, subject: subject.slice(0, 60),
        codes, hasText: text.length > 0,
      }), { expirationTtl: 86400 });
    } catch (e) {
      await env.MAILCODE.put("err:" + Date.now(), String(e).slice(0, 500), { expirationTtl: 86400 });
    }
  },

  // ---- 取码 API ----
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      return Response.json({ ok: true, domain: EMAIL_DOMAIN });
    }
    if (url.pathname === "/api/getcode") {
      const addr = (url.searchParams.get("addr") || "").toLowerCase();
      const key = url.searchParams.get("key") || "";
      if (key !== API_KEY) return Response.json({ ok: false, error: "bad key" }, { status: 403 });
      if (!addr || !addr.endsWith("@" + EMAIL_DOMAIN)) {
        return Response.json({ ok: false, error: "addr must end with @" + EMAIL_DOMAIN }, { status: 400 });
      }
      let recRaw = await env.MAILCODE.get("m:" + addr);
      if (!recRaw) {
        const local = addr.split("@")[0];
        recRaw = await env.MAILCODE.get("m:" + local);
      }
      if (!recRaw) {
        return Response.json({ ok: false, error: "no mail yet", addr,
                               hint: "已收到但查不到时，用 GET /api/list 看信封形状" });
      }
      const rec = JSON.parse(recRaw);
      return Response.json({ ok: true, addr, code: rec.code, codes: rec.codes,
                             subject: rec.subject, from: rec.from, ts: rec.ts,
                             text: (rec.text || "").slice(0, 800) });
    }
    if (url.pathname === "/api/list") {
      if (url.searchParams.get("key") !== API_KEY) {
        return Response.json({ ok: false, error: "bad key" }, { status: 403 });
      }
      const dbg = [], mailKeys = [];
      try {
        const d1 = await env.MAILCODE.list({ prefix: "dbg:" });
        for (const k of (d1.keys || []).slice(0, 5)) {
          const v = await env.MAILCODE.get(k.name);
          try { dbg.push(JSON.parse(v || "{}")); } catch { dbg.push(v); }
        }
        const d2 = await env.MAILCODE.list({ prefix: "m:" });
        for (const k of (d2.keys || []).slice(0, 20)) mailKeys.push(k.name);
      } catch (e) {
        return Response.json({ ok: false, error: "list failed: " + e.message });
      }
      return Response.json({ ok: true, dbg, mailKeys });
    }
    return new Response("A-SWITCH mail-code worker\n", { status: 200 });
  },
};
