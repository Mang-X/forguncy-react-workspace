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
 * To test an absence, the shared source has to contain the two things whose sharing
 * is being denied. #14's reuse-class table names them:
 *
 * - **module-scope mutable state** — {@link recordVisit} writes to a module-level
 *   `Map`, and {@link seenLabels} reads it back. If two Cells shared a module
 *   instance, one Cell's write would appear in the other's read.
 * - **a React Context declared in the package** — {@link SessionLabelContext}.
 *   `createContext` runs when the module is evaluated, so two Cells sharing a module
 *   instance would share one Context object, and a provider in one Cell would be
 *   visible to the other.
 *
 * Both are *safe* here rather than forbidden, and that distinction is the point of
 * #14's table: this state is per-Cell by construction, nothing in this package relies
 * on cross-Cell identity, and `moduleIdentity` is therefore left absent — which that
 * Spec's type defines as `cell-local`. A package that *did* rely on sharing would
 * have to declare `moduleIdentity: { kind: "delegated", via }` and delegate the state
 * to a module the page loads once. This one deliberately does not.
 *
 * ## What the probe measures
 *
 * Two observations, one per class above, and they are deliberately different in
 * kind — the first is written by an interaction, the second is read at render:
 *
 * | attribute | reads | if the two Cells shared a module instance |
 * | --- | --- | --- |
 * | `data-session-labels` | every label *this* module copy has recorded | the other Cell's label would appear |
 * | `data-session-context` | what *this* Cell's tree reads from the Context | the other Cell's provider value would appear |
 *
 * A third, `data-session-own`, is this Cell's own `useState` — per mount in either
 * world, so it is the control: it proves the component rendered and its handler ran,
 * which is what keeps "the other value is absent" from being satisfiable by nothing
 * having happened.
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
 * Renders both observations, optionally behind a provider this Cell mounts.
 *
 * `provides` is what makes the Context half drivable from outside: one Cell is
 * configured with it and the other is not, so each renders what *its own* tree sees.
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
    // No provider: this Cell's tree reads the Context default, which is the value
    // the second Cell must observe.
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
  // Per mount in either world, so it is the control rather than the measurement: a
  // non-zero value proves this Cell's handler ran, which is what keeps the two
  // absences below from being satisfied by nothing having happened.
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
