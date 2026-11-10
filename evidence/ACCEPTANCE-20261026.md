# 验收证据 — P0/P1/P2 修复批次（master `2598299e`）

> **2026-10-26 对账（发布 3.141.592656）**：本文件是 `2598299e` 的历史验收记录。以下旧陈述已被
> [`docs/releases/ACCEPTANCE_3.141.592656.md`](../docs/releases/ACCEPTANCE_3.141.592656.md) 取代，
> 不得当作当前状态：V-27「未修」（D4 已关闭，`test/cache-replay-usage-accounting.test.js` 3/3）；
> V-10/V-13/V-08/V-04 的开放边界（分别由 D2/D3/D8/D1 关闭）；「96-spec mutation sweep pending」
> （发布树实测 97/97，见附录）；「master 2598299e / 3.141.592656 不存在」（发布树已到
> `cd5666ff` 的 3.141.592656 准备提交）。历史段落保留原文，但不得再把它们当作当前状态引用。

本文件记录两批修复的实际覆盖，并修正旧版的验收算术。**算术源**是
`evidence/audit/VERDICT.md` 的 27 行去重台账，不是本文件的叙述：

| 严重度 | 行数 | 行 |
|---|---:|---|
| P0 | 4 | V-01 / V-02 / V-03 / V-04 |
| P1 | 18 | V-05–V-22（连续 18 行，无跳号） |
| P2 | 5 | V-23 / V-24 / V-25 / V-26 / V-27 |
| **合计** | **27** | |

批次切分（按合并顺序，不按严重度重排）：

| 批次 | 树 | 内容 | 行数 |
|---|---|---|---:|
| 批 1 | `b3877065`（最后一个 src 提交 `5d603c3d`） | **4 P0 + 9 P1**：V-01/02/03/04、V-05/06/07/09/15/16/19/20/22 | 13 |
| 批 2 | `2598299e`（最后一个 src 提交 `2b4897e9`） | **9 P1 + 4 P2**：V-08/10/11/12/13/14/17/18/21、V-23/24/25/26 | 13 |
| 未修 | — | **V-27（P2）** | 1 |

旧版两处算术是错的，已改：批 1 不是「10 个 P1 根因」（是 **9** 个 P1）；
`REQUIREMENTS-LEDGER.md` 的「19 项 P1」也不是 18 个 P1 行（批 1 的 9 + 批 2 的 9）。
V-23/24/25/26 是 **P2**，不能计入 P1 完成数。

## 1. 逐行矩阵（V-ID / 严重度 / 批次 / 证据 / 证明测试）

状态词：**已合入** = 该行的具名机制有红先测试并已进 master；**边界未闭** = 该行
原始范围已合入，但二轮审计（`evidence/audit2/`）在同一机制的另一条调用路径上复现了
缺口，不能当作整行关闭；**未修** = 没有实现。

