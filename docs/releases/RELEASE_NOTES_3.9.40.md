# v3.9.40

本版把三类畸形输入关回本地裁决：带 per-user scope 的 `content:[null]` 曾让**缓存键规范化**在验证
之前抛 500（`src/cache.js` 对原始 body 运行，`chat.js:2840` 设计如此），`system:[null]` 曾在
Anthropic 转换器里抛同类 500，`/v1/responses` 的空 `content: []` 曾被 `JSON.stringify` 成两字符
文本 `"[]"` 顶替用户提示词送上游——三处现在都按既有规则在本地拒绝或放行。仪表盘显示**解码后的
ACU 成本**（只在解码器产出值时、绝不显示假 0，子分位不压平）；校准器不再把顶层费用坐标 `#22`
当模型名；thinking 块始终携带 `signature`（PR #278）。工程侧四项：请求尾契约成文、CONTRIBUTING
补审查与合并标准（RC0–RC12）、一份 harness 不能评分的突变规格收窄、八处烂数字改指来源或带日期。

**影响面**：只有发送畸形请求的调用者、开启 ACU 计费解码的部署（仪表盘多一列）、运行校准器的
操作者、以及把 thinking 块 `signature` 当必填的严格客户端会看到差异。**没有**新路由、没有新增
协议字段（`signature` 是 Anthropic thinking 块的既有字段，此前无真实签名时会被整个省略，现在
始终存在）、没有任何默认开关变化；无 live-account 验收（本机没有已付费账号）。

## 用户可感知

### 畸形 content / system 不再打成 500

`content:[null]` 且调用者带 per-user scope（`body.user` / `safety_identifier` / `prompt_cache_key`）：
缓存键在**验证之前**对原始 body 计算（`src/handlers/chat.js:2840`），`normalizeBinary` 在 null 部件上
读 `.type` 抛 `TypeError`（旧 `src/cache.js:89`），路由答 500——而同一 body 不带 scope 时拿到的是
共用 400。现在非对象条目原样穿过（`src/cache.js:97`、`:100`），两条路径都拿到 400
"*The last user message has empty content. Provide a non-empty user prompt.*"（`chat.js:3027`）。

`src/handlers/messages.js` 的 `anthropicToOpenAI` 同类两处：`system:[null]` 在 `b.text`（旧
`messages.js:646`）抛、`content:[null]` 在 `block.type`（旧 `:664`）抛，都是 500。现在系统数组按
`b?.text || ''` 贡献（`:651`）、非对象内容块跳过（`:675`）；`content:[null]` 得到共用 400
"*The conversation must end with a user message or a tool result.*"，`system:[null]` 不再炸转换器。

原始 HTTP、loopback、假账号实测（2026-10-07，本机 Windows；记录在提交 a2d8d07）：修复前三例分别
500（TypeError 在 `cache.js:89` / `messages.js:664` / `messages.js:646`）；修复后前两例 400，
`system:[null]` 越过转换器（本机 529 只是因为 LS 二进制缺失）。钉法：
`test/malformed-content-parts.test.js`（新文件，10 测试，本机 10 pass / 0 fail）；每条守卫单独
回退各自变红（提交记录：cache 守卫 → 3 fail / 7 pass 等）。

同一批改动里 `/v1/responses` 的消息数组改走部件循环（`src/handlers/responses.js:52-108`）：字符串
与 `{text}` 部件成为文本、null 跳过、无文本的数组落回共用 400；tool 输出保留 JSON 渲染
（`toolOutput` 选项，`:64`，调用点 `:464`、`:478`）。

### `/v1/responses` 的空 `content: []` 不再变成两字符垃圾文本

`normalizeMessageContent` 曾把零长度数组 `JSON.stringify` 成 `"[]"`——两个非空白字节，绕过了共用
空 user 守卫（predicate B），上游拿到的是字面文本而不是空。现在零长度数组保持空
（`src/handlers/responses.js:61`），与"所有部件都被丢弃"同一语义（`:108`），请求落回共用 400。
审查时的实测：`responsesToChat` 输出 content `"[]"`；live `handleResponses` 返回 403
`model_not_entitled` 而不是 400。

钉法：`test/request-tail-contract.test.js` 的空数组用例（本机 17 pass / 0 fail）+ 突变规格条目。

### 仪表盘显示解码后的 ACU 成本（仅有值时）

账户详情的终身消费块补上 ACU 列（`renderSpendCells`，`src/dashboard/index.html:6871`）：**只在
解码值 > 0 时渲染**（`:6879`、`:6884`），标签写明是解码值（`ACU cost (decoded)`，
`src/dashboard/i18n/en.json:1133`；zh-CN 同），与 credit 分列、绝不相加，也绝不显示假 0。
ACU 是 opt-in 坐标：`committed_acu_cost` 只在 `DEVIN_CONNECT_BILLING_TAGS` 点名它时解码（默认
映射只有两个已付费验证的 cache 标签，`src/devin-connect.js:1465`），默认部署看不到这列。

