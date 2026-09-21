import { describe, expect, it } from "vitest";

import { HOST_BRIDGE_DECISION, HOST_BRIDGE_DECISION_REFERENCE, HOST_BRIDGE_CITATION_PATTERNS, citesDecision } from "./governance";
import {
  assertHostBridgeContract,
  assertHostBridgeMappingIsAdmissible,
  assertHostBridgeMappingIsNotAnOwnershipConflict,
  assertHostBridgeMappingsAreUnambiguous,
  findHostBridgeModuleMapping,
  hostBridgeAdapterMappings,
  hostBridgeAvailabilityOf,
  hostBridgeBindingOf,
  hostBridgeDiagnosticIsBuildTime,
  hostBridgeDiagnosticIsRuntime,
  hostBridgeGlobalIsAlwaysAvailable,
  hostBridgeGlobalMappings,
  hostBridgeIdentityBasis,
  hostBridgeIdentitySensitiveMappings,
  hostBridgeInterceptedModuleIds,
  hostBridgeMappingsForPackage,
  hostBridgeModuleIds,
  hostBridgePresetConditionalGlobals,
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_DIAGNOSTIC_CODES,
  HOST_BRIDGE_DIAGNOSTIC_RULES,
  HOST_BRIDGE_GOVERNING_DECISIONS,
  HOST_BRIDGE_GOVERNING_SPEC_REFERENCE_LINE,
  HOST_BRIDGE_IDENTITY_FIELDS,
  HOST_BRIDGE_INTERCEPTION_POINT,
  HOST_BRIDGE_MAPPINGS,
  HOST_BRIDGE_MAPPING_KINDS,
  HOST_BRIDGE_MECHANISM,
  HOST_BRIDGE_NON_GOALS,
  HostBridgeContractError,
  JSX_RUNTIME_ADAPTER_CASES,
  JSX_RUNTIME_ADAPTER_EXPORTS,
  JSX_RUNTIME_ADAPTER_RULES,
  JSX_RUNTIME_ADAPTER_RULE_IDS,
  packageNameOfModuleId,
  sharedHostBridgeDiagnosticCodes,
} from "./host-bridge";
import type { HostBridgeGlobalMapping, HostBridgeMapping } from "./host-bridge";
import { CELL_PRESET_LIBRARIES, cellUserScopeBinding } from "./runtime-contract";

function globalMapping(specifier: string): HostBridgeGlobalMapping {
  const mapping = findHostBridgeModuleMapping(specifier);
  if (mapping === undefined || mapping.kind !== "host-global") {
    throw new Error(`"${specifier}" is not a host-global mapping`);
  }
  return mapping;
}