| V-ID | 严重度 | 批次 / 提交 | 状态 | 证据 | 证明测试 |
|---|---|---|---|---|---|
| V-01 | P0 | 批 1 / `bef123c8` | 已合入 | `evidence/FixA01.md` | `test/tool-emulation-salvage-provenance.test.js` |
| V-02 | P0 | 批 1 / `5b932eb3` | 已合入 | `evidence/FixA02.md` | `test/messages-tool-json-validation.test.js` |
| V-03 | P0 | 批 1 / `00c06d01` | 已合入 | `evidence/FixA03.md` | `test/response-store-write-ownership.test.js` |
| V-04 | P0（open-local） | 批 1 / `41e196c0` | 已合入；`/auth/*` 与 forwarded-Host 边界未闭（D1） | `evidence/FixA04A05.md`；`evidence/audit2/Server.md` S01/S02 | `test/dashboard-mutation-guard.test.js` |
| V-05 | P1（与 V-04 同链时 P0） | 批 1 / `41e196c0` | 已合入 | `evidence/FixA04A05.md` | `test/langserver-update-integrity.test.js` |
| V-06 | P1 | 批 1 / `5b932eb3` | 已合入 | `evidence/FixA06A07.md` | `test/stream-error.test.js`、`test/cascade-poll-truncation-terminal.test.js` |
| V-07 | P1 | 批 1 / `5b932eb3` | 已合入 | `evidence/FixA06A07.md` | `test/chat-tool-choice-parity.test.js` |
| V-08 | P1 | 批 2 / `ae1cbe0a`（merge `2b4897e9`） | 已合入；Messages/Gemini 未传播 verdict（D8） | `evidence/FixV08V10V12V14.md`；`evidence/audit2/Transport.md` A.2 | `test/connect-stream-backpressure-drain.test.js` |
| V-09 | P1 | 批 1 / `5b932eb3` | 已合入 | `evidence/FixP03.md` | `test/responses-input-file-connect.test.js` |
| V-10 | P1 | 批 2 / `ae1cbe0a` | 已合入；Connect **stream** 分支未校验（D2） | `evidence/FixV08V10V12V14.md`；`evidence/audit2/Transport.md` 附录 A | `test/structured-output-schema.test.js` |
| V-11 | P1 | 批 2 / `6259b1a5`（merge `d43ee185`） | 已合入 | `evidence/FixV11.md` | `test/tool-emulation-overlimit.test.js` |
| V-12 | P1 | 批 2 / `ae1cbe0a` | 已合入 | `evidence/FixV08V10V12V14.md` | `test/responses-tool-history-persistence.test.js` |
| V-13 | P1（gated） | 批 2 / `4462021e`（merge `de8c1e5c`） | 已合入；reuse→fresh 回退丢历史（D3） | `evidence/FixV13.md`；`evidence/audit2/Cascade.md` F1 | `test/cascade-native-bridge.test.js` |
| V-14 | P1（Cascade only） | 批 2 / `ae1cbe0a` | 已合入 | `evidence/FixV08V10V12V14.md` | `test/cascade-completion-controls.test.js` |
| V-15 | P1 | 批 1 / `cb12398e` | 已合入 | `evidence/FixP04.md` | `test/connect-exact-cache.test.js` |
| V-16 | P1 | 批 1 / `faba39d6` | 已合入 | `evidence/FixA16.md` | `test/auth-terminal-states.test.js` |
| V-17 | P1 | 批 2 / `072ce6d6`（merge `1c65e776`） | 已合入 | `evidence/FixV17V18V26.md` | `test/auth-reserve-inherit.test.js` |
| V-18 | P1 | 批 2 / `072ce6d6` | 已合入 | `evidence/FixV17V18V26.md` | `test/auth-quota-cooldown-monotonic.test.js` |
| V-19 | P1 | 批 1 / `00c06d01` | 已合入 | `evidence/FixA19A20.md` | `test/response-store-atomicity.test.js` |
| V-20 | P1 | 批 1 / `00c06d01` | 已合入 | `evidence/FixA19A20.md` | `test/response-store-hardening.test.js` |
| V-21 | P1 | 批 2 / `17cbff4f`（merge `475c5660`） | 已合入 | 提交说明（`fix(dashboard): atomic credentials…`） | `test/dashboard-credentials-route.test.js` |
| V-22 | P1 | 批 1 / `5d603c3d` | 已合入 | `evidence/FixP01.md` | `test/stats-prototype-pollution.test.js` |
| V-23 | P2 | 批 2 / `6667635c`（merge `ae83851d`） | 已合入 | `evidence/FixV23.md` | `test/response-store-argument-integrity.test.js` |
| V-24 | P2 | 批 2 / `17cbff4f` | 已合入 | 提交说明（同一提交） | `test/windsurf-login-identity.test.js` |
| V-25 | P2 | 批 2 / `17cbff4f` | 已合入 | 提交说明（同一提交） | `test/dashboard-batch-import-redaction.test.js` |
| V-26 | P2 | 批 2 / `072ce6d6` | 已合入；delete+re-add ABA 子claim 未复现（pinned control） | `evidence/FixV17V18V26.md` | `test/auth-snapshot-epoch.test.js` |
| V-27 | P2 | **未修 → 已修（D4，2026-10-26）** | 开放；无实现、无测试（历史；D4 已关闭：`test/cache-replay-usage-accounting.test.js` 3/3） | `evidence/audit/FIX-QUEUE.md:76`（排队）；`evidence/audit2/Transport.md` 只做静态确认；`evidence/FixD2D3D4D5.md` §D4 | 前瞻：`test/cache-replay-usage-accounting.test.js`（D4 前尚不存在；现已存在并 3/3） |

