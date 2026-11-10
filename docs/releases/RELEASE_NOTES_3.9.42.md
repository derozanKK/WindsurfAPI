# v3.9.42

本版是 v3.9.41 之后的加固补丁：**8 条修复/测试分支合入**，集中在四类用户可感知的缺陷——客户端中途断开后部分答案仍被缓存/计费/复用、慢读客户端买到无上限的上游工作、三种协议出口在交错与分片输入下丢内容、重复的上游 tool call id 原样发给客户端——外加 SSE 帧边界的三处边角、Node 20/22 上 Connect 绝对 deadline 不触发，以及流式两轮工具循环的 harness 级回归锁。

没有协议兼容性破坏，没有新增路由，没有默认开关变化（唯一新增开关 `WINDSURFAPI_MAX_DRAIN_MS` 有默认值，见「升级注意」）。默认 wire 字节由 wire 门禁按 `v3.9.41` 基线逐条比较（数字见「工程与门禁」）。

## 用户可感知

### 客户端断开：部分答案不再被缓存、计费或复用

`cascadeChat` 在客户端断开时跳出轮询循环，然后照旧走完成尾：`onEnd`、generator-metadata RPC、chunk metadata、`return chunks`。两个 handler 都无法把它与正常结束区分，于是把一个半截答案当成完整回合提交——归还复用池、记 spend、写成功统计、写 `finish_reason:"stop"` + `[DONE]`，最后 `cacheSet`。**下一次相同的请求直接从缓存返回这个半截答案，且零上游调用。**

- **流式**：`cascadeChat` 在 `endReason === 'aborted'` 或 `signal.aborted` 时抛出与 legacy 通道同形的 `AbortError`（`name`/`code: ABORT_ERR`），因此跳过 `onEnd`、元数据 RPC 和正常返回；抛错前复位 `_lastReuseInvalidated`，复用的 client 实例不会把本回合的标志带进下一次（`src/client.js`）。
- **流式 handler**：断开后不再向已关闭的 socket 写帧（Node 对 post-close 写不抛错，只能显式判断）；`cascadeChat`/`rawGetChatMessage` 返回后若信号已 abort，在尾 flush 之前返回（覆盖「循环结束后才断开」的竞态）；attempt 的 catch 在 `signal.aborted` / `AbortError` / `ABORT_ERR` 时立即返回——不重试、不罚账号、不记请求统计、不发错误帧、不发失败尾 `[DONE]`，且已签出的 reuse entry 不归还池；成功块前的 pool check-in、成功 `[DONE]`/`res.end()`、`cacheSet`、失败尾 `[DONE]`、缓存重放 `[DONE]` 全部加同一条件（`src/handlers/chat.js`）。
- **非流式**：断开时返回 **499 `client_disconnect`**，在账号分类、`recordRequest`、`log.error` 之前；调用后的同步成功块之前再查一次 `signal?.aborted`，因此没有 pool check-in、没有 `cacheSet`、没有 token/spend 记录、没有成功体。由于检查之后的每一步都是同步的，close 事件无法插进来（`src/handlers/chat.js`）。

回归：`test/cascade-abort-side-effects.test.js`（11 条）。在 `769d6ee` 上 **11 fail / 0 pass**（`cascadeChat` 仍以部分 chunks 正常返回、向已关闭的响应写了 2 帧、reuse pool 1 !== 0、spend 0 → 11、post-turn metadata RPC 1 !== 0 等），修复后 11 pass。非 abort 路径的每一帧、统计、池、计费、缓存与响应体不变。

### 背压：慢读客户端不再买到无限上游工作

`streamResponse` 的 `send()` 丢弃 `res.write()` 的返回值，Cascade 轮询循环也从不 await 消费者（`onChunk?.(chunk)`，`src/client.js` 五处）。一个停止读取的客户端因此换来了**无上限的生产者工作**：更多轨迹轮询、更多帧、更多 socket buffer，没有任何压力回传。`res.write` 返回 `false` 是普通的慢读信号（Node 已接受该帧），不是失败。

