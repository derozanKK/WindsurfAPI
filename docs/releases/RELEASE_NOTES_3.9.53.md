# v3.9.53

本版六条：**CascadeTurn 生产者（默认关）**、**Docker 一条命令更新 + 自动回滚**、**五项安全审计修复
（SEC-01..SEC-05）**、**GitHub backlog（#272 / #258 / #236）**、**出站历史预算与 PR #274 孤儿守卫**、
**124 条 smoke 矩阵扩到 20 族**。没有协议兼容性破坏；默认开启的行为变更不只有两条只记日志的计数器
（见下方「勘误」）。

## 勘误（2026-10-23）

首段「唯一新增的默认开启行为是两条只记日志的计数器」不准确。除 `assistant_images_dropped` 与
`prose_tool_intent` 这两条只记日志、不改 wire 的计数器外，v3.9.53 还有两项**默认开启**的行为改变：

- **出站历史预算**：不设环境变量时即生效——`WINDSURFAPI_HISTORY_BUDGET_TURNS` 默认 100、
  `WINDSURFAPI_HISTORY_BUDGET_BYTES` 默认 8 MB。超过任一维度的请求在到达任何上游之前返回
  413 `payload_too_large`（`code: history_budget_exceeded`）。升级后长会话客户端可能第一次看到
  该 413；把对应维度设为 `0` 可关闭（见「GitHub backlog」的 #136 / #191 条）。
- **PATCH 状态白名单**：`PATCH /accounts/:id` 的 `status` 只接受 `active` / `disabled` / `error`；
  `banned`、`reauth` 及其他拼写错误的值返回 400 `ERR_ACCOUNT_STATUS_INVALID`，不再原样落盘。
  这是 dashboard API 的收紧，不影响聊天 wire。

## 用户可感知

### CascadeTurn：可恢复的 Cascade turn（默认关）

- `WINDSURFAPI_CASCADE_TURN=1` 时，`cascadeChat` 的轮询核心改走 `src/cascade-turn.js` 的生产者对象：
  它拥有 `stepOffset` / `pollFloor` / `yieldedByStep` / `thinkingByStep` 与重叠窗口，并在返回的 chunks
  上附带 `turnSnapshot`。**默认关**——关时走原有内联轮询，行为与返回形状都不变。
- 快照缺逐 step 游标会被 `CascadeTurnCursorError` 拒绝，所以“只按 `stepOffset` 恢复”的 E2b
  0 steps / 0 chars 形态无法被构造出来。
- 回归：单步内 596 → 16,632 字符的三步增长，存储游标恢复返回完整文本且只返回一次；重叠窗口不越过
  `pollFloor`、瞬时抓取失败重试同一窗口、final sweep 只在严格扩展时追加 `modifiedText`。

### Docker：一条命令更新，失败自动回滚

- `bash deploy/update.sh`：预检（`docker compose` v2、daemon、compose 文件）→ 锁（owner PID 可证死才回收）
  → 记录回滚点（镜像 ID + 引用，旧镜像打 `:rollback`）→ `pull` → **只重建 `windsurf-api` 服务**
  → 等 `GET /health` → 任何一步失败自动恢复旧镜像。数据卷不动，不需要 Watchtower、compose profile
  或 Docker socket 挂载。
- 变体：`--tag`（钉发布 tag，接受前导 `v`）、`--image`、`--build`、`--dry-run`（只打印计划）、
  `--rollback`、`--help`。`docker-compose.yml` 的镜像改为变量，fork/自定义 registry 不再要改文件。
- 文档 `docs/DOCKER-UPDATE.md`；`npm run smoke:docker-update` 跑脚本自身的 19 条用例
  （POSIX-only 的集成夹具在 Windows 上 skip，见「尚未验证」）。

### 安全：五项审计发现（SEC-01..SEC-05）

- **SEC-01**：dashboard 的空白 proof 在 `verifyPassword` **之前**就被拒绝，未认证的空 header 不再每次
  付 ~20 ms scrypt（免费 CPU DoS），也不再推进锁定计数；真实猜测走原路径。
- **SEC-02**：nginx 只记 `$uri`，query string 全部丢弃——`?key=` 这种可接受的鉴权载体不再落进
  access log / `docker logs` / 支持包。
- **SEC-03**：`accounts.json` 与 `.env` 每次写后 best-effort `icacls /inheritance:r`（JS helper +
  `start.ps1` / `tray.ps1` 同步），失败只 warn、绝不让写失败；POSIX 上是真 no-op。
- **SEC-04**：发布流程为四个资产生成 `SHA256SUMS` 并一并发布，三个二进制作业把 esbuild 钉在 `0.28.1`。
- **SEC-05**：`secret-scan` 增加未加引号的 `KEY=value` 规则，不再整目录豁免 `test/_research/`
  （实测扫描干净），并写明 git 历史扫描是另一件事。

### GitHub backlog

- **#272**：仅图片的 assistant turn 仍然在编码前被丢弃（上游对 `role=assistant` 忽略图片，放行等于送它
  注定丢弃的字节），但不再静默——记日志并累加 `assistant_images_dropped`；没有图片槽位的 native
  tool-call 分支同样报告。**wire 字节不变。**
