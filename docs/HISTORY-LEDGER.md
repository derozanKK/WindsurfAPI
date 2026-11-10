# 全局历史记账本 / History Ledger

> **不是现状。** 本账在 **2026-08-11 / v3.9.21** 截断（当时 172 份 notes / 183 tag）。
> 活状态：[`HANDOFF-2026-08-20.md`](HANDOFF-2026-08-20.md)。发版索引：[CHANGELOG.md](../CHANGELOG.md)（v3.9.34 / 185 份）。不要拿下面「版本 → v3.9.21」当当前产品 tag。
> 可视化页 [`HISTORY-LEDGER-VIZ.html`](HISTORY-LEDGER-VIZ.html) 的数字跟到 **v3.9.34 / 2026-09-15**。逐条账仍停在 08-11。

> 把 WindsurfAPI 从创建到 2026-08-11 的**每一件事**记下来：
> 什么时候做了什么、修了什么 bug、怎么修的、谁干的、以及过程中踩过哪些自己的坑。
> 供全局 review：想查任何一个 commit / PR / issue 的前因后果，从这里进。
>
> 与 `AUDIT-LEDGER.md` 的分工：那份台账记**技术面**（哪些子系统被探测过、守卫在哪）；
> 这份记账本记**时间线事件**（每件事干了什么、修了什么、怎么修的）。两本互补。

## 怎么读这份文件

- **要每一件事的逐条细节** → 先看总览，然后进**精细账**（本文件是总账；9 份 `HISTORY-LEDGER-2026-*.md` 加 `HISTORY-LEDGER-PRS.md` / `HISTORY-LEDGER-ISSUES.md` 共 11 份是逐条账：1205 条 commit 每一条 + 每个问题的完整生命周期链 + 69 个 PR 逐条 + 177 个 issue 逐条）：
  - `HISTORY-LEDGER-2026-04-early.md`（04-09~04-22，78 条逐条 + 9 条问题链）
  - `HISTORY-LEDGER-2026-04-late.md`（04-21~05-01，265 条逐条 + 10 条问题链，#24 上下文 16 次修复全链）
  - `HISTORY-LEDGER-2026-05-bridge.md`（05-01~06-05，146 条逐条 + 7 条问题链，#115 四阶段全链 + 隐式 release 模式发现）
  - `HISTORY-LEDGER-2026-06-connect.md`（06-06~06-30，89 条逐条 + 10 条问题链，桥 24 小时逐 commit 日志）
  - `HISTORY-LEDGER-2026-07-early.md`（07-01~07-09，126 条逐条 + 7 条问题链，v3.0.0 发布日解剖）
  - `HISTORY-LEDGER-2026-07-mid.md`（07-10~07-16，93 条逐条 + 8 条问题链，烧账号链 2h44m 时间轴）
  - `HISTORY-LEDGER-2026-07-late.md`（07-16~07-31，109 条逐条 + 8 条问题链，对抗 review 风暴 14 commit 时序 + 方法论 9 条）
  - `HISTORY-LEDGER-2026-08-feature.md`（08-02~08-08，256 条逐条 + 14 条问题链，发版节奏 14 分钟间隔实测）
  - `HISTORY-LEDGER-2026-08-docs.md`（08-09~08-11，43 条逐条 + 7 条问题链，守卫盲点五连）
  - `HISTORY-LEDGER-PRS.md`（69 个 PR 逐条，含 7 个重点 PR 技术细节段）
  - `HISTORY-LEDGER-ISSUES.md`（177 个 issue 逐条 + 悬空 4 个 + 开放 6 个）
- **按时间查** → 看「时间线主账」（正序，9 个时段）
- **按问题查** → 看「Bug 修复索引」（issue 编号 → 修复 commit）
- **按人查** → 看「贡献者地图」（69 个 PR 按作者）
- **查自己踩过的坑** → 看「糊涂事清单」（跨时段归纳，含每个自伤事件的来龙去脉）
- **查反复出现的病** → 看「问题族归纳」（工具停滞 / 模型缺失 / 429 / 上下文四大家族）
- 所有 hash 可直接 `git show <hash>`；issue/PR 可 `gh issue view <n>` / `gh pr view <n>`

## 总览

