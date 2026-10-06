"use strict";
/**
 * ZCode 配置写入的沙箱回归测试：`node app/test_zcode_config.js`
 *
 * 全部跑在临时目录里的合成 fixture 上，绝不碰 ~/.zcode 里的真实配置。
 * 用例 A/B/C 复现的正是 2026-10-05 把用户配置改坏的两个错误：写入非法
 * api.type、以及整体重建 modelConfigRules 时丢掉 manualProviderModelRules。
 * 旧的内联实现三条都会失败；新实现三条都必须通过。A4（缺 modelId 的坏条目
 * 也必须能被本家目录覆盖）与 G1（主进程里不存在同名函数静默覆盖）是
 * 2026-10-06 新增的两个回归。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ZCODE_API, readConfig, writeZcodeConfig, upsertProviderRule, upsertModelEntries, checkZcodeConfig,
} = require("./zcode-config.js");

const results = [];
const t = (name, fn) => {
  try { fn(); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const throws = (fn, needle, msg) => {
  try { fn(); } catch (e) {
    assert(String(e.message).includes(needle), `${msg}：错误信息不符，实际为「${e.message}」`);
    return;
  }
  throw new Error(`${msg}：预期抛错但没有`);
};

const WB = "workbuddy-openai-provider";
const TRAE = "trae-openai-provider";
const AC = "autoclaw-glm-provider";

/** 与用户真实文件同构的 fixture：两个合法供应商 + 一个别的供应商 + 手工规则与未知兄弟键 */
function fixture() {
  return {
    version: 7,
    config: {
      providerOrder: [AC, "someone-else", WB],
      providerConfigRules: {
        providerRules: [
          { providerId: AC, providerName: "AutoClaw", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: "autoclaw-local" },
              api: { type: ZCODE_API.ANTHROPIC, baseUrl: "http://127.0.0.1:18766" },
              personalModelIds: ["GLM-5.3", "GLM-5.3-Flash", "Auto", "Auto-Fast"] } },
          { providerId: "someone-else", providerName: "别家", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: "x" },
              api: { type: ZCODE_API.OPENAI_CHAT, baseUrl: "http://example.com/v1" },
              personalModelIds: ["m1"] } },
          { providerId: WB, providerName: "WorkBuddy", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: "wb-local-key" },
              api: { type: ZCODE_API.OPENAI_CHAT, baseUrl: "http://127.0.0.1:7863/v1" },
              modelOrder: ["cn:auto"],
              personalModelIds: ["cn:auto"] } },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: AC, modelId: "GLM-5.3", config: { enabled: true, properties: { contextWindow: 1048576 } } },
          { providerId: WB, modelId: "cn:auto", config: { enabled: true, properties: {
            contextWindow: 200000,
            inputFormat: { supportsText: true, supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false },
            outputFormat: { supportsText: true } } } },
          { providerId: WB, modelId: "cn:glm-5.3", config: { enabled: true, properties: { contextWindow: 200000 } } },
        ],
        manualProviderModelRules: [],
        // 模拟未来 ZCode 版本新增的兄弟键：我们完全不认识，但也绝不能弄丢
        someFutureSibling: { keep: true },
      },
    },
  };
}

