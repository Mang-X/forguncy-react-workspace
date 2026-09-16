# 活字格前端扩展包仓库

多个 **活字格 ReactCellType 前端扩展包**（`manifest.json` + `bundle.js` + `types.d.ts`）在同一个仓库里统一维护。
每个 `packages/<id>/` 目录对应一个可上传活字格的三件套 ZIP，互不共享运行时依赖。

本仓库由 **forguncy-frontend-library** 技能的 `monorepo` 模板生成；骨架之外的构建逻辑都走
`tooling/pack-tools`，通用闸门（静态校验 / 烟雾测试 / 打包）仍由技能脚本提供。

工具链：**pnpm（workspace）** + **Vite+ / `vp`（任务运行器）** + **git-cliff（变更日志）**。

## 仓库结构

```
.
├── packages/<id>/              # 一个目录 = 一个活字格前端扩展包（目录名 = Forguncy 包 id）
│   ├── package.json            # @forguncy-ext/<id>，private，version 跟随上游类库
│   ├── README.md               # 这个包的用法与门禁清单
│   ├── CHANGELOG.md            # 只含该包的改动（git-cliff 按路径过滤生成）
│   ├── src/{entry.js,types.d.ts}
│   ├── scripts/                # build / pack / validate / smoke
│   ├── tests/                  # 该类库专用的行为断言
│   ├── dist/                   # 构建产物（gitignore）
│   └── artifacts/              # <id>-<version>.zip（gitignore）
├── tooling/
│   ├── pack-tools/             # @forguncy-ext/pack-tools：共享构建工具
│   ├── new-package.mjs         # 从 templates/package 建新包
│   ├── package-index.mjs       # 生成 docs/packages.md 清单
│   └── changelog.mjs           # 生成根 + 各包 CHANGELOG.md
├── templates/package/          # 新包骨架（占位符 __LIBRARY_ID__ / __GLOBAL_NAME__ / __VERSION__ / __DISPLAY_NAME__）
├── docs/                       # 结构与命名约定
├── cliff.toml                  # git-cliff 配置
├── pnpm-workspace.yaml         # 工作区成员 + pnpm 12 设置
└── .github/workflows/ci.yml
```

结构与命名约定见 [docs/project-layout.md](docs/project-layout.md)。

## 前置条件

| 工具 | 安装 | 说明 |
|---|---|---|
| `vp`（Vite+） | `curl -fsSL https://vite.plus \| bash` | 任务运行器；`vp install` 会按 `packageManager` 拉正确的 pnpm 与 Node |
| Node ≥ 22 | 由 `vp env` 管理 | `package.json` 里有 `engines` 约束 |
| git-cliff | `brew install git-cliff` | 仅在跑 `vp run changelog` 时需要 |
| forguncy-frontend-library 技能 | `npx skills@latest add MangMax/forguncy-frontend-library -s forguncy-frontend-library -y` | 通用闸门脚本的来源 |

技能根目录的解析顺序：环境变量 `FORGUNCY_LIBRARY_SKILL_ROOT` → 各级 `.forguncy-skill-root` →
仓库内 `.agents/skills/forguncy-frontend-library`。装进仓库后 CI 与全新克隆都无需额外配置。

## 常用命令

| 命令 | 作用 |
|---|---|
| `vp install` | 安装依赖 |
| `vp run -r build` | 构建所有包的 `dist/` 三件套 |
| `vp run -r pack` | 打标准 ZIP 到各包 `artifacts/` |
| `vp run -r gates` | 全门禁（技能随仓库时 CI 也能跑） |
| `vp run -r tests` | 只跑类库行为断言 |
| `vp run --filter ./packages/<id> <task>` | 只跑某个包 |
| `vp run packages --write` | 重新生成 `docs/packages.md` |
| `vp run new-package <id> --global <G> --version <v>` | 建新包骨架 |
| `vp run changelog` | 生成根 `CHANGELOG.md` 与各包 `CHANGELOG.md` |

需要缓存时给 `vp run` 加 `--cache`。

## 新增一个扩展包

```bash
vp run new-package <id> --global <GlobalName> --version <上游版本>
vp install
# 填 src/entry.js（门面）与 src/types.d.ts（脚本模式声明）、README.md、report.md
vp run --filter ./packages/<id> build
vp run --filter ./packages/<id> gates
vp run --filter ./packages/<id> pack
```

开工前先按技能的 `references/build-strategies.md` 做兼容性分析：Node-only、动态 import 无法消除、
许可证禁止再分发的类库不要在这里建包，直接说明阻断原因。

## 门禁与没做的事

- 一个包从零到可交付的最小闭环：`build → gates → pack`，跑出来的 ZIP 才能上传活字格。
- 上传到活字格做设计器/运行时验证**不在**本仓库的自动流程里，需要 MCP 与真实工程，结论写进各包 `report.md`。
- 尚未执行或未验证的环节一律写“未执行”，不写“应该可用”。
