/**
 * Cell B of the two-Cell anti-claim probe.
 *
 * Decision source: GitHub Issue #15 (workspace package flattening PoC), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * Identical to {@link AppA} except that it mounts **no** provider. That difference is
 * the entire Context half of the assertion: this Cell must read its own tree's
 * default, not the value Cell A's provider carries. If the two artifacts shared a
 * module instance they would share the Context object declared in `@app/session`,
 * and this Cell would render Cell A's value.
 *
 * The label differs so the module-scope half is observable too: after both Cells have
 * recorded a visit, each Cell's `seenLabels()` must name only its own label.
 */

import { SessionProbe } from "@app/session";

export function App() {
  return <SessionProbe label="cell-b" />;
}
