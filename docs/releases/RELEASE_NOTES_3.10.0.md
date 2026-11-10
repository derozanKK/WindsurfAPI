# v3.10.0

大版本：**detached cache P1（默认关）+ 四个 P2 修复**、**账号页 P2**、**SEC 四项（含发布签名）**、**#245**、**smoke 137 flows**、**真实 Docker one-click E2E**。没有协议兼容性破坏。

## detached cache P1（`WINDSURFAPI_CASCADE_DETACH=1`，默认关，需 `CASCADE_TURN=1`）

- 惰性恢复：快照 v2（`generatorOffset`/`sawActive`/`usageByStep`/`consumedThrough`）、registry CAS/TTL/容量上限、请求级租约、两个计费陷阱（offset-0 过度计费、`acct === null` 少计）。
- soak（假上游、真实 handler；`DETACH_SOAK=1` 显式开启，默认套件跳过，因为 SOAK-2 真等 120s TTL）：10 次 detach/resume、120s TTL、caps、abort×3、3 次 claim 竞态、账号删除/drain，**9/9 PASS**；mutation 表 **12 caught + 1 documented equivalent**。
- Review 后的四个 P2 已修：拒绝的 admission 不再先删旧 entry；resume 租约在同步异常下释放并结束响应；resume-miss 清 `reuseEntry`；`lookup` 不驱逐 claimed entry。
- **默认关**：设计 §7.4 的 gate 1/5/6 未满足（两周计数、维护者签字、live 60s soak），go/no-go = **NO-GO**。

## 账号页 P2

- 调色板：11 个 provider 色块改主题 token（两主题 ≥3:1）；残留 accent/slate 块全部 token 化。
- 尺度：`--space-*`/`--fs-*`/`--radius-xs`，账号页/登录 modal/用量面板统一；44px 行高由 `--acct-row-pad-y` 固定。
- 服务端排序（配额/最后使用 + 余额/错误数），`aria-sort`，localStorage 记忆，翻页重置选择；`编辑名称`（PATCH label 即 email，UI 动词如实）。
- 新增 `check:ui`（scale + contrast）与 mutation 检查；582/582 相关测试、54/54 截图断言。

## SEC

- 空白 dashboard 密码在设置时拒绝（trim 后长度；存 trim 值），8 个空格不再能设成永不匹配的密码。
- Windows ACL 覆盖 `runtime-config.json`（含明文 API key）与 `proxy.json`，与 `accounts.json` 同一路径。
- nginx access log 去掉 `$http_referer`（Referer 本身可携带 `?key=`），`?key=` 文档同步纠正；`$uri`-only 测试保持。
- **SEC-04 发布签名**：Release job 用 cosign keyless（GitHub OIDC，仓库内无密钥/无 signing
  secret）为四个资产和 `SHA256SUMS` 生成 `.sig`、`.pem`、`.sigstore.json`；签名失败即发布失败。
  `scripts/verify-release-assets.mjs` 与 [docs/RELEASE-SIGNING.md](../RELEASE-SIGNING.md) 给出
  “先验签、再校验哈希”的用户路径；Windows 手动安装文档同步。SEC-05（历史 secret 扫描）仍为 PARTIAL。

## #245

`UserStatus <ref>: teams_tier=<raw enum> mapped=<tierName> plan="<plan>"`，不改变 tier 判定。

## smoke / Docker

- smoke matrix **137 flows / 24 families**（+13）：fleet job 生命周期、KPI 划分与余额去重、ACU 有符号余额（从服务端 HTML 取格式化函数）、detach off/on、docs guard、登录步骤。
- 顺带修 `startFleetJob` 的 P1：`selectTargets(op, ids)` 参数错位导致显式选择被忽略、扫全池。
- 抽屉里的 `overageBalance` 改用 `fmtCreditBalance`（`-$0.10`，不再 `$-0.1000`）。
- **真实 Docker 29.8.2 E2E**（独立项目/端口）：首次 build、pull→up→health、坏镜像自动回滚、无 `down -v`/`volume rm`，4/4 PASS；生产 18999 未动。

## 工程与门禁

- 合入分支：`fix/sec-310` `1dae047`、`fix/ui-p2` `b0c2b27`、`test/detach-soak-patches` `6a2e40c`、`test/smoke-expand` `2715b61`、`fix/detach-p2` `5cd6271`。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,548 pass / 0 fail / 97 skip（543 文件）**（测于 `da8a8a0`）。
- Linux `npm run test:release`（HMC，Node v24.21.0，543 文件）：**6,641 pass / 0 fail / 5 skip**（`da8a8a0`）。
- Node 22.23.4 矩阵（HMC）：**6,439 pass / 0 fail / 5 skip（525 文件）**；532 文件树未跑 Node 22。
- wire：对 `v3.9.60`（`d449895`）比较 **270/270**（`da8a8a0` 树，最终代码）。
- mutation：**90/90 spec exit 0**（`da8a8a0` 树，含 parallel-tool-calls 的 6 条）。
- 真实 Docker E2E：**4/4 PASS**（`evidence/DockerE2E.md`）。


## 外部审查修正（GPT-6-Pro，独立复现）

审查指出三条真实故障链与两条 detach 反例，全部修复：