矩阵口径：每一行的「证明测试」都在本树存在（V-27 的前瞻文件除外，已注明尚不存在）；
「已合入」不等于该行在所有调用路径上关闭 —— 四个「边界未闭」的 V 行是二轮审计的
具体复现，不是推测。

## 2. 批 1（`b3877065`）

| 行 | 修复 | 提交 | 红先证据 | 验证 |
|---|---|---|---|---|
| V-03/V-19/V-20 | response-store 归属/原子写/字节预算/收敛裁剪 | `00c06d01` | 16/20 红 → 20/20 绿 | 目标 173/173；全量 6822/0 |
| V-01 | salvage 只在 provenance-safe 文本上运行 | `bef123c8` | 10 红 → 20/20 绿 | 413/413、589/589；全量 6924/0 |
| V-02/V-06/V-07/V-09 | Messages 坏 JSON 失败；Cascade 终止真相；工具契约；input_file 400 | `5b932eb3` | 各自红先 | 目标 589/589；全量 6923/0 |
| V-15 | reasoning 只提交胜出尝试 | `cb12398e` | 2/2 红 → 2/2 绿 | 99/99、201/201；全量 6804/0 |
| V-16 | 运营终态 disabled/banned 权威 | `faba39d6` | 18 红 → 21/21 绿 | 1469/0；全量 6823/0 |
| V-04/V-05 | dashboard 变更门 + LS 更新完整性 | `41e196c0` | 14 红 → 20/20 绿 | dashboard 654/654；全量 6848/0 |
| V-22 | stats 原型污染 | `5d603c3d` | 7 红 → 8/8 绿 | 709/709；全量 6924/0 |

**批 1 全门禁（集成后）**：`npm run gate` PASS；spec-static 96 specs/855；
spec-baseline 12 affected specs 0 drift；secret-scan PASS；`test:release`
**6,924 pass / 0 fail / 96 skip（574 文件）**。全量 `run-tests.mjs`：
7,020 tests / 6,924 pass / 0 fail / 96 skip。mutation：12 个受影响 spec 全部重测通过
（baseline 重钉 5 个：reasoning-continuity 328、responses-stream-done-sentinel 71、
retry-rescue-budget-split 91、response-id-entropy-guard 69、
responses-post-tool-text-item 84、terminal-event-guard 27、usage-unknown-not-zero 74）。

**批 1 wire**：`b3877065` vs `v3.141.592655`（`c60d7469`）**270 比较 / 270 字节一致 /
0 差异**（17 个提交逐一复测均 0）。控制组 `c60d7469` vs `v3.10.1`：258 一致 + 12 条
已登记 #273 差异（allowlist 精确命中）。结论：批 1 不改请求字节，下一版无需新增
wire 条目。

## 3. 批 2（`2598299e`）

| 行 | 修复 | 提交 | 证据 |
|---|---|---|---|
| V-08/V-10/V-12/V-14 | bounded writer、真实 schema 校验、ordered items、Cascade 完成控制 | `ae1cbe0a`（merge `2b4897e9`） | `evidence/FixV08V10V12V14.md` |
| V-13 | 观测门 + 失败/未映射历史保真 | `4462021e`（merge `de8c1e5c`） | `evidence/FixV13.md` |
| V-11 | over-limit 按构造丢弃、chunk 无关 | `6259b1a5`（merge `d43ee185`） | `evidence/FixV11.md` |
| V-17/V-18/V-26 | reserve inherit、配额冷却单调、快照 epoch 绑定 | `072ce6d6`（merge `1c65e776`） | `evidence/FixV17V18V26.md` |
| V-21/V-24/V-25 | 原子凭证、登录身份、批量导入脱敏 | `17cbff4f`（merge `475c5660`） | 提交说明 + 三个测试文件 |
| V-23 | 工具参数不被裁剪、丢弃可见 | `6667635c`（merge `ae83851d`） | `evidence/FixV23.md` |

