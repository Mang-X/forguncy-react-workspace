/**
 * What local development installs for this example.
 *
 * Decision source: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29), and the local
 * harness that consumes it is #23.
 *
 * The point of the file is that the authored source (`orders.ts`, `App.tsx`) is
 * not mentioned in it: the harness installs a provider and the same source runs.
 * Nothing here is a second code path, which is what #27's fourth acceptance
 * criterion asks for and what `RUNTIME_FACADE_RESOLUTION_MODEL` records as the
 * rule a mock must not break.
 *
 * Every value below stands in for something the *page* would have configured —
 * the `Sales` data source, the `GetSalesData` command, the `hasPermission`
 * member — and nothing stands in for a host global, because a Cell cannot reach
 * one any other way either.
 */

import {
  createMockDataSource,
  createMockRuntimeFacadeProvider,
} from "@forguncy-react-workspace/runtime";
import type { RuntimeFacadeProvider } from "@forguncy-react-workspace/runtime";

import type { AppServerCommands } from "./orders";

/** Fake rows for the `Sales` source. The shape is the example's business, not the host's. */
const SALES_ROWS = [
  { 月份: "6月", 销售额: 3120 },
  { 月份: "5月", 销售额: 2870 },
  { 月份: "4月", 销售额: 2450 },
];

/**
 * The provider a local harness installs before rendering.
 *
 * `totalCount` is deliberately larger than the rows on hand, mirroring #5's
 * observation that `top: 3` returned three rows while `totalCount` stayed `72`:
 * paging is the server's, so a mock that shrank the count would teach authored
 * source the wrong thing.
 */
export function createLocalDevProvider(): RuntimeFacadeProvider {
  return createMockRuntimeFacadeProvider<AppServerCommands>({
    forguncyMembers: {
      // Both synchronous, because both are synchronous on the host: #5 recorded
      // `hasPermission(…)` → `true` and `getPermissions()` → `{"ProbePermission": true}`
      // with no `await`, unlike the command call beside them. A mock that returned
      // promises would be *more* permissive than the target, which is the one
      // direction a local harness must never lean — it would teach authored source to
      // await something that is not a promise, and the mistake would only surface on a
      // real page.
      hasPermission: (permissionName: string) => permissionName === "Orders.Read",
      // `Partial` matches the facade's own type and the mock's own honesty: one entry
      // per *configured* name, nothing at all for the ones this harness did not
      // configure. A plain `Record<string, boolean>` would promise a value at every
      // key and deliver `undefined`, which is exactly the gap the facade type refuses
      // to paper over.
      getPermissions: (): Partial<Record<string, boolean>> => ({ "Orders.Read": true }),
    },
    cellProps: { Permissions: [{ key: "Orders.Read" }] },
    serverCommands: {
      GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", payload }),
    },
    dataSources: {
      Sales: createMockDataSource(SALES_ROWS, { totalCount: 240 }),
    },
  });
}
