# R0-P0 代码、Validator 与 CI 审查记录（Reviewer B）

## 元信息

- 审查日期：2026-08-04
- 审查对象：`blueforst/pi` 分支 `iris/r0-p0-fork-baseline`
- **reviewedCommit**：`6e0cf571d6494cbd3f5c4b7f7d3c6a8fd0540385`（`fix(agent): correct fork governance and enforce provenance gate`，完整 diff 已由 reviewer 亲自查看）
- **reReviewedCommit**：`a8d2eec21b1589c4d83d1efc493dd8108de24b37`（`fix(agent): align ownership list and cover remaining patch statuses`，review follow-up 复审）
- 审查者：独立 subagent（Reviewer B，代码、Validator 与 CI）

## Reviewed files

- `scripts/check-iris-fork-baseline.mjs`
- `scripts/check-iris-fork-baseline.test.mjs`
- `.github/workflows/ci.yml`
- `docs/iris-fork/README.md`（§4/§6 规则文档化核对）

## Executed commands

- `git show 6e0cf571`（全量 diff）、`git show a8d2eec2`（复审 diff）
- `node --test scripts/check-iris-fork-baseline.test.mjs` → 38 pass（初审）；40 pass（复审）
- `npm run check:iris-fork` → `OK: iris fork baseline manifests are valid`
- /tmp 构造 9 组坏 fixture 手动验证（lock.fork=null、id=""、carried 缺 latestForkCommit、lock={}、patch 缺 upstream、patches=null、removed 缺 firstForkCommit、零 SHA → 全部 exit=1 无 TypeError；proposed 无 commit → exit=0）
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → YAML 合法
- `git show 6e0cf571 --name-only`、`git status --short`（最小 diff）

## Actual outputs

- 初审：`ℹ tests 38 / ℹ pass 38 / ℹ fail 0`；`OK: iris fork baseline manifests are valid`；9 组坏 fixture 全部按预期 fail-closed
- 复审（a8d2eec2）：`ℹ tests 40 / ℹ pass 40 / ℹ fail 0`

## Findings

### 初审（reviewedCommit 6e0cf571）

- **BLOCKING：无。**
- 逐项核对：
  1. **patch ID**：`checkNonEmptyStringField(patch, "id", ...)` 逐 patch 执行，空 ID 报 `expected non-empty string`；duplicate 检查位于 `isNonEmptyString` 守卫内，空 ID 不产生误报。手动探针验证通过。
  2. **Commit identity**：`requiresCommitIdentity = status !== undefined && status !== "proposed"`；carried/upstreamed/removable/removed 缺 first/latestForkCommit 报 `required for status "..."; only "proposed" may omit commit identity`；存在时走 `checkShaField`（40 位 hex + 零 SHA 拒绝）；`removed` 的 `latestForkCommit` 语义在 README 说明（表示移除 commit）。探针验证通过。
  3. **父对象安全**：`lock.fork.repository` 直访全部改为 `getPath`（对 null/undefined 短路）；`checkLockInvariants` 全部 `!== undefined` 守卫；`validateBaselineConsistency` 先 `isObject` 守卫、仅两值都存在时比较。探针：`lock.fork=null`、`lock={}`、`lock.upstream=null`、`patch.upstream` 缺失、`patches=null` 全部字段级错误、exit=1、无 TypeError/堆栈。
  4. **Cross-field 不变量**：5 条全部实现（lastVerifiedUpstreamCommit===upstreamBaseCommit；lastVerifiedAt>=verifiedAt（ISO 字符串比较安全）；defaultBranch==="main"；packageManager==="npm"；lockfile==="package-lock.json"），"双值存在才比较，缺失交给 required"。
  5. **无依赖/确定性/main 守卫**：仅 node: 内置模块；输出确定；`process.argv[1] &&` 守卫完好。
  6. **测试**：新增 16 用例与规则一一对应；`assertFailsWithFieldError` 同时断言 exit=1、错误模式、无 TypeError/堆栈；全部临时 fixtures + `test.after` 清理；真实 manifest 仅默认路径集成测试只读。
  7. **CI**：`Iris fork provenance gate` step 位于 Install dependencies 之后、Build/Check 之前，独立于 root check 链，无 `continue-on-error`，失败使 job 失败；YAML 合法。
  8. **root check 链**：未触碰 package.json，`check:iris-fork` 仍在链尾，无回归。
  9. **最小 diff**：仅 4 个文件；工作树干净。
  10. **Evidence 数字**：bootstrap-evidence.md 仍为旧数字（19）——已知待更新（后续 docs commit），非 BLOCKING。
- **NON-BLOCKING**：
  - B1：removable/upstreamed 状态共享 `requiresCommitIdentity` 路径但缺显式测试——已修复，见复审。
  - B2：status 为枚举外值时 enum 错误与 commit-identity 错误冗余报错（fail-closed 冗余，无害）。

### 复审（reReviewedCommit a8d2eec2）

- **BLOCKING：无。** 新增 2 个测试（`rejects removable patch without commit ids`、`rejects upstreamed patch without commit ids`）真实命中 `requiresCommitIdentity` 共享路径并分别覆盖 first/latest 字段；断言规范与既有 16 用例一致；README 变更（补 RuntimeRecoveryNotice）为纯文档对齐。40/40 全绿；commit 未触碰 validator、ci.yml、package.json。

## Final verdict

**PASS**（初审与复审均无 BLOCKING；reviewedCommit `6e0cf571`、reReviewedCommit `a8d2eec2` 均通过）
