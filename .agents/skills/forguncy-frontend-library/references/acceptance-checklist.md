# 验收清单

来源：指南第 17 节。只有以下项目全部满足，才能报告"包已完成"。无法执行的项写"未执行"，不得默认通过。

## 来源与策略

- [ ] 类库和依赖版本全部固定，pnpm-lock.yaml 已提交。
- [ ] 来源和许可证已确认允许当前用途和再分发。
- [ ] 已明确包含与未包含能力。
- [ ] 已说明为何选择 UMD、esbuild、词法隔离或其他策略。
- [ ] 没有未解释的 CDN、动态 chunk 或额外运行时文件。

## 包结构

- [ ] ZIP 根目录只有 manifest.json、bundle.js、types.d.ts。
- [ ] 三个文件都是严格 UTF-8。
- [ ] Manifest 字段、ID、SemVer 和全局名合法。
- [ ] 文件及解压总大小满足限制。
- [ ] SHA-256 已记录。

## JavaScript

- [ ] Bundle 通过 vm.Script 经典脚本语法解析；可再运行 node --check bundle.js 作为补充。
- [ ] 没有残留顶层 import/export 或动态 import()。
- [ ] Bundle 执行后立即创建正确全局变量。
- [ ] 重复加载幂等。
- [ ] 全局名冲突时拒绝覆盖。
- [ ] 宿主 React 或其他宿主全局未被替换。
- [ ] CSS 和静态资源已内联或有明确可验证的加载策略。
- [ ] 具体类库核心 API 烟雾测试通过。

## 类型和 AI

- [ ] types.d.ts 声明准确全局变量。
- [ ] types.d.ts 保持脚本模式；没有顶层 import、export =、export default 或 export {}；没有在全局 declare namespace 后追加 export = <GlobalName>。
- [ ] 如果使用 export as namespace，已在 Monaco 中确认 <GlobalName>. 可补全，而不是只通过上传正则校验。
- [ ] Monaco 无语法/语义错误。
- [ ] 核心 API 有智能提示，而不仅是 any。
- [ ] description 包含能力、限制、全局名、最小示例和 cleanup。
- [ ] CodeEditor AI 能生成无 import/export 的正确示例。

## 活字格集成

- [ ] MCP/设计器上传成功且无未处理 warning。
- [ ] exists === true。
- [ ] typeDefinitionAvailable === true。
- [ ] ReactCellType 使用返回的 id 添加引用。
- [ ] 设计时预览正常。
- [ ] 工程检查无 Error。
- [ ] 生成后的运行时渲染正常。
- [ ] 浏览器控制台 Error 为 0。
- [ ] 资源清理和重复进入页面正常。

