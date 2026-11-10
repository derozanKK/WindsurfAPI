# v3.141.592655

自 v3.141.592654 以来的 **35 个提交 / 76 个文件**（`git rev-list --count v3.141.592654..d69e767`；`git diff --shortstat v3.141.592654..d69e767`：6,303 增 / 146 删）把 wave-4–7 合入：图片能力位真正生效、#273 的 tool_result 顺序修复（本版唯一有意 wire 变化）、账号真相与计费历史、上游 4xx 归类、support bundle 凭据脱敏，以及三份诊断/文档基础设施。上游 proto 形状未变；客户端可见变化只有两类：声明 `supports_images:false` 的模型不再收到图片（改为计数剥离；被剥空的终端用户轮回 400），以及原生工具历史里乱序的 `tool_result` 被移动到它的调用之后。

> **版本号**：π 的十进制是 3.141592654，本版是下一个 patch 号，语义化版本写作 **3.141.592655**（tag `v3.141.592655`，本文件 `RELEASE_NOTES_3.141.592655.md`）。分支名 `release/3.141.592655`，代码祖先 `d69e767`。

## 1. `supports_images` 从“广告”变成门

修复前 `/v1/models` 从实时目录宣告 `supports_images`，但**没有任何请求路径读它**（C3-01）：图片被转发给同一台服务器声明为纯文本的模型，上游回 106 字节 `invalid_argument`，代理再把它误判成 503（§4）。实测目录 240 行：224 `true` / 0 `false` / 16 静默——所以“缺失”必须继续按未知转发，只有**显式 false** 才剥离。

- 门放在共享的 DEVIN_CONNECT 入口（chat、responses、messages 都经过它）。剥离而非 400：保住文本轮，不把一个没有活模型验证过 false 分支的位变成硬失败。每个被丢的块计 `images_dropped_capability` 并 warn 点名 selector。
- **P2-2（wave 7）**：能力位此前读的是池级 union（first-writer-wins），同一 selector 下账号 A `true`、B `false` 时，谁先同步谁决定两个账号的行为。现在 `getConnectSelectorImageCapabilityForAccount(accountId, selector)` 读该服务账号自己的目录行，三态（true/false/未知→转发）；env-token 回退没有池账号，保留 union。两种同步顺序都有测试，且断言 union 在每种方向上都持有相反位。
- **P2-3**：`supports_images:false` 把一个**终端**图片-only 用户轮剥成 `content: []` 时，builder 会编码空 user 帧（可能被合并掉，留下更早的陈旧提示）。现在剥离后重新用 `hasAnswerableUserContent` 检查终端非 system 消息，空则 `400 invalid_request_error`、`code=image_only_turn_unsupported` 并点名 `supports_images`；更早的图片-only 轮被剥空**不**影响 tool-result 续轮（`b2b396a` 的控制用例）。
- 测试：`test/connect-image-capability-gate.test.js` 10/10、`test/connect-image-capability-account.test.js` 4/4；突变 W4-M3/M4/M9/M10/M11/M12 全部被捕获。

## 2. #273：乱序 `tool_result` 移到调用之后（唯一有意的 wire 变化）

现场复现（scratch DEVIN_CONNECT，`claude-haiku-5-5-medium`，`temperature:0`）：`[user, result(a), call(a), user]` 在解码后的 wire 上是 `[1,4,2,1]`，上游 **502** `invalid_argument`；有序控制 `[1,2,4,1]` 回 200 `ALPHA-42`。丢结果仍然 502，丢调用则模型**重新执行**工具——所以重排是唯一既保留内容又符合已测接受形状的修法。

