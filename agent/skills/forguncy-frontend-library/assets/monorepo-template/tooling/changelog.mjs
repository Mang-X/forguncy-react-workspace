#!/usr/bin/env node
// 变更日志：根目录一份全量 changelog，每个包一份按路径过滤的 changelog。
// 依赖 git-cliff（brew install git-cliff）。
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(repoRoot, "cliff.toml");
const packagesDir = path.join(repoRoot, "packages");

function run(args, collectOutput) {
  const result = spawnSync("git-cliff", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    console.error("git-cliff 失败: git-cliff " + args.join(" "));
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status === null ? 1 : result.status);
  }
  return collectOutput ? result.stdout : "";
}

if (spawnSync("git-cliff", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error("未找到 git-cliff，请先安装：brew install git-cliff");
  process.exit(1);
}

const baseArgs = ["--config", configFile, "--output"];
run([...baseArgs, path.join(repoRoot, "CHANGELOG.md")]);
console.log("已生成 CHANGELOG.md");

const directories = (await readdir(packagesDir, { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

for (const directory of directories) {
  if (!existsSync(path.join(packagesDir, directory, "package.json"))) continue;
  const target = path.join(packagesDir, directory, "CHANGELOG.md");
  const previous = await readFile(target, "utf8").catch(() => null);
  run([
    "--config",
    configFile,
    "--include-path",
    "packages/" + directory + "/**",
    "--include-path",
    "tooling/**",
    "--output",
    target
  ]);
  const next = await readFile(target, "utf8");
  console.log("已生成 packages/" + directory + "/CHANGELOG.md" + (previous === next ? "（无变化）" : ""));
}
