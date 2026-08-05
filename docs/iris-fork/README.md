# Iris Fork 治理（blueforst/pi）

本文档定义 `blueforst/pi`（`earendil-works/pi` 的受控 fork）的运行约束、同步流程与交付物校验。

受约束的对象是 Iris Roadmap 的三个项目边界之一：**Pi Runtime Capsule**（runtime substrate）。
另两个项目（`blueforst/iris_agent` cognitive runtime、`blueforst/iris_memory` memory service）不在本仓库治理范围内。

## 1. Ownership：blueforst/pi 的通用 Runtime seam 与禁止项

`blueforst/pi` 是 **generic runtime substrate** 的载体（Roadmap v13 三项目边界中的 Project A）。所有权划分以 Roadmap v13 与三项目边界（07 Project Boundaries，2026-08-04 版）为最高权威。

### 允许并应由 `blueforst/pi` 实现（通用 runtime seam / lifecycle / substrate）

- AgentHarness / agent loop；
- provider lifecycle；
- tool lifecycle；
- structured pre-conversion Provider Context Controller seam；
- stable RuntimeEvent lifecycle seam；
- SessionCommitReceipt；
- sequenced Session archive reads；
- explicit Session close；
- storage diagnostics；
- rollback / cache / runtime performance；
- upstream compatibility 与通用 runtime tests。

### 禁止进入 `blueforst/pi`（Iris 认知或产品语义，属于 `iris_agent` / `iris_memory`）

- Iris P0–P5 policy；
- ContextMessageUnit；
- contextSeq ledger；
- identity-level IrisContextState；
- m0/m1/LKG 的 Iris 策略；
- protected-tail、retirement、Historian disposition 的 Iris 语义；
- Historian、Compartment、Evidence、Publication；
- Persona；
- Goal & Work；
- RuntimeRecoveryNotice；
- Memory、Recall、Graphiti；
- Iris 产品 DTO 或业务策略。

### 关键区别

```text
通用 seam / lifecycle / substrate
→ blueforst/pi

seam 上运行的 Iris cognitive policy
→ blueforst/iris_agent
```

判断标准：某段代码描述的是**通用 runtime 机制**（回合如何执行、消息如何落盘、生命周期如何推进、provider/tool 如何被调用）？若是，归 `blueforst/pi`。它是否承载 **Iris 的认知/产品语义**（Context 策略、记忆、人格、工作目标、Historian 处置）？若是，归 `iris_agent` / `iris_memory`，即使"只是方便"也不得进入本仓库。RuntimeEvent 等 seam 本身是 Pi 的能力；在其上运行的 Iris policy 才是禁止项。

## 2. 基线（Baselines）

三个概念必须区分，不得混用：

| 概念 | 含义 | 记录位置 |
| --- | --- | --- |
| upstream base | 上次验证的 upstream（`earendil-works/pi`）immutable commit | `production-lock.json` → `upstream.baseCommit` |
| fork baseline | 当前受控 fork（`blueforst/pi`）工作起点 commit | `production-lock.json` → `fork.baselineCommit` |
| fork head | fork 当前分支最新 commit | 由 git 本身记录，不写入 manifest |

- `upstream.baseCommit` 是 **immutable** 的：它是某个时刻 upstream main 被审查过的快照，之后不再变化，直到下一次显式同步更新它。
- `fork.baselineCommit` 是本次受控工作开始时的 fork commit；它区分"我 fork 时上游长什么样"与"我现在长什么样"。
- 依赖方向固定为 `upstream_only`：fork 永不向 upstream 反向输送未审查的变更。

## 3. Upstream 同步流程（Sync Procedure）

只有通过完整流程的同步才允许更新 `production-lock.json` 中的 `upstream.baseCommit` / `sync.lastVerifiedUpstreamCommit`。同步是人工审查门（`sync.strategy: "manual_review_gate"`），不允许自动合并。

