# types.d.ts 与 Monaco 智能提示

来源：指南第 8 节。types.d.ts 有两个目标：通过上传校验，以及在 ReactCellType CodeEditor 的 Monaco 中提供真实可用的智能提示。

## 平台接受的全局声明形式

- declare const / declare let / declare var / declare class / declare function / declare namespace <GlobalName>
- export as namespace <GlobalName>（仅用于 UMD 类型）

types.d.ts 会作为独立的 Monaco extra lib 注入 JavaScript 语言服务。除 export as namespace <GlobalName> 外必须保持脚本（script）模式，顶层禁止：

- import ...
- export = <GlobalName>
- export default ...
- export { ... }

其中 export = <GlobalName> 是最容易误加的错误：它会把 declare namespace <GlobalName> 限制在模块内部。服务端"包含全局声明"的正则可能仍通过上传校验，但用户在 CodeEditor 输入 <GlobalName>. 时不会得到补全。推荐直接写全局声明，不要在文件末尾追加 export = 适配语句。

~~~typescript
declare namespace VendorLibrary {
  function create(host: HTMLElement): VendorLibrary.Instance;
  interface Instance {
    destroy(): void;
  }
}
~~~

## 最佳方案：为公开门面生成准确声明

~~~typescript
interface VendorLibraryInstance {
  destroy(): void;
  setData(data: unknown[]): void;
}

interface VendorLibraryApi {
  readonly version: string;
  create(host: HTMLElement, options?: Record<string, unknown>): VendorLibraryInstance;
}

declare const VendorLibrary: VendorLibraryApi;
~~~

只声明实际暴露且验证过的 API。不要把未打包模块留在类型提示里，否则 AI 会生成运行时不存在的代码。

## 复用厂商声明

必须先做到：

- 把所有依赖声明打成单文件，或确保文件内模块声明自洽。
- 消除 Monaco 无法解析的相对 import。
- 使用 export as namespace <GlobalName> 或额外的全局适配声明。
- Bundle 裁剪了功能就同步裁剪类型声明。
- 修改了厂商全局名就用类型 AST 或受控规则修改声明，并检查旧全局名不再泄漏。

完整 UMD 类型常见写法：

~~~typescript
export as namespace VendorLibrary;
export function create(host: HTMLElement): Instance;
export interface Instance {
  destroy(): void;
}
~~~

## 最低降级方案

只有找不到可用声明、且用户明确接受没有智能提示时才使用：

~~~typescript
declare const VendorLibrary: any;
~~~

这只保证 Monaco 不报"找不到名称"，不满足智能提示目标。必须在最终报告中明确标记该降级，不能假装类型支持完整。

## 类型验证要点

- 声明中存在 globalName。
- types.d.ts 是脚本模式：无顶层 import、export =、export default、export {}；若使用 export as namespace，已在 Monaco 中验证全局可见。
- 没有旧的冲突全局名，没有无法解析的模块引用。
- 最小 ReactCellType 示例在 checkJs 模式下无语义错误。
- Monaco 能提示至少一个核心 API。
- 类型声明不超过 4 MiB。

