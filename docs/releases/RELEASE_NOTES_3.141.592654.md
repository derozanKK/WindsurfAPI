# v3.141.592654

自 v3.10.1 以来的 **51 个提交 / 76 个文件**（`git rev-list --count v3.10.1..e3cc399`；`git diff --stat v3.10.1..e3cc399`：5,859 增 / 447 删）把 wave-3 的修复、三轮真实客户端抓包和一次历史查漏补缺合入。上游 proto 形状未变；有两处**有意**的客户端可见变化：`/v1/chat/completions` 对 server-executed 工具类型从静默丢弃改为 400，Codex 0.164 每轮都发的 `parallel_tool_calls:false` 从 400 改为正常服务。

> **版本号**：π 的十进制是 3.141592654，语义化版本要求三段，所以发布号写作 **3.141.592654**（tag `v3.141.592654`，本文件 `RELEASE_NOTES_3.141.592654.md`）。分支名沿用 `release/3.141592654`。

## 1. Cascade 重放历史的图片：不再静默丢弃

修复前只有**最新一轮**走 `extractImages`（`src/client.js:897/910/956`，修复前），更早轮次的图片到达模型时是字面占位符 `[Image omitted from text history]`（`src/client.js:166`）——**没有计数器，也没有一行日志**。

wire 能力来自 builder，不是猜的：`buildSendCascadeMessageRequest`（`src/windsurf.js:348`）的 field 6 是 `repeated ImageData{base64_data=1, mime_type=2}`（`src/windsurf.js:382-391`），是**消息级平铺列表**，没有轮次索引——所以按轮归属不可能，但每张图都能搭同一条消息。

- 现在**每个重放轮次**都用与当前轮相同的护栏抽取（`extractImages` → SSRF / 大小 / MIME / 解码）。当前轮保持位置 `1..k`，历史图按时间序接在 `k+1..`；每轮文本给每张附上的图一个编号 marker，模型能区分。
- 有界且偏好最近的轮次：`CASCADE_MAX_HISTORY_IMAGES`（默认 **4**）、`CASCADE_MAX_HISTORY_IMAGE_BYTES`（默认 **1,600,000**，即 4 × `image.js` 的 400 KB 重编码目标；`src/client.js:308-316`）。装不下的按 `cascade_image_history_dropped` 计数并记日志，装上的按 `cascade_image_history_attached` 计数，进程生命周期；`/connect-metrics` 暴露 `cascadeImages`（`DELETE` 时重置）。
- 恢复后的重建路径用**同一个** builder（`src/client.js:1133`），重建的历史与全新历史携带的内容完全一致。
- 测试：`test/cascade-image-history.test.js`（新，9/9，假 LS 解真实 proto）；新 spec `test/mutations/cascade-image-history.json` 8 条突变；`client-history-coverage.json` 4 个 anchor 重钉到新 builder。
- 文档：`docs/ENV-SWITCHES.md` 收录两个开关。

## 2. Codex `parallel_tool_calls:false`：400 → 正常服务 + 计数

Codex CLI 0.164 在 **29/29** 次抓到的请求里都发 `parallel_tool_calls:false`（`evidence/ClientSandboxes.md` §3.1、§3.3 C1），且总与 11 个工具、`tool_choice:"auto"` 同行。wave 2 让 `responsesToChat()` 转发这个字段本身是对的，但 chat 路由的门在 `DEVIN_CONNECT_TOOL_CHOICE` 不是 `1`（**出厂默认**）时回

```
400 invalid_request_error / code=unsupported_parameter / param=parallel_tool_calls
```

Codex 收到 `turn.failed` 后退出 1：默认配置下客户端不可用。决策是**永不 400**（这是偏好，不是协议）：开关打开时转发；关闭时照常服务，每进程 warn 一次并计数 `parallel_tool_calls_hint_ignored`。

探针（`evidence/CodexParallel-probe.mjs`，真实 handler、只桩掉 connect 传输）前后：

```json
{"label":"codex-shape with parallel_tool_calls:false","status":400,"modelCalls":0,"error":{"code":"unsupported_parameter","param":"parallel_tool_calls"}}
{"label":"codex-shape with parallel_tool_calls:false","status":200,"modelCalls":1,"forwardedParallelToolCalls":false,"hintIgnoredDelta":1}
```

- 测试：验收 1,220/1,220；聚焦套件 `parallel-tool-calls-connect` 12/12、`drought-gate-reachability` 10/10、`retry-after-route-parity` 5/5。
- 突变：`parallel-tool-calls.json` **10/10 被捕获**（基线 12）；`retry-after-route-parity.json` 6 条（5 捕获 + 1 条有记录的幸存者，基线 5/5）。第一次跑 spec 时 **`tool_choice` 的线程化幸免**——替换旧拒绝测试时丢了唯一断言，测试补回（`b8a7d24`）后该突变才被捕获。
- 真实 Codex CLI **修复后没有重跑**（见「尚未验证」）。

