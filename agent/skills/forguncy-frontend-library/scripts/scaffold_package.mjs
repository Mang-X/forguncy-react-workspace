#!/usr/bin/env node
// 生成前端扩展包骨架，两种模板二选一：
//   --template package   （默认）单包工作目录：一个目录 = 一个包，脚本平铺在根目录
//   --template monorepo  多包仓库：packages/<id>/ + tooling/pack-tools + vp 任务编排 + git-cliff
//
// 两种模板都把校验/打包/烟雾测试委托给技能脚本；骨架里的 ID、版本、全局名都是占位值，
// 必须按目标类库的真实分析结果改写后再构建。
// 不生成 lockfile：首次 pnpm install 时才生成 pnpm-lock.yaml，之后提交它以保证可复现。
//
// 用法:
//   node scaffold_package.mjs --dir <target> --id vendor-library --global VendorLibrary --version 1.2.3 \
//        [--name "<显示名>"] [--template package|monorepo]
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const dir = path.resolve(argValue("--dir", ""));
if (!dir || dir === path.resolve(".")) {
  console.error("需要 --dir <target>");
  process.exit(2);
}
const template = argValue("--template", "package");
const id = argValue("--id", "");
const globalName = argValue("--global", "");
const version = argValue("--version", "");
const displayName = argValue("--name", id + " for ReactCellType");
for (const [label, value] of [["--id", id], ["--global", globalName], ["--version", version]]) {
  if (!value) {
    console.error("缺少必填参数 " + label);
    process.exit(2);
  }
}
if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id) || id.endsWith(".")) {
  console.error("id 非法: " + id);
  process.exit(2);
}
if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
  console.error("globalName 必须是单个合法标识符: " + globalName);
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("version 必须是 SemVer: " + version);
  process.exit(2);
}

const templates = {
  package: {
    dir: "package-template",
    label: "单包工作目录",
    // 多包仓库才需要；单包模板没有成员骨架
    memberSkeleton: null
  },
  monorepo: {
    dir: "monorepo-template",
    label: "多包仓库（packages/<id> + tooling/pack-tools）",
    memberSkeleton: path.join("templates", "package")
  }
};
const selected = templates[template];
if (!selected) {
  console.error("未知模板: " + template + "（可选 package / monorepo）");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.dirname(here);
const scaffoldDir = path.join(skillRoot, "assets", selected.dir);

// <SKILL_ROOT> 只出现在模板里双引号包裹的 JS 字符串字面量中。
// Windows 路径的反斜杠必须先转义，否则 \W \P \f 会被当成转义序列，把路径吃成 C:WorkFileProject...
const skillRootLiteral = skillRoot.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const placeholderMap = {
  "__LIBRARY_ID__": id,
  "__GLOBAL_NAME__": globalName,
  "__VERSION__": version,
  "__DISPLAY_NAME__": displayName,
  "<SKILL_ROOT>": skillRootLiteral
};

function render(text) {
  return Object.entries(placeholderMap).reduce(
    (accumulated, [token, value]) => accumulated.split(token).join(value),
    text
  );
}

const written = [];
// macOS 会把 .DS_Store 混进资产目录，别让它污染生成出来的仓库
const skipNames = new Set([".DS_Store", "Thumbs.db"]);
// 这几个顶层目录要**原样**复制：它们的代码本身就写着占位符（new-package.mjs 的替换表、
// 成员骨架的待渲染副本），一渲染就把源码改坏了。
const rawTopLevelDirs = new Set(["tooling", "templates"]);

async function copyEntry(source, target, shouldRender) {
  const stats = await readdir(source, { withFileTypes: true });
  for (const entry of stats) {
    if (skipNames.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, shouldRender ? render(entry.name) : entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyEntry(from, to, shouldRender);
      continue;
    }
    await mkdir(path.dirname(to), { recursive: true });
    const text = await readFile(from, "utf8");
    await writeFile(to, shouldRender ? render(text) : text, "utf8");
    written.push(path.relative(dir, to).split(path.sep).join("/"));
  }
}

await mkdir(dir, { recursive: true });
const topLevel = await readdir(scaffoldDir, { withFileTypes: true });
for (const entry of topLevel) {
  if (skipNames.has(entry.name)) continue;
  const from = path.join(scaffoldDir, entry.name);
  const to = path.join(dir, render(entry.name));
  if (entry.isDirectory()) {
    await mkdir(to, { recursive: true });
    await copyEntry(from, to, !rawTopLevelDirs.has(entry.name));
    continue;
  }
  await writeFile(to, render(await readFile(from, "utf8")), "utf8");
  written.push(path.relative(dir, to).split(path.sep).join("/"));
}

// 多包仓库：成员骨架保留一份未渲染的副本（已随 templates/ 原样复制），
// 再用同一份骨架渲染出第一个包 packages/<id>。
if (selected.memberSkeleton) {
  const skeleton = path.join(scaffoldDir, selected.memberSkeleton);
  await copyEntry(skeleton, path.join(dir, "packages", id), true);
}

const nextByTemplate = {
  package: [
    "按类库真实分析结果改写 src/entry.js 与 build.mjs 里的 manifest 配置",
    "在 package.json 里把 __LIBRARY_ID__ / __VERSION__ 依赖项改成目标类库的真实名称与固定版本",
    "pnpm install（首次会生成 pnpm-lock.yaml，请提交它）",
    "pnpm run build && pnpm run validate && pnpm run smoke && pnpm run pack"
  ],
  monorepo: [
    "装技能副本，让 CI 与全新克隆也能跑门禁：npx skills@latest add MangMax/forguncy-frontend-library -s forguncy-frontend-library -y",
    "在 packages/" + id + "/package.json 里把 TODO_TARGET_LIBRARY 换成目标类库的真实名称与固定版本",
    "填 packages/" + id + "/src/entry.js 门面、src/types.d.ts 声明，以及 build.mjs 里的 description",
    "vp install（首次会生成 pnpm-lock.yaml，请提交它）",
    "vp run --filter ./packages/" + id + " gates && vp run --filter ./packages/" + id + " pack",
    "要加第二个包：vp run new-package <新id> --global <GlobalName> --version <x.y.z>"
  ]
};

console.log(JSON.stringify({
  ok: true,
  template,
  templateLabel: selected.label,
  workdir: dir,
  firstPackage: selected.memberSkeleton ? path.join(dir, "packages", id) : null,
  writtenCount: written.length,
  written,
  next: nextByTemplate[template]
}, null, 2));
