#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  plusplus/apply-hooks.mjs
//
//  把 plusplus 增强层的 4 个 hook 幂等地打进本体 lib/index.js。
//
//  为什么需要它：fork 的唯一"本体改动"就是这 4 行，但上游每次更新都可能在
//  lib/index.js 同一区域有改动，git rebase / merge 时必然冲突。同步流程是：
//
//      git fetch upstream && git rebase upstream/main      # 冲突：lib/index.js
//      git checkout --theirs lib/index.js 2>/dev/null || :  # 接受上游版本（按需）
//      node plusplus/apply-hooks.mjs                        # 重新打上 hook ①-④
//      node plusplus/self-test.mjs                          # 自测
//
//  用法：
//      node plusplus/apply-hooks.mjs                    # 就地打 hook（默认 lib/index.js）
//      node plusplus/apply-hooks.mjs --check            # 只检查，缺 hook 退出码 1
//      node plusplus/apply-hooks.mjs --file <path>      # 指定本体文件
//      node plusplus/apply-hooks.mjs --transform <in> [out]
//                                                       # 不写回：把变换结果写到 out 或 stdout
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE = join(ROOT, "lib", "index.js");

const IMPORT_LINE = 'import * as plusplus from "./plusplus.js";';
const IMPORT_COMMENT = "// plusplus fork hook ①：增强层（作用域通配/排除、作用域感知 system 段、模式→预设绑定）";
const CFG_COMMENT = "// plusplus fork hook ②：包装 scopedPresets，使上游全部 includes 判定获得 `*` / 通配 / `!排除` 能力";
const SECTION_COMMENT = "// plusplus fork hook ③：作用域感知的 system 段（strictScope=false 时复刻上游全局常驻行为）";
const ENTRIES_COMMENT = "// plusplus fork hook ④：条目按「当前模式」解析（支持 modeBindings 模式→预设绑定）";

/** hook ①：导入增强层。 */
const HOOK_IMPORT = {
  id: "①import",
  applied: (source) => source.includes(IMPORT_LINE),
  transform: (source) => {
    const anchor = /^import \* as core from "\.\/core\.js";$/m;
    if (!anchor.test(source)) return undefined;
    return source.replace(anchor, (line) => `${line}\n${IMPORT_COMMENT}\n${IMPORT_LINE}`);
  },
};