## 3. `/v1/chat/completions`：server-executed / hosted 工具类型显式 400

chat 面此前接受 `{type:'web_search'}` / `{type:'code_interpreter'}` 等并回 200、工具凭空消失，而 `/v1/responses` 对同样的载荷回 400（`evidence/DataAuditTools/findings.md` F3）。

- 谓词抽到 `src/server-side-tools.js`（新）：`UNBRIDGED_SERVER_SIDE_TYPES`、`isServerSideToolType`（带日期后缀的快照同样拒）、`isHostedSearchType`（版本化家族）、`forEachTool`（走 `tools`/`children`/`functions`/`items` 四个 namespace 键）、两面的错误工厂，以及 `firstUnsupportedServerToolType`。`responses.js` 改为 import，错误码与消息**逐字不变**。
- chat 的门在 `_handleChatCompletionsInner` 顶部、**提示词组装、缓存/账号工作和任何上游调用之前**：`400 invalid_request_error`、`code=unsupported_server_side_tool`、`param=tools`；消息区分 hosted 与 server-executed，并点名 `function` 逃生口。
- 只看 `tool.type`：`{type:'function', function:{name:'apply_patch'}}` 与 `{type:'custom', name:'apply_patch'}` 照常 200，函数形式仍进上游工具前导（有测试）。
- 未知垃圾类型保留旧的 200，但不再静默：记 `dropping unknown tool type <type>`。wire builder 未动（`devin-connect.js:1740` 仍过滤非 function 的 ToolDef，纵深防御）。
- 测试：`test/chat-hosted-tool-gate.test.js`（新，9 条：8 类 × 流/非流、8 个日期快照、4 个 hosted/版本化类型、四个 namespace 键、混合 function+server、两个 `apply_patch` 反例、未知类型日志）；验收 **1,131/1,131**。

## 4. Claude Code 2.1.306：CL1 / CL2 / CL3

- **CL2 `context_management`**（2.1.306 新增，beta `context-management-2025-06-27`）此前被静默丢弃。观测到的 `clear_thinking_20251015 keep:"all"` 每轮都接受（400 会让真实客户端不可用），且历史翻译器本来就不转发传入的 thinking 块；真正的裁剪请求记日志。`clear_tool_uses_20250919` 与未知 edit 类型回 `400 unsupported_parameter` 并点名要删什么；形状错误回 `400 invalid_request_error`。该字段从不转发上游。
- **CL3 `defer_loading`** 此前被忽略，延迟占位符被当成普通可调用工具转发。无参数声明的延迟工具（Claude Code 的 `DeferredToolPlaceholder`，"never call this tool"）现在被丢弃并计为 honored；带 schema 的延迟工具仍整份转发（上游没有工具加载协议，丢掉 schema 会让工具不可调用），但计 `toolDeferLoadingIgnored` 并每请求记 `tool_defer_loading_ignored`——偏差不再静默。`defer_loading` 本身从不转发。
- **CL1 `signature:""`** 是 #278 / `b60ec3d` 的既定行为（严格客户端要求键存在，`""` 能解析），不是缺陷：抓包里 2.1.306 在 **11/11** 次交换上都接受它（**7/7** 个 thinking 起点形状逐字为 `{"type":"thinking","thinking":"","signature":""}`，**0** 个 `signature_delta`，后续请求回放同样 200）。本上游产生不了真签名，`reasoning_signature` 的向前兼容路径保留；精确 wire 形状由测试钉住。
- 测试：CL 套件 **141/141**；全量 `6,725 tests / 6,628 pass / 0 fail / 97 skip`（`evidence/ClaudeCompatGaps.md`）。

## 5. usage 口径：cache-write 计入输入，session-id 来源可见

