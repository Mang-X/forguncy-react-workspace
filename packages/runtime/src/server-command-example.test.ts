import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

/**
 * The example, imported rather than copied.
 *
 * Issue #29's plan asks for "one server-command example based on the confirmed
 * `props.ServerCommands` behavior". Putting the example in `examples/runtime-facade`
 * and *executing* it here — rather than illustrating it in prose or duplicating it
 * as a fixture — is what keeps it from rotting: this test fails when the façade's
 * public surface stops supporting the shape an author is told to write.
 *
 * The example's `App.tsx` is JSX and is not part of this: `tsconfig.typecheck.json`
 * excludes `examples/**` until React types are wired up (repository bootstrap
 * work), and no React renderer is installed here. `orders.ts` and `localDev.ts` are
 * the TypeScript halves, and the façade's `useDataSource` member delegates to
 * whatever binding the provider carries, so the data-source read below exercises
 * the delegated call rather than React's rules-of-hooks.
 */
import {
  canReadOrders,
  readOrderPermissions,
  refreshOrders,
  useOrdersSummary,
} from "../../../examples/runtime-facade/src/orders";
import { createLocalDevProvider } from "../../../examples/runtime-facade/src/localDev";
import type { OrdersSummary } from "../../../examples/runtime-facade/src/orders";

import type { DataSourceBinding, RuntimeFacadeCellProps, RuntimeFacadeProvider } from "./contract";
import { runtimeFacade } from "./facade";
import { createHostRuntimeFacadeProvider } from "./host-provider";
import { installRuntimeFacadeProvider, uninstallRuntimeFacadeProvider } from "./provider";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "..", "..", "examples", "runtime-facade", "src");

afterEach(() => {
  uninstallRuntimeFacadeProvider();
});

/**
 * The same page, wired the way a real Cell's generated binding sees it.
 *
 * `props` arrives from the host untyped, so a binding casts once at that boundary:
 * that is why the object below is built here and cast rather than typed field by
 * field — `RuntimeFacadeCellProps` deliberately refuses to *declare* a command, as
 * `contract.ts` records, and this is the shape the port still has to carry.
 */
function hostShapeProvider(): RuntimeFacadeProvider {
  const handle = Object.fromEntries(CELL_FORGUNCY_PROP_KEYS.map(member => [member, undefined])) as Record<
    string,
    unknown
  >;
  // Synchronous, because the host's are: #5 recorded `hasPermission(…)` → `true` and
  // `getPermissions()` → `{"ProbePermission": true}` with no `await`, beside a command
  // call the same section reports as `await … resolved in 185 ms`. A harness that
  // resolved them would be more permissive than the target and would let authored
  // source await something that is not a promise — which is exactly the drift the
  // equality test below exists to catch, so the harness must model it rather than
  // smooth it over.
  handle.hasPermission = (permissionName: string) => permissionName === "Orders.Read";
  // `Partial`, for the same reason the façade's own type is: one entry per
  // *configured* name is the whole of what #5 recorded, so the harness must not
  // declare a boolean at every possible key. A plain `Record<string, boolean>` would
  // compile here (this repo leaves `noUncheckedIndexedAccess` off) while lying about
  // the unconfigured names, and a harness that lies is worse than no harness.
  handle.getPermissions = (): Partial<Record<string, boolean>> => ({ "Orders.Read": true });

  const cellProps = {
    Forguncy: handle,
    Permissions: [{ key: "Orders.Read" }],
    ServerCommands: {
      GetSalesData: async (payload: Readonly<Record<string, unknown>>) => ({
        errorCode: 0,
        errorMessage: "OK",
        payload,
      }),
    },
    ImageContext: undefined,
  } as unknown as RuntimeFacadeCellProps;

  // The Cell's own wrapper-local, as the host injects it: the page declares
  // `Sales`, anything else is an error state.
  const useDataSource: DataSourceBinding = (name, query) =>
    name === "Sales"
      ? {
          data: [{ 月份: "6月", 销售额: 3120 }, { 月份: "5月", 销售额: 2870 }, { 月份: "4月", 销售额: 2450 }].slice(
              0,
              query?.top ?? 3,
            ),
          totalCount: 240,
          loading: false,
          error: null,
        }
      : {
          data: [],
          totalCount: 0,
          loading: false,
          error: `ReactCellType data source was not found: ${name}`,
        };

  return createHostRuntimeFacadeProvider({ cellProps, useDataSource });
}

