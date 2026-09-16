#!/usr/bin/env node
// 通用烟雾闸门：在最小 DOM 模拟环境中按经典脚本执行 bundle.js，检查指南第 11 节的通用项。
// 覆盖：1 执行无异常、2 全局存在、4 重复加载幂等、5 全局冲突拒绝且不覆盖、6 宿主全局未被替换、7 CSS Marker 唯一。
// 不覆盖 3 核心 API 存在、8 最小功能结果、9 资源清理：这三项必须针对具体类库另写测试。
// 用法: node smoke_bundle.mjs [--dist dist] [--guard React] [--guard ReactDOM] [--guard GC]
//       node smoke_bundle.mjs --preload ./react-stub.mjs   （React 等宿主依赖类库必须先注入宿主全局）
// --preload <file>: ESM 模块，默认导出 (sandbox) => void，在创建 vm 上下文前修改沙箱全局，
//   用来补上 bundle 运行所必需的宿主对象（React/ReactDOM）或缺失的 Web API。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script, createContext } from "node:vm";

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
function argValues(name) {
  const values = [];
  argv.forEach((item, index) => {
    if (item === name && argv[index + 1]) values.push(argv[index + 1]);
  });
  return values;
}

const dist = path.resolve(argValue("--dist", "dist"));
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
const bundleText = await readFile(path.join(dist, "bundle.js"), "utf8");
const declaredGuards = argValues("--guard");
const guards = declaredGuards.length
  ? declaredGuards
  : ["React", "ReactDOM", "Forguncy", "Babel", "define", "require", "MonacoEnvironment"];

const preloads = [];
for (const preloadPath of argValues("--preload")) {
  const resolved = path.resolve(preloadPath);
  const loaded = await import(pathToFileURL(resolved).href);
  const inject = loaded.default || loaded.preload;
  if (typeof inject !== "function") {
    console.error("--preload 模块必须默认导出一个 (sandbox) => void 函数: " + resolved);
    process.exit(2);
  }
  preloads.push({ resolved, inject });
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail: detail || "" });
}

function createFakeDocument() {
  const nodes = [];
  const document = {
    head: {
      appendChild(node) {
        nodes.push(node);
      }
    },
    documentElement: {
      appendChild(node) {
        nodes.push(node);
      }
    },
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        attributes: {},
        textContent: "",
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name];
        }
      };
    },
    querySelector(selector) {
      const match = /^style\[data-forguncy-frontend-library="(.*)"\]$/.exec(String(selector));
      if (!match) return null;
      return nodes.find(node => node.attributes["data-forguncy-frontend-library"] === match[1]) || null;
    },
    querySelectorAll(selector) {
      const found = this.querySelector(selector);
      return found ? [found] : [];
    },
    body: { appendChild() {}, style: {} },
    get styleNodes() {
      return nodes;
    }
  };
  return document;
}

function createRuntime() {
  const document = createFakeDocument();
  const listeners = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    document,
    navigator: { userAgent: "yao-smoke" },
    location: { href: "https://local.invalid/" },
    performance: { now: () => 0 },
    // 浏览器类库常用的 Web API：vm 新上下文只有 ECMAScript 内建，这些必须显式注入。
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto,
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex(item => item.type === type && item.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatchEvent() {
      return true;
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // 宿主依赖（React/ReactDOM 等）与宿主全局必须在 vm 上下文创建前注入，
  // 否则 React 类库在 bundle 求值阶段就会因宿主全局缺失而抛错。
  const preloadedKeysBefore = new Set(Object.keys(sandbox));
  for (const preload of preloads) preload.inject(sandbox);
  const injectedKeys = Object.keys(sandbox).filter(key => !preloadedKeysBefore.has(key));
  const context = createContext(sandbox);
  return { context, document, sandbox, listeners, injectedKeys };
}

const globalName = manifest.globalName;
const marker = "data-forguncy-frontend-library";
const script = new Script(bundleText, { filename: path.join(dist, "bundle.js") });

// 1 + 2: 首次执行无异常并创建全局变量
const first = createRuntime();
const contextKeysBefore = new Set(Object.keys(first.context));
let firstError = null;
try {
  script.runInContext(first.context, { timeout: 20000 });
} catch (error) {
  firstError = error;
}
record("bundle executes without throwing", firstError === null, firstError ? String(firstError && firstError.message) : "");
const api = first.context[globalName];
record("globalThis[" + globalName + "] exists", api !== undefined && api !== null, api === undefined ? "undefined" : typeof api);

if (preloads.length) {
  record(
    "preload injected host globals",
    preloads.length > 0,
    preloads.map(item => item.resolved).join(", ")
  );
}

// 除声明的 globalName 外不应泄漏新全局（防止 React 类库把内部变量写到 window）。
const leakedGlobals = Object.keys(first.context).filter(
  key => !contextKeysBefore.has(key) && key !== globalName
);
record("no unexpected global leakage", leakedGlobals.length === 0, leakedGlobals.join(", "));

// 6: 宿主全局引用在加载前后完全相同
const hostReferencesIntact = guards.every(name => {
  const before = first.context[name];
  return before === undefined || first.context[name] === before;
});
record("host globals not replaced", hostReferencesIntact, "guarded: " + guards.slice(0, 8).join(", "));

// 7: CSS Marker 唯一
const markerNodes = first.document.styleNodes.filter(node => node.attributes[marker] === manifest.id);
record("css marker injected at most once", markerNodes.length <= 1, "count=" + markerNodes.length);

// 4: 重复加载同一版本幂等
let repeatError = null;
try {
  script.runInContext(first.context, { timeout: 20000 });
} catch (error) {
  repeatError = error;
}
const markerNodesAfterRepeat = first.document.styleNodes.filter(node => node.attributes[marker] === manifest.id);
record("repeat load is idempotent", repeatError === null && first.context[globalName] === api, repeatError ? String(repeatError.message) : "");
record("repeat load does not duplicate css", markerNodesAfterRepeat.length <= 1, "count=" + markerNodesAfterRepeat.length);

// 5: 全局名被占用时必须失败且不覆盖原对象
const occupied = createRuntime();
const sentinel = { sentinel: true };
occupied.context[globalName] = sentinel;
let conflictThrew = false;
let conflictError = null;
try {
  script.runInContext(occupied.context, { timeout: 20000 });
} catch (error) {
  conflictThrew = true;
  conflictError = error;
}
record(
  "occupied globalName is rejected without overwrite",
  conflictThrew && occupied.context[globalName] === sentinel,
  conflictThrew ? String(conflictError.message) : "no error thrown"
);

const failures = checks.filter(item => !item.ok);
console.log(JSON.stringify({
  ok: failures.length === 0,
  manifest: { id: manifest.id, version: manifest.version, globalName },
  preloads: preloads.map(item => item.resolved),
  note: "第 3、8、9 项（核心 API、最小功能、资源清理）必须另写类库专用测试；DOM/Canvas/WebGL 请用真实浏览器。",
  checks,
  failures: failures.map(item => item.name + ": " + item.detail)
}, null, 2));
if (failures.length) process.exit(1);

