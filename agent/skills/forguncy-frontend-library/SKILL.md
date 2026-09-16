---
name: forguncy-frontend-library
description: 活字格 ReactCellType 前端扩展包打包专家。把一个浏览器端 JavaScript 类库（厂商 UMD/IIFE、仅
  ESM/CJS、React 组件库、Canvas/WebGL、Worker/WASM）转换成活字格可上传的扩展包 ZIP（manifest.json +
  bundle.js +
  types.d.ts），并完成构建、静态校验、烟雾测试、打包、上传与设计器/运行时验证。当用户说"给某个类库做活字格前端扩展包""把这个库打包成活字格扩展库""把这个类库放进
  ReactCellType""生成前端扩展包 ZIP""上传/更新前端扩展包""为什么 CodeEditor 提示不到这个全局变量"，或提到
  frontendLibraries、globalName、bundle.js、types.d.ts、FrontendLibraryPackage、活字格前端库、扩展包全局名冲突时，必须使用。即使用户只说"我要在活字格里用
  xxx 这个库"也应触发。不用于：活字格 .NET 插件开发（ServerCommand / CellType / ClientCommand /
  ServerAPI）、普通网页或 Vue/React 业务代码、只解释机制不产出包、总结或翻译本指南。
---
# 活字格 ReactCellType 前端扩展包打包专家

## 触发与边界

接：为某类库生成或更新前端扩展包（含只说"想在活字格里用这个库"）；生成/修 manifest.json、bundle.js、types.d.ts；打标准 ZIP；扩展包排障（CodeEditor 无补全、预览报全局变量不存在、Invalid hook call、CSS 丢失、包超限、覆盖上传未生效）。
不接：活字格 .NET 插件（ServerCommand / CellType / ClientCommand / ServerAPI / Middleware）；类库自身功能开发与普通前端业务代码；只解释机制、只给方案、只总结或翻译。

## 硬规则（不可违反）

| 规则 | 原因 |
|---|---|
| bundle.js 是经典脚本，无顶层 import/export 与运行时 import() | 平台按 script/全局 eval 执行并同步检查 globalName |
| 执行后立即在 globalThis 上创建与 manifest.globalName 同名的属性 | 平台在脚本执行后同步检查，不能延迟到异步 |
| globalName 只能是单个合法标识符，且不得占用宿主保留名 | Manifest 校验会拒绝 |
| ZIP 根目录只放 manifest.json、bundle.js、types.d.ts，不许多包一层 | 多余条目不会被部署 |
| ZIP ≤ 16 MiB，解压总和 ≤ 16 MiB，manifest ≤ 64 KiB，bundle ≤ 8 MiB，types ≤ 4 MiB，条目 ≤ 20 | 平台硬限制 |
| 三个文本文件严格 UTF-8 | 上传校验 |
| types.d.ts 保持脚本模式：顶层不得有 import、export =、export default、export {} | export = 会把 declare namespace 关进模块，CodeEditor 失去补全 |
| React 类库复用宿主 React/ReactDOM，不打入第二份 | 否则 Hook / Context / 版本身份冲突 |
| CSS 与静态资源内联进 bundle.js | ZIP 里的额外文件不会成为运行时资源 |
| 不依赖另一个扩展包先加载 | 预览并行加载，顺序不保证 |
| 版本固定，禁止 latest / *；内容变更必须提升 version | 可复现与缓存正确性 |
| 未运行验证不得宣称包可用，报告区分"已验证"与"未执行" | 避免假阳性交付 |

## 工作流

1. 兼容性分析（先做，别急着写代码）：类库名、准确版本、来源、许可证、目标能力范围；能否成为浏览器端单文件经典脚本；检查动态 import、chunk、Worker、WASM、字体图片、宿主全局冲突、体积。结论三选一：可打包 / 有条件可打包 / 不适合当前机制。不适合时给阻断证据 + 最小平台扩展建议，然后停止。
2. 锁定来源与版本：只用官方或用户指定来源；用 pnpm 固定版本并提交 pnpm-lock.yaml；保留许可证要求的版权声明。
3. 选构建策略：按 references/build-strategies.md 的决策表选厂商 UMD / esbuild IIFE / React 宿主复用 / 全局隔离，并写明理由。
4. 建包工作目录：不要在 Forguncy 仓库里放 node_modules 或中间产物；用 scripts/scaffold_package.mjs 生成骨架。
   只做一个包 → `--template package`（单包工作目录）；要长期维护多个包 → `--template monorepo`
   （packages/<id> + tooling/pack-tools + pnpm workspace + vp 任务编排 + git-cliff）。