- **一个流内写门**：`writeRaw` 是唯一的 `res.write` 调用点；`false` 只启动**一个** drain 等待（不排队、不重发被拒的帧），与 `drain`/`close`/`error`/请求 abort 竞争，恰好 settle 一次并摘掉自己的监听器。`writeFrame` 顺序化：先等未完成的 drain，再写一次（`src/handlers/chat.js`）。
- **发射链顺序化**：`emitVisibleContent`、`emitContent`、`emitExternalContent`、`emitThinking`、`emitToolCallDelta`、native fallback、每个 chunk 的发射器都 await 自己那一帧；`holdChunkBoundary()` 结束每条 chunk 路径（含 native bridge 的两个提前 return），所以生产者在被拒的那一帧处停住，而不是下一帧。终态顺序同样过门：finish 帧、usage 帧、`[DONE]` 之前都 `awaitWriter()`；缓存重放与失败阶段（`failureStage` 现在可 await）走同一个门。
- **心跳不添字节**：有 drain 未完成时跳过 tick；心跳自身报告背压也arm 同一个等待。关闭通告在 abort 之前同步 `writeRaw`（尽力而为），不会被它本要绕过的门丢掉。
- **半开客户端有上限**：`WINDSURFAPI_MAX_DRAIN_MS`（默认 **120000 ms**，八个心跳周期）到期后尽力写一帧 `server_error` / `DRAIN_TIMEOUT`，settle 等待并 abort 请求，`drainTimedOut` 阻止后续任何新等待/新定时器；定时器 `unref()` 且每次 settle 都清掉。没有这个上限时，停止读取但保持 TCP 的客户端会把回合与账号租约钉到连接结束。
- **生产者 await**：`src/client.js` 的五个 `onChunk?.()` 改为 `await onChunk?.()`。同步消费者返回 `undefined`，await 是 no-op；rejection 作为真实的回调失败向上传播，不会被误判成解析错误。

回归：`test/stream-backpressure-drain.test.js`。在 `769d6ee` 上 9 条测试全部失败（第二个帧就被拒的 writable 仍收到 4 次写、期望 2；role 帧自身被拒时 4 !== 1）；修复后 9 条全绿，P2 跟进再加第 10 条（半开客户端），10 pass / 0 fail。去掉上限的半成品在该测试上 4 s 超时，加上限 47.8 ms 通过并归还账号（`_inflight` 1 → 0）。

**边界（明确不声称）**：`backpressureArmed = useCascade`。legacy `rawGetChatMessage` 从 gRPC `onData` 回调同步消费 `onChunk`，无法挂起生产者，armed 会让 `onEnd` 越过未完成的发射，所以那条路径的背压**没有**修；Messages/Gemini/Responses/Connect 路由的 `res` 是恒返回 `true` 的捕获适配器，门不会触发。本版关闭的是直连 Cascade SSE 这条路径。没有真实慢读 socket（内核缓冲区写满）的测量，也没有 RSS 上限测量。

### Messages：交错文本不再截断工具参数，`is_error` 不再丢

- **文本/thinking 与工具参数交错**：`emitTextDelta`/`emitThinkingDelta` 通过 `startBlock` 关闭当前块。`tool_use` 块打开时，一个文本增量就把工具块关掉，随后到达的参数片段没有合法去处（块永不重开），只能留在 `pendingArgs` 里被 `finish()` 记一条 warning 后丢弃——`Read` 拿到 `{"path"`，`JSON.parse` 失败。现在工具块打开期间文本/thinking 被**持有**（按到达顺序，同类型合并），工具块保持 current，后续片段照常 flush；`finish()` 时按原顺序在工具块之后发出。若当前工具已累积成完整 JSON，则先关工具、文本就地流出，普通非交错流的字节序完全不变。普通非交错 fixture 的归一化 SSE 在基线与修复后 sha256 相同（`0d5087…`）。
- **无法无损表示时显式失败**：参数字节既没有可打开的块（无 id/name），又属于已关闭的块时，旧代码静默丢弃并仍发 `stop_reason:"tool_use"`。现在 `finish()` 发一条 `error`（`overloaded_error`，说明「N 个参数字节没有可打开的 tool_use 块」）且不发 `message_delta`/`message_stop`。这不是通用 JSON 校验器：模型产出的完整但格式错误的 payload 仍原样转发。
- **`tool_result.is_error` 传播到每个工具**：旧代码只有 Read 的启发式注解读这个字段；OpenAI 形状的 tool 消息与 Cascade 请求编码器都没有它的槽位（proto 的 `is_error` = field 7 只在响应 delta 上），所以除 Read 外全部丢弃。现在失败结果在 Read 注解之后加上固定标记 `[tool error] `；非错误结果字节不变。

