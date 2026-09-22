import { defineForguncyConfig } from "../../../src/forguncy-config";

/**
 * Fixture: several managed Cells, one of them with a local-dev fixture entry.
 *
 * A real project imports the package name, e.g.
 * `import { defineForguncyConfig } from "@forguncy-react-workspace/core"`. The
 * relative import is only here because a package cannot resolve its own name.
 */
export default defineForguncyConfig({
  runtime: {
    forguncyVersion: "12.0.100",
    projectAlias: "sales-portal",
  },
  cells: {
    orderList: {
      entry: "./cells/order-list/src/index.ts",
      fixture: "./cells/order-list/mock.ts",
      target: { pageName: "销售订单", cell: "A1" },
    },
    orderBoard: {
      // Lower-case column, to exercise A1 normalization rather than reject it.
      entry: "./cells/order-board/src/index.ts",
      target: { pageName: "销售订单", cell: "d4" },
    },
    customerDetail: {
      entry: "./cells/customer-detail/src/index.ts",
      target: { pageName: "客户详情", cell: "B2" },
    },
  },
});