- **模型级 401 不再污染账号**：`SELECTOR_NOT_ELIGIBLE` 识别 “This model is no longer available for your account”，只记录（账号 × canonical selector）的 30 分钟短期不可用，不触发 `reportError`/重登录；failover 只挑对该 selector 有资格的 peer；`isLastUsableAccount` 带 selector。无可用 peer 时返回 403 `model_not_available`（不是 401）。17/17（双账号红先）。
- **Responses 不再伪造 hosted 搜索完成**：没有执行器时在模型调用前拒绝 hosted `web_search`（400 `unsupported_hosted_tool`），删除所有 `web_search_call.status=completed` 构造；普通客户端 `function` 仍是 `function_call`。44/44。
- **请求中轮换 key 不再漏记账**：`recordAccountSpend` 按不可变 `accountId` 归属，`attemptId` 入 ring；旧凭证 epoch 的迟到 401 不惩罚新 epoch。6/6 旋转测试。
- **detach D1/D2**：TTL 只作准入，已 claim 的 entry 只按原请求 deadline + token 清理；`evict` 带身份校验（关掉 ABA）；发出过工具调用（含 markup 模拟）的回合不进 no-tool 缓存。119/119 + 127/127。
- 顺带：`test/connect-token-usage` 的两处单参数断言更新为接受 2 参数调用；4 个 mutation baseline 与 escape 行号随合并重钉。


### 第二轮审查修正（补丁复审）

- **F1 旧凭证的迟到拒绝污染新凭证**：`SELECTOR_NOT_ELIGIBLE` 分支现在先过 `credentialCurrent`；旧 epoch 只记统计，不写 selector latch。测试 `late_old_selector_denial_must_not_override_new_credential_success`。
- **F2 peer 判定与调度器不一致**：提取只读的 `isAdmittedForRequest()`（status/maintenance/cooldown/latch/RPM/inflight/tier），latch 与 `getApiKey` 共用；不会把 maintenance 或 inflight 满的 B 当成可用 peer。测试两条（maintenance / inflight）。
- **F3 hosted 搜索版本化类型**：`web_search_preview_2025_03_11`、`web_search_2025_08_26` 等日期快照全部拒绝（400 `unsupported_hosted_tool`），覆盖 tools/additional_tools/namespace/tool_choice × 流式/非流式 16 种位置；普通 `function` 不变。
- **detach 交付截止**：trajectory 读取受剩余预算约束，await 后/回放前/终态前检查所有权；`release()` 自查 deadline；过期 claim 一律记 `deadline`，与清理顺序无关。新增 4 条测试，330-token 结算保留。
- **移除账号的迟到结果**：`finalizeConnectAccount` 先按不可变 id 解析账号；账号已删除则只记全局统计，不再回落到旧 key 惩罚重建账号。
- **签名验证收窄**：默认 identity 正则锚定结尾；`--tag vX.Y.Z` 生成精确身份，`v3.10.0-unrequested` 不再匹配。


## Wave 12（真实上游与真实客户端）

- **detach gate 6 真上游 PASS**：`claude-haiku-5-5-medium` 3/3、`gpt-5.5-xhigh` 3/3，abort→同请求恢复答案逐字节一致，60s detach 在 120s TTL 内恢复；计费每次恢复只记一次。`gpt-6-*` 无 Cascade 路径（“only in Devin Local”），已由路由修复。
- **真实客户端**：Claude Code 2.1.306 3/3、Codex 0.163 3/3，wire 校验 24/24、0 违规；发现并修复 `reasoning.effort=medium` 把 `gpt-6-luna-max` 降级为 medium（显式后缀现在优先，Responses 报告实际服务模型）。
- **工具/图片/缓存矩阵**（75 次 live）：四族工具全 native；HTTPS `image_url` 之前被静默丢弃，现已按 5MB/8s/私有 IP 防护内联；`gpt-6` 默认开启 prompt-cache hint。
- **面板**：`#stats` 改为 new-api 风格请求日志（时间/模型/账号/状态/延迟/token/费用 + 过滤/分页/聚合/时间序列）；新增 `#devin` 页（runtime/sessions/catalog/quota/settings，缺失源显式标注）；配色回退到 workbuddy 之前的 zinc/clay 并保留 AA；审计 10 tab/42 端点/42 动作，修 5 个接线 bug（0 console error）。
- 已知未修（记录）：Gemini `max_tokens` 不限制 thinking；swe 工具 ID 形状；`parallel_tool_calls:false` 在该路由无效；stats 每账号求和 352 vs 总数 393。


## Wave 13/14（复审军团）

- 独立复跑确认 `d338b36` 的发布数字属实；4 处声明（Node 22 口径、mutation 89 规格、gate 6 表述、Wave 13 未含项）已按 `VerifyReleaseClaims.md` 修正。
- ReviewChatCore 深审（无 P1，7 P2）全部修复：Cascade 侧身份调用改按账号 id（旋转后健康/计费/死 token 不丢）、`reportDeadToken` 按当前 key、未分类传输错误不再驱逐账号、复用条目在早退路径恢复、连接流成功写入需实际交付、served-model 归因统一、preflight 采用与调度器相同的准入合取。
- Dashboard 复审（1 P1 + 5 P2）全部修复：请求日志按账号 id 归属（原来所有 `devin-session-token$` 账号折叠成一个 `devin-se` 桶）、失败行零计费、DevIn 配额覆盖率/500 信封/扫描计数/对比度四项、stats 归因 352+41=393。
- gpt-6 缓存 A/B：hint 已在线上（`#13=1`），上游仍不报 read——判定为上游语义，非解码 bug；Claude 控制组 read/write 均正常。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` detach 默认开启（NO-GO 未变）；真实 Cascade 上游 resume。
- `[UNVERIFIED]` 真实 Enterprise 的 `teams_tier`；历史 secret 扫描。
- `[UNVERIFIED]` 真实 tag 构建上的 cosign keyless 交换（GitHub OIDC → Fulcio/Rekor 只能在
  GitHub runner 上验证）；本地已用 fake cosign 跑通签名步骤与验签脚本，工作流接线由测试锁定。
