/**
 * The raw page-global escape hatch.
 *
 * This is deliberately **not** façade surface. #27's Problem section names
 * "ad-hoc access to host globals/props" as the coupling the façade exists to
 * remove, and `RUNTIME_FACADE_FORBIDDEN_PATTERNS` records reading a host value
 * off `globalThis` as a pattern authored source must not use.
 *
 * It stays exported because generated/runtime code — the compiler's output, a
 * probe, a diagnostic — legitimately needs to reach a global it has already
 * resolved by name, and `#5`'s user-scope table is exactly what makes that a
 * known set of names rather than a free-for-all. Application code should reach
 * capabilities through the façade contract instead; see `capabilities.ts` for
 * which ones are confirmed and `contract.ts` for how they are resolved.
 */

/**
 * Read a page global, refusing an absent one.
 *
 * Throwing rather than returning `undefined` is the point: `#5` records that
 * several names a cell may reference (`ForguncyReactHelper`, `props`,
 * `useDataSource`) are *not* window properties, so a silent `undefined` would
 * move the failure to whatever consumed the value.
 */
export function getHostGlobal<T>(name: string): T {
  const value = (globalThis as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`Forguncy host global is unavailable: ${name}`);
  }
  return value as T;
}