| 维度 | 数字 |
|---|---|
| 时间跨度 | 2026-04-09 → 2026-08-11（约 4 个月） |
| 提交总数 | 1205（4 月 339 / 5 月 98 / 6 月 141 / 7 月 328 / 8 月 299） |
| 版本 | 183 个 tag（v1.4.0 → v3.9.21），release notes 172 份文件（GitHub release 对象 174） |
| PR | 69 个（47 合并，34 位外部贡献者，+125951/-17621/888 文件） |
| Issue | 177 个（171 关闭，整体解决率 88%，口径见「问题族」节） |
| 主要作者 | dwgx 1071（89%），外部以 warelik（15 PR）/ baily-zhang / smeinecke / aict666 为主 |

**四个阶段**：

| 阶段 | 时间 | 主题 |
|---|---|---|
| 成型期 | 04-09 ~ 04-30 | 单机反代脚本 → 完整网关：/v1/messages、模型 tier、Dashboard 雏形；issue 洪峰（4 月 82 个） |
| 深水区 | 05-01 ~ 06-05 | 工具兼容、上下文保持、sticky session；中旬停滞（疑似离线研究） |
| 换轨期 | 06-05 ~ 06-30 | Cascade native bridge 爆发 → **devin-connect 桥诞生**（6-29/30 两天 53 commits） |
| 高速期 | 07-01 ~ 08-11 | v3.0-v3.9 密集发布（14 天 22 版）、对抗 review 文化成型、审计台账建立、会话保真三线 + 模型同步 |

---

# 时间线主账

## 一、2026-04-09 ~ 04-22（项目诞生前两周，78 commits）

**大事**：仓库创建（`395311f`，04-09 18:41）。首周钉死三大架构决策：原生 `node:http`（零 npm 依赖）、proto/gRPC 手搓（`src/proto.js` schema-less wire codec）、认证走本地 LS 二进制。

**聚类**：协议核心（04-12 NO_TOOL 对抗 `05e8519`：15/15 压测、99s→35s）、cache 预热（`2a4d599` 省 300-900ms/请求）、工具仿真（`2c993b9` proto field 10/12 注入）、PDF 识别、/v1/messages（`c3a4c82`，240 行新模块）、GetUserStatus 权威层（`8f1b50e`，61 proto 对照）。

**外部力量**：PR #1（dd373156 作者，pro tier 一行 getter 修全站 403；merge commit f9783eb2）、PR #13（colin1112a，15 个安全 bug 审查）、PR #20（motto1，Auth1 登录）、PR #26（youfak，Docker）。

**自伤 5 起**：kimi-k2 六分钟内三连改（enum→string→回退）、qwen-3-coder 82 秒内三连全撤（上游目录没核实就上架）、图片 raw bytes 一分钟回退、重复 import 自崩自修、PR #1 撞车后 credits 移除又 revert。

## 二、2026-04-21 ~ 04-30（成型冲刺，265 commits + 4 条 5-01 尾巴）

**大事**：v2.0.x 系列密集发布，04-21 单日 37 条（4 月高峰之一，issue 洪峰 + 外部 PR + 两轮安全审计同日叠加；仓库全史日峰值是 08-04 的 81 条）。

**聚类**：Cascade 会话复用/上下文（~30，头号问题 **#24 上下文丢失 13 次 fix**）、工具调用解析（~24，#22 家族）、/v1/responses（~16）、模型目录/tier（~22）、Dashboard/i18n（~45）、安全加固（~25）、发布/基建（~35）。

**承重修复**：
- `18a3d81` #22/#24 三模块审计 10 个边界（fingerprint 加 system hash、64KB buffer 防 OOM、warm/cold stall）
- `5824773` #59/#63/#66 审计驱动 7 项（parser 保序、retry-after 精确解析、非 function tool 400）
- `1a59503` 2.0.42 四轴审计：**cache key 只 hash body → 跨租户串读**（P0，补 callerKey）、原子写防截断
- `9c6b685` /v1/responses 端点（476 行新模块）
- `9c2dc30` #86 GLM/Kimi 工具方言（此前被静默丢弃）
- `91b2441` fresh account 403 race（QQ 群报告，unknown 乐观放行）
- `dfb979a` #27/#29 反代指纹深度修复（6 项 + 明确 3 个「不能改」）

