import { readFileSync } from "node:fs";

export function read(path) {
  return readFileSync(path, "utf8");
}