子分位不再压平：canonical 解码值 `0.0006735000060871243`（`test/acu-opt-in-decode.test.js:16`）
此前经 2 位小数的 `frac()` 渲染成字面 `0`；`acuFmt`（`index.html:6877`）对 0.01 以下保留 4 位有效
数字 → `0.0006735`。钉法：`test/dashboard-spend-acu.test.js`（新文件，本机 8 pass / 0 fail；
子分位两例在 bd30c54 之前是 6 pass / 2 fail）。

### 校准器不再把顶层费用坐标当模型名

`decodeFrame` 对顶层 double 发射 `{kind:'fixed64', preview, raw}`，`aggregateDumps` 此前把它当字符串
处理（`"[object Object]"`），于是描述符验证过的顶层 double `committed_acu_cost #22` 落进
`actual_model_uid` 桶，harness 输出 `DEVIN_CONNECT_ACTUAL_MODEL_TAG=22`。现在：

- 顶层数字（varint / fixed64 / fixed32）归 `billing/cache`（任务 #46，
  `scripts/devin-connect-calibrate.mjs:143`），`#22` 不再进模型名桶；
- 提示按作用域拆分：顶层候选用解码器的 `^N` 形式（`:303`，如
  `DEVIN_CONNECT_BILLING_TAGS=<field>=^22`），meta 候选用裸 tag；示例保持 `<field>=^N` 泛化——
  多候选帧（#14/#18/#22/#26）下不会把某个键配到错误的 tag（旧输出曾会渲染
  `committed_acu_cost=^14`，把 credit 接成 ACU）；
- meta 候选同时命中 billing 与 cache_tokens，列表改为并集（`:296`），不再出现 `[14,15,14,15]`。

钉法：`test/devin-connect-calibrate.test.js`（本机 20 pass / 0 fail）+ selfTest 守卫。

### PR #278：thinking 块始终携带 `signature`

7d72818 曾在无真实签名时整个省略 thinking 块的 `signature` 键（当时假设 `signature: ""` 会被
严格客户端拒绝）。事实相反：严格客户端把该键当必填，缺失会让整条响应 / SSE 事件失败
（"missing field `signature`"），空串反而可解析；流式的 `content_block_start` 此前根本没有该键。
现在非流式 thinking 块始终带 `signature`（真实值或 `""`，`src/handlers/messages.js:893`），流式
`content_block_start` 带 `signature: ""`（`:1182`），`signature_delta` 仍只在真实签名时发射。

钉法：`test/messages-thinking-contract.test.js`（2 pass）+ `test/messages.test.js`（84 pass），
本机原生。

## 工程与门禁

### 请求尾契约成文

`docs/REQUEST-TAIL-CONTRACT.md`（新文件，125 行；35710da + 19b8b18）把两条本地 400 的判据写成
文件：assistant 结尾的对话上游不能服务——8334cea 实测 `UPSTREAM_INTERNAL`，连续两次会
quarantine 账号 120 秒（`src/handlers/chat.js:2971-2973`）；空的新 user 轮次会被"当作系统提示词
本身"作答（OpenClaw probe 场景 #14，79cd990）。文档同时记录 per-surface 差异：Anthropic/Gemini
转换器先丢弃无产出的轮次（服务），chat 与 responses 落回守卫（400）。钉法是三件套：
`test/request-tail-contract.test.js`（17 测试，本机 17 pass）、
`test/mutations/request-tail-contract.json`（7 条突变）、以及 0fb8bb2 补的谓词顺序钉。

### CONTRIBUTING 补上审查与合并标准

`CONTRIBUTING.md` 新增中英两半（a2ede85，+112 行）：RC0 元规则（守卫只有"回退后会红、且在生产的
形状上红"才算）、开 PR 前自答清单、RC1–RC12 十二条拒绝标准（每条引原文并附出处 issue 编号）、
以及作用域规则。纯文档，无运行时变化。

### s2-b-frame-assembly 收窄后可评分

`test/mutations/s2-b-frame-assembly.json` 的 B-length / B-inflate 两条突变此前让
`test/s2-b-connect.test.js` 第 7 个测试（`exactly MAX_FRAME_SIZE remains accepted`，`:78`；
`MAX_FRAME_SIZE = 16 * 1024 * 1024`，`src/connect.js:26`）在 16 MiB `assert.deepEqual` 上生成断言
消息、触发多 GB 分配：node 24.19 上约 45 s 后 "Array buffer allocation failed"，bench 的 node 24.21
直接把进程 OOM abort；runner 把整个文件算作一个失败单元，harness 的 guard 5 拒绝该规格
（"changed how many tests RAN: baseline 23, mutated 10"）。两条突变改为最窄的相邻行为变化
（71b2ae8）：B-length `len > MAX_FRAME_SIZE` → `len > MAX_FRAME_SIZE + 1`；B-inflate
`maxOutputLength: MAX_FRAME_SIZE` → `- 1`。现在 23 个测试全跑。