- **O2**：omp 在 2/7 个请求上看到约 11.5k 提示词只报 `prompt_tokens=3`。那些是**前缀缓存写**轮（`fresh=3, cache_write=11329`），不是重试。`normalizeConnectUsage` 现在 `prompt_tokens = fresh + cache_read + cache_write`，`total = prompt + completion`，**总是**输出 `prompt_tokens_details`，并新增显式 `fresh_input_tokens` 桶，使 Anthropic 形状的消费方（`messages.js`）、成本核算（`auth.js`）和 dashboard 统计不重复计写；Cascade 保留 #118 的拆分。
- **O3**：连续性本就是 opt-in，抓包里是关的。`DEVIN_CONNECT_SESSION_REUSE` 关闭时记录"每请求 fresh"的来源，并在 connect runbook 里写明；开关**没有**翻转。
- **O1**：保留刻意的点号别名 `claude-sonnet-4.6` → `claude-sonnet-4-6-thinking`，验证基础拼写 `claude-sonnet-4-6` 仍可达，两处都写进 README 与 runbook。
- 测试：验收 1,023/1,023；全量 `6,624 pass / 0 fail / 97 skip`（GOAL 矩阵记录，见「门禁」）。

## 6. 别名 / 方言：整类修复，不是逐个字符串

来源 `evidence/AliasResolverFix.md`（别名矩阵审计的 S2–S7 结论 + 复审 P2-1/P2-2，逐条前后探针）：

| 项 | 缺陷 | 修法 | 判定 |
|---|---|---|---|
| **S3** | 提供方前缀剥离 `/^[a-z]+\//` 匹配不了 `x-ai/`、`z-ai/`，所有带连字符前缀的拼写每次查找都失败 | 放宽到 `/^[a-z0-9][a-z0-9-]*\//`，仍只剥一段 | 修好，突变捕获 |
| **S4** | 紧凑拼写 `gpt5.x` / `gemini3.x` 没有映射行 | 查表前在分隔符处拆开紧凑版本号，不新增映射行 | 修好，突变捕获（含过度覆盖） |
| **S5** | enum 判定跑在原始名字上，小写/带前缀的 `MODEL_*` 两条路都不匹配 | 在规范化键上判 enum，查大写形式，保留目录存在性门 | 修好，突变捕获（含门移除） |
| **S2** | 家族正则测字面拼写，点号与紧凑名漏掉家族 | `pickToolDialect` 顶部把点号折叠、紧凑版本拆一次，所有家族规则测这个键 | 修好，突变捕获 |
| **S7** | `swe-1-5` → `MODEL_SWE_1_5_SLOW`，但别名落到 `kimi_k2` 与自己的 `openai_json_xml` | 两个 SWE-1.5 enum 读成家族拼写 | 修好，突变捕获——**方向是推断**，见原证据 |
| **P2-2** | 方言的前缀剥离比解析器宽（接受 `_`），会为解析器已降级的名字选方言 | 用与解析器完全相同的规则 | 修好，突变捕获 |
| **P2-1** | 注释声称前缀永不改变上游模型 | 改正注释；不对称性由测试钉住 | 只改文档 |
| 残留 | 裸 `grok-4-5` / `inkling` 400 而同族可用 | 补两个裸别名（快照里 `-medium` 目标存在） | 修好，突变捕获 |

同一轮还修了：`swe-2-0-{medium,high,max}` 的破折号 effort 拼写（冷启动曾降级免费档、live 目录下回 `model_not_found`）、紧凑 `gpt5-6-luna`、`extractImages` 接受大写 scheme（`HTTPS://` 此前静默跳过）、以及方言判定先剥提供方前缀。全部有红先行测试；`test/mutations/alias-resolver-systemic.json` 与重钉的 `connect-catalog-hotfix.json` 钉住方向。

## 7. `/v1/responses` 与 Gemini 的参数保真；`metadata` 回声与持久化

- **F1** `/v1/responses` 的 `parallel_tool_calls` 现在真正转发（配合 §2 的 chat 策略）；**F2** Gemini `generationConfig.candidateCount`、**F5** `generationConfig.topK` 不再被丢。验收 313/313（`test/responses.test.js` + `test/gemini*.test.js` + `test/response-store*.test.js`），红先行 9 条失败。
- **F4 `metadata`**：`normalizeResponseMetadata()`（导出）按 OpenAI 契约校验——扁平 map、≤16 对、键 ≤64 字符、值 ≤512 字符——违反时 `400 invalid_request_error` 且 `param:'metadata'`；`null` 与 `{}` 都表示"没有"（POST 与 GET 一致）；**值从不进日志**。非流式响应体、每个流式 `response.*` 帧、`GET /v1/responses/{id}` 都回声；存储侧新增有界槽（同样的上限、跳过 `__proto__`），`metadataBytes()` 计入条目的 `bytes`，与其它保留字节一样算进租户份额和全局预算。
- 测试：`responses.test.js` + `response-store*.test.js` **207/207**（新增 8 条 metadata 测试）；四个 responses 基线随测试数 +8 重测：68 / 83 / 70 / 73，0 drift。

## 8. 门禁：mutation 基线默认按变更域测量，release 全量