- **#258 残留**：未映射的模型名不再退化到冻结的 `swe-1-6-slow`（同步目录里不存在，会把 502 伪装成
  “daily usage quota has been exhausted”，把模型名问题指向账号）。降级目标改为**活的免费 selector**
  （先 cost tier、再 rate table，且必须是目录里真实存在的）；一个都不合格时返回 400 `model_not_found`。
  没有 live catalog 时仍用静态下限。
- **#236**：纠正性 rescue 需要 `sawReasoning && !sawText`，reasoning-effort `-none` 的 selector 永远
  满足不了。不重试一个无法与正常散文回答区分的形状，改为 issue 要求的**只记日志**检测器：
  “叙述了工具调用、实际 0 次调用”的 turn 记日志并累加 `prose_tool_intent`，开关
  `DEVIN_CONNECT_PROSE_INTENT_DETECT`（默认开）。**不改 wire。**
- **#136 / #191**：出站历史预算 `src/history-budget.js`——`WINDSURFAPI_HISTORY_BUDGET_TURNS`（默认
  100，低于实测 113 轮猝死点）与 `WINDSURFAPI_HISTORY_BUDGET_BYTES`（默认 8 MB，低于 10 MB 入口上限）。
  任一维度超限即拒绝，`0` 关闭该维度，非法值回落默认而不是静默关闸。检查点在 answerability guard 之后、
  选后端/取账号/缓存/任何上游调用之前；超限是一条带实测数字的 `WARN` + 413 `payload_too_large`
  （`code: history_budget_exceeded`）。
- **PR #274 孤儿守卫**：用**真实的** `handleChatCompletions`（上游 mock）钉住四种孤儿 tool result
  必须到达出站 transcript。此前 #274 的钉子直接调 `normalizeMessagesForCascade`、从不加载 `chat.js`，
  所以把被删掉的共享层清扫 `repairUnanswerableMessages` 加回来仍然是绿的；新守卫会 4/4 变红
  （突变验证后已还原）。

### Smoke 矩阵：124 条流程 / 20 族

- 新增六个族：`reauth`（探针门控状态、徽章/i18n、409 守卫、三条恢复路径）、`acu`（org 分组去重、
  hash-only 句柄、派生单元格、单 org 失败不拖垮健康 org）、`request-history`（真实聊天后的计费环形缓冲、
  token 合计、分页夹取、404 边角）、`devin-cards`（账本、ACU 不可观测、masked key）、`engines`、
  `docker`；`login` 补 wave 3（非 auth1 探测方法、`app.devin.ai` 回退、一步 token 导入、邮箱验证码）。
- 负向控制：每个新族至少一个突变，另加一个 login wave-3 突变，**21/21 全被抓**。

### engines / Node 22 证据

- `engines` 族在**运行时**校验：`package.json` 的 `engines.node` ≥ 22.13.0、Dockerfile 基础镜像、
  两个安装器三处一致，并且**当前进程**满足该下限（本次运行 Node v24.19.0）。
- `docker` 族解析 Dockerfile 的 `HEALTHCHECK` 并对活服务器执行同一条命令（活 → exit 0，关闭 →
  非 0），另有一条 compose 继承检查；本机 Docker daemon 未运行，compose 校验按设计跳过（见下）。

## 工程与门禁

- 合入 7 条分支（均基于 `432aee3`）：`feat/cascade-turn` `012f9f6`、`feat/docker-oneclick` `b6abe42`、
  `fix/sweep-p2` `8729ceb`、`fix/security-audit` `f69d946`、`fix/gh-backlog-a` `54f9cd6`、
  `fix/gh-backlog-b` `af3ec3e`、`test/smoke-all` `8aa6e81`。
- 合并冲突 1 处：`docs/ENV-SWITCHES.md` 的开关计数行（两条分支各追加一条）。按同一脚本在合并树上重测，
  取 **168**（base `432aee3` 实测 164；新增 `WINDSURFAPI_CASCADE_TURN`、
  `DEVIN_CONNECT_PROSE_INTENT_DETECT`、`WINDSURFAPI_HISTORY_BUDGET_TURNS/BYTES`）。
- Windows `npm run test:release`：**6,085 pass / 0 fail / 94 skip（502 文件，6,179 tests）**，exit 0。
- Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js" npm run gate`：
  **PASS exit=0** —— 全部子门绿。
- `npm run secret-scan`：exit 0。`git diff --check`：clean。
- Linux `npm run test:release`（HMC，Node v24.21.0，502 文件）：**6,174 pass / 0 fail / 3 skip（6,177 tests；Linux 在新增 2 条测试前）**，exit 0。
- mutation：`connect-catalog-hotfix`（pin 41→46）、`dashboard-connect-parity`（pin 48→49，新增“发现不消耗降级警告”用例）、`sticky-queue-on-pin`、`retry-rescue-budget-split` 四个受影响规格 exit 0。
- wire：对 `v3.9.52`（`432aee3`）基线比较（见发布提交）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` `deploy/update.sh` 的 POSIX 集成夹具（12 条在 Windows 上按设计 skip）：真实 pull /
  健康门 / 回滚序列。
- `[UNVERIFIED]` `docker compose config` 校验：本机 Docker CLI 29.7.2 在，但 daemon 未运行，矩阵按设计
  跳过并标记。

- `[UNVERIFIED]` CascadeTurn 在真实 Cascade 上游上的长轮询恢复（回归用脚本化上游）。