1. **fetch**：`git fetch upstream`，记录 upstream main 的当前 SHA。
2. **inspect**：`git log --oneline <currentBase>..upstream/main`，逐个检查 upstream 新增 commit 的 diff（依赖、安全、架构影响）。
3. **checks**：对目标 upstream commit 跑本仓库校验（`npm run check`），确认在其之上构建与测试通过。
4. **update lock**：更新 `upstream.baseCommit`、`sync.lastVerifiedUpstreamCommit`、`sync.lastVerifiedAt`（ISO 日期）为本次验证的真实值；`fork.baselineCommit` 在需要时同步更新。
5. **re-evaluate patches**：对照新 upstream base，重新评估每个 carried patch：
   - 该 patch 是否已被 upstream 采用？→ 标记 `upstreamed`。
   - 是否被 upstream 以不同方式解决？→ 标记 `removed`（记录理由）。
   - 是否仍然必要？→ 保留或标记 `removable`。
6. **remove satisfied**：`removalCondition` 已满足的 patch 立即移除（或标记 `removed`），不允许"顺手保留"。
7. **evidence**：同步事件必须写入 `docs/iris-fork/` 下的同步记录（至少：日期、old/new upstream SHA、commit 清单、审查结论、检查命令输出摘要）。

若 fork 落后于 upstream（fork 是 upstream 的祖先），**不允许**把同步悄悄混入其他 PR；同步必须有独立的提交与记录。

## 4. Carried Patch 生命周期

`docs/iris-fork/carried-patches.json` 记录 fork 携带的、upstream 尚未有的变更。

- **空 `patches` 数组表示"当前没有 fork-only patch"，不代表"没有治理要求"**。治理要求由本文档 + validator + `production-lock.json` 构成，与 patch 数量无关。
- 每个 patch 必须完整填写 schema 字段（见 §6）：`id`、`title`、`status`、`genericRuntimeRationale`、`affectedPackages`、`affectedSurfaces`、`tests`、`upstream.*`、`firstForkCommit`/`latestForkCommit`、`removalCondition`、`compatibilityRisk`、`notes`。`id` 必须是非空字符串，空 id 被拒绝。
- **Commit identity 规则**：`status = proposed` 时 `firstForkCommit`/`latestForkCommit` 可以缺省（提案尚未落地 fork commit）；`carried` / `upstreamed` / `removable` / `removed` 时两者**必须存在**且为完整非零 SHA。`removed` 的 `latestForkCommit` 表示移除该 patch 的 fork commit；移除操作必须先落 commit 再改状态，不允许"未提交的移除"。
- `status` 枚举：`proposed`（提案中，尚无 fork commit）/ `carried`（正在携带）/ `upstreamed`（已贡献回上游）/ `removable`（可移除）/ `removed`（已移除）。
- `upstream.status` 枚举：`not_filed`（未向上游提交 issue/PR，**未提交时必须用它**）/ `filed` / `open` / `merged` / `rejected` / `superseded`。当 `not_filed` 时，`upstream.issue` 与 `upstream.pullRequest` 必须为 `null`。
- 新增 patch → 必须带 `tests`（数组，非空）与 `removalCondition`（非空字符串）。没有测试或没有移除条件的 patch 无法通过校验。
- 移除条件满足 → 移除 patch 并记录 `removed` 状态与证据，而不是无限期保留。

## 5. Release / Package Identity 诚实性

- 本仓库 workspace 包名目前沿用 upstream 的 `@earendil-works/pi-*`（`distribution.packageIdentityStatus: "inherits_upstream_package_names"`）。这是**如实记录**：我们尚未建立独立身份。
- `distribution.publishStatus: "not_published"`：本 fork 尚未发布任何包，也不得擅自发布。
- 任何发布行为发生前，必须先明确 package identity 决策（沿用 vs 独立命名）并更新 manifest；不得在身份未定的情况下发布。
- 版本号、CHANGELOG 等发布物变更必须与上游策略保持一致，禁止制造与 upstream 同名同版本但内容不同的包。

