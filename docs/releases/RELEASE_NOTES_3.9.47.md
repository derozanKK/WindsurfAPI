# v3.9.47

本版把 Devin 能力卡接进账号详情：**ACU 账本、模型状态、Key 轮换、容量预检**。所有卡片只展示可观测字段；不可观测的一律显式“未知”，不编造。

## 用户可感知

- **ACU 账本**：按账号显示余额与刷新差额；`#239` 已证实付费回合的 wire 没有 per-turn billing tag，因此卡片明确标注 `no_billing_tag`，不声称逐回合扣费。
- **模型状态**：available / blocked / not_entitled / unknown 四态；`unknown ≠ not_entitled`，`freeNow` 只在 `creditNow === 0` 时为真，不放宽免费列表。
- **Key 轮换**：只显示 masked key；过期时间不可观测时显示 `not_observable`，不猜日期；只有真实换 key 才写 `keyRotatedAt`；重新登录打开预填邮箱的 modal。
- **容量预检**：上游失败时显示 `未知`（带 `upstream_unreachable`），不再显示“unlimited”；本地额度冷却与上游/池状态分开显示。
- 卡片数据走 dashboard 鉴权路由，模型输入做白名单/长度约束，缓存 key 哈希；i18n en/zh 1383 键完全一致；1440/390 无横向溢出。

回归：3 个新测试文件 **60/60**；相关批次 **194/194**；截图断言 25/25、0 console error；独立审查无 P1/P2（仅两条 P3：预检缓存无淘汰、失败卡片在抽屉会话内缓存）。

## 工程与门禁

- 合入 `feat/devin-cards` `39e7fef`（基于 `b3dea2c`，与 3.9.46 的 balance 修复无冲突）；合并后修了一处测试切片依赖（ledger helper 移入 refresh 块）。
- Windows `npm run test:release`：**5,691 pass / 0 fail / 82 skip（467 文件，5,773 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="..." npm run gate`：**PASS exit=0** —— 全部子门绿（`spec-baseline-check` 在修复后通过）。
- Linux `npm run test:release`（HMC，Node v24.21.0，467 文件）：**5,772 pass / 0 fail / 1 skip（5,773 tests）**，exit 0。
- mutation：`dashboard-connect-parity`、`gap-dashboard-loopback-proxy`、`web-search-exposure` 三个受影响规格 exit 0。
- wire：对 `v3.9.46`（`c720a56`）基线 270/270 比较相同（见发布提交）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实上游的容量预检答案与团队计费 RPC。
- `[UNVERIFIED]` 真实账号在 1440/390 之外的视口。
