"use strict";
/**
 * 入站 api_key 的生成与存档（纯 Node，回归测试见 app/test_inbound_keys.js）。
 *
 * 语义（2026-10-11 起控制台「生成」按钮）：
 *  - 「生成」是加钥不是废钥：每条链路的有效钥匙 = 内置兜底钥 ∪ env 轮换钥 ∪
 *    本档案里的生成钥。内置钥是 relay 源码里的常量，控制台废不掉它；生成后
 *    ZCode 注册值切到新钥，内置钥自动退居「备」（仍可用，闸门语义如此）。
 *  - 档案固定落在 ~/.autoclaw-relay/inbound-keys.json（0600，runtime 数据不进
 *    仓库）。四条 env 型 relay（autoclaw/trae/doubao/comate）启动时读它并把
 *    本链路钥并进 INBOUND_KEYS——所以生成后必须重启对应 relay 才生效，控制台
 *    在跑着的话自动停-起；手动启动的 relay 重启后同样吃进新钥。
 *  - workbuddy / qoder / qwenwork 不走本档案：前者改 wb2api 的 config.json
 *    api_key，后两者是网关侧出口 Key（qoder-realm-keys.json，见 main.js
 *    qoderEnsureRealmKeys），由既有流程管理；PREFIX 里仍给它们留了前缀，
 *    这样控制台生成的随机钥一眼能看出归属。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// 内置兜底钥必须与各 relay 源码里的常量逐字一致（test_inbound_keys.js 有防漂移断言）
const BUILTIN = {
  autoclaw: "autoclaw-local",
  workbuddy: "wb-local-key",
  trae: "trae-local-key",
  doubao: "doubao-local-key",
  comate: "comate-local",
  qoder: "qoder-local",
  qwenwork: "qwenwork-local",
};

// 生成钥前缀：与 qoder 出口 Key 的 qd- 风格一致，一眼看出出自哪条链路
const PREFIX = { autoclaw: "ac", workbuddy: "wb", trae: "tr", doubao: "db", comate: "cm", qoder: "qd", qwenwork: "qw" };

// 本档案只管 env 型四条链路；其余链路的生成走各自部件（见文件头）
const STORE_LINKS = ["autoclaw", "trae", "doubao", "comate"];

const storePath = (homeDir) => path.join(homeDir, ".autoclaw-relay", "inbound-keys.json");

/** 随机钥：前缀 + 密码学随机 18 字节 hex（36 位，与 qoder 出口 Key 同规格） */
function generateKey(linkId) {
  const prefix = PREFIX[linkId] || "ik";
  return `${prefix}-${crypto.randomBytes(18).toString("hex")}`;
}

/** 形状校验：可打印 ASCII 且无空白、4..128 字符——header/env/JSON 三处都不会被截断 */
function validKey(value) {
  return typeof value === "string" && /^[\x21-\x7e]{4,128}$/.test(value);
}

/**
 * 读档案：缺失 / 坏 JSON / 非对象 → {}；只保留「非空 + 形状合法」的字符串值。
 * 宽容读、严格写：手改坏的档案不该把坏钥带进控制台的口径。
 */
function readStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const s = typeof v === "string" ? v.trim() : "";
      if (validKey(s)) out[k] = s;
    }
    return out;
  } catch { return {}; }
}

/** 原子写档案（tmp+rename，0600）。runtime 数据，绝不进仓库 */
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 本链路档案里的生成钥；没生成过返回空串（调用方回退 BUILTIN） */
function activeKey(store, linkId) {
  return (store && store[linkId]) || "";
}

module.exports = { BUILTIN, PREFIX, STORE_LINKS, storePath, generateKey, validKey, readStore, writeStore, activeKey };
