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
 * 3. **A confirmed call shape is used as one.** #5 executed
 *    `props.Forguncy.hasPermission("ProbePermission")` and recorded `true` — with no
 *    `await`, where the `ServerCommands` call recorded in the same section is
 *    reported as `await … resolved in 185 ms`. So the permission check is a
 *    *synchronous* call whose return was observed, and the façade types it rather
 *    than leaving the author to declare it. This file therefore contains no
 *    `forguncyMember` declaration and no promise wrapper: the first draft of this
 *    example had both, and they were wrong for the reason the registry's levels
 *    exist to prevent — a shape nobody had run.
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
 * Ask the host whether the current user holds the permission this Cell needs.
 *
 * Synchronous, and it declares nothing: #5 executed the call
 * (`props.Forguncy.hasPermission("ProbePermission")` → `true`) and did not await it
 * while awaiting the `ServerCommands` call recorded beside it, so the call shape is
 * confirmed and the façade types it. The one case #5 never ran is a *denied*
 * permission, so `false` here is what the return type claims rather than something
 * that was observed.
 */
export function canReadOrders(): boolean {
  return runtimeFacade().hasPermission("Orders.Read");
}

/**
 * Every configured permission's boolean, through the host's own handle.
 *
 * The second confirmed call, and separately worth showing: `props.Permissions` and
 * `props.Forguncy.getPermissions()` carry the same map, but only this one is a call,
 * so this is the form whose shape a project does not have to declare. Reading the
 * base prop instead is `runtimeFacade().cellProp("Permissions")`, and it is a
 * different address — not a second way to reach this one.
 *
 * "The same map" is no longer an inference from two readings that happened to match:
 * an executed page, with one permission allowed and one denied, answered
 * `props.Permissions` and `props.Forguncy.getPermissions()` with the identical
 * `{"<allowed>": true, "<denied>": false}`, and with none configured it answered `{}`
 * for both. So the snapshot is a record of the *configured* names, empty rather than
 * absent when there are none — which is also why the base prop is a record and not the
 * `permissions[]` descriptor list the cell's own configuration uses.
 *
 * The `Partial` is not a stylistic choice, and it is worth reading code that does
 * it wrong: #5 recorded one boolean per *configured* permission — the page confirmed
 * that an unconfigured name is simply not a key — not a boolean at
 * every possible key. Declaring a plain `Record<string, boolean>` compiles happily
 * because this repository does not enable `noUncheckedIndexedAccess`, so an
 * unconfigured name would type as `boolean` and read `undefined` on a real page.
 * Keeping the type `Partial` keeps that absence in the type, where the compiler can
 * still catch it. Callers widening this return value back to a plain `Record` are
 * re-making the mistake, not simplifying.
 */
export function readOrderPermissions(): Readonly<Partial<Record<string, boolean>>> {
  return runtimeFacade().getPermissions();
}
