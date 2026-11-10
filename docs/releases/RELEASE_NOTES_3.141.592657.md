# v3.141.592657

自 v3.141.592656 以来的 **16 个提交 / 43 个文件**（`git rev-list --count v3.141.592656..f6b843fe`；
`git diff --shortstat v3.141.592656..f6b843fe`：4,057 增 / 216 删）把 D9 供应链控制的三个可落地部分
落到了默认路径：banner 生成器改为 commit + 逐文件 sha256 锁定，Docker 镜像按 digest 签名并在
dashboard OTA 中强制校验，源码 OTA 在改动 Git 前校验签名的 `release-attestation.json`。同时修复
了 F3 截止边界上最后一毫秒的 phase timeout 误分类。本版是 **patch**：协议形状未变，请求字节相对
`v3.141.592656` 仍是 **270/270 逐字节一致、0 差异、allowlist 为空**。

> **版本号**：`3.141.592656` 之后的 patch，语义化版本写作 **3.141.592657**（tag `v3.141.592657`，
> 本文件 `RELEASE_NOTES_3.141.592657.md`）。发布提交、认证树 SHA、逐项门禁计数和日志哈希见同日
> 验收附录 [`ACCEPTANCE_3.141.592657.md`](ACCEPTANCE_3.141.592657.md) —— 本文件只写内容与边界，
> 附录是本次认证的唯一计数来源。

## 1. BannerLock — banner 工作流不再执行运行时拉取的代码

`banner.yml` 过去从 `dwgx/DWGX@main` 拉四个 Python 文件直接 import/执行，且该工作流持有
`contents: write`。上游 `main` 的任何一次提交都能在没有本仓库 tag 的情况下取得写权限并推提交。

- 新增 `repo-kit.lock.json`：生成器锁定到 `dwgx/DWGX` 的 commit
  `0b44ea0168cf04654683812d6d3d7e64e5f3acf8`（2026-10-02，最后触及这四个文件的提交），并对
  `build.py` / `styles.py` / `styles_ink.py` / `ink.py` 逐文件记录 sha256 与字节数。
- 新增 `scripts/fetch-repokit.mjs`：先把四个文件读入内存并逐个校验 sha256，全部匹配后才写入一个
  全新的 staging 目录并整体替换目标目录；任何缺失、额外文件、非 200、哈希不符都在 import 之前
  exit 1，且失败时删除目标目录，避免残留的 `build.py`/`build.pyc` 被后续 import。
- `banner.yml` 的 fetch 步骤改为 `node scripts/fetch-repokit.mjs --dest /tmp/repokit`，验证在
  render/commit 之前；不再回退到 `main`，也没有 `continue-on-error`。`contents: write` 保留，因为
  自动提交仍需要它——这是已接受的风险，不是已关闭项。
- 同一批把仓库内 45 个 `uses:` 全部钉到 commit SHA（含 release/banner/ci/baseline-audit/
  star-history 的 checkout、setup-node、upload-artifact 等），`ci.yml` 显式声明
  `contents: read`，`baseline-audit.yml` 保持只读。

边界：锁定的是「已 review 的 commit 的字节」，不是「已证明安全的代码」；pin 需要人工随上游更新，
`contents: write` 下的自动提交仍是一个写权限执行路径。见 §5。

## 2. DockerSign — 镜像按 digest 签名，dashboard OTA 只认 digest

release workflow 的 `docker` job 现在：

- 为 `docker/build-push-action` 命名 `id: build`，把 `steps.build.outputs.digest` 作为唯一不可变
  地址；`permissions` 增加 `id-token: write` 供 cosign keyless 使用（缺少时 job 失败，不会静默
  跳过签名）。
- 构建并推送后执行 `cosign sign --yes "ghcr.io/<owner>/windsurf-api@sha256:<digest>"`；随后把
  digest 写入 `image-digest.txt`，用 `cosign sign-blob --bundle image-digest.txt.sigstore.json`
  签名，并把两个文件作为 `image-digest` artifact 传给 release job，最终附在 GitHub Release 上。
- 两个步骤都拒绝非 `sha256:<64hex>` 的 digest；空 bundle 也会让 release job 失败。

dashboard 的 Docker OTA（`src/dashboard/docker-self-update.js`）现在在改动 daemon 之前完成授权：

- 读取 `<DATA_DIR>/image-digest.txt`；缺失、空或格式错误返回 `image-mutable-ref` /
  `image-digest-missing`，不再把 mutable tag 当作可执行目标。
- 通过 daemon 的 `GET /distribution/<repo>:<tag>/json` 解析 tag 的 `Descriptor.digest`；与签名
  digest 不一致返回 `image-digest-mismatch`（两个 digest 都在 `detail` 中），不 pull、不 create。
- 按 digest pull（Moby 形状 `fromImage=<repo>&tag=sha256:<64hex>`），pull 后检查
  `GET /images/<digest-ref>/json` 的 `RepoDigests` 包含该 digest，否则
  `image-digest-unconfirmed`；容器 create 之前就失败。
