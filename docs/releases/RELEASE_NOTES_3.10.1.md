# v3.10.1

三个硬化修复：**明文 http 图片默认拒**、**server-executed 工具类型显式 400**、**`glm-5-1` 拼写的路由与方言**。没有协议兼容性破坏（wire 270/270 vs v3.10.0）。

## 1. 明文 `http:` 图片 URL 默认拒（MITM 面）

远程 `image_url` 的字节会被内联进模型上下文（connect 的 proto `#10`、Cascade 的图片块）。此前 `validateImageUrl` 同时接受 `http:` 与 `https:`，链路上任何中间人都能替换这些字节。

- `src/image.js` `validateImageUrl` 默认只收 `https:`；`http:` 直接拒绝，错误消息点名逃生口。
- `WINDSURFAPI_ALLOW_HTTP_IMAGES=1` 只对**公网**主机恢复明文 http。私有/回环/链路本地地址无论开关如何都被 SSRF 策略拒绝（`safeLookup` 每跳校验），开关不能放宽它。读 `process.env`，精确 `=== '1'`。
- 每一跳都过同一检查：`fetchImageHop` 每次 redirect 重新 `validateImageUrl`，所以 `https → http` 降级同样被拒（有测试钉住）。
- 拒绝时 `log.warn` 只打 host（URL 可能带签名 query），图片丢弃、文本照发——与既有的 deadline/大小/MIME 失败同一条契约。
- 覆盖两条消费路径：connect 的 `inlineRemoteImages` 与 Cascade 的 `extractImages`。
- 文档：`README.md` / `README.en.md` 图片节、`.env.example`。

## 2. server-executed 工具类型：静默丢弃 → 显式 400

`/v1/responses` 此前对 `code_interpreter` / `image_generation` / `local_shell` / `shell` / `apply_patch` 走 catch-all `warn + return []`，`file_search` / `computer_use_preview` / `mcp` 静默丢弃。客户端声明了由服务器执行的工具却拿到正常回答——工具凭空消失，零信号。

- 8 个类型统一进 `UNBRIDGED_SERVER_SIDE_TYPES`，在**调用模型之前** 400，`code=unsupported_server_side_tool`，消息列出全部拒收类型。
- 复审补强：带日期后缀的版本化拼写（如 `code_interpreter_2025_03_11`）同样拒——剥掉 `_YYYY_MM_DD` 后回查集合，覆盖任何成员当前与未来的快照；非成员（`foobar_2025_03_11`）仍 warn+drop。
- 复审补强：namespace 的每个数组键都走一遍（`tools`/`children`/`functions`/`items`）——`{tools:[], children:[mcp]}` 这种双键形状此前会漏掉子项、静默丢工具。转发时的键选择未变（只改拒绝判定）。
- 四个位置都拦：顶层 `tools`、`input[].additional_tools`、namespace 子项、`tool_choice`（含 stream 与非 stream）。
- `{type:'function', name:'apply_patch'}` 是**客户端**工具，照常放行——只按 `tool.type` 判定，有反例测试。
- 真正未知的类型仍保留 warn + drop（未来类型无法枚举，不能一概 400）。
- 64 个新 400 用例；四个 responses mutation 基线按新增测试数重钉（只改数字，anchor 未动）。

## 3. `glm-5-1`：别名 + 方言两层

破折号拼写 `glm-5-1` 此前两层都错，且都静默：

- **路由**：`SELECTOR_MAP` 只有点号 `glm-5.1`。live catalog 下 `glm-5-1` 解析成 `{selector:null}` → 400 `model_not_found`；冷启动/快照回退时降级到免费档 `swe-1-6-slow`。补一行 `'glm-5-1': 'glm-5-2'`。
- **方言**：`pickToolDialect` 的 GLM 正则 `[2-9]` 不匹配 5.1 家族（点号形式归一化后同样不匹配），落 `glm47` XML markup——而 GLM-5.2 家族**忽略** glm47 markup，结果是纯文本回答、零 tool call、客户端永等（#236 卡死族的根因）。正则改 `(?:1|[2-9])`，边界保持（`-` 或结尾），`glm-5` / `glm-4.x` / `glm-5-12` 仍留 `glm47`。
- 反例测试钉住：`glm-5`、`glm-4.7`、`glm-4-7` 不变；Cascade 侧 `glm-5-1`/`glm-5-2` 的 uid 区分（`model-access.js`）未动。

## 门禁

（全部测于 `a317f0c`——复审修复合入后的最终树。）

- Windows `npm run gate`：**PASS**，`6,570 pass / 0 fail / 97 skip`（544 文件，6,667 tests；6 inert 文件声明）。
- Linux（HMC，Node v24.21.0）`npm run test:release`：**6,663 pass / 0 fail / 5 skip**（6,668 tests），最终树与两个前序 HEAD 各跑一次全绿；更早的一次（`b85fc10`）有 1 个失败，`detach-ls-pool-pressure` 的假 LS spawn 撞上 `EADDRINUSE 127.0.0.1:42100`（同轮更早还有 ENOSPC），单独复跑与之后三次全量均绿（`evidence/3101-pool-pressure-rerun.log`）。
- wire：对 `v3.10.0`（`3d26345`）比较 **270/270**，`base_head` 校验通过。
- mutation：**90/90 spec exit 0**（含本次新增/重钉的 `remote-image-inline`、四个 responses 规格）。首轮全扫时 `detach-p1-lease-deadline-addendum` 的基线测试在负载下时序 flake（`claim_deadline_during_delayed_first_trajectory_read...`，59 例中 1 例），空载复跑该 spec exit 0（M6c CAUGHT）；基线单跑 59/59。
- 三 lane 交叉干扰套件（10 文件 / 234 tests）全绿后才进全量门禁（`evidence/3101-crosslane-suite.log`）。

## 已知

- Linux 首跑时 `detach-ls-pool-pressure` 有一次假 LS spawn 失败（`LS process exited before ready`，同轮日志先有 `EADDRINUSE 127.0.0.1:42100`、更早有 ENOSPC）；单独复跑与随后三次全量均绿，非代码回归。
- 明文 http 被拒后，只有显式设 `WINDSURFAPI_ALLOW_HTTP_IMAGES=1` 才能用 http 图床。
- `code_interpreter` 等类型现在会 400：依赖"静默忽略"行为的客户端会开始收到错误——这是刻意的。
