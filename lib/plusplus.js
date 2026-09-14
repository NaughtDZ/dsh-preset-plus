// ═══════════════════════════════════════════════════════════════════
//  dsh-preset-plus-plus —— fork 增强层（本文件为 fork 新增文件）
//
//  上游的能力边界：
//    注入门禁 = `cfg.scopedPresets.includes(current)`（精确字符串匹配），
//    默认 ["preset-plus"]，即「只有挂在该模式下的会话才注入」。想在所有 DSH
//    模式下都注入（不管用户当前选的是 standard / tavern-lite / 自己建的任意
//    模式），就必须改本体里那三处 includes 判定。
//
//  本文件把这套判定整体接管，做到：
//    1. 作用域匹配支持 全量 * / 通配 preset-* / 反向排除 !minimal，可手写白名单
//       也可以自动「全都要」；
//    2. 作用域感知的 system 段：strictScope=true 时，system 主提示词只在命中
//       作用域的模式下出场（上游的 system 段是全局 section，任何模式都会带上，
//       即使 README 写着「其他模式一律不注入」——这点在下面 systemSectionText
//       的注释里有完整说明）；
//    3. 可选 模式→预设 绑定：不同 DSH 模式挂不同预设（例如 tavern-lite 用角色
//       预设、standard 用破限预设），而不必来回切 activePresetId。
//
//  与上游的接触面只有 4 处、每处一行（见 plusplus/apply-hooks.mjs）：
//    ① import * as plusplus from "./plusplus.js";
//    ② const cfg = plusplus.wrapConfig({ ...DEFAULTS, ...(config || {}) });
//    ③ systemPrompt.section 的 text → plusplus.systemSectionText(cfg, ctx, core, context)
//    ④ llm/stream 里的 entries → plusplus.activeEntries(cfg, core, plusplus.modeOfSession(ctx, sessionId))
//  上游同步时冲突只可能发生在这 4 行，且都能用 `node plusplus/apply-hooks.mjs` 一键重放。
//
//  配置语法（cordis.patch.yml → config.scopedPresets，数组或逗号分隔字符串）：
//    ["*"]                        → 所有模式（自动全量注入）
//    ["standard", "tavern-lite"]  → 手动白名单
//    ["preset-*"]                 → 通配（* 任意长度、? 单字符）
//    ["*", "!tavern-lite"]        → 全量 + 反向排除
//    ["!tavern-lite"]             → 只有反向项时 = 除它以外全部
//    ["all"] / ["any"]            → "*" 的同义词
//    []                           → 关闭注入（与上游一致）
//
//  其它可选配置：
//    strictScope:  true|false  （默认 true）system 段是否按作用域出场；
//                               false = 完全复刻上游「system 段全局常驻」行为
//    modeBindings: { "tavern-lite": "roleplay", "*": "jailbreak" }
//                               模式 → 预设 id（该模式用哪套预设），"*" 为兜底；
//                               未列出的模式仍用设置页里激活的预设
//    verbose:      true|false  打印作用域判定过程
// ═══════════════════════════════════════════════════════════════════

/** fork 增强层版本（与上游 package.json version 无关，单独走自己的号）。 */
export const VERSION = "0.1.0";

/** 表示「所有模式」的记号。 */
const ALL_TOKENS = new Set(["*", "all", "any"]);

/** 含通配符的记号。 */
const GLOB_CHARS = /[*?]/;

/** 模式 id → 匹配器。挂在 wrapConfig 生成的 ScopeList 实例上，避免污染 cfg。 */
const MATCHERS = new WeakMap();

let announced = false;

/** 转义正则元字符。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把一个 glob 记号编译成正则（`*` 任意长度、`?` 单字符）。 */
function compileGlob(pattern) {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += escapeRegExp(ch);
  }
  return new RegExp(source + "$");
}

/** 把配置里的原始值统一成字符串数组：数组原样，逗号分隔的字符串切分。 */
export function normalizeScopeInput(input) {
  if (Array.isArray(input)) return input.map((x) => String(x ?? "")).filter((x) => x.trim() !== "");
  if (typeof input === "string") {
    return input
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }
  return [];
}

/**
 * 解析一条作用域记号。
 * @param {string} raw 原始记号，可带前导 `!` 表示反向。
 * @returns {{raw: string, negate: boolean, kind: "all"|"glob"|"exact", value?: string, test?: RegExp}|null}
 */
function parseScopeEntry(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  const negate = text.startsWith("!");
  const body = (negate ? text.slice(1) : text).trim();
  if (body === "") return null;
  if (ALL_TOKENS.has(body.toLowerCase())) return { raw: text, negate, kind: "all" };
  if (GLOB_CHARS.test(body)) return { raw: text, negate, kind: "glob", test: compileGlob(body) };
  return { raw: text, negate, kind: "exact", value: body };
}

