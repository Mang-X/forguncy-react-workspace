// types.d.ts 是手写源码，放在 src/；构建时原样复制到 dist/，
// 这样 dist/ 可以整体由 build.mjs 重新生成、整体进 .gitignore。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function emitTypesDeclaration({ sourceTypesFile, outputDirectory }) {
  const types = await readFile(sourceTypesFile, "utf8");
  await mkdir(outputDirectory, { recursive: true });
  const target = path.join(outputDirectory, "types.d.ts");
  await writeFile(target, types, "utf8");
  return target;
}
