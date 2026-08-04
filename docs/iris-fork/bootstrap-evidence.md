# R0-P0 Bootstrap Evidence（blueforst/pi fork 基线）

本文件记录 R0-P0 "Production Baseline & Pi Fork Bootstrap" 交付时的真实状态与运行结果。所有数据来自实际命令输出；未做/未验证的事项如实标注。

## 1. 任务信息

- 任务日期：2026-08-04
- 分支：`iris/r0-p0-fork-baseline`（自 `blueforst/pi` 的 `main` 创建）
- 仓库：`blueforst/pi`（fork），`earendil-works/pi`（upstream）
- 交付物：7 项（production-lock.json、carried-patches.json、README.md、validator+测试、root check 接入、CI 行为确认、本 evidence）

## 2. 基线（Baselines）

| 项 | 值 |
| --- | --- |
| fork main（= merge-base = 分支创建点） | `ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1` |
| upstream main（观察/验证点） | `e741cb05ca7c1c7bc5a9664c99697df32de9fac6` |
| 验证日期 | 2026-08-04 |
| divergence | fork 是 upstream 的祖先；fork-only commits = 0；upstream-only commits = 6 |
| 同步决策 | **不同步 upstream**，本 PR 从当前 fork main 开始（见 §2.1） |

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

## 4. Validator 与测试

- 无第三方依赖（仅 `node:` 内置模块）。
- Fail-closed：15 类失败条件全部覆盖（JSON 解析失败、schemaVersion 不支持、必填字段缺失、占位符、SHA 格式、零 SHA、repo 不匹配、依赖方向错误、patch id 重复、patch status 不支持、upstream status 不支持、无 tests、无 removal condition、patch commit 格式错误、upstream base 不一致）。
- 测试：`scripts/check-iris-fork-baseline.test.mjs`，19 个用例，全部使用临时 fixtures（`mkdtempSync`），不修改真实 manifest；最后一个用例用默认路径验证真实 manifest 通过。

### 4.1 实际运行结果

```
$ node --test scripts/check-iris-fork-baseline.test.mjs
ℹ tests 19
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 557.249459

$ npm run check:iris-fork
OK: iris fork baseline manifests are valid
```

## 5. Root check 接入与 CI

- `package.json` 新增 `"check:iris-fork": "node scripts/check-iris-fork-baseline.mjs"`，并追加 `&& npm run check:iris-fork` 到 `check` 链末尾（不改变既有顺序）。
- 无依赖变化、无 lockfile 变化（仅 scripts 修改；pre-commit 的 lockfile 检查只比对依赖条目）。
- **CI：不新增 workflow**。现有 `.github/workflows/ci.yml` 的 PR job 已运行 `npm run check`（checkout → setup-node 22 → `npm ci --ignore-scripts` → build → check → test），validator 随之在普通 PR CI 中运行，且无网络依赖。注：由于 §5.2 的 tsgo pre-existing 失败使 check 链在 CI 中短路，当前 `check:iris-fork` 实际不会执行到；该问题随 fork 落后治理解决后生效。

### 5.1 `npm run check` 完整结果（2026-08-04）

`npm run check` 在本机执行，输出见 `/tmp/iris-check-output.txt`（本次会话完整存档）。逐段结果：

