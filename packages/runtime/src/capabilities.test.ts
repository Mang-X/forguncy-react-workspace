import { describe, expect, it } from "vitest";

import {
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
  RUNTIME_EVIDENCE_CHANNELS,
  cellUserScopeBinding,
  isApplicationOwned,
} from "@forguncy-react-workspace/core";

import {
  admittedRuntimeFacadeFamilies,
  applicationOwnedRuntimeFacadeCapabilities,
  assertRuntimeFacadeCapabilityAdmissible,
  assertRuntimeFacadeSurfaceIsConfirmed,
  findRuntimeFacadeCapability,
  findRuntimeFacadeEvidenceSource,
  findRuntimeFacadeFamily,
  omittedRuntimeFacadeFamilies,
  RUNTIME_FACADE_CAPABILITIES,
  RUNTIME_FACADE_CAPABILITY_IDS,
  RUNTIME_FACADE_EVIDENCE_SOURCE_IDS,
  RUNTIME_FACADE_FAMILIES,
  RUNTIME_FACADE_FAMILY_IDS,
  RuntimeFacadeContractError,
  runtimeFacadeBindingName,
  runtimeFacadeBindingShadowsCellScope,
  runtimeFacadeCapabilitiesOfFamily,
  runtimeFacadeConcernOf,
  runtimeFacadeEvidenceChannels,
} from "./capabilities.ts";
import type { RuntimeFacadeCapability, RuntimeFacadeHostBinding } from "./capabilities.ts";

/**
 * #27's first acceptance criterion is that "every facade API maps to a confirmed
 * host/product capability with evidence from #5 or a linked product contract",
 * and its sixth is that "unsupported/unconfirmed capabilities are omitted rather
 * than guessed".
 *
 * Those two are the reason this file exists. A façade is easy to write and hard
 * to keep honest: the failure mode is not a crash, it is a plausible accessor for
 * behaviour nobody probed. So the registry is pinned, and every admitted address
 * is checked against `core` — the record that owns the evidence — rather than
 * against a copy of it kept here.
 */
describe("façade capability registry", () => {
  // Pinned in order so that adding, removing or reworking one is a deliberate
  // edit against the Spec rather than an incidental tidy-up of a list.
  it("records exactly the capabilities this contract admits, in order", () => {
    expect([...RUNTIME_FACADE_CAPABILITY_IDS]).toEqual([
      "server-command-invocation",
      "data-source-binding",
      "permission-snapshot",
      "permission-check",
      "permission-map-read",
      "current-user",
      "session-control",
      "file-upload",
      "upload-limit",
      "cell-method-exposure",
      "forguncy-value-conversions",
      "image-context",
    ]);
    expect(RUNTIME_FACADE_CAPABILITIES.map(capability => capability.id)).toEqual([
      ...RUNTIME_FACADE_CAPABILITY_IDS,
    ]);
  });

  it("resolves #27's six candidate families, in the Issue's order", () => {
    expect([...RUNTIME_FACADE_FAMILY_IDS]).toEqual([
      "cell-props-and-context",
      "server-command-invocation",
      "application-navigation",
      "page-and-cross-cell-state",
      "page-events-and-commands",
      "host-and-global-lookup",
    ]);
    expect(RUNTIME_FACADE_FAMILIES.map(family => family.id)).toEqual([...RUNTIME_FACADE_FAMILY_IDS]);
  });

  it("stays internally consistent, so a family and a capability cannot disagree", () => {
    expect(() => assertRuntimeFacadeSurfaceIsConfirmed()).not.toThrow();
  });

  it("refuses an unknown id instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findRuntimeFacadeCapability("not-a-capability")).toThrow(/Unknown façade capability/);
    // @ts-expect-error an unknown family must not be accepted either
    expect(() => findRuntimeFacadeFamily("not-a-family")).toThrow(/Unknown façade candidate family/);
  });
});

