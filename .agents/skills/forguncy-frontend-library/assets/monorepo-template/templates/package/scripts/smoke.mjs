// 通用烟雾闸门：委托技能的 smoke_bundle.mjs。
// React / ReactDOM 依赖宿主提供时才需要 --preload；非 React 类库删掉 preload 两行。
import { hostReactStubPath, packageLayout, runSkillScript } from "@forguncy-ext/pack-tools";

runSkillScript("smoke_bundle.mjs", [
  "--dist",
  packageLayout(import.meta.url).dist,
  "--preload",
  hostReactStubPath
]);
