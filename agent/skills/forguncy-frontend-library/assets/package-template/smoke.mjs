import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = process.env.FORGUNCY_LIBRARY_SKILL_ROOT || "<SKILL_ROOT>";
const shared = path.join(skillRoot, "scripts", "smoke_bundle.mjs");
if (!existsSync(shared)) {
  console.error("找不到 " + shared + "；请设置 FORGUNCY_LIBRARY_SKILL_ROOT 指向 forguncy-frontend-library 技能根目录。");
  process.exit(2);
}
const extra = process.argv.slice(2);
const result = spawnSync(process.execPath, [shared, "--dist", path.join(here, "dist"), ...extra], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
