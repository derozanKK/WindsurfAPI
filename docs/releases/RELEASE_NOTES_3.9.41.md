# v3.9.41

> **2026-10-21 维护增量**：代码候选 `f2b938d` 在本文原有 2026-10-19 证据之上补了工具历史、终态与 SSE 修复；旧数字保留为当日快照，当前门禁数字见文末「2026-10-21 维护增量」。发布状态见下一条 2026-10-22 条目。
>
> **2026-10-22 发布集成**：六条修复/测试分支已合入 `release/3.9.41`；用户可感知项、live 证据与门禁数字见文末「2026-10-22 发布集成」。本版已作为 annotated tag `v3.9.41` 打在 `4211656` 上，于 2026-10-22（JST）发布：release run `39627102554` 六个 job 全绿，4 个资产已上传。

本版是 v3.9.40 之后的一次大补丁：**90+ 个提交，57 个 feat/fix**。没有协议兼容性破坏，没有新增协议路由，默认 wire 字节保持不变（`a51a0f1` 对 `v3.9.40` 的 270/270 比较全部相同）。内容集中在五块：工具名/ID/历史的跨方言卫生、SSE 提交门与错误状态、Dashboard 的只读观测面、Devin Connect 的目录/传输/重试修复，以及账号、日志、统计与缓存的可运维性。

**影响面**：默认开启的工具卫生会改变少数畸形工具名/ID 的线上形状；SSE 提交门默认等待 5 秒，预内容错误现在能以真实 HTTP 状态返回；新增若干默认关闭的日志/ACP 开关和 Dashboard 只读接口。没有改协议字段、没有改默认路由、没有改上游 wire。昂贵模型 live 矩阵只覆盖一个 Pro 账号的一次部署，不等同于对所有账号等级的承诺。

> **勘误(2026-10-22,发布后)**:文首两条状态句与「2026-10-22 发布集成」节首那条，原本都写着"版本号与发布状态未改"，并声明当时还没有 tag、也还没有 push。那是 **tag 之前**的实况，不是本版终态；三句已就地改正为 annotated tag `v3.9.41` 打在 `4211656`、2026-10-22（JST）发布，release run `39627102554` 六个 job 全绿、4 个资产，本文件即该 release 的 body。
>
> 上面"**90+ 个提交，57 个 feat/fix**"是 **2026-10-19 的候选快照**，原样保留；按 tag 范围实测，`v3.9.40..4211656` 是 **133 个提交**：**22 feat + 45 fix（67 feat/fix）、24 docs、20 test**，其余为 15 chore、1 refactor 和 6 条 `Merge branch ...` 提交。复跑：`git rev-list --count v3.9.40..4211656` = 133；`git log --format=%s v3.9.40..4211656 | sed -E 's/^([a-z]+)(\([^)]*\))?!?:.*/\1/' | sort | uniq -c`。

## 用户可感知

### 工具名、工具 ID 与历史：跨方言不再截断或丢轮次

v3.9.40 只在 Messages 侧修了 64 字符 wire 上限；这一版把同一类问题扩到三种方言和请求历史：

