/**
 * Cell A of the two-Cell anti-claim probe.
 *
 * Decision source: GitHub Issue #15 (workspace package flattening PoC), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * ## Why there are two entries rather than one
 *
 * #14's `cells-do-not-share-workspace-module-state` is a claim about *two* Cells, so
 * a single artifact cannot evidence it: the whole question is whether two separately
 * compiled Cells, both importing `@app/session` by name, end up sharing a module
 * instance on one page. Two entries compiled into two artifacts and mounted on one
 * page is the only arrangement that can answer it.
 *
 * ## Two observations, and they are not equally strong
 *
 * **The module-scope `Map` carries the anti-claim.** `label` keys this Cell's writes,
 * so after both Cells have recorded visits each Cell's `seenLabels()` must name only
 * its own label. A shared module instance would make one Cell name the other's.
 *
 * **The Context Provider does not carry it.** `provides` mounts a Provider so the page
 * shows #14's `WORKSPACE_CONTEXT_SEMANTICS` as a mounted fact. It is *not* evidence of
 * module identity: two Cells are two React roots, and a Context value is resolved
 * along the reading tree's ancestor chain, so a Provider in one root cannot supply a
 * Consumer in another **even when both roots share one Context object**. Cell B
 * reading the default proves only that no Provider is mounted in B's tree.
 *
 * ## The identity probe: both Cells publish, the harness compares
 *
 * Object identity has to be observed by comparing the objects, which needs a channel
 * both Cells can reach. `window` is that channel — and it is *this file's* choice
 * rather than the package's: `@app/session` exposes its Context reference and reaches
 * no global itself.
 *
 * Neither Cell compares anything. Each publishes its own reference under
 * `__fgcContextIdentity["cell-a-published"]`, and the **harness** — the local test, or the browser
 * check on the page — does `Object.is` between the two published values and its own
 * control.
 *
 * That division is deliberate, and it replaced a design that did not survive a
 * mutation test. An earlier version had Cell B compare and report a verdict, with a
 * self-comparison as its positive control. Hardcoding that verdict to `false` left
 * every test green: the control and the claim were two separate expressions, so
 * breaking one did not break the other. Moving the comparison into the harness removes
 * the artifact-side reporting branch entirely — there is no verdict in a Cell that a
 * defect could falsify, only two references — and the harness is where a control and
 * its claim can genuinely share one comparator.
 *
 */

import { SessionProbe, sessionContextIdentity } from "@app/session";

/** The page-level channel both Cells use. A probe, not a feature. */
const IDENTITY_REGISTRY_KEY = "__fgcContextIdentity";

export function App() {
  if (typeof window !== "undefined") {
    const registry = ((window as unknown as Record<string, unknown>)[IDENTITY_REGISTRY_KEY] ??= {}) as Record<
      string,
      unknown
    >;
    // Pure data: this Cell's own Context reference, published for comparison.
    registry["cell-a-published"] = sessionContextIdentity();
  }

  return <SessionProbe label="cell-a" provides="cell-a" />;
}
