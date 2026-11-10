# v3.9.57

修复**发布门本身**：v3.9.54 / v3.9.55 / v3.9.56 的 tag 都在，但 GitHub Release 没有发布——Test job 在 `docs-consistency-guard` 上失败。本版只改这条守卫，产品代码与 3.9.56 完全一致。

## 根因（已复现）

`actions/checkout@v5` 在 tag push 上执行 `fetch … +<commit>:refs/tags/vX`，把 `refs/tags/vX` **强制指向提交**。守卫要求 `git cat-file -t refs/tags/vX` 返回 `tag`（annotated 对象），在 CI 里永远返回 `commit`，因此：

- `v3.9.53` 通过（守卫的该断言在 3.9.54 才加入）；
- `v3.9.54`、`v3.9.55`、`v3.9.56` 的 Release run 全部在 Test 失败，**没有 GitHub Release 产物**（tag 与 tarball 存在，OTA/自更新不受影响；`/opt` 部署来自 tag tarball）。

## 修复

`test/docs-consistency-guard.test.js` 现在按 ref 形态分两条路：

- `refs/tags/vX` 是 **tag 对象**（本地/annotated checkout）：保留 annotated、tag 对象与 §0 `对象` 的一致性断言，不放宽。
- 是 **commit**（Actions 强制 ref）：跳过 annotated/对象断言，但仍要求 ref 可解析、§0 的 commit 等于或为 tag 提交的祖先、版本与 `package.json`/最新 tag 一致。
- 其它对象类型直接失败。

## 红/绿（同一台机、同一个 clone）

| 形态 | 结果 |
| --- | --- |
| 本地 annotated worktree | 44/44 绿 |
| clone + `update-ref refs/tags/vX <commit>`，修复前 | 43/44 红（`actual: 'commit', expected: 'tag'`） |
| 同上，修复后 | 44/44 绿 |
| 同上 + 非祖先提交 | 红（`not an ancestor of (or equal to)`） |
| annotated + §0 `对象` 改成 `deadbee` | 红（本地对象检查仍生效） |

## 工程与门禁

- 合入 `fix/release-guard` `5b000ec`（单文件 +33/−10）。
- Windows `npm run gate`：**PASS**；`npm run test:release` **6,150 pass / 0 fail / 95 skip（506 文件）**。
- Linux `npm run test:release`（HMC，Node v24.21.0，506 文件）：**6,242 pass / 0 fail / 3 skip**。
- 生产代码零改动（单文件测试），mutation 规格不覆盖该守卫；wire 与 3.9.56 相同。
- 本版之后请用 `gh release view v3.9.57` 确认 Release 与 5 个资产（含 `SHA256SUMS`）真实发布。

## 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)。

- `[UNVERIFIED]` 真实 Actions 执行（本地用强制 ref clone 复现了对象形态）。
- `[UNVERIFIED]` v3.9.54–56 的 Release 产物不会补发；它们的内容已包含在 3.9.56/3.9.57。