- **两遍工具名映射**：先收集本次请求的工具名，再在 egress 时恢复客户端原名；Messages 的 split `function.name`（`get_` + `weather`）不再以首片开块，等完整名确认后再发 `content_block_start`，延迟到达的参数在 finish 前补 flush（`src/handlers/messages.js`，`test/startserver-harness-shapes.test.js`）。
- **工具 ID 卫生**：新增 `src/tool-ids.js`，对过长/重复/空 ID 做确定性收敛；重复 raw ID 会按调用顺序分配唯一 wire ID，结果按 FIFO 配对；`src/tool-names.js` 负责 64 字符 wire 名的双向映射；Responses、Gemini、Messages 三条 egress 都接入了同一套守卫。`WINDSURFAPI_TOOL_HYGIENE=0` 现在真正关闭名称映射、ID 清洗和历史规范化（发布审计 P1-1）。
- **历史尾部规范化**：`src/history-normalize.js` 保留 assistant/tool 轮次和数组内容，不再把 `content` 数组压成字符串或丢掉中间轮；孤儿 tool result 只在连续 tool 段结束后折叠成 user 文本，绝不插在 assistant tool_call 和它的有效 tool result 之间（发布审计 P1-2）。
- **Responses split 流名**：`function.name` 被拆成多片时，工具事件与 post-tool 文本先缓冲，等完整名确认后再发 `output_item.added`；参数增量边界和 message/tool 顺序保持不变（`src/handlers/responses.js`，`test/stream-split-tool-name.test.js`）。
- **边界测试**：新增/扩展 `test/tool-*.test.js`、`test/request-tail-contract.test.js`、`test/startserver-harness-shapes.test.js`，覆盖 split 名、重复 ID、64 字符边界、空工具数组、非对象部件和真实 HTTP 流。

### SSE：预内容错误不再伪装成 200，帧边界不再靠运气

- **统一 framer**：`src/sse-framer.js` 现在被 chat、Messages、Responses 三个翻译器共用；混合 `\n\n`/`\r\n\r\n` 终止符、跨 chunk 的 CRLF、超长帧都有上限和测试（`test/sse-framer.test.js`、`test/stream-framer-routes.test.js`）。
- **提交门**：`src/sse-commit.js` 在写 200 之前缓冲首批帧，首个真实内容或错误帧决定提交；`WINDSURFAPI_STREAM_COMMIT_MS` 默认 5000 ms，`0` 恢复旧的“先写 200”行为。所有 SSE 路由（chat/completions/responses/messages/gemini）在发头之前接入同一个门（`src/server.js`，`test/stream-commit-route.test.js`）。
- **错误状态按协议保留**：Responses 的 `MODEL_BLOCKED` 仍是 402，Messages 保持 Anthropic 的 403/529 语义，Gemini 优先使用数字 `code`（400/404/413）；流式 429 保留 `Retry-After` 和 rate-limit 类；预内容错误不再追加 `[DONE]`，避免客户端把错误当正常结束（`src/sse-commit.js`、`src/handlers/chat.js`）。
- **客户端断开**：上游取消信号继续传播，客户端中途断开时记 `client disconnected mid-stream` 并 abort 上游，不触发 failover；连接关闭后健康检查仍为 200。

### Dashboard：只读观测面补齐，密钥前缀不再出现在页面上

新增/扩展的只读卡片都走服务端鉴权，响应带 `Cache-Control: no-store`，账号引用只显示哈希：

- **账号用量与池冷却**：账号 usage、cooldown 原因/剩余时间、rate-limit/capacity/quota 状态，读取内存池，20 秒轮询不触发上游（`src/dashboard/api.js`、`src/dashboard/pool-events.js`）。
- **请求环**：有界 request ring，记录 chat/completions/responses/messages/gemini 以及 `protocol` 字段，支持最近请求列表和统计；流式请求的耗时按完成时间计算（`src/dashboard/request-ring.js`、`src/server.js`）。
- **目录差异**：live catalog 与静态目录的 diff，能看出新增/缺失/改名的模型（`src/dashboard/catalog-diff.js`）。
- **计费/配额 burn-down**：billing health、quota burn-down、模型对账卡片；没有真实计费值时显示未知，不伪造 0（`src/dashboard/billing-health.js`、`quota-burn-down.js`、`model-reconcile.js`）。
- **安全**：Dashboard 读路径优先使用 Devin session token；不再把 API key 前缀当 fallback 渲染；OTP 片段不再写日志，IMAP SEARCH 解析修复（`src/dashboard/index.html`、`src/dashboard/logger.js`）。
- **视觉验收**：1440 宽桌面截图通过，卡片、空态、错误态和刷新路径都检查过（`.agent/absorption-20261018/dashboard-visual-20261019/`）。

### Devin Connect：目录、模型与传输修复

