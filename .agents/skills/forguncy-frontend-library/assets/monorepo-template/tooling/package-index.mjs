#!/usr/bin/env node
// 包清单：汇总 packages/* 的 id / 版本 / 全局名 / 产物，供 README 与人工核对。
// 用法: vp packages [--write]            （--write 时写入 docs/packages.md）
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");
const write = process.argv.includes("--write");

async function readPackage(directory) {
  const packageJson = JSON.parse(await readFile(path.join(packagesDir, directory, "package.json"), "utf8"));
  const manifestPath = path.join(packagesDir, directory, "dist", "manifest.json");
  const manifest = await readFile(manifestPath, "utf8").catch(() => null);
  return {
    id: directory,
    name: packageJson.name,
    version: packageJson.version,
    globalName: manifest ? JSON.parse(manifest).globalName : "（未构建）",
    built: Boolean(manifest)
  };
}

const entries = (await readdir(packagesDir, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const rows = await Promise.all(entries.map(readPackage));

const lines = [
  "# 包清单",
  "",
  "由 `vp run packages --write` 生成，请勿手工编辑。",
  "",
  "| 目录 / id | npm 包名 | 版本 | 全局名 | 已构建 |",
  "|---|---|---|---|---|",
  ...rows.map(row =>
    "| `packages/" + row.id + "` | `" + row.name + "` | " + row.version + " | `" + row.globalName + "` | " +
    (row.built ? "是" : "否") + " |"
  ),
  ""
];
const markdown = lines.join("\n");

if (write) {
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await writeFile(path.join(repoRoot, "docs", "packages.md"), markdown, "utf8");
  console.log("已写入 docs/packages.md");
} else {
  process.stdout.write(markdown);
}
