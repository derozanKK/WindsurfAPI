# GATE RISK — release-note honesty audit

**Target:** `0ef5067f19a8a13a39d826bc01bff0c0e991489c`<br>
**Audited file:** `docs/releases/RELEASE_NOTES_3.141.592656.md`<br>
**Verdict: OVERSTATED.**

The named V-ledger closures, F2/F3 fixes, D1–D8/D10 boundaries, and gate claims are supported by
the supplied later evidence for their **tested mechanisms**. The notes also explicitly disclose D9,
P3 cleanup, live-upstream limits, and real-Docker/deployment limits. The release note nevertheless
omits the still-open, non-blocking audit2 **P2** risks that `FINAL-VERDICT.md` §1.2 and §2 require
to remain visible. Its opening “D 波跟进全部收口” shorthand and unqualified 27-row closure heading
can therefore be read as a broader remediation/safety certification than the evidence supports.
A green V-ID count does not close the separate audit2 findings.

This is a disclosure defect, not a finding that the landed F2/F3 or V/D fixes are ineffective.
`DIRECTION.md` and `FINAL-VERDICT.md` are pre-F2/F3 release-gate documents; their old blocking
conclusions are superseded only where the release report/addendum supplies the later fix and gate
evidence. Their residual-risk boundaries remain applicable.

## 1. Claim-by-claim adjudication

| Claim / required disclosure | Result | Evidence and exact boundary |
|---|---|---|
| 27 V rows closed, with 4 P0 + 18 P1 + 5 P2 | **Supported only as ledger/mechanism closure; scope must be explicit.** | `evidence/audit/VERDICT.md:7-16` establishes exactly 27 rows and that arithmetic. `docs/releases/ACCEPTANCE_3.141.592656.md:18-53` binds each row to a fix and test. The original `VERDICT.md` itself does not certify fixes. `FINAL-VERDICT.md:95` explicitly warns that a green V-ID count does not certify the separate residual paths. |
| F2 final-sweep false-empty defect fixed | **Supported for the tested mechanism, not overstated.** | Notes §2 describes the same `sawText`/terminal-classification defect as `FINAL-VERDICT.md:79`. The final acceptance addendum records the landed F2 regression and its tests; notes lines 105-107 correctly state that live F2 controls remain unverified. |
| F3 producer-entry deadline fixed | **Supported for the tested mechanism, not overstated.** | Notes §3 addresses the warmup/StartCascade/Send budget gap identified at `FINAL-VERDICT.md:80`, and the addendum records the landed fix. Notes lines 105-107 correctly retain the live-control boundary. No unsupported F3 waiver is claimed. |
| D1–D8 and D10 closed | **Supported only for their specified/tested boundaries.** | `FINAL-VERDICT.md:51-60` supersedes the older open D1–D8/D10 status and states the exact qualifications. Notes lines 75-84 substantially preserve them, including hermetic D6, fake/live D7, controlled-socket D8, and scoped D10. These closures do not erase other audit2 findings. |
| D9 design-only/open risk | **Disclosed; no fix required.** | Notes line 83 says “仅设计，开放风险”; lines 110-111 say OTA tag signatures, image signing, and fetched banner code are not verified. This matches `FINAL-VERDICT.md:59,82`. “D 波跟进全部收口” at line 5 should nevertheless be narrowed so it does not contradict D9's open status. |
| P3 cleanup deferred | **Disclosed; no fix required.** | Notes lines 84 and 112-113 explicitly defer README wording, dead i18n keys, and out-of-prefix env switches. `DIRECTION.md:43-45` defers P3 cleanup only; it does not authorize omission of the remaining P2s. |
| Live upstream / LS / clients unverified | **Disclosed; no fix required.** | Notes lines 81-82 and 105-107 explicitly retain fake-LS, controlled-socket, real-client, paid-account, and Cascade-live limitations. `FINAL-VERDICT.md` §3.2 confirms those evidence gaps. |
| Real Docker / deployment / rollback unverified | **Disclosed; no fix required.** | Notes lines 80 and 108-109 distinguish hermetic D6 from real daemon/registry/restart/deploy/rollback; lines 117-118 also say release CI/assets/deployment have not happened. This matches `FINAL-VERDICT.md` B06/B07 and §3.3. |
| Audit2 residual P2s | **NOT disclosed. Blocking documentation fix for an HONEST verdict.** | `FINAL-VERDICT.md:61` says the non-F2/F3 residual rows remain known risk, not certified harmless, and that the P3-only sentence must not be copied as the complete residual statement. `FINAL-VERDICT.md:83-95` enumerates them. None appears in notes §6. |

## 2. Exact lines to fix

Line numbers below are the lines at `0ef5067f` (working-copy blob and target blob both
`a98c7860cd0b68240517c9cb121166cbfed4e521`). Apply the following release-note edits; do not
rewrite the historical `DIRECTION.md` or `FINAL-VERDICT.md`.