回归：`test/messages-interleave-lossless.test.js`（新增）。基线 `Messages-red-baseline.log`，修复后 `Messages-green-fixed.log`；探针 `evidence/MessagesProbe.mjs` 对真实 handler 输出做了前后 JSON 对比。

### Responses：空的尾部消息与分片工具名导致的冻结

- **D4 空尾消息**：先说一段文本再调用工具的回合，以第三个空 `message` item 结束。`finish()` 用整回合累加器 `this.text` 判断当前 item 有没有文本，而 `finishMessage()` 发布的是 `this.segmentText`（工具把前置 item 封口后是 `''`）。门改读 `segmentText`。修复前输出 `[message "BEFORE ", function_call, message ""]`，修复后只剩前两个 item。
- **分片 `function.name` 冻结**：首个名字片段设置 `deferred`，而之后所有名字判断都被 `!this.deferred` 守卫，于是名字确认后 item 也永远打不开：整个流被缓冲到 `finish()` 再按「非文本先、文本后」重放。现在名字一旦可证明是最终的（名字补全、参数开始、流结束）就立即结束 deferral；缓冲区是**一条**有序列表；只发布最终名字。实测 `text → "get_" → "time" → args → text` 的客户端字节：修复前在首个片段处停在 1834 字节直到 finish，修复后 1120 → 1834 → 2092 → 2285 → 2946 逐步增长；`added` 的 output_index 顺序与发射顺序一致（`[0,1,2,3,4]`）。
- 评审轮（Kimi 对 `0ac4a79`）提出的 1 个 P1 + 2 个 P2 已在同分支复现并修复（`8e41a98`：名字片段之间也持有文本、只对「正在 defer 的那个调用」的证明结束 deferral、item 工厂去重）。

回归：`test/responses-empty-tail-and-split-name.test.js`（新增）。

### 工具调用 ID：重复的上游 id 在三个出口唯一化

上游可以把同一个 call id 用两次（并行调用或重复回合）。请求侧早已修复（`normalizeToolIdsInMessages` → `uniqueToolId`），但**客户端先看到重复**：Messages 流、Responses（流与非流）、Gemini（流与非流）都原样发布。

新增 `createToolIdAllocator()`（`src/tool-ids.js`）复用请求侧同一套后缀算法，每个响应/回合一个实例：首次出现的 id 保持原样（经清洗），后续重复按到达顺序得到 `_2`、`_3`…；分配按 call index 只做一次（后续 delta 里重复的 id 不会二次分配）；名字/参数/结果不动，只改 id 字符串；`WINDSURFAPI_TOOL_HYGIENE=0` 保持原样透传。Messages 非流保留历史 `toolu_<hex>` 回退，Responses 保留各 item 类型的 `call_<hex>`/`ws_<hex>` 回退。

六个出口的前后对照（两次调用都用 `call_dup`）：`['call_dup','call_dup']` → `['call_dup','call_dup_2']`。每个流测试跑同一假上游回合两次并断言 id 列表相同（确定性），再把发出的 id 回放进下一回合的请求侧（`handleMessages`/`responsesToChat`/`geminiToOpenAI`）断言 id 与 tool-result 配对不变。修复前 19 条里 6 fail，修复后 47 pass / 0 fail。

### SSE 帧边界：BOM、提交后失败扫描、typed ping

