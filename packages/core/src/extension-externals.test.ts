import { describe, expect, it } from "vitest";

import {
  assertExtensionExternalContract,
  assertExtensionExternalMappingIsAdmissible,
  assertExtensionExternalMappingsAreUnambiguous,
  auditExtensionLibraryMetadata,
  extensionGlobalClaimReason,
  extensionInterceptedModuleIds,
  extensionMappingForPackage,
  extensionMappingGlobals,
  extensionMappingsForLibrary,
  extensionModuleIds,
  extensionVerificationBasis,
  EXTENSION_EXTERNAL_DIAGNOSTIC_CODES,
  EXTENSION_EXTERNAL_DIAGNOSTIC_MOMENTS,
  EXTENSION_EXTERNAL_DIAGNOSTIC_RULES,
  EXTENSION_EXTERNAL_INTEROP_BEHAVIOUR,
  EXTENSION_EXTERNAL_MAPPINGS,
  EXTENSION_GLOBAL_NAME_PATTERN,
  EXTENSION_GLOBAL_READ_TIMING,
  EXTENSION_LOAD_ORDER_RULES,
  EXTENSION_METADATA_SOURCES,
  EXTENSION_RESERVED_GLOBAL_NAMES,
  EXTENSION_RESERVED_LIBRARY_IDS,
  EXTENSION_RESERVED_LIBRARY_ID_SEGMENTS,
  findExtensionExternalMapping,
  isExtensionGlobalName,
  isExtensionLibraryId,
} from "./extension-externals.ts";
import type { ExtensionExternalMapping, ExtensionLibraryListing } from "./extension-externals.ts";
import { hostBridgeGlobalMappings } from "./host-bridge.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** #12's canonical row, which every test below either uses or is measured against. */
function tanStackQueryMapping(): ExtensionExternalMapping {
  const mapping = EXTENSION_EXTERNAL_MAPPINGS.find(candidate => candidate.packageName === "@tanstack/react-query");
  if (mapping === undefined) throw new Error("The table no longer carries the canonical TanStack Query row.");
  return mapping;
}

/** A well-formed row, so each refusal test below varies exactly one thing. */
function mapping(overrides: Partial<ExtensionExternalMapping> = {}): ExtensionExternalMapping {
  return {
    packageName: "some-package",
    libraryId: "some-library",
    globalName: "SomeLibrary",
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule: "A catalog entry whose id and global the listing confirms.",
    verifiedBy: ["product-documentation"],
    note: "synthetic row",
    ...overrides,
  };
}

/** A listing shaped the way `api.app.listFrontendLibraries` reports one. */
function listing(overrides: Partial<ExtensionLibraryListing> = {}): ExtensionLibraryListing {
  return {
    id: "tanstack-query",
    name: "TanStack Query for ReactCellType",
    globalName: "TanStackQuery",
    exists: true,
    typeDefinitionAvailable: true,
    ...overrides,
  };
}

/** The guard's message, or a failure explaining that nothing was thrown. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the guard to refuse this mapping, and it did not.");
}

/** The audit over the canonical row, which is what a plan for a TanStack Query cell passes. */
function audit(
  listings: readonly ExtensionLibraryListing[],
  mappings: readonly ExtensionExternalMapping[] = [tanStackQueryMapping()],
): readonly { readonly code: string; readonly subject: string; readonly detail: string }[] {
  return auditExtensionLibraryMetadata(listings, { mappings });
}

// ---------------------------------------------------------------------------
// The shipped table
// ---------------------------------------------------------------------------

