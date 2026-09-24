# 候选研究与排队

来源：Spec #16（选型偏好、probe 协议、Skill/scripts 边界）。信号清单与族语义由 `node scripts/select_dependency.mjs policy` 输出。

## 研究方式

候选要**查当前的**，不能凭记忆认定。一个包今天的分发形态、导出条件、是否需要 Worker/WASM，都可能与印象不符。

研究范围至少覆盖：官方文档与 npm 元数据（`exports` / `module` / `browser` / `main` / `peerDependencies`）、许可证、最近维护情况、是否有官方的 Vite 集成说明。

`probe` 的 `export-metadata` 与 `package-identity` 两步会把这些元数据变成事实，所以"文档说支持浏览器"要在 probe 里落实成 `main`/`exports` 指向浏览器入口。

## 三类信号

`policy` 输出里每个信号都带 `observedFrom` 与 `observedByProbeSteps`——**哪个 probe 步骤能观测它**是查出来的，不是猜的。

### 正面信号（缩小范围，不是证明）

browser-first / ESM-first 分发、一等 Vite 入口、自带 TypeScript 声明、面向 UI 的高层 React API、无 Node 内置模块、自包含运行时资源、维护活跃且许可证可接受。

**"ESM" 是正面信号，不是兼容证明。** 一个纯 ESM 包仍可能 `new URL('x.wasm', import.meta.url)` 或起一个 Worker。正面信号只把候选排到前面，结论仍由 probe 出。

### 风险信号（要实测，不是自动拒绝）

Worker / SharedWorker、WASM、`new URL(..., import.meta.url)`、运行期 `fetch()` 包内资源、动态 import / 代码分割、CSS/字体/图片、Portal 到 `document.body`、WebGL/Canvas 生命周期、全局单例假设。

风险唯一正确的处置是**测量并权衡**。把"这个包有 Worker"直接说成"不支持"，就是把应该测量的东西变成了判词。

### 替换信号（拒绝候选）

Node 文件系统/进程/网络/原生扩展、只有 SSR/服务端假设而无浏览器构建、要求 Service Worker／跨源隔离／特殊响应头、应用路由/认证/全局 store 归属冲突、生成体积超目标约束、运行期资源无法内嵌或经所选路径表达。

每个替换信号映射到一个技术拒绝 code（`policy` 输出的 `replacementRejections`）。`audit` 会检查记录的理由**确实**来自观察到的发现，而不是随便一个失败。

## 排队

按正面信号排先后，写清每个候选被偏好的**理由**。不要只给一个候选就进 probe：`replace` 要有已评估的替代项，而且"替代项更差"是允许写本地修复的唯一条件。

## 范例：PDF 查看器

**不要因为 `pdfjs-dist` 出名就默认选它。** #16 的 PDF 范例明确要求：

1. 比较高层的现代浏览器/React 方案（EmbedPDF 一类），而不是直接下沉到低层库；
2. 实测它们真实的 WASM / Worker / 资源行为；
3. 选**在活字格里部署路径最简单且已验证**的那个。

同一条推理适用于 3D（Three.js 及其运行时资源与生命周期）、编辑器、地图：知名 ≠ 合适。低层库通常把 Worker/WASM/资源编排的负担留给使用者，高层方案往往已经处理好——功能等价时优先高层。

参考已验证的 Worker/WASM 风险案例：`examples/probe-proving-cases` 里的 `@embedpdf/pdfium`（4.6 MB `pdfium.wasm`，经 `new URL('pdfium.wasm', import.meta.url)` 解析）。probe 对它会报出 `wasm` 与 `import-meta-url-asset` 风险但**不拒绝**——这正是"风险要权衡"的样板。