function entryMatches(entry, presetId) {
  if (entry.kind === "all") return true;
  if (entry.kind === "glob") return entry.test.test(presetId);
  return entry.value === presetId;
}

/**
 * 建一个作用域匹配器。
 *
 * 语义：命中 =（正向命中 或 没有正向项 且 非空配置）且 未被任何反向项命中。
 * 因此 `["!x"]` 等价于「除 x 以外全部」，`[]` 等价于关闭。
 *
 * @param {unknown} input cfg.scopedPresets 原始值
 * @returns {{raw: string[], entries: object[], isAll: boolean, match(id: unknown): boolean, describe(): string}}
 */
export function createScopeMatcher(input) {
  const raw = normalizeScopeInput(input);
  const entries = raw.map(parseScopeEntry).filter((e) => e !== null);
  const positives = entries.filter((e) => !e.negate);
  const negatives = entries.filter((e) => e.negate);
  const matcher = {
    raw,
    entries,
    /** 是否「所有模式」——用于无法判定模式 id 时的兜底决策。 */
    isAll: positives.some((e) => e.kind === "all"),
    /**
     * 判断某个模式 id 是否命中作用域。
     * @param {unknown} presetId agentPresets.composedPreset() 的结果
     * @returns {boolean} 未挂任何预设（undefined）时一律不命中
     */
    match(presetId) {
      if (typeof presetId !== "string" || presetId === "") return false;
      if (entries.length === 0) return false;
      const positive = positives.length === 0 ? true : positives.some((e) => entryMatches(e, presetId));
      if (!positive) return false;
      return !negatives.some((e) => entryMatches(e, presetId));
    },
    /** 人类可读描述，给状态命令/接口用。 */
    describe() {
      if (entries.length === 0) return "(空=关闭)";
      return entries.map((e) => e.raw).join(", ");
    },
  };
  return matcher;
}

/**
 * 带匹配语义的「数组」：实例仍是真数组（`Array.isArray` 为 true、可 join /
 * JSON 序列化），只是 `includes()` 走作用域匹配。
 *
 * 这一点是刻意的：上游判定写成 `scopes.includes(current)`，本体不要为此重写；
 * 只要把 scopedPresets 换成这个列表，那三处 includes 立刻获得通配/排除能力。
 */
class ScopeList extends Array {
  /** map/filter/slice 等返回普通数组，避免匹配语义意外扩散。 */
  static get [Symbol.species]() {
    return Array;
  }

