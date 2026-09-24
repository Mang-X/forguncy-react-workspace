# 策略与证据

来源：Spec #4（策略语义）、#8（证据 profile 与新鲜度）、#16（何时 replace 而非适配）。策略语义由 `node scripts/select_dependency.mjs policy` 输出的 `strategies` / `evidencePolicy` 给出。

## 四种策略

| 策略 | 含义 | 是否需要 rationale | 真机必验 |
|---|---|---|---|
| `host` | 源码 import 映射到宿主已有的全局；不打包 | 否 | 是 |
| `inline` | 打进生成的 Cell 产物，自包含 | 否 | 是 |
| `extension` | 由活字格前端扩展提供，Cell import 其全局 | **是** | 是 |
| `replace` | 候选不适合本目标，记录拒绝并换方案 | **是** | 否 |

`inline` 是兼容的 browser-first 库的**默认**。`extension` 只在共享模块身份 / 跨 Cell 单例 / 有意的项目级复用 / 实测体积经济学需要时才选。

## 每种策略欠什么证据

`evidencePolicy` 把决策分成三个 profile，各欠不同的 probe 结果：

- **`resolved-dependency`**（`host` / `inline` / `extension`）：`probeRequirement: "passed"`。欠一个**通过**的 probe：所有 deployment-required 步骤都通过，且没有任何发现取消候选资格。
- **`architectural-rejection`**（`replace` + 架构拒绝）：`probeRequirement: "none"`。证据是归属决策本身，**不欠 probe**。
- **`technical-rejection`**（`replace` + 技术拒绝）：`probeRequirement: "not-passed"`。拒绝必须落在一条**机器观测到的**发现上——光有失败不足以证明是你写的那个原因。

deployment-required 步骤（`policy` 输出的 `probeDeploymentRequiredSteps`）：`package-identity`、`export-metadata`、`node-builtin-scan`、`build`、`artifact-scan`、`asset-inventory`、`runtime-pattern-scan`、`size`。

注意 `runtime-smoke` **不在**其中：本地无浏览器时它是 `skipped` 且带原因，`assessProbeReport` 仍可判 `supports-deployment`。

## 何时 `replace`，而不是写适配器

#16 第一条验收标准就是"正常运作**不需要**按包名维护 adapter 注册表"。有注册表，每个不兼容包都会看起来像一项待办任务；没有注册表，别扭的候选只能走 `replace`——这正是 #16 想施加的压力。

**顺序**：先评估替代方案 → 仍不合适才考虑本地修复。

### 本地 repair recipe 的三个条件（必须同时成立）

1. **能力仍然有价值**：确有一个 Cell 真的需要它。没有需求就没有可投入的对象。
2. **替代方案明显更差**：已评估过替代项，并在 API 契合度 / 运行时复杂度 / 维护性上更差。**这一条才是在"修复"与"替换"之间做决定的**——单独看，前一条几乎总是成立。
3. **修复可被验证**：能用执行过的本地或真机检查证明它工作。未验证的修复与"放弃但保留依赖"无法区分，也无法作为证据记进锁。

三者缺一即被拒绝（`evaluateRepairRecipe`）。`audit` 会执行这个判断。

## 记录里的 `target`：本地 probe 必须留 null

两个字段都叫 target，混用就是 AGENTS.md 规则 7 要禁止的事：

- `ProbeEnvironment.target` = probe **以哪个活字格契约作为测量基准**。引擎默认填 #5 已核实的身份，所以纯本地静态运行它也是非 null。
- `LockRecordMetadata.target` = 证据**在哪个真实运行时里被验证过**。#8 称之为"the runtime claim"；它是否存在，决定 `assessLockDecision` 报 `validated` 还是 `not-validated`。

把前者抄进后者，就等于把一次绿的本地构建冒充成人没做过的运行时兼容声明。因此 `record` 默认写 `target: null`；只有决策文件显式声明 `validatedAgainstRuntime: true`、且 probe 的 `runtime-smoke` 步骤**真的通过**时才会填。skipped 的 smoke 步骤不是确认。

## 别忘了 `host` 的真实要求

`host` 的 `realRuntimeRequired` 为真，且要求：

- 宿主在目标版本里**确实**把这个模块暴露成全局；
- 模块身份与宿主共享（React、Context 等单例仍是单例）；
- 依赖的 peer 范围与宿主提供的版本兼容。

`host` 是 React/ReactDOM 这类已文档化的宿主全局的答案。第二份打包副本会破坏身份（hooks、Context、`instanceof`）——这正是 `host` 存在的理由。
