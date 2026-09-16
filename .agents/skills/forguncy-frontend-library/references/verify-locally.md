# 本地静态校验、烟雾测试与打包

来源：指南第 9、10、11 节。静态校验不能证明库可用，必须配合类库专用烟雾测试。

## 静态校验口径

用 scripts/validate_package.mjs（本技能自带，参数：--dist 目录）。它必须覆盖：

- manifest.json 只有 description、globalName、id、name、schemaVersion、version 六个键。
- schemaVersion === 1；id 匹配 ^[A-Za-z][A-Za-z0-9._-]{0,63}$ 且不以点结尾；id 首段不是 Windows 设备保留名。
- version 是合法 SemVer；globalName 匹配 ^[A-Za-z_$][A-Za-z0-9_$]*$，不是 JS 保留字，不是宿主保留名。
- name 非空且 ≤ 128、无控制字符；description 非空且 ≤ 20000；id/name 不是 antdesign、echarts。
- manifest ≤ 64 KiB，bundle.js ≤ 8 MiB，types.d.ts ≤ 4 MiB。
- types.d.ts 中存在 declare const/let/var/class/function/namespace 或 export as namespace <globalName>（用词边界，避免前缀误命中）。
- types.d.ts 无顶层 import、export =、export default、export {}。
- bundle.js 无顶层 import/export、无 import( 动态导入。
- bundle.js 能被 new vm.Script(bundleText) 按经典脚本解析（不要受 package.json "type": "module" 影响）。
- 输出 manifest、各文件字节数和 SHA-256。

动态 import 的文本扫描是保守规则：若只在字符串或注释里误命中，用 JavaScript AST 确认不存在真正的 ImportExpression，而不是盲删厂商内容。平台上传仍是最终校验边界，本地通过后也必须实际上传验证。

## 打包

用 scripts/pack_package.mjs（跨平台，macOS/Linux/Windows 通用）生成 ZIP。要求：

- 三个文件位于 ZIP 根目录，条目名排序后恰好为 bundle.js、manifest.json、types.d.ts。
- ZIP ≤ 16 MiB；解压后条目大小总和 ≤ 16 MiB。
- 记录 ZIP 大小与 SHA-256 并写入报告。

指南原文给出的 Windows pack.ps1 等价实现见本技能脚本；如果环境只有 PowerShell，可保留 pack.ps1 作为替代。

## 类库专用烟雾测试（必须，至少九项）

1. Bundle 在模拟浏览器或真实浏览器中执行无异常。
2. globalThis[manifest.globalName] 存在。
3. 核心构造器/函数存在。
4. 重复执行同一版本不会重复初始化或重复注入 CSS。
5. 全局名已被其他对象占用时，Bundle 明确失败且不覆盖原对象。
6. 被保护的宿主全局对象引用在加载前后完全相同。
7. CSS Marker 存在且只出现一次。
8. 最小功能得到确定结果，例如公式为 500、图表 Canvas 非空、3D 场景有非背景像素。
9. 创建的实例可以正确销毁，监听器、动画帧、Observer 和 WebGL 资源得到清理。

scripts/smoke_bundle.mjs 是可复用的通用闸门，覆盖第 1、2、4、5、6、7 项。第 3、8、9 项必须针对具体类库编写。

### 通用闸门的两个附加能力

`--preload <file>`：在创建 vm 上下文**之前**注入宿主全局。参数是 ESM 模块，默认导出
`(sandbox) => void`。React 类库必须用它补充 React / ReactDOM，否则 bundle 会因宿主全局缺失而在
求值阶段直接抛错（这是设计行为，不是测试环境问题）。例：

~~~bash
node scripts/smoke_bundle.mjs --dist dist --preload ./react-stub.mjs
~~~

沙箱已内置浏览器常用 Web API（`AbortController`、`AbortSignal`、`URL`、`queueMicrotask`、
`crypto`、`TextEncoder/Decoder`、`addEventListener/removeEventListener`），以及一个记录式
的 `document`。vm 新上下文只有 ECMAScript 内建，缺这些会让浏览器类库在测试里假失败。

闸门还会断言"除 globalName 外没有向 window 泄漏新全局"。

### 渲染型类库的额外要求

只跑 vm 闸门**不足以**验证 React 类库：不渲染就不会走到 JSX 适配器和 Hooks 路径，
适配器缺陷会被完全掩盖。按下面两级递进：

**第一级：真实 React 同步渲染（必做，成本低）**

- 在包工作目录安装真实 `react` / `react-dom`（devDependency，不进交付物）。
- 把真实 React 注入沙箱；用 `react-dom/server` 的 `renderToString` 渲染
  `<Provider><Child/></Provider>`。
- 断言输出 HTML 非空、包含子组件文本、Hooks 状态正确（例如 `status === "success"`）、
  共享 Context 传到了子组件。

**第二级：真实 DOM + 副作用（凡插件涉及 useEffect / 异步初始化就必须做）**

`renderToString` **不执行 `useEffect`**，所以恢复缓存、订阅、异步初始化这类行为它一律覆盖不到。
需要装 `jsdom`，并注意：

- `react-dom` 必须在 `window` / `document` 就位**之后**再加载，因此用动态 `import()`。
- Node 的 `globalThis.navigator` 是只读 getter，要用 `Object.defineProperty` 覆盖；
  `window` / `document` / `HTMLElement` / `Element` / `Node` 同理一次性注入。
- 必须设置 `globalThis.IS_REACT_ACT_ENVIRONMENT = true`，用 `react` 的 `act` 包住
  `createRoot().render()` 与后续等待。
- 用真实 `localStorage`（jsdom 的 `window.localStorage`）而不是内存替身，让持久化真的落盘。
- 断言链要包含：首屏状态 → 异步状态翻转 → DOM 文本 → 数据回写 → 卸载无异常 → 显式清理。
- 恢复在第一次 `render` 的 `act` 窗口之外才 resolve 时会打印 "not wrapped in act" 警告。
  这是测试装置现象，可在脚本里过滤并计数，不要当成失败，也不要据此改产品代码。
- React 调度器与 query-core 的 `gcTime` 定时器会保活事件循环，脚本结尾必须
  `process.exit(failures.length ? 1 : 0)`，否则表现为"跑完不退出"。

对 DOM/Canvas/WebGL 类库，优先使用真实浏览器测试：只用 Node vm 无法发现布局、CSS、Canvas、WebGL 或资源 URL 问题。

