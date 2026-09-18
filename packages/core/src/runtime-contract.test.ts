import { describe, expect, it } from "vitest";

import * as contract from "./runtime-contract";
import {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_ENTRY_RESOLUTION_ORDER,
  CELL_ENTRY_SHAPES,
  CELL_FORGUNCY_FACADE,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_HOST_RUNTIME_SEMANTICS,
  CELL_PRESET_LIBRARIES,
  CELL_PRESET_LIBRARY_DEFAULT,
  CELL_PROPS_BASE_KEYS,
  CELL_PROPS_KEY_ORDER,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  CELL_SERVER_COMMANDS_CONTRACT,
  CELL_SERVER_COMMAND_RESULT_KEYS,
  CELL_SOURCE_EXECUTION_MODEL,
  CELL_SOURCE_REJECTIONS,
  CELL_SOURCE_REJECTION_ENVELOPE,
  CELL_SOURCE_SIZE_OBSERVATIONS,
  CELL_USER_SCOPE_BINDINGS,
  cellUserScopeBinding,
  describeRuntimeContractTarget,
  emitCellEntryShapes,
  findCellEntryShape,
  findCellHostRuntimeFact,
  findCellPresetLibrary,
  findCellSourceRejection,
  FRONTEND_LIBRARY_REFERENCE_CONTRACT,
  FRONTEND_LIBRARY_REFERENCE_EXAMPLE,
  FRONTEND_LIBRARY_RUNTIME_SEMANTICS,
  nonWorkingCellEntryShapes,
  openRuntimeContractQuestions,
  persistedDefaultCellPreset,
  rejectedCellSourceConstructs,
  RUNTIME_CONTRACT_TARGET,
  RUNTIME_CONTRACT_UNKNOWNS,
} from "./runtime-contract";
import type { RuntimeEvidenceChannel } from "./runtime-contract";
import {
  citesDecision,
  citesEveryArchitectureDecision,
  GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE,
  RUNTIME_CONTRACT_DECISION,
  RUNTIME_CONTRACT_DECISION_REFERENCE,
} from "./governance";

const EVIDENCE_CHANNELS: readonly RuntimeEvidenceChannel[] = [
  "product-runtime-source",
  "product-documentation",
  "designer-api",
  "generated-runtime-browser",
];

interface EvidenceBearing {
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

function carriesEvidence(value: unknown): value is EvidenceBearing {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as { evidence?: unknown }).evidence;
  return Array.isArray(candidate) && candidate.length > 0;
}

/**
 * Values that are *not* facts about the target.
 *
 * Kept deliberately short: an unanswered question is recorded precisely because
 * nobody observed an answer, so requiring evidence on it would be backwards.
 */
const NON_FACT_EXPORTS: readonly string[] = ["RUNTIME_CONTRACT_UNKNOWNS"];

/**
 * Values that restate an evidence-bearing record instead of carrying evidence
 * themselves, mapped to the record they are derived from.
 *
 * Derivation is the point: a second copy of "AntDesign" or of the base props key
 * list is a value that can drift from its own observation, so a derived value is
 * only acceptable while it is genuinely produced from the evidenced record.
 */
const DERIVED_EXPORTS: Readonly<Record<string, string>> = {
  CELL_PRESET_LIBRARY_DEFAULT: "CELL_PRESET_LIBRARIES",
  CELL_PROPS_BASE_KEYS: "CELL_PROPS_KEY_ORDER",
  CELL_FORGUNCY_PROP_KEYS: "CELL_FORGUNCY_FACADE",
  CELL_SERVER_COMMAND_RESULT_KEYS: "CELL_SERVER_COMMANDS_CONTRACT",
  FRONTEND_LIBRARY_REFERENCE_EXAMPLE: "FRONTEND_LIBRARY_REFERENCE_CONTRACT",
};

