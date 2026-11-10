# GITHUB-CORPUS.md — 本仓库 GitHub 历史的离线语料

`dwgx/WindsurfAPI` 的全部 GitHub 远端历史（PR / issue 的正文、评论、review、行内 review 评论、
提交、改动文件清单、issue 时间线）被落成一份**离线可查询**的本地语料：查「这条 PR / issue 当时
到底怎么说的」不再需要联网重读 GitHub。**语料本身不在本仓库里**（它是本机资产，见下表「位置」）；
本文只写**方法与形状**——数据正文以本地语料为准，不复制到这里。

## 快照事实（2026-10-15）

| 项 | 值 |
|---|---|
| 抓取时刻 | `2026-10-15T07:51:38Z`（UTC，记在语料 `meta.json.fetchedAt`；`query.py --stats` 会打印） |
| 覆盖 | **89 个 PR / 183 个 issue**（全部状态，含 closed；PR 与 issue 共用一个编号空间，#N 全局唯一） |
| 同轮分母（四个来源一致） | `gh pr/issue list --state all` = 89 / 183；REST `pulls` Link 头末页 = 89；search API `total_count` = 89 / 183；实际抓下条数 = 89 / 183 |
| 规模 | 1190 次 API 调用 · 0 错误 · 0 截断 · 117 秒（6 线程；`gh` 2.98.0） |
| 位置 | 本机 `extra-hands/RESEARCH/windsurfapi-corpus/`（**不进 git**；克隆仓库拿不到） |

## 怎么重建（唯一的联网入口）

全量刷新一条命令（`fetch.py` 只读 GitHub，不发任何写操作）：

```
python "extra-hands/RESEARCH/windsurfapi-corpus/fetch.py"
```

- **权限**：仓库是公开的，登录 `gh`（默认 scope 即可）就能跑；匿名限流 60/h 不够（本轮 1190 次调用）。
- **分页**：列表端点 `--limit 1000`；明细端点 `per_page=100` **全翻页**（单端点上限 30 页）；
  触顶会记进 `meta.json.truncations`（本快照为空）。
- **产出**：`prs.json`（1.55 MB）/ `issues.json`（2.32 MB）/ `prs.tsv` / `issues.tsv` / `meta.json`，
  并重算 `MANIFEST.sha256`（覆盖目录内 15 个文件）；末尾自检「实际抓下条数 vs 同轮 `gh` 计数」，
  一致才打印 `COUNTS OK`、exit 0。
- **校验**：`fetch.py --verify` → 按原始字节逐文件比对，打印 `VERIFY OK (15 files, 0 bad)`；
  `--manifest-only` 在只改本地文件后离线重算清单。
- **环境**：Windows 原生 Python 3.8+（标准库零依赖）+ `gh` ≥ 2.x；网络慢或触发重试时可能几分钟。

## 语料里有什么（记录 schema 字段）

`prs.json` 每条 PR 的字段：

```
number / title / state / url / author(.login) / authorLogin /
createdAt / updatedAt / closedAt / mergedAt / merged / mergedBy /
labels[] / labelNames[] / additions / deletions / changedFiles /
isDraft / reviewDecision / headRefName / baseRefName / headRefOid / body /
comments[]        {user, author, createdAt, body}                  # 会话评论
reviews[]         {user, author, state, submitted_at, submittedAt, body_len, body}
                                                                   # review 对象（APPROVED / CHANGES_REQUESTED …）
reviewComments[]  {author, createdAt, path, in_reply_to_id, body}  # 行内评论
commits[]         {sha, message, authorLogin, authorName, date}    # 完整 message
files[]           {filename, path, status, additions, deletions, changes}  # 文件级统计（无 patch 正文）
checkRuns         {total, runs[]: {name, status, conclusion}}
mergeCommit / mergeCommitSha / reviewsUrl
```

`issues.json` 每条 issue 的字段：

```
number / title / state / stateReason / author(.login) / authorAssociation /
createdAt / updatedAt / closedAt / labels[] / body /
comments[]        {user, author, authorAssociation, createdAt, body}
closeEvent / closeActor / closedByLogin / closeStateReason / closeMechanism / reopenCount /
commitIds[] / prRefs[] / mergedRefs[] /
timeline[]        {event, actor, created_at, commit_id, state_reason, label, source}
                  # 含 cross-referenced 的来源（source.type/number/title/merged_at/html_url）
timelineEventCount / commentCount
```