**自伤 12 起（最密集时段之一）**：
- **F1 最严重**：2.0.19 把 GRPC_PROTOCOL 默认 legacy→Connect → 2.0.21 生产全挂回退（作者写了 postmortem）
- F2：自己为前端免密加的「空 password 放行」成为 **Dashboard auth bypass**
- F3：04-23 当天三连 revert（gRPC 压缩头/planner READ_ONLY/版本号）——三个「聪明改动」全踩中自己已记录的「不能改」
- F4-F12：自己 ship 的回归（2.0.16→17）、positiveIntEnv 复制漏改、tier 守卫引入 403 race、两个 ReferenceError、JSON 指令污染 trajectory、email 登录搞坏 4 天

## 三、2026-05-01 ~ 06-05（社区洪峰 + 停滞期，146 commits）

**大事**：5 月初社区 issue 洪峰（#109-#192 密集报告），5 月中下旬停滞（05-14~21 八天空窗、05-30~06-02 四天，疑似离线研究期），6-05 的 48 条是**所有研究线的总兑现**。

**聚类**：Cascade native bridge 爆发（6-05/06，48 条）、release 暴雨日 v2.0.68~90（28 条，NLU 七连 hotfix）、社区 issue 洪峰（19 条）、sticky-session 深水区（18 条，05-25 一天 11 条 debug+修复）、kimi-k2 上游 outage（7 条）、#134 PostAuth（6 条）、社区 PR 合并周（7 条）。

**最长战线 #115**（5-02 ~ 6-06，贯穿整个时段）：5-02 判定 root cause 是 gpt_native 方言 → 当天 hotfix（body is not defined）→ 声称「真修」→ partition mode → **5-03 承认翻方向** → 换 NLU 协议转换层（2.0.72，hotfix 六连）→ 6-05/06 以 native bridge 形态全面重做（这次带测试线 + 遥测 + canary）。从「猜根因」到「可观测 + 灰度」的完整演化。

**其他事故**：#114 OTT 端点全坏紧急绕路（2.0.90）、#129 wnfilm 回归三连（2.0.85 上 fallback → 86 默认 OFF → 87 真修后重开）。

**自伤 6 起**：#115 方言链（自己引入、自己修、自己推翻）、#129 wnfilm、NLU 七连 hotfix（同一层一周 8 个补丁）、sticky 自查风暴、CLAUDE.md 两天反复、6-05 当日起义（31 条里测试与修复交错）。

## 四、2026-06-06 ~ 06-30（devin-connect 桥诞生月，89 commits，6-29/30 占 59.6%）

**大事**：**devin-connect 桥 24 小时诞生**（6-30，27 commits：f25950c 纯 HTTP GetChatMessage → 1ae8e77 createSession v3 REST → 2c54e35 router 接入 → 294393c 计费记账）。前夜是 special-agent 硬化 + devin-backend 脚手架（14 条），前一天是审计修复潮（13 条）。

**聚类**：发布潮收尾与 Cascade 桥尾巴（10）、安全加固（10，含 `4296675` PDF ReDoS + 日志泄漏）、目录扩展 + LS 镜像稳定化（13，含 PR #201/#195/#192 合并）、审计修复潮（13）、桥前夜（14）、**桥诞生 24h（27）**。

**重大事故**：
- `21393b9`（6-29）**探针烧账户**：强制探针约 12 个模型发真实请求，把活着的免费账户 free→expired（线上事故）。修法：计费 canary 改 opt-in。
- `27d31de`（6-30 cutover 日双 P0）：re-login 风暴无节流（force:true 绕过 60s 冷却）+ 池耗尽静默降级锤单账户。
- `0e1cbd9`（6-29）：tierManual 逃生门被三处无条件写覆盖 + reportError 无时间窗终身计数（3 次瞬时 blip 永久禁号）。
- `a8091d5`（6-30）：catalog alias 未全量解析——**用户要 GPT-5.5 静默拿到 SWE-1-6-slow**。

**自伤 12 起**（9 起落在桥诞生窗内）：探针烧账户（最重）、双 P0、alias 漂移、quota 误分类无限 402、socket idle timer 字节级重置钉死 slot、流式路径缺重试、MODEL_BLOCKED 误扣健康预算、无时间窗错误计数、probe-pending 误标、假冷却、流错误尾巴残留、WebFetch 完成步误标（#183）。