/**
 * Everything the authored source exposes, read under whichever provider is installed.
 *
 * Two keys are `unknown` because that is what the authored source declares them as
 * (`OrdersSummary`): #5 pins that a data source result carries `totalCount` and
 * `error`, not what the page puts in them. `rows` is narrowed to a count here
 * because that is the observable this test compares, and a row list would compare
 * by the rows a provider happens to hold rather than by the read.
 */
async function readThroughExample(): Promise<{
  readonly summary: {
    readonly rows: number;
    readonly totalCount: OrdersSummary["totalCount"];
    readonly error: OrdersSummary["error"];
  };
  readonly refresh: { readonly errorCode: unknown; readonly errorMessage: unknown };
  readonly canRead: boolean;
  readonly permissions: Readonly<Partial<Record<string, boolean>>>;
}> {
  const summary = useOrdersSummary(3);
  const refresh = await refreshOrders({ top: 3 });
  // No `await` on either, and that is the assertion rather than a style: both are
  // confirmed *synchronous* calls, so the authored source has nothing to await. A
  // re-introduced promise would still satisfy an `await` here and would only be caught
  // by the type check, which is why the example's own return types are pinned too.
  const canRead = canReadOrders();
  const permissions = readOrderPermissions();
  return {
    summary: { rows: summary.rows.length, totalCount: summary.totalCount, error: summary.error },
    refresh: { errorCode: refresh.errorCode, errorMessage: refresh.errorMessage },
    canRead,
    permissions,
  };
}