/** hook ②：包装 cfg。 */
const HOOK_CFG = {
  id: "②wrapConfig",
  applied: (source) => /plusplus\.wrapConfig\(/.test(source),
  transform: (source) => {
    const anchor = /^([ \t]*)const cfg = \{ \.\.\.DEFAULTS, \.\.\.\(config \|\| \{\}\) \};$/m;
    if (!anchor.test(source)) return undefined;
    return source.replace(
      anchor,
      (_all, indent) => `${indent}${CFG_COMMENT}\n${indent}const cfg = plusplus.wrapConfig({ ...DEFAULTS, ...(config || {}) });`,
    );
  },
};

/** hook ③：system 段改为作用域感知。 */
const HOOK_SECTION = {
  id: "③systemSection",
  applied: (source) => /plusplus\.systemSectionText\(/.test(source),
  transform: (source) => {
    // 上游原文（容忍缩进/空白差异）：
    //   text: () => {
    //     const entries = core.loadActiveEntries();
    //     return entries.length > 0 && entries[0].role === "system" ? entries[0].text : "";
    //   },
    const anchor = /^([ \t]*)text: \(\) => \{\n[ \t]*const entries = core\.loadActiveEntries\(\);\n[ \t]*return entries\.length > 0 && entries\[0\]\.role === "system" \? entries\[0\]\.text : "";\n[ \t]*\},$/m;
    if (!anchor.test(source)) return undefined;
    return source.replace(
      anchor,
      (_all, indent) => `${indent}${SECTION_COMMENT}\n${indent}text: (context) => plusplus.systemSectionText(cfg, ctx, core, context),`,
    );
  },
};

/** hook ④：条目按模式解析（必须只剩 llm/stream 里那一处调用）。 */
const HOOK_ENTRIES = {
  id: "④entries",
  applied: (source) => /plusplus\.activeEntries\(/.test(source),
  transform: (source) => {
    const anchor = /^([ \t]*)const entries = core\.loadActiveEntries\(\);$/gm;
    const found = source.match(anchor);
    if (found === null || found.length !== 1) return undefined; // 0 处或 >1 处都不猜
    return source.replace(
      anchor,
      (_all, indent) => `${indent}${ENTRIES_COMMENT}\n${indent}const entries = plusplus.activeEntries(cfg, core, plusplus.modeOfSession(ctx, sessionId));`,
    );
  },
};

const HOOKS = [HOOK_IMPORT, HOOK_CFG, HOOK_SECTION, HOOK_ENTRIES];

/**
 * 幂等地把全部 hook 打进一段源码。
 *
 * 输入里的 CRLF 会先归一成 LF 再变换（本仓库在 Windows 上 core.autocrlf=true，
 * 工作区文件是 CRLF，而上游原文是 LF；多行锚点只按 LF 写），写完按原样还原，
 * 保证「已打好的文件再过一遍」逐字节不变。
 *
 * @param {string} source lib/index.js 原文
 * @returns {{source: string, applied: string[], skipped: string[], failed: string[], eol: string}}
 */
export function applyHooks(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let current = eol === "\n" ? source : source.replace(/\r\n/g, "\n");
  const applied = [];
  const skipped = [];
  const failed = [];
  for (const hook of HOOKS) {
    if (hook.applied(current)) {
      skipped.push(hook.id);
      continue;
    }
    const next = hook.transform(current);
    if (next === undefined) {
      failed.push(hook.id);
      continue;
    }
    current = next;
    applied.push(hook.id);
  }
  return { source: eol === "\n" ? current : current.replace(/\n/g, eol), applied, skipped, failed, eol };
}

function parseArgs(argv) {
  const args = { check: false, file: DEFAULT_FILE, transform: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--file") args.file = resolve(argv[++i] ?? "");
    else if (a === "--transform") {
      args.transform = resolve(argv[++i] ?? "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args.out = resolve(next); i++; }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.transform !== null) {
    const result = applyHooks(readFileSync(args.transform, "utf8"));
    if (args.out === null) process.stdout.write(result.source);
    else writeFileSync(args.out, result.source, "utf8");
    console.log(`[apply-hooks] 变换 ${args.transform}：applied=[${result.applied}] skipped=[${result.skipped}] failed=[${result.failed}]`);
    process.exit(result.failed.length === 0 ? 0 : 2);
  }

  const before = readFileSync(args.file, "utf8");
  const result = applyHooks(before);

  if (result.failed.length > 0) {
    console.error(`[apply-hooks] ✗ ${args.file} 里这些 hook 既没打上、也找不到可替换锚点：${result.failed.join(", ")}`);
    console.error("[apply-hooks] 上游可能改写了对应代码 —— 请手工对照 plusplus/README.md 的 4 个锚点处理。");
    process.exit(2);
  }
  if (args.check) {
    if (result.applied.length > 0) {
      console.error(`[apply-hooks] ✗ 缺少 hook：${result.applied.join(", ")}（运行 node plusplus/apply-hooks.mjs 补上）`);
      process.exit(1);
    }
    console.log(`[apply-hooks] ✓ 4 个 hook 均已就位（${args.file}）`);
    return;
  }
  if (result.applied.length === 0) {
    console.log(`[apply-hooks] ✓ 已是目标状态，无改动（${args.file}）`);
    return;
  }
  writeFileSync(args.file, result.source, "utf8");
  console.log(`[apply-hooks] ✓ 已写入 ${args.file}：applied=[${result.applied.join(", ")}]`);
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href) main();