describe("host module bridge mapping table", () => {
  it("intercepts exactly the module ids #9 names, and no others", () => {
    expect(hostBridgeInterceptedModuleIds()).toEqual([
      "react",
      "react-dom",
      "react-dom/client",
      "antd",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ]);
  });

  // #9's second non-goal and the fourth acceptance criterion both come down to
  // this: aliasing a module the source did not import would be a rewrite in
  // disguise, and a prefix rule would make `react-router/dom` inherit `react`.
  it("intercepts by exact module id rather than by package prefix", () => {
    expect(findHostBridgeModuleMapping("react-dom/client")?.specifier).toBe("react-dom");
    expect(findHostBridgeModuleMapping("react-dom/server")).toBeUndefined();
    expect(findHostBridgeModuleMapping("react-router")).toBeUndefined();
    expect(findHostBridgeModuleMapping("antd/es/button")).toBeUndefined();
    expect(findHostBridgeModuleMapping("react/jsx-runtime")?.kind).toBe("jsx-runtime-adapter");
  });

  it("keeps module ids unique across rows", () => {
    const ids = hostBridgeInterceptedModuleIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => assertHostBridgeMappingsAreUnambiguous()).not.toThrow();
  });

  it("binds React to the page object and names the field that checks its identity", () => {
    const react = globalMapping("react");
    expect(react.globalName).toBe("React");
    expect(react.identitySensitive).toBe(true);
    expect(react.identityField).toBe("hostReactVersion");
    expect(hostBridgeIdentityBasis(react)).toBe("checked-against-lock");
    // The version the bridge compares against is a real observation, not a guess:
    // #5 read it off the injected object.
    expect(react.verifiedMembers).toContain("version");
  });

  // ReactDOM is the case #8's lock cannot check — it records a host React version
  // and nothing about ReactDOM — so the mapping has to say so rather than name a
  // field it cannot honour.
  it("records ReactDOM's identity as self-enforced rather than pretend-checked", () => {
    const reactDom = globalMapping("react-dom");
    expect(reactDom.identitySensitive).toBe(true);
    expect(reactDom.identityField).toBeUndefined();
    expect(hostBridgeIdentityBasis(reactDom)).toBe("self-enforced");
    expect(reactDom.identityRule).toContain("No recorded field can check this one");
  });

  it("lists the observed ReactDOM surface, so `react-dom/client` is host-compatible and not the published module", () => {
    const reactDom = globalMapping("react-dom");
    expect(reactDom.moduleIds).toEqual(["react-dom/client"]);
    // #5 read exactly these two members off `window.ReactDOM`.
    expect(reactDom.verifiedMembers).toEqual(["version", "createRoot"]);
    expect(reactDom.note).toContain("hydrateRoot");
  });

  it("marks only the two modules #5 and #9 say must not be duplicated", () => {
    expect(hostBridgeIdentitySensitiveMappings().map(mapping => mapping.specifier)).toEqual(["react", "react-dom"]);
  });

  it("reads availability out of #5 instead of restating it", () => {
    expect(hostBridgeAvailabilityOf(globalMapping("react"))).toBe("always");
    expect(hostBridgeAvailabilityOf(globalMapping("react-dom"))).toBe("always");
    expect(hostBridgeAvailabilityOf(globalMapping("antd"))).toBe("after-the-declared-preset-resolves");

    expect(hostBridgeGlobalIsAlwaysAvailable(globalMapping("react"))).toBe(true);
    expect(hostBridgeGlobalIsAlwaysAvailable(globalMapping("antd"))).toBe(false);

    // Derived, so it agrees with #5's binding record by construction.
    for (const mapping of hostBridgeGlobalMappings()) {
      expect(hostBridgeAvailabilityOf(mapping), mapping.specifier).toBe(
        cellUserScopeBinding(mapping.globalName)?.availableInCellSource,
      );
    }
  });

  it("names the preset that gates each conditional global", () => {
    expect(hostBridgePresetConditionalGlobals()).toEqual([{ globalName: "antd", preset: "AntDesign" }]);
  });

  // The absence of a binding is a fact about the host, so a mapping for an
  // unrecorded name must be refused rather than defaulted.
  it("refuses a mapping for a global #5 never recorded", () => {
    const mapping: HostBridgeMapping = {
      kind: "host-global",
      specifier: "lodash",
      globalName: "_",
      identityRule: "none needed",
      verifiedMembers: [],
      evidence: ["product-runtime-source"],
    };
    expect(() => assertHostBridgeMappingIsAdmissible(mapping)).toThrow(HostBridgeContractError);
    expect(() => assertHostBridgeMappingIsAdmissible(mapping)).toThrow(/not one of the names the runtime contract verified/);
  });

  // `props` and `useDataSource` *are* verified names, and mapping a module onto
  // one would bind a module to something that exists only inside one cell's render
  // closure.
  it("refuses a mapping whose target is a wrapper-local", () => {
    const mapping: HostBridgeMapping = {
      kind: "host-global",
      specifier: "some-lib",
      globalName: "useDataSource",
      identityRule: "none needed",
      verifiedMembers: [],
      evidence: ["product-runtime-source"],
    };
    expect(() => assertHostBridgeMappingIsAdmissible(mapping)).toThrow(/wrapper-local/);
  });

  it("refuses a mapping with no evidence channel, and one with no identity rule", () => {
    expect(() =>
      assertHostBridgeMappingIsAdmissible({
        kind: "host-global",
        specifier: "react",
        globalName: "React",
        identityRule: "a rule",
        verifiedMembers: [],
        evidence: [],
      }),
    ).toThrow(/no evidence channel/);

    expect(() =>
      assertHostBridgeMappingIsAdmissible({
        kind: "host-global",
        specifier: "react",
        globalName: "React",
        identityRule: "   ",
        verifiedMembers: [],
        evidence: ["product-runtime-source"],
      }),
    ).toThrow(/states no identity rule/);
  });

  it("refuses an adapter that names a page global and an adapter with nothing to delegate to", () => {
    expect(() =>
      assertHostBridgeMappingIsAdmissible({
        kind: "jsx-runtime-adapter",
        specifier: "react/jsx-runtime",
        adapter: "jsx-runtime",
        requiredHostMembers: ["createElement"],
        verifiedMembers: [],
        evidence: ["product-runtime-source"],
        globalName: "React",
      } as unknown as HostBridgeMapping),
    ).toThrow(/must not name a page global/);

    expect(() =>
      assertHostBridgeMappingIsAdmissible({
        kind: "jsx-runtime-adapter",
        specifier: "react/jsx-runtime",
        adapter: "jsx-runtime",
        requiredHostMembers: [],
        verifiedMembers: [],
        evidence: ["product-runtime-source"],
      }),
    ).toThrow(/names no host member to delegate to/);
  });

  it("refuses two rows claiming one module id", () => {
    expect(() =>
      assertHostBridgeMappingsAreUnambiguous([
        ...HOST_BRIDGE_MAPPINGS,
        {
          kind: "host-global",
          specifier: "antd",
          globalName: "antd",
          identityRule: "duplicate row",
          verifiedMembers: [],
          evidence: ["product-runtime-source"],
        },
      ]),
    ).toThrow(/claimed by both/);
  });

  // #9's second non-goal: a bridge row is not a way to make an ownership conflict
  // compile.
  it("refuses to map a package that has no legitimate in-cell role", () => {
    expect(() =>
      assertHostBridgeMappingIsNotAnOwnershipConflict({
        kind: "host-global",
        specifier: "react-router",
        globalName: "React",
        identityRule: "irrelevant",
        verifiedMembers: [],
        evidence: ["product-runtime-source"],
      }),
    ).toThrow(/no legitimate in-cell role/);

    // A package whose rule *does* allow a cell-local role is not this check's
    // business — refusing it would refuse a supported configuration.
    expect(() =>
      assertHostBridgeMappingIsNotAnOwnershipConflict({
        kind: "host-global",
        specifier: "zustand",
        globalName: "React",
        identityRule: "irrelevant",
        verifiedMembers: [],
        evidence: ["product-runtime-source"],
      }),
    ).not.toThrow();
  });

  it("passes its own guards as shipped", () => {
    expect(() => assertHostBridgeContract()).not.toThrow();
  });
});

