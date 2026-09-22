import { afterEach, describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

import { RUNTIME_FACADE_CAPABILITY_IDS, RuntimeFacadeContractError } from "./capabilities";
import {
  assertRuntimeFacadeSurfaceIsExposed,
  auditRuntimeFacadeSurface,
  findRuntimeFacadeSurfaceMember,
  RUNTIME_FACADE_CELL_PROP_ADDRESSES,
  RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES,
  RUNTIME_FACADE_SURFACE,
  RUNTIME_FACADE_SURFACE_FINDING_IDS,
  RUNTIME_FACADE_SURFACE_MEMBER_IDS,
  runtimeFacade,
  runtimeFacadeExposedAddressNames,
  runtimeFacadeMemberCarriesBinding,
  runtimeFacadeSurface,
} from "./facade";
import type { RuntimeFacade, RuntimeFacadeSurfaceMember } from "./facade";
import { createMockDataSource, createMockRuntimeFacadeProvider } from "./mock-provider";
import { installRuntimeFacadeProvider, uninstallRuntimeFacadeProvider } from "./provider";

afterEach(() => {
  uninstallRuntimeFacadeProvider();
});

describe("the surface registry", () => {
  /**
   * #27's first acceptance criterion — "every facade API maps to a confirmed
   * host/product capability" — in the form that can fail.
   *
   * Two directions, because either alone is satisfiable by a lie: a member
   * exposing something the registry never admitted, and an admitted capability no
   * member exposes (authored source then has no way to reach it through the
   * façade, which is the state #29 exists to end).
   */
  it("exposes exactly the admitted capabilities", () => {
    const exposed = new Set(RUNTIME_FACADE_SURFACE.flatMap(member => member.exposes));
    expect([...exposed].sort()).toEqual([...RUNTIME_FACADE_CAPABILITY_IDS].sort());
    expect(() => assertRuntimeFacadeSurfaceIsExposed()).not.toThrow();
    expect(auditRuntimeFacadeSurface()).toEqual([]);
  });

  // Four members rather than eleven is the whole design: one per confirmed call
  // shape, one per confirmed address family.
  it("records exactly the four members, in order", () => {
    expect([...RUNTIME_FACADE_SURFACE_MEMBER_IDS]).toEqual([
      "invokeServerCommand",
      "useDataSource",
      "cellProp",
      "forguncyMember",
    ]);
    expect(RUNTIME_FACADE_SURFACE.map(member => member.id)).toEqual([...RUNTIME_FACADE_SURFACE_MEMBER_IDS]);
    for (const member of RUNTIME_FACADE_SURFACE) {
      expect(member.summary.trim().length, member.id).toBeGreaterThan(10);
      expect(member.exposes.length, member.id).toBeGreaterThan(0);
    }
  });

  // The registry is the contract; the accessor is what a Cell gets. Comparing
  // them is the only way a documented member cannot exist without being callable
  // — and it is also what keeps the surface from growing a provider-facing member
  // (`kind`, `bindings`), which is the coupling #27 names.
  it("returns exactly the members it registers, and nothing else", () => {
    const returned = Object.keys(runtimeFacadeSurface()).sort();
    expect(returned).toEqual([...RUNTIME_FACADE_SURFACE_MEMBER_IDS].sort());
    expect(returned).not.toContain("kind");
    expect(returned).not.toContain("bindings");
    expect(returned).not.toContain("provider");
  });

  it("carries each member's confirmed signature strength", () => {
    const typed = RUNTIME_FACADE_SURFACE.filter(
      member => member.signature === "confirmed-call-shape",
    ).map(member => member.id);
    expect(typed).toEqual(["invokeServerCommand", "useDataSource"]);
  });

  it("refuses an unknown member id rather than returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findRuntimeFacadeSurfaceMember("navigate")).toThrow(/Unknown façade surface member/);
  });
});

