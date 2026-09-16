# 结构与命名约定

## 0. 随仓库分发的技能

`.agents/skills/forguncy-frontend-library/` 是 forguncy-frontend-library 技能的实体副本，
`.claude/skills/forguncy-frontend-library` 是指向它的**相对**符号链接，`skills-lock.json` 记录来源与哈希。
三者都要入库，这样 CI 与全新克隆都能跑完整门禁。安装 / 更新：

```bash
npx skills@latest add MangMax/forguncy-frontend-library -s forguncy-frontend-library -y
npx skills@latest update forguncy-frontend-library
```

> `-s` 必须写成空格形式：`--skill=<name>` 会被静默忽略，结果是装下整个仓库。

包内脚本按以下顺序找技能根目录：环境变量 `FORGUNCY_LIBRARY_SKILL_ROOT` → 各级 `.forguncy-skill-root`
→ 仓库内的 `.agents/skills/forguncy-frontend-library`。

## 1. 包 id

| 规则 | 取值 |
|---|---|
| 正则 | `^[a-z0-9]+(-[a-z0-9]+)*$`（小写 kebab-case） |
| 用途 | 目录名 `packages/<id>/`、**Forguncy 包 id**（manifest.id）、npm 包名后缀、提交 scope、产文件名 |
| 不可变 | 一旦上传过就不要改 id；要换 id 等于换一个新包 |

改 id = 换包。版本迭代只提升 `version`。

## 2. 每个包里的名字

| 名字 | 规则 | 示例 |
|---|---|---|
| 目录 | 等于 id | `packages/vendor-library/` |
| npm 包名 | `@forguncy-ext/<id>`，`"private": true`，不发布 | `@forguncy-ext/vendor-library` |
| version | 跟随被打包的上游类库版本；内容变更必须提升，**禁止 `latest` / `*` / `^`** | `1.2.3` |
| globalName | 单个合法标识符、PascalCase，一般是上游类库的习惯名；不得占用活字格宿主保留名 | `VendorLibrary` |
| 产文件名 | `<id>-<version>.zip`，落在 `artifacts/` | `artifacts/vendor-library-1.2.3.zip` |
| 提交 scope | 等于 id（跨基建改动用 `tooling` 或不带 scope） | `feat(vendor-library): 加上持久化入口` |

## 3. 源码与产物边界

| 目录 | 是否入库 | 内容 |
|---|---|---|
| `src/` | 入库 | `entry.js`（门面）+ `types.d.ts`（手写声明，必须是脚本模式） |
| `scripts/` | 入库 | `build` / `pack` / `validate` / `smoke`，逻辑尽量下沉到 `@forguncy-ext/pack-tools` 或技能脚本 |
| `tests/` | 入库 | 该类库专有的行为断言；宿主 React 桩复用 `pack-tools` 导出的那一份 |
| `dist/` | **不入库** | `bundle.js` + `manifest.json` + `types.d.ts`，由 `build` 整体重生成 |
| `artifacts/` | **不入库** | ZIP 交付物，由 `pack` 重生成 |
| `superseded/` | 入库 | 被取代的历史 ZIP，作为交付记录保留（不在 .gitignore 的 `*.zip` 范围内） |

规则：`dist/` 与 `artifacts/` 必须能从一个干净检出 + `vp install` + `vp run -r build` 完整重生成；任何人手工往里放文件都是 bug。

## 4. 上游依赖

- 版本**固定写死**（`"vendor-library": "1.2.3"`），`pnpm-workspace.yaml` 已设 `saveExact=true`。
- 只能打包许可证允许再分发的类库；MIT 类库要在 `bundle.js` 顶部保留版权 banner。
- pnpm 的严格依赖树会让“隐式传递依赖”立刻炸出来：`src/entry.js` 里 import 的每个包都必须在 dependencies 里显式声明，不能靠 npm 时代的扁平提升。
- React 类库不打第二份 React：运行时复用宿主的 `globalThis.React` / `ReactDOM`（由 `pack-tools` 的宿主 React 插件做映射）。

## 5. 仓库级工具

| 目录 | 说明 |
|---|---|
| `tooling/pack-tools` | `@forguncy-ext/pack-tools`：包根目录推断、宿主 React esbuild 插件、经典脚本外壳、manifest 构造、类型声明复制、技能根解析、宿主 React 桩。包壳逻辑只在这里存在一份 |
| `tooling/new-package.mjs` | `vp run new-package <id> [--global <GlobalName>] [--version <x.y.z>]` |
| `tooling/package-index.mjs` | `vp run packages [--write]` |
| `tooling/changelog.mjs` | `vp run changelog` |

新包的准入条件：必须自带 `README.md`（用法与门禁清单）和 `report.md`（兼容性分析与验证报告），否则不算完成。