- **live 目录/模型**：刷新 Connect catalog，补 102 个公开成本表模型和新 family；live credit 乘数落到 `src/models.js`；裸别名与 `-medium` selector 的解析保持一致（`src/devin-connect-models.js`、`src/models.js`）。
- **RATE-RETRY R-1..R-5**：完成剩余限流/重试风险项；`Retry-After`、completion config、严格 tag、post-auth decode 分别有回归测试。
- **在途上限（默认关）**：`DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT` 默认 `0`（关闭）；设为 `N > 0` 时账号选择跳过已达 N 个在途请求的账号（含 sticky 绑定），突发流量会分散或 429，而不是继续堆在单账号；陈旧计数由 15 分钟下限的清扫回收（`src/auth.js`）。
- **传输/协议**：cancel 信号传播、LS 超时分类、GetUserJwt 15 秒 deadline、catalog/seat surface 的四个协议修复、workspace trust 字段 3/4 双写；`src/devin-connect.js`、`src/client.js`。
- **缓存回放保真**：DEVIN_CONNECT completion cache 保留已交付文本、stop cause 和 model；缓存命中不再改变 finish 语义（`src/handlers/chat.js`、`test/connect-exact-cache.test.js`）。
- **账号过滤（默认关）**：`WAPI_ACCOUNTS_ONLY` 未设置时加载全部账号；设置后按邮箱/账号 id 做每实例隔离；过滤掉的账号仍保留在 `accounts.json`，保存时不再把整份文件裁掉；空匹配 fail-closed（`src/auth.js`、`test/auth-accounts-only.test.js`）。

### 日志、统计与 ACP

- **日志保留/轮转（默认关）**：`LOG_RETENTION_DAYS`、`LOG_MAX_FILE_MB`、`LOG_MAX_TOTAL_MB`；按完整 JSONL 行切分，容量优先于保留期，写失败不会停止后续 append（`src/dashboard/log-files.js`、`src/dashboard/logger.js`）。
- **统计导入**：完整快照导入带验证，缺字段/坏形状不会覆盖现有统计（`src/dashboard/stats.js`）。
- **ACP 原生模型配置（默认关）**：`DEVIN_ACP_CONFIG_OPTIONS=1` 时在 `session/new` 后按 `configOptions` 调 `session/set_config_option`；默认关闭，因为 live option id/value 尚未校准（`src/devin-acp.js`、`docs/ENV-SWITCHES.md`）。

## 工程与门禁

- **startServer 真实 HTTP 测试**：`test/startserver-harness-shapes.test.js` 现在覆盖 chat/Messages/Responses/Gemini 的成功、非流式、两请求 tool loop、并行 tool calls、split tool delta、600 KB body、OpenAI/Anthropic 图片和 ring `protocol` 字段；`test/startserver-cancel.test.js` 用真实 socket 断开证明一次上游尝试且服务仍健康；`test/review-history-coverage.test.js` 区分 1M 的 900 KB 与普通 600 KB 预算。
- **回归缺口**：补 PR/issue 回归 intercepts（9 条无测试行）、#32 no-tools override、#41 短 identity rewrite、sentence-boundary identity rewrite；修复两条静默 no-op 测试，让断言真正执行。
- **门禁**：本地 `npm test` 5,464 / 5,382 pass / 0 fail / 82 skip；`npm run test:release`/gate 5,382 pass / 0 fail / 82 skip（442 文件）；HMC `a51a0f1` 5,464 / 5,463 pass / 0 fail / 1 skip；`secret-scan` 0；`git diff --check` 0。
- **wire**：`a51a0f1` 对 `v3.9.40` 270/270 比较全部相同，skip 0。
- **mutation**：全量 85/85 在 `4a173a0` 通过（767 条突变，754 caught，13 条声明 survivor，0 mismatch）；最终 Responses split/custom 修复的 4 个受影响规格在 `a51a0f1` 复跑 20 caught + 1 声明 survivor。
- **Node**：Node 矩阵在 `27e30f4` 测得——Node 24 全绿；Node 22 仅 `test/s2-a-golden.test.js` 的跨大版本 fixture guard 失败；Node 20 另缺 `test:summary`/`node:sqlite`。发布门以 Node 24 为准，Node 20/22 的兼容策略另行记录。

