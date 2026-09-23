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
 * ## The identity probe, and why this Cell compares too
 *
 * Object identity has to be observed by comparing the objects, which needs a channel
 * both Cells can reach. `window` is that channel — and it is *this file's* choice
 * rather than the package's: `@app/session` exposes its Context reference and reaches
 * no global itself.
 *
 * This Cell publishes its reference **and compares two references**, which is what
 * makes the pair of Cells a discriminating experiment rather than a one-sided one:
 *
 * | key | comparison | expected |
 * | --- | --- | --- |
 * | `cell-a-published` | — | A's own reference |
 * | `cell-a-self-match` | A's reference against itself | **`true`** |
 * | `cell-b-matches-cell-a` (Cell B) | B's reference against A's | **`false`** |
 *
 * The first row is the positive control the pair needs: a comparator that always
 * answered `false` would make Cell B's result meaningless, and this rules it out from
 * the same code path the page runs. Together the two rows say the comparison
 * *discriminates* — same object `true`, different objects `false` — which is what
 * turns Cell B's `false` into evidence that the two artifacts created two Context
 * objects.
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
    const own = sessionContextIdentity();
    // Publish this Cell's reference for the other Cell to compare against.
    registry["cell-a-published"] = own;
    // And compare it against itself, which must be `true`. Without this row, Cell B's
    // `false` would be consistent with a comparator that never answers `true`.
    registry["cell-a-self-match"] = Object.is(own, own);
  }

  return <SessionProbe label="cell-a" provides="cell-a" />;
}
