# dsh-preset-plus **plusplus**（fork 增强层）

本文件描述本 fork 相对上游 [`Rain-kl/dsh-preset-plus`](https://github.com/Rain-kl/dsh-preset-plus) 的全部差异，
以及上游更新时的同步流程。**除本目录外，本体只改了 4 行**（`lib/index.js`）＋ 1 个配置项
（`cordis.patch.yml`），全部由 `plusplus/apply-hooks.mjs` 一键重放。

---

## 0. 装 fork / 远端布局

```bash
dsh plugin --profile web add github:NaughtDZ/dsh-preset-plus#plusplus   # 装完重启 DSH
```

- `origin` = 你的 fork（`NaughtDZ/dsh-preset-plus`），`upstream` = 官方库（`Rain-kl/dsh-preset-plus`）。
- `main` 是**上游镜像**（不动它，方便 `git diff upstream/main` 看清自己的差异）；
  fork 的工作全部在 **`plusplus`** 分支上。
- 包名保持 `@rain-kl/dsh-preset-plus` 不变，所以 profile 的 `dsh.profile.bundles` 与
  任何 `cordis.patch.yml` 里的 `name` 都不用改，装 fork 就是同名覆盖上游那份。
- 改完推 `plusplus` 后要重新执行上面那条 `add`（pnpm 会把 spec 重新解析到分支最新提交），再重启 DSH。
- 想让**默认分支**直接可用（少写 `#plusplus`）：`git checkout main && git merge --ff-only plusplus
  && git push origin main`；此后每次同步上游都要 `rebase` + `push --force-with-lease` 重写 main，
  代价比「只在分支上 rebase」大，随你取舍。

---

## 1. 解决什么问题

上游的作用域是**写死的精确匹配**：

```js
// lib/index.js（上游）
function enabledForAgent(agentPresets, agents, sessionId, cfg) {
  const scopes = Array.isArray(cfg.scopedPresets) ? cfg.scopedPresets : [];
  if (scopes.length === 0) return false;
  ...
  return scopes.includes(current);        // ← 只能命中一个固定的模式 id
}
```

所以「只提供一个固定 DSH 模式 `preset-plus`，其他模式一律不注入」。
想在任何模式下都注入（不管用户当前选的是 `standard` / `tavern-lite` / 自己建的模式），
就必须改这三处 `includes` 判定。plusplus 把判定整体接管，做到：

| 能力 | 上游 | plusplus |
| --- | --- | --- |
| 注入作用域 | 单个固定模式 id | `*` 全量 / 白名单 / 通配 `preset-*` / 反向排除 `!tavern-lite` |
| 自动 vs 手动 | 只有 auto + `/prefill` | 再加「手动指定要注入哪些模式」与「模式→预设」绑定 |
| system 段 | 全局 section，任何模式都带上（见 §4） | `strictScope=true` 时只在作用域内出场 |
| 多预设 | 全模式共用设置页里激活的那一套 | `modeBindings` 可为每个模式指定不同预设 |

## 2. 配置（`cordis.patch.yml` → `config`）

```yaml
- insert:
    - id: dsh-preset-plus
      name: '@rain-kl/dsh-preset-plus'
      config:
        enabled: true
        scopedPresets: ["*"]        # ← 下面这几种写法都支持
        verbose: false
        strictScope: true           # plusplus 独有
        modeBindings:               # plusplus 独有（可选）
          tavern-lite: roleplay     # 该模式用 roleplay 这套预设
          "*": jailbreak            # 其余模式的兜底绑定
```

### `scopedPresets` 语法

| 写法 | 含义 |
| --- | --- |
| `["*"]` / `["all"]` / `"*"` | **所有模式**（自动全量注入） |
| `["preset-plus"]` | 上游原行为：只在该模式注入 |
| `["standard", "tavern-lite"]` | 手动白名单 |
| `["preset-*"]` | 通配（`*` 任意长度、`?` 单字符） |
| `["*", "!tavern-lite"]` | 全量 + 反向排除 |
| `["!tavern-lite"]` | 只有反向项时 = 除它以外全部 |
| `[]` / 缺省 | 关闭注入（同上游） |
| `"standard,tavern-lite"` | 逗号分隔字符串也接受（上游会当非法值忽略） |

> 未挂任何 agent preset 的裸 agent（`composedPreset()` 返回 `undefined`）一律不注入，
> 即使作用域是 `["*"]`。子 agent 的请求本来就被 `options.purpose` 过滤掉。

### 其它配置

- `strictScope: true|false`（默认 `true`）—— system 段是否按作用域出场，详见 §4。
- `modeBindings: { 模式id: 预设id, "*": 预设id }` —— 某模式用哪套预设；绑定指向不存在的预设时
  自动回落到设置页里激活的预设（不会变成"完全不注入"）。改 YAML 后需重启 DSH 生效。
- `verbose: true` —— 打印每次 system 段的作用域判定结果。

## 3. 与上游的接触面：4 个 hook

本体（`lib/index.js`）只有这 4 行改动，`plusplus/` 目录外没有任何其它逻辑：

| hook | 位置 | 改动 |
| --- | --- | --- |
| ① | 顶部 import | `import * as plusplus from "./plusplus.js";` |
| ② | `apply()` | `const cfg = plusplus.wrapConfig({ ...DEFAULTS, ...(config \|\| {}) });` |
| ③ | `installInjector()` 的 `systemPrompt.section` | `text: (context) => plusplus.systemSectionText(cfg, ctx, core, context)` |
| ④ | `llm/stream` handler | `const entries = plusplus.activeEntries(cfg, core, plusplus.modeOfSession(ctx, sessionId));` |

② 是最关键的一行：`wrapConfig` 把 `cfg.scopedPresets` 换成一个**真数组子类** `ScopeList`
（`Array.isArray` 为 `true`、可 `join` / `JSON` 序列化，只重写了 `includes`）。
于是上游那三处 `scopes.includes(current)` 原地获得通配/排除能力，**不需要为它们分别打补丁**，
将来上游新增的作用域判定也自动继承。

### 上游同步流程（一条命令）

```bash
npm run plusplus:sync                        # 演练：fetch 上游 + 报告新提交与预计冲突，不动工作区
npm run plusplus:sync -- --rebase            # 真同步：rebase 到 upstream/main，冲突自动重放 hook，然后跑自测
npm run plusplus:sync -- --rebase --push --token-file <token文件>   # 全绿后推 fork
```

`plusplus/sync-upstream.mjs` 固化了整套流程，关键几条安全设计：

- 冲突**只**允许发生在 `lib/index.js`，而且**先在内存里用 `applyHooks` 试打**这 4 个 hook：
  打得上去才取上游版本继续；打不上去就 `git rebase --abort` 回到同步前，报出是哪个 hook 失败——
  不会留下"同步了一半、hook 掉了一个"的状态。
- 其它文件冲突 → 直接 abort 交给人处理。
- 自测（hook 校验 + 51/53 + 30 项）任一失败 → **不推送**，并提示 `git reset --hard ORIG_HEAD` 撤销本次 rebase。
- 推送用 `--force-with-lease`（rebase 后必须 force，lease 保证不覆盖别人的提交）；
  `--token-file` 时 token 通过**环境变量**交给 git 的 credential helper，不进命令行、不进 `.git/config`、不落盘。

手工等价流程（脚本坏了时用）：

```bash
git fetch upstream && git rebase upstream/main     # 冲突几乎只会在 lib/index.js
node plusplus/apply-hooks.mjs                      # 重放 hook ①-④（幂等，已打过的会跳过）
npm run plusplus:test                              # 自测：语义 53 项 + 本体集成 30 项
npm run plusplus:hooks                             # 缺 hook 时退出码 1（可放 CI）
```

若 rebase 时选择了上游版本（`git checkout --theirs lib/index.js`），跑一次 apply-hooks 即可恢复。
`apply-hooks` 会把输入里的 CRLF 归一成 LF 再变换、写完还原，所以 Windows 工作区不会出现整文件换行差异。
如果上游重写了对应代码导致锚点找不到，脚本会**明确报出是哪个 hook 失败**，而不是猜着改。

### 自测覆盖什么

- `plusplus/self-test.mjs`（51 项，纯语义）：作用域匹配各写法、`ScopeList` 仍是真数组
  （`Array.isArray` / `join` / `JSON` / `map` 返回普通数组）、复刻上游三处 `includes` 判定、
  `modeBindings` 与失效回落、`strictScope` 两种行为、hook 幂等。
  带 `--pristine <上游原始 lib/index.js>` 时再加 2 项：从上游原文重放后与当前文件一致（共 53 项）。
- `plusplus/integration-test.mjs`（30 项，本体集成）：用假 cordis ctx 直接调 `apply()`，
  验证 system 段、`llm/stream` 前置 fake 消息、内置 section 过滤在四种配置下（`["*"]` / 上游式
  `["preset-plus"]` / `modeBindings` / `["*","!tavern-lite"]` / 空作用域）的实际行为。
  数据指向临时 `DSH_HOME`，不碰真实 `~/.dsh/preset-plus.json`。

其它 fork 专属文件（都不参与上游同步）：
`lib/plusplus.js`（增强层实现）、`plusplus/apply-hooks.mjs`、`plusplus/sync-upstream.mjs`、
`plusplus/self-test.mjs`、`plusplus/integration-test.mjs`、本文件。
`package.json` 只多了 `plusplus:hooks` / `plusplus:sync` / `plusplus:test` 三条 scripts 与 `files` 里的 `plusplus`。

## 4. 两个必须知道的真相

### 4.1 上游的 system 段其实是"全局常驻"的

上游把 system 段注册成**全局** section：

```js
ctx.systemPrompt.section({ name: "preset-plus", order: 100, text: () => {...} });
```

而 harness 组装时全局 section 会合进**每一个** scope（`dsh-system-prompt` 的
`ScopedLayers.merge`：先铺全局，再由同名的 scoped section 覆盖）。也就是说，上游 README 写的
「其他模式**一律不进行任何注入**」对 system 段并不成立 —— 只要有激活预设，任何模式的会话都会带上
它的 system 主提示词；作用域门禁实际只挡住了 fake `user`/`assistant` 消息与内置 section 的移除。

plusplus 把这段判定显式化：

- `strictScope: true`（默认）：system 主提示词只在命中作用域的模式下出场 —— 与 README 的意图一致；
  模式 id 无法判定时（诊断组装、裸 agent）只在作用域含 `*` 时出场。
- `strictScope: false`：完全复刻上游行为（有 system 条目就出场，不看模式）。

### 4.2 作用域里的每个模式都会被"清掉内置 section"

上游在 `system-prompt/assemble` 里对**命中作用域**的会话过滤掉
`harness:identity` / `harness:source` / `app:web-surface` 三段。配上 `["*"]` 就等于
**所有模式**都失去这三段（这正是破限想要的效果，但请知悉这是全量生效的）。
只想在部分模式生效就写白名单，或 `["*", "!tavern-lite"]` 把酒馆排除掉。

## 5. 生效验证

命令行/控制台：

1. DSH 启动日志里应出现 `[preset-plus++] v0.1.0 作用域=* strictScope=on 绑定=0 项`。
2. 每次注入会打印上游的 `[preset-plus] injected → session=..., inject=N, system=[...]`，
   其中 `system=[...]` 是当前模式下实际生效的那套预设的 system 头部（受 `modeBindings` 影响）。
3. `/preset-plus status` 会显示作用域与"本会话是否已注入"；`/preset-plus list|activate <id>`
   管理预设；`/preset-plus off` 关掉自动注入（仍可 `/preset-plus prefill` 手动触发下一条消息）。

> 注意：`/preset-plus status` 显示的「作用域」来自 `cfg.scopedPresets`，会显示成 `*, !tavern-lite`
> 这样的原始记号，而不是展开后的模式列表 —— 展开是运行期按会话模式判定的（模式集合不固定，
> 用户随时能在设置里新建模式）。

## 6. fork 变更记录

### plusplus-0.1.0
- 新增作用域匹配层：`*` 全量 / 白名单 / 通配 / `!` 反向排除 / 逗号分隔字符串。
- 新增 `strictScope`：system 段作用域感知，修掉「非作用域模式仍被注入 system 主提示词」。
- 新增 `modeBindings`：模式 → 预设 绑定（含 `*` 兜底与失效回落）。
- 新增 `plusplus/apply-hooks.mjs`（hook 幂等重放 + `--check`）、`plusplus/sync-upstream.mjs`（一条命令同步上游，
  冲突自动重放、打不上就 abort、自测不过不推送）、`plusplus/self-test.mjs`（51 项语义自测，
  带 `--pristine` 时 53 项）、`plusplus/integration-test.mjs`（30 项本体集成自测）。
- `cordis.patch.yml` 默认 `scopedPresets: ["*"]`、`strictScope: true`；CI 增加 hook 校验与自测两步。