本机（Windows / node v24.19.0）以规格自身的 anchor/replacement 字节手工套用：基线 23 pass / 0 fail；
8 条突变全部判红（各条 1–10 个测试变红），每次都是 23 测试全跑——该规格在 HEAD 上可评分。全量
`scripts/mutate-verify.mjs` 重评分记录在 71b2ae8：**WSL，node v24.21.0，1500 MB cgroup 限制内存**
（该规格的旧突变会让进程 OOM），8/8 命中、exit 0；本机 harness 自身拒绝运行（需受信绝对路径的 POSIX git）。

**bench 复核（2026-10-07，`hmc`，`runs/master-final`）**：`origin/master` @ `74f6c6d` —— 与本版
tag 目标**同源代码**（差别只有版本号与文档）—— `GATE_EXIT=0`，全量 **`sweep_ok=85 sweep_abort=0`**
（85 份规格全部可评分，零拒收），其中该规格的日志写着
`all 8 mutation(s) behaved as expected; tree clean`。

`node scripts/spec-static-check.mjs` 本机：85 份规格 / 766 条突变，锚点唯一、格式良好。

### 文档：八处烂数字改指来源或带日期

`claim-drift.py` 实测八处复述已腐烂（tag 计数 200→201、发布说明 188→190、v3.9.37→v3.9.39 两处、
归档 handoff 10→14、PR 84→87、extra-hands 文件 909→4513、archive-bytes 快照）外加一处过期的
tracked-files 计数；仓内修复（5fe110d）：`docs/README.md` 的发布数 / 最新版本 / 产品 tag / handoff
数改为指向来源，tracked-files 计数改为 `git ls-files docs/`；CHANGELOG 的 tag 计数与 CONTRIBUTING
的 PR 计数改成带日期的记录（截至 2026-10-05）；`GATE_INERT_SKIP_PATHS` 示例按宿主拆成两组实测
（POSIX 两个 / 原生 Windows 四个）。另更新 star 历史图（`docs/assets/star-history.svg`，纯资产）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` **无 live-account 验收**：本机没有已付费账号；live 套件（`test/devin-connect-relogin-live.test.js`）
  未 armed，整个套件按声明跳过。
- `[UNVERIFIED]` `system:[null]` 的"修复后完整 200"在本机只能验到越过转换器（提交记录本机 529 因 LS 二进制
  缺失）；200 由仓库自身 backend seam 的测试钉住，真实账号路径未验。
- `[UNVERIFIED]` s2-b 的 harness 全量重评分（8/8、exit 0）先是 **WSL** 记录（node v24.21.0，1500 MB cgroup 限内存），
  现已由 **bench 复核**（`hmc`，`runs/master-final`，`74f6c6d`，`GATE_EXIT=0` 且
  `sweep_ok=85 sweep_abort=0`，该规格日志 `all 8 mutation(s) behaved as expected; tree clean`）。
  本机以手工字节复验 8/8（23 测试全跑），但 `scripts/mutate-verify.mjs` 在本机拒绝运行（POSIX git）。

## 验证记录

- 版本范围：`git log --oneline v3.9.39..master` → 23 个提交（其中 16 个内容提交，7 个 merge）。
- 本机 2026-10-07（Windows / node v24.19.0），
  `node --import ./scripts/mutation-network-deny.mjs --import ./test/setup-env.mjs --test --test-reporter=tap --test-force-exit <file>`：
  `test/malformed-content-parts.test.js` 10 pass / 0 fail；`test/request-tail-contract.test.js`
  17 pass / 0 fail；`test/dashboard-spend-acu.test.js` 8 pass / 0 fail；
  `test/devin-connect-calibrate.test.js` 20 pass / 0 fail；`test/messages-thinking-contract.test.js`
  2 pass / 0 fail；`test/messages.test.js` 84 pass / 0 fail。
- `node scripts/spec-baseline-check.mjs request-tail-contract.json` →
  `ok request-tail-contract.json: 17 pass + 0 approved skips = 17 [MEASURED_NO_SKIPS]`。
- 手工突变复验（规格自身字节，本机）：s2-b 规格基线 23 pass、8/8 判红、每次 23 测试全跑。
- **bench（`hmc`，`/root/testbench/windsurfapi-20261005`，`runs/master-final`，2026-10-07）**：
  `origin/master` @ `74f6c6d`（与本版 tag 目标同源代码）—— 门 `GATE_EXIT=0`，
  全量变异 sweep **`sweep_ok=85 sweep_abort=0 sweep_other=0`**（85 份规格全部可评分）。
