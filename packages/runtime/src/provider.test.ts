import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DataSourceBinding, RuntimeFacadeProvider } from "./contract";
import { RUNTIME_FACADE_PORT_CHANNEL_MEMBERS } from "./contract";
import { runtimeFacade } from "./facade";
import { createHostRuntimeFacadeProvider, RUNTIME_FACADE_HOST_BINDING_CHANNELS } from "./host-provider";
import { createMockRuntimeFacadeProvider } from "./mock-provider";
import {
  findRuntimeFacadeAbsenceMode,
  installRuntimeFacadeProvider,
  RUNTIME_FACADE_ABSENCE_MODES,
  RUNTIME_FACADE_ABSENCE_SHAPES,
  RUNTIME_FACADE_ADDRESS_KINDS,
  RUNTIME_FACADE_RESOLUTION_ERROR_CODES,
  RuntimeFacadeResolutionError,
  runtimeFacadeProviderState,
  throwingRuntimeFacadeAbsenceCodes,
  uninstallRuntimeFacadeProvider,
} from "./provider";
import type { RuntimeFacadeAbsenceId, RuntimeFacadeAddressKind } from "./provider";

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
 * One real call, and the address family whose lookup is the one that fails.
 *
 * `addressKind` is written rather than derived on purpose: it is the independent
 * statement that the façade's own choice of code is checked against.
 */
