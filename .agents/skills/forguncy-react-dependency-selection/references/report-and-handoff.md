# 报告与移交

## 报告字段

一次选型结束时按这些字段报告。**本地检查与真机验证必须分开陈述**（AGENTS.md 规则 7）：绿的本地构建是 `local` 证据，不是 Forguncy 运行时兼容。

| 字段 | 内容 |
|---|---|
| 能力 | 用户要的能力，一句话 |
| 归属判断 | Forguncy / React island，以及依据的角色 |
| 分支 | `forguncy-owned`（提前结束）或 `react-island-owned` |
| 候选 | 研究的候选清单，各自观察到的信号 |
| 实测 | probe 的 `assessment` / `lockStatus`，外加 `facts` / `risks` / `validation` 摘要 |
| 策略 | `host` / `inline` / `extension` / `replace` 及理由 |
| 拒绝的理由 | 若 `replace`：架构拒绝还是技术拒绝，对应的 code 与机器观测到的发现 |
| 记录 | `fgc.lock.json` 里的记录、`freshness`、`blockers` |
| 本地证据 | 跑过什么本地检查 |
| 真机证据 | 跑过什么真机验证；**未执行就写"未执行"** |
| 未决 | 仍需用户决定或仍缺的证据 |

## 本地证据 vs 真机证据

- **本地**（本仓库可跑）：probe 的静态/构建设计步骤、`audit` 通过、锁写入并读回 fresh。
- **真机**（只能在真实 Forguncy 项目里）：宿主全局在页面执行后确实存在且是期望的对象；渲染/预览控制台无错误；跨 Cell 模块身份确实共享。

`runtime-smoke` 在本地工具链里是 `skipped`（无浏览器），带原因记录。不要把 skipped 说成通过。

## 何时移交给 `forguncy-frontend-library`

本 skill 只到**决策 + 证据**为止。以下情况决策可能是 `extension`，或需要把某个库做成前端扩展包：

- `extension` 策略需要一个新的前端扩展包（不只引用已验证的既有扩展）；
- 已决定的包需要打成 `manifest.json` + `bundle.js` + `types.d.ts` 三件套 ZIP 并上传。

此时移交**已安装的** `forguncy-frontend-library` skill 处理打包、静态校验、烟雾测试、打包 ZIP、上传与运行时验证。**不要在本仓库里复制扩展包打包逻辑，也不要重建它的校验脚本**——那是它的职责，重复实现会造出两份会漂移的打包规则。

移交时带上：包名与精确版本、来源、许可证、Probe 报告里的风险摘要（尤其 Worker/WASM/动态 import/资源）、以及本次的 `rationale`。对方 skill 的兼容性分析会消费这些。

## 生成报告里的 `probe` 引用怎么写

`record` 写进锁的 probe 链接形如 `fgc-evidence/<sha256>.json`——仓库相对路径，跨机器可复现（#8 禁止绝对机器路径）。报告里引用同一条路径，不要贴绝对路径。

它是按内容寻址的（report 字节的 sha256），与 #17 的 `.fgc/probe-cache/`（按 probe 输入寻址、可被同 fingerprint 的运行覆盖）是两回事。cite 前者：证据要的是"当初测到的那份"，不是"这个 fingerprint 现在会被当成什么"。

`fgc-evidence/` 与锁并列，**要一起提交**。它不在 `.fgc/` 下——那是被 git 忽略的，放那里等于全新 checkout 后锁的引用指向空气，而锁仍会显示 `validated`。
