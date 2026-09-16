// 包内目录布局：从任意脚本位置反推所属包的根与其标准子目录。
//
// 约定（见 docs/project-layout.md）：
//   packages/<id>/{package.json,src,scripts,tests,dist,artifacts}
// 无论脚本放在 scripts/ 还是 tests/，向上找到第一个 package.json 即为包根。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function toDirectory(startPath) {
  if (typeof startPath !== "string") {
    throw new TypeError("起始路径必须是 import.meta.url 或目录字符串");
  }
  if (startPath.startsWith("file:")) {
    return path.dirname(fileURLToPath(startPath));
  }
  return startPath;
}

export function findPackageRoot(startPath) {
  const startDirectory = toDirectory(startPath);
  let current = path.resolve(startDirectory);
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("找不到包含 package.json 的包根目录: " + startDirectory);
    }
    current = parent;
  }
}

export function packageLayout(startPath) {
  const root = findPackageRoot(startPath);
  const dist = path.join(root, "dist");
  return {
    root,
    src: path.join(root, "src"),
    scripts: path.join(root, "scripts"),
    tests: path.join(root, "tests"),
    dist,
    artifacts: path.join(root, "artifacts"),
    bundle: path.join(dist, "bundle.js"),
    entry: path.join(root, "src", "entry.js"),
    types: path.join(dist, "types.d.ts")
  };
}
