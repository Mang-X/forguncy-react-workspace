/**
 * The authored half of the server-command read, and the data-source read.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), which decides every shape
 *   used below.
 *
 * This is a near-copy of `examples/runtime-facade/src/orders.ts`, and the duplication is
 * deliberate rather than an oversight: the two examples answer *different* questions, and
 * merging them would make one file responsible for two claims.
 *
 * - `examples/runtime-facade` proves the façade's *run-time* behaviour under two provider
 *   kinds, executed by `packages/runtime`'s test suite with no React renderer involved.
 * - `examples/dev-harness` proves the *loop*: that this source renders under `vp dev`, that
 *   HMR reaches it, and — #23's acceptance criterion 2 — that the same file compiles into a
 *   Cell artifact with no local-only branch. That claim needs the file to live in a project
 *   the compiler can be pointed at, with a real `forguncy.config.ts` and a real fixture.
 *
 * The shared part is the *shape* rather than the text, and the shape is #27's: a command map
 * declared here because #5 pinned that a Cell's `ServerCommands` record carries only the names
 * the designer listed and not what any command takes, so the parameter knowledge is this
 * project's claim, written once.
 */

import { runtimeFacade } from "@forguncy-react-workspace/runtime";

/**
 * The commands this Cell's page makes available.
 *
 * The one executed call #5 records is `await props.ServerCommands.GetSalesData({})`, so the
 * single object argument below is a shape that was *observed* rather than one that reads well.
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
 * Named `use…` because it calls the confirmed hook: in a real Cell this runs during render,
 * which is the only place `useDataSource` is legal. Nothing here caches or reshapes the
 * result — a Cell-side cache would be the second data layer #27's non-goals forbid.
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
 * No `TypeError` for an unconfigured name and no prop plumbing: the façade reports a command
 * the page did not configure as a named failure (`server-command-not-configured`), which is
 * what makes this call safe to write without knowing the page configuration — and what makes
 * the *fixture* the only thing deciding whether it works locally.
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
 * Ask the host whether the current user holds the permission this Cell needs.
 *
 * Synchronous, and it declares nothing: #5 executed the call
 * (`props.Forguncy.hasPermission("ProbePermission")` → `true`) and did not await it, while
 * awaiting the `ServerCommands` call recorded beside it — so the call shape is confirmed and
 * the façade types it. The one case #5 never ran is a *denied* permission, so `false` here is
 * what the return type claims rather than something that was observed.
 */
export function canReadOrders(): boolean {
  return runtimeFacade().hasPermission("Orders.Read");
}

/**
 * Every configured permission's boolean, through the host's own handle.
 *
 * The `Partial` is not stylistic. #5 recorded one boolean per *configured* permission — the
 * page confirmed that an unconfigured name is simply not a key — not a boolean at every
 * possible key. Declaring a plain `Record<string, boolean>` compiles happily here because this
 * repository leaves `noUncheckedIndexedAccess` off, so an unconfigured name would type as
 * `boolean` and read `undefined` on a real page. Keeping the type `Partial` keeps that absence
 * in the type, where the compiler can still catch it.
 */
export function readOrderPermissions(): Readonly<Partial<Record<string, boolean>>> {
  return runtimeFacade().getPermissions();
}
