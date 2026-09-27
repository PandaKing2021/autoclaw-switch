// Cloudflare Email Worker —— 自建域名验证码邮箱（网页查看器 + JSON API 双模）
//
// 功能：
//   1. email 事件：接收任意 *@szpuedu.dpdns.org 的邮件，解码 MIME，存 KV（含 HTML 正文）
//   2. GET /viewer?key=...        网页版邮件查看器（列表 + 渲染 HTML 正文，链接可点）
//   3. GET /api/getcode?addr=...&key=...   JSON 取码（自动化用）
//      返回 {"ok":true,"code":"123456","codes":[...],"subject":"...","html":"..."}
//   4. GET /api/mails?key=...     JSON 邮件列表
//   5. GET /api/list              调试：信封形状
//   6. GET /ping
//
// 无第三方依赖；内置轻量 MIME 解码（multipart/base64/quoted-printable）。
// 安全：API_KEY 是查看器和 API 的口令；Worker 只读邮件、不回信。

const API_KEY = "asw_RLdO-4xPUeZ8Z2oG";           // 取码口令（自己保管）
const TTL = 86400;                                 // 邮件保留 1 天
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
function mimeToParts(raw, depth) {
  depth = depth || 0;
  if (depth > 4) return [];
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw);
  if (boundary) {
    const b = "--" + boundary[1];
    const parts = raw.split(b).slice(1, -1);
    let all = [];
    for (const p of parts) all = all.concat(mimeToParts(p, depth + 1));
    return all;
  }
  const sep = raw.match(/\r?\n\r?\n/);
  if (!sep) return [{ head: raw, body: raw }];
  const head = raw.slice(0, sep.index);
  const body = raw.slice(sep.index + sep[0].length);
  return [{ head, body }];
}
function mimeToTextAndHtml(raw) {
  let text = "", html = "";
  for (const { head, body } of mimeToParts(raw)) {
    const cte = (/content-transfer-encoding:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "";
    const ct = (/content-type:\s*([^;\r\n]+)/i.exec(head) || [])[1] || "";
    let decoded = body;
    if (/base64/i.test(cte)) decoded = b64ToText(body.split(/\r?\n\r?\n/)[0] || body);
    else if (/quoted-printable/i.test(cte)) decoded = decodeQP(body);
    if (/html/i.test(ct) || /<html|<body|<div|<table/i.test(decoded)) html += decoded;
    else text += decoded + "\n";
  }
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return { text, html };
}
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
      const { text, html } = mimeToTextAndHtml(raw);
      const codes = extractCodes(text + " " + subject);
      const record = { from, subject, codes, code: codes[0] || "",
                       text: text.replace(/\s+/g, " ").slice(0, 4000),
                       html: html.slice(0, 120000), ts: Date.now() };
      const v = JSON.stringify(record);
      await env.MAILCODE.put("m:" + to, v, { expirationTtl: TTL });
      await env.MAILCODE.put("m:" + local, v, { expirationTtl: TTL });
      try {
        const rawTo = message.to;
        if (rawTo && rawTo.toLowerCase() !== to) {
          await env.MAILCODE.put("m:" + rawTo, v, { expirationTtl: TTL });
        }
      } catch {}
      await env.MAILCODE.put("dbg:" + Date.now(), JSON.stringify({
        to: message.to, local, from, subject: subject.slice(0, 60),
        codes, hasText: text.length > 0,
      }), { expirationTtl: 86400 });
    } catch (e) {
      await env.MAILCODE.put("err:" + Date.now(), String(e).slice(0, 500), { expirationTtl: 86400 });
    }
  },

  // ---- HTTP：查看器 + API ----
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";
    const keyOk = key === API_KEY;

    if (url.pathname === "/ping") {
      return Response.json({ ok: true, domain: EMAIL_DOMAIN });
    }

    // ---- JSON：邮件列表 ----
    if (url.pathname === "/api/mails") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403 });
      const mails = [];
      const d2 = await env.MAILCODE.list({ prefix: "m:" });
      const seen = new Set();
      for (const k of (d2.keys || []).slice(0, 40)) {
        const addr = k.name.slice(2);
        if (seen.has(addr)) continue; seen.add(addr);
        try {
          const rec = JSON.parse(await env.MAILCODE.get(k.name) || "{}");
          mails.push({ addr, subject: rec.subject, from: rec.from, code: rec.code,
                       codes: rec.codes, ts: rec.ts });
        } catch {}
      }
      mails.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return Response.json({ ok: true, mails });
    }

    // ---- JSON：取码（自动化） ----
    if (url.pathname === "/api/getcode") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403 });
      const addr = (url.searchParams.get("addr") || "").toLowerCase();
      if (!addr || !addr.endsWith("@" + EMAIL_DOMAIN)) {
        return Response.json({ ok: false, error: "addr must end with @" + EMAIL_DOMAIN }, { status: 400 });
      }
      let recRaw = await env.MAILCODE.get("m:" + addr);
      if (!recRaw) recRaw = await env.MAILCODE.get("m:" + addr.split("@")[0]);
      if (!recRaw) {
        return Response.json({ ok: false, error: "no mail yet", addr,
                               hint: "GET /api/list 查看信封形状；/viewer 网页查看" });
      }
      const rec = JSON.parse(recRaw);
      return Response.json({ ok: true, addr, code: rec.code, codes: rec.codes,
                             subject: rec.subject, from: rec.from, ts: rec.ts,
                             html: (rec.html || "").slice(0, 2000),
                             text: (rec.text || "").slice(0, 800) });
    }

    // ---- 调试：信封形状 ----
    if (url.pathname === "/api/list") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403 });
      const dbg = [], mailKeys = [];
      const d1 = await env.MAILCODE.list({ prefix: "dbg:" });
      for (const k of (d1.keys || []).slice(0, 5)) {
        const v = await env.MAILCODE.get(k.name);
        try { dbg.push(JSON.parse(v || "{}")); } catch { dbg.push(v); }
      }
      const d2 = await env.MAILCODE.list({ prefix: "m:" });
      for (const k of (d2.keys || []).slice(0, 20)) mailKeys.push(k.name);
      return Response.json({ ok: true, dbg, mailKeys });
    }

    // ---- 网页查看器 ----
    if (url.pathname === "/viewer") {
      if (!keyOk) return new Response("bad key", { status: 403 });
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>邮件查看器 · ${EMAIL_DOMAIN}</title>
<style>
 body{margin:0;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#222}
 .wrap{max-width:1100px;margin:0 auto;padding:18px}
 h1{font-size:20px} .mut{color:#888;font-size:12px}
 .grid{display:grid;grid-template-columns:340px 1fr;gap:14px;align-items:start}
 .list{background:#fff;border:1px solid #e3e5e8;border-radius:8px;overflow:hidden}
 .item{padding:10px 12px;border-bottom:1px solid #eef0f2;cursor:pointer}
 .item:hover{background:#f0f4ff}
 .item.on{background:#e8efff}
 .item .t{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .item .m{font-size:11.5px;color:#888}
 .view{background:#fff;border:1px solid #e3e5e8;border-radius:8px;padding:14px}
 .code{font-size:28px;font-weight:700;background:#eef;padding:6px 14px;border-radius:6px;display:inline-block;margin:6px 0}
 iframe{width:100%;height:560px;border:1px solid #e3e5e8;border-radius:6px;background:#fff}
 .empty{color:#999;padding:40px;text-align:center}
 @media (max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>邮件查看器 <span class="mut">${EMAIL_DOMAIN}</span></h1>
<div class="grid"><div class="list" id="list"></div><div class="view" id="view"><div class="empty">左侧选择一封邮件</div></div></div>
</div>
<script>
var KEY = new URLSearchParams(location.search).get("key") || "";
function esc(s){return String(s??"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function fmtTs(ts){try{return new Date(ts).toLocaleString();}catch(e){return "";}}
async function loadList(){
  var r = await fetch("/api/mails?key="+encodeURIComponent(KEY));
  var d = await r.json();
  var box = document.getElementById("list");
  if(!d.ok || !d.mails.length){ box.innerHTML = '<div class="empty">暂无邮件</div>'; return; }
  box.innerHTML = d.mails.map(function(m,i){
    return '<div class="item" data-i="'+i+'"><div class="t">'+esc(m.subject||"(无主题)")+'</div>'
      + '<div class="m">'+esc(m.addr)+' · '+esc(fmtTs(m.ts))+(m.code?' · 码:'+esc(m.code):'')+'</div></div>';
  }).join("");
  window._mails = d.mails;
  box.querySelectorAll(".item").forEach(function(el){
    el.onclick = function(){ show(el.dataset.i|0); };
  });
  show(0);
}
async function show(i){
  var m = window._mails[i]; if(!m) return;
  document.querySelectorAll(".item").forEach(function(el,idx){ el.classList.toggle("on", idx===i); });
  var r = await fetch("/api/getcode?addr="+encodeURIComponent(m.addr)+"&key="+encodeURIComponent(KEY));
  var d = await r.json();
  var v = document.getElementById("view");
  if(!d.ok){ v.innerHTML = '<div class="empty">'+esc(d.error||"读取失败")+'</div>'; return; }
  v.innerHTML = '<div style="margin-bottom:8px">'
    + (d.code ? '验证码/码: <span class="code">'+esc(d.code)+'</span>' : '')
    + '<div class="mut">主题: '+esc(d.subject)+' · 来自: '+esc(d.from)+' · '+esc(fmtTs(d.ts))+'</div></div>'
    + '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" srcdoc="'
    + esc(d.html || ("<pre>"+esc(d.text||"(无正文)")+"</pre>")) + '"></iframe>';
}
loadList();
</script></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("A-SWITCH mail-code worker\n", { status: 200 });
  },
};