- **前导 UTF-8 BOM 丢掉第一帧并提交 200**：framer 按行首字节分类（`:` 或 `event|data|id|retry` + `:`），BOM 解码出的 `\uFEFF` 让首行不匹配任何字段，第一帧被静默丢弃；提交门同样直接 `JSON.parse` 该缓冲区，payload 为空 → `errorFromFrame` 返回 `null` → 以 **200** 写出错误字节，真实状态与 `Retry-After` 丢失。现在 framer 在流起点丢掉恰好一个 BOM（流开始之后到达的 BOM 不丢），提交门的解析视图同样丢弃，而 `pending` 仍保留原始字节——以 SSE 提交时客户端逐字节收到 BOM。
- **提交后的失败扫描把整次写当成一帧**：`errorFromFrame(buf.toString('utf8'))` 会把缓冲区里所有 `data:` 行用 `\n` 连起来，内容帧 + 错误帧的写入因此 `JSON.parse` 失败、`failure = null`，请求环把明明发出了错误帧的请求记成无失败类。现在逐帧扫描（`scanFailure`），跨写的半帧由有界 `scanCarry` 携带；状态码仍不可被已提交的响应改写。
- **`event: ping` 会提交门**：framer 正确派发了 ping 帧，但 `isBootstrapFrame` 只认注释帧与各路由的 JSON 谓词，于是默认（openai）协议下 ping 提交了 200，后续的预内容错误再也改不了状态。现在 `isKeepaliveFrame` 按「最后一个 `event` 值」识别 `ping|keepalive|keep-alive`（大小写不敏感）并对所有协议按 bootstrap 处理；错误检查在 bootstrap 检查之前，所以带 `{"error":…}` 的 ping 仍映射到真实状态。

每一层都被突变检查过：删掉 framer 的 BOM 处理 → 2 条测试红；删掉门的 BOM 处理 → 3 条；删掉 keepalive bootstrap → 2 条；改回整次写解析 → 1 条；`scanCarry` 恒空 → 1 条；去掉 `endsAtFrameEnd` 快路径 → 1 条。

### Node 20/22：Connect 的绝对 deadline 不再被 unref 掉

`streamChat` 用 `setTimeout(…, absoluteDeadlineMs)` 布下绝对 deadline 后立刻 `unref()`。在没有其它 ref 的进程里（测试的消费者被阻塞、没有活动 handle），Node 20/22 的事件循环可以在定时器到期前结束——deadline 不触发，请求永远不会返回 `DEADLINE_EXCEEDED`。现在只要还有消费者被阻塞，这个 deadline 就保持 ref'd；请求正常收尾时清掉。

同分支还修了两处测量基础设施：`scripts/s2-a-golden.mjs` 的 golden fixture 改按 `engines.node` 判定而不是按采集时的 major（Node 20 上因此不再误判），`.github/PULL_REQUEST_TEMPLATE.md` 里「Node 22 才有此限制」的说法换成实测的 Node 20 界限。新增 `test/devin-connect-deadline-ref.test.js` 在独立进程里守住这个 ref 窗口。

HMC 实测（同一主机、同一批二进制，`evidence/NodeFix.md`）：Node 20.20.2 `test:release` 从 **5,466 pass / 22 fail / 96 cancelled** 变为 **5,564 pass / 21 fail / 0 cancelled**；Node 22.23.4 从 **5,491 pass / 1 fail / 96 cancelled** 变为 **5,589 pass / 0 fail / exit 0**；Node 24.21.0 计数不变（+1 条新测试）。`test/devin-connect.test.js` 在 Node 20 上连跑 5 次、Node 22 上 3 次，每次 195/195。

### 覆盖：流式两轮工具循环

`test/startserver-harness-shapes.test.js` 新增 4 条 streaming 两轮工具循环测试（chat / Messages / Responses / Gemini）：假上游发出一个参数里带 nonce 的工具调用（名字与 JSON 都跨 delta 拆分），下一回合只有在 OpenAI 形状的 `messages` 里看到 `role:"tool"` 且含该 nonce 时才回最终答案，因此路由丢结果或错配会直接失败。四条在 `769d6ee` 上即绿——这是**覆盖缺口，不是缺陷**；它们锁住真实 harness 走的流式路径（终态顺序、`[DONE]` 位置、`sequence_number` 单调、无第二个工具调用）。临时突变（清空 `input_json_delta.partial_json` / `function_call_arguments.delta`、把 Gemini 参数换成 `{}`）分别让对应测试红，日志见 `evidence/HarnessStream-mutation-*.log`。