describe("the bridge mechanism", () => {
  // #9's fourth and fifth acceptance criteria are properties of where the bridge
  // attaches, so they are asserted against the recorded mechanism rather than
  // argued in a comment.
  it("attaches at module resolution and never inspects authored source", () => {
    expect(HOST_BRIDGE_MECHANISM.interceptionPoint).toBe("module-resolution");
    expect(HOST_BRIDGE_INTERCEPTION_POINT).toBe("module-resolution");
    expect(HOST_BRIDGE_MECHANISM.rewritesAuthoredSource).toBe(false);
    expect(HOST_BRIDGE_MECHANISM.inspectsAuthoredSource).toBe(false);
    expect(HOST_BRIDGE_MECHANISM.interceptionKey).toBe("specifier");
    expect(HOST_BRIDGE_MECHANISM.mappingSource).toBe("HOST_BRIDGE_MAPPINGS");
  });

  it("has exactly the two mapping kinds #9 distinguishes", () => {
    expect(HOST_BRIDGE_MAPPING_KINDS).toEqual(["host-global", "jsx-runtime-adapter"]);
    expect(hostBridgeGlobalMappings().map(mapping => mapping.specifier)).toEqual(["react", "react-dom", "antd"]);
    expect(hostBridgeAdapterMappings().map(mapping => mapping.specifier)).toEqual(["react/jsx-runtime"]);
  });

  it("keeps a JSX runtime id off every page global", () => {
    for (const mapping of hostBridgeAdapterMappings()) {
      expect((mapping as { globalName?: unknown }).globalName).toBeUndefined();
    }
    const globalNames = hostBridgeGlobalMappings().flatMap(hostBridgeModuleIds);
    expect(globalNames).not.toContain("react/jsx-runtime");
    expect(globalNames).not.toContain("react/jsx-dev-runtime");
  });

  it("resolves a package's mappings without keying interception on the package", () => {
    expect(hostBridgeMappingsForPackage("react").map(mapping => mapping.specifier)).toEqual([
      "react",
      "react/jsx-runtime",
    ]);
    expect(packageNameOfModuleId("react-dom/client")).toBe("react-dom");
    expect(packageNameOfModuleId("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(hostBridgeBindingOf(globalMapping("react"))?.kind).toBe("injected-parameter");
    expect(hostBridgeBindingOf(globalMapping("react-dom"))?.kind).toBe("page-global");
  });
});

describe("the JSX runtime adapter contract", () => {
  it("exports the four names the automatic and dev runtimes select between", () => {
    expect(JSX_RUNTIME_ADAPTER_EXPORTS).toEqual(["jsx", "jsxs", "jsxDEV", "Fragment"]);
  });

  it("states one rule per way the delegate's signature differs, plus the two #9 adds", () => {
    expect(JSX_RUNTIME_ADAPTER_RULE_IDS).toContain("key-is-not-children");
    expect(JSX_RUNTIME_ADAPTER_RULE_IDS).toContain("no-third-argument-without-a-key");
    expect(JSX_RUNTIME_ADAPTER_RULE_IDS).toContain("evaluation-must-not-throw");
    expect(JSX_RUNTIME_ADAPTER_RULE_IDS).toContain("adapter-is-not-the-react-object");

    for (const rule of JSX_RUNTIME_ADAPTER_RULES) {
      expect(rule.statement.length, rule.id).toBeGreaterThan(0);
      expect(rule.why.length, rule.id).toBeGreaterThan(0);
      expect(rule.establishedBy.length, rule.id).toBeGreaterThan(0);
    }
  });

  // #9's second acceptance criterion asks for tests "with children and keyed
  // lists"; the case list is what makes that checkable rather than adjectival.
  it("covers keyed lists and children, and every rule is covered by a case", () => {
    const covered = new Set(JSX_RUNTIME_ADAPTER_CASES.flatMap(entry => entry.covers));
    for (const rule of JSX_RUNTIME_ADAPTER_RULES) {
      expect(covered.has(rule.id), rule.id).toBe(true);
    }

    const ids = JSX_RUNTIME_ADAPTER_CASES.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("children-only");
    expect(ids).toContain("keyed-list-via-jsxs");
    expect(ids).toContain("explicit-undefined-key");
  });

  it("records the verified source of each rule rather than re-arguing it", () => {
    const keyRule = JSX_RUNTIME_ADAPTER_RULES.find(rule => rule.id === "key-is-not-children");
    expect(keyRule?.establishedBy).toContain("forguncy-react-library");
    const throwRule = JSX_RUNTIME_ADAPTER_RULES.find(rule => rule.id === "evaluation-must-not-throw");
    expect(throwRule?.establishedBy).toContain("jsx-runtime-adapter.mjs");
  });
});

describe("host bridge diagnostics", () => {
  it("gives every code a rule, a fix owner and a remediation", () => {
    expect(HOST_BRIDGE_DIAGNOSTIC_CODES).toHaveLength(6);
    for (const code of HOST_BRIDGE_DIAGNOSTIC_CODES) {
      const rule = HOST_BRIDGE_DIAGNOSTIC_RULES[code];
      expect(rule.code, code).toBe(code);
      expect(rule.remediation.length, code).toBeGreaterThan(0);
      expect(rule.fixOwner.length, code).toBeGreaterThan(0);
    }
  });

  // One vocabulary for two moments: the same condition has to be recognizable as
  // the same problem whether it is refused by a build or thrown by a page.
  it("shares `host-global-missing` and `host-global-incompatible` between the build and the page", () => {
    expect(sharedHostBridgeDiagnosticCodes()).toEqual(["host-global-missing", "host-global-incompatible"]);
    expect(hostBridgeDiagnosticIsBuildTime("host-global-missing")).toBe(true);
    expect(hostBridgeDiagnosticIsRuntime("host-global-missing")).toBe(true);
    expect(hostBridgeDiagnosticIsBuildTime("host-adapter-not-used")).toBe(true);
    expect(hostBridgeDiagnosticIsRuntime("host-adapter-not-used")).toBe(false);
    expect(hostBridgeDiagnosticIsRuntime("host-module-duplicated")).toBe(false);
  });

  it("says which codes a mapping change can fix", () => {
    expect(HOST_BRIDGE_DIAGNOSTIC_RULES["host-mapping-missing"].fixableByMapping).toBe(true);
    expect(HOST_BRIDGE_DIAGNOSTIC_RULES["host-adapter-not-used"].fixableByMapping).toBe(true);
    expect(HOST_BRIDGE_DIAGNOSTIC_RULES["host-mapping-conflict"].fixableByMapping).toBe(true);
    // Neither a missing page global nor a bundled duplicate is a table problem.
    expect(HOST_BRIDGE_DIAGNOSTIC_RULES["host-global-missing"].fixableByMapping).toBe(false);
    expect(HOST_BRIDGE_DIAGNOSTIC_RULES["host-module-duplicated"].fixableByMapping).toBe(false);
  });

  it("records one identity field, because #8 records one host version", () => {
    expect(HOST_BRIDGE_IDENTITY_FIELDS).toEqual(["hostReactVersion"]);
  });
});

describe("the built-ins #9 defers", () => {
  // Deferred is not the same as forgotten: #9 names `echarts`/`dayjs` as "later
  // built-ins", and #5 has since confirmed their availability without confirming
  // their version semantics — so the deferral has to be recorded, with its reason.
  it("defers dayjs and echarts with a reason instead of omitting them", () => {
    expect(HOST_BRIDGE_DEFERRED_MODULES.map(entry => entry.specifier)).toEqual(["dayjs", "echarts"]);

    for (const entry of HOST_BRIDGE_DEFERRED_MODULES) {
      expect(findHostBridgeModuleMapping(entry.specifier), entry.specifier).toBeUndefined();
      expect(entry.reason.length, entry.specifier).toBeGreaterThan(0);
      expect(entry.requires.length, entry.specifier).toBeGreaterThan(0);
      // The global #5 did record, so the deferral cannot be read as "not there".
      expect(cellUserScopeBinding(entry.globalName), entry.specifier).toBeDefined();
      // And the preset that installs it, read from #5 rather than restated.
      const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.name === entry.preset);
      expect(preset?.providesGlobals, entry.specifier).toContain(entry.globalName);
    }
  });

  it("defers them for the reason #9 gives, not for absence of evidence of availability", () => {
    const dayjs = HOST_BRIDGE_DEFERRED_MODULES.find(entry => entry.specifier === "dayjs");
    expect(dayjs?.reason).toContain("version");
    const echarts = HOST_BRIDGE_DEFERRED_MODULES.find(entry => entry.specifier === "echarts");
    expect(echarts?.reason).toContain("normal");
  });
});

describe("host bridge non-goals and provenance", () => {
  it("states the non-goals #9 states, and refuses to become a strategy decision", () => {
    expect(HOST_BRIDGE_NON_GOALS.some(entry => entry.includes("automatically safe or stable"))).toBe(true);
    expect(HOST_BRIDGE_NON_GOALS.some(entry => entry.includes("conflicts with #4's ownership"))).toBe(true);
    expect(HOST_BRIDGE_NON_GOALS.some(entry => entry.includes("should be `host`"))).toBe(true);
    // A `host` mapping with a bundling fallback cannot honour the identity rule.
    expect(HOST_BRIDGE_NON_GOALS.some(entry => entry.includes("inline"))).toBe(true);
  });

  it("points at Issue #9 and cites the architecture Specs it is built on", () => {
    expect(HOST_BRIDGE_DECISION.issue).toBe(9);
    expect(HOST_BRIDGE_DECISION_REFERENCE).toBe("#9");
    expect(HOST_BRIDGE_DECISION.url).toBe("https://github.com/Mang-X/forguncy-react-workspace/issues/9");
    expect(HOST_BRIDGE_GOVERNING_DECISIONS.map(source => source.issue)).toEqual([4, 5, 9]);
    expect(HOST_BRIDGE_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #9");
  });

  // `#9` is a prefix of `#90`, so a substring check would report a citation of a
  // different Issue — the boundary reasoning `citationPatternsFor` already owns.
  it("detects a citation of #9 without accepting a longer issue number", () => {
    expect(citesDecision("#9", HOST_BRIDGE_DECISION)).toBe(true);
    expect(citesDecision("https://github.com/Mang-X/forguncy-react-workspace/issues/9", HOST_BRIDGE_DECISION)).toBe(
      true,
    );
    expect(citesDecision("#90", HOST_BRIDGE_DECISION)).toBe(false);
    expect(citesDecision("#19", HOST_BRIDGE_DECISION)).toBe(false);
    expect(HOST_BRIDGE_CITATION_PATTERNS).toHaveLength(3);
  });
});
