# v3.9.51

本版两条：**登录流程 wave 3（双 host 探测、无密码账号、Token 导入、验证码 UI）** 与 **ACU/用量面板**。没有协议兼容性破坏。

## 用户可感知

### 登录：根因确认，路径收敛

Owner 遇到的“正确密码也报 `ERR_INVALID_CREDENTIALS`”根因是 **3.9.44 之前的构建把 email-code connection 的 `enabled` 当成“有密码”**（`git show v3.9.41:…:447`）。该账号 `has_password:false`，上游必然 401。3.9.44 已修正分类；本版把剩余路径收敛：

- **双 host 探测**（flag 门控）并记住应答 host；`connections: []` 视为“未知”而不是“无账号”；400/422 视为终态 `ERR_INVALID_EMAIL`。
- **未知探测 + 密码被拒** 时再问一次 method → `ERR_NO_PASSWORD_OAUTH_ACCOUNT`，不计锁；否则错误携带 `probeUnknown` + `alternatives`。
- **Auth1 先于 Firebase**（Firebase 被 App Check 挡住时不再白等）。
- `email/start` 在探测/显式选择的 host 上发送；新增 **无状态 `POST /windsurf-login/token`**（裸 token / show-auth-token 值 / deep link / 完整 URL），不再依赖 `/oauth/start` 会话，`ERR_INVALID_STATE` 消失。
- UI：登录页“从 windsurf.com 获取 Token”三步 + 一键剪贴板导入；验证码表单显示“已发送到 …”、发送按钮倒计时、live region、未拿到 flow 前禁用验证、改邮箱即丢弃 flow、“改用 app.devin.ai 发送”。
- `scripts/token-capture.mjs`：本地 CDP 轮询 `GetOneTimeAuthToken` 与页面输入框并导入，**不写 token 到磁盘**。

回归：`test/login-flow-wave3.test.js` 27/27；登录/dashboard/import 扫描 552/552；6 个定向突变被抓；headless Chrome 登录 tab 14/14、0 console error；日志包装测试证明 token/code 不进日志。

### ACU / 用量面板

- 新 `GET /dashboard/api/usage/orgs`（鉴权、no-store、`?refresh=1`），按 org 去重（同一 team 多账号不再重复计数），hash-only `orgref-*`。
- 面板：每日 ACU 上限（null 显示 ∞）、已用、派生剩余（明确标注 limit−used）、最新一天、cycle 日期、每日表、按产品表与占比、cached/stale/partial 徽章、空/错误态；每个 org 一个 tab。
- `usage.js`：缺失的每日 `amount`/`cumulative`、产品 `total` 保持 `null`（显示 —），不再编造 0。

回归：ACU 相关 32/32 + 14 套件 181/181；dashboard smoke 1/1；i18n 1497=1497。

## 工程与门禁

- 合入 2 条分支（均基于 `ec4e599`）：`fix/login-flows-wave3` `821b804`、`feat/acu-usage-cards` `26b50a4`；合并后补一条“非 auth1 探测方法直接走 legacy”的路由修正，并更新两条测试到新顺序。
- Windows `npm run test:release`：**5,910 pass / 0 fail / 82 skip（487 文件，5,992 tests）**，exit 0。
- Windows `npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，487 文件）：**5,991 pass / 0 fail / 1 skip（5,992 tests）**，exit 0。合并期间发现 `test/chat-cache-hit.test.js` 在装有真实 LS 的 HMC 上会留下 LS 子进程导致 runner 不退出；测试 teardown 现在调用 `stopLanguageServerAndWait`（仅测试代码）。
- mutation：`firebase-referrer-block-map`、`dashboard-connect-parity`、`gap-dashboard-loopback-proxy` 三个受影响规格 exit 0。
- wire：对 `v3.9.49`（`ec4e599`，3.9.50 未单独打 tag）**270/270 比较相同**，exit 0。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实邮箱验证码的 `email/complete` → PostAuth（需要 Owner 的收件箱）。
- `[UNVERIFIED]` 真实 `has_password:true` 账号、Devin 跨 host PostAuth。
- `[UNVERIFIED]` 真实 `app.devin.ai` 的 daily-usage 响应（fixture 按捕获形状）。