describe("the shipped extension mapping table", () => {
  it("satisfies its own contract", () => {
    expect(() => assertExtensionExternalContract()).not.toThrow();
  });

  it("carries #12's canonical TanStack Query case, with the identity the rest of the repository already uses", () => {
    // The same triple appears in #8's lock fixtures, #24's conformance catalog and
    // #12's own example, so a typo here would be a typo in every one of them.
    expect(tanStackQueryMapping().libraryId).toBe("tanstack-query");
    expect(tanStackQueryMapping().globalName).toBe("TanStackQuery");
    expect(tanStackQueryMapping().metadataSource).toBe("verified-catalog");
  });

  it("covers the sibling package the vendor package re-exports", () => {
    // `@tanstack/query-core` is a package of its own, and the extension's global
    // carries its exports because `@tanstack/react-query` re-exports them. #12's
    // "one extension stands in for more than one package", expressed as one row.
    expect(extensionModuleIds(tanStackQueryMapping())).toEqual(["@tanstack/react-query", "@tanstack/query-core"]);
    expect(extensionInterceptedModuleIds()).toEqual(["@tanstack/react-query", "@tanstack/query-core"]);
  });

  it("intercepts module ids exactly, so an unlisted subpath stays unbridged", () => {
    expect(findExtensionExternalMapping("@tanstack/react-query")).toBe(tanStackQueryMapping());
    expect(findExtensionExternalMapping("@tanstack/react-query/persist")).toBeUndefined();
    expect(findExtensionExternalMapping("@tanstack/react-query-persist-client")).toBeUndefined();
  });

  it("finds a row for a package the table lists as one of its module ids", () => {
    expect(extensionMappingForPackage("@tanstack/query-core")).toBe(tanStackQueryMapping());
    expect(extensionMappingForPackage("left-pad")).toBeUndefined();
  });

  it("reports every row that names a library, so sharing is answerable from the table", () => {
    expect(extensionMappingsForLibrary("tanstack-query")).toEqual([tanStackQueryMapping()]);
    expect(extensionMappingsForLibrary("nope")).toEqual([]);
  });

  it("reads a catalog-declared row as catalog-declared", () => {
    expect(extensionVerificationBasis(tanStackQueryMapping())).toBe("catalog-declared");
    expect(extensionVerificationBasis(mapping({ metadataSource: "list-frontend-libraries" }))).toBe(
      "listing-confirmed",
    );
    expect(extensionMappingGlobals()).toEqual(["TanStackQuery"]);
  });

  it("keeps every host-bridge global on the platform's reserved list", () => {
    // The guard below refuses a mapping whose global the host bridge already binds
    // *and* one the platform reserves. Today the second subsumes the first for every
    // host row, so this test is what keeps that a checked fact rather than a
    // coincidence: a new host row for a name the platform does not reserve has to
    // fail here, where the reason is visible, instead of quietly becoming available
    // to an extension.
    const uncovered = hostBridgeGlobalMappings()
      .map(host => host.globalName)
      .filter(globalName => !EXTENSION_RESERVED_GLOBAL_NAMES.includes(globalName as never));
    expect(uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Platform shape rules
// ---------------------------------------------------------------------------

describe("platform library id and global name rules", () => {
  it("accepts the ids the platform accepts", () => {
    for (const id of ["tanstack-query", "a", "vendor.library_1", "Vendor-Library", "x.y.z"]) {
      expect(isExtensionLibraryId(id)).toBe(true);
    }
  });

  it("refuses ids the platform's manifest validation refuses", () => {
    for (const id of ["", "-leading-dash", ".leading-dot", "trailing.", "1leading-digit", "has space", "a".repeat(65)]) {
      expect(isExtensionLibraryId(id)).toBe(false);
    }
  });

  it("refuses the built-in preset ids and the Windows device names", () => {
    for (const reserved of EXTENSION_RESERVED_LIBRARY_IDS) {
      expect(isExtensionLibraryId(reserved)).toBe(false);
      expect(isExtensionLibraryId(reserved.toLowerCase())).toBe(false);
    }
    for (const device of EXTENSION_RESERVED_LIBRARY_ID_SEGMENTS) {
      expect(isExtensionLibraryId(device.toLowerCase())).toBe(false);
      expect(isExtensionLibraryId(`${device.toLowerCase()}.ext`)).toBe(false);
    }
    // A device name that is not the *first* segment is not a device name.
    expect(isExtensionLibraryId("my.con")).toBe(true);
  });

  it("accepts a single identifier as a global and refuses anything else", () => {
    for (const name of ["TanStackQuery", "_private", "ReactThreeFiber", "SFGC"]) {
      expect(isExtensionGlobalName(name)).toBe(true);
    }
    // `$` is a legal identifier and still refused, because the platform reserves it:
    // the reserved list is checked as well as the shape, not instead of it.
    for (const name of ["Foo.Bar", "1Leading", "has space", "", "class", "await", "React", "antd", "define", "$"]) {
      expect(isExtensionGlobalName(name)).toBe(false);
    }
  });

  it("states which of the two reasons a global is unavailable, and says so in words", () => {
    expect(extensionGlobalClaimReason("React")).toContain("manifest validation reserves this name");
    expect(extensionGlobalClaimReason("TanStackQuery")).toBeUndefined();
    // The host-bridge reason, exercised through an injected table: every shipped host
    // global is also platform-reserved, so without the option this clause would be
    // unreachable and therefore untested.
    expect(extensionGlobalClaimReason("SomeHostGlobal", { hostGlobals: ["SomeHostGlobal"] })).toContain(
      "#9's host bridge already binds",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-mapping guard
// ---------------------------------------------------------------------------

describe("an inadmissible extension mapping", () => {
  it("passes for a row that is complete", () => {
    expect(() => assertExtensionExternalMappingIsAdmissible(mapping())).not.toThrow();
  });

  it("is refused when its library id is one the platform would refuse", () => {
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ libraryId: "con" })))).toContain(
      "manifest validation would refuse",
    );
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ libraryId: "AntDesign" })))).toContain(
      "manifest validation would refuse",
    );
  });

  it("is refused when it names no global", () => {
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ globalName: "" })))).toContain(
      "names no global",
    );
  });

  it("is refused when its global is not a single identifier, before anything is said about reservations", () => {
    // Two checks, two repairs: `Foo.Bar` is a shape problem and `antd` is a
    // reservation problem, and a guard that reported one message for both would send a
    // reader looking for the wrong thing.
    expect(
      refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ globalName: "Foo.Bar" }))),
    ).toContain("not a single JavaScript identifier");
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ globalName: "class" })))).toContain(
      "not a single JavaScript identifier",
    );
  });

  it("is refused when its global is reserved, naming which reservation applies", () => {
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ globalName: "antd" })))).toContain(
      "manifest validation reserves this name",
    );
    expect(
      refusal(() =>
        assertExtensionExternalMappingIsAdmissible(mapping({ globalName: "NotReserved" }), {
          hostGlobals: ["NotReserved"],
        }),
      ),
    ).toContain("#9's host bridge already binds");
  });

  it("is refused when it does not say where its library id came from", () => {
    expect(
      refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ metadataSource: "looks-legit" as never }))),
    ).toContain("not one of #12's two");
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ metadataReference: "  " })))).toContain(
      "guessed from a display name",
    );
  });

  it("is refused when it records no evidence channel", () => {
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ verifiedBy: [] })))).toContain(
      "no evidence channel",
    );
  });

  it("is refused when it states no verification rule", () => {
    expect(refusal(() => assertExtensionExternalMappingIsAdmissible(mapping({ verificationRule: " " })))).toContain(
      "states no verification rule",
    );
  });

  it("is refused when it lists one of its own ids twice", () => {
    expect(
      refusal(() =>
        assertExtensionExternalMappingIsAdmissible(
          mapping({ packageName: "dup", moduleIds: ["dup", "other"] }),
        ),
      ),
    ).toContain('lists "dup" twice');
  });
});

