# v3.141.592656

自 v3.141.592655 以来的 **53 个提交 / 148 个文件**（`git rev-list --count v3.141.592655..12aebfcb`；
`git diff --shortstat v3.141.592655..12aebfcb`：18,533 增 / 1,884 删）把二轮审计的 27 行 V 台账与
D 波指定修正已落地（D9 仍为仅设计的开放风险），并关闭两条 Cascade 发布阻塞项 F2/F3 的已测机制。
这不关闭 audit2 的其他残余 P2，也不构成 live/部署认证；边界见 §6。本版是 **patch**：协议形状未变，
请求字节相对 `v3.141.592655` 仍是 **270/270 逐字节一致、0 差异、allowlist 为空**。

> **版本号**：`3.141.592655` 之后的 patch，语义化版本写作 **3.141.592656**（tag `v3.141.592656`，
> 本文件 `RELEASE_NOTES_3.141.592656.md`）。发布提交与认证树 SHA、逐项门禁计数和日志哈希见同日
> 验收附录 [`ACCEPTANCE_3.141.592656.md`](ACCEPTANCE_3.141.592656.md) —— 本文件只写内容与边界，
> 附录是本次认证的唯一计数来源。

## 1. 审计台账：27 行全部关闭（4 P0 + 18 P1 + 5 P2）

旧台账的两处算术错误已按 `audit/VERDICT.md:7-16` 的 27 行去重表修正：批 1 是 **4 P0 + 9 P1**
（不是「10 个 P1 根因」），批 2 是 **9 P1 + 4 P2**；V-23/24/25/26 是 P2，不计入 18 项 P1。
本版把 V-27 也从「未修」改为关闭：

本节“关闭”仅指各 V-ID 的具名机制已有修复与测试证据，不等于所有 Cascade/传输/部署风险均已关闭，
也不包括 audit2 的独立残余 P2；后者列于 §6。

| 严重度 | 行数 | 行 | 状态 |
|---|---:|---|---|
| P0 | 4 | V-01 / V-02 / V-03 / V-04 | 全部关闭；V-04 的 `/auth/*` 与 forwarded-Host 边界由 D1 关闭 |
| P1 | 18 | V-05–V-22（连续 18 行） | 全部关闭；V-08 由 D8、V-10 由 D2、V-13 由 D3 关闭各自边界 |
| P2 | 5 | V-23 / V-24 / V-25 / V-26 / V-27 | 全部关闭；V-27 由 D4 关闭 |
| **合计** | **27** | | |

- **V-27 / D4（缓存重放计费）**：缓存命中的 replay 不再把同一轮的 token/credit/账号支出
  再记一次；非流式、流式与「只有真正跑过上游的轮才刷信用卡」三条臂在 `2598299e` 上红先
  （16 vs 8、16 vs 8、8 vs 4），修复后 `test/cache-replay-usage-accounting.test.js` 3/3。
- 逐行 V-ID / 严重度 / 证据文件 / 证明测试见
  [`evidence/ACCEPTANCE-20261026.md`](../../evidence/ACCEPTANCE-20261026.md) 的 §1 矩阵；
  本次发布附录按同一顺序再列一次，并绑定发布提交 SHA。

## 2. F2 / B00a — final-sweep 文本不再被误判为空轮

final IDLE sweep 常常是某一 step 的文本**第一次**可见的位置（LS 在上一次轮询读取与 sweep 之间
写出答案）。两条 sweep 分支都把字节发给了调用方，却没有置 `sawText`，于是回合以 `idle_empty`
结束；`classifyCascadeEnd` 在字节已经发出之后把它映射成 502 `EMPTY_RESPONSE`（流式则在文本后
追加错误帧）。

- `src/cascade-turn.js:287-320` 的 `consumeFinalStep` 两个 top-up 分支现在都置
  `sawText = true` 并刷新 `lastGrowthAt`；detach 快照冻结在该 seam 时也携带真相。
- `src/client.js:2046-2092` 的 CascadeTurn 与 inline 两条 sweep 分支同样标记输出；
  `:2097` 的终止原因改为 `(sawText || totalYielded > 0) ? 'idle_done' : 'idle_empty'`。
- `src/client.js:561-587` 的 `idle_empty` 分类臂与 `max_wait` 一样尊重 `hasOutput`：已交付字节
  变成 typed truncation（`CASCADE_TRUNCATED`，200），真正零输出的回合仍是 502 `EMPTY_RESPONSE`。
- 红先：`test/cascade-final-sweep-terminal.test.js` 在未修源码上 9 tests / 5 fail（两条 sweep 臂
  的 `idle_empty`、路由级 502、流式错误帧）；修复后与 F3 套件合计 **18/18**。新增
  `test/mutations/cascade-final-sweep-deadline.json` 的 7 条突变中 5 条被捕获、2 条按构造声明为
  等价 survivor（理由钉在条目 name 里）。

