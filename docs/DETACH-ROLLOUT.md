# Detach 默认开关：gate 2 压测与 gate 1 两周测量

`WINDSURFAPI_CASCADE_DETACH` 是**默认关**的行为变更（网络、内存、计费、共享 LS）。
设计 §7.4 规定：在下列 gate 全部满足前不得默认开启。本文只覆盖 gate 2（N 并发
abort 不饿死 live 请求）和 gate 1（两周 `serve/admit` 计数）的测量方法；其余 gate
的现状见文末表。

## 1. Gate 2 — N 并发 abort 不产生 `ls_pool_exhausted`

**命题。** `LS_MAX_INSTANCES=2`（代码常量 `MAX_LS_INSTANCES`）时，N（> 2）个并发
abort 各自冻结一个 detached entry，但 entry **不持有** `beginLsUse` 租约；因此产生
请求的 `finally` 一返回，LS 实例的 `activeRequests` 归零、重新可被 LRU 驱逐。随后
一个 live 请求（第三个 proxy key）必须能驱逐空闲实例并完成，而不是在池满时等
`LS_POOL_WAIT_MS` 后抛 `ls_pool_exhausted`。

**测试。** `test/detach-ls-pool-pressure.test.js`（POSIX；真实 `src/langserver.js`
池 + 真实 `ensureLs` spawn 的假 LS 进程，真实 handler/client/registry）：

```bash
WINDSURFAPI_SKIP_DOTENV=1 node --import ./test/setup-env.mjs \
  --test test/detach-ls-pool-pressure.test.js
```

测试的四个阶段（同一个测试，因为 `admissionStats` 是模块级计数）：

1. default + proxyA 占满 2 个槽位；在同一 proxyA 上并发触发 3 个 mid-stream
   abort。断言 `admit=3`、`serve=0`、`entries<=2`、`activeRequests=0`、
   并发峰值 `peakActive=3`、`poolExhausted=0`。
2. proxyB 的 live 请求驱逐空闲的 proxyA 实例并完整返回；`poolExhausted` 仍为 0。
3. **负控制**：手工 `beginLsUse(proxyB.port)` 钉住租约（模拟“detach 泄漏租约”的
   形状）。同一 live 请求现在必须以 `code=CAPACITY`（内部 `ls_pool_exhausted`，
   OpenAI 出口按 O10 归一成 `api_error`）失败，且 `poolExhausted` 恰好 +1。
   这一步证明 gate 对该失败模式是敏感的，而不是恒绿。
4. 解除钉住后重试：live 请求成功，`poolExhausted` 不再增长。

决定性输出形如：

```
GATE2 pressure: maxInstances=2 aborts=3 peakActive=3 admit=3 serve=0 entries=2 \
liveGreenPoolExhausted=0 redCode=CAPACITY redPoolExhausted=1 greenAfterUnpinPoolExhausted=1
```

原始日志与复跑命令见 `evidence/DetachPressure.md`。

## 2. Gate 1 — 两周 `serve/admit` 计数

### 2.1 读哪里

Dashboard 的 `GET /dashboard/api/overview`（需要 `X-Dashboard-Password`）新增
`detach` 块：

```json
{
  "detach": {
    "enabled": true,
    "admit": 412,
    "refuse": { "no_scope": 0, "no_chunks": 3, "tools": 11, "...": 0 },
    "lookup": { "hit": 98, "miss": 214 },
    "claim": { "ok": 95, "busy": 2, "ttl": 1, "deadline": 0, "gone": 0 },
    "serve": 71,
    "re_detach": 9,
    "evict": { "ttl": 17, "drain": 0, "account_removed": 0, "resume_miss": 5, "capacity": 6, "superseded": 3, "deadline": 0 },
    "replay_bytes": 918273,
    "billed_detached": 71,
    "entries": 2,
    "bytes": 41820,
    "draining": false
  }
}
```

- `enabled` 区分“开关没开”和“开了但没流量”。测量期间它必须一直是 `true`。
- `admit` = 成功冻结的 turn 数；`serve` = 被同一 body + 同一可信 scope 的重试
  认领并走完正常成功尾的次数。**gate 1 的比值就是 `serve / admit`。**
- `evict.*` / `refuse.*` / `claim.*` 用来解释比值为什么低：TTL/容量/被新请求覆盖
  的条目不会贡献 `serve`；`claim.busy` 说明并发重试只有一个赢家。
- `billed_detached` 应等于 `serve`（每次成功恢复恰好记一次账）。唯一的例外是
  claim 在原请求 deadline 边界结束、但上游 turn 已经跑完的样本：它按 owner 的
  稳定 id 记账（`billed_detached` +1），`release` 拒绝后不提交成功尾（`serve`
  不加）。其余任何不相等都是计费回归，直接停止测量。
