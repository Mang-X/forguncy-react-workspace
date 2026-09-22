import { defineForguncyConfig } from "../../../src/forguncy-config";

/**
 * Fixture: two logical Cells whose targets differ only by case.
 *
 * Both must be refused, because the two locators are indistinguishable in the
 * designer's addressing — one of them would silently overwrite the other.
 */
export default defineForguncyConfig({
  cells: {
    orderList: {
      entry: "./cells/a.ts",
      target: { pageName: "销售订单", cell: "A1" },
    },
    orderBoard: {
      entry: "./cells/b.ts",
      target: { pageName: "销售订单", cell: "a1" },
    },
  },
});