interface AbsenceProducer {
  readonly code: RuntimeFacadeAbsenceId;
  readonly addressKind: RuntimeFacadeAddressKind;
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
   * One real call per (code, address family) pair the module can produce.
   *
   * A *list* rather than a record keyed by code, and that shape is the point: a code
   * that can be raised about two families has to appear twice, so the second family
   * is written down rather than absorbed. A record keyed by code forces one family
   * per code, which is what the taxonomy used to claim and what review found false —
   * `capability-not-supplied` was listed as a `forguncy-member` code while
   * `invokeServerCommand` was already throwing it about a `server-command-name`.
   *
   * `addressKind` is written here rather than derived, so the table is an
   * *independent* statement next to the façade's own choice of code. `address` is
   * asserted against the error's own field, so a producer cannot exercise a different
   * address than it says it does. Between them, a code that starts being thrown from
   * an unlisted family fails here rather than passing as prose — which is the check
   * "every code can be produced once" could not make, because it only ever asked
   * whether *some* call produced the code.
   */
  const producers: readonly AbsenceProducer[] = [
    {
      code: "provider-not-installed",
      addressKind: "provider",
      // Carries no address, and that is right: nothing resolved, so the failure is
      // about the slot rather than about anything the call named.
      address: undefined,
      note: "no provider installed, so the call discovers it before any address is asked for",
      produce: async () => {
        uninstallRuntimeFacadeProvider();
        return runtimeFacade().cellProp("Permissions");
      },
    },
    {
      code: "provider-kind-conflict",
      addressKind: "provider",
      // The incoming provider's kind, which is what the refusal names — the kind that
      // *would* have been installed, not the one already there.
      address: "mock",
      note: "a second provider installed under a different kind",
      produce: async () => {
        installRuntimeFacadeProvider(hostProvider());
        return installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      },
    },
    {
      code: "host-binding-not-confirmed",
      addressKind: "cell-prop",
      address: "NotABaseProp",
      note: "a base prop name #5 never observed — reachable from JavaScript, and from a cast in TypeScript",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().cellProp("NotABaseProp" as never);
      },
    },
    {
      code: "host-binding-not-confirmed",
      addressKind: "forguncy-member",
      address: "NotAMember",
      note: "the same rule applied to a handle member #5 never observed",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().forguncyMember("NotAMember" as never);
      },
    },
    {
      code: "binding-not-exposed",
      addressKind: "cell-prop",
      address: "ServerCommands",
      note: "a confirmed base prop reached through the wrong accessor",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().cellProp("ServerCommands" as never);
      },
    },
    {
      code: "binding-not-exposed",
      addressKind: "forguncy-member",
      address: "hasPermission",
      note: "a confirmed handle member reached through the wrong accessor",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().forguncyMember("hasPermission" as never);
      },
    },
    {
      code: "provider-binding-missing",
      addressKind: "provider",
      address: "cellProps",
      note: "a provider carrying no bindings record at all",
      produce: async () => {
        installRuntimeFacadeProvider({ kind: "mock" } as never);
        return runtimeFacade().cellProp("Permissions");
      },
    },
    {
      code: "provider-binding-missing",
      addressKind: "cell-prop",
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
    {
      code: "provider-binding-missing",
      addressKind: "forguncy-member",
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
    {
      code: "provider-binding-missing",
      addressKind: "cell-hook",
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
    {
      code: "capability-not-supplied",
      addressKind: "forguncy-member",
      address: "hasPermission",
      note: "a mock that fills the handle's keys and supplies none of them: present, not callable",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().hasPermission("ProbePermission");
      },
    },
    {
      code: "capability-not-supplied",
      addressKind: "server-command-name",
      address: "GetSalesData",
      note: "a command that resolved to something other than the result record #5 recorded",
      produce: async () => {
        installRuntimeFacadeProvider(
          createMockRuntimeFacadeProvider<{ GetSalesData: [] }>({
            // `as never` because the mock's type asks for a `ServerCommandCall`, and
            // the whole point of the fixture is to answer something that type does
            // not describe.
            serverCommands: { GetSalesData: (async () => undefined) as never },
          }),
        );
        return runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData");
      },
    },
    {
      code: "server-command-not-configured",
      addressKind: "server-command-name",
      address: "CreateOrder",
      note: "a command the project declared but the page did not configure",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade<{ CreateOrder: [] }>().invokeServerCommand("CreateOrder");
      },
    },
    {
      code: "undeclared-data-source",
      addressKind: "data-source-name",
      address: "NoSuchSource",
      note: "the non-error row: the host's own error state, returned rather than thrown",
      produce: async () => {
        installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
        return runtimeFacade().useDataSource("NoSuchSource");
      },
    },
  ];

  it("can produce every declared code from a real call", async () => {
    // Every row has at least one producer, and no producer names an id the taxonomy
    // does not admit. Compared against the whole taxonomy rather than the error codes,
    // because the non-error row is produced here too — its *shape* is what
    // distinguishes it, and the loop below asserts that.
    expect([...new Set(producers.map(entry => entry.code))].sort()).toEqual(
      RUNTIME_FACADE_ABSENCE_MODES.map(mode => mode.id).sort(),
    );

    for (const entry of producers) {
      uninstallRuntimeFacadeProvider();
      if (findRuntimeFacadeAbsenceMode(entry.code).shape === "returns-the-hosts-error-state") {
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
      expect(error.code, entry.note).toBe(entry.code);
      // The address, not just the code: a producer that fails somewhere else would
      // otherwise still look like a producer for the family it claims.
      expect(error.address, entry.note).toBe(entry.address);
    }
  });

  /**
   * The families a row claims and the families that are produced have to be the same
   * set — checked in both directions.
   *
   * The first direction is the correctness one: a code thrown from a family its row
   * does not name is a row that lies. The second is the discipline one, and it is the
   * half that keeps a plural field from becoming a place to list families "just in
   * case": a family nothing produces fails too, so every entry stays earned.
   */
  it("records exactly the address families each code is raised about", () => {
    for (const mode of RUNTIME_FACADE_ABSENCE_MODES) {
      const claimed = new Set(mode.addressKinds);
      const produced = new Set(
        producers.filter(entry => entry.code === mode.id).map(entry => entry.addressKind),
      );
      for (const kind of produced) {
        expect(claimed, `${mode.id} is raised about ${kind} but does not list it`).toContain(kind);
      }
      for (const kind of claimed) {
        expect(produced, `${mode.id} lists ${kind} but nothing produces it`).toContain(kind);
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