- `src/handlers/tool-emulation.js` 新增 `orderToolResultsAfterCalls()`：把“匹配调用在后面的” tool 消息推迟到该调用之后，保持原有结果顺序；没有移动时原样返回。`normalizeMessagesForCascade` 在 `nativeStructured` 下、`interleaveParallelToolMessages` **之前**运行；文本模拟路径字节不变。
- **P2-1（wave 7）**：`emulateTools=false` 且没有声明 `tools` 时，handler 只走 `interleaveParallelToolMessages`，绕过了上面的修复（`nativeToolCall` 默认开，builder 仍发 #6/#7）。现在无 tools 分支在 `nativeFlag` 下先重排，H4-T8 用真实 handler 断言 `[1,2,4,1]`。
- **wire 影响**：270 个比较中 **12 个**改变，全部是 fixture 5（`[tool, assistant, user]`）× `normalize`/`strip` × native/emulated × 3 环境。长度不变（native 1047 / 文本折叠 1055），非消息字段逐字节相同，消息 payload 除每个消息的 #1 uuid 外相同，角色序列 `4,2,1→2,4,1`（native）与 `1,2,1→2,1,1`（文本折叠）。把 `src/handlers/tool-emulation.js` 单独回退到 `4406ca6^` 后 270/270 全等——12 个差异恰好就是 #273 的重排。
- 这 12 个差异由 `test/wire-expected-diffs.json` 逐条声明：每条带 issue、fixture/route/native/env、字节长度、重排前后角色序列。校验器 `test/wire-expected-diffs.js` 要求消息字段以外的每个字节相同、payload 去掉 #1 uuid 后多重集相同、uuid 序列本身相同、角色序列逐项匹配；**没有条目的差异仍然失败**，条目匹配不到差异（过期）或匹配到多个比较都会失败。比较基线包含该修复后，必须删除条目。
- 测试：`test/wire-h4-tool-pair-order.test.js` 8/8；`test/wire-expected-diffs.test.js` 13/13（含“没有条目”“形状不符”“过期条目”“重复匹配”的负例）；突变 `wire-h4-tool-pair-order.json` 6/6 捕获。`#141` 的“第二条指令重放”在 proxy 层**未复现**（fixture 与真实 Claude Code 2.1.306 两轮会话都只各出现一次，`test/wire-h5-instruction-replay.test.js` 钉住）；`#273.2` 的 reasoning 多帧重复只复现了行为、缺真实 Devin 客户端抓包，未改编码器。

## 3. 账号真相：`success` 可用、免费档决策、成功新鲜度、计费窗口

- **#159**：两个门（`isModelAllowedForAccount` 与 `getAvailableModelsForAccount`）此前只认 `user_status`；一个刚成功回答过的模型（`reason:'success'`）会从 `availableModels` 消失，pool 被 403 `probe_pending`。现在共享一个 `capabilityVerdict()`：`not_entitled` 是权威否定，`success` 是权威肯定（带新鲜度，见下），无裁决才回落静态 tier 表；UID-only 模型（如 `glm-5.1`，enum 0）也进入列表，不只是路由。wave 4 红先行 4 条失败（14 条中）；wave 7 的新鲜度用例再红先行 2 条；最终 `test/account-entitlement.test.js` 18/18。
- **#149（决策，不是新增）**：`FREE_TIER_BASE` 保持 `['gemini-2.5-flash']`。免费账号能用 GLM/Kimi 是**按账号探测**出来的（enum 键模型走 GetUserStatus allowlist，UID-only 走一次成功调用并持久化到 `capabilities`），不是静态三个；把一个猜测写进基表只会把干净的 403 变成上游 529。`test/free-tier-cold-start.test.js` 4 条钉住冷启动契约，`src/models.js` 常量旁与两份 README 写明理由。
- **P2-4 成功新鲜度**：`success` 只在 `lastCheck >= userStatusLastFetched` 时算肯定——降级/试用过期的账号不再无限期列出并路由高级模型。刷新后的 allowlist 省略某个 enum 时写 `not_entitled`（不再保留旧 success）；但之后真正成功的一次调用会以更新的 `lastCheck` 重新建立成功。
- **P2-6 计费窗口**：失败行与 billed 行共用 100 行环，100 条失败会把 billed 行挤光、把摘要清零。现在 incoming billed 先逐出最旧的 failed（全是 billed 才逐出最旧 billed）；incoming failed 只逐出 failed，全满时**丢弃自己**。失败永远不能挤掉计费行；`summary` 仍只统计 billed。
- 测试：P2-4/P2-6 红先行 2+1+3 条失败，修复后 `account-entitlement` 18/18、`userstatus-teams-tier-log` 7/7、`dashboard-account-requests` 15/15；突变 `auth-truth-p2.json` 三层各被捕获（手工在 Windows 上应用/还原并核对 sha256）。