## 6. Manifest 与校验

### `docs/iris-fork/production-lock.json`

机器可验证的生产锁，字段：

- `schemaVersion`：当前为 `2`。v2 新增 `acceptedRuntime` 段（见下）。
- `fork.repository` / `fork.defaultBranch` / `fork.baselineCommit`：fork 身份与基线（完整 40 位 SHA，禁止零 SHA、占位符、浮动引用）。
- `acceptedRuntime.repository` / `acceptedRuntime.commit` / `acceptedRuntime.tree` / `acceptedRuntime.verifiedAt`：**Agent 实际允许消费的 accepted runtime 身份**（issue iris_agent#41 单一权威来源）。
  - `commit` 是 fork 内**不可变 commit**（经审查接受的 Pi fork head，如 `fa7aba0a…`）；
  - `tree` 是该 commit 的 git tree hash（`<commit>^{tree}`），用于机械证明 checkout 内容等价；
  - 禁止使用浮动 `main` 作为 accepted identity；`commit` 必须与 `fork.baselineCommit` 不同（仅记录初始 bootstrap 基线不满足 R0 Exit Gate）；
  - `--verify-git` 模式会在真实 git 仓库中验证 commit 存在、tree 匹配、carried patches 是 accepted commit 的祖先。
- `upstream.repository` / `upstream.baseCommit` / `upstream.verifiedAt`：immutable upstream 基线与其验证日期（ISO `YYYY-MM-DD`）。
- `runtime.node` / `runtime.packageManager` / `runtime.lockfile`：运行时约束。
- `distribution.packageIdentityStatus`：`inherits_upstream_package_names` 或 `independent_identity`。
- `distribution.publishStatus`：`not_published` 或 `publish_forbidden`。
- `dependencyDirection`：固定 `upstream_only`（fork 只依赖 upstream，反之不成立）。
- `sync.strategy` / `sync.lastVerifiedUpstreamCommit` / `sync.lastVerifiedAt`：同步策略与最近一次验证。

### `docs/iris-fork/carried-patches.json`

顶层 `upstreamBaseCommit` 必须与 `production-lock.json` 的 `upstream.baseCommit` 一致（validator 交叉校验）；`patches` 为数组，schema 见 §4。

### Validator（fail-closed）

`scripts/check-iris-fork-baseline.mjs` 是 schema 的单一权威实现，无第三方依赖。它有两个执行入口：root `npm run check` 链（`check:iris-fork`，带 `--verify-git`）以及 `.github/workflows/ci.yml` 中**独立且靠前的 "Iris fork provenance gate" step**（位于 build 与 full check 之前，不会被 `tsgo` 等既有失败短路）。**失败即退出非零**，任何下列情况都会导致 gate 失败：

