# v3.9.50

本版三条：**重试所有权收敛**、**账号页 v3（登录/导入/添加合并 + 请求历史）**、**108 条 smoke 矩阵**。没有协议兼容性破坏。

## 用户可感知

### 重试：一个错误只有一个所有者

- 传输层重试归适配器：`toChatCompletion` 默认 1 次、流式路径同样在首字节前重试一次；handler 只负责账号 failover，不再对同一 token 重放。一个 5xx 现在恰好 2 次上游尝试（初始 + 1 次适配器重试），不再是 3 次。
- `reLoginAccount({signal})` 的 abort 现在真的可达：流式/非流式/后台恢复/存活探测四个调用点都转发 `AbortSignal`；排队等登录槽的客户端断开即退出。
- “IP 级”突发限流改为进程级共享窗口（`src/rate-limit-burst.js`），第二个请求能看到第一个请求的突发；不再是每请求状态。
- ACP 增加一次有界重试：只对传输/5xx/504（以及显式 retryable 的 CAPACITY 429），工具映射、UPSTREAM_INTERNAL、认证、限流、abort、已发出 chunk 一律不重试。

### 账号页 v3：一个入口，能看到每个账号的请求

- 顶部合并为 **登录 / 导入 / 添加** 一组按钮（主按钮登录），池空态复用同一组；Key 卡里重复的“重新登录”移除，统一到抽屉 footer。
- 抽屉新增 **请求历史**（每账号 100 条，进程内，仅计费成功；显示模型/时间/用量），探测/刷新余额后自动刷新抽屉，不再留旧数据。
- 首屏骨架、错误横幅（带服务端原因 + 重试）、三种空态；添加 modal 的 Tab 焦点陷阱；tablist 支持方向键/Home/End；行高统一 44 px。
- 采用 workbuddy2api-hub 的配色/几何（AA 修正），深色默认不变；1440/390 无横向溢出；DOM 中无上游 key/session/JWT/Bearer/dashboard 密码。

### Smoke 矩阵：108 条真实流程

`npm run smoke:matrix`（`scripts/smoke-matrix.mjs`）在临时 `DATA_DIR` + 假上游上启动真实服务器，覆盖 14 个族（core/auth/dashboard/login/accounts/models/openai/messages/responses/gemini/dashboard-live/acp/i18n/hygiene），每族含成功 + 失败/边角。**108/108 通过**，14/14 负向突变被抓（每个族故意破坏一处即红），连续 3 次一致。

## 工程与门禁

- 合入 3 条分支（均基于 `ec4e599`）：`fix/retry-ownership` `2eea3d0`、`feat/account-ui-v3` `8ba1c3c`、`test/smoke-matrix` `c64ca8a`；合并后把 smoke fixture 的凭据改为运行时拼接，secret-scan 保持 0 命中。
- Windows `npm run test:release`：**5,851 pass / 0 fail / 82 skip（483 文件，5,933 tests）**，exit 0。
- Windows `npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux/mutation/wire：见发布提交与 CI。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 ACP 子进程的重试（fake stdio）。
- `[UNVERIFIED]` 真实浏览器的 1440/390 之外视口。
- `[UNVERIFIED]` 请求历史只覆盖计费成功，非计费/失败尝试不显示。
