# v3.9.49

本版三条：**协议字段按描述符修正**、**LS 安装器改为清单 + 固定哈希**、**账务 UI 不再编造 0/日期**。没有协议兼容性破坏；LS 升级到 3.10.67（可回滚 3.5.17）。

## 用户可感知

### 协议：StopReason 与 int64 字段不再丢

- `StopReason` 不再全部映射成 `stop`：`FUNCTION_CALL(10)→tool_calls`、`MAX_TOKENS(3/1/5/9)→length`、`CONTENT_FILTER(11)→content_filter`、`ERROR(13)→error`；未知值仍 `stop` 但每个值只记一次日志。
- `overageBalanceMicros` 接受 proto3 JSON 的 int64 字符串（`"80000000"` → `$80`），同时保留数字；`-1`/`abc`/空/`1e13`/布尔/对象一律 `null`。
- `ChatToolChoice` oneof 只写一个成员（具名工具 → `tool_name`，否则 `option_name`），不再同时写两个。

### LS：从清单安装当前版本，失败即停

- `install-ls.sh` 改为读取 `https://windsurf-stable.codeium.com/api/versions`，按 `ls-pins.json` 固定 commit + 归档 sha256 + 内层二进制 sha256；任一层不匹配即非零退出，目标文件不动。
- 默认 3.10.67（Linux x64 / macOS arm64 / macOS x64），保留 3.5.17 的 `--rollback` 固定回滚；移除静默 Exafunction 回退。
- 真实安装验证：Linux 3.10.67 内层 sha `11190150…`，macOS arm64 `e6481920…`，回滚 3.5.17 `0555f889…`；无二进制进仓库。

### 账务 UI：未知就是未知

- `availableCredits` 缺失显示 `— credits`，真实 0 仍显示 0；prompt/flex remaining/used 缺失显示 `—`。
- 抽屉把 `periodStart/periodEnd` 标为“每日/每周配额重置”，真实计划周期单独成行；每周 tooltip 从“已消耗”改为“仍剩余”。
- 池余额没有可计账号时显示 `—`，不再编造 `$0.00`；`usage.cycle.total` 缺失为 null。

回归：描述符 49/49（父提交 13 fail）、LS 安装器 13/13 + 原子重命名 4/4、账务 17/17 + 相关 122/122；全量 5,790/0/82。

## 工程与门禁

- 合入 3 条分支（均基于 `312c148`）：`fix/descriptor-fields` `ca35fea`、`fix/ls-manifest-install` `bdb63eb`、`fix/billing-truth` `ee20d01`。
- Windows `npm run test:release`：**5,819 pass / 0 fail / 82 skip（477 文件，5,901 tests）**，exit 0。
- Windows `npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，477 文件）：**5,900 pass / 0 fail / 1 skip（5,901 tests）**，exit 0。
- mutation：`connect-catalog-hotfix`、`dashboard-connect-parity`、`credit-cost-top-level` 三个受影响规格 exit 0。
- wire：对 `v3.9.48`（`d909ae6`）**270/270 比较相同**，exit 0。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 LS 3.10.67 的 `UpdateWorkspaceTrust`/`prompt_cache_key` 端到端行为（仅二进制字符串与安装验证）。
- `[UNVERIFIED]` Linux arm64 无上游归档，需 `--file`。
- `[UNVERIFIED]` 真实上游的 int64 字符串 JSON 响应（描述符 + 解码器验证）。
