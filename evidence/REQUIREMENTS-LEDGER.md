# 需求考古台账 — 每条需求 → 实际产物 → 验收方式（2026-10-26）

> **2026-10-26 对账（发布 3.141.592656）**：R3/R13 的「96-spec mutation sweep pending」与
> 「V-27 未修」已过时。发布树 `cd5666ff` 上：V-27 由 D4 关闭
> （`test/cache-replay-usage-accounting.test.js` 3/3）；全量 mutation 覆盖 97 份 spec / 862 条
> （17 条声明 survivor），实测结果见
> [`docs/releases/ACCEPTANCE_3.141.592656.md`](../docs/releases/ACCEPTANCE_3.141.592656.md)；
> F2/F3 两条 Cascade 阻塞项已关闭。历史行保留原文，但不得再把它们当作当前状态引用。

| # | 你的原话/需求 | 实际做到 | 产物与证据 | 验收 |
|---|---|---|---|---|
| R1 | 版本跳到 3.141592654 | 发布+部署 | tag `65285ca`→`d5e7ace`；10 assets；HMC 3.141.592654 | `git ls-remote --tags`；HMC `/health` |
| R2 | 后续修复 | 发布+部署 | tag `913db70`→`c60d7469`；HMC 3.141.592655 | 同上 |
| R3 | 全量测试 | 全绿 | Win gate 6774/0/96；Linux 24/22 6853/0/5；wire 270/270；mutation 96/855（841+14） | `npm run gate`；`run-tests.mjs` |
| R4 | 历史查漏补缺 | 两份台账 | `HistoryGapAudit/gaps.md` 77 行；`KimiAuditHistory.md` 3,299 行（VERIFIED 1,292 / REFUTED 130 / STALE 410 / UNVERIFIED 136） | `grep -c` 计数 |
| R5 | 账户价值+客户端 | 已交 | ClientSandboxes2 47 记录；LiveMatrix655 38 探针；AccountMatrix 113 行 | 三份 evidence + bundle |
| R6 | kimi 5–12 分钟截断 | 根因+补丁提案 | `HubAbort/REPORT.md`：98/51,728；kimi 2.49% vs deepseek 0.176%；并发 16+ 0.947%；0/98 重试 | 报告 + usage24h.jsonl |
| R7 | 看板加色彩+UI 点评 | 已合并 | master `13a5ad04`；DashColor 49 KB + DashLayout 13 KB；对比度全过；642/642 | `check-dashboard-contrast`；dashboard tests |
| R8 | 全面代码审计 | 8 份审计 | Core 7 KB（补完中）、Handlers 52 KB（56 findings）、Api 45 KB（101 路由）、Storage 32 KB、Tests 64 KB（6 mutant 实测）、History 477 KB、Dash 2 份 | 文件 + VERDICT |
| R9 | 审计判决 | VERDICT-A/B | A：25 行（4 P0/17 P1/4 P2）；B：5 行（4 P1/1 P2）；去重 3 组后合并 **27 行 = 4 P0 + 18 P1 + 5 P2** | `VERDICT-A.md`/`VERDICT-B.md`/`VERDICT.md` |
| R10 | P0 修复 | **4/4 合入**（V-04 的 `/auth/*` / forwarded-Host 边界另见 D1，未计入关闭） | V-01/V-02/V-03/V-04 全部合入 master（批 1 `b3877065`） | `ACCEPTANCE-20261026.md` §1/§2 |
| R11 | P1 修复 | **18/18 合入**（V-08/V-10/V-13 的跨 surface / stream / 回退边界另见 D8/D2/D3） | 批 1：4 P0 + **9 P1**（V-05/06/07/09/15/16/19/20/22）；批 2：**9 P1**（V-08/10/11/12/13/14/17/18/21）+ **4 P2**（V-23/24/25/26） | master `2598299e`，gate 7,016/0/96；逐行矩阵见 `ACCEPTANCE-20261026.md` §1 |
| R12 | banner 老错误 | 已修 | `2ea7337`；run `40196003362` 绿 | CI |
| R13 | 二轮考古（未覆盖面） | 五路报告完成；终矩阵 mutation 待跑 | Transport/Update/Server/Cascade/Docs 五份 + DIRECTION 排名；Linux Node 24/22 各 7,108/0/5、wire 270/270；**96-spec mutation sweep pending** | `evidence/audit2/`、`DIRECTION.md`、`MatrixFinal.md` |

## 验收算术（2026-10-26 修正）

源台账 `evidence/audit/VERDICT.md` 的 27 行是 **4 P0 + 18 P1 + 5 P2**。
批 1 = **4 P0 + 9 P1**；批 2 = **9 P1 + 4 P2**；**V-27（P2）仍未修**。
因此 R11 的正确完成数是 **18 项 P1**（不是 19），V-23/24/25/26 是 P2，不计入 P1。
逐行 V-ID / 严重度 / 证据 / 证明测试见 `evidence/ACCEPTANCE-20261026.md` §1。

## 子 agent 实际做到的环节（核对）
- 审计文件不是空壳：全部有 file:line 行；History 3,299 行、Tests 415 行、Handlers 164 行。
- Tests 的 6 个 mutant 是**真跑过**的（KimiTestsVerify：6/6 survived，含命令与 TAP 输出）。
- Handlers 的 mutation 验证 23/23 真跑（WSL，tree clean）。
- Core 仍是半成品（56 行），已由 `DsCoreFinish` 接手补完。
- VERDICT-A/B 已合并为单一 `VERDICT.md`+`FIX-QUEUE.md`；`VERDICT.md` 的 27 行是本节算术的唯一来源。