## 五、2026-07-01 ~ 07-09（v3.0.0 前夜，126 commits）

**大事**：DEVIN_CONNECT wire 逆向（最大主线，20+ commit）、Vision 链路、OAuth/账单、429/lockout 缓解、三协议 batch-7 硬化、**Dashboard 大改版（~45 commit）**。

**承重修复**：
- `839e6ee`（07-10）429 lockout 缓解（+970）：tier-aware 最后账户豁免 + degraded-serve 兜底 + Retry-After clamp。根因链：单账户限流 → 硬过滤 → 429 → 客户端自动重试续命冷却 → 小池黑屏。
- `3584bac`（07-10）Claude 系原生 tool_call 恢复：**五独立根因**（content-policy 拦截 / permission_denied 误判死 token / 缺 system prompt / 工具描述过长 / 编码差异），新增 identity-neutralize.js。
- `f8a6b95`（07-09）停止 false-positive bans：**打开 dashboard 页面就把自己 IP ban 了**（~12 个空密码 401 全计失败）。
- `661b649` #209 fable 空响应（env-lift 跳过）、`815cf59` #210 Docker 默认 DEVIN_CONNECT=1（实测证据：emulation 路径 glm-5.2 约 1/3 轮次叙述代替 tool_call）。

**自伤 6 起**：S1 违反零依赖铁律引入 jimp（当日 CI 红，次日 vendor 化）、S2 **host/key 泄漏进公开仓**（redact 13 文件 + 删除内部 maintainer/reversing 笔记批次）、S3 v3.0.0 打开页面就 ban 自己、S4 WebGL2 slider 同日引入即撤、S5 v3.0.0 Docker 无法 boot、S6 email-OTP 当日封存（外部限制）。

## 六、2026-07-10 ~ 07-16（v3.0-v3.5，93 commits）

**大事**：v3.1.2 → v3.5.0，19 正式版 + 3 rc（22 tag）。07-11 一天 6 版，07-13 一天 8-9 版（rc4/5/6 三连）。主线：Dashboard 大改版、外部审计修复轮、Windows exe/托盘链。

**承重修复**：`7a8d658` live-catalog alias-fold **烧账号根治**（gpt-5.6-sol → UPSTREAM_INTERNAL 烧 homecloud 单账号，真号坐实；只折 canonical + fail closed）、`2047628` MCP-gate neutralize（#216，5 文件 +432）、`15e9562` IPv6 ETIMEDOUT（#215）、Windows 热更新退出码致命 bug（`9afc1dd`）、`2a9724a` 安全审计（5 HIGH + 1 MED）。

**自伤 4 起（本片最重）**：**① gpt-5.6-sol 烧账号**（v3.2.3 引入 → v3.2.4 引爆 → v3.2.5 根治，中间烧掉真实账号，审计修复轮自己引入的 catalog 逻辑没验证就发布）；② Windows 热更新退出码致命 bug；③ devin-backend 假绿测试删 423 行（长期假绿掩盖真实状态）；④ tray.ps1 占位残留。

## 七、2026-07-16 ~ 07-31（密集发布 + 对抗 review 风暴，109 commits）

**大事**：v3.6.0 → v3.9.6（12 tag，v3.7.0 无 tag）。**7-27 对抗 review 风暴日**：审计台账建立（`0179306`）+ v3.9.0 当天发布、当天被打穿（`30485c3` 修 5 缺陷含 blocker）。

**聚类**：发布链 13、对抗 review+审计台账 14、responses 会话/检索/存储 13、截断完成语义 10、sticky 亲和 10、身份中和/内容策略 12、云目录 8、devin-connect 计量 10、**warelik #224-#229 merge 批次 8**。

**关键修复**：
- `30485c3` 修 5 个对抗验证缺陷（blocker：v3.9.0 核心功能对规范客户端全失效）
- `2ced8a2` **第二轮对抗复核挖出 1 blocker + 4 major，全部是上一批修复自己引入的**
- `f9cd3ac`/`bd97b89`/`44f0303` 错误预算三波（STREAM_TRUNCATED/UPSTREAM_ERROR 不该打健康账号下线）
- `92946c5` 截断判定从 StopReason 迁移到 usage（+`161c88d` **v3.9.2 只修了 1/3**，两天后补全）
- `4a4653d` **GET/DELETE /v1/responses/{id} 自 v3.9.0 发布起对所有人不可用**（7-29 才发现）
- `e838341` response store 跨租户泄漏（SEC-W2）
- sticky 亲和修复链五连（#230：connect 路径绑定缺失、failover 困死、re-login 打断、越权窗口）