## 3. F3 / B00b — 路由预算从 producer 入口起算

`chat.js` 传给 producer 的是 `maxWaitMs: budget.remainingMs()`（一个**时长**），而 producer
在 warmup + StartCascade + Send 之后才起钟；短预算的请求为 send 阶段付两次时间：一次在预算外，
一次作为全新的轮询窗口。审计复现为 100 ms 预算在 250 ms Send 后面实际用了 310/313 ms。

- `src/client.js:1028-1052` 在 producer 入口取**一个绝对 deadline**
  （`turnStart`、`turnBudgetMs = min(CASCADE_MAX_WAIT_MS, requestMaxWaitMs)`、
  `remainingBudgetMs()`），预算耗尽统一抛 `budgetExceededError` → `upstream_deadline_exceeded`。
- warmup（`:1054-1079`，含 re-warm `:1152,1394`）、StartCascade 与恢复重试
  （`:1134-1155,1407-1426`）、Send 与重试（`:1320-1369`）、重试 backoff（`:1399-1403`）、
  轮询窗口（`:1476-1486`）、detach admission（`:1554-1565`）、每条 trajectory/status 读取
  （`:1575-1592`）都消费同一个剩余预算；截止后的失败不再被当成可重试的传输错误去轮换账号。
- `src/handlers/chat.js:6854-6857,6965,8762` 把预算停止统一归类为 504 deadline，而不是 502。
- 红先：`test/cascade-turn-deadline.test.js` 在未修源码上 8 tests / 5 fail（120 ms 预算在 400 ms
  Send 后用了 464 ms、StartCascade 465 ms、warmup 越过 deadline、恢复 StartCascade 467 ms、
  claim deadline 770 ms）；poll-window 控制臂另测 349 ms / 200 ms。快 Send、重试 Send 与长合法
  多轮输出三条控制臂在修复前后都绿。post-turn usage settlement 保留自己的 5 s 上限
  （`:2209-2217`），已计费回合在 claim deadline 之后仍会结算。

## 4. D 波跟进状态（D1–D10）

| 行 | 状态 | 依据 / 边界 |
|---|---|---|
| D1 | 关闭（已测边界） | `/auth/*` 与 forwarded-Host 共用 dashboard Host 门；`test/dashboard-host-boundary.test.js` 9/9，攻击臂与合法控制臂都走真实 `startServer()`。未断言密码保护的远程部署可以匿名访问。 |
| D2 | 关闭 | Connect **stream** 的 `json_schema` 校验；非法输出是 typed failure，且不缓存、不提交。`test/structured-output-schema.test.js` 12/12（红先 1 条）。 |
| D3 | 关闭 | reuse→fresh 回退携带完整映射工具历史；`test/cascade-native-history-delta.test.js` 4/4（红先 2 条），fresh/reuse/expired-resume 为 3/1/1→3。 |
| D4 | 关闭（= V-27） | 缓存命中不重复计 token/credit/账号支出；`test/cache-replay-usage-accounting.test.js` 3/3（红先 3 条）。 |
| D5 | 关闭 | `generatorOffset` 在无 usage 记录时保留未知而不是归 0；`test/cascade-generator-offset.test.js` 5/5（红先 3 条）。 |
| D6 | 关闭（hermetic） | 自更新 pending/terminal 状态真实，回滚点与 journal 保留；fake Docker/git 注入。真实 Docker daemon、registry pull、真实重启与部署仍 `[UNVERIFIED]`。 |
| D7 | 关闭（G1–G4） | gRPC/Connect 无终止状态不再被当成成功；`test/s2-b-grpc.test.js` 18/18（红先 7 fail）。真实 LS 兼容性仍 `[UNVERIFIED]`，默认传输未翻转。 |
| D8 | 关闭（受控 socket） | Messages/Gemini 翻译层把 verdict 与 drain 传回生产者；目标套件 179/179（红先 4+3 fail）。真实 TCP/真实客户端未测。 |
| D9 | **仅设计，开放风险** | `evidence/D9-TRUST-DESIGN.md` 是 Policy T 设计，未实现；按本版发布策略非阻塞，但不得声称 OTA/镜像/banner 已验证。 |
| D10 | 关闭（指定修正） | env switches、Connect 映射、验收算术；docs guard 47/47。README 措辞、32 个前缀外开关与 P3 清理明确留给后续。 |

## 5. 门禁与认证

