// 通用静态校验：委托 forguncy-frontend-library 技能的 validate_package.mjs。
import { packageLayout, runSkillScript } from "@forguncy-ext/pack-tools";

runSkillScript("validate_package.mjs", ["--dist", packageLayout(import.meta.url).dist]);
