// 把 esbuild 产出的 IIFE 包成"经典脚本 + 全局对象"的活字格扩展包。
//
// 平台约束（见技能硬规则）：
//   - bundle.js 按经典脚本执行，不得有顶层 import/export 与运行期 import()；
//   - 脚本执行完必须【同步】在 globalThis 上建好与 manifest.globalName 同名的属性；
//   - 同名全局被别的库占用时直接抛错；id + version 完全一致则幂等返回（重复加载安全）；
//   - CSS 只能内联，运行时注入一次（用 data 属性做标记去重）。
export const LIBRARY_MARKER = "__forguncyFrontendLibrary";

function json(value) {
  return JSON.stringify(value);
}

export function wrapLibraryBundle(options) {
  const {
    id,
    version,
    globalName,
    generatedJavaScript,
    cssText = "",
    generatedModuleName = "__ForguncyGeneratedModule",
    licenseBanner = "",
    minSupportedReactMajor = 18,
    supportedReactNote = "React 18 or 19"
  } = options;

  if (!id || !version || !globalName) {
    throw new Error("wrapLibraryBundle 需要 id / version / globalName");
  }
  if (typeof generatedJavaScript !== "string" || generatedJavaScript === "") {
    throw new Error("wrapLibraryBundle 需要 esbuild 产出的 generatedJavaScript");
  }

  const hostReactGuard = [
    "  if (!globalObject.React) {",
    '    throw new Error(' + json(globalName + " requires the host React global provided by ReactCellType.") + ');',
    "  }",
    '  var hostReactMajor = parseInt(String(globalObject.React.version || "0").split(".")[0], 10);',
    "  if (!(hostReactMajor >= " + minSupportedReactMajor + ")) {",
    '    throw new Error(' + json(globalName + " requires " + supportedReactNote + "; host React version is ") + ' + globalObject.React.version + ' + json(".") + ');',
    "  }"
  ].join("\n");

  const body = [
    "(function (globalObject) {",
    '  "use strict";',
    "  var libraryId = " + json(id) + ";",
    "  var libraryVersion = " + json(version) + ";",
    "  var globalName = " + json(globalName) + ";",
    "  var markerName = " + json(LIBRARY_MARKER) + ";",
    "  var cssText = " + json(cssText) + ";",
    "  function ensureStyle() {",
    '    if (typeof document === "undefined" || !cssText) return;',
    '    var selector = "style[data-forguncy-frontend-library=\\"" + libraryId + "\\"]";',
    "    if (document.querySelector(selector)) return;",
    '    var style = document.createElement("style");',
    '    style.setAttribute("data-forguncy-frontend-library", libraryId);',
    "    style.textContent = cssText;",
    "    (document.head || document.documentElement).appendChild(style);",
    "  }",
    "  var existing = globalObject[globalName];",
    "  if (existing !== undefined) {",
    "    var metadata = existing && existing[markerName];",
    "    if (metadata && metadata.id === libraryId && metadata.version === libraryVersion) {",
    "      ensureStyle();",
    "      return;",
    "    }",
    '    throw new Error(globalName + " is already occupied by another library.");',
    "  }",
    hostReactGuard,
    generatedJavaScript,
    "  var generatedModule = " + generatedModuleName + ";",
    "  var publicApi = generatedModule && generatedModule.default !== undefined",
    "    ? generatedModule.default",
    "    : generatedModule;",
    '  if ((typeof publicApi !== "object" || publicApi === null) && typeof publicApi !== "function") {',
    '    throw new Error("The generated library did not produce an object or function API.");',
    "  }",
    "  if (!Object.isExtensible(publicApi)) {",
    '    throw new Error("The entry module must export an extensible facade object or function.");',
    "  }",
    "  Object.defineProperty(publicApi, markerName, {",
    "    configurable: false,",
    "    enumerable: false,",
    "    writable: false,",
    "    value: Object.freeze({ id: libraryId, version: libraryVersion })",
    "  });",
    "  Object.defineProperty(globalObject, globalName, {",
    "    configurable: true,",
    "    enumerable: true,",
    "    writable: false,",
    "    value: publicApi",
    "  });",
    "  ensureStyle();",
    "})(globalThis);",
    ""
  ].join("\n");

  return licenseBanner + body;
}
