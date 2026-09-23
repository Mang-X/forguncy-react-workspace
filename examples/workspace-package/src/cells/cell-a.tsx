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
 * This Cell provides a Context value. {@link AppB} does not, and that asymmetry is
 * what makes the Context half observable: if the two Cells shared a module instance
 * they would share one Context object, and Cell B would read `"cell-a"` instead of
 * its own tree's default.
 *
 * The `label` is what the module-scope half keys on, so Cell A's writes and Cell B's
 * writes are distinguishable in either Cell's `seenLabels()`.
 */

import { SessionProbe } from "@app/session";

export function App() {
  return <SessionProbe label="cell-a" provides="cell-a" />;
}
