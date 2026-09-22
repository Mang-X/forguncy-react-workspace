/**
 * Fixture: a config that bypasses TypeScript entirely.
 *
 * Loaders must not trust the config's shape just because a `.ts` config would have
 * been type-checked. This one contains, in order: a machine-specific absolute
 * entry, a secret-bearing field, and a dependency-strategy decision that belongs
 * in `fgc.lock.json`. All three must be reported.
 */
export default {
  cells: {
    orderList: {
      entry: "C:\\repos\\sales\\cells\\order-list\\src\\index.tsx",
      target: { pageName: "销售订单", cell: "A1" },
    },
  },
  sessionToken: "not-a-real-token",
  dependencies: { "es-toolkit": "inline" },
};