**批 2 门禁（报告值，不是本方向审计的重跑）**：`REQUIREMENTS-LEDGER.md` 记录合并后
gate **7,016 pass / 0 fail / 96 skip**。二轮审计的 fresh-clone Linux 终树
（`evidence/audit2/MatrixFinal.md`）在 Node 24.21.0 与 22.23.4 上各 **7,108 pass /
0 fail / 5 skip（7,113 tests / 584 files）**；wire 对 `v3.141.592655` **270/270
字节一致、0 差异、allowlist 为空**。**96-spec mutation sweep 仍为 pending**
（历史；`MatrixFinal.md` §4 是 `2598299e` 的旧结论；发布树实测 97 份 spec / 862 条，见
`docs/releases/ACCEPTANCE_3.141.592656.md`）—— 不得把 Linux 全绿当作 mutation 已验。

## 4. 未关闭项与发布真相

> **2026-10-26 对账**：本节以下各条是 `2598299e` 时的状态，已被
> [`docs/releases/ACCEPTANCE_3.141.592656.md`](../docs/releases/ACCEPTANCE_3.141.592656.md) 取代：
> V-27 已由 D4 关闭；V-10/V-08/V-13/V-04 的边界分别由 D2/D8/D3/D1 关闭；mutation sweep 已在
> 发布树完成 97/97；版本真相更新为 `3.141.592656` 的准备提交 `cd5666ff`（tag 尚未创建）。

- **V-27（P2）未修**：缓存命中仍可能被 additive upstream credit/token recorder 记账。
  `evidence/audit/FIX-QUEUE.md:76` 仍要求真实的 cache-replay 记账测试；D4 的
  `test/cache-replay-usage-accounting.test.js` 是前瞻验收门，尚不存在。
- **V-10 / Connect streaming 未全闭**：`structuredOutputViolation()` 在
  `src/handlers/chat.js:1268-1274` 校验非流式与 buffered Cascade；Connect `stream`
  分支把模型文本原样透传（`evidence/FixV08V10V12V14.md` 的 Known boundary）。
- **V-08 / 跨surface 背压未全闭**：`src/handlers/messages.js:2006-2017` 与
  `src/handlers/gemini.js:739-746` 仍未把 socket verdict 传回生产者（D8）。
- **V-13 / reuse→fresh 回退是已复现的 P1**：`evidence/audit2/Cascade.md` F1 测得
  fresh 控制 = 3 个 field-9 step，正常 reuse delta = 1，expired-resume fresh restart = 1
  （不是 3）；`src/client.js:1206-1229` 只恢复 text/images，`:1284` 清 `reuseEntry`（D3）。
- **V-04 / Host 边界未闭**：`evidence/audit2/Server.md` S02 复现 open-local 下
  `GET /auth/accounts`、`POST /auth/login` 带 `Host: attacker.example` 仍 200，
  而 `/dashboard/api/accounts` 正确 403；S01 显示 trust-proxy 模式下未列入
  `DASHBOARD_ALLOWED_HOSTS` 的 forwarded Host 可绕过（D1）。
- **版本真相**：最后一个已发布 tag 是 **`v3.141.592655`**，annotated tag 指向
  `c60d7469`（`git rev-list -n1 v3.141.592655`），`package.json` 仍是
  `3.141.592655`。master `2598299e` 在 tag 之后 **34 个提交**，两批修复均**未发版**；
  **`3.141.592656` 不存在**。批 1 末尾的「建议发 3.141.592656」只是建议，不是已执行事实。
- **发布评估**：批 1 的 4 P0 + 9 P1 有红先与全量证据；批 2 的 9 P1 + 4 P2 有红先证据，
  但 V-10/V-13 与 D1/D8 的开放边界、pending 的 mutation sweep、以及
  `[UNVERIFIED]` 的 live 402/配额/凭证轮换意味着**不能按现有绿色矩阵直接发布**。
  先关闭 D1–D5，再重跑完整矩阵（含 mutation），然后才评估 release/tag。