### Fix A — narrow the opening claim (replace lines 4-6)

Current:

> D 波跟进全部收口，并关闭两条 Cascade 发布阻塞项 F2/F3。本版是 **patch**：协议形状未变，
> 请求字节相对 `v3.141.592655` 仍是 **270/270 逐字节一致、0 差异、allowlist 为空**。

Replace with:

> D 波指定修正已落地（D9 仍为仅设计的开放风险），并关闭两条 Cascade 发布阻塞项 F2/F3 的已测机制。
> 这不关闭 audit2 的其他残余 P2，也不构成 live/部署认证；边界见 §6。本版是 **patch**：
> 协议形状未变，请求字节相对 `v3.141.592655` 仍是 **270/270 逐字节一致、0 差异、allowlist 为空**。

The preceding line ending in `27 行 V 台账与` remains unchanged. This removes the false implication
that D9 is closed and avoids presenting F2/F3 as live-certified.

### Fix B — scope the 27-row closure (insert after line 17)

Insert:

> 本节“关闭”仅指各 V-ID 的具名机制已有修复与测试证据，不等于所有 Cascade/传输/部署风险均已关闭，
> 也不包括 audit2 的独立残余 P2；后者列于 §6。

This qualification also governs lines 13 and 21-23. Those lines need not be rewritten once this
sentence is present; their V-row arithmetic and named follow-up ownership are correct.

### Fix C — disclose every audit2 residual P2 (insert after line 109, before D9)

Insert this complete block in §6:

> - **audit2 残余 P2 未关闭（按当前发布策略非阻塞，不等于无害）**：27 行 V 台账与 F2/F3 的关闭不覆盖以下独立风险。
>   - **F5（Cascade 多轮）**：重放 prompt 的相反角色 closing tag 与最新 human turn 未被统一转义，可伪造对话结构；这是 prompt-integrity 风险，未证明跨租户暴露。
>   - **S03（dashboard）**：请求体在 Host/auth 门之前缓冲并解析；未认证并发连接可在读取期间各保留约 10–20 MB，需前置 Host 校验、较小长度上限与请求 deadline。
>   - **历史 downstream key**：已从当前文档删除不等于撤销；轮换/吊销仍 `[UNVERIFIED]`。不得发布 key 值；若仍有效须按安全事件处理。
>   - **L1（LS 冷启动/容量压力）**：全局 admission lock 跨越 capacity/memory 等待，可阻塞无关 LS 启动最多两轮 30 s；已就绪 LS 请求不受影响。
>   - **L2（默认 auto-restart）**：LS ready 后立即清零重试计数，ready-then-crash 循环可永远达不到 retry cap。
>   - **F4（Cascade 图片）**：历史图片有 4 张/1.6 MB 预算，但当前轮图片不纳入同一 count/aggregate-byte 预算；HTTP 10 MiB 上限仍限制网络输入。
>   - **Devin ACP-1/ACP-2（opt-in）**：pre-abort 后注册的 listener 不会触发，可能在调用方离开后开始工作；不可写 stdin 会静默丢 RPC，pending prompt 可等到默认 10 min timeout。尚无 live billable-turn 测量。
>   - **其余已列 P2**：Update P2-5（forced-update stash 未向操作者呈现）、G5（unbounded unary buffering）、C1（同步压缩）、W1（async Promise executor）仍未关闭；未进入 top-10 不代表已修复。

This block preserves the impact/reachability distinctions in `FINAL-VERDICT.md:83-95`; in
particular, it does not label static findings as reproduced, ACP as live billing proof, or F5 as
cross-tenant exposure. It also includes the four P2s immediately outside the top ten, whose omission
is expressly not a closure claim.

### No other line changes required for this audit

- Keep lines 83 and 110-111 (D9 design-only and unverified supply chain).
- Keep lines 84 and 112-113 (D10 scope and P3 cleanup).
- Keep lines 105-109 and 117-118 (live, Docker, deployment, CI/artifact boundaries).
- Do not weaken F2/F3 into “still open” or convert the notes into an unconditional production GO.
  The later final report records B01–B05 complete/tag-ready, while B06/B07 remain later-phase gates.

## 3. Re-audit criterion

Return **HONEST** once Fixes A–C (or wording with exactly the same scope and all the same residual
IDs) are present and the unverified-register release section is regenerated consistently. Until
then, **OVERSTATED** stands solely because the notes over-broaden closure and omit accepted/open P2
risk—not because D9, P3, live-upstream, Docker, or deployment limitations are hidden.

## 4. Review boundary

This was a read-only documentation/evidence audit of the target notes, original V ledger,
`evidence/DIRECTION.md`, `evidence/final/FINAL-VERDICT.md` §1.2/§2, the final acceptance addendum,
and the final release report. Product tests, live probes, Docker/deployment, and release CI were not
rerun. Source file:line anchors quoted by the historical verdict are evidence references, not fresh
measurements by this audit.