## 4. 上游 4xx 校验拒绝是 400，不是 503

AccountMatrix §7.1 的 106 字节尾帧是 `{"error":{"code":"invalid_argument","message":"an internal error occurred"}}`（图片发给 `/v1/models` 省略 `supports_images` 的模型）。旧的文本 arm 先匹配 `internal error occurred`，于是显式的 4xx 校验码被读成瞬时后端故障：`503 UPSTREAM_INTERNAL`、可重试、并给健康账号记 internal-error streak。

- 新增 `REQUEST_REJECTED` 裁决：显式 `invalid_argument` / `failed_precondition` 不再被文本 arm 抢走；保留上游消息并追加能力提示（点名 `supports_images` 与消息/工具形状）。配额、容量、内容策略、selector、tier、auth、限流等更窄裁决仍然优先。
- HTTP：`REQUEST_REJECTED → 400 invalid_request_error`（流式同一类型）；不计罚、不冷却、不 re-login，计 `request_rejected`；`isRetryable` 永不重放，即使包在 5xx 壳里。没有 4xx code 的真瞬时 5xx 仍是 503。
- 探针 `evidence/UpstreamErrorMapping-probe.mjs` 重放真实 106 字节穿过完整链：前 `503 UPSTREAM_INTERNAL` → 后 `400 REQUEST_REJECTED`，`upstream_hits: 1`（未重试）；容量/内部瞬时控制不变。`test/connect-request-rejection.test.js` 16/16（红先行 9 失败），9 条新突变全部被捕获。

## 5. support bundle：打包证据，不打包凭据（P1 / P2-7）

`scripts/support-bundle.mjs` 把最新 trace legs、`/health` 提交与版本、脱敏后的开关快照打成一个 `support-bundle-<utc>.zip` 加逐文件 sha256 manifest。wave-6 的首版把二进制 leg 原样复制，于是 `03-upstream-req.bin` 里的 session token / user JWT 进了压缩包；文本 leg 也漏掉账号邮箱与 presigned URL 凭据。

- 二进制请求 leg 现在是**解析后脱敏**：`GetChatMessageRequest` #1 ClientMetadata 的 #3（session token）与 #21（user JWT）值替换为 `[redacted]`，其余字节原样保留；manifest 记 `sourceBytes`/`sourceSha256` 与 `transforms`。无法识别为请求的二进制 leg **省略**并记录原因与 sha256（响应的 gRPC 帧无法证明内容，只能省略）。
- 文本 leg 增加：凭据字段值、`X-Amz-*` 与 `Signature`/`token`/`key`/`api_key`/`access_token`/`refresh_token`/`session_token`/`password`/`secret` 查询参数、邮箱形状。独立 backstop `findResidualSensitive()` 要求这些名字后面的值必须是 `[redacted]`；所有被移除的凭据值还会在写 ZIP 前对整棵 staging 树逐字节搜索，命中则 exit 1 且**不写任何文件**。
- 退出码不变：0 = 写出；1 = 门禁命中（共享规则或残留凭据）；2 = 用法/IO/环境失败。测试 `test/support-bundle.test.js` 12/12（旧代码 4 fail + 5 cancelled）；独立用 Python `zipfile` 复检三个真实 builder trace：JWT、opaque token、邮箱+presigned URL 均不在任何 entry 中，manifest 的 `binaryLegs.redacted/omitted` 与存储字节数可对账。8 个手工突变（#3/#21 原样、关闭 staging 搜索、去掉邮箱脱敏、去掉查询参数脱敏、原样 stage、只按 `isText` 分类、不脱敏 environment、只脱敏 #3）每个都有测试变红。

