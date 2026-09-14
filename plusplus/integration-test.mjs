#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  plusplus/integration-test.mjs —— 本体集成自测（不启动 DSH）
//
//  直接用假的 cordis ctx 调 lib/index.js 的 apply()，验证打过 hook 之后的真实行为：
//    · system 段（hook ③）在各模式下的出场/不出场
//    · llm/stream fake 消息注入（hook ④ + ② 的作用域判定）
//    · system-prompt/assemble 的内置 section 过滤
//    · modeBindings：不同模式取到不同的预设条目
//
//  数据文件指向临时 DSH_HOME，不碰真实 ~/.dsh/preset-plus.json。
//
//  用法：node plusplus/integration-test.mjs
// ═══════════════════════════════════════════════════════════════════

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 插件之前设好 DSH_HOME（core.js 在调用时读 env，这里只是确保一致）
const home = mkdtempSync(join(tmpdir(), "pp-integration-"));
process.env.DSH_HOME = home;

const PRESET_DOC = {
  version: 1,
  activePresetId: "jailbreak",
  presets: {
    jailbreak: {
      id: "jailbreak",
      name: "破限预设",
      autoMode: true,
      entries: [
        { role: "system", text: "SYS:JAILBREAK", enabled: true },
        { role: "user", text: "USER:JAILBREAK", enabled: true },
        { role: "assistant", text: "ASSISTANT:JAILBREAK", enabled: true },
      ],
    },
    roleplay: {
      id: "roleplay",
      name: "角色预设",
      autoMode: true,
      entries: [
        { role: "system", text: "SYS:ROLEPLAY", enabled: true },
        { role: "user", text: "USER:ROLEPLAY", enabled: true },
      ],
    },
  },
};
writeFileSync(join(home, "preset-plus.json"), JSON.stringify(PRESET_DOC, null, 2), "utf8");

const { apply } = await import("../lib/index.js");

// 正常部署里 apply() 一个进程只跑一次；本测试要在同一进程里跑 5 组不同配置，
// 于是 apply() 里的 ensureAgentPresetMode() 会并发往同一个临时目录里 rm/cp 打架，
// 刷出一堆 EEXIST/EBUSY 警告。那是测试自身的产物，不是插件问题 —— 屏蔽掉。
const realWarn = console.warn;
console.warn = () => {};

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 造一个刚够用的 cordis ctx。 */
function makeCtx() {
  const state = {
    section: null,
    handlers: new Map(),
    streamed: null,
    streamCalls: 0,
  };
  const ctx = {
    state,
    systemPrompt: { section: (definition) => { state.section = definition; return () => {}; } },
    on: (event, handler) => { state.handlers.set(event, handler); return () => {}; },
    inject: () => {},
    get: (name) => (name === "agentPresets" ? state.agentPresets : undefined),
    agents: { get: (sessionId) => state.agent },
    llm: {
      stream: (options) => {
        state.streamCalls++;
        state.streamed = options;
        return Promise.resolve("stream-result");
      },
    },
    tools: undefined,
  };
  return ctx;
}

function wireScope(ctx, presetId) {
  ctx.state.agentPresets = { composedPreset: () => presetId };
  ctx.state.agent = { id: "session-test", ctx: {} };
}

// ── 场景 1：作用域 ["*"] + strictScope ──────────────────────────────
{
  const ctx = makeCtx();
  wireScope(ctx, "standard");
  apply(ctx, { enabled: true, scopedPresets: ["*"], strictScope: true, verbose: false, announce: false });

  check("1 system 段已注册", ctx.state.section !== null && ctx.state.section.name === "preset-plus");
  check("1 system 段 text 是可调用函数（hook ③）", typeof ctx.state.section.text === "function");

  const textOf = (presetId) => {
    wireScope(ctx, presetId);
    return ctx.state.section.text({ agent: ctx.state.agent });
  };
  eq("1 standard 模式的 system 段（含 * → 出场）", textOf("standard"), "SYS:JAILBREAK");
  eq("1 preset-plus 模式同样出场", textOf("preset-plus"), "SYS:JAILBREAK");
  eq("1 未挂预设(undefined) 也出场（作用域含 *）", textOf(undefined), "SYS:JAILBREAK");

  // fake 消息注入（llm/stream）
  const stream = ctx.state.handlers.get("llm/stream");
  check("1 llm/stream handler 已注册", typeof stream === "function");
  let nextCalled = false;
  wireScope(ctx, "standard");
  stream({ sessionId: "session-test", provider: "p", model: "m", messages: [{ id: "real-1", role: "user", content: [{ type: "text", text: "hi" }] }] }, () => { nextCalled = true; return Promise.resolve("next"); });
  check("1 命中作用域时不走 next()", nextCalled === false);
  eq("1 注入请求已提交到 llm.stream", ctx.state.streamCalls, 1);
  const injected = ctx.state.streamed.messages;
  eq("1 前置 fake 消息数量（user+assistant）", injected.length, 3);
  eq("1 第 1 条是 fake user", injected[0].content[0].text, "USER:JAILBREAK");
  eq("1 第 2 条是 fake assistant", injected[1].content[0].text, "ASSISTANT:JAILBREAK");
  eq("1 真实消息保持在末尾", injected[2].id, "real-1");
  eq("1 purpose 非主请求不注入", (() => {
    const callsBefore = ctx.state.streamCalls;
    let n = false;
    stream({ sessionId: "session-test", purpose: "title", messages: [] }, () => { n = true; return Promise.resolve(); });
    return n && ctx.state.streamCalls === callsBefore;
  })(), true);

  // 内置 section 过滤：* 之下所有模式都过滤
  const assemble = ctx.state.handlers.get("system-prompt/assemble");
  const assembly = {
    sections: [
      { name: "harness:identity", text: "x" },
      { name: "harness:source", text: "x" },
      { name: "app:web-surface", text: "x" },
      { name: "preset-plus", text: "SYS:JAILBREAK" },
      { name: "tool:read", text: "x" },
    ],
  };
  wireScope(ctx, "standard");
  assemble(assembly, { agent: ctx.state.agent }, () => Promise.resolve());
  eq("1 standard 模式下内置 section 被过滤（*）", assembly.sections.map((s) => s.name).join(","), "preset-plus,tool:read");
}

