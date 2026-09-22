/**
 * The Cell, as a component author writes it.
 *
 * Decision source: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29), under #27 —
 * "Spec: typed Forguncy runtime facade for application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 *
 * This is the same source that runs in Forguncy and under the local harness
 * (`localDev.ts`): the values it needs arrive through the façade, so there is
 * nothing to branch on and no `props` to thread down. The component is presented
 * with our first-party examples and is intentionally not type-checked yet — the
 * repository's `tsconfig.typecheck.json` excludes `examples/**` until React types
 * are wired up (tracked as repository bootstrap work), and the *executed* half of
 * this example is `orders.ts`, which is plain TypeScript and is run by the
 * package's test suite.
 */

import { refreshOrders, useOrdersSummary } from "./orders";

export function App() {
  const summary = useOrdersSummary(3);

  return (
    <section>
      <h2>本月销售</h2>
      {summary.error ? (
        <p role="alert">销售数据不可用：{String(summary.error)}</p>
      ) : (
        <ul>
          {summary.rows.map((row, index) => (
            <li key={index}>{JSON.stringify(row)}</li>
          ))}
        </ul>
      )}
      <ExportButton />
    </section>
  );
}

/**
 * A command invocation from a handler.
 *
 * Note what is absent: no `props`, no host detection, no `ServerCommands` lookup.
 * A command the page did not configure arrives as a named failure, so the handler
 * can report it instead of guarding against a `TypeError`.
 */
function ExportButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void refreshOrders({ top: 3 }).catch(error => {
          console.error(error);
        });
      }}
    >
      导出
    </button>
  );
}