// #27: "Every facade API maps to a confirmed host/product capability with
// evidence from #5 or a linked product contract."
describe("evidence linkage", () => {
  it("cites only sources that `core` records actually are", () => {
    expect(new Set(RUNTIME_FACADE_EVIDENCE_SOURCE_IDS).size).toBe(RUNTIME_FACADE_EVIDENCE_SOURCE_IDS.length);
    for (const id of RUNTIME_FACADE_EVIDENCE_SOURCE_IDS) {
      const source = findRuntimeFacadeEvidenceSource(id);
      expect(source.id, id).toBe(id);
      expect(source.coreExport.trim().length, id).toBeGreaterThan(0);
      expect(source.evidence.length, id).toBeGreaterThan(0);
    }
  });

  // The channel list is read out of `core` at import time rather than restated,
  // because a copied list is a second source of truth that drifts the first time
  // #5 is re-probed.
  it("derives every evidence channel from a `core` record", () => {
    for (const capability of RUNTIME_FACADE_CAPABILITIES) {
      const channels = runtimeFacadeEvidenceChannels(capability);
      expect(channels.length, capability.id).toBeGreaterThan(0);
      for (const channel of channels) {
        expect(RUNTIME_EVIDENCE_CHANNELS, capability.id).toContain(channel);
      }
      // Derived means reproducible: the same lookup must give the same answer.
      const expected = [
        ...new Set(
          capability.evidenceSources.flatMap(sourceId => findRuntimeFacadeEvidenceSource(sourceId).evidence),
        ),
      ];
      expect(channels, capability.id).toEqual(expected);
    }
  });

  it("gives every capability at least one source and one binding", () => {
    for (const capability of RUNTIME_FACADE_CAPABILITIES) {
      expect(capability.evidenceSources.length, capability.id).toBeGreaterThan(0);
      expect(capability.hostBindings.length, capability.id).toBeGreaterThan(0);
      expect(capability.summary.trim().length, capability.id).toBeGreaterThan(10);
    }
  });

  /**
   * The independent half of the check.
   *
   * `assertRuntimeFacadeCapabilityAdmissible` already refuses an unverified
   * address, so re-running it here would only prove the guard calls itself. This
   * looks the names up in `core` directly, which is what "no invented APIs"
   * actually means.
   */
  it("addresses only names `core` verified — independently of the guard", () => {
    for (const capability of RUNTIME_FACADE_CAPABILITIES) {
      for (const binding of capability.hostBindings) {
        const name = runtimeFacadeBindingName(binding);
        switch (binding.kind) {
          case "cell-prop":
            expect(CELL_PROPS_BASE_KEYS, `${capability.id}:${name}`).toContain(binding.prop);
            break;
          case "forguncy-member":
            expect(CELL_FORGUNCY_PROP_KEYS, `${capability.id}:${name}`).toContain(binding.member);
            break;
          case "cell-hook":
            expect(cellUserScopeBinding(binding.hook), `${capability.id}:${name}`).toBeDefined();
            break;
        }
      }
    }
  });

  // `getHostGlobal` is the package's raw page-global escape hatch. It reads by
  // name, so it is not a confirmed address in the sense the façade needs: nothing
  // in #5's user-scope table names it.
  it("does not smuggle the raw global escape hatch into the capability set", () => {
    const bindingNames = RUNTIME_FACADE_CAPABILITIES.flatMap(capability =>
      capability.hostBindings.map(runtimeFacadeBindingName),
    );
    expect(bindingNames).not.toContain("getHostGlobal");
    expect(cellUserScopeBinding("getHostGlobal")).toBeUndefined();
  });
});

