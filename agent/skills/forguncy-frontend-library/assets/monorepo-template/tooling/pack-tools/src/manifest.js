// manifest.json 的字段与顺序必须与平台期望一致：
// schemaVersion / id / name / version / globalName / description。
export function buildManifest(config) {
  const { schemaVersion = 1, id, name, version, globalName, description } = config;
  for (const [key, value] of Object.entries({ id, name, version, globalName, description })) {
    if (typeof value !== "string" || value === "") {
      throw new Error("manifest 字段缺失或非法: " + key);
    }
  }
  return {
    schemaVersion,
    id,
    name,
    version,
    globalName,
    description
  };
}
