#!/usr/bin/env node
// 通用静态校验：对齐《活字格 ReactCellType 前端扩展包生成指南》第 9 节与第 4 节限制。
// 用法: node validate_package.mjs [--dist dist]
// 退出码: 0 通过; 1 存在失败项。上传仍是最终校验边界，本地通过后仍需实际上传验证。
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const dist = path.resolve(argValue("--dist", "dist"));
const manifestPath = path.join(dist, "manifest.json");
const bundlePath = path.join(dist, "bundle.js");
const typesPath = path.join(dist, "types.d.ts");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const expectedManifestKeys = ["description", "globalName", "id", "name", "schemaVersion", "version"];
const windowsReservedNames = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);
const javascriptReservedWords = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"
]);
const hostReservedGlobalNames = new Set([
  "$", "jQuery", "React", "ReactDOM", "Babel", "Forguncy", "GC", "antd", "echarts", "dayjs",
  "ForguncyReactHelper", "ReactCellTypeAntDesignZhCN", "ForguncyAIAssistant",
  "ReactCellTypeCodeEditor", "forguncyWebBrowserBridge", "MonacoEnvironment", "define", "require"
]);
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const decoder = new TextDecoder("utf-8", { fatal: true });

const buffers = await Promise.all([
  readFile(manifestPath).catch(() => null),
  readFile(bundlePath).catch(() => null),
  readFile(typesPath).catch(() => null)
]);
const [manifestBuffer, bundleBuffer, typesBuffer] = buffers;

check(manifestBuffer !== null, "缺少 " + manifestPath);
check(bundleBuffer !== null, "缺少 " + bundlePath);
check(typesBuffer !== null, "缺少 " + typesPath);
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

function decode(buffer, label) {
  try {
    return decoder.decode(buffer);
  } catch (error) {
    failures.push(label + " 不是严格 UTF-8: " + error.message);
    return null;
  }
}

const manifestText = decode(manifestBuffer, "manifest.json");
const bundleText = decode(bundleBuffer, "bundle.js");
const typesText = decode(typesBuffer, "types.d.ts");

let manifest = null;
if (manifestText !== null) {
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    failures.push("manifest.json 不是合法 JSON: " + error.message);
  }
}

const bundleStat = await stat(bundlePath);
const typesStat = await stat(typesPath);

if (manifest) {
  check(
    JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(expectedManifestKeys),
    "manifest.json 键必须是 " + expectedManifestKeys.join(", ") + "，实际为 " + Object.keys(manifest).sort().join(", ")
  );
  check(manifest.schemaVersion === 1, "schemaVersion 必须是数字 1");
  if (typeof manifest.id === "string") {
    check(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(manifest.id), "id 非法: " + manifest.id);
    check(!manifest.id.endsWith("."), "id 不能以点结尾");
    check(!windowsReservedNames.has(manifest.id.split(".")[0].toUpperCase()), "id 首段是 Windows 设备保留名");
    check(!["antdesign", "echarts"].includes(manifest.id.toLowerCase()), "id 不能使用内置预设库保留名");
  } else {
    failures.push("id 必须是字符串");
  }
  if (typeof manifest.version === "string") {
    check(semverPattern.test(manifest.version), "version 不是合法 SemVer: " + manifest.version);
  } else {
    failures.push("version 必须是字符串");
  }
  if (typeof manifest.globalName === "string") {
    check(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(manifest.globalName), "globalName 不是单个合法标识符: " + manifest.globalName);
    check(!javascriptReservedWords.has(manifest.globalName), "globalName 不能是 JavaScript 保留字");
    check(!hostReservedGlobalNames.has(manifest.globalName), "globalName 不能使用宿主保留名: " + manifest.globalName);
  } else {
    failures.push("globalName 必须是字符串");
  }
  check(
    typeof manifest.name === "string" && manifest.name.trim().length > 0 && manifest.name.length <= 128,
    "name 必填且 <= 128 字符"
  );
  if (typeof manifest.name === "string") {
    check(!/\p{Cc}/u.test(manifest.name), "name 不能包含控制字符");
    check(!["antdesign", "echarts"].includes(manifest.name.toLowerCase()), "name 不能使用内置预设库保留名");
  }
  check(
    typeof manifest.description === "string" && manifest.description.trim().length > 0 && manifest.description.length <= 20000,
    "description 必填且 <= 20000 字符"
  );
  check(Buffer.byteLength(manifestText, "utf8") <= 64 * 1024, "manifest.json 超过 64 KiB");
  check(bundleStat.size <= 8 * 1024 * 1024, "bundle.js 超过 8 MiB");
  check(typesStat.size <= 4 * 1024 * 1024, "types.d.ts 超过 4 MiB");
}

if (typesText !== null && manifest && typeof manifest.globalName === "string") {
  const escapedGlobal = manifest.globalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const globalDeclaration = new RegExp(
    "\\b(?:declare\\s+(?:const|let|var|class|function|namespace)|export\\s+as\\s+namespace)\\s+" + escapedGlobal + "(?![A-Za-z0-9_$])"
  );
  check(globalDeclaration.test(typesText), "types.d.ts 没有声明 " + manifest.globalName);
  check(!/^\s*import\s/m.test(typesText), "types.d.ts 不得包含顶层 import");
  check(!/^\s*export\s*=\s*/m.test(typesText), "types.d.ts 不得使用顶层 export =（会使 declare namespace 失去全局提示）");
  check(!/^\s*export\s+default\b/m.test(typesText), "types.d.ts 不得包含顶层 export default");
  check(!/^\s*export\s*\{/m.test(typesText), "types.d.ts 不得包含顶层 export 列表");

  const declaredGlobal = new RegExp("\\b(?:declare\\s+(?:const|let|var|class|function|namespace))\\s+" + escapedGlobal + "(?![A-Za-z0-9_$])");
  if (/^\s*export\s+as\s+namespace\s/m.test(typesText)) {
    console.error("提醒：types.d.ts 使用了 export as namespace，必须在真实 Monaco 中确认 " + manifest.globalName + ". 可补全，上传正则通过不代表提示可用。");
  } else {
    check(declaredGlobal.test(typesText), "types.d.ts 缺少 declare 全局声明");
  }
}

if (bundleText !== null) {
  check(!/^\s*(?:import|export)\s/m.test(bundleText), "bundle.js 仍包含顶层模块语法");
  check(!/\bimport\s*\(/.test(bundleText), "bundle.js 仍包含动态 import()（若仅在字符串或注释中，请用 AST 确认）");
  try {
    new Script(bundleText, { filename: bundlePath });
  } catch (error) {
    failures.push("bundle.js 不是可解析的经典脚本: " + error.message);
  }
}

const sha256 = value => createHash("sha256").update(value).digest("hex").toUpperCase();

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  manifest,
  bundleBytes: bundleStat.size,
  typesBytes: typesStat.size,
  bundleSha256: sha256(bundleBuffer),
  typesSha256: sha256(typesBuffer)
}, null, 2));
