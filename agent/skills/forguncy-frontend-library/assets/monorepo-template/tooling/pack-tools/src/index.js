// 统一出口：包内脚本只需 import 这一个模块。
export { findPackageRoot, packageLayout } from "./paths.js";
export { createHostReactPlugin } from "./esbuild-host-react.js";
export { wrapLibraryBundle, LIBRARY_MARKER } from "./bundle-wrapper.js";
export { buildManifest } from "./manifest.js";
export { sha256 } from "./fingerprint.js";
export { emitTypesDeclaration } from "./declaration.js";
export { resolveSkillRoot, runSkillScript } from "./skill.js";
export { hostReactStubPath } from "./stub-path.js";