## 6. 诊断与文档基础设施

- **失败尝试历史**：`recordAccountRequest` 给每行盖 `billed`；新的 `recordAccountAttempt` 写零成本 `billed:false` 行（`outcome` + `status`），没有账号 id 就不写行。CONNECT 的 429/402/连接错误/abort 与 Cascade 的 LS/abort 退出都会归到被尝试的账号；`GET /accounts/:id/requests` 返回 `billed`/`failed`，drawer 分行显示，Devin 面板的 billed turns 过滤失败行。计费摘要逐字节不变（失败行不移动 requests/tokens/credit/acu/lastTs）。
- **未验证登记册**：`scripts/unverified-register.mjs` 从 24 份 release notes 的「尚未验证」小节生成 `docs/UNVERIFIED.md`（file:line、文本、marker、状态），`test/unverified-register.test.js` 逐字节比较并验证幂等与 marker 映射。本版新增的缺口也进入登记册。
- **§0 src-lag 守卫**：只检查祖先不够——§0 曾命名一个落后 10 个提交、6 个 `src/` 文件的 master 而守卫全绿。`docs-consistency-guard` 现在跑 `git diff --name-only <§0 master>..HEAD -- src/`：docs-only 滞后允许，`src/` 变化必须已被 §0 指向。自测钉住 `predates N src/ change(s)` 文案与 HEAD 自身不误报。

## 门禁

（本表每一行都写出来源；`[UNVERIFIED]` 表示至今没有任何测量。）

| 项 | 命令 | 结果 | 来源 |
|---|---|---|---|
| spec 静态一致性 | `node scripts/spec-static-check.mjs` | PASS — 96 份 spec / 855 条突变，anchor 各命中一次 | 本版运行 |
| Windows 本地门禁 | `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate` | **PASS** — 6,774 pass / 0 fail / 96 skip（560/560 文件实测；5 个 inert 文件，6 条声明；`test/wire-byte-identity.test.js` 因本机基线存在而**实际执行**并通过，被报 unused） | 本版运行 |
| wire（本地，对上一发布） | `WIRE_BASE_TREE=.claude/worktrees/wire-base WIRE_BASE_REQUIRED=1 WIRE_BASE_TAG=v3.141.592654 WIRE_BASE_SHA=d5e7ace… node --import ./test/setup-env.mjs --test test/wire-byte-identity.test.js` | **PASS — 258 byte-identical + 12 declared = 270/270**；`WIRE_PROVENANCE_COMPARED {"compared":270,"expected":270,"base_head":"d5e7ace…"}`，`WIRE_EXPECTED_DIFFS {"byte_identical":258,"expected":12,"entries":12,"compared":270}` | 本版运行（Windows，node v24.19.0） |
| wire（因果对照） | 同一矩阵，只把 `src/handlers/tool-emulation.js` 回退到 `4406ca6^` | 270/270 全等 —— 12 个差异恰好是 #273 重排 | FinalMatrix @ `d69e767`（HMC） |
| wire（v3.141.592654 对 v3.10.1） | release gate 形态 | 270/270，`tag_ref_verified=true` | FinalMatrix @ `d5e7ace`（HMC） |
| docs 一致性 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | PASS — 47/47 | 本版运行 |
| 未验证登记册 | `node --import ./test/setup-env.mjs --test test/unverified-register.test.js` | PASS — 生成器逐字节一致 | 本版运行 |
| Linux（HMC）Node 24.21.0 | `node scripts/run-tests.mjs`（559 文件） | 6,858 tests / **6,853 pass / 0 fail / 5 skip** | FinalMatrix @ `d69e767` |
| Linux（HMC）Node 22.23.4 | 同上 | 6,858 tests / **6,853 pass / 0 fail / 5 skip** | FinalMatrix @ `d69e767` |
| 全量 mutation sweep（96 份 spec） | `node scripts/mutation-sweep.mjs` | **PASS — 96/96 spec**；855 executed = **841 caught + 14 条声明的 `expectCaught:false`**，0 意外幸存、0 drift、0 untrustworthy；`VERDICT coverage: 96/96; exit=0` | FinalMatrix @ `d69e767`（HMC，node v24.21.0） |

