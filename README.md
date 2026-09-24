# Forguncy React Workspace

面向**活字格 ReactCellType** 的现代 React / TypeScript / Vite+ 工程化工具链。

> **活字格负责“应用”，React 负责“单元格内的 UI”。**  
> Forguncy owns the application. React owns the island.

## 为什么做这个项目

活字格的 React 单元格让复杂前端能力进入低代码页面成为可能，但它的运行和依赖模型与普通 React 工程并不相同。开发者和 Coding Agent 很难直接获得常规 React 项目中的模块组织、npm 依赖、TypeScript、共享源码、测试和构建体验。

本项目希望把 **ReactCellType 视为部署目标，而不是主要开发环境**：

```text
普通 React / TypeScript / Vite+ Workspace
                  ↓
            Forguncy 工具链
                  ↓
      ReactCellType 可消费的产物
                  ↓
                活字格
```

目标是让开发者和 Coding Agent 尽可能按照正常的现代 React 项目方式工作，再由工具链处理活字格特有的运行时与部署约束。

## 核心原则

### 活字格负责应用

以下能力应优先由活字格提供：

- 页面与应用导航
- 页面 / 全局业务状态
- 数据源
- 服务端命令与业务流程
- 权限
- 页面生命周期
- 跨 React 单元格通信

### React 负责单元格内 UI

React 单元格更适合承载：

- 复杂组件与交互
- 表单与局部状态
- 图表、地图、Canvas / WebGL / 3D
- 拖拽、动画、虚拟列表
- 富文本、代码编辑器、PDF / 媒体查看器等浏览器 UI 能力

项目不会尝试在 React 单元格里重新实现一套应用路由、全局业务 Store、权限系统或数据层。

## 本地开发（`vp dev`）

在活字格里同步一次才能看到一次 UI 改动，反馈太慢。因此项目提供一个**很薄的本地开发环境**：它把 Cell 的源码当作普通 React 挂载，用 Vite+ 的 HMR 提供反馈。

```bash
cd examples/dev-harness
vp dev
```

无需任何 flag、无需 wrapper 脚本 —— 这也是 #22 的 Developer workflow 与 #23 第一条验收标准的写法。

它做的事情只有三件：

1. 从 `forguncy.config.ts` 读出 Cell 的 `entry` 与 `fixture`，把 `entry` 挂载成一个 React root；
2. 把 `fixture` 解析成 mock provider，装进运行时门面（`@forguncy-react-workspace/runtime`）；
3. 按 #9 的宿主映射表，把 `react` / `react-dom` / `antd` 等被判定为 `host` 的模块解析到本机安装的对应版本。

编辑 Cell 源码 → 浏览器即时更新，**不需要**同步到活字格。

### 它不是什么

本地开发环境**不是活字格模拟器**，它无法替代真实运行验证：

| 它**不能**证明 | 原因 |
| --- | --- |
| 源码会被活字格的设计器接受 | #5 记录设计器的写入期校验会直接拒绝 `import` / `export` 声明，而本地工程本身就是由 `import` 组成的 —— 本地能跑，与设计器是否接受**无关** |
| 页面生命周期、路由、权限语义 | 这些属于活字格；本地进程既没有页面的 history，也没有页面图 |
| 跨 Cell 的部署隔离 | #5 验证了页面上每个 Cell 是独立 React root，Context 不跨 Cell；本地只挂载一个 Cell，两个 Cell 挂进同一棵树会得到相反的结果 |
| 扩展（`extension`）依赖的真实行为 | 页面级前端库的加载顺序没有保证（#5 `loadOrderGuaranteed: false`）；本地把依赖解析成 npm 包，反而比页面**更强** |
| 生成的宿主桥接模块本身 | 本地解析的是**已发布的包**，从不运行编译器生成的桥接模块；本地绿 ≠ 桥接正确 |

换句话说：本地反馈是 `local` 级证据，**不是**兼容性证据。哪些检查仍然欠真实页面，由 `runtime` 的 `formatLocalDevValidationDistinction()` 逐条打印，而不是靠人记。

一个具体后果值得单独写下来：`react-dom/client` 在页面被收窄为 #5 实际观测到的成员，本地却是完整的已发布模块 —— 所以本地比页面**更宽松**，本地通过不能当作更强的结论。

## 依赖策略

第三方依赖不会简单地分成“支持 / 不支持”，而是根据实际运行方式选择以下策略：

| 策略 | 含义 |
| --- | --- |
| `host` | 由活字格 / ReactCellType 宿主提供，例如宿主 React 或已存在的全局库 |
| `inline` | 直接打包进当前 Cell 产物；这是兼容的现代浏览器库的默认方向 |
| `extension` | 使用活字格前端扩展库，适合需要共享模块身份、跨 Cell 单例 / 缓存或明确复用的大型依赖 |
| `replace` | 当前库不适合该运行环境，优先选择更现代、更适合浏览器 / ESM / Vite 的替代方案，而不是无限增加适配器 |

兼容性判断不会依赖一个无法维护的“全 npm 兼容列表”。项目计划通过 **Agent 动态选库 + 确定性 Probe + 实际运行验证** 来做决策，并把已验证结果记录为可复现的项目状态。

## 当前状态

项目目前仍处于 **v0.1 架构验证阶段**，尚不应视为可直接用于生产的完整工具链。

当前重点是验证：

1. ReactCellType 的真实运行时与源码契约；
2. 普通 React / TypeScript 源码是否可以稳定编译为 Cell 产物；
3. `inline`、`host`、`extension` 三种部署路径；
4. pnpm workspace 内共享源码的构建方式；
5. 通过 MCP 将生成产物同步到真实活字格项目；
6. React Cell 可接受的代码体积与性能边界；
7. Agent 驱动的依赖选择与兼容性验证流程。

整体路线、依赖关系和当前任务请查看 [v0.1 总 Epic](https://github.com/Mang-X/forguncy-react-workspace/issues/3)。

## 项目协作方式

本仓库采用 **Issue-first / PR-first**：

- 设计与技术 Spec 放在 GitHub Issues；
- 实施计划与依赖关系放在 Issues / Epic Issues；
- 代码实现通过关联 Issue 的 Pull Request 提交；
- 不在仓库中重复维护 `specs/`、`plans/` 文档树；
- 未经过真实活字格运行验证的能力，不宣称为已兼容。

如果你想了解当前最优先的工作，可以从 [Issue #3](https://github.com/Mang-X/forguncy-react-workspace/issues/3) 开始。