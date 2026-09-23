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
 * module identity, and an earlier version of this file said it was: two Cells are two
 * React roots, and a Context value is resolved along the reading tree's ancestor
 * chain, so a Provider in one root cannot supply a Consumer in another **even when
 * both roots share one Context object**. Cell B reading the default proves only that
 * no Provider is mounted in B's tree.
 *
 * ## The identity probe, which is the honest way to ask the Context question
 *
 * Object identity has to be observed by comparing the objects, which needs a channel
 * both Cells can reach. `window` is that channel — and it is *this file's* choice
 * rather than the package's: `@app/session` exposes its Context reference and reaches
 * no global itself. This Cell publishes its reference under
 * `__fgcContextIdentity["cell-a"]`; Cell B compares that entry against its own with
 * `Object.is`, so the page answers "did the two artifacts create one Context object
 * or two?" directly.
 *
 * `typeof window === "undefined"` is guarded because the same entry is compiled and
 * rendered by local tests, where there is no page.
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
    // Publish this Cell's own Context reference for the other Cell to compare against.
    registry["cell-a"] = sessionContextIdentity();
  }

  return <SessionProbe label="cell-a" provides="cell-a" />;
}
