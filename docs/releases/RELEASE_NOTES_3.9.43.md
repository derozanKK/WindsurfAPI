# v3.9.43

本版是 v3.9.42 之后的两条补丁：**ACP 工具调用不再静默丢失**，以及 **Dashboard 在 1440/390 宽度下不再横向溢出**。没有协议兼容性破坏，没有新增路由，没有默认开关变化。

## 用户可感知

### ACP：agent 发起的工具调用现在真的到达客户端

`devin acp` 的 `tool_call` / `tool_call_update` 通知此前被适配器丢弃（只保留文本），而 `stopReason:"tool_use"` 又被降级成 `finish_reason:"stop"`——客户端看到一次正常结束，却永远拿不到工具名和参数。现在：

- `tool_call` / `tool_call_update` 按 `toolCallId` 合并（title / kind / status / authoritative `rawInput`），`stopReason` 为工具类时投影成 OpenAI 形状的 `message.tool_calls` + `finish_reason:"tool_calls"`（非流式与 SSE 都覆盖）；现有翻译层据此产出 Anthropic `tool_use` + `stop_reason:"tool_use"`。
- `tool_call_update.content` / `rawOutput` **不会**被伪造成工具结果——更新只用于合并调用本身。
- 工具类 `stopReason` 但没有任何具名调用时，返回 **502 `backend_tool_call_unmapped`**，而不是静默的 `stop`；该错误不计入账号错误 streak。

回归：`test/devin-acp-tool-updates.test.js`（3 条，真实 fake `devin acp` 子进程穿过两个协议前端）。基线 0/3，修复后 3/3；13 个 ACP / special-agent 套件 141/141 绿。突变抽查：去掉 `hasToolCalls` 让测试 1–2 红，去掉守卫让测试 3 红。

**边界（明确不声称）**：未跑真实 Devin CLI/账号的 ACP 会话；`/v1/responses` 对 `tool_calls` 的渲染未单独验证；客户端侧的 agent 工具行为未测。

### Dashboard：账号页/概览页不再横向溢出

`.main` 是 flex 子项但缺 `min-width:0`，内容的最小内容宽度把整页撑出视口：accounts 在 1440 宽下 `scrollWidth 1628 / clientWidth 1430`，390 宽下 1416 / 380。现在 `.main{flex:1;min-width:0}`，表格只在自己的 `.table-wrap` 内滚动：

| 页面 / 宽度 | 修复前 | 修复后 |
|---|---|---|
| accounts 1440 | 1628 / 1430 | **1430 / 1430** |
| overview 390 | 945 / 380 | **380 / 380** |
| accounts 390 | 1416 / 380 | **380 / 380** |

未改 token、颜色、字体、皮肤；`index-sketch.html` 未动。24 个 dashboard 测试文件 / 240 条全绿；`check-i18n.js`、`check-inline-sync.js` 通过；1440/390 的 22 个面板扫描全部无横向溢出。

## 工程与门禁

- 合入 2 条分支（均基于 `3ff5d0e`）：`fix/acp-tool-updates` `929a0d6`、`fix/dashboard-layout-overflow` `058f5bd`。
- Windows `npm run test:release`：**5,579 pass / 0 fail / 82 skip（458 文件，5,661 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：**PASS exit=0** —— `spec-static-check`、`spec-baseline-check`、`secret-scan`、`test:release`（同上 5,579 / 0 / 82，458 文件，4 inert / 4 declared）、`git diff --check`、`git diff --cached --check` 全绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，458 文件）：**5,660 pass / 0 fail / 1 skip（5,661 tests）**，exit 0。
- mutation：`acp-model-argv`、`strict-usage-total` 两个受影响规格（ACP 改动文件）exit 0；ACP 新逻辑的突变抽查见上（去 `hasToolCalls` / 去守卫）。
- wire：`WIRE_BASE_TREE` 指向 `v3.9.42`（`3ff5d0e`），`test/wire-byte-identity.test.js` **270/270 比较相同**，0 skip，exit 0；provenance：tested `e23c39f`、base `3ff5d0e`、expected tag `v3.9.42`。本提交只改文档/版本，`src/` 字节不变。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 Devin CLI 的 ACP 工具调用与真实客户端渲染。
- `[UNVERIFIED]` `/v1/responses` 的 ACP `tool_calls` 输出。
- `[UNVERIFIED]` 真实浏览器之外的 dashboard 视口（只测 1440/390 两档）。
