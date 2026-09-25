---
name: forguncy-react-dependency-selection
description: 活字格 ReactCellType 的依赖选型与决策记录专家。当一个 Cell 需要外部能力（工具库、图表、PDF/3D 查看器、编辑器、地图、请求缓存、状态库、路由）而你要决定"用哪个库、以 host / inline / extension / replace 哪种方式进入 Cell、并把这次决策记进 fgc.lock.json"时使用。触发词包括：选型、选个库、用哪个库、评估这个库、这个库能不能用、某个库的许可证与维护情况、能不能 inline、用 host 还是 inline、要不要做 extension、要不要换库、React Router / zustand / redux / TanStack Query 能不能用、PDF 查看器用什么、3D 查看器用什么、依赖探测 probe、这个包的 Worker/WASM 风险、fgc.lock.json、锁过期 stale / 记录决策、跨 Cell 共享单例。用户只说"我想在 Cell 里做 X，用什么好""帮我评估这个库"也应触发。不用于：把某个已选定的库打包成活字格前端扩展包 ZIP（用 forguncy-frontend-library）、活字格 .NET 插件开发、纯业务页面编码、只解释机制不产出决策、总结或翻译。
metadata:
  author: Yao Team
  mode: production
---

# 活字格 React 依赖选型与决策记录

## 这个 skill 干什么

把一个"Cell 需要某个能力"的请求，走完 **#16 的选型流程**：先把能力判给 Forguncy 或 React island，再研究候选、排队、用**确定性 probe 实测**、决定 `host` / `inline` / `extension` / `replace`，最后记进 `fgc.lock.json`。

它产出**决策 + 证据**，不产出扩展包。真正需要新扩展包时，把打包交给已安装的 `forguncy-frontend-library`（见 `references/report-and-handoff.md`）。

## 硬规则（不可违反）

| 规则 | 原因 |
|---|---|
| 先判归属，再看任何包 | 归属是能力的属性，不是包的属性。反过来做，任何包都能以"未分类"填进宿主角色，Cell 里就会长出第二个路由或第二份业务状态 |
| 归属判给 Forguncy 时**立即停止**，不研究、不排队、不 probe | 架构冲突的修法在宿主侧，没有任何替代包能解决；probe 一个包来发现"这属于宿主"是把 ownership-first 反过来执行 |
| 不得仅凭文档/README 宣称兼容 | 现代 ESM 包也可能藏 Worker / WASM / 运行期资源；只有**执行过的**确定性 probe 才算证据（AGENTS.md 规则 6） |
| 候选别扭时优先 `replace`，不要先写适配器 | #16 第一条验收标准就是"正常运作不需要按包名维护 adapter 注册表"；有注册表就会让每个不兼容包都像"待办" |
| 本地构建绿 ≠ 活字格运行时兼容 | AGENTS.md 规则 7：本地检查与真机验证必须分开报告；`target` 只能由真实页面确认后填写 |
| 策略变更必须留 rationale，并链接证据 | `extension` 与 `replace` 在 #4 下需要书面理由；PR diff 要能解释策略选择 |
| 不要把 `ESM` 当作兼容证明 | 它是正面信号，只能缩小候选范围，不能替代实测 |

## 工作流

1. **判归属**（Agent）：按 `references/ownership-and-roles.md` 判这个能力属于 Forguncy 还是 React island。
   - Forguncy 所有 → 直接产 `replace` + 归属评估自带的架构拒绝，跳到第 6 步。**不研究包。**
   - React island → 继续。
2. **研究候选**（Agent）：找当前可用的候选，按 `references/candidate-research.md` 的信号偏好排序。不要凭记忆认定知名包就是最优。
3. **排队**（Agent）：正面信号只缩小范围、不是证明；风险信号要实测，不是假定坏掉。
4. **实测 probe**（脚本）：对候选跑确定性 probe，拿到 `facts` / `risks` / `validation` / `environment`。probe 只测量，不决定策略。
5. **定策略**（Agent）：按 `references/strategies-and-evidence.md` 在 `host` / `inline` / `extension` / `replace` 中选一个，理由必须由 probe 证据支撑。
6. **记录并校验**（脚本）：`audit` 校验决策，`record` 写入 `fgc.lock.json`；不可记录的决策会被拒绝而不是写进去。

## 命令

脚本从工作区源码读取策略（不复制常量），因此改动 #4/#8/#16/#17 会立即反映到本 skill。

