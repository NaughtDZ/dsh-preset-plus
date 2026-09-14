#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  plusplus/sync-upstream.mjs —— 一条命令同步上游
//
//  它把「上游更新 → 合到 fork」这件事固化成可重放的流程，省掉凭记忆复现：
//    1. 检查工作区干净、在 plusplus 分支上、upstream 远端存在
//    2. git fetch upstream，报告上游新提交，并预测哪些文件会冲突
//    3. --rebase：git rebase upstream/main
//       冲突只发生在 lib/index.js（我们 4 个 hook 所在的文件）时，自动改取上游版本，
//       并在**动手之前**先用 applyHooks 在内存里验证 4 个 hook 还打得上去：
//         能打上 → 自动重放即可放心继续；
//         打不上（上游改写了锚点附近代码）→ 直接 git rebase --abort 回到同步前，
//                                          报出是哪个 hook 失败，交给人适配正则。
//    4. 跑 hook 校验 + 两套自测；任一失败则不推送，并提示 git reset --hard ORIG_HEAD 撤销
//    5. --push：git push --force-with-lease（rebase 后必须 force；lease 保证不会覆盖意外提交）
//
//  用法：
//    node plusplus/sync-upstream.mjs                                   # 演练（只看不动）
//    node plusplus/sync-upstream.mjs --rebase                          # 真同步，不推送
//    node plusplus/sync-upstream.mjs --rebase --push                   # 用系统的 git 凭据推送
//    node plusplus/sync-upstream.mjs --rebase --push --token-file <路径>  # 用文件里的 token 推送
//                                                                      # （token 走环境变量传给 git，
//                                                                      #   不出现在命令行/配置/文件里）
//  环境变量：
//    PP_GH_TOKEN / GITHUB_TOKEN —— 直接提供 token，等价于 --token-file
//  其它参数：--branch <名>（默认 plusplus）、--upstream <remote>（默认 upstream）、--remote <名>（默认 origin）
// ═══════════════════════════════════════════════════════════════════

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHooks } from "./apply-hooks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 只有这个文件的冲突可以自动解决（重放 hook 即可恢复我们的改动）。 */
const HOOK_FILE = "lib/index.js";
const MAX_RESOLVE_ROUNDS = 20;

let secret = "";

function mask(text) {
  if (secret === "") return text;
  return String(text).split(secret).join("***");
}

function raw(args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_EDITOR: "true", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  });
}

function git(...args) {
  return raw(args).trim();
}

/** 跑一条 git 命令，失败时带上 stdout/stderr 而不是抛裸错误。 */
function gitTry(...args) {
  try {
    return { ok: true, out: raw(args).trim(), err: "" };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      out: mask(String(error.stdout ?? "").trim()),
      err: mask(String(error.stderr ?? "").trim()),
    };
  }
}