本版在发布提交上实测（Windows 本地门禁、Linux Node 24 与 Node 22、wire、全量 mutation sweep）。
**逐项命令、精确计数、skip 名单、日志路径与 sha256 全部记录在同日验收附录**
[`ACCEPTANCE_3.141.592656.md`](ACCEPTANCE_3.141.592656.md)；该附录与本节在同一个 tag 树上，
不引用任何「上一棵树」的数字。

- wire：基线由外部选择并证明为 `v3.141.592655` → `c60d746985f0feffe5d29ff13773f4bfbdf9aa5b`，
  在干净的外部基线树上比较；要求 **270/270 逐字节一致、0 未声明差异**。
- mutation：**97 份 spec / 862 条突变**（`cascade-final-sweep-deadline.json` 是本版新增的第 97 份），
  全量 sweep 要求 97/97 spec、0 意外 survivor、0 baseline drift、0 untrustworthy；17 条
  `expectCaught:false` 为声明 survivor（15 条既有 + F2/F3 的 2 条冗余层）。
- Node 22 使用既有的 22.23.4 对照解释器（HMC `/root/node22matrix-360/node-v22.23.4-linux-x64/bin/node`）；
  声明的 `>=22.13.0` 下限本身仍未实测，见 §6。

## 6. 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增的条目也在其中。

- **真实上游未重跑**：V/D 波与 F2/F3 的证据来自单元测试、真实 handler 与 fake LS/受控 socket；
  没有用真实 LS gRPC、真实付费账号或真实 Claude/Codex/Devin 客户端复验这些路径。Cascade live
  矩阵（含 F2/F3 的 live 控制）仍 `[UNVERIFIED]`。
- **真实 Docker / 部署 / 回滚**：D6 是 fake Docker/git 注入；没有 registry pull、daemon recreate、
  真实重启或生产部署。生产 `:18999` 未作为测试目标；B07 的备份/部署/回滚演练仍未执行。
- **audit2 残余 P2 未关闭（按当前发布策略非阻塞，不等于无害）**：27 行 V 台账与 F2/F3 的关闭不覆盖以下独立风险。
  - **F5（Cascade 多轮）**：重放 prompt 的相反角色 closing tag 与最新 human turn 未被统一转义，可伪造对话结构；这是 prompt-integrity 风险，未证明跨租户暴露。
  - **S03（dashboard）**：请求体在 Host/auth 门之前缓冲并解析；未认证并发连接可在读取期间各保留约 10–20 MB，需前置 Host 校验、较小长度上限与请求 deadline。
  - **历史 downstream key**：已从当前文档删除不等于撤销；轮换/吊销仍 `[UNVERIFIED]`。不得发布 key 值；若仍有效须按安全事件处理。
  - **L1（LS 冷启动/容量压力）**：全局 admission lock 跨越 capacity/memory 等待，可阻塞无关 LS 启动最多两轮 30 s；已就绪 LS 请求不受影响。
  - **L2（默认 auto-restart）**：LS ready 后立即清零重试计数，ready-then-crash 循环可永远达不到 retry cap。
  - **F4（Cascade 图片）**：历史图片有 4 张/1.6 MB 预算，但当前轮图片不纳入同一 count/aggregate-byte 预算；HTTP 10 MiB 上限仍限制网络输入。
  - **Devin ACP-1/ACP-2（opt-in）**：pre-abort 后注册的 listener 不会触发，可能在调用方离开后开始工作；不可写 stdin 会静默丢 RPC，pending prompt 可等到默认 10 min timeout。尚无 live billable-turn 测量。
  - **其余已列 P2**：Update P2-5（forced-update stash 未向操作者呈现）、G5（unbounded unary buffering）、C1（同步压缩）、W1（async Promise executor）仍未关闭；未进入 top-10 不代表已修复。
- **D9 是设计，不是实现**：源码 OTA 无 tag 签名校验、docker 镜像未签名、`banner.yml` 执行运行时
  拉取的代码；本版按当前发布策略接受该风险，不声称「verified OTA/supply chain」。
- **P3 清理未做**：`DIRECTION.md` 明确延后；README 的模型计数/双 API 表述、63 个死 i18n key、
  32 个前缀外 env switch 等仍是已知文档债，不是本版回归。
- **Node 下限未实测**：只跑了 22.23.4 与 24.21.0；`>=22.13.0` 的 floor 本身 `[UNVERIFIED]`。
- **Windows 本机 inert 声明**：6 条平台/live 文件按 `GATE_INERT_SKIP_PATHS` 声明，不当作绿；
  具体名单与计数见验收附录。
- **托管 CI / 发布产物**：tag、release workflow、cosign 资产核验与 HMC 部署都必须在 tag 后另行
  执行与核对（B06/B07）；本文件不代表它们已经发生。
