# v3.9.54

本版三条：**账号页 P0 修正（KPI 真实、人话、可取消的车队任务）**、**文档漂移守卫**、**3.9.53 审查修正**。没有协议兼容性破坏。

## 用户可感知

### 账号页：KPI 不再说谎，批量操作不再卡死

- KPI 改成真正的划分：`正常 + 已停用 + 需处理 = 总数`；`已停用` 只数 `status==='disabled'`，banned/reauth/error 都进 `需处理`，`仅异常` 用同一谓词。Teams 共享余额按 org/team 去重，`balanceOwners`/`balanceSharedAccounts` 可见。
- 机器话改成中文/英文人话：`API Key`/`登录凭证`/`邮箱登录`/`会话凭证`，`ls_not_idle_resident` → “语言服务没在运行…”，re-auth 的 `GetUserStatus`/错误码收进折叠的“技术详情”；未映射的 `ERR_*` 不再直接显示。新增 `npm run check:copy` 守住范围。
- 车队任务（全部探测/刷新全部余额）改为后台 job：`POST /accounts/fleet-jobs` + `GET …/:id?since=N` + `POST …/:id/cancel`；UI 显示 `检查 3/12 · 当前 <email>`、可取消、逐行更新、结束后保留结果面板（不依赖是否勾选）。

回归：253 条相关测试 0 fail；截图 34/34（KPI 划分 8=3+1+4、共享余额 `$32.00` 去重、390 无溢出、英文、re-auth 抽屉、车队结果面板）。

### 文档：版本漂移现在会让门变红

- 新增守卫：handoff §0 的 `产品 tag`/`package.json`/`master == vX` 必须与当前版本一致；tag 必须能解析到 annotated tag/对象/提交；banner 文案必须等于 href；每个 `[vX.Y.Z](...)` 必须指向该版本 notes；CHANGELOG `当前` 行与 banner 计数一致。
- 修掉 11 处 banner 文案、handoff §0（v3.9.40 → v3.9.53）、`docs/README.md`、CHANGELOG tag 计数、README 星数、secret-scan 轮次说明；旧 §0 原样保留在 `<details>`。
- 旧守卫 33/33，新守卫在旧文档上 40/44（4 处漂移被抓），修后 44/44。

### 3.9.53 审查修正

- `#236` 的 prose-tool-intent 检测移到 emulation/stop 之后，正常的 `<tool_call>` 模拟调用不再被误记为“只有 prose”；新增 3 条测试（16/16）。
- `deploy/update.sh` 的 exec 回退加了超时（`timeout(1)` 或纯 bash 看门狗 + `AbortSignal.timeout`），容器卡死会触发回滚而不是挂住；WSL 20/20。
- 3.9.53 notes 增加勘误：默认开启的历史预算（100 轮 / 8 MB → 413）与 PATCH 状态白名单（400 `ERR_ACCOUNT_STATUS_INVALID`）也是本版行为变化。

## 工程与门禁

- 合入 3 条分支（均基于 `693b375`）：`fix/doc-drift` `df4f915`、`fix/ui-p0` `bb45dce`、`fix/review353` `6e6f955`。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,120 pass / 0 fail / 95 skip（505 文件）**；`spec-static-check`/`spec-baseline-check`/`secret-scan`/`git diff --check` 全 PASS。
- Linux `npm run test:release`（HMC，Node v24.21.0，505 文件）：**6,210 pass / 2 fail / 3 skip**；两条失败都是 `docs-consistency-guard` 在无 tag 的 bundle clone 里 fail-closed（"no release tags reachable"），`git fetch --tags` 后该文件 44/44，全量即 **6,212 pass / 0 fail / 3 skip**。
- wire：对 `v3.9.53`（`693b375`）比较 **270/270**，`tag_ref_verified:true`。
- mutation：全部 **85 个规格 exit 0**（无 survivor）。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实池的批量任务延迟与取消（fake upstream）。
- `[UNVERIFIED]` 真实 Docker daemon 的 pull/health/rollback（脚本状态机已在 Git Bash 复现）。
- `[UNVERIFIED]` 1440/390 之外视口与屏幕阅读器。
