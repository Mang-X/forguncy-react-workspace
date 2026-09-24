/**
 * `@forguncy-react-workspace/dependency-resolver/local` — the lock's decision pipeline on a graph
 * that does not pull a bundler.
 *
 * ## The defect this entry exists to fix
 *
 * `index.ts` re-exports 26 names from `probe/*`, and `probe/build.ts` statically imports `rolldown`.
 * A barrel re-export is not a declaration: importing *any* name from this package evaluates every
 * module it re-exports, so `rolldown` entered the graph of every consumer — including the dev
 * harness's, which loads its plugin from a project's `vite.config.ts`.
 *
 * Measured, for the `dev-harness` caller this entry was added for:
 *
 * | imported | marginal cost, with `vite` and `core` already loaded |
 * | --- | --- |
 * | `dependency-resolver` (the barrel) | ~570 ms |
 * | `decision-conformance` / `lock-store` / `install-graph` | 11 / 9 / 7 ms |
 *
 * That is a bundler pulled into every `vp dev` start, to read a lock of a few kilobytes.
 *
 * This is the same shape as `core/browser`, and for the same reason: the fix is to remove the
 * *edge*, not to defer it. A lazy `import()` inside the heavy modules would fix this caller only by
 * leaving the artifact problem in place — #6 forbids a dynamic `import("node:fs")`-style edge in
 * Cell output, and the compiler's source guard refuses it — so the projection is a separate module
 * graph rather than a change in load order.
 *
 * ## What it re-exports, and why these four
 *
 * The modules that answer "what does this lock say, and is it still valid" without probing anything:
 *
 * - `lock-store` — the lock as an artifact (read, write, and the two projections onto compilation);
 * - `decision-conformance` — the audit that checks the lock against the strategy and mapping
 *   contracts, which the compiler runs *before* compiling;
 * - `install-graph` — the installed versions the freshness rules compare against, read from the
 *   workspace's own tree rather than from a probe;
 * - `decision-recording` — the update API a resolver step records through.
 *
 * What is deliberately absent is everything that *runs* a probe or builds a bundler: the engine,
 * the fingerprint composer, the cache, the build runner and the scanners. A consumer that needs
 * those wants `index.ts`, and should pay for them knowingly.
 *
 * `probe/fingerprint.ts` is absent for that reason and not by oversight, even though the harness
 * could use it: it composes a fingerprint from the *declared* probe inputs, but `build.ts` defines
 * `BUILD_CONFIGURATION_FINGERPRINT`, which is one of those inputs — so composing one here would
 * pull the bundler in through the back door. The consequence for a caller is recorded where it
 * lands: a probe fingerprint is not locally observable, and `localCompilationDependencies`' own
 * projection reports that as staleness rather than guessing.
 *
 * ## Why `export *`, and what keeps it honest
 *
 * Re-exporting the four modules wholesale rather than mirroring `index.ts`'s named exports by hand
 * is deliberate: a hand-copied second list is precisely the "second copy of a rule" this repository
 * keeps finding and deleting. The projection is **checked**, not trusted —
 * `local-projection.test.ts` derives both surfaces at run time and asserts the relation is exact in
 * both directions (nothing reachable here that `index.ts` does not export, and no `node:`-free
 * module's export forgotten), plus that this entry's transitive graph reaches no `rolldown`.
 */

export * from "./lock-store.ts";
export * from "./decision-conformance.ts";
export * from "./install-graph.ts";
export * from "./decision-recording.ts";
