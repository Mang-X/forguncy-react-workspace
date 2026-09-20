import { describe, expect, it } from "vitest";

import {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
  CELL_SERVER_COMMANDS_CONTRACT,
  concernsOwnedBy,
  isApplicationOwned,
} from "@forguncy-react-workspace/core";

import { RuntimeFacadeContractError } from "./capabilities";
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
  RUNTIME_FACADE_PROVIDER_EXPECTATIONS,
  RUNTIME_FACADE_PROVIDER_KINDS,
  RUNTIME_FACADE_RESOLUTION_MODEL,
  runtimeFacadePortChannelOfBinding,
  runtimeFacadePortChannels,
} from "./contract";
import type {
  DataSourceBindings,
  DataSourceResult,
  RuntimeFacadeBoundary,
  RuntimeFacadeCellProps,
  RuntimeFacadeHostBindings,
  RuntimeFacadePortChannel,
  RuntimeFacadeProvider,
  ServerCommandCall,
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

interface MockBindingsOverrides {
  readonly cellProps?: Partial<RuntimeFacadeCellProps>;
  readonly dataSources?: DataSourceBindings;
}

function mockBindings(overrides: MockBindingsOverrides = {}): RuntimeFacadeHostBindings {
  return {
    cellProps: mockCellProps(overrides.cellProps),
    dataSources: overrides.dataSources ?? {},
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
// feasible". The shape asserted here is #5's, not a convenient invention: the
// reserved result keys, the named returns beside them, and the `undefined` a name
// the designer never configured produces.
describe("the confirmed server-command call shape", () => {
  it("carries the reserved result keys #5 pins", () => {
    expect([...CELL_SERVER_COMMANDS_CONTRACT.resultKeys].sort()).toEqual(["errorCode", "errorMessage"]);
  });

  it("lets authored source call a configured command and read a named return", async () => {
    const bindings = mockBindings({
      cellProps: {
        ServerCommands: {
          RefreshOrders: async () => {
            // `errorCode` beside a command's own named return is exactly the
            // shape #5 records ("namedReturnsAreExtraKeys").
            return { errorCode: 0, refreshed: 3 };
          },
        },
      },
    });

    const refreshOrders = bindings.cellProps.ServerCommands.RefreshOrders;
    expect(typeof refreshOrders).toBe("function");
    if (!refreshOrders) {
      throw new Error("the configured command should be present on the record");
    }

    const result = await refreshOrders();
    expect(result.errorCode).toBe(0);
    expect(result.refreshed).toBe(3);
  });

  // #5 records this as the behaviour of a name that was not configured, and it is
  // a plain TypeError rather than a platform error — so the type has to admit
  // `undefined` instead of pretending every name resolves.
  it("keeps an unconfigured command name absent rather than inventing a rejection", () => {
    const bindings = mockBindings();
    expect(bindings.cellProps.ServerCommands.NotConfigured).toBeUndefined();
  });

  // #5 pins what a *result* carries and never exercised a call with arguments, so
  // the base type admits no argument list. `readonly unknown[]` would read as
  // "every call form is valid", which is the widening #27's rule refuses.
  it("does not admit a parameter list #5 never observed", () => {
    const bindings = mockBindings({
      cellProps: { ServerCommands: { CreateOrder: async () => ({ errorCode: 0 }) } },
    });
    const createOrder = bindings.cellProps.ServerCommands.CreateOrder;
    if (createOrder) {
      // @ts-expect-error the base call type takes no parameters, because #5 verified none
      void createOrder({ orderId: "SO-1" });
    }
    expect(typeof createOrder).toBe("function");
  });

  // The other half of the same rule: narrowing is not forbidden, it just has to
  // be someone's claim. A project that knows its own command's parameters makes it.
  it("lets a command-specific declaration supply the parameters it knows", async () => {
    type CreateOrderParameters = [{ readonly orderId: string }];

    const createOrder: ServerCommandCall<CreateOrderParameters> = async parameters => {
      return { errorCode: 0, orderId: parameters.orderId };
    };

    const result = await createOrder({ orderId: "SO-2026-0001" });
    expect(result.orderId).toBe("SO-2026-0001");
  });
});

// #27's fourth acceptance criterion: "Local dev can provide mocks for the same
// public facade."
describe("the provider boundary", () => {
  it("makes the host and the mock the same type, so authored source cannot tell them apart", () => {
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

// The gap this suite exists to keep closed. `data-source-binding` is admitted,
// and its address is a wrapper-local rather than a prop, so a port built only
// from `props` gave a provider nowhere to supply it — which would have forced
// #29 either to bypass the provider or to add a second injection path. #22 also
// requires mock DataSource behaviour to be injectable by the example.
describe("data-source coverage on the port", () => {
  const ordersResult: DataSourceResult = {
    data: [{ id: "A-1" }],
    totalCount: 1,
    loading: false,
    error: null,
  };

  it("runs one authored data-source read under both providers", () => {
    const host = providerOf("host", { dataSources: { Orders: () => ordersResult } });
    const mock = providerOf("mock", { dataSources: { Orders: () => ordersResult } });

    /**
     * Authored once, parameterised only by which provider handed it bindings —
     * which is what "the same source runs unchanged under `vp dev`" means.
     */
    function orderCount(bindings: RuntimeFacadeHostBindings): unknown {
      const orders = bindings.dataSources.Orders;
      return orders ? orders().totalCount : undefined;
    }

    expect(orderCount(host.bindings)).toBe(1);
    expect(orderCount(mock.bindings)).toBe(1);
  });

  it("requires exactly the result fields #5 executed against", () => {
    expect([...CELL_DATA_SOURCE_CONTRACT.resultFieldsExecuted].sort()).toEqual([
      "data",
      "error",
      "loading",
      "totalCount",
    ]);

    const complete: DataSourceResult = { data: null, totalCount: 0, loading: false, error: null };
    expect(Object.keys(complete)).toHaveLength(4);

    // The interface writes these four out instead of deriving them from `core`,
    // because `resultFieldsExecuted` is a mutable `string[]` rather than a literal
    // tuple. Each one is therefore asserted required by name, so the written-down
    // list cannot rot into optionals.
    // @ts-expect-error `totalCount` is part of the executed result
    const missingTotalCount: DataSourceResult = { data: null, loading: false, error: null };
    // @ts-expect-error `data` is part of the executed result
    const missingData: DataSourceResult = { totalCount: 0, loading: false, error: null };
    // @ts-expect-error `loading` is part of the executed result
    const missingLoading: DataSourceResult = { data: null, totalCount: 0, error: null };
    // @ts-expect-error `error` is part of the executed result
    const missingError: DataSourceResult = { data: null, totalCount: 0, loading: false };

    expect([missingTotalCount, missingData, missingLoading, missingError]).toHaveLength(4);
  });

  // #5 documents `reload` but never observed it on a result, so it is admitted
  // through the extra-key member rather than required — "the host provides this"
  // and "the docs mention it" are different claims.
  it("admits a documented-only field without requiring it", () => {
    expect([...CELL_DATA_SOURCE_CONTRACT.resultFieldsDocumented]).toContain("reload");
    const withReload: DataSourceResult = {
      ...ordersResult,
      reload: () => undefined,
    };
    expect(typeof withReload.reload).toBe("function");
  });

  // #5 records the undeclared case as an error *state* rather than a throw, so a
  // missing key on the supply side is input to the façade, not a failure.
  it("leaves an undeclared data source absent for the façade to turn into a state", () => {
    expect(mockBindings().dataSources.Orders).toBeUndefined();
    expect(CELL_DATA_SOURCE_CONTRACT.unknownSourceOutcome).toMatch(/error state/);
  });
});

describe("port coverage", () => {
  it("provides a channel for every binding the registry admits", () => {
    expect(runtimeFacadePortChannels()).toEqual(["cell-props", "data-sources"]);
    expect([...RUNTIME_FACADE_PORT_CHANNELS]).toEqual(["cell-props", "data-sources"]);
    expect(() => assertRuntimeFacadePortCoversAdmittedCapabilities()).not.toThrow();
  });

  it("routes prop bindings to props and the wrapper-local to data sources", () => {
    expect(runtimeFacadePortChannelOfBinding({ kind: "cell-prop", prop: "ServerCommands" })).toBe(
      "cell-props",
    );
    expect(runtimeFacadePortChannelOfBinding({ kind: "forguncy-member", member: "hasPermission" })).toBe(
      "cell-props",
    );
    expect(runtimeFacadePortChannelOfBinding({ kind: "cell-hook", hook: "useDataSource" })).toBe(
      "data-sources",
    );
  });

  it("refuses a registry that needs a channel the port does not have", () => {
    const unprovided = "cell-hooks" as unknown as RuntimeFacadePortChannel;

    let caught: unknown;
    try {
      assertRuntimeFacadePortCoversAdmittedCapabilities(["cell-props", unprovided]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).message).toMatch(/does not provide/);
  });
});

// #27's packaging section: a façade that is host-backed "must not add a duplicate
// runtime copy per Cell unless intentionally tiny and stateless".
describe("packaging policy", () => {
  it("takes the stateless exception instead of the per-cell prohibition", () => {
    expect(RUNTIME_FACADE_PACKAGING_POLICY.holdsModuleState).toBe(false);
    expect(RUNTIME_FACADE_PACKAGING_POLICY.perCellDuplicateAllowed).toBe(true);
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
