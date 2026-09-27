/**
 * A project that is a *member* of the repository's workspace rather than a workspace root.
 *
 * The layout is the point: this directory holds no `pnpm-workspace.yaml`, and the nearest one above
 * it is the repository's. That is exactly how every example in this repository is laid out, and how
 * a real monorepo member looks — so a build that only checked its own root would report
 * `workspaceAudited: false` for it and silently skip #14's audit, whose findings can be fatal.
 */
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  cells: {
    probe: {
      entry: "./cells/probe/src/index.ts",
      target: { pageName: "探针", cell: "A1" },
    },
  },
});
