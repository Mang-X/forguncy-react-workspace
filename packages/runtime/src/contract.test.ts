import { describe, expect, it } from "vitest";

import {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
  CELL_SERVER_COMMANDS_CONTRACT,
  concernsOwnedBy,
  isApplicationOwned,
} from "@forguncy-react-workspace/core";

import { RuntimeFacadeContractError, findRuntimeFacadeCapability } from "./capabilities";
import type { ForguncyPropMember } from "./capabilities";
import {
  APPLICATION_OWNED_CONCERNS,
  assertRuntimeFacadeBoundariesProtectApplicationConcerns,
  assertRuntimeFacadePortCoversAdmittedCapabilities,
  findRuntimeFacadeBoundaryForConcern,
  RUNTIME_FACADE_BOUNDARIES,
  RUNTIME_FACADE_BOUNDARY_IDS,
  RUNTIME_FACADE_FORBIDDEN_PATTERNS,
  RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS,
  RUNTIME_FACADE_PACKAGING_POLICY,
  RUNTIME_FACADE_PORT_CHANNELS,
  RUNTIME_FACADE_PORT_CHANNEL_MEMBERS,
  RUNTIME_FACADE_PORT_HOOK_NAME,
  RUNTIME_FACADE_PROVIDER_EXPECTATIONS,
  RUNTIME_FACADE_PROVIDER_KINDS,
  RUNTIME_FACADE_RESOLUTION_MODEL,
  runtimeFacadePortChannelOfBinding,
  runtimeFacadePortChannels,
  runtimeFacadePortCoversBinding,
} from "./contract";
import type {
  DataSourceBinding,
  DataSourceQueryOptions,
  DataSourceResult,
  RuntimeFacadeBoundary,
  RuntimeFacadeCellProps,
  RuntimeFacadeHostBindings,
  RuntimeFacadeProvider,
  ServerCommandBindings,
} from "./contract";

/**
 * A mock built from `core`'s key list rather than from a hand-written literal.
 *
 * #29 owns the mock *provider*; this is only what the tests need to prove the
 * boundary is satisfiable. Deriving the members means a key #5 adds cannot leave
 * the mock quietly behind the host surface.
 */
function forguncyMembers(
  overrides: Partial<Record<ForguncyPropMember, unknown>> = {},
): Readonly<Record<ForguncyPropMember, unknown>> {
  const members = Object.fromEntries(
    CELL_FORGUNCY_PROP_KEYS.map(member => [member, undefined] as const),
  ) as Record<ForguncyPropMember, unknown>;
  return { ...members, ...overrides };
}

function mockCellProps(overrides: Partial<RuntimeFacadeCellProps> = {}): RuntimeFacadeCellProps {
  return {
    Forguncy: forguncyMembers(),
    Permissions: [],
    ServerCommands: {},
    ImageContext: undefined,
    ...overrides,
  };
}

/**
 * A mock that declares no data source, answering exactly the way #5 records an
 * undeclared one: an error state whose message contains the name, not a throw.
 */
const noSuchSource: DataSourceBinding = name => ({
  data: [],
  totalCount: 0,
  loading: false,
  error: `Error: ReactCellType data source was not found: ${name}`,
});

interface MockBindingsOverrides {
  readonly cellProps?: Partial<RuntimeFacadeCellProps>;
  readonly useDataSource?: DataSourceBinding;
}

function mockBindings(overrides: MockBindingsOverrides = {}): RuntimeFacadeHostBindings {
  return {
    cellProps: mockCellProps(overrides.cellProps),
    useDataSource: overrides.useDataSource ?? noSuchSource,
  };
}

function providerOf(
  kind: RuntimeFacadeProvider["kind"],
  overrides: MockBindingsOverrides = {},
): RuntimeFacadeProvider {
  return { kind, bindings: mockBindings(overrides) };
}

