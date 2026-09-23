/**
 * `@app/session` — the workspace package that makes #14's anti-claim testable.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening PoC"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/15), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * ## Why this package exists at all
 *
 * Every other package in this PoC demonstrates something that *works*: a component
 * renders, a function computes. This one exists so an **absence** can be observed,
 * and it is the only way to reach #14's `real-runtime` guarantee:
 *
 * > Two cells importing the same workspace package share no module state unless the
 * > identity was delegated, so a provider in one cell is invisible to the other.
 *
 * To test an absence, the shared source has to contain the state whose sharing is
 * being denied, and #14's reuse-class table names the class:
 *
 * - **module-scope mutable state** — {@link recordVisit} writes to a module-level
 *   `Map`, and {@link seenLabels} reads it back. If two Cells shared a module
 *   instance, one Cell's write would appear in the other's read. **This is the
 *   observation the anti-claim rests on.**
 *
 * The package also declares a React Context ({@link SessionLabelContext}), because
 * that is the other class #14's table names — but **it is not evidence of module
 * identity, and the probe's `data-session-context` attribute must not be read as
 * such.** Two Cells are two independent React roots, and a Context value is resolved
 * along the *ancestor chain of the tree doing the reading*. A Provider in one root
 * cannot supply a Consumer in another root **even when both roots share one and the
 * same Context object** — verified directly with `react-dom/server` against a single
 * shared `createContext` result, where the second root's Consumer read the default
 * while the first root's Provider was mounted. So `context=(none)` in one Cell proves
 * only that no Provider is mounted in *that* tree; it says nothing about whether the
 * two artifacts created different Context objects.
 *
 * This file previously claimed the opposite — that a shared module instance would
 * make one Cell's Provider visible to the other — and that claim was wrong. It is
 * recorded rather than quietly deleted because it is the intuitive reading, and the
 * next person to look at this probe will have the same intuition.
 *
 * The Context is kept for what it *is* good for: showing that a Context declared in a
 * workspace package is local to the Cell's React tree, which is #14's
 * `WORKSPACE_CONTEXT_SEMANTICS` as a mounted page rather than as prose.
 *
 * Both classes are *safe* here rather than forbidden, and that distinction is the
 * point of #14's table: this state is per-Cell by construction, nothing in this
 * package relies on cross-Cell identity, and `moduleIdentity` is therefore left
 * absent — which that Spec's type defines as `cell-local`. A package that *did* rely
 * on sharing would have to declare `moduleIdentity: { kind: "delegated", via }` and
 * delegate the state to a module the page loads once. This one deliberately does not.
 *
 * ## What the probe measures
 *
 * | attribute | reads | what its absence proves |
 * | --- | --- | --- |
 * | `data-session-labels` | every label *this* module copy has recorded | that this Cell's module instance has not seen another Cell's writes — **the anti-claim** |
 * | `data-session-context` | what *this* Cell's tree reads from the Context | only that no Provider is mounted in this tree — **not** a module-identity claim |
 * | `data-session-own` | this Cell's own `useState` | nothing about sharing; the control that the component rendered and its handler ran |
 */

import { createContext, useContext, useState } from "react";

// ---------------------------------------------------------------------------
// The module-scope state: shared if, and only if, the module instance is
// ---------------------------------------------------------------------------

// Re-exported from `./state`, which holds it in a React-free file so the Cell
// compiler's isolation test can import *this* module's instance directly and assert
// that a compiled artifact cannot observe a write to it. See that file's header.
import { recordVisit, seenLabels } from "./state";

export { recordVisit, seenLabels };

// ---------------------------------------------------------------------------
// The Context: one object per module evaluation
// ---------------------------------------------------------------------------

/**
 * A Context declared in the workspace package — the case #14 singles out as
 * counter-intuitive:
 *
 * > a React Context declared in a workspace package is local to the Cell's React
 * > tree: each cell that inlines the package evaluates that module separately, so a
 * > Context created there is a different object per cell, and a provider mounted in
 * > one cell is invisible to another.
 *
 * The `null` default is what a consumer reads when no provider is mounted *in its own
 * tree* — which is precisely what the second Cell must observe while the first has a
 * provider mounted.
 */