/** 模拟“注册三个平台”想要写入的状态（合法版） */
function registeredConfig(cfg, { wbEnums = ZCODE_API.OPENAI_CHAT, keepManual = true, keepFuture = true, trae = true } = {}) {
  const next = JSON.parse(JSON.stringify(cfg));
  const conf = next.config;
  conf.providerConfigRules.providerRules = upsertProviderRule(conf.providerConfigRules.providerRules, {
    providerId: WB, providerName: "WorkBuddy", enabled: true,
    config: { group: "standard-personal", access: { type: "api-key", apiKey: "wb-local-key" },
      api: { type: wbEnums, baseUrl: "http://127.0.0.1:7863/v1" },
      personalModelIds: ["cn:auto", "cn:glm-5.3", "cn:deepseek-v4-pro"] },
  });
  if (trae) {
    conf.providerConfigRules.providerRules = upsertProviderRule(conf.providerConfigRules.providerRules, {
      providerId: TRAE, providerName: "Trae", enabled: true,
      config: { group: "standard-personal", access: { type: "api-key", apiKey: "trae-local-key" },
        api: { type: ZCODE_API.OPENAI_CHAT, baseUrl: "http://127.0.0.1:18768/v1" },
        personalModelIds: ["glm-5.1", "Doubao-Seed-Code"] },
    });
    if (!conf.providerOrder.includes(TRAE)) conf.providerOrder.push(TRAE);
  }
  conf.modelConfigRules.providerModelRules = upsertModelEntries(
    conf.modelConfigRules.providerModelRules, WB,
    [["cn:auto", 200000], ["cn:glm-5.3", 200000], ["cn:deepseek-v4-pro", 200000]].map(([modelId, contextWindow]) => ({
      providerId: WB, modelId, config: { enabled: true, properties: {
        contextWindow,
        inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
        outputFormat: { supportsText: true } } },
    })));
  if (trae) {
    conf.modelConfigRules.providerModelRules = upsertModelEntries(
      conf.modelConfigRules.providerModelRules, TRAE,
      [["glm-5.1", 200000], ["Doubao-Seed-Code", 184000]].map(([modelId, contextWindow]) => ({
        providerId: TRAE, modelId, config: { enabled: true, properties: {
          contextWindow,
          inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true } } },
      })));
  }
  if (!keepManual) delete conf.modelConfigRules.manualProviderModelRules;
  if (!keepFuture) delete conf.modelConfigRules.someFutureSibling;
  return next;
}

// 结构路径里的数组元素身份是 `providerId/modelId`，缺 modelId 的坏条目只剩 `providerId`，
// 两种形态都得放行（2026-10-06 的教训：只放行带斜杠那种，坏条目就永远修不好——任何修复
// 写入都会被自己的闸门拦下，表现为“注册报成功、配置里还是旧的空条目”）
const CATALOG_ALLOW = [AC, WB, TRAE].flatMap((p) => [
  `config.modelConfigRules.providerModelRules[${p}]`,
  `config.modelConfigRules.providerModelRules[${p}/`]);