## 工程与门禁

- 合入 8 条分支（全部基于 `769d6ee`），顺序与合并提交见下表；每次合并后跑该分支触碰的测试文件，全部绿（`evidence/Integrator-342.md` 有逐次数字）。合并后工作树干净。
- Windows `npm run test:release`：**5,576 pass / 0 fail / 82 skip（457 文件，5,658 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：**PASS exit=0** —— `spec-static-check`、`spec-baseline-check`、`secret-scan`、`test:release`（同上 5,576 / 0 / 82，457 文件，4 inert / 4 declared）、`git diff --check`、`git diff --cached --check` 全绿；增量门不执行 mutation（按设计），Linux 侧补跑。
- 85 个 mutation 规格、767 条突变锚点在本集成树上逐条核对：**767/767 恰好匹配一次**（`responses-post-tool-text-item` 的首条锚点因 Responses 的 item 工厂重构成 `openToolItem` 而失效，已按同一突变语义重指到 `if (seal) this.sealMessageSegment();`）。
- Linux/mutation/wire：见本文件末尾「2026-10-22 集成验证」一节（同一集成树，HMC）。

## 2026-10-22 集成验证（`release/3.9.42`，HMC）

- Linux `npm run test:release`（Node v24.21.0，457 文件）：**5,657 pass / 0 fail / 1 skip（5,658 tests）**，exit 0。
- mutation（HMC，POSIX git）：`cascade-metadata-egress`、`cascade-think-reroute`、`responses-post-tool-text-item`、`s4-r4` 四个受影响规格全部 **exit 0**，每条突变均按预期 caught。
- wire：`WIRE_BASE_TREE=/tmp/wapi-341`（`v3.9.41` = `4211656`），`test/wire-byte-identity.test.js` **270/270 比较一致**，`WIRE_EXIT=0`；provenance：tested `a6bcb63`、base `4211656`、expected tag `v3.9.41`。本提交只改本文档，`src/` 字节不变。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实慢读 socket（内核缓冲区写满的 `ServerResponse`）未测；写门由受控 `EventEmitter` writable 与真实轮询循环驱动，`res.write === false` 的契约本身是 Node 的，未重新测量。
- `[UNVERIFIED]` 未观察到真实上游发出前导 BOM；BOM 修复是防御性的。
- `[UNVERIFIED]` 本版没有 live 上游/账号验收：所有协议用例都用既有 fake-`res` / fake-upstream 形状。
- `[UNVERIFIED]` legacy `rawGetChatMessage` 的背压仍然缺失（本版范围外，见上）；Messages/Gemini/Responses/Connect 路由不声称端到端背压。
- `[UNVERIFIED]` 没有 RSS 测量：C2 的承诺是「生产者进度有界」，不是内存硬上限。

## 升级注意

- 新增 `WINDSURFAPI_MAX_DRAIN_MS`（默认 `120000`，要求正整数，否则回落默认）。半开客户端在这个时长后被 `DRAIN_TIMEOUT` 中止并归还账号租约；把它调大只会延长租约占用，不会让死连接复活。
- 客户端断开现在返回 499（非流式）或直接结束（流式），**不再**写 `finish_reason:"stop"` / `[DONE]`，也不再缓存或计费该回合。依赖「断开也能拿到部分成功体」的调用方需要改为从流里自行累积。
- Messages 在「参数字节无任何合法去处」时改为发 `error` 且不发 `message_stop`（旧行为是静默丢弃 + 声称 `tool_use`）。这类流本来就是坏的，但现在会显式失败。
- 重复 tool call id 现在会在三个出口得到 `_2`/`_3` 后缀。客户端若自己按原始 id 做跨回合映射，需要按「首见保持原样」的规则重新对齐。
- `WINDSURFAPI_TOOL_HYGIENE=0` 仍是完整回滚开关（id 清洗、去重、名称映射、历史规范化一起关闭）。