**自伤 8 起**：2ced8a2 自伤-自愈闭环（数小时内）、8334cea 守卫位置错、4f29f23 + 50875f5 累计清 8 条自己写的假测试、f21586b 镜像实现测试、161c88d 修 1/3、4a4653d 端点 4 天不可用、85bc1fb 自己测试文件带 NUL。

## 八、2026-08-02 ~ 08-08（功能爆发期，256 commits）

**大事**：发版机器——6 天 14 版（v3.9.8~v3.9.21），08-04 一天 5 版（v3.9.10→v3.9.14 最短间隔 34 分钟）。**会话保真三线全落地**（warelik #242/#243/#248 + #250 issue 驱动的 think 防线）、协议出口 eleven defects 大 patch、突变验证基础设施成型（45 条）。

**聚类**：devin-connect 会话保真三线（68）、rescue 救援与预算（#238→#241，11）、工具方言与模型路由（7）、协议出口修复轮（15，`b6e7dc9` 四路径 11 缺陷 +2231 行）、auth/sticky/分片/干旱/计费（38）、外部 PR 合并（9）、突变验证基础设施（45）、发版（14）、文档/交接/台账（48）、CI（8）。

**关键修复**：`b6e7dc9` 四出口 11 缺陷、`6d1f087` response-store 四条「注释对、实现只盖一个特例」、`129682f` intent-extractor 从反例说明伪造工具调用、`7bca624` identity-neutralize 跨段落误删、`aaf487c` caller 分片反噬 #37、`3cc5aab` 空/畸形目录擦掉 last-known-good、`68da125` 断连吞 429 冷却、`793ed79` swe-1-7 agentic 死循环（#238 nudge）、`6a664ae` 模型面板与 /v1/models 零重叠（#234）、`6dcd0a9` **CompletionConfiguration #2/#3 tag 互换**（4 份独立 .proto 互证挖出）。

**自伤/返工（记账纪律最强的时段）**：sticky RPM 修复当天 revert（结论反转）、修自己的修三连、hook 探针自打脸（7a8ebfe→a57a83c）、声称改了但没改（d0b9c9f→8449002）、更正自己的更正、删自己的死代码、假话更正（61a7452/dcc8cee）、坏探针得出错误结论、自己的 Math.floor 打断自己的 anchor、baseline 算错多次、SWE kimi 方言过度推广两天后排除（898af0f→6cc2886）。

## 九、2026-08-09 ~ 08-11（文档补课 + 审计收尾 + 模型同步，43 commits）

**大事**：合并 PR #249（LEAK_TRACE）/ #252（swe dialect）→ 合并后 5 个修补 → 文档补课轮（ENV-SWITCHES 五批、CHANGELOG 新建、docs 索引、README 中英对齐、issue 模板重做）→ **模型同步 #244**（8-11）。

**关键修复**：
- `0523910` **#252 两处改动互相抵消**：抑制逻辑靠 `<tool_call>` 标记触发，同一 PR 把默认值里的标记删了——抑制变永久 no-op，合入当天才发现
- `6202c34` 剥注释正则吃掉真代码（`*/` 在正则字面量里 9 次 vs `/*` 7 次）——两个开关（含凭证开关）对守卫隐形还报绿
- `f91d54b`+`62dec04` 同一条测试两个随机失败（扫裸字节 4.3% + 比长度 3.3%）
- `d007317` tool_choice tag 碰撞覆盖认证元数据（10 字节覆盖 800 字节 ClientMetadata，表现为 auth failure）
- `b5c2e90` secret-scan 漏掉仓库自己的 `devin-session-token$` 格式
- `9e8080a` 模型同步 #244（gpt-5.6-luna + Claude 5 全系 + swe 图片 400）

**自伤 12 起**：0523910 双重自伤、守卫三连崩（1fbefd0 第五盲点 / 6202c34 正则吃代码 / a98a572→c374ec7 三连漏）、「35/35」「86/86 收齐」声明被 4ada929 一次补 47 个推翻、NUL 字节两次（f2283a7 + 4404015）、注释说反（d12eea3）、自己 CI 弄红（5c21e43→121fb9b）、夹具触发自己扫描器（f3e0094）、PR 模板声明「暂无测试套件」。

