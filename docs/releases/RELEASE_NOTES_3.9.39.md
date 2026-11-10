# v3.9.39

本版修两条工程缺陷：**上游错误响应体在流式与 unary 两条读取路径上都没有上限**——一个行为不端
（或带敌意）的上游只需发一段超大的错误响应，就能把代理进程整体打退；以及**门禁对“声明了测试、
却一条都没执行”的文件失明**——整段跳过的套件不计入 skip 合计，绿色结论背后可以根本没有证据。
变化只发生在非 200 错误响应超过上限、或宿主上存在未声明的 inert 文件时；无公开接口、路由、
字段或默认开关变化。

## 用户可感知

### 一个坏的上游错误响应不再能把进程打退（流式 + unary 两条路径）

流式路径（`src/devin-connect.js` 的 streamChat non-200 分支）此前把上游错误体**整个累积**，
再在 `'end'` 监听器里 `Buffer.concat(...).toString('utf8')`。一个持续输出的上游可以越过 V8 约
512 MiB 的字符串上限：`ERR_STRING_TOO_LONG` 在没人捕获的位置抛出、升级为 `uncaughtException`，
`src/index.js:42-44` 直接退出进程——**一个租户收到一次坏响应，所有租户断连**。

同一形状在 unary 侧还有两处：`postConnectUnary`（GetUserJwt）把整个响应体读进来、非 200 时丢弃；
catalog 探测（GetCliModelConfigs / GetUserStatus / AssignModel）先 `toString` 再 `slice(0, 200)`。
实测（node v24.21.0）：catalog 路径收到 500 + 600 MiB 多块响应体时，`ERR_STRING_TOO_LONG` 从
`'end'` 监听器逃逸、进程退出 1；`postConnectUnary` 读取中途保留 300 MiB → 修复后 8.2 MiB。
修复后同样的 600 MiB 响应 → 退出 0、`UPSTREAM_ERROR`、消息带截断标记。

三处读取现在共用 `createBoundedBodyAccumulator`：上限 8 MiB，模块加载时读取一次
（`DEVIN_CONNECT_MAX_ERROR_BODY_BYTES` 可覆盖；非正数或不可解析回落到默认值——“没有上限”正是
被修掉的那个 bug）。跨越上限的那一块**切在边界处**保留真实前缀，而不是整块丢弃——否则单块大响应
会只剩一个描述不了任何上游输出的空标记。catalog 路径改为**先 slice 再 decode**；超过上限的 200
响应体被拒绝，而不是把前缀当完整消息解析。

影响范围：正常成功流量不变；上限只对超过 8 MiB 的响应体生效（真实错误体是 JSON 信封或短文本，
JWT 与目录响应也远小于上限）。

## 工程与门禁

### 门禁能看到“声明了测试却一条没执行”的文件

一个文件整体跳过（含 `describe.skip` 的整套件）时，跳过合计里可能什么都不剩——`npm run gate`
会对着不存在的证据报 PASS。门禁现在给出**逐文件的 inert 普查**：`tests > 0 且 pass+fail == 0`，
以及 `tests == 0 且 suites > 0`（整段套件跳过）两种形状都算；未声明的 inert 文件判红并**点名
路径**，声明过但不再命中的条目报告为 `unused`。接受是显式的、无默认值；无 wire base、无 live
凭据的 POSIX 宿主实测需要的就是这两条：

```text
GATE_INERT_SKIP_PATHS=test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js
```

两种形状都对真实 runner 验证过：整段跳过以探针文件在真实 shard runner 上实测。

### mutate-verify：被取消的 baseline 报成“截断”，不再报成“失败套件”

node 22 上事件循环先排空时，一个合法的 baseline 运行会给出 `pass=99 fail=0 cancelled=95` 的形状。
旧措辞把这种**截断**宣布成“红的套件”，并在 `failing:` 下列出一堆根本没失败的用例名——
2026-10-05 因此花掉一次完整调查。现在按实测分岔：`fail > 0` 才用失败措辞；`fail == 0` 且
`cancelled > 0` 报“截断”并给出 cancelled 计数与名单；其余只报数字、不宣布成因。`ok` 判定两边
都不变；node 24 路径不受影响。

### 文档：DEVIN_ONLY 路由的 ACP 模型通道

`src/backend-router.js` 的注释此前声称 ACP 路径“只”把模型作为 prompt 提示传递、不切换 CLI core。
前半句是错的：模型被压进 `devin acp --model <key>` 的启动 argv（`src/devin-acp.js:530-531`），
prompt 侧提示是**另外**还发一份（579-582 行）。新增测试钉住 argv 通道与“操作者已自带 `--model`
时不重复”守卫，并补 `test/mutations/acp-model-argv.json`，让“删掉这一 push”的突变永久判红。
CLI 的 `--model` 是否切换其底层 core，本仓库无法证明，仍需真实账号 live 探测——文档中的
“（未经验证，需要 live 探测）”标记保留。

### 其它工具与文档更正

`CONTRIBUTING.md`、`.env.example`、`scripts/local-gate.mjs`：写出宿主实际需要的两条声明；
删除已被证伪的理由（“import 期抛错的模块会表现为 skip”——实测是文件判失败：`tests 1 / fail 1`、
退出 1，`fail` 计数一直抓得住，从来不是跳过）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` **无 live-account 验收**：本轮每个宿主上 `accounts.json` 都是 2 字节的空池。
- `[UNVERIFIED]` **四个仪器仍未运行**：`WINDSURFAPI_LEAK_TRACE=1`、`DEVIN_CONNECT_DEBUG_META=1`、
  `calibrate:devin`、`cascade-survival-probe.mjs`。
- `[UNVERIFIED]` **`s2-b-frame-assembly` 的突变裁决仍然缺失**：它的突变本身破坏模块加载，harness 按设计拒绝
  把这种运行当作证据（拒绝 ≠ 判绿）。

## 验证记录

- **突变全量扫描**：2026-10-05 首次在 HMC bench（node v24.21.0）原生跑完（逐规格
  `npm run mutate -- <spec>`；CI 不运行这条链路）：**84 份规格 / 759 条突变**——738 条判红、
  13 条为规格内已登记的 survivor，其余 8 条属于按设计拒绝的那份规格（`s2-b-frame-assembly`，
  无裁决）；83 份规格按声明的预期完成，0 份出现未预期的结果。
- 上限的新多块 pin：评审发现“删掉累加行 `bodyBytes += c.length`”能让整套测试保持全绿
  （用例都只推单个 chunk）；新增“三块 32 字节对 64 字节上限”的多块用例后，该突变**恰好判红
  一条测试**。上限边界另按 63/64/65 字节实测。
- unary 侧新增 `unary-body-bound` 规格（4 条突变，anchor 各唯一）；catalog 的
  slice-before-stringify 顺序**不做**突变：上限生效时该顺序在上限之下不可观测，突变会报
  SURVIVED，而它是抬高上限后的纵深防御（人工复跑：还原该顺序整套保持绿色，属于构造上的必然）。
