# R0-P0 Bootstrap Evidence（blueforst/pi fork 基线）

本文件记录 R0-P0 "Production Baseline & Pi Fork Bootstrap" 交付与 BLOCKING 修复轮的真实状态与运行结果。所有数据来自实际命令输出；未做/未验证的事项如实标注。

## 1. 任务信息

- 任务日期：2026-08-04
- 分支：`iris/r0-p0-fork-baseline`（自 `blueforst/pi` 的 `main` 创建）
- 仓库：`blueforst/pi`（fork），`earendil-works/pi`（upstream）
- PR：#1 `R0-P0: controlled Pi fork provenance and CI baseline`（base `main`，非 Draft）
- 交付物：7 项（production-lock.json、carried-patches.json、README.md、validator+测试、root check 接入、CI gate step、本 evidence）
- 修复轮：初版 5 个 BLOCKING 全部修复（ownership 归属、CI fork gate、validator fail-closed 漏洞、evidence 一致性、review 可追溯性），经两个独立 subagent 审查与复审

## 2. 基线（Baselines）

| 项 | 值 |
| --- | --- |
| fork baseline（fork main = merge-base = 分支创建点） | `ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1` |
| upstream reviewed snapshot（as of 2026-08-04） | `e741cb05ca7c1c7bc5a9664c99697df32de9fac6` |
| 验证日期 | 2026-08-04 |
| divergence | fork 是 upstream 的祖先；fork-only commits = 0；upstream-only commits = 6 |
| 同步决策 | **不同步 upstream**，本 PR 从当前 fork main 开始（见 §2.1） |

`e741cb05…` 是 **reviewed upstream snapshot**（2026-08-04 审查时的上游状态），不是"当前 upstream main"；upstream 后续继续推进**不改变**该 immutable reviewed snapshot，直到下一次按 README §3 显式同步更新 `upstream.baseCommit`。

命令证据：

```
$ git merge-base main upstream/main
ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1
$ git rev-parse main
ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1
$ git rev-parse upstream/main
e741cb05ca7c1c7bc5a9664c99697df32de9fac6
$ git log --oneline main..upstream/main
e741cb05 fix(coding-agent): preserve extension auth endpoints
42a06f94 fix(coding-agent): test composite OAuth cancellation signal
b784c809 fix(ai): remove OAuth refresh lock test
acbdc0d2 fix(ai): bound OAuth refresh duration
f7ea2ef3 docs(agent): resolve open questions, add mechanical test constructions
382aa641 DRAFT: add openai background mode responses (#7339)
$ git log --oneline upstream/main..main
（空——无 fork-only commits）
```

### 2.1 同步决策（不合并 upstream）

任务约束：不得为了保持最新而把未审查的 upstream 变更混入本 PR；环境未明确允许 clean fast-forward。fork 落后 6 commits，故本 PR 从当前 fork main（`ab5f8d8`）开始，不合并 upstream。upstream 同步将作为独立工作按 README §3 流程执行。

## 3. Manifest 与 Schema

- `docs/iris-fork/production-lock.json`：fork/upstream 身份与基线、runtime 约束、distribution 诚实性（packageIdentityStatus = `inherits_upstream_package_names`、publishStatus = `not_published`）、dependencyDirection = `upstream_only`、sync 记录。
- `docs/iris-fork/carried-patches.json`：`upstreamBaseCommit`（与 lock 交叉校验）+ 空 `patches` 数组。空集含义：**当前无 fork-only patch**，不代表无治理要求（治理要求由 README + validator + lock 构成）。
- Schema 权威：`scripts/check-iris-fork-baseline.mjs` 内常量（单一权威来源），README §6 文档化。
- 占位符（TBD/TODO/unknown）与零 SHA 全局拒绝；所有 SHA 必须完整 40 位 hex；日期为 ISO `YYYY-MM-DD`；patch 的 `upstream.status` 未提交时必须为 `not_filed`。
- **Schema v1 固定不变量**（validator 与 README §6 同时明确，均有测试）：`sync.lastVerifiedUpstreamCommit` === `upstream.baseCommit`；`sync.lastVerifiedAt` >= `upstream.verifiedAt`；`fork.defaultBranch` === `"main"`；`runtime.packageManager` === `"npm"`；`runtime.lockfile` === `"package-lock.json"`。这些不变量是本 fork 治理对 schema v1 的固定约束（决策来源：README §6 + validator 单一权威），当前 manifest 全部满足。
- **Patch 规则**：`id` 必须非空（空 id 拒绝）；commit identity——`status = proposed` 可缺省 `firstForkCommit`/`latestForkCommit`，`carried | upstreamed | removable | removed` 必须两者齐全且为完整非零 SHA（`removed` 的 `latestForkCommit` 表示移除该 patch 的 fork commit）；父对象缺失/null（如 `fork`、`upstream`）返回字段级错误而不崩溃。

