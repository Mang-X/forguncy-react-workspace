/**
 * Alpha Cell: imports `@tanstack/query-core`, which this Cell's projection decides `inline`.
 *
 * Both Cells in this fixture import the **same** package and must compile differently, which is the
 * property #4 defines strategy at the `(packageName, cellTarget)` level for. The import is ordinary
 * npm source with no annotation, so nothing about the file tells the bundler which strategy applies
 * — the decision does, and that is the point.
 *
 * The package is the built-in extension table's `@tanstack/query-core` because it is the one id
 * where **both** strategies are compilable today: it is installed (so `inline` has an artifact to
 * flatten) and it has a verified mapping row (so `extension` has a global to reference). A package
 * with only one of those could not be the subject of a two-strategy test.
 */
import { QueryClient } from "@tanstack/query-core";

export function App() {
  return new QueryClient().getDefaultOptions;
}