// #27: "Unsupported/unconfirmed capabilities are omitted rather than guessed."
describe("omitted candidate families", () => {
  it("omits exactly the four families #5 could not confirm", () => {
    expect(omittedRuntimeFacadeFamilies().map(family => family.id)).toEqual([
      "application-navigation",
      "page-and-cross-cell-state",
      "page-events-and-commands",
      "host-and-global-lookup",
    ]);
    expect(admittedRuntimeFacadeFamilies().map(family => family.id)).toEqual([
      "cell-props-and-context",
      "server-command-invocation",
    ]);
  });

  it("names the evidence that would admit each omitted family", () => {
    for (const family of omittedRuntimeFacadeFamilies()) {
      expect(family.blockedBy?.trim().length, family.id).toBeGreaterThan(20);
      expect(family.guidance?.trim().length, family.id).toBeGreaterThan(20);
      expect(family.capabilityIds, family.id).toEqual([]);
      expect(runtimeFacadeCapabilitiesOfFamily(family.id), family.id).toEqual([]);
    }
  });

  // The omission is only worth anything if no capability quietly belongs to an
  // omitted family: that is the shape a "just this once" exception takes.
  it("admits no capability under an omitted family", () => {
    const omitted = new Set(omittedRuntimeFacadeFamilies().map(family => family.id));
    for (const capability of RUNTIME_FACADE_CAPABILITIES) {
      expect(omitted.has(capability.family), capability.id).toBe(false);
    }
  });

  // #27's third acceptance criterion, in executable form: navigation guidance
  // must route through Forguncy rather than an application router.
  it("routes navigation through Forguncy instead of an application router", () => {
    const navigation = findRuntimeFacadeFamily("application-navigation");
    expect(navigation.guidance).toMatch(/Forguncy page command/);
    expect(navigation.guidance).toMatch(/React Router|cell-local history/);
    expect(navigation.rationale).toMatch(/no navigation member/);
    expect(runtimeFacadeCapabilitiesOfFamily("application-navigation")).toEqual([]);
  });

  it("keeps host/global lookup with the compiler rather than the façade", () => {
    const family = findRuntimeFacadeFamily("host-and-global-lookup");
    expect(family.rationale).toMatch(/dependency-strategy concern/);
    expect(family.guidance).toMatch(/let the compiler resolve it/);
  });
});

// The strongest form of "do not invent APIs": how far the evidence goes is
// recorded per capability, so a typed signature has to be paid for with evidence
// rather than added because it reads well.
describe("confirmation levels", () => {
  /**
   * Only the bridges #5 executed are call-shape.
   *
   * This list is also the one the review moved, and the move is the point rather
   * than a detail: the first version held two entries because it was derived from
   * the *key list* `core` records for `props.Forguncy`, which says which names exist
   * and nothing about whether any was called. #5's own comments record
   * `hasPermission("ProbePermission")` → `true` and `getPermissions()` →
   * `{"ProbePermission": true}` — neither awaited, beside a command call the same
   * section reports as `await … resolved in 185 ms` — so both belong here.
   */
  it("records call-shape only where the probe executed a call", () => {
    expect(
      RUNTIME_FACADE_CAPABILITIES.filter(capability => capability.confirmation === "call-shape").map(
        capability => capability.id,
      ),
    ).toEqual([
      "server-command-invocation",
      "data-source-binding",
      "permission-check",
      "permission-map-read",
    ]);
  });

  // #5 executed three `useDataSource` calls, so the data-source binding is not a
  // pinned-result-only capability and its note has to say what was called.
  it("records the calls #5 executed for the data-source binding", () => {
    const binding = findRuntimeFacadeCapability("data-source-binding");
    expect(binding.confirmation).toBe("call-shape");
    expect(binding.note).toMatch(/useDataSource\("Sales", \{ top: 3 \}\)/);
    expect(binding.note).toMatch(/orderBySqlParams/);
    expect(binding.note).toMatch(/not a proven-complete list/);
    expect(binding.note).toMatch(/error state/);
  });

  /**
   * Two addresses, one map, different evidence — so two capabilities.
   *
   * `props.Permissions` was keyed and never invoked; `props.Forguncy.getPermissions()`
   * was called and answered. A confirmation is a property of the *call*, so a single
   * level could not honestly cover both, and the version that filed them together
   * recorded the executed call as a mere member name — the same over-claim
   * `data-source-binding` had already been corrected for, one address over.
   */
  it("separates a keyed value prop from the handle call that returns the same map", () => {
    const snapshot = findRuntimeFacadeCapability("permission-snapshot");
    const mapRead = findRuntimeFacadeCapability("permission-map-read");
    const check = findRuntimeFacadeCapability("permission-check");

    expect(snapshot.confirmation).toBe("member-presence");
    expect(snapshot.hostBindings).toEqual([{ kind: "cell-prop", prop: "Permissions" }]);
    expect(mapRead.confirmation).toBe("call-shape");
    expect(mapRead.hostBindings).toEqual([{ kind: "forguncy-member", member: "getPermissions" }]);
    expect(check.confirmation).toBe("call-shape");
    expect(check.hostBindings).toEqual([{ kind: "forguncy-member", member: "hasPermission" }]);

    // The notes carry the evidence rather than the conclusion, including the
    // synchronous detail that separates these two calls from the command call
    // recorded beside them in #5.
    for (const capability of [check, mapRead]) {
      expect(capability.note, capability.id).toMatch(/await/);
      expect(capability.note, capability.id).toMatch(/ProbePermission/);
    }
    // And the snapshot has to point at the call it is not, or a reader sees two
    // capabilities for one map with no explanation.
    expect(snapshot.note).toMatch(/getPermissions/);
    expect(snapshot.note).toMatch(/permission-map-read/);
  });

  it("leaves every other member at presence-only, where #5 stopped", () => {
    const presenceOnly = RUNTIME_FACADE_CAPABILITIES.filter(
      capability => capability.confirmation === "member-presence",
    ).map(capability => capability.id);
    expect(presenceOnly).toEqual([
      "permission-snapshot",
      "current-user",
      "session-control",
      "file-upload",
      "upload-limit",
      "cell-method-exposure",
      "forguncy-value-conversions",
      "image-context",
    ]);
  });
});

