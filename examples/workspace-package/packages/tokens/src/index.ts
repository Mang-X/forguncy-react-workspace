/**
 * `@app/tokens` — the second workspace package, imported by `@app/ui` by name.
 *
 * Decision source: GitHub Issue #15 (workspace package flattening PoC), under
 * #14's workspace-source contract.
 *
 * Two reasons this package is separate rather than folded into `@app/ui`:
 *
 * 1. It makes the workspace graph a *graph* — an entry (`@app/ui`) reaching
 *    another workspace package — so the compile exercises the transitive edge
 *    rather than a single-node lookup. `traceWorkspaceSourceClosure` walks it.
 * 2. `trimmed` is a pure function reached *through* `@app/ui`, and the Cell does
 *    not import it. It is the second half of the tree-shaking assertion: a name
 *    two hops from the entry must still be droppable, which a single-package test
 *    cannot show.
 *
 * It is type-only plus two constants at minimum, so it carries no `react` import
 * of its own: a package that exists to be flattened should not need a host
 * mapping to be flattened. `Money` is a type, erased before anything runs.
 */

export interface Money {
  readonly currency: string;
  readonly amount: number;
}

/** The corner rounding the shared component renders, in CSS pixels. */
export const SURFACE_RADIUS = 6;

/** The step between two surface sizes. */
export const SURFACE_STEP = 2;

/**
 * A pure helper the Cell never imports.
 *
 * Reached through `@app/ui`, so it is two workspace hops from the entry — which is
 * what makes the tree-shaking assertion cover the transitive case as well.
 */
export function trimmed(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