## 4. Validator 与测试

- 无第三方依赖（仅 `node:` 内置模块）。
- Fail-closed：18 类失败条件全部覆盖（JSON 解析失败、schemaVersion 不支持、必填字段缺失、占位符、SHA 格式、零 SHA、repo 不匹配、依赖方向错误、patch id 为空/重复、patch status 不支持、upstream status 不支持、无 tests、无 removal condition、patch commit 格式错误、非 proposed 缺 commit identity、父对象缺失/null、cross-field 不变量、upstream base 不一致）。
- 测试：`scripts/check-iris-fork-baseline.test.mjs`，**40 个用例**，全部使用临时 fixtures（`mkdtempSync`），不修改真实 manifest；最后一个用例用默认路径验证真实 manifest 通过。

### 4.1 实际运行结果（修复轮最终）

```
$ node --test scripts/check-iris-fork-baseline.test.mjs
ℹ tests 40
ℹ pass 40
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1053.333375

$ npm run check:iris-fork
OK: iris fork baseline manifests are valid
```

## 5. Root check 与 CI

### 5.1 Root check 接入

- `package.json` 新增 `"check:iris-fork": "node scripts/check-iris-fork-baseline.mjs"`，并追加 `&& npm run check:iris-fork` 到 `check` 链末尾（不改变既有顺序）。
- 无依赖变化、无 lockfile 变化（仅 scripts 修改）。

### 5.2 CI：独立 fork gate step（不被 tsgo 短路）

`.github/workflows/ci.yml` 新增独立且靠前的 **"Iris fork provenance gate"** step，位于 `Install dependencies` 之后、`Build` / `Check` 之前：

```yaml
      - name: Iris fork provenance gate
        run: npm run check:iris-fork
```

- 即使后续 build、tsgo 或其他既有检查失败，fork provenance gate 也已经真实执行（本机验证 `npm run check:iris-fork` 通过）。
- 不依赖网络、secret 或 provider key；不复制完整 CI matrix；不使用 `continue-on-error`；gate 失败使 job 失败。
- `check:iris-fork` 同时保留在 root `npm run check` 链尾，但 fork gate 不依赖该链路。

### 5.3 GitHub Actions 实际触发状态

**GitHub Actions 在 fork 仓库未触发**（代码无法启用该设置，如实记录）：

- `GET /repos/blueforst/pi/actions/workflows` → `{"total_count":0,"workflows":[]}`（对照 `earendil-works/pi` 可列出 12 个 workflow）。
- `GET /repos/blueforst/pi/actions/runs` → `{"total_count":0,"workflow_runs":[]}`；PR #1 创建后无任何 workflow run（含 pr-gate.yml 的 `pull_request_target`）。
- 远程 `main`（`ab5f8d8`）上 `.github/workflows/ci.yml` 存在，触发条件为 push/PR 到 main，正确。
- 结论：**fork 的 Actions 调度未启用，需要仓库 owner 在 GitHub Settings → Actions 启用 workflow 调度**。本 PR 不虚报 CI 已运行或已通过；workflow 代码修复已完成，启用后 fork gate step 会在 build/check 之前真实执行。

### 5.4 Full `npm run check` 真实结果（修复轮最终，2026-08-04）

`npm run check` 在本机执行，完整输出存档于本次执行记录（`/tmp/iris-check-output2.txt`，临时辅助，非长期证据；本节为 durable 摘要）：