// A member's *address domain* is derived from the two registries, and the
// accessors' parameter types are literal tuples because a parameter type cannot
// be computed from them. This is where the two are allowed to meet, so drift is a
// failing test rather than a call that compiles and throws.
describe("accessor address domains", () => {
  function sorted(names: readonly string[]): readonly string[] {
    return [...names].sort();
  }

  it("derives the cellProp domain from the capabilities it exposes", () => {
    expect(sorted(runtimeFacadeExposedAddressNames("cellProp"))).toEqual(
      sorted([...RUNTIME_FACADE_CELL_PROP_ADDRESSES]),
    );
    expect(new Set(RUNTIME_FACADE_CELL_PROP_ADDRESSES).size).toBe(
      RUNTIME_FACADE_CELL_PROP_ADDRESSES.length,
    );
    for (const key of RUNTIME_FACADE_CELL_PROP_ADDRESSES) {
      expect(CELL_PROPS_BASE_KEYS, key).toContain(key);
    }
  });

  it("derives the forguncyMember domain from the capabilities it exposes", () => {
    expect(sorted(runtimeFacadeExposedAddressNames("forguncyMember"))).toEqual(
      sorted([...RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES]),
    );
    expect(new Set(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES).size).toBe(
      RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES.length,
    );
    for (const member of RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES) {
      expect(CELL_FORGUNCY_PROP_KEYS, member).toContain(member);
    }
  });

  /**
   * The exclusions, asserted rather than left to a reader's arithmetic.
   *
   * Each one has a reason, and each reason is a rule this repository already
   * holds: `ServerCommands` has a call-shaped member of its own, `Permissions` is
   * the base prop the same capability already exposes, and the two
   * `DataSource*Type` members are names a Cell can already use without an import
   * (#5's user-scope table), so addressing them would give one value two
   * spellings.
   */
  it("keeps the addresses another member or the cell scope already owns out of the accessors", () => {
    expect(RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).not.toContain("ServerCommands");
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain("Permissions");
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain(
      "DataSourceCompareType",
    );
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain(
      "DataSourceRelationType",
    );

    // Each omitted name is a real confirmed address, so the exclusions are
    // choices rather than gaps in #5's evidence.
    expect(CELL_PROPS_BASE_KEYS).toContain("ServerCommands");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("Permissions");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("DataSourceCompareType");
  });

  // Keyed on the address rather than on the kind, so a second wrapper-local
  // cannot ride along on useDataSource's channel.
  it("matches a wrapper-local by name, not by being a wrapper-local", () => {
    const hookMember = findRuntimeFacadeSurfaceMember("useDataSource");
    expect(
      runtimeFacadeMemberCarriesBinding(hookMember, { kind: "cell-hook", hook: "useDataSource" }),
    ).toBe(true);
    expect(
      runtimeFacadeMemberCarriesBinding(hookMember, { kind: "cell-hook", hook: "someOtherLocal" }),
    ).toBe(false);
  });
});

// The audit is the guard #27 never had: the registry can be internally consistent
// and still describe a surface nobody implemented, or a surface that is reachable
// only through an address its member cannot carry. Each finding is driven by a
// mutation of the registry, so the check is asserted rather than assumed.
describe("surface audit", () => {
  function findingsFrom(members: readonly RuntimeFacadeSurfaceMember[]): readonly string[] {
    return auditRuntimeFacadeSurface(members).map(finding => finding.id);
  }

  it("records exactly the seven findings it can report", () => {
    expect([...RUNTIME_FACADE_SURFACE_FINDING_IDS]).toEqual([
      "member-exposes-nothing",
      "capability-not-admitted",
      "signature-outruns-confirmation",
      "capability-unexposed",
      "address-unreachable",
      "member-not-implemented",
      "surface-member-unregistered",
    ]);
  });

  it("refuses a member that exposes no capability", () => {
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "forguncyMember" ? { ...member, exposes: [] } : member,
    );
    expect(findingsFrom(members)).toContain("member-exposes-nothing");
  });

  // The `navigate` case #27 forbids by name: a member whose address is not in the
  // registry has to be reported, not resolved.
  it("refuses a member that exposes a capability the registry does not admit", () => {
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "forguncyMember"
        ? { ...member, exposes: [...member.exposes, "application-navigation" as never] }
        : member,
    );
    expect(findingsFrom(members)).toContain("capability-not-admitted");
  });

  it("refuses a signature that outruns the confirmation, in both directions", () => {
    const downgraded = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "invokeServerCommand" ? { ...member, signature: "caller-declared-shape" as const } : member,
    );
    expect(findingsFrom(downgraded)).toContain("signature-outruns-confirmation");

    const upgraded = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "cellProp" ? { ...member, signature: "confirmed-call-shape" as const } : member,
    );
    expect(findingsFrom(upgraded)).toContain("signature-outruns-confirmation");
  });

  it("names a capability no member exposes", () => {
    const members = RUNTIME_FACADE_SURFACE.filter(member => member.id !== "forguncyMember");
    const findings = auditRuntimeFacadeSurface(members);
    expect(findings.map(finding => finding.id)).toContain("capability-unexposed");
    expect(
      findings
        .filter(finding => finding.id === "capability-unexposed")
        .map(finding => finding.capability),
    ).toContain("permission-check");
  });

  // The narrow case, and the one the first draft of this design got wrong: the
  // capability *is* exposed, but through a member that cannot carry one of its
  // two addresses.
  it("names an address the members that expose it cannot carry", () => {
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "cellProp"
        ? { ...member, exposes: ["permission-snapshot" as const], carrier: { kind: "forguncy-member" as const } }
        : member,
    );
    const finding = auditRuntimeFacadeSurface(members).find(
      candidate => candidate.id === "address-unreachable",
    );
    expect(finding?.capability).toBe("permission-snapshot");
    expect(finding?.address).toBe("Permissions");
  });

  it("catches a registered member the accessor does not return", () => {
    const implemented = withoutMember("cellProp");
    expect(auditRuntimeFacadeSurface(RUNTIME_FACADE_SURFACE, implemented).map(f => f.id)).toContain(
      "member-not-implemented",
    );
  });

  it("catches a returned member the registry does not declare", () => {
    const implemented = { ...runtimeFacadeSurface(), navigate: () => undefined } as unknown as RuntimeFacade;
    const findings = auditRuntimeFacadeSurface(RUNTIME_FACADE_SURFACE, implemented);
    expect(findings.map(finding => finding.id)).toContain("surface-member-unregistered");
    expect(findings.find(finding => finding.id === "surface-member-unregistered")?.statement).toMatch(
      /navigate/,
    );
  });

  it("reports every finding at once, and refuses with a contract error", () => {
    const members = RUNTIME_FACADE_SURFACE.filter(member => member.id !== "forguncyMember");
    expect(auditRuntimeFacadeSurface(members).length).toBeGreaterThan(1);

    let caught: unknown;
    try {
      assertRuntimeFacadeSurfaceIsExposed(members);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("surface-not-exposed");
  });
});