const SessionLabelContext = createContext<string | null>(null);

/** What this tree's Context carries, or `null` when no provider is mounted in it. */
export function useSessionLabel(): string | null {
  return useContext(SessionLabelContext);
}

/**
 * This Cell's own `SessionLabelContext` object, for an identity comparison across
 * Cells.
 *
 * ## Why this exists when the rendered probe already covers the Context
 *
 * It does not, and that is the point. A Provider/Consumer pair in two sibling React
 * roots **cannot** show whether the two artifacts created one Context object or two:
 * value resolution walks the reading tree's ancestor chain, so a Consumer in root B
 * reads the default whether or not root A's Provider and root B's Consumer share a
 * Context object. An earlier version of this package claimed otherwise.
 *
 * Observing object identity needs the objects themselves, so this exposes the
 * reference. **The package does not publish it anywhere** — reaching a page global is
 * application code's business, not a shared package's, and the Cell entries that do it
 * are the probe's harness. A Cell that never asks gets the reference and does nothing
 * with it.
 */
export function sessionContextIdentity(): unknown {
  return SessionLabelContext;
}

// ---------------------------------------------------------------------------
// The probe each Cell renders
// ---------------------------------------------------------------------------

export interface SessionProbeProps {
  /** Identifies this Cell, and the label its module-scope writes are recorded under. */
  readonly label: string;
  /** When set, this Cell mounts a provider carrying this value. */
  readonly provides?: string;
}

/**
 * Renders the module-scope observation, optionally behind a provider this Cell mounts.
 *
 * `provides` is what makes the Context half drivable from outside: one Cell is
 * configured with it and the other is not, so each renders what *its own* tree sees.
 * **That is all it shows** — that a Context declared in a workspace package is local
 * to the Cell's React tree, which is #14's `WORKSPACE_CONTEXT_SEMANTICS` as a mounted
 * page. It is *not* evidence about module identity: see this file's header, and note
 * that a Provider in one root cannot supply a Consumer in another even when both roots
 * share one Context object.
 *
 * The provider wraps {@link SessionProbeBody} rather than the body being this
 * component's own JSX, and that shape is load-bearing rather than stylistic:
 * `useContext` reads the nearest provider **above** the calling component, so a hook
 * called in this function would sit outside the provider this function returns and
 * would read the default in every Cell. The first version of this file did exactly
 * that, and both Cells rendered `context=(none)` — including the one mounting a
 * provider, which is what gave it away. Reading the Context has to happen in a
 * component the provider is an ancestor of.
 */
export function SessionProbe({ label, provides }: SessionProbeProps) {
  if (provides === undefined) {
    // No provider mounted here, so this tree reads the Context default.
    return <SessionProbeBody label={label} />;
  }
  return (
    <SessionLabelContext.Provider value={provides}>
      <SessionProbeBody label={label} />
    </SessionLabelContext.Provider>
  );
}

/** The body, which is a descendant of any provider this Cell mounts. */
function SessionProbeBody({ label }: { readonly label: string }) {
  // Per mount in either world, so it is the control rather than a measurement: a
  // non-zero value proves this Cell's handler ran, which is what keeps the
  // `labels` absence from being satisfied by nothing having happened.
  const [own, setOwn] = useState(0);
  const contextValue = useSessionLabel();
  const labels = seenLabels();

  return (
    <section data-session-probe={label}>
      <h3>{`session probe: ${label}`}</h3>
      <output data-session-own={String(own)}>{`own=${own}`}</output>
      <button
        type="button"
        onClick={() => {
          // The module-scope write. `setOwn` only re-renders so `seenLabels()` is
          // re-read; the count itself comes from the module, not from React state.
          recordVisit(label);
          setOwn(current => current + 1);
        }}
      >
        record-visit
      </button>
      <output data-session-labels={labels.join(",")}>{`labels=${labels.join(",") || "(none)"}`}</output>
      <output data-session-context={contextValue ?? "(none)"}>{`context=${contextValue ?? "(none)"}`}</output>
    </section>
  );
}