function isEvidenceBearingExport(name: string): boolean {
  const value = (contract as Record<string, unknown>)[name];
  if (carriesEvidence(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(carriesEvidence);
}

/** For the per-record assertions below: every fact record in the module. */
const FACT_RECORDS: readonly { readonly name: string; readonly evidence: readonly RuntimeEvidenceChannel[] }[] = [
  { name: "RUNTIME_CONTRACT_TARGET", evidence: RUNTIME_CONTRACT_TARGET.evidence },
  { name: "CELL_SOURCE_EXECUTION_MODEL", evidence: CELL_SOURCE_EXECUTION_MODEL.evidence },
  { name: "CELL_PROPS_KEY_ORDER", evidence: CELL_PROPS_KEY_ORDER.evidence },
  { name: "CELL_FORGUNCY_FACADE", evidence: CELL_FORGUNCY_FACADE.evidence },
  { name: "CELL_SERVER_COMMANDS_CONTRACT", evidence: CELL_SERVER_COMMANDS_CONTRACT.evidence },
  { name: "CELL_DATA_SOURCE_CONTRACT", evidence: CELL_DATA_SOURCE_CONTRACT.evidence },
  { name: "CELL_SOURCE_REJECTION_ENVELOPE", evidence: CELL_SOURCE_REJECTION_ENVELOPE.evidence },
  { name: "CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR", evidence: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.evidence },
  { name: "CELL_SOURCE_SIZE_OBSERVATIONS", evidence: CELL_SOURCE_SIZE_OBSERVATIONS.evidence },
  { name: "FRONTEND_LIBRARY_REFERENCE_CONTRACT", evidence: FRONTEND_LIBRARY_REFERENCE_CONTRACT.evidence },
  { name: "FRONTEND_LIBRARY_RUNTIME_SEMANTICS", evidence: FRONTEND_LIBRARY_RUNTIME_SEMANTICS.evidence },
  ...CELL_ENTRY_SHAPES.map(shape => ({ name: `CELL_ENTRY_SHAPES.${shape.id}`, evidence: shape.evidence })),
  ...CELL_ENTRY_RESOLUTION_ORDER.map(step => ({
    name: `CELL_ENTRY_RESOLUTION_ORDER.${step.order}`,
    evidence: step.evidence,
  })),
  ...CELL_HOST_RUNTIME_SEMANTICS.map(fact => ({
    name: `CELL_HOST_RUNTIME_SEMANTICS.${fact.id}`,
    evidence: fact.evidence,
  })),
  ...CELL_SOURCE_REJECTIONS.map(rejection => ({
    name: `CELL_SOURCE_REJECTIONS.${rejection.id}`,
    evidence: rejection.evidence,
  })),
  ...CELL_USER_SCOPE_BINDINGS.map(binding => ({
    name: `CELL_USER_SCOPE_BINDINGS.${binding.name}`,
    evidence: binding.evidence,
  })),
  ...CELL_PRESET_LIBRARIES.map(preset => ({
    name: `CELL_PRESET_LIBRARIES.${preset.name}`,
    evidence: preset.evidence,
  })),
];

describe("runtime contract target", () => {
  it("pins the exact product build the contract was established against", () => {
    expect(RUNTIME_CONTRACT_TARGET.productVersion).toBe("12.0.100.0");
    expect(RUNTIME_CONTRACT_TARGET.productBuild).toContain("12.0.100.0+");
    expect(RUNTIME_CONTRACT_TARGET.hostReactVersion).toBe("19.2.7");
    expect(RUNTIME_CONTRACT_TARGET.hostReactDomVersion).toBe(RUNTIME_CONTRACT_TARGET.hostReactVersion);
    expect(RUNTIME_CONTRACT_TARGET.browserTranspilerVersion).toBe("7.29.4");
  });

  it("is governed by the runtime contract decision", () => {
    expect(RUNTIME_CONTRACT_TARGET.decision).toBe(RUNTIME_CONTRACT_DECISION);
    expect(RUNTIME_CONTRACT_DECISION.issue).toBe(5);
    expect(RUNTIME_CONTRACT_DECISION_REFERENCE).toBe("#5");
    expect(citesDecision(RUNTIME_CONTRACT_TARGET.decision.url, RUNTIME_CONTRACT_DECISION)).toBe(true);
  });

  it("renders a header a report or PR body can carry", () => {
    const header = describeRuntimeContractTarget();
    expect(header).toContain("12.0.100.0");
    expect(header).toContain("19.2.7");
    expect(header).toContain("7.29.4");
  });
});

// The Issue's fifth acceptance criterion is "no claim relies solely on
// implementation guesses". The type system already forbids an `assumption`
// channel; the checks below assert the weaker runtime property that no recorded
// fact was left without one.
describe("evidence discipline", () => {
  it("gives every fact record at least one evidence channel", () => {
    for (const record of FACT_RECORDS) {
      expect(record.evidence.length, record.name).toBeGreaterThan(0);
    }
  });

  it("uses only known evidence channels", () => {
    for (const record of FACT_RECORDS) {
      for (const channel of record.evidence) {
        expect(EVIDENCE_CHANNELS, record.name).toContain(channel);
      }
    }
  });

  // The earlier version of this suite enumerated fact tables by hand, so a new
  // exported constant could be added with no provenance while the suite stayed
  // green. This walks the module namespace instead: every exported value has to
  // be evidence-bearing, registered as derived from something evidenced, or
  // explicitly declared non-factual.
  it("classifies every exported value", () => {
    const unclassified: string[] = [];
    let examined = 0;
    for (const [name, value] of Object.entries(contract as Record<string, unknown>)) {
      // Module-interop artifacts are not values this module chose to export.
      if (name === "__esModule" || name === "default") continue;
      if (typeof value === "function") continue;
      examined += 1;
      if (NON_FACT_EXPORTS.includes(name)) continue;
      if (name in DERIVED_EXPORTS) continue;

      if (Array.isArray(value)) {
        if (value.length === 0) unclassified.push(`${name} (empty list)`);
        else if (!value.every(carriesEvidence)) unclassified.push(`${name} (item without evidence)`);
        continue;
      }

      if (!carriesEvidence(value)) unclassified.push(`${name} (no evidence)`);
    }

    expect(
      unclassified,
      "An exported value must carry evidence, be registered in DERIVED_EXPORTS, or be declared non-factual.",
    ).toEqual([]);

    // Guard against a vacuous pass: if the namespace stopped being enumerable,
    // the loop above would examine nothing and still report success.
    expect(examined, "the guard must have inspected the module's exported values").toBeGreaterThan(15);
  });

  it("keeps every derived export attached to an evidenced record", () => {
    for (const [name, source] of Object.entries(DERIVED_EXPORTS)) {
      expect((contract as Record<string, unknown>)[name], `${name} must still be exported`).toBeDefined();
      expect((contract as Record<string, unknown>)[source], `${name} derives from ${source}`).toBeDefined();
      expect(isEvidenceBearingExport(source), `${name} derives from ${source}`).toBe(true);
    }
  });

  // `toBe`, not `toEqual`: proof of derivation is that the value *is* the record's
  // value, not a copy that happens to match today.
  it("derives the derived values instead of restating them", () => {
    expect(CELL_PRESET_LIBRARY_DEFAULT).toBe(persistedDefaultCellPreset().name);
    expect(CELL_PRESET_LIBRARY_DEFAULT).toBe(findCellPresetLibrary("AntDesign").name);
    expect(CELL_PROPS_BASE_KEYS).toBe(CELL_PROPS_KEY_ORDER.baseKeys);
    expect(CELL_FORGUNCY_PROP_KEYS).toBe(CELL_FORGUNCY_FACADE.keys);
    expect(CELL_SERVER_COMMAND_RESULT_KEYS).toBe(CELL_SERVER_COMMANDS_CONTRACT.resultKeys);
    expect(FRONTEND_LIBRARY_REFERENCE_EXAMPLE).toBe(FRONTEND_LIBRARY_REFERENCE_CONTRACT.example);
  });

  it("records the open questions rather than guessing them", () => {
    expect(RUNTIME_CONTRACT_UNKNOWNS.length).toBeGreaterThan(0);
    const ids = RUNTIME_CONTRACT_UNKNOWNS.map(unknown => unknown.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const unknown of RUNTIME_CONTRACT_UNKNOWNS) {
      expect(unknown.question.trim().length, unknown.id).toBeGreaterThan(0);
      expect(unknown.whyOpen.trim().length, unknown.id).toBeGreaterThan(0);
    }
  });

  it("lets a downstream Issue find the questions it owns", () => {
    const forBudget = openRuntimeContractQuestions("#21");
    expect(forBudget.map(unknown => unknown.id)).toContain("absolute-source-ceiling");
    expect(openRuntimeContractQuestions("#6").map(unknown => unknown.id)).toContain("property-change-re-render");
  });
});

// The multi-cell facts are a class of their own: they describe the page the cells
// share, not one cell's source, and they are what makes hooks and Context
// cell-local by construction rather than by convention.
describe("host runtime across cells", () => {
  it("records that the page has one React instance shared by every cell", () => {
    const fact = findCellHostRuntimeFact("single-react-instance-per-page");
    expect(fact.statement).toMatch(/one React instance/);
    expect(fact.evidence).toContain("generated-runtime-browser");
  });

  it("records the shared globalThis and the per-cell root", () => {
    expect(findCellHostRuntimeFact("shared-global-this").statement).toMatch(/share one globalThis/);
    expect(findCellHostRuntimeFact("one-react-root-per-cell").statement).toMatch(/its own ReactDOM root/);
  });

  it("states that React Context does not cross cell roots", () => {
    const fact = findCellHostRuntimeFact("context-does-not-cross-cells");
    expect(fact.statement).toMatch(/not visible to another cell/);
    // This one was only established in the browser: the source shows separate
    // roots, but the isolation itself was executed.
    expect(fact.evidence).toEqual(["generated-runtime-browser"]);
  });

  it("says cell initialisation order is not layout order", () => {
    expect(findCellHostRuntimeFact("initialisation-order-is-not-layout-order").statement).toMatch(
      /not the layout order/,
    );
  });

  it("gives every host runtime fact a way to be observed again", () => {
    expect(CELL_HOST_RUNTIME_SEMANTICS.length).toBeGreaterThanOrEqual(5);
    const ids = CELL_HOST_RUNTIME_SEMANTICS.map(fact => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fact of CELL_HOST_RUNTIME_SEMANTICS) {
      expect(fact.statement.trim().length, fact.id).toBeGreaterThan(0);
      expect(fact.howToObserve.trim().length, fact.id).toBeGreaterThan(0);
    }
  });

  // Source-only facts must not look like executed ones.
  it("marks the teardown fact as read rather than executed", () => {
    const fact = findCellHostRuntimeFact("unmount-clears-the-cell-root");
    expect(fact.evidence).toEqual(["product-runtime-source"]);
    expect(fact.howToObserve).toMatch(/Not executed/);
  });

  it("rejects unknown fact ids", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellHostRuntimeFact("not-a-fact")).toThrow(/Unknown ReactCellType host runtime fact/);
  });
});