`npm run gate` 的摘要逐字如下：

```
PASS spec-static-check exit=0
PASS spec-baseline-check exit=0
PASS secret-scan exit=0
PASS test:release exit=0 — 6774 pass / 0 fail / 96 skip (560 files) — 5 inert file(s), 6 declared (unused: test/wire-byte-identity.test.js)
PASS git diff --check exit=0
PASS git diff --cached --check exit=0
SKIP mutation EXECUTION — this gate checks spec shape, anchors and baseline values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.
INCREMENTAL GATE: PASS exit=0
```

`TEST_SHARD_SUMMARY {"files":560,"measuredFiles":560,"tests":6870,"pass":6774,"fail":0,"skipped":96,"cancelled":0,"todo":0}`

## 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增的条目也在其中。

- **wire 已实测，但只覆盖请求体**：本版本地对 v3.141.592654（`d5e7ace`，annotated tag 已验证）**258 个逐字节相同 + 12 个声明差异 = 270/270 对账**；同一矩阵在 master 上对同一基线得到相同的 12 个差异，且只回退 `tool-emulation.js` 后 270/270，证明差异因果上就是 #273。比较范围仍是 9 组历史 × 5 条 prepare 路由 × 2 native × 3 环境 = 270 个 protobuf 请求体；HTTP/Connect 帧与响应流不在内。
- **expected-diff 允许列表是自失效的**：比较基线一旦包含 #273，12 条必须删除，否则 wire 门报 stale。它是逐比较的，不是全局放行。
- **全量 mutation sweep**：96 份 spec / 855 条突变，结果见门禁表；Windows 本机仍不能跑 mutation harness（需要受信 POSIX git）。
- **真实客户端未重跑**：wave-7 的图片、顺序、账号真相、计费历史修复由单元测试、真实 handler 与捕获帧探针证明；没有用真实 Claude Code / Codex / Devin 客户端复验这些路径。
- **#273.2 未校准**：多帧 reasoning 重复只复现了 fixture 行为（raw 3 份 / 预处理后 2 份，与 issue 一致），缺真实 Devin 客户端抓包；编码器未改。
- **#149 是政策决策**：静态基表保持一个模型，依据是历史测量与 #155 的 probe 说明；没有在本版重新对免费账号做 live entitlement 探测。
- **support bundle 的边界**：凭据值在 staging 树中逐字节证明已移除；二进制请求里的 prompt/system 文本不扫描邮箱（它是用户内容，且已在 README 声明会打包）；prompt 文本里粘贴的、与请求元数据无关的 opaque 凭据无法被识别。未用真实付费账号的凭据 trace 复验。
- **本机门禁的 inert 声明**：Windows 没有 `/usr/bin/git`，`test/devin-connect-relogin-live.test.js` 未武装，`test/mutate-verify-harness.test.js` / `test/self-update-untracked-safety.test.js` 因 `REAL_GIT` 为 null 不执行，`detach-soak` / `detach-ls-pool-pressure` 在本机整文件跳过——这 5 个按 `GATE_INERT_SKIP_PATHS` 声明，不当作绿。`test/wire-byte-identity.test.js` 也声明了，但本次运行存在本机基线（`.claude/worktrees/wire-base` @ `d5e7ace`），它实际执行并通过，所以被报 unused；没有基线的主机仍会整文件跳过。
- **托管 CI / 发布产物未验证**：本版在本地分支准备；tag、release workflow、HMC 部署与 cosign 资产都要在合并后另行执行与核对。
