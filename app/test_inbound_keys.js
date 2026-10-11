"use strict";
/**
 * 入站 api_key「生成」功能的沙箱回归测试：`node app/test_inbound_keys.js`
 *
 * 全部跑在临时目录里的合成 fixture 上，绝不碰真实的 ~/.autoclaw-relay/。
 * 重点是三条不变量：
 *   1. 生成钥形状（前缀 + 36 位 hex）与随机性——控制台生成的东西必须能当
 *      header/env 值用，不能带空白或逗号（逗号会破坏 *_INBOUND_KEYS 追加语义）；
 *   2. 档案读写宽容且不丢数据——手改坏的 JSON 不该把坏钥带进闸门口径；
 *   3. 内置兜底钥与 relay 源码逐字一致（防漂移）——BUILTIN 里改了名而 relay
 *      没跟着改，就会表现为「生成后旧 ZCode 注册值失效」这类现场故障。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const IK = require("./inbound-keys.js");

const results = [];
const t = (name, fn) => {
  try { fn(); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asw-ik-"));
const LINKS = ["autoclaw", "workbuddy", "trae", "doubao", "comate", "qoder", "qwenwork"];

// ------------------------------------------------------------ generateKey
t("A1 生成钥前缀覆盖七条链路", () => {
  for (const id of LINKS) {
    const k = IK.generateKey(id);
    assert(k.startsWith(IK.PREFIX[id] + "-"), `${id} 的前缀应为 ${IK.PREFIX[id]}-，实际 ${k}`);
  }
});

t("A2 生成钥形状 = 前缀 + 36 位 hex", () => {
  for (const id of LINKS) {
    const k = IK.generateKey(id);
    assert(/^[a-z]{2}-[0-9a-f]{36}$/.test(k), `${id} 形状不符：${k}`);
    assert(IK.validKey(k), `${id} 生成的钥应通过 validKey`);
  }
});

t("A3 未知链路退化为 ik- 前缀", () => {
  assert(/^ik-[0-9a-f]{36}$/.test(IK.generateKey("nope")), "未知链路应退化为 ik-");
});

t("A4 连续生成不重复", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const k = IK.generateKey("trae");
    assert(!seen.has(k), "两次生成出现相同值（随机源坏了）");
    seen.add(k);
  }
});

// -------------------------------------------------------------- validKey
t("B1 validKey 接受常规钥", () => {
  for (const k of ["abcd", "qd-0123456789abcdef0123456789abcdef0123", "A_b-C.9~x"]) {
    assert(IK.validKey(k), `应接受：${k}`);
  }
});

t("B2 validKey 拒绝空/短/空白/逗号/超长", () => {
  const bad = ["", "abc", "has space", "has\tspace", "a,b", "x".repeat(129)];
  for (const k of bad) assert(!IK.validKey(k), `应拒绝：${JSON.stringify(k.slice(0, 20))}（长度 ${k.length}）`);
});

t("B3 validKey 拒绝非字符串", () => {
  for (const v of [null, undefined, 123, {}, ["a"], Buffer.from("abcd")]) assert(!IK.validKey(v), "应拒绝非字符串");
});

// ------------------------------------------------------------- storePath
t("C1 storePath 落在 ~/.autoclaw-relay/inbound-keys.json", () => {
  const p = IK.storePath("C:\\Users\\fake");
  assert(p === path.join("C:\\Users\\fake", ".autoclaw-relay", "inbound-keys.json"), "路径不符：" + p);
});

// ------------------------------------------------------------- readStore
t("D1 档案缺失 → 空对象", () => {
  assert(JSON.stringify(IK.readStore(path.join(tmp, "no-such.json"))) === "{}", "缺失应返回 {}");
});

t("D2 坏 JSON → 空对象（不抛错）", () => {
  const f = path.join(tmp, "bad.json");
  fs.writeFileSync(f, "{not json");
  assert(JSON.stringify(IK.readStore(f)) === "{}", "坏 JSON 应返回 {}");
});

t("D3 数组 / null / 标量 → 空对象", () => {
  for (const [name, raw] of [["arr.json", "[1,2]"], ["null.json", "null"], ["num.json", "42"]]) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, raw);
    assert(Object.keys(IK.readStore(f)).length === 0, `${name} 应返回 {}`);
  }
});

t("D4 非字符串值与坏形状值被过滤", () => {
  const f = path.join(tmp, "mixed.json");
  fs.writeFileSync(f, JSON.stringify({
    trae: "tr-" + "a".repeat(36), autoclaw: 123, doubao: null, comate: { v: "x" },
    ghost: "has space", long: "y".repeat(200), empty: "",
  }));
  const s = IK.readStore(f);
  assert(s.trae === "tr-" + "a".repeat(36), "合法值应保留");
  for (const k of ["autoclaw", "doubao", "comate", "ghost", "long", "empty"]) {
    assert(!(k in s), `${k} 应被过滤`);
  }
});

t("D5 值两端空白被 trim", () => {
  const f = path.join(tmp, "trim.json");
  fs.writeFileSync(f, JSON.stringify({ trae: "  tr-" + "b".repeat(36) + "\n" }));
  assert(IK.readStore(f).trae === "tr-" + "b".repeat(36), "应 trim 后保留");
});

// ------------------------------------------------------------ writeStore
t("E1 写后读回一致（含目录自动创建）", () => {
  const f = path.join(tmp, "nested", "deep", "inbound-keys.json");
  const store = { trae: IK.generateKey("trae"), doubao: IK.generateKey("doubao") };
  IK.writeStore(f, store);
  const back = IK.readStore(f);
  assert(back.trae === store.trae && back.doubao === store.doubao, "读回不一致");
});

t("E2 覆盖写：第二次写不含第一次的键", () => {
  const f = path.join(tmp, "overwrite.json");
  IK.writeStore(f, { trae: IK.generateKey("trae"), autoclaw: IK.generateKey("autoclaw") });
  IK.writeStore(f, { trae: IK.generateKey("trae") });
  const back = IK.readStore(f);
  assert(back.trae && !("autoclaw" in back), "覆盖写应完全替换内容");
});

t("E3 原子写不留 .tmp 残留", () => {
  const f = path.join(tmp, "atomic.json");
  IK.writeStore(f, { comate: IK.generateKey("comate") });
  assert(!fs.existsSync(f + ".tmp"), ".tmp 应已被 rename 掉");
});

// ------------------------------------------------------------- activeKey
t("F1/F2/F3 activeKey 命中 / 未生成 / 空档案", () => {
  const store = { trae: "tr-" + "c".repeat(36) };
  assert(IK.activeKey(store, "trae") === store.trae, "命中应返回值");
  assert(IK.activeKey(store, "doubao") === "", "未生成应返回空串");
  assert(IK.activeKey({}, "trae") === "" && IK.activeKey(null, "trae") === "", "空/坏 store 应返回空串");
});

// --------------------------------------------------------- 防漂移（源码）
const srcOf = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

t("G1 BUILTIN 与四条 relay 源码常量逐字一致", () => {
  const relPaths = { autoclaw: "bridge/server_2x.mjs", trae: "trae/relay.mjs", doubao: "doubao/relay.mjs", comate: "comate/relay.mjs" };
  for (const [id, rel] of Object.entries(relPaths)) {
    const src = srcOf(rel);
    assert(src.includes(`"${IK.BUILTIN[id]}"`), `${rel} 里找不到内置钥 ${IK.BUILTIN[id]}（BUILTIN 与 relay 漂移了）`);
  }
});

t("G2 四条 relay 都带 consoleStoreKey 通道", () => {
  for (const rel of ["bridge/server_2x.mjs", "trae/relay.mjs", "doubao/relay.mjs", "comate/relay.mjs"]) {
    const src = srcOf(rel);
    assert(src.includes("function consoleStoreKey"), `${rel} 缺 consoleStoreKey（生成钥通道被删了？）`);
    assert(src.includes(".autoclaw-relay\", \"inbound-keys.json"), `${rel} 的档案路径不是 ~/.autoclaw-relay/inbound-keys.json`);
  }
});

t("G3 STORE_LINKS 恰为四条 env 链路", () => {
  assert(IK.STORE_LINKS.slice().sort().join(",") === "autoclaw,comate,doubao,trae", "STORE_LINKS 不符：" + IK.STORE_LINKS.join(","));
});

// ------------------------------------------------------------------ 汇总
const pass = results.filter((r) => r[1]).length;
for (const [name, ok, msg] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + msg}`);
console.log(`\n==== ${pass}/${results.length} ====`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(pass === results.length ? 0 : 1);
