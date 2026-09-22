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
import type { DataSourceResult, RuntimeFacadeCellProps } from "./contract";
import { createHostRuntimeFacadeProvider } from "./host-provider";
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

  // Six members rather than twelve is the whole design: one per confirmed call
  // shape, one per confirmed address family. The two handle calls joined the typed
  // half during review, when #5's comments turned out to record them being executed
  // where the key list only recorded their names.
  it("records exactly the six members, in order", () => {
    expect([...RUNTIME_FACADE_SURFACE_MEMBER_IDS]).toEqual([
      "invokeServerCommand",
      "useDataSource",
      "hasPermission",
      "getPermissions",
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
    expect(typed).toEqual(["invokeServerCommand", "useDataSource", "hasPermission", "getPermissions"]);

    // Each typed handle member's address is the host's own name for it, so a reader
    // can check the signature against #5 instead of decoding a rename.
    expect(runtimeFacadeExposedAddressNames("hasPermission")).toEqual(["hasPermission"]);
    expect(runtimeFacadeExposedAddressNames("getPermissions")).toEqual(["getPermissions"]);
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
    // The complement is the count, not a second list: `core` pins fourteen handle
    // members, five are reached elsewhere, and each of the five has a written reason
    // below. Asserting the *number* is what makes a sixth omission require a
    // sentence rather than passing as arithmetic a reader has to redo.
    expect(CELL_FORGUNCY_PROP_KEYS.length - RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES.length).toBe(5);
  });

  /**
   * The exclusions, asserted rather than left to a reader's arithmetic.
   *
   * Each one has a reason, and each reason is a rule this repository already
   * holds: `ServerCommands` has a call-shaped member of its own, `Permissions` is
   * the base prop the same capability already exposes, `hasPermission` and
   * `getPermissions` have typed members of their own, and the two
   * `DataSource*Type` members are names a Cell can already use without an import
   * (#5's user-scope table), so addressing them would give one value two
   * spellings.
   */
  it("keeps the addresses another member or the cell scope already owns out of the accessors", () => {
    expect(RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).not.toContain("ServerCommands");
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain("Permissions");
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain("hasPermission");
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).not.toContain(
      "getPermissions",
    );
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
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("hasPermission");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("getPermissions");
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
    ).toContain("current-user");
    // Exactly the six `forguncyMember` was the only surface for. The count is
    // asserted so a capability that quietly becomes reachable through nothing else
    // cannot hide behind the `toContain` above.
    expect(findings.filter(finding => finding.id === "capability-unexposed")).toHaveLength(6);
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
        // Synchronous, as #5 recorded them: `hasPermission("ProbePermission")` → `true`
        // and `getPermissions()` → `{"ProbePermission": true}`, neither awaited, beside a
        // command call the same section reports as `await … resolved in 185 ms`. A mock
        // that resolved them would be more permissive than the host, which is the one
        // direction a local harness must not lean.
        forguncyMembers: {
          hasPermission: (permissionName: string) => permissionName.endsWith("@readable"),
          getPermissions: () => ({ "dev@readable": true }),
          // One of the six #5 pinned by name only, so the declared-shape accessor has
          // something to reach that is not also a typed member.
          getCurrentUser: () => ({ userName: "dev@example.com" }),
        },
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

  it("reaches a handle member and lets the declared shape call it", () => {
    installMock();
    // `getCurrentUser` is presence-only, which is what the accessor is for: the façade
    // asserts the confirmed *address* and the caller declares the shape, because #5
    // pinned the name and never called it.
    const getCurrentUser = runtimeFacade().forguncyMember<() => { userName: string }>("getCurrentUser");
    expect(getCurrentUser().userName).toBe("dev@example.com");
  });

  // The other half of the same split, and the one review corrected: `hasPermission`
  // and `getPermissions` are *calls* #5 executed, so an author declares nothing and
  // awaits nothing.
  it("types the two handle calls #5 executed, so the author declares and awaits nothing", () => {
    installMock();
    expect(runtimeFacade().hasPermission("dev@readable")).toBe(true);
    expect(runtimeFacade().hasPermission("dev@other")).toBe(false);
    expect(runtimeFacade().getPermissions()).toEqual({ "dev@readable": true });
  });

  it("names the typed member when a confirmed call is reached through the accessor", () => {
    installMock();
    // Same rule as `cellProp("ServerCommands")`: one address, one member. Reaching a
    // typed call through the declared-shape accessor would give the façade a second
    // way to be called wrongly.
    expect(() => runtimeFacade().forguncyMember("hasPermission" as never)).toThrow(
      /not the member that exposes it/,
    );
    expect(() => runtimeFacade().forguncyMember("getPermissions" as never)).toThrow(
      /not the member that exposes it/,
    );
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
  const unclaimed = runtimeFacade().forguncyMember("getCurrentUser");
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
  // @ts-expect-error `hasPermission` is exposed through its own typed member
  void facade.forguncyMember("hasPermission");
  // @ts-expect-error a wrapper-local is already reachable in cell source
  void facade.forguncyMember("DataSourceCompareType");
  // @ts-expect-error a name #5 never verified is not an address at all
  void facade.cellProp("NotABaseProp");
}

/**
 * The permission map's type must not promise a boolean the runtime will not deliver.
 *
 * `getPermissions()` is `Readonly<Partial<Record<string, boolean>>>` and deliberately
 * not a plain `Record`, because #5 recorded one boolean per *configured* name and
 * nothing at all about the rest. This repository leaves `noUncheckedIndexedAccess`
 * off, so a plain `Record<string, boolean>` would let an arbitrary index read as
 * `boolean` while the value at runtime is `undefined` — a type stronger than the
 * evidence. The directive below is what keeps that from creeping back: restoring the
 * plain `Record` makes it an *unused* `@ts-expect-error`, which `tsc` fails on.
 *
 * The pair is completed by the runtime assertions in the test that calls this, where
 * a configured name really does carry `true` and an unconfigured one really is
 * `undefined` — so the type claims no more and the runtime delivers no less.
 */
function typeOnlyArbitraryPermissionKey(): void {
  const permissions = runtimeFacade().getPermissions();
  // @ts-expect-error an unconfigured name is `boolean | undefined`, not `boolean`
  const granted: boolean = permissions["NotConfigured"];
  void granted;

  // The usable form of the same read: acknowledging the absence compiles, so the
  // refusal above is the `undefined` rather than a member that never returns.
  const coalesced: boolean = permissions["NotConfigured"] ?? false;
  void coalesced;
}

describe("what the types refuse", () => {
  function installMock(): void {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        // Synchronous, as on the host: a promise here would be the shape the first
        // draft of this file asserted, and #5 never observed it.
        forguncyMembers: {
          hasPermission: (permissionName: string) => permissionName === "Orders.Read",
          getPermissions: () => ({ "Orders.Read": true }),
          getCurrentUser: () => ({ userName: "dev@example.com" }),
        },
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

  it("leaves an undeclared shape unusable rather than plausible", () => {
    installMock();
    expect(typeOnlyUndeclaredShape).toBeTypeOf("function");

    // Both halves of the pair: un-declared is unusable, declared works.
    expect(runtimeFacade().forguncyMember("getCurrentUser")).toBeTypeOf("function");
    expect(runtimeFacade().cellProp("Permissions")).toEqual([{ key: "Orders.Read" }]);
    expect(
      runtimeFacade().forguncyMember<() => { userName: string }>("getCurrentUser")().userName,
    ).toBe("dev@example.com");

    // And the other half of the split: the two confirmed calls need no declaration at
    // all, which is exactly what the confirmation level buys.
    expect(runtimeFacade().hasPermission("Orders.Read")).toBe(true);
    expect(runtimeFacade().getPermissions()).toEqual({ "Orders.Read": true });
  });

  it("refuses an address that belongs to another member or to the cell scope", () => {
    installMock();
    expect(typeOnlyWrongAddress).toBeTypeOf("function");

    // The runtime guard agrees with the type, because a name can also arrive from
    // JavaScript that never saw either.
    expect(() => runtimeFacade().cellProp("ServerCommands" as never)).toThrow(/not the member that exposes/);
    // The phrase is shared, the clause after it is not: one address domain, three
    // reasons, three fixes — so each case asserts the reason it is refused for.
    expect(() => runtimeFacade().forguncyMember("DataSourceCompareType" as never)).toThrow(
      /not the member that exposes it.*wrapper-local/,
    );
    expect(() => runtimeFacade().forguncyMember("Permissions" as never)).toThrow(
      /not the member that exposes it.*cellProp\("Permissions"\)/,
    );
    expect(() => runtimeFacade().forguncyMember("hasPermission" as never)).toThrow(
      /not the member that exposes it.*runtimeFacade\(\)\.hasPermission\(\)/,
    );
  });

  it("keeps an unconfigured permission name out of the boolean type", () => {
    installMock();
    expect(typeOnlyArbitraryPermissionKey).toBeTypeOf("function");

    // The runtime half of the pair: the configured name carries its boolean and the
    // unconfigured one is genuinely absent, which is *why* the type has to be
    // `Partial` rather than a plain `Record`. If this ever returned a value at
    // `NotConfigured`, the façade would be inventing one and the type would be right
    // to promise it.
    expect(runtimeFacade().getPermissions()["Orders.Read"]).toBe(true);
    expect(runtimeFacade().getPermissions()["NotConfigured"]).toBeUndefined();
  });
});

/**
 * The host boundaries a passing local suite cannot see by accident.
 *
 * Both were found in review on a PR whose tests all passed, and the reason is the
 * same for both: an arrow function and a plain property name are exactly the cases in
 * which losing a receiver and reading the prototype chain are *invisible*. Every
 * other fixture in this file is written the convenient way; these are written the
 * awkward way on purpose, because convenience is what hid the defect.
 */
describe("host boundaries only a hostile fixture can see", () => {
  /**
   * `this`, because #5 confirms the *method* form.
   *
   * The recorded call is `props.ServerCommands.GetSalesData({})` — a call *on the
   * record* — and nothing records that a command survives being detached from it. A
   * detached call hands the command `undefined` as `this`, which an arrow function
   * cannot reveal, so the fixture below is a method that reads it.
   */
  it("keeps the server-command receiver on the record it came from", async () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({
          ServerCommands: {
            marker: "the-command-record",
            GetSalesData(this: { marker?: string }) {
              return Promise.resolve({ errorCode: 0, sawThis: this?.marker });
            },
          },
        }),
        useDataSource: unusedDataSource,
      }),
    );

    const result = await runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData");
    expect(result.sawThis).toBe("the-command-record");
  });

  /**
   * The same boundary on the handle, on both paths in.
   *
   * `props.Forguncy.hasPermission(…)` is the recorded form, and the typed member and
   * the declared-shape accessor both have to preserve the receiver — otherwise one of
   * them would be a subtly different call from the other, and only one of them would
   * match the host.
   */
  it("keeps the props.Forguncy receiver on the handle it came from, on both paths", () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({
          Forguncy: {
            realm: "the-handle",
            hasPermission(this: { realm?: string }) {
              return this?.realm === "the-handle";
            },
            logIn(this: { realm?: string }) {
              return this?.realm;
            },
          },
        }),
        useDataSource: unusedDataSource,
      }),
    );

    // Typed member first, then the accessor: they resolve through one helper, so a
    // regression in it must fail here rather than pass on the other's green.
    expect(runtimeFacade().hasPermission("ProbePermission")).toBe(true);
    expect(runtimeFacade().forguncyMember<() => unknown>("logIn")()).toBe("the-handle");
  });

  /**
   * A name supplied by the caller is a *string*, and `record[name]` walks the
   * prototype chain.
   *
   * Before this was fixed, `invokeServerCommand("toString")` found
   * `Object.prototype.toString`, passed the callable check, and was invoked —
   * answering with `"[object Undefined]"` and never reaching the
   * `server-command-not-configured` branch #5's unconfigured-command observation is
   * about. The names below are the ones a caller would plausibly stumble into, and the
   * fix is `Object.hasOwn`, so all of them now get the same answer as `DoesNotExist`.
   */
  it("answers a command name only the prototype chain has as unconfigured", async () => {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());

    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      await expect(
        runtimeFacade<Record<string, []>>().invokeServerCommand(inherited),
      ).rejects.toMatchObject({ code: "server-command-not-configured" });
    }
  });

  /**
   * The command result is the third narrowing this file does, so it is checked too.
   *
   * `serverCommandRecord` types the record as `Record<string, unknown>`, which makes
   * `ServerCommandResult` a claim of this file's rather than a type it forwards, and #5
   * records that a real call returns `{ errorCode, errorMessage, data: [...] }`. A
   * command that resolves a primitive is therefore reported instead of being handed
   * over as a record whose fields a caller would read as `undefined`. The host fixture
   * is the awkward one on purpose: the mock's `serverCommands` is typed, so only a
   * provider written the way a real host arrives can produce this answer.
   */
  it("refuses a command result that is not the record #5 recorded", async () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({ ServerCommands: { GetSalesData: async () => undefined } }),
        useDataSource: unusedDataSource,
      }),
    );

    await expect(runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData")).rejects.toThrow(
      /answered a value whose typeof is "undefined" rather than the result record/,
    );
  });

  /**
   * A typed member's declared return is a claim about the host, so an answer of the
   * wrong type is reported rather than coerced into it.
   *
   * `Boolean("false")` is `true`: a truthiness conversion in `hasPermission` would
   * report every permission as granted against a host that answered a string, and
   * `{}` in place of a missing map would say "this user may do nothing" where the host
   * said nothing at all. Both are the guess #29's fifth acceptance criterion forbids.
   */
  it("refuses an answer that is not the shape #5 recorded instead of coercing it", () => {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: { hasPermission: () => "false", getPermissions: () => undefined },
      }),
    );

    expect(() => runtimeFacade().hasPermission("Orders.Read")).toThrow(/rather than the boolean/);
    expect(() => runtimeFacade().getPermissions()).toThrow(/rather than the permission map/);
  });

  /**
   * The same boundary against every wrong answer rather than one, because "not an
   * object" was the test that let them all through.
   *
   * The thenable cases are the ones that matter: `typeof promise === "object"` passes an
   * object test, so before this was fixed an async mock was cast straight into a
   * permission map and a caller whose declared type is a value was handed a pending
   * one — the host/mock timing difference these typed members exist to remove, restored
   * by the very check meant to keep shapes honest. Each case is asserted against the
   * *reason* it is refused for, so a catch-all message would fail here.
   */
  it("refuses every wrong answer to a narrowed return, naming the one that arrived", () => {
    type MockMembers = NonNullable<
      NonNullable<Parameters<typeof createMockRuntimeFacadeProvider>[0]>["forguncyMembers"]
    >;
    const cases: readonly {
      readonly why: string;
      readonly members: MockMembers;
      readonly expected: RegExp;
    }[] = [
      {
        why: "an async mock, the shape that would restore the timing difference",
        members: { getPermissions: async () => ({ "Orders.Read": true }) },
        expected: /answered a thenable — typeof "object"/,
      },
      {
        why: "an async boolean on the other narrowed member",
        members: { hasPermission: async () => true },
        expected: /hasPermission\("Orders.Read"\) answered a thenable/,
      },
      {
        why: "an array, whose indices would read as permission names",
        members: { getPermissions: () => [{ name: "Orders.Read" }] },
        expected: /answered an array/,
      },
      {
        why: "a Map, whose entries a record read cannot see",
        members: { getPermissions: () => new Map([["Orders.Read", true]]) },
        expected: /and not a plain record whose own keys are permission names/,
      },
      {
        why: "a Date",
        members: { getPermissions: () => new Date() },
        expected: /and not a plain record/,
      },
      {
        why: "a non-boolean value, which would read true in a condition and false in a comparison",
        members: { getPermissions: () => ({ "Orders.Read": "yes" }) },
        expected: /a value whose typeof is "string" for the permission "Orders.Read"/,
      },
      {
        why: "a boolean beside an absent one",
        members: { getPermissions: () => ({ "Orders.Read": true, "Orders.Write": undefined }) },
        expected: /a value whose typeof is "undefined" for the permission "Orders.Write"/,
      },
    ];

    for (const { why, members, expected } of cases) {
      uninstallRuntimeFacadeProvider();
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider({ forguncyMembers: members }));
      const call =
        "getPermissions" in members
          ? (): unknown => runtimeFacade().getPermissions()
          : (): unknown => runtimeFacade().hasPermission("Orders.Read");
      expect(call, why).toThrow(expected);
    }
  });

  /**
   * And the accepting half, so the boundary is a shape test rather than a suspicion of
   * anything unusual.
   *
   * A record with no prototype is accepted on purpose: it is still a plain map of own
   * enumerable keys, which is all #5 recorded, and refusing it would be this file
   * inventing a requirement the evidence does not make.
   */
  it("answers a plain record of booleans, with or without a prototype", () => {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: {
          getPermissions: () =>
            Object.assign(Object.create(null), { "Orders.Read": true, "Orders.Write": false }),
        },
      }),
    );

    expect(runtimeFacade().getPermissions()).toEqual({ "Orders.Read": true, "Orders.Write": false });
  });
});

/** Every base prop key `core` verified, with the ones under test overridden. */
function hostCellProps(overrides: Readonly<Record<string, unknown>>): RuntimeFacadeCellProps {
  const base = Object.fromEntries(CELL_PROPS_BASE_KEYS.map(key => [key, undefined])) as Record<
    string,
    unknown
  >;
  return { ...base, ...overrides } as unknown as RuntimeFacadeCellProps;
}

/** A binding the cases above never read, kept out of the way of what they assert. */
const unusedDataSource = (): DataSourceResult => ({
  data: [],
  totalCount: 0,
  loading: false,
  error: null,
});
