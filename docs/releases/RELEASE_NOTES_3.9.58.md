# v3.9.58

修复**重试预算竞态**——v3.9.57 CI 唯一的失败点。产品行为只在“预算已经不够退避”时变化：不再发起一次注定被拒的重试，而是直接抛出真实的上游错误。

## 根因（已确定性复现）

`budgetedSleep(ms, budget)` 原来睡 `min(backoff, remainingMs)`，然后返回 `remainingMs() > 0`。计时器粒度让它在只剩 <1ms 时仍返回成功，而两条重试循环的 `canStartAttempt()` 检查在**睡眠之前**，于是第 2 次上游调用被发出（CI：`calls 2 !== 1`，`test/request-budget.test.js:129`）。

## 修复

- `budgetedSleep`：预算不足以覆盖**完整**退避时返回 `false`，不再“睡一个截断值然后报成功”。
- 非流式（`toChatCompletion`）与流式（`streamChatCompletion`）两条循环：退避之后再次 `canStartAttempt()`，失败则抛出原始 `err`。
- 外层循环继续抛真实上游错误；内层 empty/rescue 分支继续用自己的预算错误，语义不变。

## 测试（四个，确定性，无墙钟）

- 桩：`canStartAttempt()` 睡眠前 true、睡眠后 false，`remainingMs()` 为正，使用真实 `budgetedSleep`（1ms）→ 不得发起重试。
- 桩：剩余 5ms、退避 400ms → 不得“睡 5ms 后重试”。
- 两条循环各一对。修复前全红（`2 !== 1`、`4 !== 1`），修复后 11/11 绿。
- mutation：单独删非流式后检查 → 1 红；单独删流式后检查 → 1 红；恢复旧的截断睡眠 → 2 红。

## 工程与门禁

- 合入 `fix/budget-race` `5d44eab`。
- 相关套件 163/163 + 77/77；`node --check` 通过。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,154 pass / 0 fail / 95 skip（506 文件）**。
- Linux `npm run test:release`（HMC，Node v24.21.0，506 文件）：**6,246 pass / 0 fail / 3 skip**。
- wire：对 `v3.9.57`（`fd7d3ee`）比较 **270/270**。
- mutation：全部 **85 个规格 exit 0**（无 survivor）。
- 本版之后请用 `gh release view v3.9.58` 确认 Release 与 5 个资产（含 `SHA256SUMS`）真实发布；v3.9.54–57 的 Release 因守卫/竞态未发布，内容均已包含在本版。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 Actions 执行（本地 gate + Linux 全量 + 强制 ref clone 已复现对象形态）。
- `[UNVERIFIED]` 真实上游在预算边界的行为（fake upstream）。
