# forguncy-frontend-library

活字格 ReactCellType 前端扩展包打包专家。把一个浏览器端 JavaScript 类库转换成可上传、可提示、可预览、可运行的前端扩展包，并给出可复核的验证证据。

## 这个 skill 接住什么

- 用户要求"为某个类库生成活字格前端扩展包"，包括只说"我想在活字格里用这个库"。
- 需要生成或修 manifest.json / bundle.js / types.d.ts 三件套，或打标准 ZIP。
- 扩展包排障：CodeEditor 无补全、预览报全局变量不存在、Invalid hook call、CSS 丢失、包超限、覆盖上传后行为未更新。
- 更新已上传的扩展包（保持 id、提升 version、overwrite: true）。

## 这个 skill 不接什么

- 活字格 .NET 插件开发（ServerCommand / CellType / ClientCommand / ServerAPI / Middleware）。
- 普通前端页面与 Vue/React 业务代码。
- 只解释机制、只给方案、只总结或翻译输入文档。

## 资产

- scripts/scaffold_package.mjs：生成骨架，两种模板：`--template package`（默认，单包工作目录）、
  `--template monorepo`（多包仓库：packages/<id> + tooling/pack-tools + pnpm workspace + vp + git-cliff）。
- scripts/validate_package.mjs：通用静态校验，对齐平台 ZIP/Manifest/大小/编码/types 脚本模式限制。
- scripts/smoke_bundle.mjs：通用烟雾闸门（全局创建、幂等、冲突拒绝、宿主全局未替换、CSS Marker 唯一）。
- scripts/pack_package.mjs：跨平台打包标准 ZIP（三条目 + 大小 + SHA-256，字节可复现）。
- references/：Manifest 与限制、构建策略、types 与 Monaco、本地验证与打包、上传与集成、验收清单、常见失败、参考案例、报告与请求模板。
- assets/package-template/：单包工作目录模板（package.json / pnpm-workspace.yaml / build.mjs / src/entry.js / validate|smoke|pack.mjs / README）。
- assets/monorepo-template/：多包仓库模板（packages/<id>/{src,scripts,tests}、tooling/pack-tools、
  templates/package 成员骨架、pnpm-workspace.yaml、cliff.toml、CI）。

## 知识来源

活字格 ReactCellType 前端扩展包生成指南（AI 执行规范），21 节，1176 行。产品实现与文档冲突时以实际校验和运行行为为准，并修订对应参考件。

## 用法示例

~~~text
给 three.js 做一个活字格前端扩展包，版本 0.180.0，产物目录 /Users/mang/Project/three-forguncy。
~~~

~~~text
CodeEditor 里 ReactThreeFiber. 没有补全，帮我看看 types.d.ts。
~~~

~~~text
我要在一个仓库里维护多个活字格前端扩展包，第一个包是 three.js 0.180.0，全局名 ReactThreeFiber。
~~~

