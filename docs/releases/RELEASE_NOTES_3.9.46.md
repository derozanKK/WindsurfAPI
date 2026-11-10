# v3.9.46

本版修一个用户可见的账务显示错误：**账号池余额不再显示 `$18,446,744,073,709.43`**。

## 用户可感知

`GetUserStatus` 的 `#1.13.16` 是 uint64 微美元。账号没有可用的 on-demand 余额时，上游发的是 `-1`（未设置/无限哨兵）；按无符号 varint 读出来是 `2^64-1`，除以 `1e6` 后变成 `18446744073709.43`，Dashboard 的“账号池余额”把它当成真实美元累加。修复：

- 解码层：只有 `0 .. $1,000,000`（微美元 `0 .. 1e12`）的余额才算真实；哨兵/负数/超界一律 `balance:null`、`balanceUnit:null`，不再写入 `balanceMicro`。
- 刷新层：billing 返回 `balance:null` 时删除旧的 `credits.balance`，避免上一次的哨兵值继续留在账号对象里。
- 聚合层：负数（既有的“无快照”哨兵）和超过 $1,000,000 的值不计入 `balanceTotal`/`balanceAccounts`。

回归：`test/billing-userstatus-decode.test.js` 新增两条（uint64 -1 → null；$1.50 仍正确解码），该文件 + `s4-r3` 共 17/17 通过；`s4-r3` 的既有“无 billing 快照”语义未变。

## 工程与门禁

- 合入 `fix/uint64-balance` `c90e30a`。
- Windows `npm run test:release`：**5,631 pass / 0 fail / 82 skip（464 文件，5,713 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：**PASS exit=0** —— 全部子门绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，464 文件）：**5,712 pass / 0 fail / 1 skip（5,713 tests）**，exit 0。
- mutation：`unary-body-bound`（引用 catalog 文件的受影响规格）exit 0。
- wire：`WIRE_BASE_TREE` 指向 `v3.9.45`（`ae2607b`），**270/270 比较相同**，exit 0；provenance：tested `ce0ff3a`、base `ae2607b`、expected tag `v3.9.45`。本提交只改文档/版本，`src/` 字节不变。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实账号在 15 分钟刷新周期后的 HMC 页面（部署后由 `refreshCredits` 自动清除旧值）。
