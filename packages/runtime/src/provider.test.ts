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
import type { RuntimeFacadeResolutionErrorCode } from "./provider";

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

// `RUNTIME_FACADE_ABSENCE_MODES` is the reason "the value is not there" is not
// one condition. These tests keep it a taxonomy rather than a comment: every code
// has a row, every row is actionable, and — the check that matters — every code
// is reachable from a real call.
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
      expect(RUNTIME_FACADE_ADDRESS_KINDS, mode.id).toContain(mode.addressKind);
      expect(findRuntimeFacadeAbsenceMode(mode.id).id, mode.id).toBe(mode.id);
    }
  });

  it("refuses an unknown absence id rather than defaulting", () => {
    // @ts-expect-error an id outside the union must not be accepted either
    expect(() => findRuntimeFacadeAbsenceMode("something-else")).toThrow(/Unknown façade absence mode/);
  });

  /**
   * Every declared code, driven by a scenario that produces it.
   *
   * This is the check #12 established the need for: a code in a vocabulary that
   * no code path emits makes a rule table look as though it covers an invariant
   * nobody checks. The record is keyed by the code union, so adding a code
   * without a scenario is a compile error, and the set assertion catches the
   * reverse.
   */
  const scenarios: Readonly<Record<RuntimeFacadeResolutionErrorCode, () => Promise<unknown>>> = {
    "provider-not-installed": async () => {
      uninstallRuntimeFacadeProvider();
      runtimeFacade().cellProp("Permissions");
    },
    "provider-kind-conflict": async () => {
      installRuntimeFacadeProvider(hostProvider());
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
    },
    "host-binding-not-confirmed": async () => {
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      // Reachable from JavaScript, and from a cast in TypeScript.
      runtimeFacade().cellProp("NotABaseProp" as never);
    },
    "binding-not-exposed": async () => {
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      runtimeFacade().cellProp("ServerCommands" as never);
    },
    "provider-binding-missing": async () => {
      installRuntimeFacadeProvider({
        kind: "mock",
        bindings: { cellProps: { Forguncy: {} }, useDataSource: noSuchSource } as never,
      });
      runtimeFacade().cellProp("Permissions");
    },
    "capability-not-supplied": async () => {
      // A mock that fills the handle's keys and supplies none of them: present,
      // not callable. This is the absence the mock must not paper over.
      //
      // Driven through the typed `hasPermission`, and that is now the only kind of
      // address that can produce this code: requiring a callable value is a signature,
      // so only the members #5 actually *called* may demand one. A `member-presence`
      // address is handed over exactly as the handle holds it — see the façade's
      // `hostHandleMember` and the regression beside the receiver test in
      // `facade.test.ts` — because #5 confirmed those names from the handle's key list
      // and never read their `typeof`.
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      runtimeFacade().hasPermission("ProbePermission");
    },
    "server-command-not-configured": async () => {
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
      // A command the project declared but the page did not configure: the
      // declaration makes the call legal, and the missing entry is what the
      // façade reports — which is the distinction #5 draws between an address
      // that is not there and a name the designer never listed.
      await runtimeFacade<{ CreateOrder: [] }>().invokeServerCommand("CreateOrder");
    },
  };

  it("can produce every declared code from a real call", async () => {
    expect(Object.keys(scenarios).sort()).toEqual([...RUNTIME_FACADE_RESOLUTION_ERROR_CODES].sort());

    for (const code of RUNTIME_FACADE_RESOLUTION_ERROR_CODES) {
      uninstallRuntimeFacadeProvider();
      let caught: unknown;
      try {
        await scenarios[code]();
      } catch (error) {
        caught = error;
      }
      expect(caught, code).toBeInstanceOf(RuntimeFacadeResolutionError);
      expect((caught as RuntimeFacadeResolutionError).code, code).toBe(code);
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
