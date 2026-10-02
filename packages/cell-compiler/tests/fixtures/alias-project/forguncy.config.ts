/**
 * The project config for #97's cross-path fixture: one Cell, and one project alias.
 *
 * Committed as a real config rather than hand-written per test, so both consumers normalize the
 * same file — which is the property under test. A test that built its own config object would be
 * comparing two objects it constructed, not two readers of one declaration.
 */
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  cells: {
    probe: {
      entry: "./cells/probe/src/index.ts",
      target: { pageName: "探针", cell: "A1" },
    },
  },
  resolve: {
    alias: {
      "@app/shared": "./shared",
    },
  },
});