describe("execution model", () => {
  it("transforms with the react preset only", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.transformPresets).toEqual(["react"]);
    expect(CELL_SOURCE_EXECUTION_MODEL.missingTransforms).toEqual(
      expect.arrayContaining(["typescript", "preset-env"]),
    );
  });

  // The parameter order is part of the contract: the runtime binds them
  // positionally, so a copied signature that reorders them still type-checks but
  // binds the wrong values.
  it("binds the host through the documented parameter order", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.injectedParameters).toEqual([
      "React",
      "antd",
      "echarts",
      "dayjs",
      "ForguncyReactHelper",
      "__useDataSource",
      "__props",
    ]);
  });

  it("keeps top-level declarations out of the page globals", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.perCellCompilationScope).toBe(true);
    expect(CELL_SOURCE_EXECUTION_MODEL.topLevelDeclarationsReachGlobalThis).toBe(false);
  });
});

describe("entry shapes", () => {
  it("never lets a generator emit a shape that validates but does not render", () => {
    const emittable = emitCellEntryShapes().map(shape => shape.id);
    expect(emittable).not.toContain("app-async-function-declaration");
    expect(emittable).not.toContain("no-entry");
    expect(emittable).toContain("app-function-declaration");
    expect(emittable).toContain("render-call");
  });

  it("names the accepted-but-broken async entry as the only write-time false pass", () => {
    expect(nonWorkingCellEntryShapes().map(shape => shape.id)).toEqual([
      "app-async-function-declaration",
      "no-entry",
    ]);

    // `no-entry` is not meant to render anything, so the interesting set is the
    // shapes that actually name an entry: exactly one of them is accepted and
    // still fails.
    const brokenEntries = nonWorkingCellEntryShapes().filter(shape => shape.id !== "no-entry");
    expect(brokenEntries.map(shape => shape.id)).toEqual(["app-async-function-declaration"]);
    expect(brokenEntries[0]?.note).toContain("#482");
  });

  it("flags the silent no-entry case", () => {
    const noEntry = findCellEntryShape("no-entry");
    expect(noEntry.acceptedAtWriteTime).toBe(true);
    expect(noEntry.renderedAtRuntime).toBe(false);
    expect(noEntry.note).toMatch(/silently/);
  });

  it("records resolution precedence in a contiguous order that starts at render(value)", () => {
    expect(CELL_ENTRY_RESOLUTION_ORDER.map(step => step.order)).toEqual([1, 2, 3, 4, 5]);
    expect(CELL_ENTRY_RESOLUTION_ORDER[0]?.mechanism).toContain("render(value)");
    expect(CELL_ENTRY_RESOLUTION_ORDER[1]?.mechanism).toContain("App");
    expect(CELL_ENTRY_RESOLUTION_ORDER.every(step => step.evidence.length > 0)).toBe(true);
  });

  it("rejects unknown entry shapes instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellEntryShape("not-a-shape")).toThrow(/Unknown ReactCellType entry shape/);
  });
});

