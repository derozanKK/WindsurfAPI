# v3.9.60

本版把 **detached cache P1（惰性恢复）** 落地，默认关闭；另补 #245 要求的 `teams_tier` 日志行。没有协议兼容性破坏。

## detached cache P1（`WINDSURFAPI_CASCADE_DETACH=1`，默认关，需同时开 `WINDSURFAPI_CASCADE_TURN=1`）

- **快照 v2**：新增 `generatorOffset`、`sawActive`、`usageByStep`、`consumedThrough`。`snapshot()` 拒绝批次中途；`fromSnapshot()` 拒绝 v1、缺字段、`consumedThrough !== stepOffset`——关掉空游标重复前缀的洞。
- **registry**（`src/detached-registry.js`）：key = body+scope+route 摘要，租户由 `hasPerUserScope` 提供（不复制第二份）；CAS `claim`；TTL 120s / 8 条 / 每 caller 2 条 / 单条 4 MiB / 总量 32 MiB；每条一个 unref 定时器；计数器、drain、账号删除驱逐。**不持有 LS 租约**。
- **恢复路径**：跳过 Start/Send/warmup，恢复游标与 `pollFloor`，只在第一次成功读取后回放；中止时挂 detach；metadata 仍按 offset 计。
- **两个计费陷阱**：offset-0 过度计费（T3：metadata offset `[7]`、owner 账单 `110` token；0-offset 会变成 `330`）；`acct === null` 静默少计（T5：只向 owner 计费，重试账号不动）。
- 钩子：账号删除（`src/auth.js`）、drain（`src/index.js`）、restart（`src/restart.js`）。

## #245

`src/auth.js:5016` 在有 teams 证据时输出 `UserStatus <ref>: teams_tier=<raw enum> mapped=<tierName> plan="<plan>"`：raw 是 `mapTeamsTier` 消费的值，mapped 是它的结果。不改变任何 tier 判定；非 teams 路径不输出。

## 测试

- 新增 `cascade-turn-snapshot-v2`（S1–S7）、`detached-registry`（R1–R9+）、`cascade-detach-lazy-resume`（T1–T19，每个负例都有正控）、`userstatus-teams-tier-log`（6）。
- 红：改动前 S 套件 7/7 全红；R/T 在缺 registry 时无法导入。
- 绿：新套件 **42/42**；既有 cascade 套件在 detach off / `CASCADE_TURN=1` / 两者都开三种组合下均 **150/150**；更大回归 **193/193**；#245 6/6（全量 6,255 tests，+6 pass）。

## 工程与门禁

- 合入 `fix/245-teams-tier` `c0cb8de`、`feat/detach-p1` `2854fab`。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,202 pass / 0 fail / 95 skip（510 文件）**。
- Linux `npm run test:release`（HMC，Node v24.21.0，510 文件）：**6,294 pass / 0 fail / 3 skip**。
- wire：对 `v3.9.59`（`630fe95`）比较 **270/270**。
- mutation：全部 **85 个规格 exit 0**（无 survivor）。
- 测试宿主修复：`test/s4-r4.test.js` 的失败续段锚点在 client.js 重构后失效，已重锚到新的 `finally` 块（仍执行真实续段），并做 CRLF→LF 归一。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 设计 §6.7 的 mutation 表与真实 soak；**默认关**，不开不影响现有路径。
- `[UNVERIFIED]` 真实 Enterprise 账号的 `teams_tier` 行（无可用账号）。