---

# Bug 修复索引（issue → 修复）

> 完整版见各时间片明细。这里列**高频复发**与**关键事件**。

| Issue | 问题 | 修复轨迹 |
|---|---|---|
| #24 | 聊天上下文丢失（4 月头号） | 13+ 次 fix 贯穿 04-22~04-30（fingerprint→打包→redact→reuse 池逐层打补丁） |
| #22 | Claude Code/Cline 工具调用兼容 | 9 次 fix（3ef2061→cac0b8d 等） |
| #70/#75 | Tool definitions too large | compact → schema-compact 两级压缩 |
| #84 | 账号密码登录坏 | F11 自伤：登录探测切 CheckUserLoginMethod，4 天后 2.0.39 恢复 |
| #109 | 模型 SKU/跨 tier | 5b952fa/b7e5910（tier ladder） |
| #114 | OTT 端点全坏 | b8c0554 → fd031fd 紧急绕路（2.0.90） |
| #115 | codex gpt 无工具 | 最长战线（5-02~6-06）：方言→NLU→native bridge 三稿终章 |
| #129 | wnfilm 上下文断裂 | 回归三连（2.0.85→86→87） |
| #133 | 任务一半忘记内容 | 2.0.95 sticky session 真修（被顶开 re-open 后） |
| #135 | 模型全报错 | 5269f04 ReferenceError context |
| #144 | 登录修复（Await-d PR） | 04c1500 |
| #178 | No Tools get Called | **悬空**（Rebirth 横幅关闭无修复证据，持续战场） |
| #185 | 响应截断 | **悬空**（同上） |
| #187 | 上下文牛头不对马嘴 | **悬空**（同上） |
| #203 | opus-4-8 不可见 | 静态表 + SELECTOR_MAP（0604f0c）+ entitlement 墙解释 |
| #209 | fable 空响应 | 661b649 env-lift 跳过 |
| #210 | claude code 无法持续运行 | 815cf59 Docker 默认 DEVIN_CONNECT=1（报告者确认） |
| #213/#214 | 工具被 permission_denied / 零工具描述 | warelik #216（MCP-gate 指纹）+ #215（IPv6） |
| #219 | codex apply_patch content-policy | forrinzhao 双片段 A/B → (a7) 规则 |
| #220 | 无状态会话计费分叉 | bc0fd13 缓存 A/B 校准 |
| #221 | 429 reset window 丢失 | warelik #224 双链根因 |
| #222/#226 | 稳定 session_id | warelik pair-chain（600 行零依赖，真上游 6 轮 200） |
| #223 | Grok self-ID 触发 content policy | warelik #227 |
| #230 | connect 路径 sticky 缺失 | wangergou777（三账号实测）+ 维护方五连修 |
| #234 | 模型面板与 /v1/models 零重叠 | 6a664ae 单一真相源 + parity 测试 |
| #235 | 免费模型误烧周限 | 1805ce9 currentlyFree 三态 |
| #237 | swe-1-7 reasoning-only finish | 已修（thinking-only 停滞） |
| #238→#241（PR 链） | swe-1-7 agentic 死循环 → rescue nudge 演化 | 793ed79 → 0f5a57b + digest 钳三连（#238/#241 是 warelik 的 PR，#239/#240 是 issue） |
| #242/#243/#247/#248 | 会话保真四件套 | warelik（session continuity / think reroute / dedup / 根锚抗压缩） |
| #244 | 模型同步 gpt5.6-luna/claude5 + swe 图片 | **9e8080a（2026-08-11）**：全系 + 400 model_no_vision |
| #249 | reasoning leak 追踪 | LEAK_TRACE 边界日志（默认 OFF） |
| #250 | reasoning leaks into content | **活缺陷**：边界追踪已上，等抓包定位 |
| SEC-W2 | response store 跨租户泄漏 | e838341（只对可信身份存储） |

# 糊涂事清单（自伤 / 返工 / 自我推翻，跨时段归纳）

> 全部有 commit 证据。按「伤」排序。