// #27's fifth acceptance criterion: "The facade does not become a cross-Cell
// state store or duplicate data layer", and #4's ownership rule expressed in
// normal TypeScript source.
describe("ownership projection", () => {
  it("files application capabilities only under concerns #4 gave to Forguncy", () => {
    const capabilities = applicationOwnedRuntimeFacadeCapabilities();
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      const concern = runtimeFacadeConcernOf(capability);
      expect(concern, capability.id).toBeDefined();
      if (concern === undefined) {
        throw new Error(`${capability.id} is application-scoped but reports no concern`);
      }
      expect(isApplicationOwned(concern), capability.id).toBe(true);
    }
  });

  it("refuses to claim the two concerns a store or a data layer would occupy", () => {
    const claimed = applicationOwnedRuntimeFacadeCapabilities().map(capability =>
      runtimeFacadeConcernOf(capability),
    );
    expect(claimed).not.toContain("application-state");
    expect(claimed).not.toContain("cross-cell-communication");
    expect(claimed).not.toContain("page-lifecycle");
    expect(claimed).not.toContain("application-navigation");
  });

  it("returns no concern for a capability it refuses to classify", () => {
    const unclassified = RUNTIME_FACADE_CAPABILITIES.filter(
      capability => capability.scope.kind === "unclassified",
    ).map(capability => capability.id);
    expect(unclassified).toEqual(["cell-method-exposure", "image-context"]);
    for (const id of unclassified) {
      expect(runtimeFacadeConcernOf(findRuntimeFacadeCapability(id))).toBeUndefined();
    }
  });

  it("says which concern each application capability serves", () => {
    expect(runtimeFacadeConcernOf(findRuntimeFacadeCapability("server-command-invocation"))).toBe(
      "server-commands",
    );
    expect(runtimeFacadeConcernOf(findRuntimeFacadeCapability("data-source-binding"))).toBe(
      "business-data-source",
    );
    for (const id of [
      "permission-snapshot",
      "permission-check",
      "permission-map-read",
      "current-user",
      "session-control",
    ] as const) {
      expect(runtimeFacadeConcernOf(findRuntimeFacadeCapability(id)), id).toBe("permissions");
    }
  });

  it("explains why a host helper is not filed under a concern", () => {
    const helpers = RUNTIME_FACADE_CAPABILITIES.filter(capability => capability.scope.kind === "host-helper");
    expect(helpers.map(capability => capability.id)).toEqual(["upload-limit", "forguncy-value-conversions"]);
    for (const helper of helpers) {
      expect(helper.scope.kind === "host-helper" && helper.scope.basis.trim().length).toBeGreaterThan(20);
    }
  });
});