describe("rejected source", () => {
  it("carries the platform's own wording for the fixed messages", () => {
    expect(findCellSourceRejection("import-declaration").message).toBe(
      "ReactCellType does not support import statements. Use the provided global variables instead.",
    );
    expect(findCellSourceRejection("export-declaration").message).toBe(
      "ReactCellType does not support export statements. Define App, element, or call render(value) instead.",
    );
    expect(findCellSourceRejection("react-use").message).toContain("React.use is not supported");
  });

  it("separates what the platform refuses from what only the bundler refuses", () => {
    const refusedIds = rejectedCellSourceConstructs().map(rejection => rejection.id);
    expect(refusedIds).toContain("import-declaration");
    expect(refusedIds).toContain("typescript-annotation");

    // The one record that describes a *non*-rejection must not be reported as one.
    const dynamicImport = findCellSourceRejection("runtime-import-call-not-rejected");
    expect(dynamicImport.rejected).toBe(false);
    expect(refusedIds).not.toContain(dynamicImport.id);
    expect(dynamicImport.note).toMatch(/bundler requirement/);
  });

  it("marks the parse-error messages as position-dependent samples", () => {
    for (const rejection of CELL_SOURCE_REJECTIONS) {
      expect(rejection.message.trim().length, rejection.id).toBeGreaterThan(0);
      if (rejection.stage === "babel") {
        expect(rejection.messageVaries, rejection.id).toBe(true);
      }
    }
  });

  it("documents the error envelope both validation passes surface through", () => {
    expect(CELL_SOURCE_REJECTION_ENVELOPE.template).toContain("ReactCellType 代码验证失败");
    expect(CELL_SOURCE_REJECTION_ENVELOPE.stageTags).toEqual(["preview", "babel"]);
  });

  it("rejects unknown rejection ids", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellSourceRejection("not-a-rejection")).toThrow(/Unknown ReactCellType source rejection/);
  });
});

