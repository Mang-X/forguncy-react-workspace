# 贡献约定

## 提交信息（Conventional Commits + 包 scope）

CHANGELOG.md 由 git-cliff 直接读提交历史生成，写歪了就会污染日志。格式：

```
<type>(<scope>): <subject>
```

- `<type>`：`feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `build` / `ci` / `chore`
- `<scope>`：**必须是包 id**（如 `vendor-library`）；跨基建改动用 `tooling`；仓库级改动（README、CI、配置）可以不带 scope
- `<subject>`：一句话，祈使句，不用句号结尾
- 破坏性变更：type 后加 `!`，并在正文写 `BREAKING CHANGE: ...`

```
feat(tanstack-query): 增加 SharedPersistProvider
fix(tanstack-query): 修正 jsx-runtime 适配器丢失 children
build(release)!: tanstack-query 提升到 5.102.9
docs: 补充新包脚手架说明
```

### 发布 / 变更日志

`vp run changelog` 会重新生成根 `CHANGELOG.md` 与各包独立的 `CHANGELOG.md`（按路径过滤），不要手工编辑这两个文件。

## 分支命名

语义化短横线命名：`feat/<id>-<简述>`、`fix/<id>-<简述>`、`chore/<简述>`。例如 `fix/vendor-library-jsx-key`。

## 新增一个扩展包

```bash
vp run new-package <id> --global <GlobalName> --version <上游版本>   # 从 templates/package 拷骨架
vp install                                                        # 让 workspace 链接新包
# 写 src/entry.js（门面）与 src/types.d.ts（脚本模式声明）
# 写 README.md（用法 + 门禁清单）与 report.md（兼容性分析与验证报告）
vp run --filter ./packages/<id> build
vp run --filter ./packages/<id> gates
vp run --filter ./packages/<id> pack
```

开工前先按技能里 `references/build-strategies.md` 的决策表做兼容性分析：Node-only、动态 import 无法消除、
许可证禁止再分发的类库，**不要**在这里建包，应该直接说明阻断原因。

## 版本与内容

- 依赖版本固定写死，不用 `latest` / `*` / `^`；仓库已设 `saveExact=true`。
- **内容变就必须提 version**：新增/删除 API、调换依赖版本、改 `entry.js` 或 `types.d.ts`。
- 别动 id：id 变了等于新包，旧包会被当作另一个扩展包占用全局名。

## 门禁

一个包的完整闭环是 `build → gates → pack`：

| 任务 | 是否需要技能脚本 | 说明 |
|---|---|---|
| `build` | 否 | esbuild → `dist/` 三件套 |
| `validate` | 是 | 结构 / 编码 / 大小 / Manifest / 保留名 / 经典脚本 / types 脚本模式 |
| `smoke` | 是 | 全局创建 / 幂等 / 冲突拒绝 / 宿主全局未被替换 / CSS 标记 |
| `tests` | 否 | 该类库专有的行为断言（含真实 React 渲染与持久化 E2E） |
| `pack` | 是 | 确定性 ZIP → `artifacts/<id>-<version>.zip` |

技能脚本随仓库分发（`.agents/skills/forguncy-frontend-library/`），所以上述"是"的三项无需额外配置。
若要用本机另一份技能（比如调试上游改动），设 `FORGUNCY_LIBRARY_SKILL_ROOT` 覆盖即可。
同步上游更新：`npx skills@latest update forguncy-frontend-library`，然后确认
`skills-lock.json` 的 `computedHash` 变了、CI 仍然全绿。

没有跑过的验证一律写“未执行”，不许写“应该可用”。设计器 / 运行时验证需要 MCP + 真实工程，结论写进 `report.md`。

## 不要入库的东西

`dist/` 与 `artifacts/`。它们必须能从干净检出 + `vp install` + `vp run -r build` 重新生成。
大二进制、`node_modules`、本地路径配置（`.forguncy-skill-root`）同样不入库。