const CATALOG_ALLOW_SLASH_ONLY = [AC, WB, TRAE].map((p) => `config.modelConfigRules.providerModelRules[${p}/`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcfg-test-"));
const cfgPath = path.join(tmp, "provider_config.json");
const seed = fixture();
let prevRaw = JSON.stringify(seed, null, 2);
const reset = () => { fs.writeFileSync(cfgPath, prevRaw); };

// ---- A. 旧代码的两个错误必须被拒绝 ----
t("A1 拒绝非法 api.type（openai-compatible）", () => {
  reset();
  const bad = registeredConfig(seed, { wbEnums: "openai-compatible" });
  throws(() => writeZcodeConfig(cfgPath, bad, prevRaw, { allowRemovedPaths: CATALOG_ALLOW }),
    "不是合法枚举", "非法枚举应被拒绝");
  assert(readConfig(cfgPath).config.providerConfigRules.providerRules.find((r) => r.providerId === WB).config.api.type === ZCODE_API.OPENAI_CHAT,
    "被拒绝的写入不应改动文件");
});

t("A2 拒绝丢失 manualProviderModelRules（整体重建 modelConfigRules）", () => {
  reset();
  const bad = registeredConfig(seed, { keepManual: false });
  throws(() => writeZcodeConfig(cfgPath, bad, prevRaw, { allowRemovedPaths: CATALOG_ALLOW }),
    "丢失既有结构", "丢失兄弟键应被拒绝");
});

t("A3 拒绝丢失未知兄弟键（未来版本新增字段）", () => {
  reset();
  const bad = registeredConfig(seed, { keepFuture: false });
  throws(() => writeZcodeConfig(cfgPath, bad, prevRaw, { allowRemovedPaths: CATALOG_ALLOW }),
    "someFutureSibling", "丢失未知兄弟键应被拒绝");
});

t("A4 缺 modelId 的坏条目可被本家目录重写覆盖（只放行带斜杠的写法会拦住修复）", () => {
  // 造一条坏条目：有 providerId 没有 modelId（历史上生成过，注册结果里 modelId 全是 null）
  const broken = JSON.parse(JSON.stringify(seed));
  broken.config.modelConfigRules.providerModelRules.push({
    providerId: WB, config: { enabled: true, properties: { contextWindow: 200000 } },
  });
  fs.writeFileSync(cfgPath, JSON.stringify(broken, null, 2));
  const next = registeredConfig(broken);
  throws(() => writeZcodeConfig(cfgPath, next, JSON.stringify(broken, null, 2), { allowRemovedPaths: CATALOG_ALLOW_SLASH_ONLY }),
    "丢失既有结构", "旧的白名单写法应拦下修复（这条就是当时的现场）");
  // 补上不带斜杠的形态后，修复必须放行
  writeZcodeConfig(cfgPath, next, JSON.stringify(broken, null, 2), { allowRemovedPaths: CATALOG_ALLOW });
  const left = readConfig(cfgPath).config.modelConfigRules.providerModelRules.filter((r) => r.providerId === WB);
  assert(left.every((r) => r.modelId), `坏条目应被重写掉，实际剩下 ${JSON.stringify(left.map((r) => r.modelId))}`);
  assert(readConfig(cfgPath).config.modelConfigRules.manualProviderModelRules !== undefined, "修复不得牵连兄弟键");
  reset();
});

// ---- B. 正常注册路径 ----
t("B1 合法注册：写入成功且既有内容全部保留", () => {
  reset();
  const next = registeredConfig(seed);
  writeZcodeConfig(cfgPath, next, prevRaw, { allowRemovedPaths: CATALOG_ALLOW });
  const got = readConfig(cfgPath);
  const rules = got.config.providerConfigRules.providerRules;
  assert(rules.every((r) => !r.config?.api?.type || ["anthropic-messages", "openai-responses", "openai-chat-completions"].includes(r.config.api.type)),
    "落盘后所有 api.type 必须合法");
  assert("manualProviderModelRules" in got.config.modelConfigRules, "manualProviderModelRules 必须保留");
  assert("someFutureSibling" in got.config.modelConfigRules, "未知兄弟键必须保留");
  assert(rules.find((r) => r.providerId === "someone-else").config.personalModelIds.join() === "m1", "别家供应商不得被改动");
  assert(rules.find((r) => r.providerId === WB).config.modelOrder.join() === "cn:auto", "供应商规则里我们不管的子键必须保留");
  assert(rules.some((r) => r.providerId === TRAE), "Trae 供应商应已加入");
  assert(got.config.providerOrder.includes(TRAE), "providerOrder 应包含 Trae");
});

t("B2 写入前自动备份", () => {
  reset();
  const next = registeredConfig(seed);
  const bak = writeZcodeConfig(cfgPath, next, prevRaw, { allowRemovedPaths: CATALOG_ALLOW });
  assert(fs.existsSync(bak), "应生成备份文件");
  assert(JSON.parse(fs.readFileSync(bak, "utf8")).config.providerConfigRules.providerRules.length === 3, "备份应为写入前的内容");
});

// ---- C. 已有能力声明不被覆盖 ----
t("C1 重复注册保留既有 supportsImage", () => {
  reset();
  writeZcodeConfig(cfgPath, registeredConfig(seed), prevRaw, { allowRemovedPaths: CATALOG_ALLOW });
  const round1 = fs.readFileSync(cfgPath, "utf8");
  const next2 = registeredConfig(readConfig(cfgPath));
  writeZcodeConfig(cfgPath, next2, round1, { allowRemovedPaths: CATALOG_ALLOW });
  const auto = readConfig(cfgPath).config.modelConfigRules.providerModelRules.find((x) => x.providerId === WB && x.modelId === "cn:auto");
  assert(auto.config.properties.inputFormat.supportsImage === true, "既有 supportsImage=true 不应被刷新目录时抹掉");
});

t("C2 幂等：连续两次注册内容一致", () => {
  reset();
  writeZcodeConfig(cfgPath, registeredConfig(seed), prevRaw, { allowRemovedPaths: CATALOG_ALLOW });
  const a = fs.readFileSync(cfgPath, "utf8");
  writeZcodeConfig(cfgPath, registeredConfig(readConfig(cfgPath)), a, { allowRemovedPaths: CATALOG_ALLOW });
  const b = fs.readFileSync(cfgPath, "utf8");
  assert(a === b, "第二次注册不应产生内容变化");
});

// ---- D. 体检 ----
t("D1 checkZcodeConfig 能报出非法枚举与字段缺失", () => {
  const bad = fixture();
  bad.config.providerConfigRules.providerRules[1].config.api.type = "openai-compatible";
  delete bad.config.modelConfigRules.manualProviderModelRules;
  fs.writeFileSync(cfgPath, JSON.stringify(bad, null, 2));
  const r = checkZcodeConfig(cfgPath);
  assert(r.ok === false, "应判定为不健康");
  assert(r.illegal.length === 1 && r.illegal[0].providerId === "someone-else", "应指出非法枚举的供应商");
  assert(r.hasManualRules === false, "应报出 manualProviderModelRules 缺失");
  assert(r.modelConfigRulesKeys.join() === "providerModelRules,someFutureSibling", "应列出实际键集合");
});

// ---- E. 真实文件只读体检（不改动） ----
t("E1 真实配置当前健康（只读，不写入）", () => {
  const real = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
  if (!fs.existsSync(real)) return;
  const before = fs.statSync(real).mtimeMs;
  const r = checkZcodeConfig(real);
  assert(r.ok === true, `真实配置存在非法 api.type：${JSON.stringify(r.illegal)}`);
  assert(r.hasManualRules === true, "真实配置缺少 manualProviderModelRules");
  assert(fs.statSync(real).mtimeMs === before, "体检不得改动文件");
});

// ---- F. 模型条目必须「就地生效」 ----
// 回归：2026-10-05 之前的 upsertModelEntries 返回新数组，而 main.js 三处调用都不接返回值，
// 症状是 personalModelIds 从 12 涨到 27、providerModelRules 里却仍是旧条目，ZCode 看不到新模型。
t("F1 调用方忽略返回值时，新增模型条目仍然落进原数组", () => {
  const arr = [{ providerId: "p1", modelId: "old" }];
  upsertModelEntries(arr, "p1", [
    { providerId: "p1", modelId: "old" },
    { providerId: "p1", modelId: "brand-new" },
  ]);
  assert(arr.length === 2, `条目数应为 2，实际 ${arr.length}`);
  assert(arr.some((x) => x.modelId === "brand-new"), "新模型条目必须存在");
});

t("F2 已有条目的能力声明保留，只刷新 contextWindow", () => {
  const arr = [{
    providerId: "p1",
    modelId: "m",
    config: { properties: { contextWindow: 1000, inputFormat: { supportsImage: true } } },
  }];
  upsertModelEntries(arr, "p1", [{
    providerId: "p1",
    modelId: "m",
    config: { properties: { contextWindow: 5000 } },
  }]);
  const props = arr[0].config.properties;
  assert(props.contextWindow === 5000, "contextWindow 应被刷新");
  assert(props.inputFormat?.supportsImage === true, "supportsImage 必须保留（不能被默认值抹掉）");
});

t("F3 其它供应商的条目位置不动", () => {
  const arr = [
    { providerId: "a", modelId: "a1" },
    { providerId: "p1", modelId: "old" },
    { providerId: "b", modelId: "b1" },
  ];
  upsertModelEntries(arr, "p1", [{ providerId: "p1", modelId: "new" }]);
  assert(arr.map((x) => x.modelId).join() === "a1,new,b1", `位置应保持 a1,new,b1，实际 ${arr.map((x) => x.modelId).join()}`);
});

// ---- G. 主进程源码卫生 ----
// 同一作用域里重复声明同名 function，JS 会静默覆盖（不报错，node --check 也过）：
// 2026-10-06 就这么把 comateModels() 覆盖成了返回字符串数组的版本，导致 15 条
// comate 目录的 modelId 全写成 null，而注册流程照样报成功。
t("G1 main.js 里不存在重复声明的函数（静默覆盖曾写出 null modelId）", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const seen = new Map();
  src.split("\n").forEach((line, i) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) throw new Error(`函数 ${m[1]}() 在第 ${seen.get(m[1])} 行与第 ${i + 1} 行重复声明`);
    seen.set(m[1], i + 1);
  });
  assert(seen.size > 20, `main.js 只扫到 ${seen.size} 个顶层函数声明，正则或文件结构变了，这条用例已失效`);
});

const pass = results.filter((r) => r[1]).length;
for (const [name, ok, msg] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + msg}`);
console.log(`\n==== ${pass}/${results.length} ====`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(pass === results.length ? 0 : 1);
