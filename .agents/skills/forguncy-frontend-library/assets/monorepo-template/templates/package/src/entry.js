// 对外门面：bundle 执行完后，这个模块的默认导出会挂在 globalThis.__GLOBAL_NAME__ 上。
// TODO: 汇总目标类库的公开 API。
//
// 约束（见 docs/project-layout.md 与技能硬规则）：
//   - 这里 import 的每个包都必须在 package.json 的 dependencies 里显式写死版本（pnpm 不做扁平提升）；
//   - React 类库不要引入第二份 React：运行时会被映射到宿主 globalThis.React / ReactDOM；
//   - 不要在模块作用域发请求或执行副作用：这类代码在脚本求值阶段就会生效，且每个单元格都会跑一遍。
export default {
  id: "__LIBRARY_ID__",
  version: "__VERSION__"
};
