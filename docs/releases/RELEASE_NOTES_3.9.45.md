# v3.9.45

本版是 **账号管理页重做** + **Dashboard 17 条端到端 smoke**。没有协议兼容性破坏，没有新增默认开启的开关，没有新增路由前缀。

## 用户可感知

### 账号管理：一页完成登录、导入、维护、探测、批量操作

原来的账号管理是 12 列表格 + 顶部独立“添加账号” + 单独的“登录取号”页 + `<td colspan=12>` 详情行；现在合并为一个页面：

- **KPI 条**（账号数 / 活跃 / 异常 / 冷却 / 余额 / 请求）+ **工具栏**（全部探测、刷新全部余额、导出、密度）+ **筛选**（搜索 300 ms 防抖、层级、8 态状态、仅异常、计数、清除）。
- **9 列表格**（Key/错误/ID 折进单元格与抽屉），行尾 kebab：探测层级/模型、刷新余额、屏蔽模型、重新登录、启用/停用、重置错误、删除；**右侧抽屉**（焦点陷阱、Esc、焦点返回、固定 footer）替代 colspan 行。
- **吸底批量条**：显式“选择本页 / 选择全部 N 项”，逐项 `{ok}/{fail}` 进度与失败浮层；批量删除必须显式 ids。
- **一个添加/登录/导入 modal**：登录（邮箱密码 / 邮箱验证码）、粘贴凭证、批量导入、本机扫描；顶部“添加账号”与独立“登录取号”页删除，旧 hash 保留别名。
- **Key 只显示 masked**（first8…last4），不再有 reveal/copy 整键的单元格；日志只记 id-hash/labelHash。
- **主题**：workshop-paper 浅/深 token（默认深色不变），`--on-accent` 修正白字对比，移除 Google Fonts；badge 改为 label=`--text` + hue 点，四组原本 AA 不达标的配色全部通过（label 8.44–13.69，dot 3.59–5.57）。
- **API**：`GET /accounts` 增加 `q/status/sort/order`；`total` 与行用同一 predicate（修复组合筛选下计数漂移）；新增 `GET /accounts/ids`、`POST /accounts/batch`（去重、1000 上限、部分失败 200 + `failed[]`）；`quotaCooled`/`capacityThrottled` 走同一条状态阶梯（badge/band/filter/drawer 一致）。

回归：15 个 dashboard/相关测试文件 **179/179**；新增 `dashboard-account-query.test.js` 9 条；截图断言 1440/390 无横向溢出、表格 1148 适配 1148 wrap、9 列、行高 42–44、6 KPI、零 console error；`check-i18n` 与 `check-inline-sync` 通过；独立审查无 P1/P2（转义、路由鉴权、total、key 脱敏、a11y 全部复核）。

### Dashboard smoke：17 条真实 HTTP 流程

新增 `npm run smoke:dashboard`（`scripts/dashboard-smoke.mjs`）：用临时 `DATA_DIR` 与脚本化 fake upstream 启动真实 `startServer()`，覆盖 dashboard HTML（en/zh-CN）、models 鉴权 401/200、两种登录探测、email start/complete、token 添加账号、列表、探测、余额刷新、目录差异、请求环、usage、删除、secret 扫描。`test/dashboard-smoke.test.js` 把它接进 CI（exit 0 + 每条 PASS + secret 扫描）。负向对照（usage 路由改坏）exit 1、15/17，证明不是空跑。

## 工程与门禁

- 合入 2 条分支（均基于 `e9be4da`）：`feat/account-ui` `062b425`、`test/dashboard-smoke` `835379c`。
- Windows `npm run test:release`：**5,629 pass / 0 fail / 82 skip（464 文件，5,711 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：**PASS exit=0** —— `spec-static-check`、`spec-baseline-check`、`secret-scan`、`test:release`（同上 5,629 / 0 / 82，464 文件，4 inert / 4 declared）、`git diff --check`、`git diff --cached --check` 全绿。
- Linux `npm run test:release`（HMC，Node v24.21.0，464 文件）：**5,710 pass / 0 fail / 1 skip（5,711 tests）**，exit 0。
- mutation：`gap-dashboard-loopback-proxy`、`dashboard-connect-parity`、`sticky-queue-on-pin`、`firebase-referrer-block-map` 四个受影响规格 exit 0（`sticky-queue-on-pin` 的一条 documented survivor 未变）。
- wire：`WIRE_BASE_TREE` 指向 `v3.9.44`（`8120ebf`），**270/270 比较相同**，exit 0；provenance：tested `b3dea2c`、base `8120ebf`、expected tag `v3.9.44`。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实账号在重做后的账号页上的完整视觉/交互走查（截图使用 fixture key，配额单元多为设计的“获取失败”态）。
- `[UNVERIFIED]` 真实上游的批量探测/刷新（fake upstream 覆盖路由与失败形状）。
