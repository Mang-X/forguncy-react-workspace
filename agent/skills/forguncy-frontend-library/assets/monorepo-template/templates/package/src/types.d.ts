// 手写的门面声明。必须保持"脚本模式"：顶层不得有 import、export =、export default、export {}，
// 否则 declare namespace 会被关进模块作用域，活字格 CodeEditor 就失去了全局补全。
// TODO: 反映 src/entry.js 的真实门面，不要为省事用 any 降级冒充完整类型。
declare namespace __GLOBAL_NAME__ {
  const id: string;
  const version: string;
}