  constructor(raw, matcher) {
    super();
    for (const item of raw) this.push(item);
    MATCHERS.set(this, matcher);
    Object.defineProperty(this, "includes", {
      value: (presetId) => matcher.match(presetId),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

/**
 * 取出 cfg 对应的匹配器：wrapConfig 生成的列表直接复用，否则按原始值临时构造
 * （例如调用方忘了 wrapConfig，判定依然正确）。
 * @param {object|undefined|null} cfg 插件配置
 * @returns {ReturnType<typeof createScopeMatcher>}
 */
export function matcherFor(cfg) {
  const list = cfg?.scopedPresets;
  const cached = list instanceof ScopeList ? MATCHERS.get(list) : undefined;
  return cached ?? createScopeMatcher(list);
}

/**
 * 某个模式是否在注入作用域内（作用域判定唯一入口）。
 * @param {object|undefined|null} cfg 插件配置
 * @param {unknown} presetId 模式 id
 * @returns {boolean}
 */
export function inScope(cfg, presetId) {
  return matcherFor(cfg).match(presetId);
}

/**
 * 包装本体 cfg：把 scopedPresets 换成作用域列表，并顺手打印一次 fork 横幅。
 * 本体只需把 `const cfg = { ...DEFAULTS, ...(config || {}) };` 换成
 * `const cfg = plusplus.wrapConfig({ ...DEFAULTS, ...(config || {}) });`。
 * @param {object|undefined|null} cfg 原始配置
 * @returns {object} 包装后的配置（浅拷贝，原对象不被改动）
 */
export function wrapConfig(cfg) {
  const base = cfg && typeof cfg === "object" ? cfg : {};
  const matcher = createScopeMatcher(base.scopedPresets);
  const wrapped = { ...base, scopedPresets: new ScopeList(matcher.raw, matcher) };
  if (!announced && base.announce !== false) {
    announced = true;
    const bindings = modeBindings(wrapped);
    const bindingText = Object.keys(bindings).length === 0 ? "无" : JSON.stringify(bindings);
    console.log(
      `[preset-plus++] v${VERSION} 作用域=${matcher.describe()}`
      + ` strictScope=${strictScope(wrapped) ? "on" : "off"}`
      + ` 绑定=${bindingText}`,
    );
  }
  return wrapped;
}

/** strictScope：system 段是否按作用域出场（默认 true；false = 复刻上游全局常驻）。 */
export function strictScope(cfg) {
  const value = cfg?.strictScope ?? cfg?.plusplus?.strictScope;
  return value !== false;
}

/** 模式 → 预设 绑定表（可选）。 */
export function modeBindings(cfg) {
  const table = cfg?.modeBindings ?? cfg?.plusplus?.modeBindings;
  return table && typeof table === "object" && !Array.isArray(table) ? table : {};
}

/** 当前模式 id：从会话 id 反查 Agent → agentPresets.composedPreset。 */
export function modeOfSession(ctx, sessionId) {
  try {
    const agentPresets = ctx?.get?.("agentPresets");
    if (!agentPresets) return undefined;
    const agent = ctx?.agents?.get?.(sessionId);
    if (agent === undefined) return undefined;
    return agentPresets.composedPreset(agent.ctx);
  } catch {
    return undefined;
  }
}

/** 当前模式 id：从 system-prompt 的组装上下文取（context.agent 由 dsh-agent 注入）。 */
export function modeOfContext(ctx, context) {
  try {
    const agent = context?.agent;
    if (agent === undefined) return undefined;
    const agentPresets = ctx?.get?.("agentPresets");
    if (!agentPresets) return undefined;
    return agentPresets.composedPreset(agent.ctx);
  } catch {
    return undefined;
  }
}

/**
 * 该模式下该用哪套预设的条目。
 *
 * 优先 modeBindings[modeId]（找不到则 modeBindings["*"]），其次设置页里激活的
 * 预设。绑定指向不存在的预设时静默回落到激活预设，避免配置写错就完全不注入。
 *
 * @param {object} cfg 插件配置
 * @param {{loadMultiPreset: Function, loadActiveEntries: Function}} core core.js 模块
 * @param {unknown} modeId 当前模式 id
 * @returns {Array} 预设条目
 */
export function activeEntries(cfg, core, modeId) {
  const bindings = modeBindings(cfg);
  const wanted = typeof modeId === "string" && modeId !== ""
    ? (bindings[modeId] ?? bindings["*"])
    : undefined;
  if (typeof wanted === "string" && wanted.trim() !== "") {
    try {
      const preset = core.loadMultiPreset().presets[wanted.trim()];
      if (preset && Array.isArray(preset.entries) && preset.entries.length > 0) return preset.entries;
    } catch {
      // 绑定解析失败 → 回落激活预设
    }
  }
  return core.loadActiveEntries();
}

/**
 * system 段文本（本体 hook ③）。
 *
 * 背景：上游把 system 段注册成**全局** section（`ctx.systemPrompt.section(...)`，
 * 而不是挂在某个 agent 的 scope 上），而 harness 组装时全局 section 会合进每一个
 * scope（dsh-system-prompt `ScopedLayers.merge`：先铺全局、再由 scoped 同名覆盖）。
 * 所以上游 README 写的「其他模式一律不进行任何注入」对 system 段并不成立 —— 只要
 * 有激活预设，任何模式的会话都会带上它的 system 主提示词。作用域门禁实际只挡住了
 * fake user/assistant 消息与内置 section 的移除。
 *
 * 本函数按配置接管这段判定：
 *   strictScope=false → 复刻上游行为（有 system 条目就出场，不看模式）
 *   strictScope=true  → 只有在作用域内的模式下才出场
 *   模式 id 无法判定（诊断/裸 agent 组装） → 只在作用域含 `*` 时出场
 *
 * @param {object} cfg 插件配置
 * @param {object} ctx 插件上下文
 * @param {object} core core.js 模块
 * @param {{agent?: object}|undefined} context 组装上下文
 * @returns {string} 该出场就返回 system 主提示词，否则空串
 */
export function systemSectionText(cfg, ctx, core, context) {
  const modeId = modeOfContext(ctx, context);
  const entries = activeEntries(cfg, core, modeId);
  const head = entries.length > 0 && entries[0]?.role === "system" && typeof entries[0].text === "string"
    ? entries[0].text
    : "";
  if (head === "") return "";
  if (!strictScope(cfg)) return head;
  const allowed = modeId === undefined ? matcherFor(cfg).isAll : matcherFor(cfg).match(modeId);
  if (cfg?.verbose) {
    console.log(`[preset-plus++] system 段 mode=${modeId ?? "(未知)"} 注入=${allowed ? "是" : "否"}`);
  }
  return allowed ? head : "";
}
