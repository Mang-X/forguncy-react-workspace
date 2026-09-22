/**
 * The authored half of the server-command example.
 *
 * Decision source: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider", whose plan asks for "one server-command example
 * based on the confirmed `props.ServerCommands` behavior"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29), governed by
 * #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 *
 * This file is written the way a Cell author writes, and it is *executed* by
 * `packages/runtime/src/server-command-example.test.ts` under both provider kinds
 * rather than only compiled, because an example nobody runs is the cheapest thing
 * in a repository to let rot.
 *
 * Four things are on purpose, and each one is a rule from #27 rather than a
 * style choice:
 *
 * 1. **No `props` and no host branch.** Nothing here reads a host global, threads
 *    `props` down, or asks whether it is running on Forguncy
 *    (`RUNTIME_FACADE_FORBIDDEN_PATTERNS`' first three entries).
 * 2. **The command map is declared here.** `#5` pinned that a Cell's
 *    `ServerCommands` record carries only the names the designer listed, and not
 *    what any command takes — so the parameter knowledge is this project's
 *    claim, written once, and a command the project forgot to declare is not
 *    callable at all.
 * 3. **The handle member's signature is declared at the point of use.**
 *    `hasPermission` was *observed* to exist and never called, so the façade
 *    returns `unknown` for it and the declaration below is the shape this project
 *    expects. That is the honest place for it: a human can correct one line here,
 *    whereas a signature inside the façade would read as evidence.
 * 4. **The data source is read through the façade's `useDataSource`**, which is
 *    the same confirmed wrapper-local under its own name — so this file needs no
 *    import for it and the local harness can supply it.
 */

import { runtimeFacade } from "@forguncy-react-workspace/runtime";

/**
 * The commands this Cell's page makes available.
 *
 * The one executed call #5 records is `await props.ServerCommands.GetSalesData({})`,
 * so the single object argument below is a shape that was observed rather than one
 * that reads well.
 */
export type AppServerCommands = {
  readonly GetSalesData: [payload: Readonly<Record<string, unknown>>];
};

export interface OrdersSummary {
  readonly rows: readonly unknown[];
  /** The server-side count, which stays put while the page size limits rows. */
  readonly totalCount: unknown;
  readonly error: unknown;
}

/**
 * The Cell's read of the page's data source.
 *
 * Named `use…` because it calls the confirmed hook: in a real Cell this runs
 * during render, which is the only place `useDataSource` is legal. Nothing here
 * caches or reshapes the result — a Cell-side cache would be the second data
 * layer #27's non-goals forbid.
 */
export function useOrdersSummary(top = 3): OrdersSummary {
  const sales = runtimeFacade().useDataSource("Sales", { top });
  return {
    rows: Array.isArray(sales.data) ? sales.data : [],
    totalCount: sales.totalCount,
    error: sales.error,
  };
}

export interface OrdersRefresh {
  readonly errorCode: unknown;
  readonly errorMessage: unknown;
  /** The command's own named returns arrive beside the reserved keys. */
  readonly result: Readonly<Record<string, unknown>>;
}

/**
 * Invoke the page's server command.
 *
 * No `.TypeError` for an unconfigured name and no prop plumbing: the façade
 * reports a command the page did not configure as a named failure
 * (`server-command-not-configured`), which is what makes this call safe to write
 * without knowing the page configuration.
 */
export async function refreshOrders(payload: Readonly<Record<string, unknown>> = {}): Promise<OrdersRefresh> {
  const result = await runtimeFacade<AppServerCommands>().invokeServerCommand("GetSalesData", payload);
  return {
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    result: result as Readonly<Record<string, unknown>>,
  };
}

/**
 * Ask the host whether the current user holds a permission.
 *
 * The declared signature is this project's expectation, not the façade's claim:
 * #5 verified that `props.Forguncy.hasPermission` exists and did not call it, so
 * the façade resolves it to `unknown` until a shape is supplied here.
 */
export function canReadOrders(): Promise<boolean> {
  const hasPermission =
    runtimeFacade().forguncyMember<(permissionName: string) => Promise<boolean>>("hasPermission");
  return hasPermission("Orders.Read");
}
