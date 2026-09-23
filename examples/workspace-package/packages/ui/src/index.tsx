/**
 * `@app/ui` — the shared workspace package #15 compiles into a Cell artifact.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening
 * PoC" (https://github.com/Mang-X/forguncy-react-workspace/issues/15), exercising
 * the contract merged as #14 — "Spec: local workspace packages are source
 * dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * This is ordinary React source, written the way a monorepo author writes it. It
 * imports `react` by name, it imports its sibling `@app/tokens` by name, and it
 * never mentions a Cell, a bundler, or Forguncy. That is the whole point of the
 * PoC: if flattening required the package to know it was being flattened, the
 * development-stage sharing would not be sharing.
 *
 * Three exports are load-bearing for the criteria #14 could not evidence and
 * moved here:
 *
 * 1. {@link ThemeScope} is a real React component, so "a shared React component
 *    renders in a real ReactCellType runtime" is a component and not a greeting.
 * 2. {@link formatMoney} is a pure domain helper the Cell *does* import, and
 *    {@link excerpt} is one it does not — the pair is what tree-shaking is
 *    asserted against (the used name is present, the unused one is gone).
 * 3. The package imports `react` and `@app/tokens` by name, so the compile walks
 *    two different kinds of edge through the real workspace graph: a third-party
 *    decision (`react` → `host`) and a workspace edge (`@app/tokens`).
 *
 * `sideEffects: false` in this directory's `package.json` is not decoration: it
 * is the fact the bundler reads to decide whether an unused export may be dropped.
 */

import { SURFACE_RADIUS, SURFACE_STEP } from "@app/tokens";
import { useState } from "react";

import type { ReactNode } from "react";
import type { Money } from "@app/tokens";

export interface ThemeScopeProps {
  /** The label shown above the shared component's own content. */
  readonly title: string;
  /** Rendered inside the scope, so the example can prove children arrive. */
  readonly children?: ReactNode;
}

/**
 * A shared component with local state, rendered inside a Cell.
 *
 * It declares local `useState` deliberately. #14's reuse-class table calls a
 * component "cell-local": its state belongs to each mount, not to the package, so
 * a second Cell inlining this source gets its own counter. That is the behaviour
 * the component should have, and building it into the PoC keeps the reuse-class
 * table's `components-and-hooks` row honest rather than theoretical.
 *
 * The `react` import is what the compile has to map to the host global: a copy of
 * React bundled here would give this component a second React identity, which is
 * exactly what #9's host bridge exists to prevent.
 */
export function ThemeScope({ title, children }: ThemeScopeProps) {
  const [clicks, setClicks] = useState(0);

  return (
    <section data-workspace-component="theme-scope" data-surface-radius={String(SURFACE_RADIUS)}>
      <h2>{title}</h2>
      {children}
      <button type="button" onClick={() => setClicks(current => current + 1)}>
        {`clicks=${clicks}`}
      </button>
      <small>{`step=${SURFACE_STEP}`}</small>
    </section>
  );
}

/**
 * A pure function the Cell imports.
 *
 * Pure in #14's sense — same arguments, same answer, no module state — which is
 * why the reuse-class table calls this class `always-safe`.
 */
export function formatMoney(value: Money): string {
  return `${value.currency} ${value.amount.toFixed(2)}`;
}

/**
 * An export the Cell deliberately does **not** import.
 *
 * The name is a stable, distinctive marker so the tree-shaking assertion can be a
 * substring test on the compiled artifact rather than a module-graph
 * introspection. Its absence from the artifact is the evidence; see
 * `workspace-package-poc.test.ts`, which asserts both directions — the used
 * helper is present *and* this one is gone — because "the artifact is empty" would
 * otherwise pass a one-sided test.
 */
export function excerpt(text: string, maxLength = 24): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
