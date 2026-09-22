/**
 * Fixture module: default-exports the options object Issue #28's contract
 * consumes. A real project's fixture stands in for confirmed host members,
 * base props, server commands and data sources — nothing else.
 */
const options = {
  cellProps: {
    Permissions: { Orders: "read" },
  },
  dataSources: {
    Orders: () => ({
      data: [{ id: "SO-1" }],
      totalCount: 1,
      loading: false,
      error: null,
    }),
  },
};

export default options;