/** 跑一个子进程（自测脚本），返回是否成功。 */
function nodeRun(scriptArgs) {
  try {
    const out = execFileSync(process.execPath, scriptArgs, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(out);
    return true;
  } catch (error) {
    process.stdout.write(mask(String(error.stdout ?? "")));
    process.stderr.write(mask(String(error.stderr ?? "")));
    return false;
  }
}

function parseArgs(argv) {
  const args = { rebase: false, push: false, branch: "plusplus", upstream: "upstream", remote: "origin", tokenFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rebase") args.rebase = true;
    else if (a === "--push") args.push = true;
    else if (a === "--branch") args.branch = argv[++i] ?? args.branch;
    else if (a === "--upstream") args.upstream = argv[++i] ?? args.upstream;
    else if (a === "--remote") args.remote = argv[++i] ?? args.remote;
    else if (a === "--token-file") args.tokenFile = argv[++i] ?? null;
    else if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
    else { console.error(`[sync] 不认识的参数: ${a}`); console.error(HELP); process.exit(2); }
  }
  return args;
}

const HELP = "用法见 plusplus/sync-upstream.mjs 头部注释（--rebase / --push / --token-file / --branch / --upstream / --remote）";

function die(code, ...lines) {
  for (const line of lines) console.error(mask(line));
  process.exit(code);
}

// ── 准备 ────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

if (args.tokenFile !== null) {
  try {
    secret = readFileSync(args.tokenFile, "utf8").trim();
  } catch (error) {
    die(2, `[sync] 读不了 token 文件 ${args.tokenFile}: ${error.message}`);
  }
} else {
  secret = (process.env.PP_GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
}
if (args.push && secret === "" && process.env.PP_ALLOW_INTERACTIVE_CRED !== "1") {
  console.log("[sync] 未提供 token（--token-file / PP_GH_TOKEN），推送将依赖系统 git 凭据（可能会弹窗）。");
  console.log("       想用文件里的 token：加 --token-file <路径>；想跳过这条提示：设 PP_ALLOW_INTERACTIVE_CRED=1。");
}

const dirty = git("status", "--porcelain");
if (dirty !== "") {
  die(2, "[sync] 工作区不干净，先提交或 stash：", dirty);
}

const branchNow = git("rev-parse", "--abbrev-ref", "HEAD");
if (branchNow !== args.branch) {
  die(2, `[sync] 当前在 ${branchNow}，请在 ${args.branch} 分支上跑： git checkout ${args.branch}`);
}

const upstreamUrl = gitTry("remote", "get-url", args.upstream);
if (!upstreamUrl.ok) {
  die(2, `[sync] 没有 ${args.upstream} 远端。加上它再重跑：`,
    `       git remote add ${args.upstream} https://github.com/Rain-kl/dsh-preset-plus.git`);
}

console.log(`[sync] 仓库 ${ROOT}`);
console.log(`[sync] 分支 ${branchNow} | upstream=${args.upstream} (${upstreamUrl.out}) | remote=${args.remote}`);

// ── 取上游 ──────────────────────────────────────────────────────────
console.log("[sync] git fetch upstream …");
const fetched = gitTry("fetch", args.upstream, "--prune");
if (!fetched.ok) die(2, "[sync] fetch 失败：", fetched.err || fetched.out);

const behind = Number(git("rev-list", "--count", `HEAD..${args.upstream}/main`));
const ahead = Number(git("rev-list", "--count", `${args.upstream}/main..HEAD`));

// 本地 main 保持上游镜像（快进即可，不动工作区）
if (gitTry("rev-parse", "--verify", "main").ok) {
  const ff = gitTry("fetch", args.upstream, "main:main");
  if (ff.ok) console.log("[sync] 已把本地 main 快进到上游镜像");
  else if (ff.err !== "") console.log(`[sync] 本地 main 未快进（非致命）：${ff.err.split("\n")[0]}`);
}

if (behind === 0) {
  console.log(`[sync] ✓ upstream 没有新提交（本地 ${branchNow} 领先 ${ahead} 个提交）——无需同步。`);
  process.exit(0);
}

console.log(`[sync] 上游新增 ${behind} 个提交（本地 ${branchNow} 领先 ${ahead} 个）：`);
console.log(git("log", "--oneline", "--no-decorate", `HEAD..${args.upstream}/main`).split("\n").map((l) => "       " + l).join("\n"));

// 预测会冲突的文件：上游改的文件 ∩ 我们改的文件
const base = git("merge-base", "HEAD", `${args.upstream}/main`);
const upstreamTouched = new Set(git("diff", "--name-only", `${base}..${args.upstream}/main`).split("\n").filter(Boolean));
const oursTouched = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
const likely = oursTouched.filter((f) => upstreamTouched.has(f));
console.log(`[sync] 我们改过的文件：${oursTouched.join(", ") || "(无)"}`);
console.log(`[sync] 预计会冲突：${likely.join(", ") || "(无)"}`);

if (likely.length > 0 && !likely.every((f) => f === HOOK_FILE)) {
  console.log(`[sync] 注意：预计冲突包含非 ${HOOK_FILE} 的文件，脚本只会自动处理 ${HOOK_FILE}，其余会 abort 交给人处理。`);
}

if (!args.rebase) {
  console.log("[sync] 演练结束（未改动工作区）。要执行： node plusplus/sync-upstream.mjs --rebase");
  process.exit(0);
}

// ── rebase ─────────────────────────────────────────────────────────
console.log(`[sync] git rebase ${args.upstream}/main …`);
let rebase = gitTry("rebase", `${args.upstream}/main`);

for (let round = 0; !rebase.ok && round < MAX_RESOLVE_ROUNDS; round++) {
  const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  if (conflicted.length === 0) {
    die(3, "[sync] rebase 失败但没有冲突文件，交给人处理：", rebase.err || rebase.out,
      "[sync] 撤销： git rebase --abort");
  }
  if (!(conflicted.length === 1 && conflicted[0] === HOOK_FILE)) {
    gitTry("rebase", "--abort");
    die(3, `[sync] 冲突文件：${conflicted.join(", ")}`,
      `[sync] 只有 ${HOOK_FILE} 能自动解决（重放 hook）。已 git rebase --abort，仓库回到同步前状态。`,
      "[sync] 人工处理建议： git rebase upstream/main 后逐个解决，再跑 node plusplus/apply-hooks.mjs");
  }

  // 先验证「取上游版本 + 重放 hook」这条路走得通，再动工作区
  const upstreamSide = gitTry("show", `:2:${HOOK_FILE}`);
  if (!upstreamSide.ok) die(3, `[sync] 取不到 ${HOOK_FILE} 的上游侧内容：`, upstreamSide.err, "[sync] 撤销： git rebase --abort");

  const probe = applyHooks(upstreamSide.out);
  if (probe.failed.length > 0) {
    gitTry("rebase", "--abort");
    die(3, `[sync] 上游改写了 ${HOOK_FILE} 里 hook 锚点所在的代码：${probe.failed.join(", ")} 打不上去。`,
      "[sync] 已 git rebase --abort，仓库回到同步前状态（没有任何半成品）。",
      "[sync] 人工处理：手工把这 4 处 hook 打到新的 " + HOOK_FILE + " 上，",
      "       并同步更新 plusplus/apply-hooks.mjs 里对应的锚点正则，然后在 plusplus/README.md 记一笔。");
  }

  console.log(`[sync] 冲突（第 ${round + 1} 轮）只在 ${HOOK_FILE}：用「上游版本 + 重放 hook」作为解决结果`);
  // 关键：把重放后的内容**直接写成冲突解决**，而不是先取上游版本、事后再打 hook ——
  // 后者会让 rebase 提交里存的是「没有 hook 的上游版本」，hook 变成未提交改动（曾因此拒绝推送）。
  const target = join(ROOT, HOOK_FILE);
  const eol = readFileSync(target, "utf8").includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(target, eol === "\n" ? probe.source : probe.source.replace(/\n/g, "\r\n"), "utf8");
  const staged = gitTry("add", "--", HOOK_FILE);
  if (!staged.ok) die(3, `[sync] git add ${HOOK_FILE} 失败：${staged.err}`, "[sync] 撤销： git rebase --abort");
  rebase = gitTry("-c", "core.editor=true", "rebase", "--continue");
}

if (!rebase.ok) {
  die(3, `[sync] rebase 未完成（超过 ${MAX_RESOLVE_ROUNDS} 轮或其它原因）：`, rebase.err || rebase.out,
    "[sync] 撤销： git rebase --abort");
}

// ── 收尾：重放 hook + 自测 ────────────────────────────────────────────
console.log("[sync] 重放 hook 并自测 …");
const applied = gitTry("status", "--porcelain");
if (applied.out !== "") console.log(`[sync] rebase 后工作区有未提交改动：\n${applied.out}`);

if (!nodeRun([join(ROOT, "plusplus", "apply-hooks.mjs")])) {
  die(4, "[sync] apply-hooks 失败。未推送。",
    "[sync] 撤销本次 rebase： git reset --hard ORIG_HEAD");
}
if (!nodeRun([join(ROOT, "plusplus", "apply-hooks.mjs"), "--check"])) {
  die(4, "[sync] hook 校验未通过。未推送。", "[sync] 撤销本次 rebase： git reset --hard ORIG_HEAD");
}
if (!nodeRun([join(ROOT, "plusplus", "self-test.mjs")]) || !nodeRun([join(ROOT, "plusplus", "integration-test.mjs")])) {
  die(4, "[sync] 自测未通过。未推送，请先修。", "[sync] 撤销本次 rebase： git reset --hard ORIG_HEAD");
}

const after = gitTry("status", "--porcelain");
if (after.out !== "") {
  die(4, "[sync] 自测通过但工作区仍有未提交改动。未推送。", after.out,
    `[sync] 若确认这些改动就是 hook（说明 rebase 提交里存的是上游版本），把它们并进最新提交再推：`,
    `       git add ${HOOK_FILE} && git commit --amend --no-edit && git push --force-with-lease ${args.remote} ${args.branch}:${args.branch}`,
    "[sync] 或整体撤销本次 rebase： git reset --hard ORIG_HEAD");
}

console.log(`[sync] ✓ rebase + 自测全部通过（HEAD = ${git("rev-parse", "--short", "HEAD")}）`);

// ── 推送 ───────────────────────────────────────────────────────────
if (!args.push) {
  console.log(`[sync] 未推送（加 --push）。推送命令： git push --force-with-lease ${args.remote} ${args.branch}:${args.branch}`);
  process.exit(0);
}

console.log(`[sync] git fetch ${args.remote} ${args.branch}（刷新 --force-with-lease 的基线）…`);
gitTry("fetch", args.remote, args.branch);

console.log(`[sync] git push --force-with-lease ${args.remote} ${args.branch}:${args.branch} …`);
const helper = '!f() { test "$1" = get && echo username=x-access-token && echo password=$PP_GH_TOKEN; }; f';
const pushArgs = secret === ""
  ? ["push", "--force-with-lease", args.remote, `${args.branch}:${args.branch}`]
  : ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "--force-with-lease", args.remote, `${args.branch}:${args.branch}`];
const pushed = gitTry(...pushArgs);
if (!pushed.ok) {
  die(5, "[sync] 推送失败：", pushed.err || pushed.out,
    "[sync] 本地已完成 rebase 与自测；只差推送。常见原因：token 失效/权限不足，或远端被别人更新（lease 保护）。",
    `[sync] 之后单独推送： git push --force-with-lease ${args.remote} ${args.branch}:${args.branch}`);
}

console.log(mask(String(pushed.err || pushed.out)));
console.log("[sync] ✓ 已推送到 fork");
console.log("[sync] 接下来（本机生效）：");
console.log(`       dsh plugin --profile web add github:NaughtDZ/dsh-preset-plus#${args.branch}`);
console.log("       然后重启 DSH（host 端插件代码需要重启），控制台应出现 [preset-plus++] 横幅。");
