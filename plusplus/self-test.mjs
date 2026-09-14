#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  plusplus/self-test.mjs —— 增强层语义自测（不依赖 DSH 运行时）
//
//  覆盖：
//    A 作用域匹配（`*` / 白名单 / 通配 / 反向排除 / 空）
//    B ScopeList 仍是真的数组（Array.isArray / join / JSON / spread / map）
//    C 上游三处 includes 判定在包装后依然按预期工作
//    D modeBindings 模式→预设 绑定（含回落）
//    E systemSectionText 的 strictScope 两种行为
//    F hook 幂等性；给了 --pristine <file> 时还校验「从上游原文能变换出当前文件」
//
//  用法：node plusplus/self-test.mjs [--pristine <上游原始 lib/index.js>]
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pp from "../lib/plusplus.js";
import { applyHooks } from "./apply-hooks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── A 作用域匹配 ────────────────────────────────────────────────────
const cases = [
  { name: '["*"] 命中 standard', scopes: ["*"], id: "standard", want: true },
  { name: '["*"] 命中 preset-plus', scopes: ["*"], id: "preset-plus", want: true },
  { name: '["*"] 命中任意自定义模式', scopes: ["*"], id: "preset-mu1d5omp-uduygh", want: true },
  { name: '["*"] 不命中未挂预设(undefined)', scopes: ["*"], id: undefined, want: false },
  { name: '["*"] 不命中空串', scopes: ["*"], id: "", want: false },
  { name: '上游默认 ["preset-plus"] 不命中 standard', scopes: ["preset-plus"], id: "standard", want: false },
  { name: '上游默认 ["preset-plus"] 命中 preset-plus', scopes: ["preset-plus"], id: "preset-plus", want: true },
  { name: '白名单命中其中之一', scopes: ["standard", "tavern-lite"], id: "tavern-lite", want: true },
  { name: '白名单未列出的模式不命中', scopes: ["standard", "tavern-lite"], id: "minimal", want: false },
  { name: '通配 preset-* 命中', scopes: ["preset-*"], id: "preset-mu1d5omp-uduygh", want: true },
  { name: '通配 preset-* 不命中 standard', scopes: ["preset-*"], id: "standard", want: false },
  { name: '通配 ?avern-lite 命中', scopes: ["?avern-lite"], id: "tavern-lite", want: true },
  { name: '["*","!tavern-lite"] 排除生效', scopes: ["*", "!tavern-lite"], id: "tavern-lite", want: false },
  { name: '["*","!tavern-lite"] 其余仍命中', scopes: ["*", "!tavern-lite"], id: "standard", want: true },
  { name: '只有反向项 = 除它以外全部', scopes: ["!minimal"], id: "standard", want: true },
  { name: '只有反向项，被排除者不命中', scopes: ["!minimal"], id: "minimal", want: false },
  { name: '反向项也能用通配', scopes: ["*", "!preset-*"], id: "preset-plus", want: false },
  { name: '空数组 = 关闭', scopes: [], id: "preset-plus", want: false },
  { name: '字符串形式 "standard,tavern-lite"', scopes: "standard,tavern-lite", id: "tavern-lite", want: true },
  { name: '字符串形式 "*"', scopes: "*", id: "standard", want: true },
  { name: '未配置(undefined) = 关闭', scopes: undefined, id: "preset-plus", want: false },
  { name: '"all" 同义于 "*"', scopes: ["all"], id: "standard", want: true },
];
for (const c of cases) {
  const cfg = pp.wrapConfig({ scopedPresets: c.scopes, announce: false });
  eq(`A ${c.name}`, pp.inScope(cfg, c.id), c.want);
}

// ── B ScopeList 仍是真数组 ───────────────────────────────────────────
{
  const cfg = pp.wrapConfig({ scopedPresets: ["*", "!tavern-lite"], announce: false });
  const list = cfg.scopedPresets;
  check("B Array.isArray(scopedPresets)", Array.isArray(list));
  eq("B length", list.length, 2);
  eq("B join 用于状态显示", list.join(", "), "*, !tavern-lite");
  eq("B JSON 序列化", JSON.stringify({ scopedPresets: list }), '{"scopedPresets":["*","!tavern-lite"]}');
  check("B map 返回普通数组（不扩散匹配语义）", Object.getPrototypeOf(list.map((x) => x)) === Array.prototype);
  eq("B 展开运算符", [...list][0], "*");
  eq("B includes 走匹配", list.includes("standard"), true);
  eq("B includes 反向排除", list.includes("tavern-lite"), false);
  check("B 面向对象的原始值仍在（客户端显示用）", list.every((x) => typeof x === "string"));
}

// ── C 复刻上游三处判定 ──────────────────────────────────────────────
{
  const cfg = pp.wrapConfig({ enabled: true, scopedPresets: ["*"], announce: false });
  // 上游 enabledForAgent 的逻辑（lib/index.js）
  const enabledForAgent = (presetId) => {
    if (!cfg.enabled) return false;
    const scopes = Array.isArray(cfg.scopedPresets) ? cfg.scopedPresets : [];
    if (scopes.length === 0) return false;
    return scopes.includes(presetId);
  };
  // 上游 system-prompt/assemble hook 的条件
  const stripsBuiltins = (presetId) => cfg.scopedPresets.includes(presetId);

  eq("C enabledForAgent(standard)", enabledForAgent("standard"), true);
  eq("C enabledForAgent(preset-plus)", enabledForAgent("preset-plus"), true);
  eq("C enabledForAgent(undefined)", enabledForAgent(undefined), false);
  eq("C assemble hook 判定(standard)", stripsBuiltins("standard"), true);

  const offCfg = pp.wrapConfig({ enabled: false, scopedPresets: ["*"], announce: false });
  eq("C enabled=false 直接关闭", offCfg.enabled, false);
}

