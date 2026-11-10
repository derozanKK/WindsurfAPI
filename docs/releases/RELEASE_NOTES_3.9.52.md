# v3.9.52

本版两条：**账号 `reauth` 状态（会话 token 失效可被识别并重新认证）** 与 **Node 支持策略收紧到 22.13+**。没有协议兼容性破坏。

## 用户可感知

### 账号：token 失效不再只是“错误”，而是一个可恢复状态

- 新增 `status:'reauth'`：排在 `banned` 之下、所有自愈冷却之上；选择器（`getApiKey`）直接跳过，半开恢复不会把它拉回 active。
- 检测是两段式：聊天 `UNAUTHORIZED`/`kind:'dead'` 只触发一次**免费** `GetUserStatus` 探针；只有探针也返回 UNAUTHORIZED 才标记 `reauth`。单次聊天 401 不会封账号。
- 探针 60 秒去重、in-flight 共享、token 竞态保护；成功重新登录/导入后清除状态。
- Dashboard：`reauth` 徽章/筛选/抽屉提示 + “检查 token”；重新登录会**替换**同一账号行而不是新增；`PATCH` 在 token 未变时返回 409 `ERR_REAUTH_TOKEN_UNCHANGED`；删除账号现在会同时删除已存的加密凭据（此前会留在磁盘）。
- 不存 Auth1、不引入新秘密落盘。

回归：state/route/UI/hooks/terminal 五组；`dashboard-*`/`auth-*`/`login-*`/`chat-*` 等 704 条回归 0 fail；三个强制突变（确认分支、状态拒绝、reportError 守卫）均被抓。

独立审查后补的四个修正：`reauth` 现在是**终态**（`reportError` 不再把它降成 `error`，900 秒半开恢复无法把死 token 拉回；`reportSuccess` 只在非 reauth 时提升 active）；同 key 粘贴在三个入口都返回 409 `ERR_REAUTH_TOKEN_UNCHANGED` 且保留证据；绑定密码/邮箱登录与 token 路由共用 `ERR_REAUTH_NOT_APPLICABLE` 拒绝 disabled/banned，且不会清掉活跃封禁；`chat.js` 的两个 `requestReauthCheck` 调用点与 `removeAccount → deleteCredential` 都有测试钉住，改标签后仍按记录时的 `credentialEmail` 删除。

### Node：22.13+，Node 20 明确不支持

- `engines.node` 改为 `>=22.13.0`（`test:summary` 22.10 引入、`node:sqlite` 22.13  unflagged；Node 20 已 EOL 2026-04-30 且有 21 条 test-runner-only 失败）。
- README / README.en / CONTRIBUTING / PR 模板 / bug.yml / Dockerfile（20→24）/ Windows 脚本同步；发布门仍是 Node 24.x。
- 本版未在 22.13.0 上重跑矩阵；CI/本地仍以 24.21.0 为准。

## 工程与门禁

- 合入 2 条分支（均基于 `2d1e183`）：`chore/engines-22` `307384f`、`feat/reauth-state` `abf76c6`（审查后补 `827eef6`）。
- Windows `npm run test:release`：**5,992 pass / 0 fail / 82 skip（492 文件，6,074 tests）**，exit 0。
- Windows `npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，492 文件）：**6,073 pass / 0 fail / 1 skip（6,074 tests）**，exit 0。
- mutation：`dashboard-connect-parity`、`gap-dashboard-loopback-proxy`、`sticky-queue-on-pin` 三个受影响规格 exit 0（1 条 documented survivor 未变）。
- wire：对 `v3.9.51`（`2d1e183`）**270/270 比较相同**，exit 0。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实退役 session id 的探针行为（设计 §8-6）。
- `[UNVERIFIED]` Node 22.13.0 的完整矩阵（策略已声明，矩阵待补）。
- `[UNVERIFIED]` 真实浏览器上的 reauth 徽章/抽屉视觉。