- 计数器是**进程生命周期**的，重启清零；`/overview` 同一响应里的 `uptime` 可用来
  识别重启。

### 2.2 采集

前置：`WINDSURFAPI_CASCADE_TURN=1`、`WINDSURFAPI_CASCADE_DETACH=1`；有
per-user / `session:` scope 的真实流量（`api:<hash>` 等不可信 scope 永远不准入，
测不到东西）；dashboard 已设密码。密码只放环境变量或 0600 文件，不写进命令行、
不写进采集日志。

每 5 分钟追加一行（cron）：

```bash
# /etc/cron.d/windsurfapi-detach-gate1
# /etc/windsurfapi-dashboard.pw is root-only (0600) and holds the password.
*/5 * * * * root \
  curl -fsS -H "X-Dashboard-Password: $(cat /etc/windsurfapi-dashboard.pw)" \
    http://127.0.0.1:18999/dashboard/api/overview \
  | jq -c '{ts: now, uptime, detach}' >> /var/lib/windsurfapi/detach-gate1.jsonl
```

若 dashboard 在别的端口/前缀，改 URL；`jq` 只取需要的字段，避免把账号列表等
无关数据落盘。

### 2.3 汇总（14 天后）

计数器会因重启清零，所以不能拿“最后一次减第一次”。按相邻样本求增量，遇到
`uptime` 下降（重启）时把当前值整体当作新进程的增量：

```bash
jq -s '
  [ .[] | {ts, uptime, d: .detach} ] as $rows
  | reduce range(0; $rows|length) as $i
      ({admit:0, serve:0, billed:0, restarts:0, prev:null};
       ($rows[$i]) as $r
       | if .prev == null or $r.uptime < .prev.uptime
         then .admit += $r.d.admit | .serve += $r.d.serve | .billed += $r.d.billed_detached
              | (if .prev != null then .restarts += 1 else . end)
         else .admit += ($r.d.admit - .prev.d.admit)
              | .serve += ($r.d.serve - .prev.d.serve)
              | .billed += ($r.d.billed_detached - .prev.d.billed_detached)
         end
       | .prev = $r)
  | . + {ratio: (if .admit > 0 then (.serve / .admit) else null end)}
  | del(.prev)
' /var/lib/windsurfapi/detach-gate1.jsonl
```

判读：

- `ratio = serve / admit`，目标 **≥ 0.20**（设计 §7.4：低于约 20% 说明这条 120s
  的冻结换不回足够的恢复，默认开是净亏）。
- 分母必须写清：窗口内 `admit` 至少 100；流量不足就延长窗口直到 100 个 admit
  或 14 天（取更晚者），报告实际天数与 `admit`。
- 同时报告 `restarts`、`evict` 合计、`refuse` 合计、`billed`（正常应等于 `serve`；
  claim 在 deadline 边界被清理的样本可能少一次 serve，TTL 清理不应造成差异）。
- 测量期间 `enabled=false` 的样本不计入窗口。

### 2.4 立即停止/回滚条件

出现任一条即停止测量并回滚（unset 两个 env，重启；entry 全在内存，无需清理）：

- 跨 tenant 命中（`hasPerUserScope` 之外的 scope 拿到 entry）；
- `billed_detached != serve`（仅 §2.1 的 deadline 边界已完成 turn 例外），或账单落到非 owner 账号；
- 恢复轮把整条 cascade 历史重复计费（metadata RPC 不是从 `generatorOffset` 起）；
- 120s TTL 后**未 claim** 的 `entries/bytes` 不归零（泄漏）；claimed entry 由原请求
  deadline 约束，deadline 前不归零是正常；
- 归因于 detach 的 `ls_pool_exhausted`（gate 2 回归）；
- 进程 RSS 随 `entries` 单调上涨。

## 3. 设计 §7.4 门禁现状

| # | 门禁 | 现状 |
|---|---|---|
| 1 | 两周 `serve/admit` 计数 | **测量面已就绪**：`/overview.detach` 暴露 `admit`/`serve` 等计数；计划见本文 §2。尚未开始两周窗口。 |
| 2 | N 并发 abort 不产生 `ls_pool_exhausted` | **本分支覆盖**：`test/detach-ls-pool-pressure.test.js`，HMC 实跑见 `evidence/DetachPressure.md`。 |
| 3 | 恢复轮只计最后一轮 usage、账单落 owner | 既有 T3/T5 与 soak 覆盖（`evidence/DetachSoak.md`）。 |
| 4 | T4/T6/T8 + mutation 全 caught | 既有 lazy-resume 套件与 mutation 表覆盖。 |
| 5 | §6.5 abort 条款维护者签字 | 待维护者。 |
| 6 | 真实上游 60s detach/resume 字节一致 | 由 live 影子实例 lane 负责（不在本分支）。 |
| 7 | 回滚路径 = unset + restart | 已满足（内存条目，无持久化）。 |
