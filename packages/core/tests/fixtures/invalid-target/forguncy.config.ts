import { defineForguncyConfig } from "../../../src/forguncy-config.ts";

/**
 * Fixture: target declarations that cannot address a Forguncy Cell.
 *
 * `cell: "0"` has no column, and an empty page name names no page. Both must fail
 * before anything is compiled or synced.
 */
export default defineForguncyConfig({
  cells: {
    orderList: {
      entry: "./cells/a.ts",
      target: { pageName: "销售订单", cell: "0" },
    },
    orderBoard: {
      entry: "./cells/a.ts",
      target: { pageName: "   ", cell: "B4" },
    },
  },
});