## Live 验收（一个 Pro 账号，隔离部署）

- 7/7 路由 smoke 200；昂贵模型 5 个 selector × 4 协议 20/20 200、文本 `PONG`、usage 存在，1.34–4.91 s。
- 23 个 mode 名全部尝试：6 个 live（`swe-2-medium/high/max`、`gpt-6-astra/sol/1-sol`），17 个预上游 `400 model_not_found`。
- 工具 2/2（`gpt-6-astra`、`claude-opus-5-5`）；多轮保留 `Ada`；取消干净；12 并发 Haiku 12/12 200。
- 补测：4 个其他昂贵 selector 的图片 chat 全部 502 `invalid_argument`，加上 opus 的 chat 502 / messages 529，**5 个昂贵 selector 全部拒绝图片**；Gemini 3.5 Flash 控制 200。
- 正确拼写的 `swe-2-medium/high/max-lightning` 3/3 200；`gpt-6-astra`/`claude-opus-5-5` 的流式 tool call 2/2 200，完整名、完整 args、`finish_reason: tool_calls`、`[DONE]`，未出现 split name。
- 73 次客户端请求 / 56 次上游调用，list-price 上限 3,491 credits；wire 没有计费标签，**实际扣费未观测**。
- 证据：`~/.dwgx/ops/research/devinpro-complete-capability-matrix/{MATRIX-REPORT.md,VERIFICATION.md,matrix.json}`。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` **实际计费 debit**：3,491 是乘数上限，不是账单读数。
- `[UNVERIFIED]` **图片**：5 个昂贵 selector 的 chat 图片全部失败（4 个本次补测 + opus 既有）；messages 只对 opus 观测到 529，其他四个未重复。
- `[UNVERIFIED]` **streaming tool deltas**：`gpt-6-astra`/`claude-opus-5-5` 的 live 流式 tool call 已覆盖完整名与完整 args；Gemini 与 Responses 的 split 名均由 fake upstream 覆盖，`output_item.added` 携带完整名。
- `[UNVERIFIED]` **429/402 停止路径**：本轮没有触发，未验证。
- `[UNVERIFIED]` **Node 20/22**：版本性失败仍在，发布门只声明 Node 24。
- `[UNVERIFIED]` **Any2API 集成**：Codex `responses` 直通和 Claude `anthropic` 的 live 冒烟尚未跑；`PATCH-G5.diff` 只是提案，未应用。

## 2026-10-21 维护增量（代码候选 `f2b938d`）

本段是发布候选上的后续维护；原始 2026-10-19 证据保留为当日快照。以下数字只对应 `f2b938dfd04f6771d18e4db723e2944fae555057` 的代码与测试树；后续仅文档变更不改变该证据。

- **工具历史**：畸形/超长 raw tool id 不再覆盖已有 FIFO 队列，后续调用与结果仍按到达顺序绑定；合法 id 与确定性映射不变（`src/tool-ids.js`、`test/tool-ids.test.js`）。
- **终态**：预内容 Cascade 失败只发错误帧，不再追加成功 `[DONE]`；已交付部分内容的失败仍走既有 synthetic finish + 单次 `[DONE]` 兼容路径（`src/handlers/chat.js`、`test/s4-r4.test.js`、`test/stream-error.test.js`）。
- **SSE 语义**：framer 的 payload 上限与网络分片无关；LF/CRLF/CR 统一；`data`/`event` 等字段允许空值；注释开头的内容不会被后续错误替换；忽略行、data、event 分别记账，dispatch 时合计仍受限（`src/sse-framer.js`、`test/sse-framer.test.js`）。
- **SSE 性能**：分隔符扫描改为单游标 `/[\r\n]/g`，大批量帧从二次降为线性；本机 Node 24 固定批次观测 160k 帧约 28 ms（修复前约 3.6 s），不作为通用延迟保证（`src/sse-framer.js`）。
- **平台门**：Windows `npm run gate`（含 `test:release`）**5,415 pass / 0 fail / 82 skip**（442 文件）；Linux release **5,497 pass / 0 fail / 0 skip**（442 文件）；wire **270/270** 对 `v3.9.40`。
- **Linux 首次聚合 gate**：**exit 2**，原因是 detached clone 缺少 `origin/master`；这不是零退出。补跑缺失层 `spec-baseline-check` 得到 **85 specs / 0 drift / 0 untrustworthy**（base `6fd35b3`）。受影响 mutation 规格共 **11** 个预期：**10 caught + 1 个已声明 survivor**（`s4-r4` 5/5；`terminal-event-guard` 5 caught + 1 declared）。
- **相关项目（独立）**：Any2API 候选 `a4b3406` 的 LF 集成树 `go test ./...` 为 **18 ok + 1 no-test / 0 fail**；二进制已构建并固定哈希。其 live 结果不在本版范围，不作为本版证据。

## 2026-10-22 发布集成（`release/3.9.41`，六条分支合入）

> 本节记录 2026-10-21 分头完成、2026-10-22 合入的六条修复/测试分支。上面的 2026-10-19 与 2026-10-21 段落保留为当日快照；本节数字只对应本集成树（`929a070`，发布说明提交另计）。该树之上的发布说明提交 `4211656` 就是 annotated tag `v3.9.41` 的目标，已发布。

### 用户可感知

- **分片工具参数（四个出口）**：上游把 `function.arguments` 拆成多个增量时，chat/completions、Messages、Responses、Gemini 四个出口在 1、128、4096 字节边界（含工具名最后一片才到、参数夹多字节字符）逐字节重组，不截断、不丢片；文本模拟的 `<tool_call>` 拆分同样不泄漏标记。`test/tool-args-split-assembly.test.js` 在四个出口、三个边界上做字节级断言。组装行为在 `e3e39d9` 上已正确，本次补的是此前缺失的覆盖：A1 组的 3 条针对性突变全部被捕获（总计 8 条，见 `evidence/a1a2-mutcheck.log`）。
- **并行工具调用交错（Messages）**：两个 `tool_use` 的参数增量交错到达时，Messages 不再为第二个调用重开块而丢掉第一个调用的后续片段；所有参数在 finish 前无损组装，每个块都有 `content_block_stop`（`src/handlers/messages.js`、`test/tool-calls-interleaved.test.js`）。代价是除首个调用外，其余调用在 finish 时才输出参数——这是 Anthropic 单开块流模型下唯一的无损表示。文本/thinking 与工具块的交错仍沿用既有的“记录并丢弃”限制，不在本版范围。
- **终态后的错误不再被吞**：成功终态（finish / `message_stop` / `response.completed` / `finishReason`）之后到达的错误帧按到达顺序转发，Messages/Responses/Gemini 不再补发第二个成功终态；SSE 提交门在已提交 200 后逐字节转发错误帧，不改写响应。该行为在 `e3e39d9` 上已正确，`test/late-error-after-terminal.test.js` 现在把它钉死（A2 组的 5 条突变全部被捕获，同一批 8 条中的其余 5 条）。
- **SSE 多行 `data` 固定**：LF/CR/CRLF 三种终止符、逐字符投递、空 `data:` 行和混合终止符下，framer 与提交门都按 `\n` 连接多行 `data`；多行 JSON 错误对象仍能在提交前被识别为错误，pretty-print 的 role 帧仍被扣住到首个内容帧（`test/sse-multiline-data.test.js`）。framer/提交门行为在 `e3e39d9` 上已正确，本次是固定证据。
- **Gemini schema 保真度**：`oneOf`、属性级 `allOf`、数字 `enum` 在 wire 上精确保留（不选分支、不压平、不字符串化）；根级 `allOf` 仍按上游限制被剥离，prompt 模拟层的有损行为也被记录（`test/gemini-schema-fidelity.test.js`，characterization，`e3e39d9` 上即绿）。
- **Cascade 历史按 UTF-8 计数**：历史预算改用 `Buffer.byteLength(..., 'utf8')`，与 proto 编码一致；此前按 UTF-16 计数，CJK 历史会把约 1.8 MB 当成 600 KB 送上 wire（`src/client.js`）。
- **Cascade 轮询有界**：步骤读取窗口改为 `max(pollFloor, stepOffset - 8)` 的有界重叠，`stepOffset` 只前进不后退；部分步骤的增长仍会被重读，但轨迹不再从 0 反复整取（`src/client.js`）。
- **工具活跃停顿上限保留**：`pendingToolCalls` 以“调用名+参数”为键跨窗口记录 ACTIVE 工具调用，工具步骤离开重叠窗口后 `hasActiveStep` 仍为真，文本停顿上限不会误杀工具轮（`test/client-budget-offset-transient.test.js`）。
- **“Panel state lost” 不再当传输错误**：重试循环合成的 `Panel state lost N times after re-warm — likely an LS-level issue with very large payloads` 是确定性的终态失败，不再按可重试传输错误轮换账号；LS 自己返回的 `panel state not found` / Initialize 失败仍是传输错误（`src/client.js`、`test/client-panel-retry.test.js`）。
- **请求环记录流式失败类**：提交门保留首个失败，四条流式路由（chat/responses/messages/gemini）在 `onDone` 用与普通错误体相同的 class 更新环行；中途失败不再显示为 `ok`（`src/server.js`、`src/sse-commit.js`、`test/o10-ring-class.test.js`）。
- **Windows LS 拿到 APPDATA**：`LS_ENV_ALLOWLIST` 在 `win32` 上额外放行 `APPDATA`，修掉 LS 启动即报 `failed to determine user config directory: %AppData% is not defined`；`LOCALAPPDATA`、`USERPROFILE`、`SystemRoot` 与凭据仍被过滤（`src/langserver.js`、`test/langserver-redact.test.js`）。

### 文档

- README 中英双语新增「项目定位与使用边界 / Project Scope and Usage Boundaries」：BYO-account、不提供/出售/出租账号、独立项目声明，并保留原有正文。
- `docs/ENV-SWITCHES.md` 按 `e3e39d9` 重测：三前缀开关 **160** 个，`.env.example` + README 覆盖 **78** 个，本文覆盖其余 **82** 个。

### Live 证据（一个付费 devin-team 账号，隔离部署）

- **账号与付费面**：桌面会话 token 被 `server.codeium.com` 接受；`plan: pro`、`isPaid: true`、catalog 240 个模型且无免费默认；三个 provider 各一个 selector（`claude-opus-4-8-medium`、`gpt-5-5-medium`、`gemini-3-8-flash-medium`）全部返回内容，harness 判定 `PAID entitlement CONFIRMED`；11/12 请求上限，4 次付费探测，0 个 402/429。
- **#272 assistant-role 图片**：图片只挂在 assistant 轮时被客户端空 assistant 过滤丢弃（wire 里没有 base64）；把同一图片强行放到带文本的 assistant 轮（C/C2，HTTP 200）后模型仍说没有图片，同一形状的 user 轮控制组（D）正确回答 `Checkerboard`——上游在语义上忽略 assistant 轮图片，放宽过滤只会把字节送给上游丢弃。issue 维持 open，缺的是显式说明/日志而不是放行。
- **#236 GLM-5.2 工具调用**：`glm-5-2-none` 加强制 prompt，一次 200，`finish_reason=tool_calls`，单个 delta、参数 `{"city":"Paris"}`、无旁白（form B）；报告人要的 `ToolRoute[...]` 行在 DEVIN_CONNECT 路径上根本不会打印（只在 Cascade 分支），这是独立的可观测性缺口。
- **#239 计费标签**：一次真实付费回合（`glm-5-3-low`，200，`PONG`）的 wire 上没有任何 credit/ACU/overage 字段（`#14/#22/#26/#27` 不存在），`balance` 为 `null`，账本前后无可观测变化；结论是“wire 无证据”，不是“没有扣费”。
- **#250 reasoning 泄漏**：3 个 live 回合未复现标记泄漏；唯一的 reasoning→content 复制是 reasoning-only 回合触发 `finish=length` 时的既有 promotion 回退（`contentChars == reasoningChars`），不是上游标记泄漏。3 回合不足以证明不存在，issue 维持 inconclusive。
- **workspace trust**：部署的 3.10.67 LS 上，`InitializeCascadePanelState` 只写 field 3 被 `untrusted workspace` 拒绝，只写 field 4 则回合成功并返回 `TRUSTED-OK`——**#4 是读取字段**，field 3 在该构建上被保留且不读；`UpdateWorkspaceTrust` field 2 写同一槽位。

