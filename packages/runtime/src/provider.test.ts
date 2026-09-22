import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

import type { DataSourceBinding, RuntimeFacadeProvider } from "./contract";
import { RUNTIME_FACADE_PORT_CHANNEL_MEMBERS } from "./contract";
import { runtimeFacade } from "./facade";
import { createHostRuntimeFacadeProvider, RUNTIME_FACADE_HOST_BINDING_CHANNELS } from "./host-provider";
import { createMockRuntimeFacadeProvider } from "./mock-provider";
import {
  findRuntimeFacadeAbsenceMode,
  findRuntimeFacadeAbsencePath,
  installRuntimeFacadeProvider,
  RUNTIME_FACADE_ABSENCE_MODES,
  RUNTIME_FACADE_ABSENCE_PATHS,
  RUNTIME_FACADE_ABSENCE_SHAPES,
  RUNTIME_FACADE_ADDRESS_KINDS,
  RUNTIME_FACADE_REFUSAL_PATHS,
  RUNTIME_FACADE_RESOLUTION_ERROR_CODES,
  RuntimeFacadeResolutionError,
  runtimeFacadeProviderState,
  throwingRuntimeFacadeAbsenceCodes,
  uninstallRuntimeFacadeProvider,
} from "./provider";
import type { RuntimeFacadeAbsencePathId } from "./provider";

const noSuchSource: DataSourceBinding = name => ({
  data: [],
  totalCount: 0,
  loading: false,
  error: `not found: ${name}`,
});

function hostProvider(): RuntimeFacadeProvider {
  return createHostRuntimeFacadeProvider({
    // A host binding passes the Cell's own `props`. A mock's `cellProps` is the
    // same shape by construction, which is what makes it usable here.
    cellProps: createMockRuntimeFacadeProvider().bindings.cellProps,
    useDataSource: noSuchSource,
  });
}

beforeEach(() => {
  uninstallRuntimeFacadeProvider();
});

afterEach(() => {
  uninstallRuntimeFacadeProvider();
});

describe("the provider slot", () => {
  it("reports not-installed as a state rather than as an absent field", () => {
    expect(runtimeFacadeProviderState()).toEqual({ installed: false });
    expect(() => runtimeFacade()).toThrow(/No runtime façade provider is installed/);
  });

  // The provider is the whole surface's precondition, so the refusal happens at
  // the accessor rather than at the first resolution — but only for a Cell that
  // calls the façade at all, which is why the check is not in the import path.
  it("names the code and the remediation when nothing is installed", () => {
    let caught: unknown;
    try {
      runtimeFacade();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeResolutionError);
    expect((caught as RuntimeFacadeResolutionError).code).toBe("provider-not-installed");
    expect((caught as RuntimeFacadeResolutionError).message).toMatch(/generated host binding/);
  });

  it("reports what is installed, without exposing it on the façade surface", () => {
    installRuntimeFacadeProvider(hostProvider());
    expect(runtimeFacadeProviderState()).toEqual({ installed: true, kind: "host" });

    // The switch is explicit, which is the point of the kind-conflict refusal
    // asserted below.
    uninstallRuntimeFacadeProvider();
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
    expect(runtimeFacadeProviderState()).toEqual({ installed: true, kind: "mock" });
  });

  // A re-render passes new props and an HMR pass re-evaluates the module; both
  // look like "install again with the same kind", and both must take effect.
  it("replaces a provider of the same kind, so a second render is visible", () => {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({ cellProps: { Permissions: ["first"] } }),
    );
    expect(runtimeFacade().cellProp("Permissions")).toEqual(["first"]);

    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({ cellProps: { Permissions: ["second"] } }),
    );
    expect(runtimeFacade().cellProp("Permissions")).toEqual(["second"]);
  });

  // Installing over the other kind would move a Cell from the mock to the host —
  // or back — as a side effect. That is a harness action, so it is explicit.
  it("refuses to switch kind, and leaves the installed provider alone", () => {
    const host = installRuntimeFacadeProvider(hostProvider());
    expect(() => installRuntimeFacadeProvider(createMockRuntimeFacadeProvider())).toThrow(
      /already installed/,
    );
    expect(runtimeFacadeProviderState()).toEqual({ installed: true, kind: "host" });
    // Still resolving through the host provider that was installed first.
    expect(String(runtimeFacade().useDataSource("Sales").error)).toContain("not found: Sales");
    expect(host.kind).toBe("host");
  });

  it("returns what was installed, so the harness can report the transition", () => {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
    expect(uninstallRuntimeFacadeProvider()).toEqual({ installed: true, kind: "mock" });
    expect(uninstallRuntimeFacadeProvider()).toEqual({ installed: false });
  });

  // The two providers fill the same port, which is what makes the mock a
  // stand-in rather than a second code path.
  it("fills the same port members from both factories", () => {
    const host = hostProvider();
    const mock = createMockRuntimeFacadeProvider();

    expect(Object.keys(host.bindings).sort()).toEqual(Object.keys(mock.bindings).sort());
    expect(host.kind).toBe("host");
    expect(mock.kind).toBe("mock");

    // Derived from the port's own channel list, so a channel added to the port
    // cannot leave a generated binding behind.
    expect([...RUNTIME_FACADE_HOST_BINDING_CHANNELS].sort()).toEqual(
      Object.values(RUNTIME_FACADE_PORT_CHANNEL_MEMBERS).sort(),
    );
  });
});