**一级（烧钱 / 事故 / 安全）**：
1. **探针烧掉真实账户**（6-29 `21393b9`）：强制探针扫 12 个模型，免费账户 free→expired，线上事故。
2. **gpt-5.6-sol 烧账号**（7-12 `7a8d658` 根治）：live-catalog 折入 family alias → 原样透传 → UPSTREAM_INTERNAL，homecloud 单账号，真号坐实。
3. **v2.0.19 GRPC_PROTOCOL 默认改 Connect → 生产全挂**（4 月 F1）：2.0.21 回退，作者写了 postmortem。
4. **Dashboard auth bypass 自己引入**（4 月 F2）：空 password header 放行。
5. **host/key 泄漏进公开仓**（7-04）：redact 13 文件 + 删 1401 行内部 notes。
6. **429 lockout 死循环**（7 月）：v3.0.0 打开页面就 ban 自己 IP。

**二级（合并后才发现自己搞坏）**：
7. **#252 两处改动互相抵消**（8-10 `0523910`）：抑制逻辑靠的标记被同一 PR 删了，合入当天发现。
8. **v3.9.0 当天被打穿**（7-27）：30485c3 修 5 缺陷（含 blocker）→ 2ced8a2 发现 **1 blocker + 4 major 全是上一批修复自己引入的**。
9. **v3.9.2 只修了 1/3**（7-28 `161c88d`）：合成终止帧漏洞两条路由没补。
10. **检索端点 4 天不可用**（7-29 `4a4653d`）：v3.9.0 发布起就坏。
11. **SWE kimi 方言过度推广**（8-07→8-09）：898af0f 全家 kimi_k2 → 6cc2886 排除 lightning。

**三级（返工 / 自打脸 / 守卫失效）**：
12. **「35/35」「86/86 收齐」被推翻**（8-10）：4ada929 一次补 47 个。
13. **守卫坏掉还报绿**（8-10 `6202c34`）：剥注释正则吃真代码，凭证开关隐形。
14. **自己的测试随机失败**（8-10 `f91d54b`+`62dec04`）：4.3% + 3.3%。
15. **hook 探针自打脸**（8-04 `7a8ebfe`→`a57a83c`）。
16. **声称改了但没改**（8-04 `d0b9c9f`→`8449002`）。
17. **#115 方言链六天四稿**（5-02~5-03）：root cause 当天自爆 → 承认翻方向。
18. **NLU 七连 hotfix**（5-03）：同一层一周 8 个补丁。
19. **#129 wnfilm 回归三连**（5-04）。
20. **三个「聪明改动」全踩中自己记录的「不能改」**（4-23 F3）。
21. **NUL 字节两次**（8-10 f2283a7 + 4404015）：注释 + 记录教训的文档自己踩坑。
22. **「我上一批修复自己引入的」共三处**（7-27 2ced8a2、8-03 2e3d765/9a4826c）。
23. **更正自己的更正**（8-04 `71127dc`、台账 61a7452/dcc8cee/71b960b）。
24. **坏探针得出错误结论**（8-04 135b9e3、8-06 1e1d7e7）。
25. **baseline 算错**（8 月多次：87bd1e9/895b5dc/0da8e02/44eeac5）。
26. **8 条自己写的假测试被自己清理**（7-27~7-31）。
27. **镜像实现测试**（7-27 f21586b）：测试复制生产逻辑等于没测。
28. **PR #1 撞车 + credits 反复**（4 月 05 起）。

# 贡献者地图（69 个 PR）

| 作者 | PR 数 | 评级 | 干了什么 |
|---|---|---|---|
| **warelik** | 15 | S×7 | 两条主线：reasoning 泄漏治理（#238→#241→#243→#247→#249 逐层递进）+ 会话连续性（#226→#242→#248）。工程姿态好（opt-in/默认关/字节不变），弱点是小缺陷反复、多数以维护方补丁收尾 |
| **baily-zhang** | 6 | S+/LR | #61 把 Opus 4.7 多模态救回来；cascade 复用机制实质 maintainer（#36/#45） |
| **smeinecke** | 5 | — | Dashboard i18n 体系奠基（#43/#88/#89/#90） |
| **aict666** | 5 | MR | 4/24-25 两天 3 个 S+ 根因修复（红队思维） |
| **andya1lan** | 3 | A | #232 架构级修复（首贡） |
| **wangergou777** | 2 | S | #230 三账号交叉实测钉死机制 |
| **wjurkowlaniec** | 1 | — | #252 swe dialect（唯一「两处互相抵消」级缺陷，合并后还原） |
| **forrinzhao** | 2 | — | #219 双片段 A/B 挖出结构缺陷（a7 规则），#218 废案 |
| **The-five-stooges** | 2 | S | #188 跨 6 子系统 8 天迭代；#194 废案（+48K 行） |
| **其余 24 人** | 各 1（abwuge 2） | — | 含 #13 安全审查（colin1112a）、#206 catalog 自愈（clarezoe）、#26 Docker（youfak）、#20 Auth1 逆向（motto1）等 |

