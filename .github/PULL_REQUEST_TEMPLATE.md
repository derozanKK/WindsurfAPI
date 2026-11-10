<!-- 感谢贡献 / Thanks for contributing.
     完整规则见 CONTRIBUTING.md;这里只列每个 PR 都要回答的。
     Full rules in CONTRIBUTING.md; this is just what every PR needs to answer. -->

## 改了什么 / What changed

<!-- 一两句话。行为有变化的话,说清"之前怎样、现在怎样"。
     One or two sentences. If behaviour changes, state before → after. -->

## 为什么 / Why

<!-- 修哪个 bug、加哪个功能,关联 issue #xx。
     如果是从别处（外部报告、扫描器、AI 分析）拿到的结论,请说明你**验证了哪些、没验证哪些** ——
     本仓库处理过多份"作者自陈未核实"的清单,其中若干条的成因是错的。
     If this came from an external report or analysis, say which parts you verified yourself. -->

## 测试 / Testing

<!-- 项目有完整测试套件（当前 3900+ 断言）。请贴实际跑过的命令和结果。
     The project HAS a full suite (3900+ assertions today). Paste what you actually ran.

     export PATH=~/.local/share/mise/installs/node/24/bin:$PATH   # 发布门禁 / release gate
     npm run test:release          # 权威口径 / the authoritative gate
     node --import ./test/setup-env.mjs --test test/你的.test.js

     支持下限是 Node 22.13+（`test:summary` 自 22.10、免 flag 的 `node:sqlite` 自 22.13）。
     Node 20 已 EOL 且不再支持：它的 runner 不发 `test:summary`，两个 harness 自测会失败；
     `node:sqlite` 也不存在，4 条本地导入测试不会被收集。22.13+ 与 24.x 应全绿。
     Supported floor is Node 22.13+ (`test:summary` since 22.10, unflagged `node:sqlite` since 22.13).
     Node 20 is EOL and unsupported: its runner emits no `test:summary`, so the two harness
     self-tests fail, and `node:sqlite` is absent, so 4 import tests are not collected.
     On 22.13+ and 24.x the suite should be green. -->

## Checklist

- [ ] 代码风格和现有文件一致 / Code style matches existing files
- [ ] **没有引入 npm 运行时依赖** / No new npm runtime dependencies (project is zero-dep)
- [ ] **测试跑过了,贴了结果** / Tests run, output pasted above
- [ ] 新行为有测试,且**断言行为而不是 grep 源码文本** / New behaviour has tests that assert
      behaviour, not source text (the latter breaks on rename and misses real regressions)
- [ ] 新开关**默认关**;若默认开,已加进 `test/default-on-switch-registry.test.js` 台账
      / New switches default OFF; a default-ON switch is registered in the ledger test
- [ ] 加了开关就同步了文档 —— `.env.example`、`README.md`、`README.en.md`、
      `docs/ENV-SWITCHES.md`,守卫测试会逐个查
      / Switch documented in all four places (a guard test enforces this)
- [ ] 涉及 wire 协议改动时,注明字段号**来源**;未经实测的坐标默认关并在注释里直说不确定
      / For wire changes, cite the field-number source; unmeasured tags ship OFF and say so
- [ ] 涉及 dashboard UI 用 `App.confirm` / `App.prompt`,不用浏览器原生 alert/confirm
      / Dashboard UI uses App.confirm / App.prompt, not native dialogs
- [ ] commit message **没有任何 AI 署名尾注**（`Co-Authored-By`、`Generated with` 等）
      / No AI attribution trailers in commit messages
