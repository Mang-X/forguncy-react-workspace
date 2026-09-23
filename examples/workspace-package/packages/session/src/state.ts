/**
 * The module-scope state `@app/session` exists to demonstrate — and nothing else.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening PoC"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/15), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * ## Why this is a separate file from the component
 *
 * Two reasons, and the second is the one that decided it.
 *
 * 1. **It is the thing #14's anti-claim is about.** The Spec's reuse-class table
 *    calls module-scope mutable state `delegated-required` *when a package relies on
 *    it being one instance per page*. This module is the counter-example: its state
 *    is per-Cell by construction, nothing here relies on cross-Cell identity, and
 *    `moduleIdentity` is left absent — which that type defines as `cell-local`.
 * 2. **It has no React import, so a test can import it directly.** The Cell compiler's
 *    isolation test needs to write to *the test process's own instance* of this module
 *    and assert that a compiled artifact cannot see the write — the one assertion
 *    that fails when a bundler leaves the package external or hoists it into a shared
 *    chunk. Importing a `.tsx` from under `packages/**` would pull React's JSX types
 *    into the typecheck project, where they are not yet wired (the repository
 *    bootstrap gap that keeps `examples/**` out of `tsconfig.typecheck.json`). Keeping
 *    the state in a React-free file makes that assertion typecheck, so the strong
 *    test exists instead of a weaker one that cannot fail.
 */

/**
 * Visits recorded per label, at module scope.
 *
 * A `Map` keyed by label rather than a counter, so a probe can tell its own writes
 * from another Cell's: if a second Cell's writes landed in this same Map, this Cell's
 * {@link seenLabels} would grow to include a label it never used.
 */
const visitsByLabel = new Map<string, number>();

/**
 * Record one visit for a label, answering that label's running total.
 *
 * The write is the instrument. A second Cell calling this with its own label must
 * not affect this Cell's read of {@link seenLabels}.
 */
export function recordVisit(label: string): number {
  const next = (visitsByLabel.get(label) ?? 0) + 1;
  visitsByLabel.set(label, next);
  return next;
}

/**
 * Every label this copy of the module has recorded, sorted.
 *
 * The leak detector: read during render, so it reports the state of the module
 * instance the Cell is actually running against.
 */
export function seenLabels(): readonly string[] {
  return [...visitsByLabel.keys()].sort();
}