// ---------------------------------------------------------------------------
// Cross-row guard
// ---------------------------------------------------------------------------

describe("an ambiguous extension mapping table", () => {
  it("passes for the shipped table", () => {
    expect(() => assertExtensionExternalMappingsAreUnambiguous()).not.toThrow();
  });

  it("refuses two rows claiming one module id", () => {
    const message = refusal(() =>
      assertExtensionExternalMappingsAreUnambiguous([
        mapping({ packageName: "shared", libraryId: "lib-a", globalName: "LibA" }),
        mapping({ packageName: "other", libraryId: "lib-b", globalName: "LibB", moduleIds: ["shared"] }),
      ]),
    );
    expect(message).toContain("claimed by both");
    expect(message).toContain("table order");
  });

  it("refuses one global claimed by two libraries", () => {
    // The platform's own validation refuses two extensions publishing one global, so
    // a table that allowed it would describe a designer state that cannot be reached.
    expect(
      refusal(() =>
        assertExtensionExternalMappingsAreUnambiguous([
          mapping({ packageName: "a", libraryId: "lib-a", globalName: "Shared" }),
          mapping({ packageName: "b", libraryId: "lib-b", globalName: "Shared" }),
        ]),
      ),
    ).toContain("A global holds one object");
  });

  it("refuses one library bound to two globals", () => {
    expect(
      refusal(() =>
        assertExtensionExternalMappingsAreUnambiguous([
          mapping({ packageName: "a", libraryId: "lib", globalName: "LibOne" }),
          mapping({ packageName: "b", libraryId: "lib", globalName: "LibTwo" }),
        ]),
      ),
    ).toContain("publishes one global name");
  });

  it("refuses a module id the host bridge already binds", () => {
    // Across the two tables, not within one: `react` reaching an extension mapping is
    // an import with two identities, which is the conflict #12 asks the compiler to
    // detect. Exercised through an injected host table for the reason given above.
    expect(
      refusal(() =>
        assertExtensionExternalMappingsAreUnambiguous(
          [mapping({ packageName: "anything", libraryId: "lib", globalName: "Lib" })],
          { hostModuleIds: ["anything"] },
        ),
      ),
    ).toContain("two different identities");
  });

  it("threads the injected host table into the per-row guard as well", () => {
    // A caller-supplied table that only reached the cross-row check would report a
    // clean verdict on a row the other guard had already refused.
    expect(
      refusal(() =>
        assertExtensionExternalContract([mapping({ globalName: "HostOwned" })], { hostGlobals: ["HostOwned"] }),
      ),
    ).toContain("#9's host bridge already binds");
  });
});

