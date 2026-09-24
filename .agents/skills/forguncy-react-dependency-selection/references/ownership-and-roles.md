# 归属与角色

来源：Spec #4（应用归属边界）、#16 规则 1。角色与规则表由 `node scripts/select_dependency.mjs policy` 输出，不在此重抄。

## 判据：角色先于包名

归属是**能力的属性**，不是包的属性。同一条规则对未知包和知名包一视同仁：一个自研的 `my-nav-lib` 填 `application-navigation`，与 React Router 填这个角色同样冲突。

先问"这个能力该由谁拥有"，再问"用哪个包"。反过来做，任何不在规则表里的包都会以 `unclassified` 的身份填进宿主角色——这正是 Cell 里长出第二个路由或第二份业务状态的路径。

## 两边的边界

**Forguncy 拥有应用**：路由、页面与全局状态、数据源、服务端命令、权限、页面生命周期、跨 Cell 通信。

**React 拥有 island**：组件本地 UI、局部交互状态、表单、可视化、动画、拖拽、图表、地图、3D、编辑器，以及其他纯浏览器 UI 关注点。

## 四种角色

| 角色 | 归属 | 说明 |
|---|---|---|
| `application-navigation` | Forguncy | 导航与浏览器历史 |
| `application-state` | Forguncy | 跨 Cell 业务状态的事实源 |
| `application-auth` | Forguncy | 认证与授权 |
| `business-data-source` | Forguncy | 业务数据事实源 |
| `cell-local-ui` | Cell | 单元内 UI |
| `cell-local-state` | Cell | 单元内局部状态 |
| `cell-local-data-access` | Cell | 单元内数据访问 |

前四种是**应用所有角色**：无论用哪个包，请求都跨过了边界。后三种是 cell-local：单个 Cell 内合法。

## 三条必须教会的判断

### 1. React Router / 应用级路由不是 Cell 里的默认答案

`react-router`、`react-router-dom`、`@tanstack/react-router`、`wouter`、`history` 等在任何 cell-local 角色下都没有合法用途（`allowedCellLocalRoles` 为空），因此在 Cell 内使用就是真实的架构冲突（`application-router-conflict`）。

正确做法：用宿主页面导航。Cell 不是应用外壳，不该挂载路由器。

**注意**：`role-mismatch` 与 `platform-conflict` 是不同答案。`zustand` 请求 `cell-local-ui` 是"包与角色不匹配"（角色声明错了），不是归属冲突。把两者混为一谈会造出假阳性架构拒绝。

### 2. Zustand / Redux 可以是 Cell 局部状态，但不能自动成为跨 Cell 业务状态源

`zustand`、`redux`、`@reduxjs/toolkit`、`react-redux`、`jotai`、`recoil`、`valtio`、`mobx` 等的 `allowedCellLocalRoles` 包含 `cell-local-state` / `cell-local-ui` / `cell-local-data-access`。

- 用在**一个 Cell 的局部状态**（如向导步骤）：合法。
- 当作**跨 Cell 业务状态事实源**：平台冲突（`application-state-conflict`），因为它复制了 Forguncy 页面状态。

这是 #4 强调的"归属判断对角色敏感"：同一个包，用在哪决定它是否冲突。

### 3. TanStack Query 可以用于外部数据 / Cell 局部远程数据；已用 Forguncy DataSource 的地方仍以 Forguncy 为准

`@tanstack/react-query` 不在平台冲突规则表里（`unclassified`），因此走正常策略评估——通常是 `inline` 或 `extension`。

- 用于 **Cell 局部**的远程数据获取 / 缓存：可以。
- 作为**业务数据的事实源**、取代已有的 Forguncy DataSource：不可以。已有 DataSource 的地方，Forguncy 仍是权威。

它也是 `extension` 的典型场景：多个 Cell 需要共享同一个 `QueryClient`／缓存时，bundled 副本会让每个 Cell 各持一份，此时需要扩展提供的页面全局（见 `strategies-and-evidence.md`）。

## 归属判给 Forguncy 之后

分支立刻结束（`SELECTION_BRANCHES` 的 `forguncy-owned` 臂：`classify-ownership` → `persist-decision`，`skipsCandidateWork: true`）：

- 不研究候选、不排队、不 probe、不找替代包。
- 产出 `replace`，`rejection` **就是归属评估自己给出的那条**，不要手写：`audit`/`record` 会比对 code，不一致会被拒绝。
- 记录欠 `probeRequirement: "none"`，即**不欠 probe**；架构拒绝的证据是归属决策本身。所以它的 `target` 与 `resolvedVersion` 都是 `null`。

替代方案是**能力的所有者**（宿主），不是另一个包——因此架构拒绝不记 `alternatives`。
