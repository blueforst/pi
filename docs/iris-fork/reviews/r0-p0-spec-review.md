# R0-P0 规格与边界审查记录（Reviewer A）

- 审查日期：2026-08-04
- 审查对象：`blueforst/pi` 分支 `iris/r0-p0-fork-baseline` 工作树（审查时未提交，最终以单个 commit 提交）
- 审查者：独立 subagent（Reviewer A，规格与边界）
- 审查文件：
  - `docs/iris-fork/production-lock.json`
  - `docs/iris-fork/carried-patches.json`
  - `docs/iris-fork/README.md`
  - `docs/iris-fork/bootstrap-evidence.md`
  - `package.json`（check:iris-fork 接入）
  - `.github/workflows/ci.yml`（CI 结论评估，未改动）

## 执行命令

- `node --test scripts/check-iris-fork-baseline.test.mjs` → 19 pass / 0 fail（初审时）
- `npm run check:iris-fork` → `OK: iris fork baseline manifests are valid`
- `git status --short` / `git diff --stat` / `git diff package.json` → 改动仅限任务文件
- `git merge-base` / `rev-parse` / `log` / `rev-list` → 验证全部 SHA 与 divergence 声明

## Findings

### 规格符合性（全部通过，无 BLOCKING）

- Manifest 16 个必填字段全部合规：三个 SHA（ab5f8d88… / e741cb05… / e741cb05…）均为 40 位 hex 且经 git 验证真实存在；无 TBD/TODO/unknown/零 SHA；日期 ISO；immutable upstream base 与 fork baseline 区分正确；package identity 诚实（8 个 workspace 包实测均为 `@earendil-works/pi-*` v0.83.0 → `inherits_upstream_package_names` + `not_published` 合理）。
- carried-patches.json 空 `patches` 数组合法；`upstreamBaseCommit` 与 lock 交叉一致；README 明确空集语义。
- README 覆盖全部五项规格：Ownership（禁止 Iris Context/P0–P5/Historian/Persona/Memory 等）、Sync procedure（fetch→inspect→checks→update lock→re-evaluate→remove satisfied→evidence）、Patch lifecycle、Release/package identity 诚实性、Evidence 要求。
- evidence 关键事实（SHA、divergence = 6 upstream-only / 0 fork-only、commit 清单、19/19 测试、未实现清单、不宣称 R0 complete）全部经 git 实测复核一致。
- 边界泄漏检查通过：改动仅 `M package.json` + `?? docs/` + 两个 scripts；无 Iris 专属层代码进入本仓库。
- CI 结论成立：现有 ci.yml PR job 运行 `npm run check`（已含 check:iris-fork），无网络依赖，无需新 workflow。

### 修复项（初审 NON-BLOCKING → 已修复，复审通过）

- F7：evidence §5.1 错误码拆分（TS2345 ×655 等，744 总数）。
- F8：evidence §5.2 内联 worktree 验证命令与输出。
- F9：evidence §5.1 注明 biome 2.4.6 info 行来源（首次运行，未存档；npm ls 确认安装版本 2.3.5）。
- F11：evidence §5.1/§5 补充说明 tsgo 短路导致 check:iris-fork 当前在 CI 实际执行不到。
- F10（忽略）：`duration_ms` 运行时波动，非造假。

## 最终结论

**VERDICT: PASS**（无 BLOCKING；初审与复审均通过）