// #27's second acceptance criterion is that a server command "can be authored
// with TypeScript-friendly facade usage instead of raw prop plumbing when
// feasible". The shapes asserted here are #5's: the one executed call, the
// reserved result keys, the named returns beside them, and the `undefined` a name
// the designer never configured produces.
describe("the confirmed server-command call shape", () => {
  it("carries the reserved result keys #5 pins", () => {
    expect([...CELL_SERVER_COMMANDS_CONTRACT.resultKeys].sort()).toEqual(["errorCode", "errorMessage"]);
  });

  // #5's executed call is `await props.ServerCommands.GetSalesData({})`, so the
  // declaration a project writes for its own command pins one object argument.
  // The payload stays the declaration's claim, not this contract's.
  it("lets a declaration pin the one-argument form #5 observed", async () => {
    type Commands = { GetSalesData: [payload: Readonly<Record<string, unknown>>] };

    const commands: ServerCommandBindings<Commands> = {
      GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", echo: payload }),
    };

    const result = await commands.GetSalesData?.({});
    expect(result?.errorCode).toBe(0);
    expect(result?.errorMessage).toBe("OK");
    // A command's own named return sits beside the reserved keys, exactly as
    // #5 records ("namedReturnsAreExtraKeys").
    expect(result?.echo).toEqual({});
  });

  // The base record is deliberately not callable. `readonly never[]` would have
  // admitted a zero-argument call the evidence does not contain, and
  // `readonly unknown[]` every arity; #5 pins what a *result* carries, not what
  // any given command takes.
  it("admits no call at all until a declaration supplies parameters", () => {
    const commands = mockBindings().cellProps.ServerCommands;
    // @ts-expect-error a command nobody declared has no callable type
    expect(commands.CreateOrder).toBeUndefined();
  });

  // The fact the empty default does not encode is recorded where facts live.
  it("still records that an unconfigured name is undefined at runtime", () => {
    const note = findRuntimeFacadeCapability("server-command-invocation").note ?? "";
    expect(note).toMatch(/undefined/);
    expect(note).toMatch(/plain `TypeError`/);
  });
});

// #27's fourth acceptance criterion: "Local dev can provide mocks for the same
// public facade."
describe("the provider boundary", () => {
  it("makes the host and the mock the same type, so a consumer cannot tell them apart", () => {
    const host = providerOf("host", { cellProps: { Permissions: [{ key: "Orders.Read" }] } });
    const mock = providerOf("mock");

    expect(host.kind).toBe("host");
    expect(mock.kind).toBe("mock");
    expect(Object.keys(mock.bindings).sort()).toEqual(Object.keys(host.bindings).sort());
    expect(RUNTIME_FACADE_PROVIDER_KINDS).toEqual(["host", "mock"]);
  });

  it("addresses exactly the base props `core` verifies", () => {
    expect(Object.keys(mockCellProps()).sort()).toEqual([...CELL_PROPS_BASE_KEYS].sort());
    expect(Object.keys(forguncyMembers()).sort()).toEqual([...CELL_FORGUNCY_PROP_KEYS].sort());
  });

  it("expects the mock to reproduce the host's absences rather than substitute behaviour", () => {
    const mock = RUNTIME_FACADE_PROVIDER_EXPECTATIONS.mock;
    const host = RUNTIME_FACADE_PROVIDER_EXPECTATIONS.host;
    expect(mock.realRuntimeRequired).toBe(false);
    expect(host.realRuntimeRequired).toBe(true);
    expect(mock.missingCapabilityOutcome).toMatch(/undefined/);
    expect(host.supplies).toMatch(/props/);
  });

  // The two `false` members are the ones #22/#23 build against, and the ones a
  // reviewer has to be able to check.
  it("forbids authored source from branching on the host or reading globals", () => {
    expect(RUNTIME_FACADE_RESOLUTION_MODEL.authoredSourceBranchesOnHost).toBe(false);
    expect(RUNTIME_FACADE_RESOLUTION_MODEL.authoredSourceReadsHostGlobals).toBe(false);
    expect(RUNTIME_FACADE_RESOLUTION_MODEL.providersSharePublicSurface).toBe(true);
  });
});

