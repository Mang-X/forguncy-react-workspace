# __DISPLAY_NAME__

活字格 ReactCellType 前端扩展包（骨架，待填写）。

| 项 | 值 |
|---|---|
| id / 目录名 | `__LIBRARY_ID__` |
| npm 包名 | `@forguncy-ext/__LIBRARY_ID__` |
| version | `__VERSION__`（跟随上游类库，内容变更必须提升） |
| globalName | `__GLOBAL_NAME__` |
| manifest.name | `__DISPLAY_NAME__` |
| 目标类库 | TODO：名称、版本、来源、许可证 |
| 宿主依赖 | TODO：是否需要 React / ReactDOM，最低版本 |

## 待办清单（做完才能算包完成）

- [ ] 兼容性分析结论写进 `report.md`（可打包 / 有条件可打包 / 不适合，理由要具体）
- [ ] `package.json` 的 dependencies 写死版本，删掉 `TODO_TARGET_LIBRARY`
- [ ] `src/entry.js` 汇总真实门面
- [ ] `src/types.d.ts` 反映真实门面，保持脚本模式
- [ ] `scripts/build.mjs` 里的 `description` 补齐（它同时是 AI/CodeEditor 的 API 文档）
- [ ] `tests/functional.mjs` 补真实断言
- [ ] `vp run --filter ./packages/__LIBRARY_ID__ build`
- [ ] `vp run --filter ./packages/__LIBRARY_ID__ gates`
- [ ] `vp run --filter ./packages/__LIBRARY_ID__ pack`

## 命令

```bash
vp run --filter ./packages/__LIBRARY_ID__ build    # dist/ 三件套
vp run --filter ./packages/__LIBRARY_ID__ gates    # validate + smoke + tests
vp run --filter ./packages/__LIBRARY_ID__ pack     # artifacts/__LIBRARY_ID__-__VERSION__.zip
```

需要通用闸门时有前置条件：设置 `FORGUNCY_LIBRARY_SKILL_ROOT`，或在仓库根写 `.forguncy-skill-root`。

## 未完成

- 上传到活字格 + 设计器/运行时验证：需要 MCP 与真实工程，结论记录进 `report.md`。
- 没跑过的验证写“未执行”，不写“应该可用”。