describe("names visible inside a cell", () => {
  it("keeps the injected parameters distinguishable from window globals", () => {
    expect(cellUserScopeBinding("React")?.availableInCellSource).toBe("always");
    expect(cellUserScopeBinding("React")?.onWindow).toBe("always");

    // The runtime passes these as arguments, so they are usable but invisible on
    // `window`; reading them through `window` is a real failure mode.
    for (const name of ["ForguncyReactHelper", "props", "useDataSource", "render", "useState", "DataSourceCompareType"]) {
      expect(cellUserScopeBinding(name)?.onWindow, name).toBe("never");
    }
  });

  it("ties preset-provided names to the preset resolving first", () => {
    for (const name of ["antd", "dayjs", "echarts"]) {
      expect(cellUserScopeBinding(name)?.availableInCellSource, name).toBe(
        "after-the-declared-preset-resolves",
      );
    }
  });

  it("returns undefined for an unknown name rather than inventing a binding", () => {
    expect(cellUserScopeBinding("Reactify")).toBeUndefined();
    expect(cellUserScopeBinding("")).toBeUndefined();
  });
});

describe("preset libraries", () => {
  it("has exactly one persisted default, and it is the one that also loads dayjs", () => {
    const defaults = CELL_PRESET_LIBRARIES.filter(preset => preset.isPersistedDefault);
    expect(defaults.map(preset => preset.name)).toEqual([CELL_PRESET_LIBRARY_DEFAULT]);
    expect(defaults[0]?.providesGlobals).toEqual(["dayjs", "antd"]);
  });

  it("treats None as genuinely library-free", () => {
    expect(findCellPresetLibrary("None").providesGlobals).toEqual([]);
    expect(findCellPresetLibrary("None").scriptChain).toEqual([]);
  });

  it("loads ECharts through the runtime module loader, not a script URL", () => {
    const echarts = findCellPresetLibrary("ECharts");
    expect(echarts.runtimeModule).toBe("chart");
    expect(echarts.scriptChain).toEqual([]);
  });

  it("rejects unknown preset names", () => {
    // @ts-expect-error an unknown preset must not be accepted at the type level either
    expect(() => findCellPresetLibrary("Moment")).toThrow(/Unknown ReactCellType preset library/);
  });
});