describe("admissibility guard", () => {
  function baseCapability(overrides: Partial<RuntimeFacadeCapability> = {}): RuntimeFacadeCapability {
    return {
      ...findRuntimeFacadeCapability("permission-check"),
      ...overrides,
    };
  }

  it("accepts every registered capability", () => {
    for (const capability of RUNTIME_FACADE_CAPABILITIES) {
      expect(() => assertRuntimeFacadeCapabilityAdmissible(capability), capability.id).not.toThrow();
    }
  });

  it("refuses a capability that delegates to nothing", () => {
    const capability = baseCapability({ hostBindings: [] });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(/delegates to nothing/);
  });

  // A claim with no source is the exact failure #27's first criterion exists to
  // catch, so it is refused rather than defaulted.
  it("refuses a capability that cites no evidence source", () => {
    const capability = baseCapability({ evidenceSources: [] });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(/cites no evidence source/);
  });

  it("refuses an application concern #4 gave to the cell", () => {
    const capability = baseCapability({
      scope: { kind: "application", concern: "cell-ui", basis: "looks convenient" },
    });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(
      /#4 does not assign to Forguncy/,
    );
  });

  it("refuses a boundary claim with no sentence behind it", () => {
    const capability = baseCapability({
      scope: { kind: "application", concern: "permissions", basis: "   " },
    });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(/without stating what pins it/);
  });

  // Knowing how to call something is enough to know whose boundary it is on, so
  // the two must not travel together.
  it("refuses a pinned call shape filed as unclassified", () => {
    const capability = baseCapability({
      confirmation: "call-shape",
      scope: { kind: "unclassified", reason: "not sure" },
    });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(/whose capability it is/);
  });

  it("refuses an unclassified capability with no reason", () => {
    const capability = baseCapability({ scope: { kind: "unclassified", reason: " " } });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(/unclassified without saying why/);
  });

  it("refuses an address #5 never verified", () => {
    const capability = baseCapability({
      hostBindings: [{ kind: "forguncy-member", member: "navigate" as never }],
    });
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(
      /not one #5 verified on the cell handle/,
    );
  });

  it("reports the refusal code so a caller can branch without parsing the message", () => {
    let caught: unknown;
    try {
      assertRuntimeFacadeCapabilityAdmissible(baseCapability({ hostBindings: [] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("capability-not-admissible");
  });
});

// A façade that gives a name already in cell source a second address does not add
// a capability, it adds a way for two spellings of the same value to disagree.
describe("second addresses", () => {
  it("treats every confirmed name as already visible to cell source", () => {
    const confirmed: readonly RuntimeFacadeHostBinding[] = RUNTIME_FACADE_CAPABILITIES.flatMap(
      capability => capability.hostBindings,
    );
    const shadowing = confirmed.filter(runtimeFacadeBindingShadowsCellScope);
    expect(shadowing).toEqual([]);
  });

  it("exempts a cell hook, because the canonical name is the address", () => {
    expect(runtimeFacadeBindingShadowsCellScope({ kind: "cell-hook", hook: "useDataSource" })).toBe(false);
  });

  // Reachable only from data that never saw the types — which is exactly why the
  // guard runs at runtime as well as at compile time.
  it("still refuses a binding that re-addresses a cell-scope name", () => {
    expect(runtimeFacadeBindingShadowsCellScope({ kind: "cell-prop", prop: "props" as never })).toBe(true);
    const capability: RuntimeFacadeCapability = {
      ...findRuntimeFacadeCapability("permission-check"),
      hostBindings: [{ kind: "forguncy-member", member: "useState" as never }],
    };
    expect(() => assertRuntimeFacadeCapabilityAdmissible(capability)).toThrow(
      /already makes visible to cell source/,
    );
  });
});
