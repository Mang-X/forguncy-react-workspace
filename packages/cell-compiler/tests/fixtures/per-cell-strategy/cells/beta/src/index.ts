/**
 * Beta Cell: imports the same `@tanstack/query-core` as Alpha, decided `extension` for this Cell.
 *
 * Byte-identical import to Alpha's on purpose — the two files differ only in the `App` body, so the
 * *only* thing that can make their artifacts differ is the strategy each was decided under. If a
 * build applied one projection to both, the two artifacts would carry the same treatment of this
 * import, which is what the test asserts against.
 */
import { QueryClient } from "@tanstack/query-core";

export function App() {
  return new QueryClient().getDefaultOptions;
}