1. JSON 无法解析
2. schemaVersion 不支持
3. 必填字段缺失
4. 任何字符串值含占位符（`TBD` / `TODO` / `unknown`，不区分大小写）
5. SHA 格式错误（非 40 位 hex）
6. 零 SHA
7. `fork.repository` / `upstream.repository` 不匹配（`blueforst/pi` / `earendil-works/pi`）
8. `acceptedRuntime.repository` 不匹配、`acceptedRuntime.commit`/`tree` 缺失或格式错误、`acceptedRuntime.commit` 等于 `fork.baselineCommit`
9. 依赖方向错误（非 `upstream_only`）
10. patch `id` 为空或重复
11. patch `status` 不在枚举内
12. patch `upstream.status` 不在枚举内
13. patch 无 `tests`（缺失或空数组）
14. patch 无 `removalCondition`（缺失或空）
15. patch 的 `firstForkCommit` / `latestForkCommit` 存在但格式错误
16. 非 `proposed` 状态的 patch 缺少 `firstForkCommit` / `latestForkCommit`
17. 父对象缺失或为 `null`（如 `fork`、`upstream` 缺失）时仍返回字段级错误，不崩溃
18. 跨字段不变量（schema v2 固定规则）：`sync.lastVerifiedUpstreamCommit` 必须等于 `upstream.baseCommit`；`sync.lastVerifiedAt` 必须等于或晚于 `upstream.verifiedAt`；`fork.defaultBranch` 必须为 `main`；`runtime.packageManager` 必须为 `npm`；`runtime.lockfile` 必须为 `package-lock.json`
19. `carried-patches.json` 的 `upstreamBaseCommit` 与 lock 的 `upstream.baseCommit` 不一致
20. `--verify-git` 模式（`npm run check:iris-fork` 与 CI gate 默认启用）：acceptedRuntime.commit 在 git 仓库中不存在、`<commit>^{tree}` 与 lock 记录的 tree 不一致、或任一 `carried`/`upstreamed`/`removable`/`removed` patch 的 `latestForkCommit` 不是 acceptedRuntime.commit 的祖先

本地运行：`npm run check:iris-fork`，或带路径运行 `node scripts/check-iris-fork-baseline.mjs [--verify-git] <lockPath> <patchesPath> [repoDir]`。

### 开发者本地 bootstrap（不触碰已有分支）

`blueforst/pi` 的 accepted runtime 身份是**不可变 commit + tree**。开发者无需把个人工作分支 reset 到 accepted commit；推荐在独立目录使用 worktree/clone 固定到 accepted identity：

```bash
# 在仓库外（例如 workspace/pi-accepted）创建只读 detached checkout，绝不移动现有分支
git clone --no-checkout https://github.com/blueforst/pi.git /tmp/pi-accepted
git -C /tmp/pi-accepted fetch origin fa7aba0a5240ead1679dced5a5e12a0fe7df2800
git -C /tmp/pi-accepted checkout --detach fa7aba0a5240ead1679dced5a5e12a0fe7df2800
git -C /tmp/pi-accepted rev-parse HEAD^{tree}   # 必须等于 1b43382f…
node /path/to/pi/scripts/check-iris-fork-baseline.mjs --verify-git \
  /path/to/pi/docs/iris-fork/production-lock.json \
  /path/to/pi/docs/iris-fork/carried-patches.json \
  /tmp/pi-accepted
```

对 `iris_agent` 消费方（相邻 `../pi` 布局），`iris_agent` 仓库提供等效的确定性 bootstrap 脚本（见 `iris_agent/docs/pi-production-lock.md`），其行为与上面等价：fetch 期望仓库 → 校验 commit/tree → 在专用目录创建 detached worktree/checkout → 不 reset 任何已有分支 → 不匹配时输出可操作的诊断。

## 7. Evidence 要求

任何影响 baseline / lock / patch 状态的操作都必须留下证据，记录于 `docs/iris-fork/`：

- 操作日期与执行者（commit 作者、PR 号）
- 变更前的值（old upstream SHA、old baseline）
- 变更后的值
- 使用的命令与输出（至少命令与退出码；关键操作附输出摘要）
- 决策理由（为什么同步 / 为什么保留 / 为什么移除）
- 检查结论（reviewer、BLOCKING/无 BLOCKING、修复 commit）

Evidence 必须是真实运行结果，禁止编造；未做的事如实标注"未实现 / 未验证"。

## 8. 参考

- Iris Roadmap v13 R0：Production Baseline & Pi Fork Bootstrap
- Roadmap 详细规格：R0–R7 交付与 Exit Gate（Notion 3b2b9833-8da5-81d0-ac5c-d0b997f38063）
- 项目边界：Notion 3aeb9833-8da5-8153-8ace-dc7ca9da57b9
- Pi Runtime Capsule Boundary：Notion 3a7b9833-8da5-8128-a4bb-fdb912063707