/**
 * One real call, and the address that call names.
 *
 * There is no `code` and no `addressKind` field, and that is the correction this round
 * needed: those were hand-written annotations sitting beside a hand-written taxonomy, so
 * the two could agree with each other and both be wrong. The path id is the key here,
 * the path table says what that path means, and the run is asked what it actually got.
 */
interface AbsencePathProducer {
  /** The address the call names, asserted against the error's own field. */
  readonly address: string | undefined;
  /** Which lookup fails, in words — the label a failing assertion prints. */
  readonly note: string;
  readonly produce: () => Promise<unknown>;
}

// `RUNTIME_FACADE_ABSENCE_MODES` is the reason "the value is not there" is not
// one condition. These tests keep it a taxonomy rather than a comment: every code
// has a row, every row is actionable, and — the two checks that matter — every code
// is reachable from a real call, and every address family a row claims is a family
// a real call produces it from.
describe("the absence taxonomy", () => {
  it("documents exactly the codes the module can throw", () => {
    expect([...RUNTIME_FACADE_RESOLUTION_ERROR_CODES]).toEqual([
      "provider-not-installed",
      "provider-kind-conflict",
      "host-binding-not-confirmed",
      "binding-not-exposed",
      "provider-binding-missing",
      "capability-not-supplied",
      "server-command-not-configured",
    ]);
    expect([...throwingRuntimeFacadeAbsenceCodes()]).toEqual([...RUNTIME_FACADE_RESOLUTION_ERROR_CODES]);
  });

  // The non-error row is the point of typing the id union by hand: an undeclared
  // data source is a *returned state*, and typing it as an error code would make
  // a reader believe the façade throws for it.
  it("keeps the host-shaped absence out of the error codes", () => {
    const hostShaped = RUNTIME_FACADE_ABSENCE_MODES.filter(
      mode => mode.shape === "returns-the-hosts-error-state",
    );
    expect(hostShaped.map(mode => mode.id)).toEqual(["undeclared-data-source"]);
    expect(RUNTIME_FACADE_RESOLUTION_ERROR_CODES as readonly string[]).not.toContain(
      "undeclared-data-source",
    );
    expect([...RUNTIME_FACADE_ABSENCE_SHAPES]).toEqual([
      "throws",
      "returns-the-hosts-error-state",
    ]);
  });

  it("gives every row a cause, a remediation and a vocabulary address kind", () => {
    expect(new Set(RUNTIME_FACADE_ABSENCE_MODES.map(mode => mode.id)).size).toBe(
      RUNTIME_FACADE_ABSENCE_MODES.length,
    );
    for (const mode of RUNTIME_FACADE_ABSENCE_MODES) {
      expect(mode.cause.trim().length, mode.id).toBeGreaterThan(40);
      expect(mode.remediation.trim().length, mode.id).toBeGreaterThan(30);
      // Plural and non-empty, with no repeats: a row claiming no family would be a
      // row nothing can produce, and a repeat would inflate the claim without
      // adding one. That every claimed family really is produced is asserted below.
      expect(mode.addressKinds.length, mode.id).toBeGreaterThan(0);
      expect(new Set(mode.addressKinds).size, mode.id).toBe(mode.addressKinds.length);
      for (const kind of mode.addressKinds) {
        expect(RUNTIME_FACADE_ADDRESS_KINDS, `${mode.id}/${kind}`).toContain(kind);
      }
      expect(findRuntimeFacadeAbsenceMode(mode.id).id, mode.id).toBe(mode.id);
    }
  });

  it("refuses an unknown absence id rather than defaulting", () => {
    // @ts-expect-error an id outside the union must not be accepted either
    expect(() => findRuntimeFacadeAbsenceMode("something-else")).toThrow(/Unknown façade absence mode/);
  });

  /**
   * One real call per failure *path*, and the address that call names.
   *
   * Keyed by the path union, so a path added to `RUNTIME_FACADE_REFUSAL_PATHS` — or to
   * the one returned-state path — without a producer here **does not compile**. That is
   * the property the previous two rounds of this regression lacked: the table was a
   * hand-written list of situations keyed by nothing, so a real throw site nobody listed
   * stayed green on both sides of the comparison. That is exactly how a
   * declared-but-uncallable command went unclassified for two rounds.
   *
   * `addressKind` is not a field here, deliberately. It used to be, and it was compared
   * against the taxonomy — two hand-written lists agreeing with each other and both
   * wrong: the handle read (`Forguncy`, a *base prop*) was annotated as a handle-member
   * failure. The path decides the family now, the run reports what it actually got, and
   * the vocabulary check below is what catches a family that contradicts `core`.
   */
  const producers: Readonly<Record<RuntimeFacadeAbsencePathId, AbsencePathProducer>> = {
    "provider-not-installed": {
      // Carries no address, and that is right: nothing resolved, so the failure is
      // about the slot rather than about anything the call named.
      address: undefined,
      note: "no provider installed, so the call discovers it before any address is asked for",
      produce: async () => {
        uninstallRuntimeFacadeProvider();
        return runtimeFacade().cellProp("Permissions");
      },
    },
    "provider-kind-conflict": {
      // The incoming provider's kind, which is what the refusal names — the kind that
      // *would* have been installed, not the one already there.
      address: "mock",
      note: "a second provider installed under a different kind",
      produce: async () => {
        installRuntimeFacadeProvider(hostProvider());
        return installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      },
    },
    "base-prop-not-confirmed": {
      address: "NotABaseProp",
      note: "a base prop name #5 never observed — reachable from JavaScript, and from a cast in TypeScript",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().cellProp("NotABaseProp" as never);
      },
    },
    "handle-member-not-confirmed": {
      address: "NotAMember",
      note: "the same rule applied to a handle member #5 never observed",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().forguncyMember("NotAMember" as never);
      },
    },
    "base-prop-not-exposed": {
      address: "ServerCommands",
      note: "a confirmed base prop reached through the wrong accessor",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().cellProp("ServerCommands" as never);
      },
    },
    "handle-member-not-exposed": {
      address: "hasPermission",
      note: "a confirmed handle member reached through the wrong accessor",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().forguncyMember("hasPermission" as never);
      },
    },
    "provider-carries-no-bindings": {
      address: "cellProps",
      note: "a provider carrying no bindings record at all",
      produce: async () => {
        installRuntimeFacadeProvider({ kind: "mock" } as never);
        return runtimeFacade().cellProp("Permissions");
      },
    },
    "base-prop-not-supplied": {
      address: "Permissions",
      note: "a bindings record that carries the handle but not a base prop",
      produce: async () => {
        installRuntimeFacadeProvider({
          kind: "mock",
          bindings: { cellProps: { Forguncy: {} }, useDataSource: noSuchSource } as never,
        });
        return runtimeFacade().cellProp("Permissions");
      },
    },
    "handle-not-supplied": {
      address: "Forguncy",
      note: "the handle itself is not there — and `Forguncy` is a *base prop*, which is the annotation review caught calling this a handle-member failure",
      produce: async () => {
        installRuntimeFacadeProvider({
          kind: "mock",
          bindings: { cellProps: {}, useDataSource: noSuchSource } as never,
        });
        return runtimeFacade().hasPermission("ProbePermission");
      },
    },
    "handle-member-not-supplied": {
      address: "hasPermission",
      note: "a handle that carries none of the members #5 recorded",
      produce: async () => {
        installRuntimeFacadeProvider({
          kind: "mock",
          bindings: { cellProps: { Forguncy: {} }, useDataSource: noSuchSource } as never,
        });
        return runtimeFacade().hasPermission("ProbePermission");
      },
    },
    "data-source-hook-not-supplied": {
      address: "useDataSource",
      note: "a provider carrying no data-source hook, which is the wrapper-local binding",
      produce: async () => {
        installRuntimeFacadeProvider({
          kind: "mock",
          bindings: { cellProps: { Forguncy: {} } } as never,
        });
        return runtimeFacade().useDataSource("Sales");
      },
    },
    "called-member-not-callable": {
      address: "hasPermission",
      note: "a mock that fills the handle's keys and supplies none of them: present, not callable",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().hasPermission("ProbePermission");
      },
    },
    "called-member-answered-wrong-shape": {
      address: "getPermissions",
      note: "a called member that answered a shape #5 did not record",
      produce: async () => {
        installRuntimeFacadeProvider(
          createMockRuntimeFacadeProvider({
            forguncyMembers: { getPermissions: async () => ({ ProbePermission: true }) },
          }),
        );
        return runtimeFacade().getPermissions();
      },
    },
    "server-command-entry-not-callable": {
      address: "GetSalesData",
      note: "a command declared on the record whose entry is not callable — present, so nothing is missing, and unusable, so not a right answer either",
      produce: async () => {
        installRuntimeFacadeProvider(
          createMockRuntimeFacadeProvider<{ GetSalesData: [] }>({
            serverCommands: { GetSalesData: "declared, but not callable" as never },
          }),
        );
        return runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData");
      },
    },
    "server-command-result-invalid": {
      address: "GetSalesData",
      note: "a command that resolved to something other than the result record #5 recorded",
      produce: async () => {
        installRuntimeFacadeProvider(
          createMockRuntimeFacadeProvider<{ GetSalesData: [] }>({
            serverCommands: { GetSalesData: (async () => undefined) as never },
          }),
        );
        return runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData");
      },
    },
    "server-command-not-configured": {
      address: "CreateOrder",
      note: "a command the project declared but the page did not configure",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade<{ CreateOrder: [] }>().invokeServerCommand("CreateOrder");
      },
    },
    "undeclared-data-source": {
      address: "NoSuchSource",
      note: "the one path that returns rather than throws: the host's own error state",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().useDataSource("NoSuchSource");
      },
    },
  };

  it("can produce every declared path from a real call", async () => {
    for (const [pathId, entry] of Object.entries(producers) as [
      RuntimeFacadeAbsencePathId,
      AbsencePathProducer,
    ][]) {
      const path = findRuntimeFacadeAbsencePath(pathId);
      uninstallRuntimeFacadeProvider();
      if (findRuntimeFacadeAbsenceMode(path.code).shape === "returns-the-hosts-error-state") {
        const state = (await entry.produce()) as { error?: unknown };
        expect(String(state?.error), entry.note).toContain(entry.address);
        continue;
      }
      let caught: unknown;
      try {
        await entry.produce();
      } catch (error) {
        caught = error;
      }
      expect(caught, entry.note).toBeInstanceOf(RuntimeFacadeResolutionError);
      const error = caught as RuntimeFacadeResolutionError;
      // Observed, not declared: the error says which code and which family it was, and
      // both have to be what the path table says this path means. A refusal that named
      // the wrong path, or reached for a code some other way, fails here.
      expect(error.code, entry.note).toBe(path.code);
      expect(error.addressKind, entry.note).toBe(path.addressKind);
      expect(error.address, entry.note).toBe(entry.address);
    }
  });

  it("keeps the refusal paths and the error-code vocabulary the same set", () => {
    expect([...new Set(RUNTIME_FACADE_REFUSAL_PATHS.map(path => path.code))].sort()).toEqual(
      [...RUNTIME_FACADE_RESOLUTION_ERROR_CODES].sort(),
    );
    // And the ids are unique, so a copy-paste cannot silently shadow a path and leave
    // the producer that covered it pointing at the copy.
    expect(new Set(RUNTIME_FACADE_REFUSAL_PATHS.map(path => path.id)).size).toBe(
      RUNTIME_FACADE_REFUSAL_PATHS.length,
    );
  });

  it("lists no address family that nothing produces", () => {
    for (const mode of RUNTIME_FACADE_ABSENCE_MODES) {
      const produced = new Set(
        RUNTIME_FACADE_ABSENCE_PATHS.filter(path => path.code === mode.id).map(
          path => path.addressKind,
        ),
      );
      for (const kind of mode.addressKinds) {
        expect(produced, `${mode.id} lists ${kind} but nothing produces it`).toContain(kind);
      }
    }
  });

  /**
   * The one check on the address family that does not come from this package's own two
   * hands.
   *
   * A path's family is a judgement, and every other assertion about it compares it
   * against something else I wrote. `core`'s vocabularies do not: a name in
   * `CELL_PROPS_BASE_KEYS` is a base prop and a name in `CELL_FORGUNCY_PROP_KEYS` is a
   * handle member, by #5's record rather than by my opinion — so an address that belongs
   * to one of those vocabularies pins the family it can be raised about.
   *
   * This is the check that would have caught review's counter-example. `Forguncy` is the
   * first entry of `CELL_PROPS_BASE_KEYS`, so a path about it cannot be a
   * `forguncy-member` failure — and it was one, and nothing failed.
   */
  it("names each address in the family core's vocabulary puts it in", () => {
    for (const [pathId, entry] of Object.entries(producers) as [
      RuntimeFacadeAbsencePathId,
      AbsencePathProducer,
    ][]) {
      if (entry.address === undefined) continue;
      const { addressKind } = findRuntimeFacadeAbsencePath(pathId);
      // Each direction is guarded by exclusivity, because the two vocabularies are not
      // disjoint: `Permissions` is a base prop key *and* one of the handle's members
      // (#5 lists it on `props.Forguncy` as well as on the Cell), so that one name does
      // not pin a family on its own. Every other name does.
      const isBaseProp = (CELL_PROPS_BASE_KEYS as readonly string[]).includes(entry.address);
      const isHandleMember = (CELL_FORGUNCY_PROP_KEYS as readonly string[]).includes(entry.address);
      if (isBaseProp && !isHandleMember) {
        expect(
          addressKind,
          `"${entry.address}" is a base prop and not a handle member, so this path cannot be a ${addressKind} failure`,
        ).toBe("cell-prop");
      }
      if (isHandleMember && !isBaseProp) {
        expect(
          addressKind,
          `"${entry.address}" is a handle member and not a base prop, so this path cannot be a ${addressKind} failure`,
        ).toBe("forguncy-member");
      }
    }
  });

  it("carries the address, so a caller can report which one failed", async () => {
    uninstallRuntimeFacadeProvider();
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());

    let caught: unknown;
    try {
      await runtimeFacade<{ CreateOrder: [] }>().invokeServerCommand("CreateOrder");
    } catch (error) {
      caught = error;
    }
    expect((caught as RuntimeFacadeResolutionError).address).toBe("CreateOrder");
  });

  // The host injects every base prop key, so a provider that lacks one is a
  // wiring fault, and the message has to say so rather than blaming the page.
  it("calls a missing base prop a wiring fault, not a page state", async () => {
    installRuntimeFacadeProvider({
      kind: "mock",
      bindings: { cellProps: { Forguncy: {} }, useDataSource: noSuchSource } as never,
    });

    let caught: unknown;
    try {
      runtimeFacade().cellProp("Permissions");
    } catch (error) {
      caught = error;
    }
    const error = caught as RuntimeFacadeResolutionError;
    expect(error.code).toBe("provider-binding-missing");
    expect(error.message).toMatch(/wiring fault/);
    expect(error.address).toBe("Permissions");
  });
});