describe("props and platform bridge", () => {
  it("records the base key order the runtime initialises props in", () => {
    expect(CELL_PROPS_BASE_KEYS).toEqual(["Forguncy", "Permissions", "ServerCommands", "ImageContext"]);
  });

  it("lists the Forguncy facade the target actually injects", () => {
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("hasPermission");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("ConvertDateToOADate");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("exposeMethod");
  });

  it("distinguishes an unconfigured server command from a failing one", () => {
    expect(CELL_SERVER_COMMAND_RESULT_KEYS).toEqual(["errorCode", "errorMessage"]);
    expect(CELL_SERVER_COMMANDS_CONTRACT.unconfiguredNameType).toBe("undefined");
    expect(CELL_SERVER_COMMANDS_CONTRACT.unconfiguredCallOutcome).toContain("is not a function");
  });

  it("treats an unknown data source as an error state rather than a throw", () => {
    expect(CELL_DATA_SOURCE_CONTRACT.unknownSourceOutcome).toMatch(/error state/);
    expect(CELL_DATA_SOURCE_CONTRACT.resultFieldsDocumented).toEqual(
      expect.arrayContaining(CELL_DATA_SOURCE_CONTRACT.resultFieldsExecuted),
    );
  });
});

describe("frontend libraries", () => {
  it("keeps only the per-cell readiness guarantee", () => {
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.perCellReadinessAwaited).toBe(true);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.loadOrderGuaranteed).toBe(false);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.crossCellReadinessGuaranteed).toBe(false);
  });

  it("states that extension globals are page-wide but bound per render instant", () => {
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.globalsArePageWide).toBe(true);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.presetGlobalsBoundPerRenderInstant).toBe(true);
  });

  it("carries the reference shape as data, not as prose", () => {
    expect(Object.keys(FRONTEND_LIBRARY_REFERENCE_EXAMPLE)).toEqual(["libraryId"]);
  });
});

describe("cell source size", () => {
  it("claims no hard limit, because none was found", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.hardCharacterLimit).toBeNull();
  });

  it("orders the two measurements so the notice threshold is bracketable", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeNotObservedAtCharacters).toBeLessThan(
      CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeObservedAtCharacters,
    );
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.largestAcceptedSourceCharacters).toBe(
      CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeObservedAtCharacters,
    );
  });

  // A budget that only produced a warning would be a style concern. It is
  // recorded as a gate because the project's acceptance check counts console
  // errors, and this notice is emitted at error level.
  it("records the transpiler notice at console error level", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeConsoleLevel).toBe("error");
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeMessage).toContain("500KB");
  });
});

describe("governing architecture decisions", () => {
  it("adds the runtime contract to the line a multi-Spec document carries", () => {
    expect(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5");
    expect(citesEveryArchitectureDecision(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE)).toBe(true);
    expect(citesDecision(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE, RUNTIME_CONTRACT_DECISION)).toBe(true);
  });

  // The module is the projection of Issue #5, so it has to be able to say which
  // decision it came from without a document.
  it("has a URL that reads back as a citation of this decision", () => {
    expect(citesDecision(RUNTIME_CONTRACT_DECISION.url, RUNTIME_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision(RUNTIME_CONTRACT_DECISION.url)).toBe(false);
  });
});