说明：`user` / `filename` / `submitted_at` / `mergeCommitSha` 是旧 schema 键，与新的
`author` / `path` / `submittedAt` / `mergeCommit` **同值并存**（旧消费者不破）。完整字段清单、
逐字段说明与 5 条示例的**逐字输出**见语料目录 `INDEX.md` 的「记录 schema」一节。

## 怎么查询（`query.py`，完全离线）

`query.py` 从自身所在目录读数据，任意 cwd 可用（示例写短形式 `query.py`，等效）。五个真实例子：

| # | 命令 | 输出形状 |
|---|---|---|
| 1 | `query.py --stats` | 逐行 key-value：`repo` / `corpus`（路径）/ `fetchedAt`（+ gh 版本、调用数、错误数）/ `PRs`（open / merged / closed）/ `issues`（open / closed）/ `reasons` / `labels`（Top 12）。`--stats --json` 给同一份数据的 JSON |
| 2 | `query.py --type pr --state open` | 列表行：`PR #<N>  [<STATE>] <author>  <YYYY-MM-DD>  <title>`（本快照 4 行 = 入站 PR 队列） |
| 3 | `query.py --label bug --state open` | 同形状的 issue 行（本快照 = 9 个 OPEN 里带 `bug` 标签的） |
| 4 | `query.py --grep <regex> --type issue` | 大小写不敏感正则；搜索范围 = title / 正文 / 评论（PR 另加 review、行内评论、提交信息）；每行尾附 `(N hits)` |
| 5 | `query.py --show <N>` | 单条全文。PR 段落：`BODY → ISSUE COMMENTS → REVIEWS → REVIEW COMMENTS → COMMITS → FILES`；issue 段落：`BODY → COMMENTS → TIMELINE`。`--show N --json` 给原始记录；查无此号 → stderr + exit 1 |

过滤语义：`--type pr|issue|all`；`--state open|closed|merged|all`（merged 按 `mergedAt` 判定，
只可能命中 PR）；`--label`（精确、大小写不敏感）；`--author`；`--since YYYY-MM-DD`（按 **createdAt**）；
`--limit N`；`--json`（列表模式输出完整记录数组）。退出码：0 正常 / 1 查无此号 / 2 参数或语料错误。

## 覆盖边界（没抓什么，如实清单）

- **PR 的 timeline 事件**：issue 的抓了（含 cross-referenced 来源），**PR 的没抓**——PR 的 label
  变更 / review-request / cross-reference 事件不在库内。
- **diff patch 正文**：只有文件级统计（path / status / ±行数），没有 hunk 文本。
- **CI 细节**：只有 head 提交的 check-runs 名称 / 状态 / 结论；没有日志、artifact、历史 run。
- **reactions / assignees / milestone / projects / linked branches / deployments / releases**：未抓。
- **commit 级文件清单**：只有 sha / 完整 message / 作者 / 日期（列表端点口径）。
- **抓取时刻之后的变化**：快照性质，不在库内；要最新 → 重跑 `fetch.py`。
- 目录里另有 5 个 **2026-10-01 旧 digest**（`pr-DIGEST.md` 等，84-PR 快照）：原始生成脚本未保留、
  刷新不会更新它们——引用前先看 `INDEX.md` 文末的说明。

## 数字口径

- PR 三态 MERGED / CLOSED / OPEN（**merged 由 `mergedAt` 非空判定**——REST 的 `state` 对已合并
  PR 也返回 `closed`，按 `state` 分类会把 54 个已合并 PR 全归错）。
- issue 两态 OPEN / CLOSED；open 的 `stateReason` 为空串（GitHub 语义），closed 的 ∈
  COMPLETED / NOT_PLANNED / DUPLICATE。
- 时间戳全部 UTC、GitHub 原样；`--since` 按 createdAt（不是 updatedAt）。
- 引用任何数字都要带上**抓取时刻**（快照会过期）。

## 相关资产（同一轮，本机）

本轮（2026-10-15）在语料之上做了两侧考古，产物在本机
`extra-hands/RESEARCH/windsurfapi-archaeology-20261015/`：`pr/`（决策台账、被拒设计、贡献者矩阵、
89 行分类表；入口 `pr/INDEX.md`）与 `issues/`（183 条逐条分类、远古史、feature backlog、未决线程；
入口 `issues/ISSUE-TAXONOMY.md`）。交接文档 [HANDOFF-2026-10-15.md](HANDOFF-2026-10-15.md) §5 把它们
与语料一起列为「本机独有资产」。
