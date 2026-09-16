# __DISPLAY_NAME__

活字格 ReactCellType 前端扩展包包工作目录。

- id: __LIBRARY_ID__
- version: __VERSION__
- globalName: __GLOBAL_NAME__

## 顺序

~~~bash
pnpm install
pnpm run build
pnpm run validate
pnpm run smoke
pnpm run pack
~~~

首次 `pnpm install` 会生成 `pnpm-lock.yaml`，请提交它；此后重装用 `pnpm install --frozen-lockfile` 复现同一依赖树。

`pnpm-workspace.yaml` 里的 `allowBuilds: { esbuild: true }` 不能删：pnpm 11 默认拒绝执行依赖的
postinstall 脚本，esbuild 的 `index.js` 就是在那一步生成的，删掉后 `pnpm run build` 会直接
`ERR_MODULE_NOT_FOUND`。新增任何带 install 脚本的依赖时同样要在这里放行。

## 还需要人工完成的

- dist/types.d.ts：按 references/types-and-monaco.md 手写，声明 __GLOBAL_NAME__ 的真实门面。
- 类库最小功能测试、资源清理测试：见 references/verify-locally.md 第 3、8、9 项。
- 上传与设计器/运行时验证：见 references/upload-and-integrate.md。

