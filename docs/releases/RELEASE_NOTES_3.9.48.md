# v3.9.48

本版是登录、账号页安全、模型免费/配额判定、以及请求预算与预内容状态四条线的合并。没有协议兼容性破坏；新增两个默认开启的请求预算（可用 env 关闭/调整）。

## 用户可感知

### 登录：不存在的邮箱不再被当成“验证码账号”，验证码流程可重试

- `connections` 的 `auth_method.method:"not_found"` 现在映射为 `userExists:false`，登录返回 `ERR_EMAIL_NOT_FOUND`，不再给出验证码入口，也不计入邮箱锁定。
- 上游 401 `Invalid verification token` 不再算“验证码错误”，不会把密码登录一起锁 15 分钟；过期/错误/传输失败分成 `ERR_EMAIL_FLOW_EXPIRED` / 错误码 / `ERR_EMAIL_VERIFY_UNAVAILABLE`。
- `email/start` 只发一次（不再 5xx 重试导致 7 秒 3 封邮件）；发送失败也启动 30 秒冷却。
- 验证码在 PostAuth 失败时可重试（2 分钟 / 3 次），只有真正换到 session token 才标记一次性。
- 导入：`show-auth-token` / 任意 `scheme://` token 链接、纯 token 行、批量 token 行都可识别；`auth1_` 仍拒绝；token 不写日志。

### 账号页：批量删除不再误删隐藏行，封禁账号不再显示绿色

- 筛选/搜索/层级/仅异常变化会清空选择；批量操作带筛选签名，过期选择被拒绝；删除确认写明“已勾选 N” vs “当前筛选全部 N”。
- 新增 `banned` 状态（排在 disabled 之后）：徽章/色带/筛选/抽屉一致，`bannedAt`/脱敏 `bannedReason` 可见，计入停用与 `filter=flagged`。
- 探测结果区分 attempted/ok/fail/skip；`skipped` 不再算成功，工具栏不再永远“正在探测 0/N”。

### 模型：免费/付费按账号真实 costTier，配额消息正确分类

- `daily usage quota has been exhausted` 及 on-demand/weekly/balance 变体现在归类为 `QUOTA_EXHAUSTED` → 402 `insufficient_quota`，不再 502 且不再增加 internal-error breaker。
- 免费/付费徽章由账号的 `modelCostTier`/`promoStatus` 驱动：`swe-2-medium/high/max` 显示 FREE（促销至 2026-11-01），幽灵 `swe-1-6-slow` 显示 not-in-catalog；静态白名单只作无实时数据时的回退。
- `inferTier` 以 planName 为下限；canary 失败得到 unknown，不再把 Pro 降成 free/expired。

### 可靠性：预内容失败保留真实 HTTP 状态；一个请求一个预算

- 提交门只在**第一次写入**时启动；池等待/预内容失败不再先发 200，而是返回真实的 429/503 + `Retry-After`（四条流式路由都覆盖）。
- 新增 `src/request-budget.js`：路由持有绝对 deadline（默认 600 s / 流式 300 s，env 可调），所有队列等待、退避、轮询、failover 只能缩短它；上游轮次硬上限 6；耗尽返回 504 类错误且不再重试。
- 空池快速失败：非流式直接 429，流式在提交前返回 429 + `retry_after_ms`，不再等 30 秒。

回归：登录 25 条（父提交 4 pass / 21 fail）、账号页 193+76、模型全量 5,718/0/82、可靠性 15 条 + 91 SSE/retry + 32 queue、合并树 touched 164/164。独立审查：Login PASS、Reliability PASS、Account UI 无 P1/P2。

## 工程与门禁

- 合入 4 条分支（均基于 `8a4fcc6`）：`fix/login-notfound` `a664ecd`、`fix/account-ui-safety` `6305425`、`fix/model-free-list` `7bf51f6`、`fix/precontent-status` `10e5613`；合并后更新两条 mutation baseline pin（credit-cost 197、reasoning-continuity 326）。
- Windows `npm run test:release`：**5,773 pass / 0 fail / 82 skip（473 文件，5,855 tests）**，exit 0。
- Windows `npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，473 文件）：**5,854 pass / 0 fail / 1 skip（5,855 tests）**，exit 0。
- mutation：`sticky-queue-on-pin`、`cascade-metadata-egress`、`dashboard-connect-parity`、`credit-cost-top-level` 四个受影响规格 exit 0。
- wire：对 `v3.9.46`（`c720a56`，3.9.48 分支的最后一个严格祖先 release tag）**270/270 比较相同**，exit 0。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实邮箱验证码的 `email/complete` 与 PostAuth。
- `[UNVERIFIED]` 真实上游的预内容 429/503 状态（fake upstream 覆盖）。
- `[UNVERIFIED]` 真实慢客户端与进程级内存。