function withoutMember(id: (typeof RUNTIME_FACADE_SURFACE_MEMBER_IDS)[number]): RuntimeFacade {
  const copy: Record<string, unknown> = { ...runtimeFacadeSurface() };
  delete copy[id];
  return copy as unknown as RuntimeFacade;
}

// #27's second and fifth acceptance criteria, at the point of use: a Cell reaches
// the supported capabilities through the façade, and an unsupported one fails
// clearly instead of answering with a plausible value.
describe("resolving through the installed provider", () => {
  function installMock(): void {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: { hasPermission: async (email: string) => email.endsWith("@example.com") },
        cellProps: { Permissions: [{ key: "Orders.Read" }] },
        // The call shape #5 executed: one object argument.
        serverCommands: {
          GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", echo: payload }),
        },
        dataSources: { Sales: createMockDataSource([{ month: "6月" }], { totalCount: 72 }) },
      }),
    );
  }

  it("reads a base prop under its confirmed name", () => {
    installMock();
    expect(runtimeFacade().cellProp("Permissions")).toEqual([{ key: "Orders.Read" }]);
  });

  // The rule that separates a value prop from a function member: #5 pinned the
  // key, and the emptiness of `Permissions` is an open question, so `undefined`
  // is passed through rather than refused.
  it("passes an undefined value prop through instead of inventing an error", () => {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
    expect(runtimeFacade().cellProp("ImageContext")).toBeUndefined();
  });

  it("reaches a handle member and lets the declared shape call it", async () => {
    installMock();
    const hasPermission = runtimeFacade().forguncyMember<(email: string) => Promise<boolean>>(
      "hasPermission",
    );
    await expect(hasPermission("dev@example.com")).resolves.toBe(true);
    await expect(hasPermission("dev@other.test")).resolves.toBe(false);
  });

  it("reads a declared data source, and keeps the host's error state for an undeclared one", () => {
    installMock();
    const source = runtimeFacade().useDataSource("Sales", { top: 3 });
    expect(source.totalCount).toBe(72);
    expect(source.data).toHaveLength(1);

    // Not a throw: #5 records an undeclared source as a state, so the façade
    // passes the host's own shape through.
    const missing = runtimeFacade().useDataSource("NotDeclared");
    expect(missing.error).toBeTruthy();
    expect(String(missing.error)).toContain("NotDeclared");
  });

  it("returns the reserved keys and the command's own named returns", async () => {
    installMock();
    const result = await runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>()
      .invokeServerCommand("GetSalesData", { top: 5 });
    expect(result.errorCode).toBe(0);
    expect(result.errorMessage).toBe("OK");
    expect(result.echo).toEqual({ top: 5 });
  });

  /**
   * The order the façade refuses in, which is a decision rather than an accident.
   *
   * A missing provider is the precondition of the whole surface, so it is reported
   * first — a harness that forgot to install one gets that answer instead of a
   * resolution detail it cannot act on. Once a provider exists, the *address* is
   * checked before the provider is read at all, because a name the façade does not
   * expose is a code mistake and should not be reported as a page-data problem.
   */
  it("refuses the precondition first, then the address, before reading the provider", () => {
    uninstallRuntimeFacadeProvider();
    expect(() => runtimeFacade()).toThrow(/No runtime façade provider is installed/);

    // A provider that carries nothing on the `cellProps` channel: the wrong
    // address below must be reported as a wrong address, not as the missing prop
    // it would have been if the provider had been read first.
    installRuntimeFacadeProvider({
      kind: "mock",
      bindings: { cellProps: { Forguncy: {} }, useDataSource: () => ({}) } as never,
    });
    expect(() => runtimeFacade().cellProp("NotABaseProp" as never)).toThrow(/not a base prop #5 verified/);
    expect(() => runtimeFacade().cellProp("Permissions")).toThrow(/does not carry "Permissions"/);
  });

  it("names the member to use instead when a confirmed address belongs to another one", () => {
    installMock();
    let caught: unknown;
    try {
      runtimeFacade().cellProp("ServerCommands" as never);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/not the member that exposes it/);
  });
});

