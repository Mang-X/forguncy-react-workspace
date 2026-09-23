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
 * ## The identity probe: both Cells publish, the harness compares
 *
 * This Cell publishes its Context reference under `__fgcContextIdentity["cell-b-published"]`,
 * exactly as Cell A publishes under `"cell-a-published"`, and compares nothing.
 *
 * **The harness** — the local test, or the browser check on the page — reads both
 * references and does the comparison and its control itself. That division replaced a
 * design that did not survive a mutation test: an earlier version had this Cell compare
 * and report a verdict, with a self-comparison as its positive control, and hardcoding
 * that verdict to `false` left every test green, because the control and the claim were
 * two separate expressions. With the comparison in the harness there is no verdict in
 * any Cell for a defect to falsify — only two references — and the harness is where a
 * control and its claim can share one comparator.
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

    // Pure data, exactly like Cell A: this Cell's own Context reference.
    registry["cell-b-published"] = sessionContextIdentity();
  }

  return <SessionProbe label="cell-b" />;
}
