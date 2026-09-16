#!/usr/bin/env node
// 新包脚手架：templates/package -> packages/<id>
// 用法: vp new-package <id> [--global <GlobalName>] [--version <x.y.z>] [--name "<展示名>"] [--force]
//
// 命名规则见 docs/project-layout.md：
//   id 必须是小写 kebab-case（同时是 Forguncy 包 id、目录名、npm 作用域后缀）
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(repoRoot, "templates", "package");
const packagesDir = path.join(repoRoot, "packages");

function parseArgs(argv) {
  const options = { id: "", global: "", version: "0.0.0", name: "", force: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--global" || arg === "--version" || arg === "--name") {
      index += 1;
      if (!argv[index]) throw new Error(arg + " 缺少取值");
      options[arg.slice(2)] = argv[index];
    } else if (arg.startsWith("-")) throw new Error("未知参数: " + arg);
    else positional.push(arg);
  }
  if (!positional[0]) {
    throw new Error(
      "用法: node tooling/new-package.mjs <id> [--global <GlobalName>] [--version <x.y.z>] [--name \"<展示名>\"] [--force]"
    );
  }
  options.id = positional[0];
  return options;
}

function toPascalCase(id) {
  return id
    .split("-")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.id)) {
    throw new Error("包 id 必须是小写 kebab-case，且以字母或数字开头/结尾: " + options.id);
  }
  const globalName = options.global || toPascalCase(options.id);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) {
    throw new Error("globalName 必须是单个合法标识符: " + globalName);
  }
  const target = path.join(packagesDir, options.id);
  const existing = await readdir(packagesDir).catch(() => []);
  if (existing.includes(options.id) && !options.force) {
    throw new Error("已存在 " + target + "；加 --force 覆盖");
  }
  await mkdir(target, { recursive: true });
  await cp(templateDir, target, { recursive: true });

  const displayName = options.name || options.id + " for ReactCellType";
  const replacements = {
    __LIBRARY_ID__: options.id,
    __GLOBAL_NAME__: globalName,
    __VERSION__: options.version,
    __DISPLAY_NAME__: displayName
  };
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const text = await readFile(full, "utf8");
      const rendered = text.replace(
        /__LIBRARY_ID__|__GLOBAL_NAME__|__VERSION__|__DISPLAY_NAME__/g,
        match => replacements[match]
      );
      if (rendered !== text) await writeFile(full, rendered, "utf8");
    }
  }
  await walk(target);

  console.log(
    JSON.stringify({ id: options.id, globalName, version: options.version, displayName, path: target }, null, 2)
  );
  console.log("下一步：填 src/entry.js 门面 + src/types.d.ts 声明 → vp run --filter ./packages/" + options.id + " build");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
