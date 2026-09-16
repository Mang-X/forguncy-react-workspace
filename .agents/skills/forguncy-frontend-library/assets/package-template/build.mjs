// 构建 bundle.js + manifest.json。配置里的 ID / 版本 / 全局名请按目标类库分析结果修改。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const config = {
  schemaVersion: 1,
  id: "__LIBRARY_ID__",
  name: "__DISPLAY_NAME__",
  version: "__VERSION__",
  globalName: "__GLOBAL_NAME__",
  description: [
    "Library __VERSION__ for ReactCellType.",
    "Use the global __GLOBAL_NAME__ directly; never use import or export.",
    "Included: <列出能力>. Not included: <列出未包含模块>.",
    "Create resources in React.useEffect and release them in cleanup.",
    "Minimal example: __GLOBAL_NAME__.<entry call>."
  ].join(" ")
};

const outputDir = "dist";
await mkdir(outputDir, { recursive: true });

const result = await build({
  entryPoints: ["src/entry.js"],
  bundle: true,
  write: false,
  outfile: "dist/generated.js",
  format: "iife",
  globalName: "__ForguncyGeneratedModule",
  platform: "browser",
  target: ["es2018"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  define: {
    "process.env.NODE_ENV": '"production"'
  },
  loader: {
    ".png": "dataurl",
    ".jpg": "dataurl",
    ".jpeg": "dataurl",
    ".gif": "dataurl",
    ".svg": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl"
  }
});

const jsFile = result.outputFiles.find(file => file.path.endsWith(".js"));
const cssFile = result.outputFiles.find(file => file.path.endsWith(".css"));
assert(jsFile, "esbuild did not produce JavaScript output");

const generatedJavaScript = jsFile.text;
const generatedCss = cssFile ? cssFile.text : "";
const markerName = "__forguncyFrontendLibrary";

const bundleSource = "(function (globalObject) {\n" +
  '  "use strict";\n' +
  "  var libraryId = " + JSON.stringify(config.id) + ";\n" +
  "  var libraryVersion = " + JSON.stringify(config.version) + ";\n" +
  "  var globalName = " + JSON.stringify(config.globalName) + ";\n" +
  "  var markerName = " + JSON.stringify(markerName) + ";\n" +
  "  var cssText = " + JSON.stringify(generatedCss) + ";\n" +
  "  function ensureStyle() {\n" +
  '    if (typeof document === "undefined" || !cssText) return;\n' +
  '    var selector = "style[data-forguncy-frontend-library=\\"" + libraryId + "\\"]";\n' +
  "    if (document.querySelector(selector)) return;\n" +
  '    var style = document.createElement("style");\n' +
  '    style.setAttribute("data-forguncy-frontend-library", libraryId);\n' +
  "    style.textContent = cssText;\n" +
  "    (document.head || document.documentElement).appendChild(style);\n" +
  "  }\n" +
  "  var existing = globalObject[globalName];\n" +
  "  if (existing !== undefined) {\n" +
  "    var metadata = existing && existing[markerName];\n" +
  "    if (metadata && metadata.id === libraryId && metadata.version === libraryVersion) {\n" +
  "      ensureStyle();\n" +
  "      return;\n" +
  "    }\n" +
  '    throw new Error(globalName + " is already occupied by another library.");\n' +
  "  }\n" +
  generatedJavaScript + "\n" +
  "  var generatedModule = __ForguncyGeneratedModule;\n" +
  "  var publicApi = generatedModule && generatedModule.default !== undefined\n" +
  "    ? generatedModule.default\n" +
  "    : generatedModule;\n" +
  '  if ((typeof publicApi !== "object" || publicApi === null) && typeof publicApi !== "function") {\n' +
  '    throw new Error("The generated library did not produce an object or function API.");\n' +
  "  }\n" +
  "  if (!Object.isExtensible(publicApi)) {\n" +
  '    throw new Error("The entry module must export an extensible facade object or function.");\n' +
  "  }\n" +
  "  Object.defineProperty(publicApi, markerName, {\n" +
  "    configurable: false,\n" +
  "    enumerable: false,\n" +
  "    writable: false,\n" +
  "    value: Object.freeze({ id: libraryId, version: libraryVersion })\n" +
  "  });\n" +
  "  Object.defineProperty(globalObject, globalName, {\n" +
  "    configurable: true,\n" +
  "    enumerable: true,\n" +
  "    writable: false,\n" +
  "    value: publicApi\n" +
  "  });\n" +
  "  ensureStyle();\n" +
  "})(globalThis);\n";

const manifest = {
  schemaVersion: config.schemaVersion,
  id: config.id,
  name: config.name,
  version: config.version,
  globalName: config.globalName,
  description: config.description
};

await Promise.all([
  writeFile(outputDir + "/bundle.js", bundleSource, "utf8"),
  writeFile(outputDir + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n", "utf8")
]);

const sha256 = value => createHash("sha256").update(value).digest("hex").toUpperCase();
console.log(JSON.stringify({
  manifest,
  bundleBytes: Buffer.byteLength(bundleSource),
  bundleSha256: sha256(bundleSource)
}, null, 2));
console.log("提醒：本模板不生成 types.d.ts。类型声明必须反映真实门面，请按 references/types-and-monaco.md 手写 dist/types.d.ts。");

