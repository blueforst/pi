# R0-P0 规格与项目边界审查记录（Reviewer A）

## 元信息

- 审查日期：2026-08-04
- 审查对象：`blueforst/pi` 分支 `iris/r0-p0-fork-baseline`
- **reviewedCommit**：`6e0cf571d6494cbd3f5c4b7f7d3c6a8fd0540385`（`fix(agent): correct fork governance and enforce provenance gate`，完整 diff 已由 reviewer 亲自查看）
- **reReviewedCommit**：`a8d2eec21b1589c4d83d1efc493dd8108de24b37`（`fix(agent): align ownership list and cover remaining patch statuses`，review follow-up 复审）
- 审查者：独立 subagent（Reviewer A，规格与项目边界）
- 最高权威：Roadmap v13；三项目边界（Notion 07 Project Boundaries，2026-08-04 版，page 3aeb9833-8da5-8153-8ace-dc7ca9da57b9）；Pi Runtime Capsule Boundary（Notion 05，page 3a7b9833-8da5-8128-a4bb-fdb912063707）；Roadmap Detailed Specifications R0–R7（page 3b2b9833-8da5-81d0-ac5c-d0b997f38063）

## Reviewed files

- `.github/workflows/ci.yml`
- `docs/iris-fork/README.md`
- `scripts/check-iris-fork-baseline.mjs`
- `scripts/check-iris-fork-baseline.test.mjs`

## Executed commands

- `git show 6e0cf571`（完整 diff）、`git show 6e0cf571 --stat`、`--name-only`
- `git show a8d2eec2`（复审完整 diff）
- `node --test scripts/check-iris-fork-baseline.test.mjs` → 38 pass / 0 fail（初审）；40 pass / 0 fail（复审后）
- `npm run check:iris-fork` → `OK: iris fork baseline manifests are valid`

## Actual outputs

- 初审：`ℹ tests 38 / ℹ pass 38 / ℹ fail 0`；`OK: iris fork baseline manifests are valid`
- 复审（a8d2eec2）：`ℹ tests 40 / ℹ pass 40 / ℹ fail 0`

## Findings

### 初审（reviewedCommit 6e0cf571）

- **BLOCKING：无。**
- PASS 依据：
  1. README §1 Ownership 允许清单 11 项（AgentHarness/agent loop、provider/tool lifecycle、structured Provider Context Controller seam、SessionCommitReceipt、stable RuntimeEvent lifecycle seam、Session archive/sequenced reads/close/diagnostics、cache/rollback 性能、upstream compatibility 与通用 runtime tests）逐项对照 07 Project A 职责原文，均未被列为禁止；初版误禁 seam 已修正。
  2. 禁止清单（P0–P5 policy、ContextMessageUnit、contextSeq ledger、IrisContextState、m0/m1/LKG、protected-tail/retirement/Historian disposition、Historian/Compartment/Evidence/Publication、Persona、Goal & Work、Memory/Recall/Graphiti、Iris 产品 DTO）与 07 Project A 禁止项及 05 页 Iris-owned 语义完全吻合；"seam vs seam 上运行的 Iris policy" 区分与 05 页 Decision Test 一致。
  3. 无 Iris cognitive policy 泄漏进 Pi；无 Pi seam 误归属 iris_agent/iris_memory。
  4. R0 范围诚实：无超出 R0-P0 的宣称。
  5. 最小 diff：`--name-only` 仅 4 个文件。
  6. CI gate step（ci.yml）位于 npm ci 之后、Build 之前，不被 tsgo 短路。
- **NON-BLOCKING**：
  - F1：bootstrap-evidence.md 相对本 commit 已过期（19/15 旧数字、CI 表述过时）——已在后续 docs commit 更新。
  - F2：README 禁止清单未单列 RuntimeRecoveryNotice（07 页显式禁止项）——已修复，见复审。
  - F3：schema v1 不变量与 commit identity 规则为仓库内部治理延伸，建议在 evidence 记录决策来源——已在 evidence §3 记录。
  - F4：PR body 尚未更新——随后更新。

### 复审（reReviewedCommit a8d2eec2）

- **BLOCKING：无。** F2 修复确认：README 禁止清单补列 RuntimeRecoveryNotice，与 07 Project Boundaries 禁止清单逐字对齐，位置顺序一致；附带 2 个测试（removable/upstreamed 缺 commit identity 拒绝）为一致性补强；改动仅 2 个文件。

## Final verdict

**PASS**（初审与复审均无 BLOCKING；reviewedCommit `6e0cf571`、reReviewedCommit `a8d2eec2` 均通过）
