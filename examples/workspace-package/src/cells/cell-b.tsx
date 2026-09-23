/**
 * Cell B of the two-Cell anti-claim probe.
 *
 * Decision source: GitHub Issue #15 (workspace package flattening PoC), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * The counterpart to {@link AppA}, differing in two deliberate ways:
 *
 * - **It mounts no Context Provider.** Cell A does, so each Cell renders what its own
 *   tree provides and the page shows `WORKSPACE_CONTEXT_SEMANTICS` as a mounted fact.
 *   This is *not* the anti-claim's evidence — a Provider in another React root cannot
 *   supply a Consumer here even if the two artifacts shared one Context object, so
 *   reading the default says nothing about module identity.
 * - **It writes under a different label.** The module-scope `Map` is what carries the
 *   anti-claim: each Cell's `seenLabels()` must name only its own label.
 *
 * ## The identity probe
 *
 * Cell A published its Context reference under `__fgcContextIdentity["cell-a"]`. This
 * Cell compares that entry against its **own** reference with `Object.is` and reports
 * the answer on `window.__fgcContextIdentity["cell-b-matches-cell-a"]` — so the page
 * answers the question the rendered Provider/Consumer pair cannot: did the two
 * artifacts create one Context object, or two?
 *
 * `undefined` (the key is absent) means Cell A had not published when this ran, which
 * is a sequencing fact rather than an answer, and is reported as such rather than as
 * `false`.
 */

import { SessionProbe, sessionContextIdentity } from "@app/session";

/** The same page-level channel Cell A publishes into. A probe, not a feature. */
const IDENTITY_REGISTRY_KEY = "__fgcContextIdentity";

export function App() {
  if (typeof window !== "undefined") {
    const registry = ((window as unknown as Record<string, unknown>)[IDENTITY_REGISTRY_KEY] ??= {}) as Record<
      string,
      unknown
    >;
    // `in` rather than a truthiness test: the published value is an object reference,
    // and "Cell A has not run yet" must not be confused with "the identities differ".
    registry["cell-b-matches-cell-a"] = "cell-a" in registry ? Object.is(registry["cell-a"], sessionContextIdentity()) : undefined;
  }

  return <SessionProbe label="cell-b" />;
}
