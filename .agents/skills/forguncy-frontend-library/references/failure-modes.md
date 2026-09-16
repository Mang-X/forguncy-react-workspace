# 常见失败与根因

来源：指南第 18 节。排障时先按现象定位，再改；不要靠"重新压一次 ZIP"碰运气。

## 上传提示缺少标准文件

根因通常是 ZIP 多包了一层目录。打开 ZIP 后必须直接看到三个文件。

## 上传提示 types.d.ts 没有声明全局变量

类型文件仍是纯 ESM 模块声明，没有 declare const/namespace 或 export as namespace。

## CodeEditor 找不到全局变量

- ReactCellType 没有添加 frontendLibraries 引用。
- types.d.ts 的全局名与 Manifest 不一致。
- 类型声明中存在未解析 import，导致声明失效。
- types.d.ts 末尾追加了 export = <GlobalName>，使 declare namespace <GlobalName> 变成模块内部声明。删除该语句并重新验证 Monaco 补全。

## CodeEditor 有提示但预览报全局变量不存在

- Bundle 没有真正写入 globalThis[globalName]。
- 原始 UMD 在运行时走了 AMD/CommonJS 分支。
- Bundle 异步加载全局变量，但平台在脚本执行后立即检查。
- 全局名大小写不一致。

## 设计时正常、运行时失败

- 设计时会临时禁用 AMD，运行时普通脚本没有相同保护。
- 依赖了只存在于设计器窗口的对象。
- 使用了相对资源路径，运行时目录不同。
- 更新后没有重新生成或浏览器仍有旧缓存。

## Invalid hook call / Context 不工作

包内打入了第二份 React，或类库与宿主 React 版本不兼容。必须 externalize 到宿主 React 并验证 peer dependency。

## CSS 丢失、字体或图片 404

ZIP 里的额外文件没有被部署，或 CSS 中仍有相对 url(...)。把资源内联为 Data URL。

## 多个扩展包偶发初始化失败

一个扩展包依赖另一个扩展包先加载。CodeEditor 预览可能并行加载多个扩展包，这种依赖不可靠。合并成一个自包含包，或改为对宿主全局的惰性解析并提供明确 ready。

## 覆盖上传后仍看到旧行为

- Bundle 内容变化但版本没有提升，版本标记跳过重复初始化。
- 工程没有重新生成，页面元数据仍携带旧版本或旧完整性摘要。

正确做法：提升版本、覆盖上传、重新生成并刷新页面。

## 持久化"看起来没生效"

按顺序排查。**前两条不是缺陷，是最常见的误判**：

1. `persistQueryClient` / 共享单例式挂载只做"恢复 + 订阅"，**恢复完成后不会主动写一次**。
   存储里为空是正常的，首次落盘发生在缓存第一次变化时。想立刻验证就手动改一次缓存。
2. 写入被节流：`createAsyncStoragePersister` / `createSyncStoragePersister` 默认
   `throttleTime = 1000ms`。改完立刻读存储通常读不到，必须等一个完整节流周期。
3. `gcTime` 小于持久化 `maxAge`：缓存条目在能被落盘前就被回收，表现为"数据时有时无"。
   `gcTime` 必须大于 `maxAge`。
4. `buster` 不匹配或数据超过 `maxAge`：恢复时被判定失效并调用 `removeClient`，
   表现为"存储里明明有数据却没恢复"。持久化结构变化时必须递增 `buster`。
5. 存储写入抛错（配额满、隐私模式）：未配置 `retry` 时该次写入被丢弃，且只在非生产构建告警。
6. 共享单例场景下在每个单元格各挂一个 Provider：重复恢复、重复订阅，表现为存储被反复覆盖。
   要么只用一个 Provider，要么用 `attachSharedPersistence` 让它幂等。

## 只跑了 vm 烟雾测试就宣称"可用"

不渲染的测试覆盖不到 JSX 适配器、Hooks 顺序和 Provider 上下文，也不执行 `useEffect`。
于是"恢复完成后 isRestoring 翻转""订阅是否真的挂上"这类行为**根本不会被执行**，
测试全绿但功能是坏的。

React 类库必须再跑一次真实端到端：真实 React + 真实 DOM（jsdom）+ `react-dom/client` + `act`，
断言首屏状态、异步翻转、DOM 文本、回写与卸载清理。渲染可能留下调度器句柄，
脚本结尾显式 `process.exit()`。

## 把"可选功能"拆成依赖另一个扩展包的独立包

给已达标的包增加功能（持久化、导出、主题等）时，不要新建一个"依赖基础包先加载"的扩展包：

- 违反"不依赖另一个扩展包先加载"（预览并行加载，顺序无保证）。
- 若新包为了自包含再打一份基础库，会得到**两份库身份**：两个 React Context、
  两个 `QueryClient` 类，`instanceof` 与 Provider 上下文全部错位，报错点还很隐蔽。

正确做法：**并入同一个包并提升版本**。评估拆分前先算体积：多数可选插件只有几 KB。

## Bundle 超过 8 MiB

1. 只导入用户需要的模块。
2. 使用生产构建和 minify。
3. 移除 sourcemap、示例、locale 和未使用插件。
4. 检查是否错误打入 React、ReactDOM 或重复依赖。
5. 裁剪类型声明到实际公开 API。
6. 仍超限时报告平台限制，不要静默删除关键功能。

