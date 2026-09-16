// esbuild 插件：把 react / react-dom / react/jsx-runtime 全部映射到宿主全局。
//
// 活字格的 ReactCellType 已经提供 globalThis.React 与 globalThis.ReactDOM，
// 扩展包再打第二份 React 会造成 Hook / Context 版本身份冲突（Invalid hook call）。
//
// 关键陷阱：自动 JSX runtime 把 children 放在 props 里，key 是第三个独立参数。
// 直接写 React.createElement(type, props, key) 会踩雷——即使 key 为 undefined，
// createElement 也会因为"传了第三个实参"而把 props.children 覆盖成 undefined，
// 表现为组件渲染成空字符串。必须在 key 为 undefined 时只传两个参数。
const jsxRuntimeAdapter = [
  "var React = globalThis.React;",
  "function jsx(type, props, key) {",
  "  return key === undefined ? React.createElement(type, props) : React.createElement(type, props, key);",
  "}",
  "module.exports = { Fragment: React && React.Fragment, jsx: jsx, jsxs: jsx, jsxDEV: jsx };"
].join("\n");

const defaultHostModules = {
  react: "module.exports = globalThis.React;",
  "react-dom": "module.exports = globalThis.ReactDOM;",
  "react-dom/client": "module.exports = globalThis.ReactDOM;",
  "react/jsx-runtime": jsxRuntimeAdapter,
  "react/jsx-dev-runtime": jsxRuntimeAdapter
};

const FILTER = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/;

export function createHostReactPlugin(options = {}) {
  const hostModules = { ...defaultHostModules, ...(options.hostModules || {}) };
  return {
    name: "react-cell-type-host-react",
    setup(buildContext) {
      buildContext.onResolve({ filter: FILTER }, args => ({
        path: args.path,
        namespace: "react-cell-type-host"
      }));
      buildContext.onLoad({ filter: /.*/, namespace: "react-cell-type-host" }, args => ({
        contents: hostModules[args.path],
        loader: "js"
      }));
    }
  };
}