- deployer 镜像 `docker:24-cli` 改为 digest 固定（OCI index
  `sha256:2b62f89aaab9e4df0ff843f0d9a7bbd17340a9ba7c660ba6f40b1f00b38c2a4d`，linux/amd64 子
  digest `sha256:dba081061b860672b2f50172ee0449b4d0a673586056ee8c12bf7747469e3cbe`），
  且所有 `docker compose up` 都带 `--no-build`，Compose 不能从磁盘 checkout 本地构建。

操作提示：dashboard Docker 更新要求操作者把与本次 release 匹配的 `image-digest.txt`（以及
`.sigstore.json` bundle）放进数据目录；这是 D9 的显式 staging 步骤，不是自动下载。
`WINDSURFAPI_IMAGE=repo@sha256:…` 仍是显式的 operator pin。`deploy/update.sh` 的命令行路径
没有在本版改动，仍按 tag/镜像引用更新——它不在 dashboard 的 digest gate 内，见 §5。

## 3. SourceAttest — 源码 OTA 在改 Git 前校验签名的 release attestation

release job 新增：

- `node scripts/generate-release-attestation.mjs --tag "$GITHUB_REF_NAME" --commit "$(git rev-parse HEAD)"
  --tree "$(git rev-parse 'HEAD^{tree}')" --repository "$GITHUB_REPOSITORY"` 生成确定性的
  `release-attestation.json`：schema 1、tag、commit、tree，以及 `SHA256SUMS` 与四个二进制/zip 的
  sha256（资产名按 release 页面的扁平名）。
- `cosign sign-blob --bundle release-attestation.json.sigstore.json release-attestation.json` 用与
  二进制相同的 workflow 身份签名；bundle 为空则 release job 失败。
- `release-attestation.json` 与它的 `.sigstore.json` 作为 release assets 发布。

消费端：

- `/self-update`（`src/dashboard/api.js` 的 `releaseUpdateState`）在返回 mutation target 之前调用
  `verifyReleaseAttestation`；`update.sh` 在 stash/reset/merge 与服务重启之前调用
  `scripts/verify-release-attestation.mjs`。校验要求 attestation 的 commit 等于所选 tag peel 出来的
  commit；签名无效或 commit 不一致时**两种模式都拒绝**。
- `WINDSURFAPI_UPDATE_ATTESTATION` 默认 `warn`：attestation 存在就校验；缺失（没有资产、没有
  bundle、没有 cosign、网络失败）只记 warning 并继续，保证老安装不需要 cosign 也能升级。
  `required`：缺失即拒绝。只接受 `warn` / `required`，其他值直接拒绝本次更新。
- `WINDSURFAPI_ATTESTATION_DIR` 可指向预置目录，供离线/内网主机与 fork 使用；不设则从
  `dwgx/WindsurfAPI` 的 GitHub Release 下载。

边界：tag 触发的 workflow 签名证明的是「这个 tag 的这次构建」，不是「独立审批」。只有 Owner 能推
`v*` tag 的前提下，源码 OTA 仍然信任 Owner 的 GitHub release 权限；本版不声称 OTA 获得了独立授权。
见 §5。

## 4. Cascade 截止边界 — 最后一 tick 的 phase timeout 归为 route deadline

B06 CI attempt 2 的 `cascade-turn-deadline` 计时 flake 暴露了一个真实分类缺口：`throwIfSpent`
只在 `remainingBudgetMs() > 0` 为假时把 phase 失败转成预算停止，但预算 RPC 的 timer 和
`Date.now()` 都按整数毫秒截断——timer 在最后一 tick 触发时，墙钟可能仍读出 1–2 ms 预算，原始
gRPC timeout 就逃逸成传输错误（账号轮换 / 502），而不是 504 deadline。

- `src/client.js:1046-1058` 引入 `DEADLINE_TOLERANCE_MS = 5`：最后 5 ms 视为已花完，不再重试；
  与 poll loop 的 `WINDOW_END_TOLERANCE_MS` 同策略。
- 新增确定性测试臂：把墙钟上限压到 `budget-1`，让真实 StartCascade timer 跑完剩余切片；未修代码
  会以 CI 同款 `gRPC unary timeout` 失败，修复后归类为 `upstream_deadline_exceeded`（504），
  且不发出 Send、不读 step。
- `test/mutations/cascade-final-sweep-deadline.json` 重钉被移动的锚点并增加 tolerance-0 臂。

## 5. 门禁与认证

本版在发布提交上实测（Windows 本地门禁、Linux Node 24 与 Node 22、wire、全量 mutation sweep）。
**逐项命令、精确计数、skip 名单、日志路径与 sha256 全部记录在同日验收附录**
[`ACCEPTANCE_3.141.592657.md`](ACCEPTANCE_3.141.592657.md)；该附录与本节在同一个 tag 树上，
不引用任何「上一棵树」的数字。

