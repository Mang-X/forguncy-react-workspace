// 构建 dist/{bundle.js,manifest.json,types.d.ts}。
// TODO: 填 prompt 给 AI 用的 description（它既是 manifest.description，也是 CodeEditor/AI 的 API 文档）；
//       React 类库保留 createHostReactPlugin，非 React 类库删掉 plugins 那一行。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import {
  buildManifest,
  createHostReactPlugin,
  emitTypesDeclaration,
  packageLayout,
  sha256,
  wrapLibraryBundle
} from "@forguncy-ext/pack-tools";

const layout = packageLayout(import.meta.url);

const config = {
  schemaVersion: 1,
  id: "__LIBRARY_ID__",
  name: "__DISPLAY_NAME__",
  version: "__VERSION__",
  globalName: "__GLOBAL_NAME__",
  description: "TODO: 一句话说明这是什么、包含哪些 API、不包含哪些、宿主依赖是什么、最小用法。"
};

await mkdir(layout.dist, { recursive: true });

const result = await build({
  absWorkingDir: layout.root,
  entryPoints: [layout.entry],
  bundle: true,
  write: false,
  outfile: path.join(layout.dist, "generated.js"),
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
  plugins: [createHostReactPlugin()],
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

const bundleSource = wrapLibraryBundle({
  id: config.id,
  version: config.version,
  globalName: config.globalName,
  generatedJavaScript: jsFile.text,
  cssText: cssFile ? cssFile.text : ""
});

await Promise.all([
  writeFile(layout.bundle, bundleSource, "utf8"),
  writeFile(path.join(layout.dist, "manifest.json"), JSON.stringify(buildManifest(config), null, 2) + "\n", "utf8")
]);
const typesFile = await emitTypesDeclaration({
  sourceTypesFile: path.join(layout.src, "types.d.ts"),
  outputDirectory: layout.dist
});

console.log(JSON.stringify({
  package: layout.root,
  outputs: [layout.bundle, path.join(layout.dist, "manifest.json"), typesFile],
  bundleBytes: Buffer.byteLength(bundleSource),
  bundleSha256: sha256(bundleSource)
}, null, 2));