`scripts/spec-baseline-check.mjs` 默认只测**这次 diff 可能移动过**的 spec（spec 文件本身或其钉住的测试文件变了）；`--all` 是 release 门（`gate:release` 与发布 workflow 用）。旧的"任何 `src/`/`scripts/`/测试辅助文件变了就全测"既让增量门几乎每个分支都付全量成本（约 100 秒），又没覆盖它想覆盖的失效——过期钉子是 spec 自己测试清单的属性。

真实仓库证明（不是只测 fixture）：把 `responses-post-tool-text-item.json` 的钉从 82 改成 83 → `DRIFT … exit=1`；还原 → `4 spec(s) measured, 0 drift, 0 untrustworthy`；release 域能测到 diff 从未碰过的 spec。wiring 由 `test/local-gate.test.js` 与 `test/mutate-verify-harness.test.js` 钉住（该文件在本机声明为 inert，见「门禁」）。

## 9. 社区 PR #281：Claude Code 子代理的内容策略

合并 `e399c15` / 提交 `3e3f21a`（作者 PsychMing）。症状：每个 Claude Code 子代理（Agent 工具：general-purpose、Explore…）都收到 `permission_denied` / 400 "blocked by our content policy"，而同代理的主会话正常。规则 `a8-cc-subagent-emoji` 把 "…MUST avoid using emojis." 重写成 "should"，**不**挂在默认关闭的 `(cc)` 块后面——被门控的规则会让所有默认部署的子代理继续失败。线上二分：整句作为全部系统提示即被拒，近似变体通过，整份被拒请求只把 MUST 换成 should 后 3/3 通过。测试钉住重写、幂等、近似变体不动、关开关。

## 10. 查漏补缺与真实客户端（证据，不改产品代码）

- `evidence/HistoryGapAudit/gaps.md`：语料 183 issues / 89 PR（快照 2026-10-17；54 merged / 31 closed-unmerged / 4 open），今天线上仍开 **7** 个（#208 #236 #239 #245 #250 #262 #273）；15 个非完成关闭（13 NOT_PLANNED + 2 DUPLICATE）；`[UNVERIFIED]` marker **78 处 / 24 文件**（是下限，不是清单）。留下的代码级开放项：#149 免费档基表主张、#159 `reason:'success'` 被忽略、`supports_images` 宣称但未读。
- `evidence/ClientSandboxes.md`：**47** 次真实客户端交换（29 Codex + 11 Claude + 7 omp），其中 **46** 次过 wire 校验、**0** 违规；三家各 3/3 任务通过；1 个客户端级破坏缺陷（C1，§2 已修）+ O1/O2/O3（§4、§5）。
- `evidence/PlannerVisionProbe.md`：**30** 次线上 A/B **推翻**了"`planner_mode=NO_TOOL` 不启用视觉"的说法——`planner_mode=3` 在线上确认，图片字节仍在 field 6，且模型确实读图（`claude-haiku-5-5-medium` 3/3、`gemini-3-6-flash-medium` 3/3、`gpt-5.5-xhigh` 3/3，均带声明工具）；绿色 PNG 在两种模式下都答 Green，无图控制 4/4 答"看不到图"。**无代码改动**；`src/windsurf.js:361` 的注释读起来像 NO_TOOL 会丢视觉，实际不会。
- kimi 断供：上游 WorkBuddy abort → hub 502，只能缓解（短轮次、重试、新会话），不是本版修复。

## 门禁

（本表每一行都写出来源；`[UNVERIFIED]` 表示至今没有任何测量。）