// The binding is modelled after the three calls #5 actually executed, not as a
// resolver invented here: the name is the first argument, the options object is
// optional, and the option fields act server-side.
describe("the confirmed useDataSource binding", () => {
  it("takes the name first and the options object second", () => {
    const binding: DataSourceBinding = (name, options) => ({
      data: options?.top === 3 ? [{ month: "6月" }, { month: "5月" }, { month: "4月" }] : [],
      totalCount: 72,
      loading: false,
      error: null,
    });

    const result = binding("Sales", { top: 3 });
    expect(result.data).toHaveLength(3);
    // `totalCount` is the server-side count and stays put while `top` limits rows.
    expect(result.totalCount).toBe(72);
  });

  // #5's third executed call passes the name alone, so the options object is
  // optional rather than required by the type.
  it("accepts the name on its own, the way #5's unknown-source call did", () => {
    const seen: string[] = [];
    const binding: DataSourceBinding = name => {
      seen.push(name);
      return noSuchSource(name);
    };

    const result = binding("NoSuchSource");
    expect(seen).toEqual(["NoSuchSource"]);
    expect(result.error).toMatch(/was not found: NoSuchSource/);
    expect(result.data).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it("keeps the option fields #5 proved act server-side", () => {
    const options: DataSourceQueryOptions = {
      top: 2,
      offset: 1,
      orderBySqlParams: [{ ColumnName: "销售额", Order: "DESC" }],
    };
    expect(options.top).toBe(2);
    expect(options.offset).toBe(1);
    expect(options.orderBySqlParams?.[0]?.ColumnName).toBe("销售额");
    expect(CELL_DATA_SOURCE_CONTRACT.pageSizeCountsAreServerSide).toBe(true);
  });

  // Port-level, not façade-level: both providers implement the same confirmed
  // binding, so a consumer cannot tell which one it holds. That is the provider
  // substitutability #27 requires; authored façade usage on top of the port is
  // #29's to build, and this test does not claim to be it.
  it("lets both providers satisfy the same binding", () => {
    // Answers by name, the way the real binding does: a declared source returns a
    // result, anything else returns #5's error state.
    const sales: DataSourceBinding = name =>
      name === "Sales" ? { data: [], totalCount: 72, loading: false, error: null } : noSuchSource(name);

    const host = providerOf("host", { useDataSource: sales });
    const mock = providerOf("mock", { useDataSource: sales });

    /** A port consumer, written once and handed either provider's bindings. */
    function readSales(bindings: RuntimeFacadeHostBindings): DataSourceResult {
      return bindings.useDataSource("Sales", { top: 3 });
    }

    expect(readSales(host.bindings).totalCount).toBe(72);
    expect(readSales(mock.bindings).totalCount).toBe(72);
    expect(Object.keys(mock.bindings).sort()).toEqual(Object.keys(host.bindings).sort());
  });

  // #5 records the undeclared case as an error state rather than a throw, so the
  // port's default mock must answer that way instead of omitting the member.
  it("answers an undeclared source with an error state rather than a throw", () => {
    const bindings = mockBindings();
    expect(() => bindings.useDataSource("NoSuchSource")).not.toThrow();
    expect(bindings.useDataSource("NoSuchSource").error).toMatch(/was not found/);
  });
});

describe("the data-source result", () => {
  const base: DataSourceResult = { data: [], totalCount: 0, loading: false, error: null };

  it("requires exactly the result fields #5 executed against", () => {
    expect([...CELL_DATA_SOURCE_CONTRACT.resultFieldsExecuted].sort()).toEqual([
      "data",
      "error",
      "loading",
      "totalCount",
    ]);

    expect(Object.keys(base)).toHaveLength(4);

    // The interface writes these four out instead of deriving them from `core`,
    // because `resultFieldsExecuted` is a mutable `string[]` rather than a literal
    // tuple. Each one is therefore asserted required by name, so the written-down
    // list cannot rot into optionals.
    // @ts-expect-error `totalCount` is part of the executed result
    const missingTotalCount: DataSourceResult = { data: [], loading: false, error: null };
    // @ts-expect-error `data` is part of the executed result
    const missingData: DataSourceResult = { totalCount: 0, loading: false, error: null };
    // @ts-expect-error `loading` is part of the executed result
    const missingLoading: DataSourceResult = { data: [], totalCount: 0, error: null };
    // @ts-expect-error `error` is part of the executed result
    const missingError: DataSourceResult = { data: [], totalCount: 0, loading: false };

    expect([missingTotalCount, missingData, missingLoading, missingError]).toHaveLength(4);
  });

  // `reload` is documented but was never observed on a result, so it is optional.
  // It is declared explicitly rather than through a string index signature: an
  // index signature would let a misspelling through, and unconfirmed names are
  // omitted rather than guessed.
  it("admits the documented-only reload field without requiring it", () => {
    expect([...CELL_DATA_SOURCE_CONTRACT.resultFieldsDocumented]).toContain("reload");

    const withReload: DataSourceResult = { ...base, reload: () => undefined };
    expect(typeof withReload.reload).toBe("function");

    const withoutReload: DataSourceResult = { ...base };
    expect(withoutReload.reload).toBeUndefined();

    // @ts-expect-error an unrecorded field name is not admitted
    const misspelled: DataSourceResult = { ...base, relaod: () => undefined };
    expect(misspelled).toBeDefined();
  });
});

describe("port coverage", () => {
  it("provides a channel for every binding the registry admits", () => {
    expect(runtimeFacadePortChannels()).toEqual(["cell-props", "use-data-source"]);
    expect([...RUNTIME_FACADE_PORT_CHANNELS]).toEqual(["cell-props", "use-data-source"]);
    expect(() => assertRuntimeFacadePortCoversAdmittedCapabilities()).not.toThrow();
  });

  // The channel union is forced exhaustive over the member map by `satisfies`,
  // and the map's values must be real member names. This pins the runtime half,
  // so a channel and a member cannot get out of step unnoticed.
  it("names the port member that carries each channel", () => {
    expect(Object.values(RUNTIME_FACADE_PORT_CHANNEL_MEMBERS).sort()).toEqual(
      Object.keys(mockBindings()).sort(),
    );
  });

  it("routes prop bindings to props and the confirmed hook to its own channel", () => {
    expect(runtimeFacadePortChannelOfBinding({ kind: "cell-prop", prop: "ServerCommands" })).toBe(
      "cell-props",
    );
    expect(runtimeFacadePortChannelOfBinding({ kind: "forguncy-member", member: "hasPermission" })).toBe(
      "cell-props",
    );
    expect(
      runtimeFacadePortChannelOfBinding({ kind: "cell-hook", hook: RUNTIME_FACADE_PORT_HOOK_NAME }),
    ).toBe("use-data-source");
  });

  // The guarantee the previous round could not make: the mapping is keyed on the
  // binding's identity, so a *second* wrapper-local is not silently treated as
  // covered by the useDataSource channel.
  it("refuses a wrapper-local the port has no member for", () => {
    const otherHook = { kind: "cell-hook", hook: "someOtherWrapperLocal" } as const;

    expect(runtimeFacadePortChannelOfBinding(otherHook)).toBeUndefined();
    expect(runtimeFacadePortCoversBinding(otherHook)).toBe(false);

    let caught: unknown;
    try {
      assertRuntimeFacadePortCoversAdmittedCapabilities([
        { ...findRuntimeFacadeCapability("data-source-binding"), hostBindings: [otherHook] },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).message).toMatch(/has no channel for/);
  });
});

// #27's packaging section: a façade that is host-backed "must not add a duplicate
// runtime copy per Cell unless intentionally tiny and stateless".
describe("packaging policy", () => {
  // #29 amended this from a single `holdsModuleState: false` because implementing
  // #27's own "resolved from the installed provider" needs one thing held. The
  // test therefore asserts both halves of what replaced it: the slot exists, and
  // what the policy was protecting (no domain state) still does not.
  it("takes the tiny-and-slot-bearing exception instead of the per-cell prohibition", () => {
    expect(RUNTIME_FACADE_PACKAGING_POLICY.holdsProviderSlot).toBe(true);
    expect(RUNTIME_FACADE_PACKAGING_POLICY.holdsDomainState).toBe(false);
    expect(RUNTIME_FACADE_PACKAGING_POLICY.perCellDuplicateAllowed).toBe(true);
    expect(RUNTIME_FACADE_PACKAGING_POLICY.reason).toMatch(/#14/);
  });

  // Lowering is #6's decision, not this contract's; stating it here would let the
  // façade's module claim the compiler's boundary.
  it("leaves import lowering to the compiler boundary", () => {
    expect(RUNTIME_FACADE_PACKAGING_POLICY.compilerOwnsImportLowering).toBe(true);
    expect(RUNTIME_FACADE_PACKAGING_POLICY.reason).toMatch(/#6/);
  });
});

// #27's non-goals, expressed against the #4 concern each would have duplicated.
describe("non-goal boundaries", () => {
  it("records exactly the six boundaries, in order", () => {
    expect([...RUNTIME_FACADE_BOUNDARY_IDS]).toEqual([
      "no-application-router",
      "no-cross-cell-state-store",
      "no-business-data-layer",
      "no-auth-implementation",
      "no-page-lifecycle-orchestration",
      "no-host-api-mirror",
    ]);
    expect(RUNTIME_FACADE_BOUNDARIES.map(boundary => boundary.id)).toEqual([...RUNTIME_FACADE_BOUNDARY_IDS]);
  });

  it("protects only concerns #4 assigned to Forguncy", () => {
    expect(() => assertRuntimeFacadeBoundariesProtectApplicationConcerns()).not.toThrow();
    for (const boundary of RUNTIME_FACADE_BOUNDARIES) {
      expect(boundary.protects.length, boundary.id).toBeGreaterThan(0);
      expect(boundary.why.trim().length, boundary.id).toBeGreaterThan(20);
      for (const concern of boundary.protects) {
        expect(isApplicationOwned(concern), `${boundary.id}:${concern}`).toBe(true);
      }
    }
  });

  // Otherwise "the façade is not an application framework" would only cover the
  // concerns the other five boundaries happened to list.
  it("covers every Forguncy-owned concern under the catch-all boundary", () => {
    const mirror = RUNTIME_FACADE_BOUNDARIES.find(boundary => boundary.id === "no-host-api-mirror");
    expect(mirror).toBeDefined();
    expect(mirror?.protects).toEqual(concernsOwnedBy("forguncy"));
    expect([...APPLICATION_OWNED_CONCERNS]).toEqual(concernsOwnedBy("forguncy"));
  });

  it("maps each concern a Cell could duplicate back to the boundary that guards it", () => {
    expect(findRuntimeFacadeBoundaryForConcern("application-navigation")?.id).toBe("no-application-router");
    expect(findRuntimeFacadeBoundaryForConcern("application-state")?.id).toBe("no-cross-cell-state-store");
    expect(findRuntimeFacadeBoundaryForConcern("business-data-source")?.id).toBe("no-business-data-layer");
    expect(findRuntimeFacadeBoundaryForConcern("permissions")?.id).toBe("no-auth-implementation");
    expect(findRuntimeFacadeBoundaryForConcern("page-lifecycle")?.id).toBe(
      "no-page-lifecycle-orchestration",
    );
  });

  it("does not pretend a cell-owned concern is a boundary", () => {
    expect(findRuntimeFacadeBoundaryForConcern("cell-ui")).toBeUndefined();
    expect(findRuntimeFacadeBoundaryForConcern("cell-editors")).toBeUndefined();
  });

  // The inversion this guard exists to catch: "the façade does not manage
  // animation" reads like a boundary but is only a scope note.
  it("refuses a boundary that guards a concern the cell owns", () => {
    const inverted: RuntimeFacadeBoundary = {
      id: "no-application-router",
      statement: "Keep rendering out of the façade.",
      protects: ["cell-visualization"],
      why: "Animation is browser UI, so a cell should own it.",
    };
    let caught: unknown;
    try {
      assertRuntimeFacadeBoundariesProtectApplicationConcerns([inverted]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("boundary-not-admissible");
    expect((caught as RuntimeFacadeContractError).message).toMatch(/assigns to the cell/);
  });
});

// #27's Problem section names the coupling the façade exists to remove; these are
// the patterns that reintroduce it, recorded so a reviewer or a future lint has
// something to refuse by.
describe("authoring patterns the façade replaces", () => {
  it("records exactly the four patterns, in order", () => {
    expect([...RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS]).toEqual([
      "host-global-sniffing",
      "host-branching",
      "prop-plumbing",
      "second-address-for-a-cell-binding",
    ]);
    expect(RUNTIME_FACADE_FORBIDDEN_PATTERNS.map(pattern => pattern.id)).toEqual([
      ...RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS,
    ]);
  });

  it("gives every pattern something to look for and something to use instead", () => {
    for (const pattern of RUNTIME_FACADE_FORBIDDEN_PATTERNS) {
      expect(pattern.lookFor.trim().length, pattern.id).toBeGreaterThan(10);
      expect(pattern.reason.trim().length, pattern.id).toBeGreaterThan(20);
      expect(pattern.use.trim().length, pattern.id).toBeGreaterThan(10);
    }
  });

  it("asks for a provider rather than a host branch", () => {
    const branching = RUNTIME_FACADE_FORBIDDEN_PATTERNS.find(pattern => pattern.id === "host-branching");
    expect(branching?.reason).toMatch(/#22\/#23/);
    expect(branching?.use).toMatch(/mock provider/);
  });
});