```bash
S=.agents/skills/forguncy-react-dependency-selection/scripts/select_dependency.mjs

# 1) 取选型面：阶段与权限、两条分支、信号族、验收标准、目标版本
node $S policy

# 2) 实测一个已安装的候选包（只测量，不给策略）
#    --cell 取 forguncy.config 里该 Cell 声明的 codeBudgetCharacters 作为**估算**上限；
#    --imports 声明 Cell 会具名导入的绑定，让估算偏向"下"。两者都进指纹。
node $S probe --project examples/probe-proving-cases es-toolkit
node $S probe --project <projectRoot> --cell <cellId> --imports debounce es-toolkit

# 3) 校验一个决策文件（只报问题，不做决定）
#    --project 是 probe 该包的位置；架构拒绝不 probe，可省略
#    决策文件里写了 cellTarget，就不必再传 --cell；写了 imports 同理，两处不一致会被拒绝
node $S audit --project <projectRoot> --decision decision.json

# 4) 校验后写入 fgc.lock.json；audit 不通过则拒绝写入
node $S record --project <projectRoot> --decision decision.json

# 注意：probe 只给出尺寸**估算**（band + 与 cap 的比较），任何情况下都不产生
# cell-artifact-budget-exceeded。硬上限判定属于编译器对该 Cell 的 codeBudgetCharacters
# 诊断——probe 的构建图与真实编译不同，合成候选可能比真实 Cell 更大。
# 决策文件里的 imports 与 cellTarget 写法见 references/decision-recording.md。

# 5) 读回锁并报告每条记录是否仍然有效
node $S status --project <projectRoot>
```

真机已验证过的决策要写入 `target` 时，必须传一个本地 hook 让 `runtime-smoke` 真的执行：

```bash
# hook.mjs: export default () => ({ facts: [...], risks: [...] });
node $S record --project <projectRoot> --runtime-smoke ./hook.mjs --decision decision.json
```

`extension` 决策会被拿去和已验证扩展目录比对；用真实清单覆盖默认目录：

```bash
node $S record --project <projectRoot> --extension-catalog listing.json --decision decision.json
```

`audit` 与 `record` 跑**同一套**检查，凡是 `record` 能靠**读取**判定并拒绝的条件都在其中：

1. conformance —— 这条记录是否**真实**（`libraryId` 等是否来自已验证目录）；
2. 候选锁自身的 validation —— 这份文档是否**可接受**（`writeFgcLock` 会执行的那套，含 #8 对 `extension`/`replace` 的 rationale 要求）；
3. 证据路径 preflight —— 将要 cite 的 `fgc-evidence/<hash>.json` 若已存在，其字节必须与本次 report 一致（不存在则没问题，`record` 会创建）。

因此 `audit` 说 `recordable: true` 而 `record` 却拒绝的情况不会发生——否则就等于告诉调用者「可以写了」。所有问题汇总在同一个 `problems` 字段里。

决策文件由 **Agent** 产出，脚本从不代填。字段与示例见 `references/decision-recording.md`。

## 环境要求

- Node ≥ 24（仓库 `engines`）；脚本用 Node 的类型剥离直接跑工作区 TypeScript，无构建步骤。
- probe 需要一个**已安装**该包的 project root：`--project examples/probe-proving-cases`（含 `es-toolkit`、`@embedpdf/pdfium`）或你自己的示例目录。没安装的包 probe 会拒绝启动——probe 描述的是真实产物。

## 资产与参考件

- `scripts/select_dependency.mjs`：确定性半边——`policy` / `probe` / `audit` / `record` / `status`。测量、校验、持久化；**从不**选策略、选替代包或判归属。
- `scripts/workspace-loader.mjs`：Node resolve hook，让脚本按包名导入 `packages/*` 的 TypeScript 源码，避免把策略常量抄成第二份。
- `references/ownership-and-roles.md`：归属边界、四种角色、平台冲突规则、三条必须教会的判断（路由 / 跨 Cell 状态 / 远程数据）。
- `references/candidate-research.md`：研究方式、正面/风险/替换信号、PDF 类"不要盲目选知名包"的范例。
- `references/strategies-and-evidence.md`：四种策略的语义、各自欠什么证据、repair recipe 的三个条件。
- `references/decision-recording.md`：决策文件字段、`fgc.lock.json`、新鲜度与何时重测。
- `references/report-and-handoff.md`：报告字段（本地/真机分开）、何时移交给 `forguncy-frontend-library` 打扩展包。
