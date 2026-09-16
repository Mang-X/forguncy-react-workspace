// 唯一需要按目标类库改写的地方：这里定义暴露给 ReactCellType 的公开门面。
// 规则：只导出用户真正需要的能力；不要直接返回 ESM module namespace（不可扩展）。
// 依赖 React 的类库请改用宿主 React 插件（见 references/build-strategies.md），不要打入第二份 React。
import * as Vendor from "__LIBRARY_ID__";
// 需要 CSS 时取消下一行注释，esbuild 会产出 css 输出并被 build.mjs 内联：
// import "__LIBRARY_ID__/dist/style.css";

const api = Object.assign(
  {},
  Vendor.default && typeof Vendor.default === "object" ? Vendor.default : {},
  Vendor
);
delete api.default;

// 默认导出是可调用函数时，改成转调函数并显式复制静态属性。

export default api;

