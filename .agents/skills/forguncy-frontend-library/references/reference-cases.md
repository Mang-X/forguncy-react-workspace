# 参考案例

来源：指南第 16 节。这两个案例代表两类最容易出错的场景。

## React Three Fiber：复用宿主 React

关键不是把厂商包目录整体压缩，而是建立清晰的宿主边界：

- 把 @react-three/fiber 和 three 打入同一个 Bundle。
- 把 react、react-dom、react-dom/client 映射到 ReactCellType 已提供的 React 和 ReactDOM。
- 初始化时检查宿主 React 版本和 ReactDOM.createRoot。
- 暴露新的全局门面，例如 ReactThreeFiber，门面中同时提供 R3F API 和经过确认的 THREE。
- ReactCellType 代码使用 ReactThreeFiber.Canvas，不能再导入模块。
- 3D 验证不能只检查 DOM；还要确认 Canvas 尺寸、非背景像素、动画/交互以及控制台错误。

如果还需要 @react-three/drei，优先与 Fiber、Three 一起打入同一个自包含包，不要创建依赖另一个扩展包先加载的独立 Drei 包。打包前检查 Drei 使用的额外字体、模型、环境贴图、Worker 和 JSX runtime。

## SpreadJS：隔离宿主 GC

宿主和目标库使用相同全局命名空间时，先分析厂商代码如何访问全局对象：

- 如果模块只通过词法变量 var GC 共享状态，把所有厂商模块按依赖顺序放入一个私有 IIFE。
- 在私有作用域中捕获最终 GC 对象，并只把它导出为 SFGC。
- 执行前保存宿主 globalThis.GC 的对象引用，执行后恢复并断言引用完全相同。
- 把主题 CSS 作为字符串内嵌，并使用唯一 Style Marker 注入。
- 类型声明只在确认语义后把命名空间适配到 SFGC，不能盲改压缩 JavaScript。
- 功能烟雾测试创建 Workbook、写入数据、计算一个确定公式，并同时断言 GC !== SFGC。

结论：全局隔离的正确性必须由"宿主对象未改变"和"新 API 的真实功能可用"共同证明。

## TanStack Query：非可视化 React 状态库

这类库没有 DOM 容器、没有 Canvas，看起来"很好打"，实际风险全在 React 身份与 Provider 边界上。

- 只安装 `@tanstack/react-query` 即可：它内部 `export * from "@tanstack/query-core"`，
  再单独引 query-core 会造成重复打包与门面命名冲突。
- 厂商 ESM 产物同时 import `react` 与 `react/jsx-runtime`。`react` 映射到 `globalThis.React`
  就够，`react/jsx-runtime` **必须写适配器**，且注意 key 参数陷阱（见 build-strategies.md 第 3 节）。
- 该库在**模块求值阶段**就调用 `React.createContext`。所以宿主 React 缺失时必须**明确抛错**，
  而不是懒加载兜底；wrapper 里的顺序是：冲突/幂等检查 → 宿主 React 存在与版本断言 → 执行 bundle。
- Provider 边界是真实约束：ReactCellType 每个单元格是独立 React 子树，hooks 只能在本单元格自己渲染的
  Provider 之下工作。门面里给一个共享单例 Provider（跨单元格共享缓存）是常见需求，但要作为**可选项**，
  并把"是否跨单元格共享同一份缓存"当作用户决策写进 description。
- 类型声明工作量大：厂商 d.ts 是重度泛型 + 模块导入。`declare namespace` 必须重新包装，
  不能把 `import` / `export =` 原样搬进 types.d.ts。第一版宁可精确覆盖高频 API 并**显式声明裁剪了什么**，
  也不要 `declare const X: any` 冒充完整类型。
- 验证要点：vm 闸门 + 真实 React `renderToString` 渲染 Provider 子树 + query-core 行为断言
  （fetchQuery 确定值、setQueryData 往返、invalidate、hashKey、dehydrate、cancelQueries 触发
  AbortSignal、unsubscribe 停通知、clear 清空缓存）。

### 加装持久化插件（同一类的第二个决策点）

要加 `@tanstack/query-persist-client-core` / `react-query-persist-client` /
`query-async-storage-persister` 时：

- **不要拆成独立扩展包。** 持久化核心本身是框架无关的（它接收 `queryClient` 实例作参数），
  但 `PersistQueryClientProvider` 必须拿到 react-query 的 `QueryClientProvider` / `IsRestoringProvider`
  上下文；独立成包要么依赖另一个包先加载，要么自带一份 react-query 从而产生第二套 Context
  与第二个 `QueryClient` 类。两个方向都是坏的。
- 验证过：并入同一个包后导出名**零重叠**（react-query 59 个导出 vs 持久化 10 个），加上去只涨约 8 KB。
- 只用 `@tanstack/react-query-persist-client` 即可，它已 `export * from "@tanstack/query-persist-client-core"`；
  存储适配器按需再加，两者都要求显式传入 `storage`，模块作用域不访问 `window.localStorage`
  （唯一一处 `localStorage` 出现在 JSDoc 示例里），因此加载期不会因缺少存储而抛错。
- 厂商行为必须写进 description，否则使用者会误判为"没生效"：
  restore + subscribe **不会**在恢复后主动写一次；写入默认节流 1000ms；
  `gcTime` 必须大于 `maxAge`；`buster` 变化会丢弃旧数据。
- 共享单例场景要自己提供"只恢复一次、只订阅一次"的入口：厂商 Provider 每个实例各恢复订阅一次，
  而 ReactCellType 每个单元格都是一个独立子树。用 `persistQueryClientRestore` +
  `persistQueryClientSubscribe` 组合，配合 `useSyncExternalStore` 把 restored 状态下发给 React。
- 验证要点：命令式往返（跨 client 恢复确定值、maxAge 过期、buster 不匹配、节流后回写、
  detach 后停止回写）+ 真实端到端（jsdom + `react-dom/client` + `act`：
  首屏 restoring 为真 → 异步翻转为假 → DOM 出现持久化数据 → 回写 → 卸载清理）。
  厂商 Provider 路线与本包共享单例路线**两条都要测**。