// ── D modeBindings ──────────────────────────────────────────────────
{
  const cfg = pp.wrapConfig({
    announce: false,
    modeBindings: { "tavern-lite": "roleplay", "*": "jailbreak" },
  });
  const core = {
    loadActiveEntries: () => ["ACTIVE"],
    loadMultiPreset: () => ({ presets: { roleplay: { entries: ["ROLEPLAY"] }, jailbreak: { entries: ["JB"] } } }),
  };
  eq("D tavern-lite 用绑定预设", pp.activeEntries(cfg, core, "tavern-lite")[0], "ROLEPLAY");
  eq("D 其余模式走 * 兜底绑定", pp.activeEntries(cfg, core, "standard")[0], "JB");
  eq("D 无兜底绑定时用激活预设", pp.activeEntries(pp.wrapConfig({ announce: false, modeBindings: { "tavern-lite": "roleplay" } }), core, "standard")[0], "ACTIVE");

  const broken = pp.wrapConfig({ announce: false, modeBindings: { "*": "does-not-exist" } });
  eq("D 绑定指向不存在的预设 → 回落激活预设", pp.activeEntries(broken, core, "standard")[0], "ACTIVE");
}

// ── E systemSectionText ─────────────────────────────────────────────
function fakeCtx(presetId) {
  return {
    get: (name) => (name === "agentPresets"
      ? { composedPreset: () => presetId }
      : undefined),
  };
}
const ENTRIES = [{ role: "system", text: "SYS", enabled: true }, { role: "user", text: "USER", enabled: true }];
const core = { loadActiveEntries: () => ENTRIES, loadMultiPreset: () => ({ presets: {} }) };
const contextWithAgent = { agent: { ctx: {} } };

{
  const wild = pp.wrapConfig({ scopedPresets: ["*"], announce: false });
  eq("E strict(默认) 全量作用域：standard 出场", pp.systemSectionText(wild, fakeCtx("standard"), core, contextWithAgent), "SYS");
  eq("E strict 全量作用域：模式未知也出场（因为含 *）", pp.systemSectionText(wild, fakeCtx(undefined), core, contextWithAgent), "SYS");

  const manual = pp.wrapConfig({ scopedPresets: ["preset-plus"], announce: false });
  eq("E strict 手动作用域：命中模式出场", pp.systemSectionText(manual, fakeCtx("preset-plus"), core, contextWithAgent), "SYS");
  eq("E strict 手动作用域：非命中模式不出场（修掉上游的 system 泄漏）", pp.systemSectionText(manual, fakeCtx("standard"), core, contextWithAgent), "");
  eq("E strict 手动作用域：模式未知不出场", pp.systemSectionText(manual, fakeCtx(undefined), core, contextWithAgent), "");

  const compat = pp.wrapConfig({ scopedPresets: ["preset-plus"], strictScope: false, announce: false });
  eq("E strictScope=false 复刻上游：任何模式都出场", pp.systemSectionText(compat, fakeCtx("standard"), core, contextWithAgent), "SYS");

  const noCtx = { get: () => undefined };
  eq("E agentPresets 缺失时不炸且不出场（strict）", pp.systemSectionText(manual, noCtx, core, contextWithAgent), "");

  const emptyHead = { loadActiveEntries: () => [{ role: "user", text: "U" }], loadMultiPreset: () => ({ presets: {} }) };
  eq("E 第一条不是 system → 空串", pp.systemSectionText(wild, fakeCtx("standard"), emptyHead, contextWithAgent), "");
}

// ── F hook 幂等 / 可重放 ────────────────────────────────────────────
{
  const current = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const noop = applyHooks(current);
  check("F 当前本体已是目标状态（无新改动）", noop.applied.length === 0, `applied=[${noop.applied}]`);
  check("F 当前本体 4 个 hook 齐全", noop.skipped.length === 4 && noop.failed.length === 0, `skipped=[${noop.skipped}] failed=[${noop.failed}]`);
  check("F 再过一遍逐字节不变（幂等 + EOL 保持）", noop.source === current, `长度 ${noop.source.length} vs ${current.length}`);

  const pristineArg = process.argv.indexOf("--pristine");
  if (pristineArg !== -1 && process.argv[pristineArg + 1] !== undefined) {
    const pristine = readFileSync(resolve(process.argv[pristineArg + 1]), "utf8");
    const round = applyHooks(pristine);
    check("F 从上游原文重放 4 个 hook", round.applied.length === 4 && round.failed.length === 0, `applied=[${round.applied}] failed=[${round.failed}]`);
    // 上游原文（git 对象，LF）→ 工作区文件（core.autocrlf=true，CRLF），比较时忽略 EOL。
    check("F 重放结果与当前 lib/index.js 一致（忽略 EOL）",
      round.source.replace(/\r\n/g, "\n") === current.replace(/\r\n/g, "\n"));
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`[self-test] ✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`[self-test] ✓ ${passed} 项全部通过`);