- wire：基线由外部选择并证明为 `v3.141.592656` → `9115ebe7183f9460df8fcce8520a0365f856ba9f`，
  在干净的外部基线树上比较；要求 **270/270 逐字节一致、0 未声明差异**。
- mutation：**97 份 spec / 863 条突变**（静态重算 `ls test/mutations/*.json | wc -l` = 97，
  逐 spec 求和 863）；发布门按 Owner 指示先用 `spec-baseline-check --all`（97 specs / 0 drift），
  完整 sweep 已于 tag 后补跑：**97/97 spec、863 条 = 846 捕获 + 17 声明 survivor、0 意外、
  0 baseline drift、0 untrustworthy**。具体日志与哈希见验收附录 §3。
- Node 22 使用既有的 22.23.4 对照解释器（HMC
  `/root/node22matrix-360/node-v22.23.4-linux-x64/bin/node`）；声明的 `>=22.13.0` 下限本身仍未
  实测，见 §6。

## 6. 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增的条目也在其中。

- **D9 不是「全部关闭」**：banner 已 hash-lock、Docker 镜像已按 digest 签名且 dashboard 路径强制
  校验、源码 OTA 已有签名 attestation；但源码 OTA 与所有 release 签名最终仍信任单个 Owner 的
  tag/账号权限。tag 触发的 cosign 不是独立审批；`WINDSURFAPI_UPDATE_ATTESTATION=warn` 是默认值，
  老安装可以继续在没有 attestation 的情况下升级。`deploy/update.sh` 的 Docker 路径仍按 tag/镜像
  引用更新，不在 dashboard 的 digest gate 内。
- **Docker 实网签名未在认证时验证**：DockerSign 的测试是 hermetic 的（注入 detect/pull/request
  与 fake registry）；真实 GHCR push、cosign 签名、daemon digest 校验与 rollback 需要 tag 后的
  release workflow 和真实 Docker 主机执行，属于 B06/B07 的核对范围，不在本文件的预认证内。
- **真实上游 / 真实 LS / 真实客户端未重跑**：本版的 banner/docker/source-attest 变更不改变上游
  协议路径；Cascade 证据仍是 fake LS/受控 socket，没有用真实 LS gRPC、真实付费账号或真实
  Claude/Codex/Devin 客户端复验。Cascade live 矩阵仍 `[UNVERIFIED]`。
- **audit2 残余 P2 未关闭（按当前发布策略非阻塞，不等于无害）**：27 行 V 台账与 F2/F3 的关闭
  不覆盖以下独立风险。
  - **F5（Cascade 多轮）**：重放 prompt 的相反角色 closing tag 与最新 human turn 未被统一转义，
    可伪造对话结构；这是 prompt-integrity 风险，未证明跨租户暴露。
  - **S03（dashboard）**：请求体在 Host/auth 门之前缓冲并解析；未认证并发连接可在读取期间各保留
    约 10–20 MB，需前置 Host 校验、较小长度上限与请求 deadline。
  - **历史 downstream key**：已从当前文档删除不等于撤销；轮换/吊销仍 `[UNVERIFIED]`。不得发布
    key 值；若仍有效须按安全事件处理。
  - **L1（LS 冷启动/容量压力）**：全局 admission lock 跨越 capacity/memory 等待，可阻塞无关 LS
    启动最多两轮 30 s；已就绪 LS 请求不受影响。
  - **L2（默认 auto-restart）**：LS ready 后立即清零重试计数，ready-then-crash 循环可永远达不到
    retry cap。
  - **F4（Cascade 图片）**：历史图片有 4 张/1.6 MB 预算，但当前轮图片不纳入同一 count/aggregate-byte
    预算；HTTP 10 MiB 上限仍限制网络输入。
  - **Devin ACP-1/ACP-2（opt-in）**：pre-abort 后注册的 listener 不会触发，可能在调用方离开后开始
    工作；不可写 stdin 会静默丢 RPC，pending prompt 可等到默认 10 min timeout。尚无 live
    billable-turn 测量。
  - **其余已列 P2**：Update P2-5（forced-update stash 未向操作者呈现）、G5（unbounded unary
    buffering）、C1（同步压缩）、W1（async Promise executor）仍未关闭；未进入 top-10 不代表已修复。
- **P3 清理未做**：`DIRECTION.md` 明确延后；README 的模型计数/双 API 表述、63 个死 i18n key、
  32 个前缀外 env switch 等仍是已知文档债，不是本版回归。
- **Node 下限未实测**：只跑了 22.23.4 与 24.21.0；`>=22.13.0` 的 floor 本身 `[UNVERIFIED]`。
- **Windows 本机 inert 声明**：平台/live 文件按 `GATE_INERT_SKIP_PATHS` 声明，不当作绿；具体名单
  与计数见验收附录。
- **托管 CI / 发布产物 / HMC 部署**：tag、release workflow、cosign 资产核验与 HMC 部署都必须在
  tag 后另行执行与核对（B06/B07）；本文件不代表它们已经发生。
