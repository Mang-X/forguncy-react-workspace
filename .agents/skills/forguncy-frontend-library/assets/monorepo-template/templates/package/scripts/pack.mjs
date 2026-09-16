// 打标准 ZIP：根目录只有 manifest.json / bundle.js / types.d.ts，落到 artifacts/<id>-<version>.zip。
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { packageLayout, runSkillScript } from "@forguncy-ext/pack-tools";

const layout = packageLayout(import.meta.url);
const manifest = JSON.parse(await readFile(path.join(layout.dist, "manifest.json"), "utf8"));
await mkdir(layout.artifacts, { recursive: true });

runSkillScript("pack_package.mjs", [
  "--dist",
  layout.dist,
  "--out",
  path.join(layout.artifacts, manifest.id + "-" + manifest.version + ".zip")
]);
