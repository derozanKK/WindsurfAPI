# v3.9.56

本版两条：**ACU 按量余额说真话**、**发布清单与安全文档**。没有协议兼容性破坏。

## 用户可感知

- **按量余额有符号**：`overageCredits` 是上游的有符号微美元余额，负数 = 已透支。面板从 “Overage credits” 改为 “Overage balance / 按量余额”，显示 `-$0.10 (overdrawn / 已透支)`；亚分金额显示 6 位小数，`-$0.00` 不再出现。**不 clamp、不隐藏**——clamp 会把上游没报的 0 当成事实。
- 用量/ACU 面板的 tooltip 与 README 写明“有符号美元、直通、永不 clamp”。

## 发布与安全

- **SHA256SUMS 修复**：`release.yml` 现在用平铺资产名生成清单。v3.9.53 的清单写的是 `dist-windows/…` 路径，下载到同一目录后 `sha256sum -c` 对 4 个资产中的 3 个失败（已复现）。
- 新增 `docs/QUERY-KEY-DEPRECATION.md`：`?key=` 标记为“支持但弃用”，列出优先级、泄漏面（nginx 已只记 `$uri`）、header 迁移与分阶段移除计划（patch 版本不删）。
- 新增 `docs/RELEASE-SIGNING.md`：现有 `SHA256SUMS` + `/self-update` tag/祖先校验 + Docker 健康回滚，未签名发布的风险，以及 cosign-keyless / minisign / attestation 的具体路径（不含密钥材料）。
- 新增 `docs/OPENCODE-REVIEW.md`：仓库没有 OCR workflow，Actions secrets 为 0，因此未新增 workflow；文档给出可一键启用的 `workflow_dispatch` SARIF 任务与零新 secret 的 GitHub Models 变体（标 `[UNVERIFIED]`）。

## 关于 v3.9.55

`v3.9.55` 的 tag 存在，但它的 GitHub Release **没有发布**：`docs-consistency-guard` 在 tag 提交上要求 §0 的 `commit` 精确等于 tag 提交，而发布提交写于 tag 之前、只能指向祖先，Test job 因此失败。本版把该断言放宽为“必须是 tag 提交的祖先”（非祖先/伪造 SHA 仍红，已用 `83f6b63` 验证），v3.9.55 的内容全部包含在本版中。

## 工程与门禁

- 合入 `fix/acu-edge` `83f6b63`、`fix/sec-docs` `0b624c9`。
- ACU 相关 42/42；`dashboard-*` + i18n 488/488；copy/i18n 检查绿。
- `release-workflow.test.js` 覆盖平铺名清单；manifest 模拟 `sha256sum -c` 四个 OK。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,150 pass / 0 fail / 95 skip（506 文件）**。
- Linux `npm run test:release`（HMC，Node v24.21.0，506 文件）：**6,242 pass / 0 fail / 3 skip**。
- wire：对 `v3.9.55`（`fa882f7`）比较 **270/270**。
- mutation：全部 **85 个规格 exit 0**（无 survivor）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 `app.devin.ai` 的 `/billing/status` 抓包（池内无 session token，fixture 来自面板观测值）。
- `[UNVERIFIED]` 修改后的 release job 真实跑一次（需要 tag）。
- `[UNVERIFIED]` cosign/minisign 命令与 OCR/SARIF 执行（无密钥/无 provider token）。