### 工程与门禁

- 合入六条分支（全部基于 `e3e39d9`）：`docs/positioning-and-drift`、`fix/a1-a2-protocol`、`fix/client-budget-offset-transient`、`test/o10-ring-class`、`test/sse-multiline-schema`、`fix/ls-env-appdata`；合并后 `git status --porcelain` 为空。
- Windows `npm run test:release`：**5,507 pass / 0 fail / 82 skip（452 文件，5,589 tests）**，exit 0。
- Windows `npm run gate`（`GATE_INERT_SKIP_PATHS` 显式接受 4 个平台门）：**PASS exit=0**——`spec-static-check`、`spec-baseline-check`、`secret-scan`、`test:release`（5,507 pass / 0 fail / 82 skip，452 文件，4 inert / 4 declared）、`git diff --check`、`git diff --cached --check` 全绿；增量门不执行 mutation（按设计），Linux 侧补跑。
- Linux/HMC `npm run test:release`（全新 clone，无 Windows 平台 skip）：**5,588 pass / 0 fail / 1 skip（452 文件，5,589 tests）**，exit 0；计入 skip 计数的唯一文件是 `test/wire-byte-identity.test.js`（未提供 `WIRE_BASE_*` 时的自身跳过，该文件随后按下面的 wire 命令单独跑满）；另有 `test/devin-connect-relogin-live.test.js` 以 suite 级跳过（0 tests），不计入 skipped 计数。
- mutation（HMC，引用本次改动文件的 14 个规格）：**170 条突变，167 caught + 3 条已声明 survivor，0 mismatch**；14/14 规格 exit 0、baseline 与规格声明一致、每次还原后树干净（`client-invariants` 8、`client-history-coverage` 4、`terminal-event-guard` 6 均在内）。
- wire（HMC，`25322dd` / `v3.9.40` worktree 为基线）：**270/270 比较相同，0 skip，exit 0**；provenance `tested_head=929a070`、`base_head=25322dd`、`tag_ref_verified=true`。
- `secret-scan` 与 `git diff --check`：**exit 0 / exit 0**（独立重跑与 gate 内各一次）。

## 升级注意

- `WINDSURFAPI_TOOL_HYGIENE` 默认开启；依赖原始畸形工具名/ID 透传的调用方需要显式设 `0`。
- SSE 提交门默认 5 秒；需要旧的“立即 200”行为时设 `WINDSURFAPI_STREAM_COMMIT_MS=0`。
- 日志保留/轮转和 ACP 原生配置默认关闭；开启前先读 `docs/ENV-SWITCHES.md` 的边界说明。
- 本版没有改协议路由或默认 wire；wire 门禁的 270/270 是默认路径未移动的证据，不是“wire 全部正确”的证明。