// ---------------------------------------------------------------------------
// Metadata audit
// ---------------------------------------------------------------------------

describe("#12's extension metadata audit", () => {
  it("confirms a mapping whose listing agrees with it", () => {
    expect(audit([listing()])).toEqual([]);
  });

  it("matches on the stable id rather than the display name", () => {
    // The listing gives the library a display name that shares nothing with the id,
    // and the audit is still satisfied — which is the whole content of "not a display
    // name".
    expect(audit([listing({ name: "TanStack 查询扩展包" })])).toEqual([]);
  });

  it("says so when the mapping used the display name as the id", () => {
    const findings = audit([listing()], [
      { ...tanStackQueryMapping(), libraryId: "TanStack Query for ReactCellType" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("extension-library-unverified");
    expect(findings[0]?.detail).toContain("is the display name");
    expect(findings[0]?.detail).toContain('"tanstack-query"');
  });

  it("lets a confirmed id win over another library's display name that looks like it", () => {
    // Review regression (#48, finding 3). The display-name check used to run first, so
    // an unrelated library whose *name* equalled this mapping's id turned a perfectly
    // verified mapping into a finding. Nothing is wrong with the mapping or with either
    // listing, which is what makes it the worst kind of false positive.
    const findings = audit([
      listing({ name: "Something Else" }),
      listing({ id: "other-library", name: "tanstack-query", globalName: "OtherGlobal" }),
    ]);

    expect(findings).toEqual([]);
  });

  it("still reports a display name when no library has that id", () => {
    // The reordering must not lose the targeted message: with no id match at all, the
    // name collision is still the most useful thing to say.
    const findings = audit([listing({ id: "other-library", name: "tanstack-query", globalName: "OtherGlobal" })], [
      { ...tanStackQueryMapping(), libraryId: "tanstack-query" },
    ]);

    expect(findings.map(finding => finding.code)).toEqual(["extension-library-unverified"]);
    expect(findings[0]?.detail).toContain("is the display name");
    expect(findings[0]?.detail).toContain('"other-library"');
  });

  it("reports an id no library in the listing has", () => {
    const findings = audit([listing({ id: "something-else" })]);
    expect(findings.map(finding => finding.code)).toEqual(["extension-library-unverified"]);
    expect(findings[0]?.detail).toContain('no library with id "tanstack-query"');
  });

  it("reports a global the listing publishes under a different name", () => {
    const findings = audit([listing({ globalName: "QueryGlobal" })]);
    expect(findings.map(finding => finding.code)).toEqual(["extension-global-mismatch"]);
    expect(findings[0]?.detail).toContain('publishes "QueryGlobal"');
  });

  it("distinguishes an absent bundle from an unstated one", () => {
    expect(audit([listing({ exists: false })]).map(finding => finding.code)).toEqual(["extension-bundle-missing"]);
    expect(audit([listing({ exists: undefined })])).toEqual([]);
  });

  it("reports missing type definitions separately from a missing bundle", () => {
    const findings = audit([listing({ exists: false, typeDefinitionAvailable: false })]);
    // Both are real and both are reported: they are different repairs on the
    // extension package, and a caller that only saw the first would upload a bundle
    // and still leave the designer unable to complete the global.
    expect(findings.map(finding => finding.code)).toEqual(["extension-bundle-missing", "extension-types-missing"]);
  });

  it("checks exactly the mappings it is given, so a row the project does not use is silent", () => {
    // The listing is one project's designer state, and a project is not required to
    // have installed every extension the table knows about. Auditing the whole table
    // would report a finding for each row the artifact never touches.
    expect(audit([listing()], [])).toEqual([]);
    expect(audit([listing()], [mapping({ libraryId: "not-installed", globalName: "NotInstalled" })])).toEqual([
      expect.objectContaining({ code: "extension-library-unverified", subject: "some-package" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The vocabulary and the load-order rules
// ---------------------------------------------------------------------------

describe("the extension externals vocabulary", () => {
  it("gives every code a rule with a moment, a remediation and a fix owner", () => {
    for (const code of EXTENSION_EXTERNAL_DIAGNOSTIC_CODES) {
      const rule = EXTENSION_EXTERNAL_DIAGNOSTIC_RULES[code];
      expect(rule.moments.length).toBeGreaterThan(0);
      expect(rule.states.length).toBeGreaterThan(0);
      expect(rule.remediation.length).toBeGreaterThan(0);
      expect(["dependency-decision", "extension-mapping", "extension-metadata", "extension-package"]).toContain(
        rule.fixOwner,
      );
      for (const moment of rule.moments) expect(EXTENSION_EXTERNAL_DIAGNOSTIC_MOMENTS).toContain(moment);
    }
  });

  it("keeps the runtime code out of the build and sync moments", () => {
    // A generated module that could report a table problem from inside the page would
    // be reporting a finding no page can act on.
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_RULES["extension-global-missing"].moments).toEqual(["runtime"]);
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_RULES["extension-not-declared"].moments).toEqual(["build"]);
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_RULES["extension-bundle-missing"].moments).toEqual(["sync"]);
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_RULES["extension-library-unverified"].moments).toEqual(["build", "sync"]);
  });

  it("leaves the artifact-specific codes to #6", () => {
    // Two vocabularies, and the difference is the subject: a code here is about a
    // mapping or an extension identity, never about a produced artifact.
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_CODES).not.toContain("missing-extension-mapping");
    expect(EXTENSION_EXTERNAL_DIAGNOSTIC_CODES).not.toContain("duplicate-host-mapping");
  });

  it("states the load-order rules with the fact each one rests on", () => {
    expect(EXTENSION_LOAD_ORDER_RULES).toHaveLength(5);
    for (const rule of EXTENSION_LOAD_ORDER_RULES) {
      expect(rule.statement.length).toBeGreaterThan(0);
      expect(rule.why.length).toBeGreaterThan(0);
      expect(rule.establishedBy.length).toBeGreaterThan(0);
    }
    expect(EXTENSION_GLOBAL_READ_TIMING).toBe("module-body-evaluation");
    expect(EXTENSION_LOAD_ORDER_RULES[0]?.statement).toContain(EXTENSION_GLOBAL_READ_TIMING);
  });

  it("records the interop behaviour the generated module is written against", () => {
    // The one fact in this module that came from experiment rather than from a Spec, and
    // the reason the generated module exports the page object instead of answering
    // member access through a proxy. Recording the *mechanism* rather than a version is
    // deliberate: a version pin would go stale silently, while a mechanism names what
    // has to be re-checked when it changes.
    const behaviour = EXTENSION_EXTERNAL_INTEROP_BEHAVIOUR;

    expect(behaviour.id).toBe("namespace-is-built-by-enumeration");
    expect(behaviour.statement).toContain("enumerating the module's own enumerable properties");
    expect(behaviour.forcedBy).toContain("__esModule");
    expect(behaviour.consequence).toContain("silently");
    expect(behaviour.observedIn).toContain("rolldown");
    // And the rule that exists because of it, so the two cannot drift apart.
    expect(EXTENSION_LOAD_ORDER_RULES.map(rule => rule.id)).toContain("export-surface-is-the-page-objects");
  });

  it("names exactly the two metadata sources #12 allows", () => {
    expect(EXTENSION_METADATA_SOURCES).toEqual(["list-frontend-libraries", "verified-catalog"]);
  });

  it("exposes the id and global patterns the platform enforces", () => {
    expect(EXTENSION_GLOBAL_NAME_PATTERN.test("TanStackQuery")).toBe(true);
    expect(EXTENSION_GLOBAL_NAME_PATTERN.test("Foo.Bar")).toBe(false);
  });
});