1. `biome check --write --error-on-warnings .`：**通过**。`Checked 1012 files`，`No fixes applied`（node_modules 就位后 biome 2.3.5 与仓库格式一致）。初版执行时（node_modules 缺失、PATH 回退到全局 biome）曾重排 17 个 packages/*/test 文件并出现 CLI 版本 2.4.6 info，已全部恢复并记录于初版 evidence。
2. `check:pinned-deps`、`check:ts-imports`、`check:shrinkwrap`、`check:install-lock:coding-agent`：**通过**。
3. `tsgo --noEmit`：**失败（exit 2），744 个 pre-existing 错误**。错误码分布：TS2345 ×655、TS2344 ×38、TS2339 ×31、TS7053 ×14、TS18046 ×3、TS2698 ×2、TS2322 ×1。样例：`packages/agent/test/agent.test.ts(122,42): Argument of type '"gpt-4o-mini"' is not assignable to parameter of type 'never'`。
4. 因 3 失败，链尾的 `check:browser-smoke` 与 `check:iris-fork` 在 **full check 内**被短路未执行——**这正是 §5.2 独立 gate step 存在的原因**：fork gate 在 CI 中位于 full check 之前，独立执行，不受此影响。

### 5.5 tsgo 失败定性：fork main pre-existing，与本 PR 无关

- 机制：`packages/ai/src/providers/all.ts` 的 `getBuiltinModel<TProvider, TModelId extends keyof (typeof MODELS)[TProvider]>` 中，`keyof MODELS[provider]` 因模型目录类型漂移退化为 `never`，导致测试中所有模型名字面量调用报错。
- 验证：在**不含本任务任何改动的干净 HEAD**（独立 worktree，符号链接主仓库 node_modules）上运行 `npx tsgo --noEmit 2>&1 | grep -c "error TS"`，输出 `744`（与主工作树一致）。**pre-existing 确认**（worktree 已清理，验证命令与输出如上）。
- 结论：本 PR 未引入任何 TS 改动（交付物为 docs/、scripts/*.mjs、package.json scripts、.github/workflows/ci.yml），该失败属于 fork 落后 upstream 6 commits 所暴露的类型漂移症状。**不得把 pre-existing failure 当作本 PR 通过，也不宣称 full check green**。

## 6. 未实现清单（明确声明，不宣称 R0 complete）

### 属于 Pi 通用 runtime seam 的 R1 范围（未来由 `blueforst/pi` 实现，**并非禁止进入 Pi**，本 PR 未实现）

- Provider Context Controller seam；
- RuntimeEvent lifecycle seam；
- SessionCommitReceipt；
- explicit Session close；
- sequenced Session archive reads。

### 禁止进入 Pi 的 Iris 认知域（属于 `iris_agent` / `iris_memory`）

- Iris P0–P5 policy；
- ContextMessageUnit / contextSeq；
- m0/m1/LKG 的 Iris 策略；
- Historian、Compartment、Evidence、Publication；
- Persona、Goal & Work、RuntimeRecoveryNotice；
- Memory、Recall、Graphiti；
- Iris 产品 DTO 或业务策略。

### 其他未实现

- package publication（publishStatus = `not_published`；所有 workspace 包仍为 `@earendil-works/pi-*` 身份，version 0.83.0，与 upstream 相同——未建立独立 package identity）；
- R1 vertical slice；
- upstream 同步（fork 落后 6 commits，已记录，未执行同步）。

本交付完成的仅是 R0-P0 的 fork 基线治理部分（7 项交付物 + 5 项 BLOCKING 修复），**不宣称 R0 complete**。

## 7. 已知限制与后续

- 提交行为：本地 `npm ci --ignore-scripts` 未运行 husky 的 `prepare`，`.git/hooks/pre-commit` 未注册，因此 commit 未被 pre-commit hook 拦截；`npm run check` 的真实结果见 §5.4。CI 不依赖 hooks（`.github/workflows/ci.yml` 直接运行命令）。
- **GitHub Actions 未触发**：见 §5.3，需要 fork owner 在 GitHub Settings → Actions 启用 workflow 调度。
- fork 落后 upstream 6 commits：需按 README §3 独立同步。
- tsgo pre-existing 类型漂移：需解决后 `npm run check` 链才能全绿（独立 fork gate step 不受影响）。

## 8. 审查与提交记录

- 实现 fix commit（含 ownership 修正、CI gate step、validator fail-closed 修复、38 个测试）：`6e0cf571d6494cbd3f5c4b7f7d3c6a8fd0540385` — 经 Reviewer A（规格/边界）与 Reviewer B（代码/CI）审查，**均为 PASS（无 BLOCKING）**。
- Review follow-up commit（README 禁止清单补 RuntimeRecoveryNotice、新增 removable/upstreamed 状态测试，40 个测试）：`a8d2eec21b1589c4d83d1efc493dd8108de24b37` — 经原两位 reviewer 复审，**均为 PASS**。
- 本 evidence 与 review 记录随最终 docs commit 提交；PR #1 的最终分支 head 见 PR 页（推送后 `git rev-parse HEAD` 可复核）。
- Review 记录：`docs/iris-fork/reviews/r0-p0-spec-review.md`、`docs/iris-fork/reviews/r0-p0-code-ci-review.md`（均绑定真实 commit）。
