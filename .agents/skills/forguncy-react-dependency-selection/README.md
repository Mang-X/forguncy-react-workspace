# forguncy-react-dependency-selection

活字格 ReactCellType 的依赖选型与决策记录。把"Cell 需要某个能力"变成一条**有证据、可复核、可失效**的依赖决策，并记进 `fgc.lock.json`。

## 这个 skill 接住什么

- "Cell 里要做 X，用什么库？"——选型请求，包括只说"帮我评估这个库"。
- "这个库能不能在 Cell 里用 / 能不能 inline / 用 host 还是 inline"——策略判断。
- "React Router / zustand / redux / TanStack Query 能不能用"——归属边界问题。
- "多个 Cell 想共享同一个 QueryClient / 单例"——共享模块身份。
- "这个包的 Worker/WASM 风险 / 依赖 node:fs"——技术可行性。
- "决策记到 fgc.lock.json / 锁 stale 了要重测什么"——决策持久化与新鲜度。

## 这个 skill 不接什么

- 把某个**已选定**的库打包成活字格前端扩展包 ZIP——那是 `forguncy-frontend-library`。本 skill 在需要新扩展时**移交**给它，不重复实现打包逻辑。
- 活字格 .NET 插件（ServerCommand / CellType / ClientCommand / ServerAPI）。
- 普通 React/Vue 业务页面编码。
- 只解释机制、不产出决策的请求；总结或翻译。

## 架构位置

由这些 Spec 决定，本 skill 不重新定义它们：

- **#4** 应用归属边界与四种依赖策略。
- **#8** `fgc.lock.json`：决策如何持久化、如何失效。
- **#16** Agent 驱动的选型与实证 probe 协议；Skill/scripts 的职责划分。
- **#17** 确定性 probe 引擎（本 skill 调用它，不重写）。

脚本通过 `scripts/workspace-loader.mjs` 直接导入 `packages/core` 与 `packages/dependency-resolver` 的 TypeScript 源码，因此**策略常量只有一份**——改动上述 Spec 会立即反映到本 skill，不会留下会漂移的第二份副本。

## 职责划分

| 谁 | 做什么 |
|---|---|
| Agent（语义推理） | 判归属、研究候选、排队、权衡风险、定策略、写 rationale |
| scripts（确定性） | 测量（probe）、校验（audit）、持久化（record）、读回（status） |

脚本**从不**选策略、选替代包或判归属。`audit`/`record` 会拒绝一个不可记录的决策，而不是把它写进锁。

## 资产

- `SKILL.md`：触发与边界、硬规则、工作流、命令。
- `scripts/select_dependency.mjs`：`policy` / `probe` / `audit` / `record` / `status`。
- `scripts/workspace-loader.mjs`：Node resolve hook，让脚本按包名导入工作区 TypeScript 源码。
- `references/ownership-and-roles.md`：归属边界与三种角色的判断题。
- `references/candidate-research.md`：研究方式、信号、PDF 范例。
- `references/strategies-and-evidence.md`：策略语义、欠什么证据、target 语义。
- `references/decision-recording.md`：决策文件字段、锁、新鲜度。
- `references/report-and-handoff.md`：报告字段、本地/真机分开、移交给打包 skill。
- `evals/selection-cases.test.ts`：六个必需评测用例的**可执行**一半，进 CI。
- `evals/cli-contract.test.ts`：**CLI 级**回归测试，真正 spawn 脚本，覆盖证据可追溯、`--runtime-smoke` 可达性、conformance 门。
- `evals/execution_cases.json`：Agent 侧（语义）用例，供人工/Agent 复核。
- `evals/trigger_cases.json` + `evals/semantic_config.json`：路由评测（precision 1.0 / recall 1.0，阈值 0.30）。

## 关键选项

| 选项 | 作用 |
|---|---|
| `--project <dir>` | probe 该包的位置；必须是**已安装**它的目录 |
| `--no-cache` | 不读缓存里的旧 report（本次测量仍会作为**不可变证据**落盘） |
| `--runtime-smoke <module>` | 执行该本地模块作为 `runtime-smoke` hook；`validatedAgainstRuntime` 需要它 |
| `--runtime-smoke-export <name>` | 指定 hook 的导出名（默认 `default`） |
| `--extension-catalog <file>` | 用真实清单/已验证目录校验 `extension` 的 `libraryId`（两种输入 shape 不同，见 `references/decision-recording.md`） |

未知选项、以及需要值的选项缺值，都会直接 usage error——不会静默退回默认值。对验证型 CLI 这很关键：拼错 `--extension-catalog` 与漏写它落在同一个地方（使用默认目录），只报错才能让二者可分辨。

## 证据要跟锁一起提交

`record` 会把自己 cite 的 probe report 写到**锁旁边**的 `fgc-evidence/<content-hash>.json`。请把它与 `fgc.lock.json` 一起提交：

- 位置与 `.fgc/`（被 git 忽略）无关。放在那里等于全新 checkout 后锁的引用指向空气，而锁仍显示 `validated`。
- **只在决策被接受时写**：`probe`/`audit` 只测量并算出会被 cite 的地址，不写文件（`audit` 是 read-only 的，被拒绝的 `record` 也不该留下孤儿）。
- 按内容寻址，且**读取端会校验**：不同 report 不会互相覆盖；文件名就是内容断言，被误改/合并坏的文件会被报成 `alteredEvidence`（`evidence-integrity-mismatch`），而不是仅因路径存在就算通过。
- 校验的是 **canonical report** 而非 checkout 原始字节，所以 `core.autocrlf=true` 下 Git 把文件转成 CRLF **不会**被误判成篡改；真正的改动仍会被发现（先 parse，再按 canonical 内容比对）。
- `status` 会把 `evidence-missing`（引用不存在）与 `evidence-integrity-mismatch`（内容不符）都列入 `blockers`、以非零码退出——它不会在证据缺失或变样时继续说 fresh/validated。

## 用法示例

~~~text
Cell 里要预览 PDF，用什么库比较好？
~~~

~~~text
我想在 Cell 里用 zustand 管跨 Cell 的业务状态，可以吗？
~~~

~~~text
这个包依赖 node:fs，帮我评估一下，能换什么
~~~

~~~text
React 用 host 还是 inline？帮我定一下并把决策记下来
~~~

## 知识来源

- #16 的选型协议与信号表、#8 的锁契约、#4 的归属模型、#17 的 probe 协议，均以代码为准。
- 文档与实现冲突时以**实际 probe 与校验行为**为准，并修订对应参考件。

## 本地验证

~~~bash
node .agents/skills/forguncy-react-dependency-selection/scripts/select_dependency.mjs policy
pnpm vp test --run .agents/skills/forguncy-react-dependency-selection
~~~

`probe` 需要该包已安装在 `--project` 指向的目录（可用 `examples/probe-proving-cases`）。**本地检查不是活字格运行时兼容**：见 `references/report-and-handoff.md`。
