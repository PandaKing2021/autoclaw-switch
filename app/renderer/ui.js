// 控制台渲染逻辑：状态轮询（本地 health，无上游出站）+ 按钮动作 + 日志查看
const $ = (id) => document.getElementById(id);
let currentLog = "relay";

function fmtUptime(s) {
  if (!s || s < 0) return "-";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}时${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`;
}
function fmtExp(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return `${d.toLocaleDateString()}（已过期）`;
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${d.toLocaleDateString()}（余 ${days} 天）`;
  return `${d.toLocaleDateString()}（余 ${Math.floor(ms / 3600000)} 小时）`;
}
function setPill(id, cls, text) { const el = $(id); el.className = "pill " + cls; el.textContent = text; }

async function refreshStatus() {
  try {
    const s = await window.api.queryStatus();
    // relay
    const relayOk = s.relay.running && s.relay.ok;
    setPill("relay-pill", relayOk ? "ok" : s.relay.running ? "warn" : "err",
      relayOk ? "运行中" : s.relay.running ? "异常" : "已停止");
    $("relay-status").textContent = relayOk ? `ok（${s.relay.status}）` : s.relay.running ? "无上游" : "未运行";
    $("relay-upstream").textContent = s.relay.upstream || "-";
    $("relay-uptime").textContent = fmtUptime(s.relay.uptimeS);
    $("relay-models").innerHTML = (s.relay.models || []).map((m) => `<span>${m}</span>`).join("");

    // token / credential
    const days = s.token.exp ? Math.max(0, Math.floor((s.token.exp * 1000 - Date.now()) / 86400000)) : -1;
    const msLeft = s.token.exp * 1000 - Date.now();
    setPill("token-pill", msLeft > 6 * 3600000 ? "ok" : msLeft > 0 ? "warn" : "err",
      msLeft > 0 ? `余 ${days >= 1 ? days + " 天" : Math.floor(msLeft / 3600000) + " 小时"}` : "已过期");
    $("token-exp").textContent = fmtExp(s.token.exp);
    $("credential").textContent = s.credential || "-";
    $("watcher-status").textContent = s.watcher.running ? "运行中" : "已停止";

    // zcode
    const zc = s.zcode;
    const zcOk = zc.registered && zc.enabled && zc.inOrder;
    setPill("zcode-pill", zcOk ? "ok" : "err", zcOk ? "已注册" : "未注册");
    $("zcode-registered").textContent = zc.registered ? (zc.enabled ? "已启用" : "已禁用") : "未注册";
    $("zcode-baseurl").textContent = zc.baseUrl || "-";
    $("zcode-models").textContent = (zc.models || []).join(" / ") || "-";

    // overall
    const msLeft2 = s.token.exp * 1000 - Date.now();
    const all = relayOk && zcOk && msLeft2 > 6 * 3600000;
    setPill("overall", all ? "ok" : "warn", all ? "链路正常" : "部分异常");
  } catch (e) {
    setPill("overall", "err", "状态获取失败");
  }
}

async function refreshPoints() {
  const btn = $("btn-points"); btn.disabled = true;
  $("acc-points").textContent = "查询中…";
  try {
    const r = await window.api.refreshPoints();
    if (r.ok) {
      $("acc-points").textContent = r.total != null ? r.total + " 分" : "无钱包数据";
      $("acc-expiring").textContent = r.expiring != null ? r.expiring + " 分" : "-";
      $("acc-name").textContent = r.nickname || r.user_id || "-";
      $("points-note").textContent = "";
    } else {
      $("acc-points").textContent = "-";
      $("points-note").textContent = "查询失败：" + (r.error || JSON.stringify(r)).slice(0, 160);
    }
  } catch (e) { $("points-note").textContent = "查询异常：" + e.message; }
  btn.disabled = false;
}

async function refreshLog() {
  try { $("logview").textContent = await window.api.tailLog(currentLog); } catch {}
}

// 绑定按钮
$("btn-relay-start").onclick = async () => { $("btn-relay-start").disabled = true; await window.api.relayStart(); $("btn-relay-start").disabled = false; refreshStatus(); };
$("btn-relay-stop").onclick = async () => { $("btn-relay-stop").disabled = true; await window.api.relayStop(); $("btn-relay-stop").disabled = false; refreshStatus(); };
$("btn-smoke").onclick = async () => {
  const btn = $("btn-smoke"); btn.disabled = true;
  $("smoke-result").textContent = "测试中（最长 3 分钟，遇限流会自动退避）…";
  try {
    const r = await window.api.smokeTest();
    $("smoke-result").textContent = r.ok ? `✅ 连通正常（${r.status}）模型回复：${r.reply}` : `❌ 失败（${r.status}）：${r.reply}`;
  } catch (e) { $("smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-points").onclick = refreshPoints;
$("btn-sync").onclick = async () => {
  const btn = $("btn-sync"); btn.disabled = true;
  try {
    const r = await window.api.syncCredential();
    $("points-note").textContent = r.ok ? "✅ 凭证已重新同步" : "❌ 同步失败：" + JSON.stringify(r).slice(0, 160);
  } catch (e) { $("points-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false;
};
$("btn-watcher").onclick = async () => {
  const s = await window.api.queryStatus();
  if (s.watcher.running) await window.api.watcherStop(); else await window.api.watcherStart();
  refreshStatus();
};
$("btn-register").onclick = async () => {
  const btn = $("btn-register"); btn.disabled = true;
  $("register-note").textContent = "注册中…";
  try {
    const r = await window.api.registerZcode();
    $("register-note").textContent = r.ok ? "✅ 已注册（重启 ZCode 生效），模型：" + (r.models || []).join("/") : "❌ " + (r.error || "失败");
  } catch (e) { $("register-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    currentLog = t.dataset.log;
    refreshLog();
  };
});

setInterval(refreshStatus, 3000);
setInterval(() => { if ($("autorefresh").checked) refreshLog(); }, 3000);
refreshStatus();
refreshPoints();
refreshLog();
