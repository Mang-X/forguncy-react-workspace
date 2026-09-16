# Manifest、加载模型与硬限制

来源：活字格 ReactCellType 前端扩展包生成指南 第 3、4 节。当前实现是经典脚本（UMD/IIFE 风格）扩展机制，不是 ES Module 加载机制。

## 加载链路

1. 用户或 AI 上传标准 ZIP。
2. 活字格校验 Manifest、Bundle、类型声明、大小和冲突。
3. bundle.js 被复制到工程 UserFile 下的 FrontendLibraries/<id>/bundle.js。
4. ReactCellType 通过 frontendLibraries: [{ libraryId: "<id>" }] 声明引用。
5. CodeEditor 把所选包的 types.d.ts 注入 Monaco JavaScript 类型系统。
6. CodeEditor 和设计器预览通过全局 eval 执行 Bundle，并检查 globalName 是否存在。
7. 运行时按引用携带的文件路径加载 Bundle，使用 SHA-256 SRI 校验新格式包，并在加载后检查 globalName。
8. ReactCellType 代码直接访问 Manifest 声明的全局变量。
9. CodeEditor AI 助手得到类库的显示名称、globalName 和 description，据此生成代码。

## 由加载模型得到的硬规则

- 最终 bundle.js 是经典脚本；不得有顶层 import / export 或无法内联的动态 import()。
- Bundle 执行后必须立即在 globalThis/window 上提供与 manifest.globalName 完全一致的属性。
- globalName 只能是单个 JavaScript 标识符，不能是 Foo.Bar。
- 包应自包含；除明确复用宿主的 React/ReactDOM 外，依赖都应打进同一 Bundle。
- CSS 和静态资源必须由 bundle.js 注入或内联；ZIP 中额外文件不会成为运行时可访问资源。
- 修改 Bundle 内容必须提升版本；运行时 URL 携带完整性摘要或版本作为缓存键，同版本覆盖不应作为热更新机制。

## ZIP 契约

ZIP 根目录只包含三个文件：

~~~text
manifest.json
bundle.js
types.d.ts
~~~

不要放在子目录，不要把 dist 目录本身压进 ZIP。平台允许最多 20 个条目，但只读取并部署上述三个标准文件，多余条目只占配额。

## 大小限制

| 对象 | 限制 |
|---|---:|
| ZIP 文件 | 16 MiB |
| ZIP 解压后所有条目总和 | 16 MiB |
| manifest.json | 64 KiB |
| bundle.js | 8 MiB |
| types.d.ts | 4 MiB |
| ZIP 条目数 | 20 |

三个文本文件都必须是严格 UTF-8。产品版本变化时，读该版本的 FrontendLibraryPackageService，或以实际上传错误为准。

## manifest.json 字段

~~~json
{
  "schemaVersion": 1,
  "id": "vendor-library",
  "name": "Vendor Library for ReactCellType",
  "version": "1.2.3",
  "globalName": "VendorLibrary",
  "description": "Use VendorLibrary directly without import/export. ..."
}
~~~

| 字段 | 规则 |
|---|---|
| schemaVersion | 必须是数字 1 |
| id | 稳定 ID；字母开头，只含字母数字点下划线短横线；最长 64；不能以点结尾 |
| name | 必填；最长 128；不能含控制字符；工程内显示名不允许重复 |
| version | 合法 SemVer，例如 1.2.3、1.2.3-beta.1 |
| globalName | 单个合法 JavaScript 标识符，例如 THREE、ReactThreeFiber、SFGC |
| description | 必填；最长 20000 字符；同时是 CodeEditor AI 助手的使用说明 |

额外约束：

- id 首段不能是 Windows 设备保留名：CON、PRN、AUX、NUL、COM1..COM9、LPT1..LPT9。
- id 和 name 不能使用内置预设库保留名 AntDesign、ECharts（大小写不敏感）。
- globalName 不能是 JavaScript 保留字。
- globalName 不能使用宿主保留名：$, jQuery, React, ReactDOM, Babel, Forguncy, GC, antd, echarts, dayjs, ForguncyReactHelper, ReactCellTypeAntDesignZhCN, ForguncyAIAssistant, ReactCellTypeCodeEditor, forguncyWebBrowserBridge, MonacoEnvironment, define, require。
- 工程中其他扩展包不能使用相同 name（大小写不敏感）或相同 globalName。
- 更新已有包时保持 id 不变、提升 version，并使用 overwrite: true 上传。

## 把 description 当成 AI API 文档

description 不是市场文案，它决定 CodeEditor AI 是否知道如何使用类库。至少包含：

1. 唯一全局变量和禁止 import/export 的说明。
2. 包含的模块和明确未包含的模块。
3. 主要 API 路径和最小可运行示例。
4. 宿主依赖，例如"复用 ReactCellType 的 React 19"。
5. DOM 容器、尺寸、异步初始化等前置条件。
6. React useEffect 初始化和 cleanup 规则。
7. 版本号、兼容范围和重要限制。

推荐格式：

~~~text
<Library> <version> for ReactCellType. Use the global <GlobalName> directly; never use import or export.
Included: <capabilities>. Not included: <omissions>.
Dependencies: <host dependencies or none>.
React usage: create a sized host element, initialize in React.useEffect, and call <dispose API> in cleanup.
Minimal example: <one-line API example>.
Important constraints: <async/worker/license/performance notes>.
~~~

描述应短而具体，不要粘贴整份厂商 API 文档，也不要只写"某某类库"。

