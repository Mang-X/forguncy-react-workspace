// 类库专用行为断言。通用闸门（第 1/2/4/5/6/7 项）由 scripts/smoke.mjs 覆盖，
// 这里按技能 references/verify-locally.md 的第 3、8、9 项补齐：
//   3 核心 API 存在；8 最小功能得到确定结果；9 实例可销毁且资源得到清理。
// TODO: 针对目标类库补真实断言，别只留下面这几条占位。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script, createContext } from "node:vm";
import { hostReactStubPath, packageLayout } from "@forguncy-ext/pack-tools";

const dist = packageLayout(import.meta.url).dist;
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
const bundleText = await readFile(path.join(dist, "bundle.js"), "utf8");
const { default: injectHostReact } = await import(pathToFileURL(hostReactStubPath).href);

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail: detail === undefined ? "" : String(detail) });

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextEncoder,
  TextDecoder,
  URL,
  queueMicrotask
};
injectHostReact(sandbox);
const context = createContext(sandbox);
new Script(bundleText, { filename: path.join(dist, "bundle.js") }).runInContext(context, { timeout: 20000 });

const api = sandbox[manifest.globalName];
record("全局对象已创建", typeof api !== "undefined", typeof api);
record("id 与 manifest 一致", api && api.id === manifest.id, api && api.id);
record("version 与 manifest 一致", api && api.version === manifest.version, api && api.version);

const failures = checks.filter(check => !check.ok);
console.log(JSON.stringify({ id: manifest.id, version: manifest.version, globalName: manifest.globalName, checks, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
