# 上传、集成与运行时验证

来源：指南第 12、13、14、15 节。

## 上传与覆盖

可通过设计器 UI 或 MCP：

~~~javascript
const uploadResult = await api.app.uploadFrontendLibrary({
  packageFilePath: "C:\\absolute\\path\\vendor-library-1.2.3.zip",
  overwrite: false
});
~~~

更新相同 id：

~~~javascript
const uploadResult = await api.app.uploadFrontendLibrary({
  packageFilePath: "C:\\absolute\\path\\vendor-library-1.2.4.zip",
  overwrite: true
});
~~~

上传后必须检查：

~~~javascript
const libraries = await api.app.listFrontendLibraries({});
const library = libraries.find(item => item.id === "vendor-library");

if (!library) throw new Error("Library metadata was not saved.");
if (!library.exists) throw new Error("Runtime bundle file is missing.");
if (!library.typeDefinitionAvailable) throw new Error("Type definitions are missing.");
if (library.globalName !== "VendorLibrary") throw new Error("Unexpected globalName.");
~~~

uploadFrontendLibrary 返回 requiresRegenerate: true 时必须重新生成工程或刷新调试运行时。生成后的资源 URL 使用完整性摘要或版本隔离缓存，但仍应在新页面会话中验证升级结果。

## ReactCellType 引用写法

必须先调用 api.app.listFrontendLibraries，使用返回的稳定 id，不能猜显示名称与脚本文件名的关系。

~~~javascript
await api.page.setCells({
  pageName: "扩展库验证页",
  cells: [{
    cell: "A1",
    rowSpan: 30,
    colSpan: 12,
    cellType: "ReactCellTypeCellType",
    cellTypeProps: {
      frontendLibraries: [
        { libraryId: "vendor-library" }
      ],
      code: "function App(props) { ... }"
    }
  }]
});
~~~

规则：

- frontendLibraries 中只保存 { libraryId }。
- React 代码按 Manifest 的 globalName 使用全局变量，不写 import/export。
- 不把 Bundle URL 写死到代码中。
- DOM/Canvas/WebGL 类库在 React.useEffect 中初始化，cleanup 中调用厂商销毁 API。
- 容器必须有确定宽高；对尺寸敏感的库使用 ResizeObserver 并在 cleanup 中断开。
- 对动画循环调用 cancelAnimationFrame 或厂商停止 API。
- 不假定未在 description 和类型声明中出现的模块可用。

## CodeEditor 与 AI 助手验证

选中扩展包后 CodeEditor 会：把 types.d.ts 注入 Monaco javascriptDefaults.setExtraLibs；在设计时执行 bundle.js；把 name、globalName、description 加入 CodeEditor AI 上下文。必须分别验证：

1. 输入 GlobalName. 能出现核心 API 补全。
2. 最小示例没有"找不到名称"或错误类型提示。
3. 设计时预览能加载 Bundle 并渲染。
4. CodeEditor AI 能根据自然语言生成使用该全局变量的代码。
5. AI 生成代码没有 import/export。
6. AI 只使用包中真实存在的能力。

Monaco 不报错但没有有价值的提示，说明 types.d.ts 只是 any 降级，不能视为完整通过。

## 完整 MCP 验证流程

1. api.app.uploadFrontendLibrary 上传 ZIP。
2. api.app.listFrontendLibraries 确认元数据、文件、类型声明和大小。
3. 创建独立验证页。
4. 用 api.page.setCells 添加引用该包的 ReactCellType。
5. 生成一个只使用核心 API 的确定性示例。
6. 保存工程。
7. api.app.checkProjectErrors，要求 errorCount === 0。
8. api.app.generatePageAsync 生成并取得运行时 URL。
9. 用浏览器打开运行时页面。
10. 检查页面状态文本、关键 DOM、Canvas/WebGL 像素、CSS Marker 和全局隔离结果。
11. 检查本次加载后的浏览器控制台 Error 为 0。
12. 再次 listFrontendLibraries，确认 referenceCount >= 1。

删除包前：

~~~javascript
const libraries = await api.app.listFrontendLibraries({});
const library = libraries.find(item => item.id === "vendor-library");
if (library?.referenceCount !== 0) {
  throw new Error("Remove all ReactCellType references before deleting the library.");
}
await api.app.deleteFrontendLibrary({ libraryId: "vendor-library" });
~~~

存在引用时删除 API 会拒绝操作。更新被引用的包应使用同一 id 和 overwrite: true。

无法运行设计器或浏览器时，报告中必须写"未执行"，不能写"应该可用"。

