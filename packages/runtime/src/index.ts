export function getHostGlobal<T>(name: string): T {
  const value = (globalThis as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`Forguncy host global is unavailable: ${name}`);
  }
  return value as T;
}
