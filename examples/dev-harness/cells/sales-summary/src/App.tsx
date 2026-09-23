/**
 * A Cell, as a component author writes it — and the source that both `vp dev` and the
 * Cell compiler consume, which is #23's acceptance criterion 2 ("the same source compiles
 * for Forguncy without local-only branches in application code").
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 7 asks
 *   for "at least one example where the same source is used both by `vp dev` and by Cell
 *   compiler output", and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), which decides *how* it
 *   manages that: every host value arrives through the façade, so there is nothing here for
 *   a local-only branch to switch on.
 *
 * ## The three rules this file follows, and why each one is load-bearing
 *
 * 1. **No `props` and no host branch.** Nothing reads `globalThis`, nothing asks whether it
 *    is running on Forguncy, and `props` is never threaded down. `RUNTIME_FACADE_FORBIDDEN_PATTERNS`
 *    names all three, and `local-only-source-branch` is the one that would silently make the
 *    local loop a *second* implementation: the branch that only runs locally is the branch
 *    that never runs on the page.
 * 2. **No local-only module.** There is no `.dev.tsx` twin and no harness wrapper around this
 *    component. The harness mounts *this* file — the compiler inlines *this* file — and
 *    `LOCAL_DEV_FORBIDDEN_PATTERNS`' `second-local-component` records why a twin is worse than
 *    a branch: it keeps looking right while it drifts.
 * 3. **The imports are the ordinary ones.** `react` is imported by name. On the page, #9's
 *    host bridge binds that specifier to the page's React object; under `vp dev`, the harness
 *    resolves the same specifier to its own pinned copy of the same version. Neither is
 *    visible from here, which is the entire point.
 *
 * ## HMR is observable here on purpose
 *
 * `useState` is used for something a developer can actually watch survive an edit: the click
 * count stays put across a React Fast Refresh pass. That is what makes "HMR works" checkable
 * by hand rather than taken on faith — a full page reload resets it to zero, Fast Refresh does
 * not. It is also a real answer to a real question, because React state surviving an edit is
 * only possible if the module graph and the host React substitution are wired the way this
 * example claims.
 */

import { useState } from "react";

import { canReadOrders, readOrderPermissions, refreshOrders, useOrdersSummary } from "./orders";

export function App() {
  // Survives a Fast Refresh pass, resets on a full reload — see the file docstring.
  const [clicks, setClicks] = useState(0);

  const summary = useOrdersSummary(3);
  // Synchronous, because #5 recorded these as synchronous calls: `hasPermission(...)` →
  // `true` and `getPermissions()` → `{"ProbePermission": true}` with no `await`. A harness
  // that made them promises would be *more* permissive than the target and would teach
  // authored source to await something that is not a promise.
  const mayRead = canReadOrders();
  const permissions = readOrderPermissions();

  return (
    <section data-dev-harness="sales-summary">
      <h2>本月销售</h2>

      {mayRead ? null : <p role="alert">当前用户没有 Orders.Read 权限。</p>}

      {summary.error ? (
        <p role="alert">销售数据不可用：{String(summary.error)}</p>
      ) : (
        <ul>
          {summary.rows.map((row, index) => (
            // `key` by index on purpose: the rows are a flat projection of whatever the page's
            // data source returned and carry no stable identity in authored source. This is the
            // one place a keyed list exists in the example, so it is also where a JSX-runtime
            // mistake would surface locally — #22 records that the local loop resolves the
            // *published* JSX runtime, never #9's generated adapter, which is exactly why a
            // green render here says nothing about the adapter.
            <li key={index}>{JSON.stringify(row)}</li>
          ))}
        </ul>
      )}

      <p>
        权限：
        {Object.entries(permissions)
          .map(([name, granted]) => `${name}=${granted}`)
          .join("、")}
      </p>

      <p>
        <button type="button" onClick={() => setClicks(count => count + 1)}>
          交互计数 {clicks}
        </button>
      </p>

      <ExportButton />
    </section>
  );
}

/**
 * A command invocation from a handler.
 *
 * Note what is absent: no `props`, no host detection, no `ServerCommands` lookup. A command
 * the page did not configure arrives as a named failure
 * (`server-command-not-configured`), which is what makes this safe to write without knowing
 * the page's configuration — and what makes the fixture's `GetSalesData` the only thing that
 * decides whether this button works locally.
 */
function ExportButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void refreshOrders({ top: 3 }).catch(error => {
          // Left to the console rather than swallowed into state: `LOCAL_DEV_ERROR_SURFACING`
          // records that the local loop must let a failure be loud, and a `catch` that rendered
          // a fallback would be the swallowed-error pattern by another name.
          console.error(error);
        });
      }}
    >
      导出
    </button>
  );
}