| 项 | 命令 | 结果 | 来源 |
|---|---|---|---|
| spec 静态一致性 | `node scripts/spec-static-check.mjs` | PASS — 92 份 spec / 822 条突变，anchor 各命中一次 | 本版运行（`ls test/mutations/*.json \| wc -l` = 92，逐 spec 求和 = 822） |
| Windows 本地门禁（incremental） | `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate` | **PASS** — 6,674 pass / 0 fail / 97 skip（551/551 文件实测；6 个 inert 文件，6 条声明；摘要逐字见下） | 本版运行 |
| mutation baseline（变更域） | `node scripts/spec-baseline-check.mjs` | exit 0 — `no affected specs; no measurement claimed`（本版没有移动任何 spec 或其钉住的测试文件） | 本版运行 |
| docs 一致性 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | PASS — 44/44；§0 的 tag/package 行、214 份说明计数、版本链接全部核对 | 本版运行 |
| Linux（HMC）Node 24.21.0 | `npm run test:release` | 6,772 tests / **6,767 pass / 0 fail / 5 skip** | GOAL 矩阵 @ `e3cc399` |
| Linux（HMC）Node 22.23.4 | `npm run test:release` | 6,772 tests / **6,767 pass / 0 fail / 5 skip** | GOAL 矩阵 @ `e3cc399` |
| Windows 合并树（前序全量） | `npm run gate` | PASS — 6,674 pass / 0 fail / 97 skip（551 文件） | GOAL 矩阵 @ `e3cc399` |
| wire vs v3.10.1 | `WIRE_BASE_TREE=/tmp/wave3-wire-base WIRE_BASE_REQUIRED=1 WIRE_BASE_TAG=v3.10.1 WIRE_BASE_SHA=b00b3b9a… node --import ./test/setup-env.mjs --test test/wire-byte-identity.test.js` | **PASS — 270/270**，0 mismatch；`WIRE_PROVENANCE_COMPARED {"compared":270,"expected":270,"base_head":"b00b3b9a…"}`，`tag_ref_verified true`，tested/base 两侧 clean | HMC @ `e3cc399`（node v24.21.0）；TAP `1/1 pass`，log sha256 `84496fb1…`（10,386 B） |
| 全量 mutation sweep（92 份 spec） | `node scripts/mutation-sweep.mjs --report-dir /tmp/wa-sweep-e3cc399` | **PASS — 92/92 spec**；822 executed = **808 caught + 14 条声明的 `expectCaught:false`**，0 意外幸存、0 drift、0 untrustworthy；wall 2,953 s（49 m 13 s） | HMC @ `e3cc399`（node v24.21.0）；`sweep.out` sha256 `c20e7bac…`；逐 spec 执行数 = 其 JSON `mutations.length`，幸存数 = 其声明数 |

本表数字产生于本版提交前的同一棵树（`e3cc399`；wire 与 mutation 两行在 HMC 上对该 commit 的 clone 实测，两侧 `git status --porcelain` 均为空）；发布提交只回填这张表。`npm run gate` 的摘要逐字如下：

```
PASS spec-static-check exit=0
PASS spec-baseline-check exit=0
PASS secret-scan exit=0
PASS test:release exit=0 — 6674 pass / 0 fail / 97 skip (551 files) — 6 inert file(s), 6 declared
PASS git diff --check exit=0
PASS git diff --cached --check exit=0
SKIP mutation EXECUTION — this gate checks spec shape, anchors and baseline values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.
INCREMENTAL GATE: PASS exit=0
```

`TEST_SHARD_SUMMARY {"files":551,"measuredFiles":551,"tests":6771,"pass":6674,"fail":0,"skipped":97,"cancelled":0,"todo":0}`

## 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增的 7 条也在其中，状态列区分已复核与仍缺。

- **wire 已实测，但只覆盖请求体**：`e3cc399` 对 `v3.10.1`（`b00b3b9`，annotated tag 已验证）**270/270** 逐字节一致，0 mismatch（HMC，见门禁表）。比较范围是 9 组历史 × 5 条 prepare 路由 × 2 native × 3 环境 = 270 个 protobuf 请求体；HTTP/Connect 帧与响应流按设计不在内。本机（Windows）无 `WIRE_BASE_TREE` 时该测试按设计跳过，已声明为 inert。
- **全量 mutation sweep 已实测**：92/92 spec、822 条全部执行，808 被捕获 + 14 条 spec 自带的 `expectCaught:false`，0 drift、0 untrustworthy（HMC，2,953 s，见门禁表）。14 条幸存者是各 spec 文档化的不可达/等价分支，不是漂移。
- **真实 Codex CLI 修复后未重跑**：客户端级 PASS 属于修复前基线（只有打开 `DEVIN_CONNECT_TOOL_CHOICE=1` 才 3/3）；修复后的 200 由探针与单元测试证明，未用真实 CLI 复验。
- **S7 的修法方向是推断**：`swe-1-5` 该落 `MODEL_SWE_1_5_SLOW` 还是 `kimi_k2` 只有快照证据，原证据里已标注。
- **托管 CI / 发布产物未验证**：本版在本地分支准备，tag、CI、HMC 部署与 cosign 资产都要在合并后另行执行与核对。
- **本机门禁的 6 条 inert 声明**：Windows 没有 `/usr/bin/git`，`test/wire-byte-identity.test.js` 无 wire 基线，`test/devin-connect-relogin-live.test.js` 未武装，`detach-soak` / `detach-ls-pool-pressure` 在本机整文件跳过——这些都按 `GATE_INERT_SKIP_PATHS` 声明，不当作绿。
- 明文 `http:` 图片、server-executed 工具类型的 400 仍是**有意**行为：依赖"静默忽略"的客户端会开始收到错误。
