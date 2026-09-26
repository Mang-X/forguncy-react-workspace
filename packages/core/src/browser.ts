/**
 * `@forguncy-react-workspace/core/browser` — the same architecture decisions, on
 * a dependency graph a browser can actually load.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), which surfaces
 *   the problem, under
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose local
 *   loop runs Cell source in a browser, and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), whose façade
 *   is the surface a Cell author calls and therefore has to be loadable in one.
 *
 * ## The defect this entry exists to fix
 *
 * `index.ts` re-exports `cell-registry.ts` and `config-loader.ts`, and those two
 * read the project off disk — `node:fs`, `node:path`, `node:crypto`, `node:url`,
 * destructured at module scope. A barrel re-export is not a declaration: importing
 * *any* name from `core` evaluates every module it re-exports, so those four
 * builtins entered the graph of every consumer of `core`, including a browser one.
 *
 * Both half-pipelines then failed, in ways that look like something else:
 *
 * - **Local dev.** Vite substitutes a `Proxy` for an externalized builtin whose
 *   `get` trap throws, and the interop line it emits for a named import reads a
 *   property immediately — so the *module graph failed to initialise* with
 *   `Module "node:fs" has been externalized for browser compatibility`. Verified in
 *   a real browser against a real `vp dev` server, not inferred.
 * - **Compilation.** The bundler left `node:fs` and friends unresolved, and #4
 *   requires every non-source dependency to carry a decision, so `compileCell`
 *   refused the artifact with four `unresolved-dependency-decision` diagnostics.
 *
 * The consequence was worse than a broken build: `@forguncy-react-workspace/runtime`
 * — the façade #27/#29 mandate and `examples/runtime-facade` is written against —
 * could not be used by any Cell at all, locally or on the page, even though nothing
 * about the façade needs the filesystem.
 *
 * ## Why a subpath and not a lazy `import()` inside the node-only modules
 *
 * The alternative was to keep one entry and defer the filesystem reads to call
 * time. It fixes the browser only by leaving the *artifact* problem in place: a
 * dynamic `import("node:fs")` is exactly what #6 forbids in Cell output, and the
 * compiler's source guard refuses it, so the compile path would still reject the
 * façade. Removing the edge is the fix that makes both halves work, and it is why
 * this is a separate module graph rather than a change in load order.
 *
 * ## Why `export *`, and what keeps it honest
 *
 * Re-exporting the fifteen browser-safe modules wholesale rather than mirroring
 * `index.ts`'s several hundred named exports by hand is deliberate: a hand-copied
 * second list is precisely the "second copy of a rule" this repository keeps
 * finding and deleting, and it would drift silently the first time a name was added
 * to one and not the other.
 *
 * So the projection is **checked**, not trusted. `browser.test.ts` derives both
 * surfaces at run time and asserts the relation is exact in both directions:
 *
 * - every value and type `index.ts` re-exports from a browser-safe module is
 *   reachable here (a new export cannot be forgotten);
 * - nothing is reachable here that `index.ts` does not re-export (this entry is a
 *   projection of one surface, not a second one that can grow its own API);
 * - no module in this entry's transitive graph imports a `node:` builtin, which is
 *   the property the whole file exists for and the one a future edit is most
 *   likely to break — a single new `import { existsSync }` in a safe module would
 *   otherwise silently re-break both halves.
 *
 * ## What it is not
 *
 * It is not a browser-safety claim about the *whole* system: `cell-registry` and
 * `config-loader` are genuinely node-side (they read, hash and import files) and
 * stay that way. Nothing here moves a decision — the same tables, guards and
 * contracts are re-exported — so a consumer reaching for `core/browser` is choosing
 * a graph, not a different answer.
 */

// The browser-safe modules, in the order index.ts cites them. The two that read
// the project off disk (`cell-registry`, `config-loader`) are the only ones absent,
// and `browser.test.ts` asserts the filesystem contact rather than this comment.
export * from "./ownership.ts";
export * from "./rejection.ts";
export * from "./platform-conflicts.ts";
export * from "./strategy.ts";
export * from "./governance.ts";
export * from "./runtime-contract.ts";
export * from "./host-bridge.ts";
export * from "./extension-externals.ts";
export * from "./extension-mappings-config.ts";
export * from "./lock.ts";
export * from "./lock-migration.ts";
export * from "./lock-freshness.ts";
export * from "./selection-signals.ts";
export * from "./probe-protocol.ts";
export * from "./selection-policy.ts";
export * from "./forguncy-config.ts";
export * from "./cell-code-budget.ts";