采纳文化：**CLOSED ≠ 白做**——22 个 CLOSED 中至少 10 个有采纳记录（直接合并 / cherry-pick 拆件 / 方案吸收三条通道）。

# 问题族归纳（177 个 issue）

| 族 | 数量 | 占比 | 现状 |
|---|---|---|---|
| 工具调用停滞/兼容 | 27 | 15% | 最顽固，持续 5 个月；#236 仍开放，#178 悬空 |
| 模型缺失/不可用/同步 | 26 | 15% | 半数以上是上游权限不一致；#244 已修（8-11） |
| 上下文丢失/截断/错乱 | 14 | 8% | 4 月爆发后逐月收敛；#185/#187 悬空 |
| 429/限流/账号池耗尽 | 12 | 7% | IP/账号 cooldown 是账号池类问题共同根因 |

按月解决率（口径：该月报告的 issue 中最终以 COMPLETED 关闭的比例）：4 月 98% / 5 月 82% / 6 月 83% / 7 月 93% / 8 月 38%（5 个开放）。整体 88%（156/177 COMPLETED）。若按「全部关闭（含 NOT_PLANNED/DUPLICATE）除以总数」口径则为 96.6%（171/177）——两口径都注明，前者更严格。

**遗留风险**：① #250 reasoning leak（唯一确认活数据缺陷，等抓包）；② #178/#185/#187/#131 悬空（Rebirth 群发关闭但无修复证据）；③ free 账号模型可见性随上游变动反复；④ 工具族 5 个月未清零。

## v2 精细账勘误（v1 总账里的错，以 v2 实测为准）

v2 精细账对 v1 的逐条核实修正了以下论断（详细证据见对应精细账）：

1. **发版最短间隔**：v1「08-04 v3.9.10→v3.9.11 间隔 34 分钟」——实际最短是 **v3.9.16→v3.9.17 的 14 分钟**（08-05）
2. **检索端点不可用时长**：v1「自 v3.9.0 发布起 4 天」——实际死窗约 **8 小时**（v3.9.1 发布 → v3.9.4 修复），且端点不在 v3.9.0
3. **#178 悬空判定**：v1「无修复证据」——v2.0.147（07-07）有实质修复（0c77824/4905209/baa8524 点名 #178），改为**半悬空**（关闭无验证回执）
4. **5c21e43 方向**：v1「PR 模板声明'暂无测试套件'与事实矛盾」——实际该 commit 是**修正**这句声明（改 3900+ 断言）
5. **7 月中旬 PR 痕迹**：v1「无 PR 合入」——15e9562/2047628 是 warelik 的 cherry-pick（原提交 32f02d0/35fbae4）
6. **5-22 后发版模式**：v1 未识别——2.0.97 后独立 release commit 消失，6-05/06 两天内嵌 package.json bump 消化了 **v2.0.98~v2.0.137 共 40 个版本号**
7. **07-13 版本数**：v1「一天 8 版」——按 tag 落点计 9 个（七版 + rc5/rc6）
8. **0f5a57b 日期**：v1「08-03」——实际 08-03 21:01 的分支 commit（非 08-05 的 #241 主体）
9. **PR #1 撞车**：v1「同题同方案撞车」——实际 merge 4ff1baf 的第二父就是 b721201 本身（同一 commit 走了一遍 PR 流程）

---

*账本生成：2026-08-11。数据源：git log 全量 1205 条 + gh pr view 69 个 + gh issue 177 个 + 22 个并行采集 agent 的分片报告（v1 11 份 + v2 11 份）。所有 hash 可 git show 验证。*
