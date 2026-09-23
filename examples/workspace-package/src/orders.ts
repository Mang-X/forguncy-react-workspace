/**
 * The Cell's own source, kept in its own module.
 *
 * Decision source: GitHub Issue #15 (workspace package flattening PoC).
 *
 * A second module rather than an inline literal in `App.tsx` because it gives the
 * compile a *relative* import to flatten alongside the named ones. #14's contract
 * classifies module ids three ways — `workspace-package`, `source-file`,
 * `external-package` — and this file is what makes the first and second kinds both
 * present in one real compile: `./orders` is a `source-file` (neither an edge to
 * follow nor a dependency to decide) and `@app/ui` is a `workspace-package`.
 *
 * A file whose only job was to be classified would be a fixture; this one carries
 * the value the Cell renders, which is what keeps the PoC an example.
 */

import type { Money } from "@app/tokens";

/**
 * The order total the Cell renders.
 *
 * Typed with `@app/tokens`' own `Money` rather than a structurally identical local
 * interface, so the type-only import is exercised too: #14 calls types
 * `always-safe` because they are erased before the artifact runs, and this is the
 * line that proves the erasure is real — `formatMoney` is the only thing that
 * makes the value legible, and it lives in the other package.
 */
export const ORDER_TOTAL: Money = { currency: "CNY", amount: 1234.5 };
