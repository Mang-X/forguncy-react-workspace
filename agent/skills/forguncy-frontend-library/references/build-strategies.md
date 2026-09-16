# 构建策略

来源：指南第 5、6、7 节。按下面的顺序决策，并在报告里写明为什么选它。

## 1. 厂商已提供可靠的浏览器全局构建

只有同时满足以下条件才直接采用厂商 UMD/IIFE：

- 浏览器执行后稳定设置一个全局变量。
- 不需要额外 chunk、CSS、Worker、WASM、字体或图片，或这些资源可以内联。
- 不会因页面存在 AMD define 而走错 UMD 分支。
- 不会覆盖活字格已有全局变量。
- 文件体积满足限制。
- 许可证允许再分发。

即使采用厂商文件，也要加一层自己的安装 Wrapper：冲突检测、版本标记、重复加载保护、CSS 注入、最终全局变量检查。

不要假定"文件名含 umd"就一定安全。设计时预览会临时禁用 AMD，运行时普通 script 加载不保证替你禁用 AMD，必须在真实运行时验证。

## 2. 只有 ESM/CommonJS：esbuild 生成 IIFE（默认推荐）

1. 用 pnpm 安装固定版本依赖，并提交 `pnpm-lock.yaml`。
2. 写一个很小的 src/entry.js，只导出需要的 API。
3. esbuild 使用 bundle: true、format: "iife"、platform: "browser"。
4. 禁止 code splitting 和 sourcemap。
5. CSS 和小型静态资源内联。
6. 在外层 Wrapper 中安装唯一全局变量。

entry.js 要点：不要直接返回 ESM module namespace（不可扩展，无法写版本标记），而是构造可扩展门面对象：

~~~javascript
import * as Vendor from "vendor-library";

const api = Object.assign(
  {},
  Vendor.default && typeof Vendor.default === "object" ? Vendor.default : {},
  Vendor
);
delete api.default;

export default api;
~~~

如果默认导出本身是可调用函数，创建转调函数并显式复制需要的静态属性，不要无差别导出内部 API。

## 3. React 类库：复用宿主 React

React 类库不能再打入一份 React/ReactDOM，否则会出现 Hook、Context、Renderer 或版本身份冲突。把以下包映射到宿主全局对象：

- react -> globalThis.React
- react-dom -> globalThis.ReactDOM
- react-dom/client -> globalThis.ReactDOM

esbuild 插件（加入 plugins 数组）：

~~~javascript
const hostModuleSources = {
  react: "module.exports = globalThis.React;",
  "react-dom": "module.exports = globalThis.ReactDOM;",
  "react-dom/client": "module.exports = globalThis.ReactDOM;"
};

const hostReactPlugin = {
  name: "react-cell-type-host-react",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^(react|react-dom|react-dom\/client)$/ },
      args => ({ path: args.path, namespace: "react-cell-type-host" })
    );
    buildContext.onLoad(
      { filter: /.*/, namespace: "react-cell-type-host" },
      args => ({ contents: hostModuleSources[args.path], loader: "js" })
    );
  }
};
~~~

还必须检查依赖是否引用 react/jsx-runtime 或 react/jsx-dev-runtime。不能简单把它们指向 React；需要使用与宿主版本兼容的 JSX runtime 适配器，或选择已编译成 React.createElement 的厂商构建。构建前读 peerDependencies，Bundle 初始化时做版本断言。

**JSX runtime 适配器（必写，且有一个致命陷阱）**：

~~~javascript
const jsxRuntimeAdapter = [
  "var React = globalThis.React;",
  "function jsx(type, props, key) {",
  "  return key === undefined ? React.createElement(type, props) : React.createElement(type, props, key);",
  "}",
  "module.exports = { Fragment: React && React.Fragment, jsx: jsx, jsxs: jsx, jsxDEV: jsx };"
].join("\n");

const hostModuleSources = {
  react: "module.exports = globalThis.React;",
  "react-dom": "module.exports = globalThis.ReactDOM;",
  "react-dom/client": "module.exports = globalThis.ReactDOM;",
  "react/jsx-runtime": jsxRuntimeAdapter,
  "react/jsx-dev-runtime": jsxRuntimeAdapter
};
~~~

陷阱：**自动 JSX runtime 把 children 放在 props 里，key 是独立的第三个参数**。若写成
`React.createElement(type, props, key)`，即使 key 是 `undefined`，"传了第三个实参"也会让
`createElement` 把 `props.children` 覆盖成 `undefined`——Provider 之类的组件会静默渲染成空字符串，
既不报错也不抛异常。必须像上面那样在 `key === undefined` 时只传两个参数。

这个陷阱**无法被 vm 烟雾测试发现**（不渲染就不会调用 jsx），必须用真实 React 渲染一次才能暴露。
验证方法：在宿主安装真实 `react` / `react-dom`，用 `renderToString` 渲染一个
`<Provider><Child/></Provider>` 子树，断言输出 HTML 非空且包含子组件内容。

除 React/ReactDOM 这类明确宿主依赖外不要随意 externalize：外部依赖不会自动加载。

## 4. 全局命名冲突

厂商使用宿主已占用的全局变量（例如活字格内置 SpreadJS 使用 GC）时，必须分配独立 globalName（例如 SFGC）。按优先级：