1. `biome check --write --error-on-warnings .`：**通过**。`Checked 1012 files`。首次运行（输出未存档）曾出现 1 个 info：biome CLI 自报版本 2.4.6，与 `biome.json` schema 声明 2.3.5 不一致（`npm ls @biomejs/biome` 确认安装版本为 2.3.5）；第二次运行存档 `/tmp/iris-check-output.txt` 中无该 info 行。该 info 非 error，不影响通过。首次运行时 biome 曾以 `--write` 重排 17 个 packages/*/test 文件（版本漂移的格式化差异），已全部 `git checkout` 恢复，工作树最终只含本任务文件。
2. `check:pinned-deps`：通过。
3. `check:ts-imports`：通过。
4. `check:shrinkwrap`：`packages/coding-agent/npm-shrinkwrap.json is up to date`。
5. `check:install-lock:coding-agent`：`packages/coding-agent/install-lock is up to date`。
6. `tsgo --noEmit`：**失败（exit 2），744 个错误**。按错误码拆分（`grep -o "error TS[0-9]*"` 统计）：TS2345 ×655、TS2344 ×38、TS2339 ×31、TS7053 ×14、TS18046 ×3、TS2698 ×2、TS2322 ×1。样例：`packages/agent/test/agent.test.ts(122,42): Argument of type '"gpt-4o-mini"' is not assignable to parameter of type 'never'`（TS2345）。
7. 因 6 失败，`check:browser-smoke` 与 `check:iris-fork` 未执行（链式短路）。**因此在当前 fork 状态下，`check:iris-fork` 在本机与 PR CI 中实际执行不到**；待 tsgo 问题解决后随 `npm run check` 生效。

### 5.2 tsgo 失败定性：fork main pre-existing，与本 PR 无关

- 机制：`packages/ai/src/providers/all.ts` 的 `getBuiltinModel<TProvider, TModelId extends keyof (typeof MODELS)[TProvider]>` 中，`keyof MODELS[provider]` 因模型目录类型漂移退化为 `never`，导致测试中所有模型名字面量调用报错。
- 验证：在**不含本任务任何改动的干净 HEAD**（独立 worktree `/tmp/pi-head-check`，符号链接主仓库 node_modules）上运行 `npx tsgo --noEmit 2>&1 | grep -c "error TS"`，输出 `744`（与主工作树一致）。**pre-existing 确认**（该 worktree 已清理，验证命令与输出如上）。
- 结论：本 PR 未引入任何 TS 改动（交付物为 docs/、scripts/*.mjs、package.json scripts），该失败属于 fork 落后 upstream 6 commits 所暴露的类型漂移症状之一。修复它需要大范围改动 packages/ 或先完成 upstream 同步，超出 R0-P0 交付范围，故不在此 PR 修复。PR CI 的 build-check-test job 预期会因该 pre-existing 问题失败（与本 PR 内容无关），后续 R0 工作需先解决 fork 落后问题。

## 6. 未实现清单（明确声明，不宣称 R0 complete）

以下内容**未实现**，不属于本交付：

- Provider Context Controller
- RuntimeEvent
- SessionCommitReceipt
- explicit close 语义
- sequenced archive API
- package publication（publishStatus = `not_published`；所有 workspace 包仍为 `@earendil-works/pi-*` 身份，version 0.83.0，与 upstream 相同——未建立独立 package identity）
- R1 vertical slice
- Iris Context / Historian / Persona / Memory 相关实现（属于 `iris_agent` / `iris_memory` 边界，禁止进入本仓库）
- upstream 同步（fork 落后 6 commits，已记录，未执行同步）

本交付完成的仅是 R0-P0 中的 fork 基线治理部分（7 项交付物），**不宣称 R0 complete**。

## 7. 已知限制与后续

- 提交行为：本地 `npm ci --ignore-scripts` 未运行 husky 的 `prepare`，`.git/hooks/pre-commit` 未注册（`ls .git/hooks/` 仅 `.sample` 文件），因此本 commit 未被 pre-commit hook 拦截。`npm run check` 的实际结果见 §5.1（tsgo pre-existing 失败）。CI 不依赖 hooks：`.github/workflows/ci.yml` 直接运行 `npm run check`。
- PR 目标 `blueforst/pi:main`；提交经过两个独立 subagent 审查（规格/边界 + 代码/测试/CI），审查记录写入 `docs/iris-fork/reviews/`。
- fork 落后状态需要在后续工作（独立于本 PR）按 README §3 流程处理。
- 本机环境 Node v24.11.0（满足 engines `>=22.19.0`）；npm 警告 `Unknown project config "min-release-age"` 为仓库既有配置，非本任务引入。