/**
 * The type-level half, where the guarantees are cheap to break.
 *
 * The `@ts-expect-error` directives below live in functions that are **never
 * called**, and that is deliberate rather than tidy: `invokeServerCommand` is
 * `async`, so executing a case that only exists to be type-checked would produce
 * a rejected promise, which vitest reports as an unhandled rejection and which
 * would hide the assertion it was meant to make. `tsc -p tsconfig.typecheck.json`
 * is what evaluates them, and CI runs it, so a directive that stops being an
 * error fails the build instead of quietly passing.
 *
 * Each case is paired with the *working* form of the same call in the tests
 * below, so a directive cannot be satisfied by a member that simply does not
 * exist.
 */
function typeOnlyUndeclaredCommandCall(): void {
  // @ts-expect-error a bare façade admits no command call: `keyof Record<never, never>` is `never`
  void runtimeFacade().invokeServerCommand("GetSalesData", {});
  // @ts-expect-error a declared tuple pins the arguments #5 observed, no more
  void runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>().invokeServerCommand(
    "GetSalesData",
  );
}

function typeOnlyUndeclaredShape(): void {
  const unclaimed = runtimeFacade().forguncyMember("hasPermission");
  // @ts-expect-error `unknown` is not callable
  unclaimed();
  // @ts-expect-error `unknown` does not narrow to a declared type on its own
  const asBoolean: boolean = unclaimed;
  void asBoolean;

  const permissions = runtimeFacade().cellProp("Permissions");
  // @ts-expect-error a base prop is `unknown` until its shape is declared too
  const entries: readonly string[] = permissions;
  void entries;
}

function typeOnlyWrongAddress(): void {
  const facade = runtimeFacade();
  // @ts-expect-error `ServerCommands` is exposed through `invokeServerCommand`
  void facade.cellProp("ServerCommands");
  // @ts-expect-error `Permissions` is the base prop, not a handle address
  void facade.forguncyMember("Permissions");
  // @ts-expect-error a wrapper-local is already reachable in cell source
  void facade.forguncyMember("DataSourceCompareType");
  // @ts-expect-error a name #5 never verified is not an address at all
  void facade.cellProp("NotABaseProp");
}

describe("what the types refuse", () => {
  function installMock(): void {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: { hasPermission: async () => true },
        cellProps: { Permissions: [{ key: "Orders.Read" }] },
        serverCommands: { GetSalesData: async () => ({ errorCode: 0 }) },
      }),
    );
  }

  it("admits no command call until a declaration supplies the parameters", () => {
    installMock();
    expect(typeOnlyUndeclaredCommandCall).toBeTypeOf("function");

    // The same member *is* callable once the declaration is supplied, so the
    // refusal above is the declaration's absence rather than a missing member.
    const declared = runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>();
    expect(typeof declared.invokeServerCommand).toBe("function");
  });

  it("leaves an undeclared shape unusable rather than plausible", async () => {
    installMock();
    expect(typeOnlyUndeclaredShape).toBeTypeOf("function");

    // Both halves of the pair: un-declared is unusable, declared works.
    expect(runtimeFacade().forguncyMember("hasPermission")).toBeTypeOf("function");
    expect(runtimeFacade().cellProp("Permissions")).toEqual([{ key: "Orders.Read" }]);
    await expect(
      runtimeFacade().forguncyMember<() => Promise<boolean>>("hasPermission")(),
    ).resolves.toBe(true);
  });

  it("refuses an address that belongs to another member or to the cell scope", () => {
    installMock();
    expect(typeOnlyWrongAddress).toBeTypeOf("function");

    // The runtime guard agrees with the type, because a name can also arrive from
    // JavaScript that never saw either.
    expect(() => runtimeFacade().cellProp("ServerCommands" as never)).toThrow(/not the member that exposes/);
    expect(() => runtimeFacade().forguncyMember("DataSourceCompareType" as never)).toThrow(
      /does not expose it/,
    );
  });
});
