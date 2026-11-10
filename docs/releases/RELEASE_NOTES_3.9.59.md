# v3.9.59

修复**发布工作流超时**：`Test` job 的 `timeout-minutes` 从 10 提到 20。产品代码零改动。

## 根因（已测量）

`v3.9.58` 的 Release run `39869346098` 在 Test job 上 **正好 10 分钟**（23:04:22 → 23:14:23）被取消。506 个文件 / ~6,250 条测试在 GitHub 托管 runner 上已超过 10 分钟（本地 Linux 全量 ~8.8 分钟，Windows gate ~11.5 分钟）。10 分钟的旧上限会把“测试跑得完”误判成挂起。

## 修复

- `.github/workflows/release.yml`：`Test` job `timeout-minutes: 20`（保留 `GitHub Release` job 的 30 分钟）。
- `test/release-workflow.test.js`：断言同步为 20，避免守卫与工作流再次漂移。

## 工程与门禁

- 合入 `fix/release-timeout` `9749530`。
- `release-workflow.test.js` 绿；Linux 上同两文件 44/44。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,154 pass / 0 fail / 95 skip（506 文件）**。
- 产品代码零改动（工作流 + 一个测试），wire 与 mutation 不受影响。
- 本版之后请用 `gh release view v3.9.59` 确认 Release 与 5 个资产（含 `SHA256SUMS`）真实发布；v3.9.54–58 的 Release 因守卫/竞态/超时未发布，内容均已包含在本版。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[VERIFIED]` Release run `39871636798` **success**（Test + 两个单文件 + Docker + GitHub Release 全绿）。2026-10-25 复核：`gh run view 39871636798` → `conclusion: success`。
- `[VERIFIED]` `gh release view v3.9.59`：5 个资产（含 `SHA256SUMS`）；逐个计算哈希与清单比对 **4/4 OK**（本机 Git Bash 的 `sha256sum -c` 有兼容问题，直接比对为准）。2026-10-25 复核：`gh release view v3.9.59` → 5 assets。
