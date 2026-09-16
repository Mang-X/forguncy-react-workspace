// 通用三件套脚本（静态校验 / 烟雾闸门 / 打包）由 forguncy-frontend-library 技能提供，
// 本仓库不复制，只调用。技能根目录按以下顺序解析（先命中先用）：
//   1. 环境变量 FORGUNCY_LIBRARY_SKILL_ROOT                     —— 想用本机另一份技能时用它覆盖
//   2. 向上逐级查找 <dir>/.forguncy-skill-root 文件             —— 本地便利配置（已 gitignore）
//   3. 向上逐级查找 <dir>/.agents/skills/forguncy-frontend-library —— 随仓库安装的技能副本，CI 与全新克隆都可用
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ENV_NAME = "FORGUNCY_LIBRARY_SKILL_ROOT";
const POINTER_FILE = ".forguncy-skill-root";
const VENDORED_SKILL = ["skills", "forguncy-frontend-library"];
const SKILL_SCRIPTS = ["validate_package.mjs", "smoke_bundle.mjs", "pack_package.mjs", "scaffold_package.mjs"];

function isSkillRoot(candidate) {
  return existsSync(path.join(candidate, "scripts", SKILL_SCRIPTS[0]));
}

export function resolveSkillRoot(startPath = process.cwd()) {
  const candidates = [];
  if (process.env[ENV_NAME]) {
    candidates.push(path.resolve(process.env[ENV_NAME]));
  }
  let current = path.resolve(startPath);
  for (;;) {
    candidates.push(path.join(current, ".agents", ...VENDORED_SKILL));
    const pointer = path.join(current, POINTER_FILE);
    if (existsSync(pointer)) {
      const recorded = readFileSync(pointer, "utf8").trim();
      if (recorded) candidates.push(path.resolve(current, recorded));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    if (isSkillRoot(candidate)) return candidate;
  }
  console.error(
    "找不到 forguncy-frontend-library 技能根目录，已尝试：\n" +
      "  1. 环境变量 " + ENV_NAME + "\n" +
      "  2. 各级目录的 " + POINTER_FILE + "\n" +
      "  3. 各级目录的 .agents/" + VENDORED_SKILL.join("/") + "\n" +
      "随仓库的技能副本可用 `npx skills@latest add MangMax/forguncy-frontend-library -s forguncy-frontend-library -y` 安装。"
  );
  process.exit(2);
}

export function runSkillScript(scriptName, args = []) {
  if (!SKILL_SCRIPTS.includes(scriptName)) {
    console.error("不允许调用的通用脚本: " + scriptName);
    process.exit(2);
  }
  const root = resolveSkillRoot();
  const scriptPath = path.join(root, "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    console.error("通用脚本不存在: " + scriptPath + "（技能版本可能不匹配）");
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
