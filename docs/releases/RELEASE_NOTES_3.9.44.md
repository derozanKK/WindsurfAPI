# v3.9.44

本版两条：**登录不再把 OAuth-only 账号误判成“密码错误”**，并补上 **邮箱验证码登录**；**DEVIN_CONNECT 帧队列与 relogin 等待队列加上限**。没有协议兼容性破坏，没有新增默认开启的开关。

## 用户可感知

### 登录：OAuth-only 账号给出可执行的路径，不再报 `ERR_INVALID_CREDENTIALS`

根因不是密码错误：`interpretConnections()` 把 `connections[email].enabled` 当成了“有密码”。真实账号返回 `auth_method.has_password:false` 且 email connection 仍 enabled（它承载验证码），同时 `CheckUserLoginMethod` 返回 `{}`，于是流程认为有密码，去调 `password/login`，把上游 401 映射成 `ERR_INVALID_CREDENTIALS`。

- **探针顺序**：`/_devin-auth/connections` 为主，`has_password` 是唯一的密码信号；`CheckUserLoginMethod` 只做补充。缺字段 = 未知，绝不猜成“有密码”。
- **OAuth-only 终止**：`has_password:false` 直接返回 `ERR_NO_PASSWORD_OAUTH_ACCOUNT`（`method:'email_code'|'oauth'`，不计入锁账号），不再尝试密码，也不走 host fallback。
- **邮箱验证码登录**：`emailLoginStart` → `/_devin-auth/email/start`（`{email,mode:"login",product:"Windsurf"}`）；`emailLoginComplete` → `/complete` → 现有 PostAuth → register → apiKey。上游 `email_verification_token` 只存在服务端，客户端拿到的是 128-bit 不透明 `flowId`（10 分钟 TTL、一次性、5 次尝试、30 秒重发冷却、200 条上限）；失败发送也会启动冷却。
- **Devin host**：`/api/auth1/email/{start,complete}` 在 `DEVIN_CONNECT_LOGIN_HOST_FALLBACK` 下作为可用性回退；4xx 不回落。
- **Dashboard UI**：输入邮箱后先探测；`hasPassword:true` 保留密码框，`false` 显示“发送验证码”+ 验证码输入，OAuth-only 显示 token 粘贴提示。验证码只在显式点击时发送。
- **路由**：`POST /dashboard/api/windsurf-login/{probe,email/start,email/complete}`，dashboard 鉴权；错误码 400（不是 429，避免触发 IP 封禁遮罩）；验证码/Token 不写日志、不回显。

回归：`test/dashboard-email-code-login.test.js` + `test/dashboard-email-code-routes.test.js` + `test/addaccount-by-email.test.js` 共 40/40；父提交上关键用例红（`ERR_INVALID_CREDENTIALS` vs `ERR_NO_PASSWORD_OAUTH_ACCOUNT`）。**未验证**：真实收件箱的 `email/complete` 与 PostAuth（没有发真实验证码）。

### 队列上限：慢消费者与卡死的 relogin 不再无限增长

- **帧队列**：`DEVIN_CONNECT_MAX_QUEUE_FRAMES`（4096）/ `..._BYTES`（8 MiB），按 text×2 + reasoning signature×2 + hex + 96 B 计账；半程暂停 socket，越界丢弃缓冲前缀、置 `QUEUE_OVERFLOW`、销毁请求；消费到 1/4 时恢复（滞回）。`QUEUE_OVERFLOW` 是显式 no-penalty blame，新增 `queue_overflow` 计数。
- **relogin 等待**：等待者带 60 秒超时（`DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS`）和可选 `AbortSignal`，超时/中止从 FIFO 中摘除并返回 `false`；槽位只交给仍存活的等待者；reset 会 settle 而不是孤儿化。
- 三个开关写入 `docs/ENV-SWITCHES.md`（census 164 = 161 + 3）和 `.env.example`。

回归：`test/connect-frame-queue-bound.test.js` + `test/relogin-queue-bound.test.js` 6 条；在 `e2c8547` 源码上 5 fail（两条 HUNG、两条无拒绝、一条无暂停），修复后 6/6。相邻 61 个文件 / 1,074 条全绿。

## 工程与门禁

- 合入 2 条分支（均基于 `e2c8547`）：`fix/login-flows` `e9be4da`、`fix/bounded-queues` `7affe87`。
- Windows `npm run test:release`：**5,619 pass / 0 fail / 82 skip（462 文件，5,701 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：**PASS exit=0** —— `spec-static-check`、`spec-baseline-check`、`secret-scan`、`test:release`（同上 5,619 / 0 / 82，462 文件，4 inert / 4 declared）、`git diff --check`、`git diff --cached --check` 全绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，462 文件）：**5,700 pass / 0 fail / 1 skip（5,701 tests）**，exit 0。
- mutation：`sticky-queue-on-pin`、`firebase-referrer-block-map`、`gap-dashboard-loopback-proxy`、`connect-catalog-hotfix` 四个受影响规格 exit 0。
- wire：`WIRE_BASE_TREE` 指向 `v3.9.43`（`e2c8547`），`test/wire-byte-identity.test.js` **270/270 比较相同**，0 skip，exit 0；provenance：tested `c9c4631`、base `e2c8547`、expected tag `v3.9.43`。本提交只改文档/版本，`src/` 字节不变。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实邮箱验证码的完整 `email/complete` → PostAuth → apiKey。
- `[UNVERIFIED]` 真实 Devin host 的 `email/{start,complete}` 回退。
- `[UNVERIFIED]` 进程级内存上限（本版承诺的是队列进度有界，不是 RSS 硬上限）。