1. 源码/模块级导出适配（最安全）。
2. 词法作用域隔离：厂商只使用 var GC 时放进私有 IIFE，执行后捕获私有对象再导出为 SFGC。
3. 临时全局捕获并恢复：厂商必须写 window.GC 时，先保存宿主值，在受控环境执行，捕获新值并恢复宿主，确认厂商不是原地修改宿主对象。
4. AST 级重写：必须改写显式全局访问时使用解析器/AST 转换并验证所有引用。

禁止对压缩 JavaScript 做全局字符串替换（例如把所有 GC 替换成 SFGC），它可能破坏字符串、属性、局部变量、许可证文本或其他标识符。

隔离测试必须保存原始对象引用并断言加载后引用完全相同：

~~~javascript
const original = globalThis.GC;
// 执行 bundle.js
if (globalThis.GC !== original) {
  throw new Error("Bundle changed the host GC namespace.");
}
if (!globalThis.SFGC) {
  throw new Error("Expected SFGC global was not created.");
}
~~~

## 5. CSS、图片、字体和其他资源

运行时只自动加载 bundle.js。正确策略：

- 把 CSS 编译结果作为字符串内嵌进 bundle.js。
- Bundle 执行时创建带唯一 data-forguncy-frontend-library 标记的 style。
- 重复加载先查标记，避免重复插入。
- 图片、SVG、字体尽量转 Data URL。
- 审计 CSS 中所有 url(...)，确保没有相对路径指向不存在的 ZIP 文件。
- 不要默认依赖公网 CDN：设计器、离线部署、CSP 或内网可能访问不到。

~~~javascript
function ensureStyle(documentObject, libraryId, cssText) {
  if (!documentObject || !cssText) return;
  var selector = 'style[data-forguncy-frontend-library="' + libraryId + '"]';
  if (documentObject.querySelector(selector)) return;
  var style = documentObject.createElement("style");
  style.setAttribute("data-forguncy-frontend-library", libraryId);
  style.textContent = cssText;
  (documentObject.head || documentObject.documentElement).appendChild(style);
}
~~~

## 6. Worker、WASM、动态 chunk

- Worker：源码内联为字符串，通过 Blob 和 URL.createObjectURL 创建；验证 CSP 是否允许 blob:。
- WASM：转 Base64 或 Uint8Array 内联；全局 API 必须立即存在，用 ready: Promise 暴露异步初始化状态。
- 动态 chunk：关闭 code splitting，合并为单文件。
- import()：必须在构建阶段消除，最终 Bundle 不能再发起模块加载。

异步初始化时 description 必须告知 AI：

~~~javascript
React.useEffect(() => {
  let disposed = false;
  GlobalLibrary.ready.then(() => {
    if (!disposed) {
      // 使用类库
    }
  });
  return () => { disposed = true; };
}, []);
~~~

## 7. 安全、信任与许可证

前端扩展包不是安全沙箱：bundle.js 与活字格页面同上下文执行，能访问页面 DOM、网络、全局对象和页面可访问的数据。机制假定上传者是受信任的应用开发者，但仍必须做供应链审查：

- 只用官方或用户明确指定的来源，记录准确版本和下载位置。
- 检查许可证是否允许打包、修改和再分发，保留要求保留的版权/许可证注释。
- 检查 pnpm-lock.yaml 与实际安装版本，避免依赖漂移。
- 审计安装脚本、远程请求、遥测、动态代码执行和敏感数据访问。
- 审计 Bundle 创建的所有全局变量：除声明的 globalName 和有意的 CSS Marker 外不应泄漏临时全局。
- 不接受普通终端用户上传任意 Bundle；若产品未来开放给非受信任用户，需要独立进程/源、CSP、权限和审核模型。

## 8. 推荐工作目录

不要把包管理器缓存、node_modules 或中间产物放进 Forguncy 仓库：

~~~text
<package-workdir>/
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  build.mjs
  validate.mjs
  src/entry.js
  dist/manifest.json
  dist/bundle.js
  dist/types.d.ts
  <id>-<version>.zip
~~~

最终只交付 ZIP，同时保留构建脚本、锁文件和验证结果，保证以后可升级版本。

### pnpm 的两个硬约束

- **必须放行 esbuild 的构建脚本。** pnpm 10.3 起 `strictDepBuilds` 默认开启，依赖的 pre/postinstall 一律不执行，未审查的构建会让 install 以 `ERR_PNPM_IGNORED_BUILDS` 退出。esbuild 的 postinstall 负责生成 `node_modules/esbuild/index.js`，被跳过时 `build.mjs` 会直接 `ERR_MODULE_NOT_FOUND`。配置只认 `pnpm-workspace.yaml` 里的 `allowBuilds` 映射（pnpm 11 已移除 `onlyBuiltDependencies`）：

  ~~~yaml
  allowBuilds:
    esbuild: true
  ~~~

  新增任何带 install 脚本的依赖（原生模块、字体/图标包等）都要显式加一行 `true` 或 `false`；未列出的包默认拒绝。

- **提交 lockfile 并用 `--frozen-lockfile` 复现。** 首次 `pnpm install` 生成 `pnpm-lock.yaml`，之后重装用 `pnpm install --frozen-lockfile`。若厂商库对扁平 node_modules 有解析假设，可在 `pnpm-workspace.yaml` 设 `nodeLinker: hoisted` 退回 npm 式布局。

