/**
 * Two Cells that import the same package, for #97's per-Cell strategy boundary.
 *
 * Decision sources: GitHub Issues
 * - #97 — "构建入口：统一 Cell registry、别名与生产构建配置的消费路径"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/97), whose review found the
 *   first version of the build entry could not express this project at all, and
 * - #4 — "Spec: application ownership boundaries and dependency strategy semantics"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/4), which defines a strategy
 *   at the `(packageName, cellTarget)` level rather than per package.
 *
 * No `dependencies` block, deliberately: which strategy a package takes is `fgc.lock.json`'s
 * answer (#8/#24) and never the config's. The strategies for these two Cells are supplied by the
 * test that builds them, which is the point — the entry takes decisions, it does not decide them.
 */
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  cells: {
    // Declared alpha-then-beta so a build's order is visible in the result.
    alpha: {
      entry: "./cells/alpha/src/index.ts",
      target: { pageName: "探针", cell: "A1" },
    },
    beta: {
      entry: "./cells/beta/src/index.ts",
      target: { pageName: "探针", cell: "B2" },
    },
  },
});
