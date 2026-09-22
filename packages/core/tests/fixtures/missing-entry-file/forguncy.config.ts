import { defineForguncyConfig } from "../../../src/forguncy-config";

/**
 * Fixture: the declared entry is intentionally **absent** from this directory.
 *
 * A config that points at a file nobody wrote is a broken project, so loading it
 * must fail with `missing-entry-file` instead of compiling nothing.
 */
export default defineForguncyConfig({
  cells: {
    orderList: {
      entry: "./cells/order-list/src/index.ts",
      target: { pageName: "销售订单", cell: "A1" },
    },
  },
});