describe("the server-command example", () => {
  /**
   * The harness is not allowed to be a friendlier host than the host.
   *
   * #5 pinned the base prop keys a `ReactCellType` Cell receives, and the object
   * above is written by hand rather than derived, so this checks that the manual
   * shape still covers every verified key. Without it, a base prop added to `core`
   * would leave this harness silently thinner than the real one — exactly the
   * mismatch a mock exists to catch.
   */
  it("wires a host-shaped props object covering every base key #5 verified", () => {
    const { cellProps } = hostShapeProvider().bindings;
    expect(Object.keys(cellProps).sort()).toEqual([...CELL_PROPS_BASE_KEYS].sort());
  });

  it("reaches the host through the façade, with no props plumbing", async () => {
    installRuntimeFacadeProvider(hostShapeProvider());
    const result = await readThroughExample();

    expect(result.summary.rows).toBe(3);
    expect(result.summary.totalCount).toBe(240);
    expect(result.summary.error).toBeNull();
    expect(result.refresh).toEqual({ errorCode: 0, errorMessage: "OK" });
    expect(result.canRead).toBe(true);
    expect(result.permissions).toEqual({ "Orders.Read": true });
  });

  /**
   * The two calls the review corrected, asserted at the point of use.
   *
   * A promise-returning `hasPermission` would still satisfy an `await` and still
   * satisfy `.toBe(true)` after one, so "the example works" cannot distinguish it —
   * which is exactly why the first draft of this example passed while contradicting
   * #5. The check that does distinguish it is that the member is not thenable, because
   * a synchronous answer is the shape the probe actually recorded.
   */
  it("reaches the host's permission calls synchronously, as #5 recorded them", () => {
    installRuntimeFacadeProvider(hostShapeProvider());

    const granted = runtimeFacade().hasPermission("Orders.Read");
    const permissions = runtimeFacade().getPermissions();

    expect(granted).toBe(true);
    expect(permissions).toEqual({ "Orders.Read": true });
    expect(granted).not.toBeInstanceOf(Promise);
    expect(permissions).not.toBeInstanceOf(Promise);
  });

  /**
   * #29's third acceptance criterion — "same public API can be mocked in local
   * dev" — as an equality rather than as two separate claims.
   *
   * The authored source is not mentioned in `localDev.ts` and every value differs
   * in how it is produced, so identical observable output is the strongest
   * statement available here: the source cannot be observing which provider it got.
   */
  it("answers identically under the local development provider", async () => {
    installRuntimeFacadeProvider(hostShapeProvider());
    const viaHost = await readThroughExample();

    uninstallRuntimeFacadeProvider();
    installRuntimeFacadeProvider(createLocalDevProvider());
    const viaMock = await readThroughExample();

    expect(viaMock).toEqual(viaHost);
    expect(createLocalDevProvider().kind).toBe("mock");
    expect(hostShapeProvider().kind).toBe("host");
  });

  // The four patterns #27's Problem section names, checked against the authored
  // *code* rather than against the file.
  //
  // Comments are stripped first, and that is not tidiness: the file has to be able
  // to *discuss* `props` in order to say it does not use it, and a textual match
  // over the whole file would refuse the explanation. It is the same distinction
  // #5 records for the platform's own validator — syntax nodes, never text — and
  // the filter is asserted to have left code behind so the check cannot pass
  // vacuously.
  it("authored source reads no host global and branches on nothing", () => {
    for (const file of ["orders.ts", "localDev.ts"]) {
      const code = readFileSync(join(exampleRoot, file), "utf8")
        .split("\n")
        .filter(line => {
          const trimmed = line.trim();
          return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
        })
        .join("\n");

      expect(code.trim().length, file).toBeGreaterThan(200);
      expect(code, file).not.toMatch(/globalThis/);
      expect(code, file).not.toMatch(/window\./);
      expect(code, file).not.toMatch(/isForguncy/);
      expect(code, file).not.toMatch(/\bprops\b/);
      // The one way in, named so a reader can see it is the façade.
      expect(code, file).toMatch(/@forguncy-react-workspace\/runtime/);
    }
  });

  // #29's fifth acceptance criterion, exercised through the example rather than
  // asserted about the façade in the abstract.
  it("fails clearly, and not with the host's raw TypeError, when a capability is absent", async () => {
    installRuntimeFacadeProvider(createLocalDevProviderWith({ commands: false }));
    await expect(refreshOrders({})).rejects.toMatchObject({ code: "server-command-not-configured" });

    installRuntimeFacadeProvider(createLocalDevProviderWith({ dataSource: false }));
    // An undeclared data source is not an error path at all: #5 records it as a
    // state, so the example reads that state instead of catching anything.
    expect(() => useOrdersSummary(3)).not.toThrow();
    expect(useOrdersSummary(3).error).toBeTruthy();
  });
});

/** A provider that is missing one capability, so the example's failure path is exercised. */
function createLocalDevProviderWith(options: {
  readonly commands?: boolean;
  readonly dataSource?: boolean;
}): RuntimeFacadeProvider {
  const provider = createLocalDevProvider();
  const bindings = provider.bindings as {
    cellProps: RuntimeFacadeCellProps;
    useDataSource: DataSourceBinding;
  };

  return {
    kind: provider.kind,
    bindings: {
      cellProps: options.commands === false
        ? ({ ...bindings.cellProps, ServerCommands: {} } as RuntimeFacadeCellProps)
        : bindings.cellProps,
      useDataSource: options.dataSource === false ? name => ({
        data: [],
        totalCount: 0,
        loading: false,
        error: `ReactCellType data source was not found: ${name}`,
      }) : bindings.useDataSource,
    },
  };
}

void CELL_PROPS_BASE_KEYS;
