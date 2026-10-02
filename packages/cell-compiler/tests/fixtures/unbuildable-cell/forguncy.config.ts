/**
 * A project with one Cell that does not compile, for the build entry's strict/lenient split.
 *
 * No `resolve` block: this fixture is about the build entry's error shape, so it declares the
 * minimum a project can and still have a Cell.
 */
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  cells: {
    broken: {
      entry: "./cells/broken/src/index.ts",
      target: { pageName: "探针", cell: "B2" },
    },
  },
});
