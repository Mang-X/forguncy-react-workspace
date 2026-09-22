/**
 * The mock provider: the same surface, supplied by the project instead of by
 * Forguncy, so authored source runs unchanged under a local harness.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29).
 *
 * #27's fourth acceptance criterion is "Local dev can provide mocks for the same
 * public facade", and its fifth is that the façade must not become a cross-Cell
 * state store or a second data layer. Those two together decide what this module
 * is: a **provider**, not a fixture library. It carries values the project hands
 * it and reproduces the host's *absences*, so a Cell meets the same shapes
 * locally as it will in Forguncy. It does not cache, aggregate, reorder or
 * retry — the moment it does, it becomes the second data layer #27 forbids, and
 * the moment it is *more* capable than the host, local development stops being a
 * prediction of production.
 *
 * That parity rule is enforced rather than documented: a mock that names a
 * `props.Forguncy` member or a base prop #5 never observed is refused at
 * construction. A mock that could impersonate `navigate` would let a Cell pass
 * every local check and fail on the first real page, which is the one failure
 * mode a local harness is supposed to prevent.
 *
 * ## What the mock does not do
 *
 * The two absences #5 records behave exactly as #5 records them, and no more:
 *
 * - a server-command name the mock was not given is **`undefined` on the
 *   record**, which is what an unconfigured name is on a real Cell — the façade
 *   is where that becomes `server-command-not-configured`, not here;
 * - a data source the mock was not given answers with an error **state**, not a
 *   throw, because that is what #5 observed for an undeclared source.
 *
 * A value prop the mock was not given stays `undefined`. It is deliberately not
 * defaulted to something plausible: `#5` records that it saw the `Permissions`
 * key and not what an empty snapshot means, so a mock that answered `[]` would be
 * asserting a shape on the host's behalf.
 */

import {
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
} from "@forguncy-react-workspace/core";

import type { CellPropKey, ForguncyPropMember } from "./capabilities";
import { RuntimeFacadeContractError } from "./capabilities";
import type {
  DataSourceBinding,
  DataSourceQueryOptions,
  DataSourceResult,
  RuntimeFacadeCellProps,
  RuntimeFacadeHostBindings,
  RuntimeFacadeProvider,
  ServerCommandBindings,
  ServerCommandParameterMap,
} from "./contract";

/** A data source's behaviour, as the project wants it simulated. */
export type MockDataSourceResolver = (options?: DataSourceQueryOptions) => DataSourceResult;

/** The base props a mock does not stand in for through `cellProps`, because they have their own option. */
export type MockStandInCellPropKey = Exclude<CellPropKey, "Forguncy" | "ServerCommands">;

export interface MockRuntimeFacadeOptions<Commands extends ServerCommandParameterMap = Record<never, never>> {
  /** Handle members the project wants to stand in for, by their confirmed names. */
  readonly forguncyMembers?: Partial<Record<ForguncyPropMember, unknown>>;
  /** Value props the project wants to stand in for. */
  readonly cellProps?: Partial<Record<MockStandInCellPropKey, unknown>>;
  /** Commands the page would have made available to this Cell. */
  readonly serverCommands?: ServerCommandBindings<Commands>;
  /** Data sources the page would have declared, by name. */
  readonly dataSources?: Readonly<Record<string, MockDataSourceResolver>>;
}

/**
 * The message the mock uses for a source it was not given.
 *
 * Exported so a test asserts the property #5 actually pinned — that the message
 * **contains the name** — rather than an equality against wording the product
 * never recorded. The exact host string is not part of the evidence; the shape
 * and the name are.
 */
export function mockUndeclaredDataSourceMessage(dataSourceName: string): string {
  return `ReactCellType data source was not found: ${dataSourceName}`;
}

/**
 * A data source over fixed rows.
 *
 * Paging is applied locally, which is mechanical: `top` limits rows and
 * `totalCount` stays the count the project declared, mirroring #5's observation
 * that `top: 3` returned three rows while `totalCount` remained `72`
 * (`pageSizeCountsAreServerSide`).
 *
 * `orderBySqlParams` is **not** applied. Ordering on the real target is the
 * server's — it depends on the database collation, not on the rows the client
 * happens to hold — so a local sort would encode a guess as a simulation. A
 * project that needs ordered results supplies its own resolver; this helper
 * returns the rows in the order it was given them, whatever options arrive.
 */
export function createMockDataSource(
  rows: readonly unknown[],
  options: { readonly totalCount?: number } = {},
): MockDataSourceResolver {
  return query => {
    const offset = query?.offset ?? 0;
    const limit = query?.top ?? rows.length;
    return {
      data: rows.slice(offset, offset + limit),
      totalCount: options.totalCount ?? rows.length,
      loading: false,
      error: null,
    };
  };
}

/** Build the provider a local harness installs. */
export function createMockRuntimeFacadeProvider<
  Commands extends ServerCommandParameterMap = Record<never, never>,
>(options: MockRuntimeFacadeOptions<Commands> = {}): RuntimeFacadeProvider {
  const handle = Object.fromEntries(CELL_FORGUNCY_PROP_KEYS.map(member => [member, undefined])) as Record<
    string,
    unknown
  >;
  for (const [member, value] of Object.entries(options.forguncyMembers ?? {})) {
    if (!(CELL_FORGUNCY_PROP_KEYS as readonly string[]).includes(member)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock supplies props.Forguncy.${member}, which is not a member #5 verified. A mock may only stand in for addresses the host has, or local development stops predicting the host.`,
      );
    }
    handle[member] = value;
  }

  // Derived from `core`'s key list rather than written out, so a base prop #5
  // adds cannot leave the mock behind the host surface.
  const cellProps = Object.fromEntries(CELL_PROPS_BASE_KEYS.map(key => [key, undefined])) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(options.cellProps ?? {})) {
    if (!(CELL_PROPS_BASE_KEYS as readonly string[]).includes(key)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock supplies the base prop "${key}", which is not one #5 verified on a ReactCellType Cell.`,
      );
    }
    cellProps[key] = value;
  }
  cellProps.Forguncy = handle;
  cellProps.ServerCommands = options.serverCommands ?? {};

  const dataSources = options.dataSources ?? {};
  const useDataSource: DataSourceBinding = (dataSourceName, query) => {
    const resolver = dataSources[dataSourceName];
    if (typeof resolver !== "function") {
      // The host's own shape for this case: an error state rather than a throw.
      return {
        data: [],
        totalCount: 0,
        loading: false,
        error: mockUndeclaredDataSourceMessage(dataSourceName),
      };
    }
    return resolver(query);
  };

  const bindings: RuntimeFacadeHostBindings = {
    cellProps: cellProps as RuntimeFacadeCellProps,
    useDataSource,
  };
  return { kind: "mock", bindings };
}