5. 生成三件套：manifest.json、bundle.js、types.d.ts；types 必须反映真实门面，不得用 any 降级冒充完整类型。
6. 静态校验：跑 scripts/validate_package.mjs（结构、编码、大小、Manifest 规则、保留名、bundle 经典脚本解析、types 脚本模式、globalName 声明）。
7. 烟雾测试：先跑 scripts/smoke_bundle.mjs 通用闸门，再针对该类库写最小功能测试；DOM/Canvas/WebGL 必须用真实浏览器。
8. 打包：跑 scripts/pack_package.mjs 生成 ZIP，记录大小与 SHA-256。
9. 上传与运行时验证（仅在允许 MCP 时）：上传 → listFrontendLibraries 校验元数据 → 建验证页引用 → 生成页面 → 浏览器确认控制台 Error 为 0 → 确认 referenceCount；见 references/upload-and-integrate.md。
10. 最终报告：按 references/report-and-request.md 的字段输出，无法执行的环节写"未执行"。

## 必须先向用户确认或直接拒绝

- Node.js 专用库、原生扩展、依赖文件系统或进程 API。
- 无法消除的动态 import、代码分割、运行期 chunk、必须从 ZIP 读取额外文件。
- 强依赖 Service Worker、跨源隔离、特殊响应头或服务器路由。
- 许可证禁止再分发、打包或嵌入的商业库。
- 单文件或类型声明超限且无法裁剪功能；与宿主全局无法隔离冲突。
- 处置：给出具体阻断原因与可选改造方向，绝不交付"能上传但跑不起来"的 ZIP。

## 资产与参考件

- scripts/scaffold_package.mjs：生成骨架，两种模板二选一：
  - `--template package`（默认）→ 渲染 assets/package-template：单包工作目录，package.json / pnpm-workspace.yaml / build.mjs / src/entry.js / validate|smoke|pack.mjs / README。
  - `--template monorepo` → 渲染 assets/monorepo-template：多包仓库，packages/<id>/{src,scripts,tests} + tooling/pack-tools + templates/package（成员骨架）+ pnpm-workspace.yaml + cliff.toml + CI；
    第一个包由 `--id/--global/--version` 播种，后续用生成物里的 `vp run new-package <id>` 加包。
    复制时会**原样**保留 tooling/ 与 templates/（它们的代码本身就写着占位符，渲染会改坏源码）。
- scripts/validate_package.mjs：通用静态校验，对齐平台硬限制。
- scripts/smoke_bundle.mjs：通用 vm 烟雾闸门（全局创建、幂等、冲突拒绝、宿主全局未替换、CSS Marker 唯一）。
- scripts/pack_package.mjs：跨平台确定性 ZIP（三条目 + 大小 + SHA-256），替代指南中仅 Windows 的 pack.ps1。
- references/manifest-and-limits.md：加载模型、ZIP 契约、manifest 字段规则、保留名、大小限制、description 当 AI API 文档。
- references/build-strategies.md：厂商 UMD / esbuild IIFE / React 宿主复用 / 全局隔离 / CSS 与资源 / Worker 与 WASM，含插件模板。
- references/types-and-monaco.md：types.d.ts 三种方案、禁止项、Monaco 验证要点。
- references/verify-locally.md：validate 口径、pack 脚本、类库专用烟雾测试九项检查。
- references/upload-and-integrate.md：上传与覆盖、ReactCellType 引用写法、CodeEditor/AI 验证、完整 MCP 流程、删除前置条件。
- references/acceptance-checklist.md：只有全部勾选才能报告"包已完成"。
- references/failure-modes.md：常见失败现象 → 根因 → 处置。
- references/reference-cases.md：React Three Fiber（复用宿主 React）与 SpreadJS（隔离宿主 GC）两个案例。
- references/report-and-request.md：最终报告字段、可直接交给 AI 的请求模板、指南维护检查项。
- evals/trigger_cases.json：触发/非触发样例，用于回归本技能的触发边界。

## 输出契约

- 交付：manifest.json + bundle.js + types.d.ts + 标准 ZIP（绝对路径、大小、SHA-256）+ 构建/校验脚本 + 验证报告。
- 报告字段：兼容性结论、类库与版本、来源与许可证、构建策略、包 ID、全局变量、ZIP 绝对路径、各文件大小与 SHA-256、包含与未包含能力、宿主依赖、ReactCellType 最小用法、静态/设计时/运行时验证结果、已知限制。
- 没做到的环节写"未执行"，不写"应该可用"。