// ── 场景 2：上游式作用域（只 preset-plus）+ strictScope ─────────────
{
  const ctx = makeCtx();
  wireScope(ctx, "standard");
  apply(ctx, { enabled: true, scopedPresets: ["preset-plus"], strictScope: true, announce: false });

  const textOf = (presetId) => {
    wireScope(ctx, presetId);
    return ctx.state.section.text({ agent: ctx.state.agent });
  };
  eq("2 preset-plus 模式出场", textOf("preset-plus"), "SYS:JAILBREAK");
  eq("2 standard 模式不出场（修掉上游的 system 泄漏）", textOf("standard"), "");
  eq("2 模式未知不出场", textOf(undefined), "");

  const stream = ctx.state.handlers.get("llm/stream");
  let nextCalled = false;
  wireScope(ctx, "standard");
  stream({ sessionId: "session-test", messages: [{ id: "real-1", role: "user", content: [] }] }, () => { nextCalled = true; return Promise.resolve("next"); });
  check("2 非作用域模式直接 next()", nextCalled === true);
  eq("2 未提交注入请求", ctx.state.streamCalls, 0);

  wireScope(ctx, "preset-plus");
  stream({ sessionId: "session-test", messages: [{ id: "real-2", role: "user", content: [] }] }, () => Promise.resolve("next"));
  eq("2 命中模式时注入", ctx.state.streamCalls, 1);

  const assemble = ctx.state.handlers.get("system-prompt/assemble");
  const assembly = { sections: [{ name: "harness:identity", text: "x" }, { name: "tool:read", text: "x" }] };
  wireScope(ctx, "standard");
  assemble(assembly, { agent: ctx.state.agent }, () => Promise.resolve());
  eq("2 非作用域模式保留内置 section", assembly.sections.map((s) => s.name).join(","), "harness:identity,tool:read");

  // strictScope=false → 复刻上游：任何模式都出场
  const compatCtx = makeCtx();
  wireScope(compatCtx, "standard");
  apply(compatCtx, { enabled: true, scopedPresets: ["preset-plus"], strictScope: false, announce: false });
  eq("2 strictScope=false 复刻上游全局常驻", compatCtx.state.section.text({ agent: compatCtx.state.agent }), "SYS:JAILBREAK");
}

// ── 场景 3：modeBindings 模式→预设 ─────────────────────────────────
{
  const ctx = makeCtx();
  wireScope(ctx, "tavern-lite");
  apply(ctx, {
    enabled: true,
    scopedPresets: "*",
    strictScope: true,
    announce: false,
    modeBindings: { "tavern-lite": "roleplay", "*": "jailbreak" },
  });

  const sectionOf = (presetId) => {
    wireScope(ctx, presetId);
    return ctx.state.section.text({ agent: ctx.state.agent });
  };
  eq("3 tavern-lite 用绑定预设 roleplay", sectionOf("tavern-lite"), "SYS:ROLEPLAY");
  eq("3 standard 走 * 兜底绑定", sectionOf("standard"), "SYS:JAILBREAK");

  const stream = ctx.state.handlers.get("llm/stream");
  wireScope(ctx, "tavern-lite");
  stream({ sessionId: "session-test", messages: [] }, () => Promise.resolve());
  const injected = ctx.state.streamed.messages;
  eq("3 fake user 来自 roleplay 预设", injected[0].content[0].text, "USER:ROLEPLAY");
  eq("3 roleplay 无 assistant 条目 → 只注入 1 条", injected.length, 1);

  // 排除写法：酒馆不注入
  const excl = makeCtx();
  wireScope(excl, "tavern-lite");
  apply(excl, { enabled: true, scopedPresets: ["*", "!tavern-lite"], strictScope: true, announce: false });
  eq("3 反向排除的模式不出场", excl.state.section.text({ agent: excl.state.agent }), "");
  check("3 反向排除的模式已就位", excl.state.section !== null);
}

// ── 场景 4：空作用域 = 关闭 ────────────────────────────────────────
{
  const ctx = makeCtx();
  wireScope(ctx, "preset-plus");
  apply(ctx, { enabled: true, scopedPresets: [], strictScope: true, announce: false });
  eq("4 空作用域 system 段不出场", ctx.state.section.text({ agent: ctx.state.agent }), "");
  let nextCalled = false;
  ctx.state.handlers.get("llm/stream")({ sessionId: "session-test", messages: [] }, () => { nextCalled = true; return Promise.resolve(); });
  check("4 空作用域不注入", nextCalled === true);
}

// apply() 里的 ensureAgentPresetMode() 是异步复制的，等它落定再清理临时 DSH_HOME
// （清理纯属卫生工作，失败不影响结论 —— Windows 上可能瞬时占用）。
await new Promise((resolve) => setTimeout(resolve, 300));
for (let attempt = 0; attempt < 3; attempt++) {
  try { rmSync(home, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
console.warn = realWarn;

if (failures.length > 0) {
  console.error(`[integration-test] ✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`[integration-test] ✓ ${passed} 项全部通过`);
