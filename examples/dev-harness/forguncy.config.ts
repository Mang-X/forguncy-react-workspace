import { defineForguncyConfig } from "@forguncy-react-workspace/core";

/**
 * The project config, as a real project would commit it.
 *
 * Decision sources: GitHub Issues
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26) — governing,
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23) — the local loop that
 *   consumes `cells.<id>.fixture`.
 *
 * ## Why one file serves both halves of the claim
 *
 * `entry` is what the compiler bundles; `fixture` is what the dev harness mounts in place of
 * the page. They are declared together because they describe *one* Cell — and #23's second
 * acceptance criterion is about exactly that: `src/App.tsx` is compiled and served without
 * either consumer needing a different file, an annotation, or a branch. `target` is the
 * Forguncy destination the artifact is written to, which the local loop never uses and never
 * fabricates: `#20`'s MCP sync is what writes it, and #26 forbids the local process claiming
 * anything about it.
 *
 * `runtime.forguncyVersion` is the version #5 measured. It is recorded rather than checked
 * here because this example does not talk to a Forguncy project at all.
 */
export default defineForguncyConfig({
  runtime: {
    forguncyVersion: "12.0.100",
    projectAlias: "dev-harness-example",
  },
  cells: {
    salesSummary: {
      entry: "./cells/sales-summary/src/App.tsx",
      fixture: "./cells/sales-summary/fixture.ts",
      target: { pageName: "销售订单", cell: "A1" },
    },
  },
});
