import { describe, expect, it } from "vitest";

import {
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
  findRuntimeFacadeBoundaryForConcern,
  RUNTIME_FACADE_BOUNDARIES,
  RUNTIME_FACADE_BOUNDARY_IDS,
  RUNTIME_FACADE_FORBIDDEN_PATTERNS,
  RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS,
  RUNTIME_FACADE_PACKAGING_POLICY,
  RUNTIME_FACADE_PROVIDER_EXPECTATIONS,
  RUNTIME_FACADE_PROVIDER_KINDS,
  RUNTIME_FACADE_RESOLUTION_MODEL,
} from "./contract";
import type { RuntimeFacadeBoundary, RuntimeFacadeCellProps, RuntimeFacadeHostBindings, RuntimeFacadeProvider } from "./contract";

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

function mockProvider(overrides: Partial<RuntimeFacadeCellProps> = {}): RuntimeFacadeProvider {
  return { kind: "mock", bindings: { cellProps: mockCellProps(overrides) } };
}

// #27's second acceptance criterion is that a server command "can be authored
// with TypeScript-friendly facade usage instead of raw prop plumbing when
// feasible". The shape asserted here is #5's, not a convenient invention: the
// reserved result keys, the named returns beside them, and the `undefined` a
// name the designer never configured produces.
describe("the confirmed server-command call shape", () => {
  it("carries the reserved result keys #5 pins", () => {
    expect([...CELL_SERVER_COMMANDS_CONTRACT.resultKeys].sort()).toEqual(["errorCode", "errorMessage"]);
  });

  it("lets authored source call a configured command and read a named return", async () => {
    const sent: unknown[] = [];
    const bindings: RuntimeFacadeHostBindings = {
      cellProps: mockCellProps({
        ServerCommands: {
          CreateOrder: async (...parameters: readonly unknown[]) => {
            sent.push(parameters[0]);
            // `errorCode` beside a command's own named return is exactly the
            // shape #5 records ("namedReturnsAreExtraKeys").
            return { errorCode: 0, orderId: "SO-2026-0001" };
          },
        },
      }),
    };

    const createOrder = bindings.cellProps.ServerCommands.CreateOrder;
    expect(typeof createOrder).toBe("function");
    if (!createOrder) {
      throw new Error("the configured command should be present on the record");
    }

    const result = await createOrder("SO-2026-0001");
    expect(sent).toEqual(["SO-2026-0001"]);
    expect(result.errorCode).toBe(0);
    expect(result.orderId).toBe("SO-2026-0001");
  });

  // #5 records this as the behaviour of a name that was not configured, and it is
  // a plain TypeError rather than a platform error — so the type has to admit
  // `undefined` instead of pretending every name resolves.
  it("keeps an unconfigured command name absent rather than inventing a rejection", () => {
    const bindings: RuntimeFacadeHostBindings = { cellProps: mockCellProps() };
    expect(bindings.cellProps.ServerCommands.NotConfigured).toBeUndefined();
  });
});

// #27's fourth acceptance criterion: "Local dev can provide mocks for the same
// public facade."
describe("the provider boundary", () => {
  it("makes the host and the mock the same type, so authored source cannot tell them apart", () => {
    const host: RuntimeFacadeProvider = {
      kind: "host",
      bindings: { cellProps: mockCellProps({ Permissions: [{ key: "Orders.Read" }] }) },
    };
    const mock: RuntimeFacadeProvider = mockProvider();

    expect(host.kind).toBe("host");
    expect(mock.kind).toBe("mock");
    expect(Object.keys(mock.bindings.cellProps).sort()).toEqual(Object.keys(host.bindings.cellProps).sort());
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
