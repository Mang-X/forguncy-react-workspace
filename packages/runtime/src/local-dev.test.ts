import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CELL_PROPS_BASE_KEYS,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  checksForLevel,
  citesDecision,
  DEPENDENCY_STRATEGIES,
  GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
  HOST_BRIDGE_MAPPINGS,
  hostBridgeInterceptedModuleIds,
  hostBridgeModuleIds,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";

import type { RuntimeFacadeHostBindings, RuntimeFacadeProvider } from "./contract";
import {
  assertLocalDevBoundariesAreAdmissible,
  assertLocalDevClaimsAreLocalOnly,
  assertLocalDevExtensionChoicesAreDeclared,
  assertLocalDevLoopStagesAreAdmissible,
  assertLocalDevMockSuppliesEveryBaseProp,
  assertLocalDevProviderIsMock,
  assertLocalDevResolutionsCoverHostBridge,
  assertLocalDevStrategyHandlingsCoverStrategies,
  auditLocalDevConfiguration,
  findLocalDevBoundaryForConcern,
  formatLocalDevValidationDistinction,
  LOCAL_DEV_BOUNDARIES,
  LOCAL_DEV_BOUNDARY_IDS,
  LOCAL_DEV_CLAIMS,
  LOCAL_DEV_CLAIM_IDS,
  LOCAL_DEV_CONTRACT_ERROR_CODES,
  LOCAL_DEV_DIAGNOSTIC_CODES,
  LOCAL_DEV_DIAGNOSTIC_RULES,
  LOCAL_DEV_ERROR_SURFACING,
  LOCAL_DEV_EXTENSION_CHOICE_MODES,
  LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS,
  LOCAL_DEV_FORBIDDEN_PATTERNS,
  LOCAL_DEV_FORBIDDEN_PATTERN_IDS,
  LOCAL_DEV_GOVERNING_DECISIONS,
  LOCAL_DEV_GOVERNING_SPEC_REFERENCE_LINE,
  LOCAL_DEV_HOST_MAPPING_SOURCE,
  LOCAL_DEV_HOST_RESOLUTION_MODEL,
  LOCAL_DEV_LOOP_STAGES,
  LOCAL_DEV_LOOP_STAGE_IDS,
  LOCAL_DEV_MODULE_RESOLUTIONS,
  LOCAL_DEV_MOCK_SURFACE,
  LOCAL_DEV_MOCK_SURFACE_SOURCE,
  LOCAL_DEV_NON_GOALS,
  LOCAL_DEV_STRATEGY_HANDLINGS,
  LOCAL_DEV_VERSION_FIELDS,
  LocalDevRuntimeContractError,
  localDevAlignmentChecks,
  localDevDeferredHostModules,
  localDevDischargeableChecks,
  localDevFailureContrast,
  localDevHandlingForStrategy,
  localDevModuleIdsOf,
  findLocalDevBridgeRow,
  findLocalDevModuleIdResolution,
  localDevExtensionChoiceProblem,
  localDevProtectedConcerns,
  localDevRealRuntimeOwedChecks,
  localDevRealRuntimeStage,
  localDevRecordedVersion,
  localDevResolvableModuleIds,
  localDevResolvedBridgeRows,
  localDevUnsupportedModuleIds,
} from "./local-dev";
import type {
  LocalDevBoundary,
  LocalDevClaim,
  LocalDevDiagnosticCode,
  LocalDevExtensionChoice,
  LocalDevExtensionRealRuntimeOnly,
  LocalDevLoopStage,
  LocalDevModuleResolution,
} from "./local-dev";
import {
  LOCAL_DEV_RUNTIME_CITATION_PATTERNS,
  LOCAL_DEV_RUNTIME_DECISION,
  LOCAL_DEV_RUNTIME_DECISION_QUALIFIED_REFERENCE,
  LOCAL_DEV_RUNTIME_DECISION_REFERENCE,
  RUNTIME_FACADE_DECISION,
} from "./provenance";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

/**
 * A mock built from `core`'s key list rather than from a hand-written literal.
 *
 * Same reasoning as `contract.test.ts`'s: deriving the members means a base prop
 * key #5 adds cannot leave the mock quietly behind the host surface, so the
 * `mock-surface-incomplete` cases exercise the rule rather than a fixture.
 */
function mockBindings(omit: readonly string[] = []): RuntimeFacadeHostBindings {
  const cellProps = Object.fromEntries(
    CELL_PROPS_BASE_KEYS.filter(key => !omit.includes(key)).map(key => [key, undefined] as const),
  );
  return {
    cellProps: cellProps as unknown as RuntimeFacadeHostBindings["cellProps"],
    useDataSource: name => ({
      data: [],
      totalCount: 0,
      loading: false,
      error: `Error: ReactCellType data source was not found: ${name}`,
    }),
  };
}

const extensionDecision: DependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "00000000-0000-0000-0000-000000000000",
  globalName: "TanStackQueryReact",
};

const tanstackSubstitute: LocalDevExtensionChoice = {
  packageName: "@tanstack/react-query",
  mode: "substitute",
  kind: "npm-package",
  resolvesTo: "@tanstack/react-query",
  justification: "Local UI work; the cross-cell singleton semantics are not exercised locally.",
};

/** The other branch #22 allows: the project accepts that validation happens on the page. */
const tanstackRealRuntimeOnly: LocalDevExtensionRealRuntimeOnly = {
  packageName: "@tanstack/react-query",
  mode: "real-runtime-only",
  reason: "the extension's cross-cell singleton is the whole reason it is an extension.",
  consequence: "local renders exercise the query client's local behaviour only.",
};

// #22's Problem section asks for a fast local loop "without pretending a simulator
// can fully replace real Forguncy validation". The stage list is that sentence as
// a data shape: exactly one stage may produce real-runtime evidence, and it is the
// last one, so the loop cannot terminate in a local claim.
describe("the local dev loop and its evidence levels", () => {
  it("records #22's workflow in order", () => {
    expect([...LOCAL_DEV_LOOP_STAGE_IDS]).toEqual([
      "edit-cell-source",
      "local-dev-server",
      "local-ui-feedback",
      "compile-artifact",
      "mcp-sync",
      "forguncy-page-validation",
    ]);
    expect(LOCAL_DEV_LOOP_STAGES.map(stage => stage.id)).toEqual([...LOCAL_DEV_LOOP_STAGE_IDS]);
  });

  it("marks every stage before the last as local evidence", () => {
    expect(() => assertLocalDevLoopStagesAreAdmissible()).not.toThrow();

    const realRuntime = LOCAL_DEV_LOOP_STAGES.filter(stage => stage.claimLevel === "real-runtime");
    expect(realRuntime).toHaveLength(1);
    expect(realRuntime[0]?.id).toBe("forguncy-page-validation");
    expect(localDevRealRuntimeStage().id).toBe("forguncy-page-validation");

    // The dev server is the stage a developer stares at all day, so it is the one
    // most likely to be over-read.
    expect(LOCAL_DEV_LOOP_STAGES.find(stage => stage.id === "local-dev-server")?.claimLevel).toBe("local");
  });

  it("states what each stage does not establish", () => {
    for (const stage of LOCAL_DEV_LOOP_STAGES) {
      expect(stage.establishes.trim().length, stage.id).toBeGreaterThan(20);
      expect(stage.doesNotEstablish.trim().length, stage.id).toBeGreaterThan(40);
    }
    // The two most load-bearing omissions: the dev server has no page, and a
    // source edit says nothing about the write-time validator.
    expect(
      LOCAL_DEV_LOOP_STAGES.find(stage => stage.id === "local-dev-server")?.doesNotEstablish,
    ).toMatch(/no page/);
    expect(
      LOCAL_DEV_LOOP_STAGES.find(stage => stage.id === "edit-cell-source")?.doesNotEstablish,
    ).toMatch(/import/);
  });

  it("names the owner of the evidence a real-runtime stage produces", () => {
    for (const stage of LOCAL_DEV_LOOP_STAGES.filter(
      candidate => candidate.claimLevel === "real-runtime",
    )) {
      expect(stage.evidenceOwner, stage.id).toBeDefined();
      expect(stage.evidenceOwner).toMatch(/#\d+/);
    }
  });

  // The failure this guard exists to catch: a stage list that closes the loop
  // locally and calls the last local step validation.
  it("refuses a list with no real-runtime stage", () => {
    const allLocal: LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES.map(stage => ({
      ...stage,
      claimLevel: "local",
    }));
    let caught: unknown;
    try {
      assertLocalDevLoopStagesAreAdmissible(allLocal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).code).toBe("loop-stage-not-admissible");
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/exactly one/i);
  });

  it("refuses a real-runtime stage that is not the last one", () => {
    const promoted: LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES.map(stage =>
      stage.id === "local-ui-feedback"
        ? { ...stage, claimLevel: "real-runtime", evidenceOwner: "#25" }
        : stage,
    );
    expect(() => assertLocalDevLoopStagesAreAdmissible(promoted)).toThrow(/exactly one/i);
  });

  it("refuses a real-runtime stage with no evidence owner", () => {
    const unowned: LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES.map(stage =>
      stage.id === "forguncy-page-validation" ? { ...stage, evidenceOwner: undefined } : stage,
    );
    expect(() => assertLocalDevLoopStagesAreAdmissible(unowned)).toThrow(/names no owner/);
  });
});

// #22's Non-responsibilities: six behaviours the harness must not claim. The two
// boundaries that protect no #4 concern are the ones this suite pins hardest,
// because "there is no #4 concern for this" and "nobody owns this" are different
// statements and only the first is a legitimate boundary.
describe("the emulator boundary", () => {
  it("records #22's non-responsibilities, one per bullet", () => {
    expect([...LOCAL_DEV_BOUNDARY_IDS]).toEqual([
      "no-project-routing-semantics",
      "no-page-lifecycle-fidelity",
      "no-permission-semantics",
      "no-extension-loader-fidelity",
      "no-designer-write-time-validation",
      "no-cross-cell-isolation-model",
    ]);
    expect(LOCAL_DEV_BOUNDARIES.map(boundary => boundary.id)).toEqual([...LOCAL_DEV_BOUNDARY_IDS]);
  });

  it("protects only concerns #4 assigned to Forguncy", () => {
    expect(() => assertLocalDevBoundariesAreAdmissible()).not.toThrow();
    for (const boundary of LOCAL_DEV_BOUNDARIES) {
      expect(boundary.why.trim().length, boundary.id).toBeGreaterThan(80);
    }
  });

  it("names an owner for the boundaries no #4 concern covers", () => {
    const unprotected = LOCAL_DEV_BOUNDARIES.filter(boundary => boundary.protects.length === 0);
    expect(unprotected.map(boundary => boundary.id)).toEqual([
      "no-extension-loader-fidelity",
      "no-designer-write-time-validation",
    ]);
    for (const boundary of unprotected) {
      expect(boundary.ownedBy, boundary.id).toBeDefined();
      expect(boundary.ownedBy, boundary.id).toMatch(/#\d+/);
    }
  });

  it("maps the concerns a local process could impersonate to their boundary", () => {
    expect(findLocalDevBoundaryForConcern("application-navigation")?.id).toBe(
      "no-project-routing-semantics",
    );
    expect(findLocalDevBoundaryForConcern("page-lifecycle")?.id).toBe("no-page-lifecycle-fidelity");
    expect(findLocalDevBoundaryForConcern("permissions")?.id).toBe("no-permission-semantics");
    expect(findLocalDevBoundaryForConcern("cross-cell-communication")?.id).toBe(
      "no-cross-cell-isolation-model",
    );
    expect(findLocalDevBoundaryForConcern("application-state")?.id).toBe("no-cross-cell-isolation-model");
    expect([...localDevProtectedConcerns()].sort()).toEqual([
      "application-navigation",
      "application-state",
      "cross-cell-communication",
      "page-lifecycle",
      "permissions",
    ]);
  });

  it("does not pretend a cell-owned concern is a boundary", () => {
    expect(findLocalDevBoundaryForConcern("cell-ui")).toBeUndefined();
    expect(findLocalDevBoundaryForConcern("cell-visualization")).toBeUndefined();
  });

  // The inversion #27's equivalent guard catches, in its local form: "the harness
  // does not manage animation" reads like a boundary but is a scope note.
  it("refuses a boundary that guards a concern the cell owns", () => {
    const inverted: LocalDevBoundary = {
      id: "no-project-routing-semantics",
      statement: "Keep rendering out of the harness.",
      protects: ["cell-animation"],
      why: "Animation is browser UI, so a cell should own it and the harness should not render it.",
      localBehaviour: "out-of-scope",
    };
    let caught: unknown;
    try {
      assertLocalDevBoundariesAreAdmissible([inverted]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).code).toBe("boundary-not-admissible");
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/assigns to the cell/);
  });

  it("refuses a boundary that protects nothing and names nobody", () => {
    const naked: LocalDevBoundary = {
      id: "no-permission-semantics",
      statement: "Ignore permissions.",
      protects: [],
      why: "Permissions are a host concern and the harness declines to model them at all.",
      localBehaviour: "mock-value-only",
    };
    expect(() => assertLocalDevBoundariesAreAdmissible([naked])).toThrow(/records an omission/);
  });

  // The sharpest local-versus-real gap, and the one that runs the opposite way to
  // the intuitive expectation: a local project is made of the very constructs the
  // designer refuses.
  it("records that a local pass is no evidence about designer acceptance", () => {
    const designer = LOCAL_DEV_BOUNDARIES.find(
      boundary => boundary.id === "no-designer-write-time-validation",
    );
    expect(designer?.localBehaviour).toBe("not-validated-locally");
    expect(designer?.statement).toBe("Exact designer/CodeEditor behavior.");
    expect(designer?.why).toMatch(/does not support import statements/);
    expect(designer?.why).toMatch(/it is no evidence/);
  });

  // Not a missing feature but a modelling hazard: two cells in one local tree make
  // Context cross them, which is the opposite of what #5 measured.
  it("records that two cells in one local root would model the opposite of the page", () => {
    const crossCell = LOCAL_DEV_BOUNDARIES.find(
      boundary => boundary.id === "no-cross-cell-isolation-model",
    );
    expect(crossCell?.localBehaviour).toBe("single-cell-only");
    expect(crossCell?.why).toMatch(/context-does-not-cross-cells/);
  });
});

// #22's third acceptance criterion: "host dependency mapping is reusable between
// compiler and dev runtime instead of maintaining two unrelated maps". One table,
// two projections — and nothing that runs the generated bridge module, because
// that module binds a page global and locally there is no page.
describe("host module resolution in local mode", () => {
  it("derives from the bridge table rather than keeping a second one", () => {
    expect(LOCAL_DEV_HOST_MAPPING_SOURCE).toBe("HOST_BRIDGE_MAPPINGS");
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.mapsFrom).toBe(LOCAL_DEV_HOST_MAPPING_SOURCE);
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.reusesTheHostBridgeMappingTable).toBe(true);
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.secondMappingTable).toBe(false);
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.runsGeneratedBridgeModules).toBe(false);
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.note).toMatch(/one table/);
  });

  it("covers every module id the bridge intercepts, and only those", () => {
    expect(() => assertLocalDevResolutionsCoverHostBridge()).not.toThrow();
    expect([...localDevResolvableModuleIds()].sort()).toEqual(
      [...hostBridgeInterceptedModuleIds()].sort(),
    );
    expect(localDevUnsupportedModuleIds()).toEqual([]);
    expect(localDevResolvedBridgeRows().map(row => row.specifier)).toEqual(
      LOCAL_DEV_MODULE_RESOLUTIONS.map(resolution => resolution.specifier),
    );
  });

  // The subpath is the half a hand-written table gets wrong: it rides on the
  // `react-dom` row, so deriving the ids from the table is what keeps it covered.
  it("takes each row's module ids from the table, including subpaths", () => {
    expect(localDevModuleIdsOf("react-dom")).toEqual(["react-dom", "react-dom/client"]);
    expect(localDevModuleIdsOf("react/jsx-runtime")).toEqual([
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ]);
    expect(localDevResolvableModuleIds()).toContain("react-dom/client");
    expect(localDevResolvableModuleIds()).toContain("react/jsx-dev-runtime");

    // The projection grew with the table rather than listing ids by hand: every id
    // of every covered row is resolvable, without this file naming any subpath.
    for (const mapping of localDevResolvedBridgeRows()) {
      for (const moduleId of hostBridgeModuleIds(mapping)) {
        expect(localDevResolvableModuleIds(), `${mapping.specifier}:${moduleId}`).toContain(moduleId);
      }
    }
  });

  it("refuses a resolution row for a module the bridge does not intercept", () => {
    let caught: unknown;
    try {
      localDevModuleIdsOf("react-dom/server");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).code).toBe("mapping-coverage");
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/not a row of the host bridge/);
  });

  // A module the artifact binds to a page global and the harness silently leaves
  // to the ordinary npm path is exactly the drift #22's third criterion forbids.
  it("refuses a projection that omits a bridged module id", () => {
    const withoutAntd = LOCAL_DEV_MODULE_RESOLUTIONS.filter(
      resolution => resolution.specifier !== "antd",
    );
    let caught: unknown;
    try {
      assertLocalDevResolutionsCoverHostBridge(withoutAntd);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/no row for it/);
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/antd/);
  });

  // The same specifier claimed twice: which package loads would depend on row
  // order, which is the collision half of the guard.
  it("refuses two resolutions for one module id", () => {
    const duplicated = [
      ...LOCAL_DEV_MODULE_RESOLUTIONS,
      {
        specifier: "react",
        resolution: "npm-package",
        localPackage: "react",
        alignmentUnchecked: "duplicated row used to exercise the collision half of the guard",
        note: "fixture",
      } satisfies LocalDevModuleResolution,
    ];
    let caught: unknown;
    try {
      assertLocalDevResolutionsCoverHostBridge(duplicated);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/more than one local resolution row/);
  });

  it("requires every row to say either what checks it or why nothing can", () => {
    const unchecked: LocalDevModuleResolution[] = [
      {
        specifier: "react",
        resolution: "npm-package",
        localPackage: "react",
        note: "fixture: neither a version field nor a reason, so it reads as verified",
      },
    ];
    expect(() => assertLocalDevResolutionsCoverHostBridge(unchecked)).toThrow(/reads as verified/);
  });

  it("requires a resolvable row to name a package", () => {
    const packageless: LocalDevModuleResolution[] = [
      { specifier: "react", resolution: "npm-package", alignmentUnchecked: "fixture", note: "fixture" },
    ];
    expect(() => assertLocalDevResolutionsCoverHostBridge(packageless)).toThrow(/nothing to resolve/);
  });

  // No version is stored in the resolution rows; every expected value is read off
  // #5's pinned target, so a row cannot carry a number that drifts from it.
  it("reads every expected version off the pinned target", () => {
    const alignment = localDevAlignmentChecks();
    expect(alignment.map(entry => `${entry.localPackage}:${entry.field}`)).toEqual([
      "react:hostReactVersion",
      "react-dom:hostReactDomVersion",
    ]);
    for (const entry of alignment) {
      expect(entry.expected, entry.localPackage).toBe(localDevRecordedVersion(entry.field));
    }
    expect(localDevRecordedVersion("hostReactVersion")).toBe(RUNTIME_CONTRACT_TARGET.hostReactVersion);
    expect(localDevRecordedVersion("hostReactDomVersion")).toBe(
      RUNTIME_CONTRACT_TARGET.hostReactDomVersion,
    );
    expect([...LOCAL_DEV_VERSION_FIELDS]).toEqual(["hostReactVersion", "hostReactDomVersion"]);
  });

  // The asymmetry worth recording: the local check is one field richer than #9's
  // lock, because the two ask different questions and only one involves a lock.
  it("checks ReactDOM's version locally even though the lock cannot", () => {
    const reactDom = LOCAL_DEV_MODULE_RESOLUTIONS.find(
      resolution => resolution.specifier === "react-dom",
    );
    expect(reactDom?.checkedVersionField).toBe("hostReactDomVersion");

    const bridgeRow = HOST_BRIDGE_MAPPINGS.find(mapping => mapping.specifier === "react-dom");
    expect(bridgeRow?.kind === "host-global" ? bridgeRow.identityField : undefined).toBeUndefined();
  });

  // Rows are keyed on a specifier, but a caller asks about module ids — and two of
  // the ids the bridge intercepts are not row specifiers at all, so a row-keyed
  // lookup would answer "no row" for them.
  it("answers per module id, including the ids that are not row specifiers", () => {
    for (const mapping of localDevResolvedBridgeRows()) {
      for (const moduleId of hostBridgeModuleIds(mapping)) {
        const found = findLocalDevModuleIdResolution(moduleId);
        expect(found?.specifier, moduleId).toBe(mapping.specifier);
        expect(found?.moduleId, moduleId).toBe(moduleId);
      }
    }

    expect(findLocalDevModuleIdResolution("react-dom/client")?.specifier).toBe("react-dom");
    expect(findLocalDevModuleIdResolution("react/jsx-dev-runtime")?.specifier).toBe(
      "react/jsx-runtime",
    );
    // A module the bridge does not intercept has no local resolution, and
    // `undefined` says so instead of meaning "npm will handle it".
    expect(findLocalDevModuleIdResolution("react-dom/server")).toBeUndefined();
    expect(findLocalDevModuleIdResolution("dayjs")).toBeUndefined();
  });

  it("uses the published JSX runtime locally and never the generated adapter", () => {
    for (const moduleId of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
      const found = findLocalDevModuleIdResolution(moduleId);
      expect(found?.resolution.localPackage, moduleId).toBe("react");
      expect(found?.resolution.note, moduleId).toMatch(/never #9's generated adapter/);
    }
    // Both runtime ids share one row, so the row is asked about by its first id.
    expect(LOCAL_DEV_HOST_RESOLUTION_MODEL.runsGeneratedBridgeModules).toBe(false);
  });

  // A substituted row whose version was never recorded says so rather than
  // implying a check that does not exist.
  it("records antd as uncheckable rather than inventing a version to compare with", () => {
    const antd = LOCAL_DEV_MODULE_RESOLUTIONS.find(resolution => resolution.specifier === "antd");
    expect(antd?.checkedVersionField).toBeUndefined();
    expect(antd?.alignmentUnchecked).toMatch(/recorded no version/);
    expect(localDevAlignmentChecks().map(entry => entry.localPackage)).not.toContain("antd");
    // And the reason it is worth knowing about: #5 measured the global as
    // conditionally present, so the local always-present package hides a branch.
    expect(antd?.note).toMatch(/conditionally\* present|conditionally present/);
  });

  // #9's deferred rows are absent from the projection on purpose, and the
  // consequence — a local import that works for a different reason than it will on
  // the page — is surfaced rather than left implicit.
  it("surfaces #9's deferred modules rather than projecting them", () => {
    const deferred = localDevDeferredHostModules();
    expect(deferred.map(module => module.specifier).sort()).toEqual(["dayjs", "echarts"]);
    expect(localDevResolvableModuleIds()).not.toContain("dayjs");

    const audit = auditLocalDevConfiguration({ referencedSpecifiers: ["dayjs"] });
    const finding = audit.diagnostics.find(
      diagnostic => diagnostic.code === "local-dev-deferred-host-module",
    );
    expect(finding?.subject).toBe("dayjs");
    expect(finding?.detail).toMatch(/ordinary npm path/);
  });

  it("does not project a deferred module for an unrelated reference", () => {
    const audit = auditLocalDevConfiguration({ referencedSpecifiers: ["@tanstack/react-query"] });
    expect(audit.diagnostics).toEqual([]);
  });
});

// #22's second acceptance criterion, and the half of it that is easy to get
// wrong: the mock must be neither narrower nor wider than the host.
describe("the mock host surface", () => {
  it("is #27's provider port rather than a harness-only vocabulary", () => {
    expect(LOCAL_DEV_MOCK_SURFACE_SOURCE).toBe("RuntimeFacadeHostBindings");
    expect(LOCAL_DEV_MOCK_SURFACE.source).toBe(LOCAL_DEV_MOCK_SURFACE_SOURCE);
    expect(LOCAL_DEV_MOCK_SURFACE.providerKind).toBe("mock");
    expect(LOCAL_DEV_MOCK_SURFACE.typedByTypeScript).toBe(true);
    expect([...LOCAL_DEV_MOCK_SURFACE.requiredCellPropKeys]).toEqual([...CELL_PROPS_BASE_KEYS]);
    expect(LOCAL_DEV_MOCK_SURFACE.serverCommandParametersDeclaredBy).toMatch(/ServerCommandBindings/);
  });

  it("accepts a mock that declares every prop the host always injects", () => {
    expect(Object.keys(mockBindings().cellProps).sort()).toEqual([...CELL_PROPS_BASE_KEYS].sort());
    expect(() => assertLocalDevMockSuppliesEveryBaseProp(mockBindings())).not.toThrow();
  });

  // A missing key is not a stricter mock: it is a cell reading `undefined` locally
  // and a value on the page.
  it("refuses a mock narrower than the host", () => {
    for (const key of CELL_PROPS_BASE_KEYS) {
      let caught: unknown;
      try {
        assertLocalDevMockSuppliesEveryBaseProp(mockBindings([key]));
      } catch (error) {
        caught = error;
      }
      expect(caught, key).toBeInstanceOf(LocalDevRuntimeContractError);
      expect((caught as LocalDevRuntimeContractError).code, key).toBe("mock-surface-incomplete");
      expect((caught as LocalDevRuntimeContractError).message, key).toContain(key);
    }
  });

  // A host provider reads bindings a live runtime injects, and `vp dev` is the
  // process that does not have one — so this is a category error, not a stricter
  // configuration, and the discriminant is the only thing that can tell them apart.
  it("refuses a host provider", () => {
    const host: RuntimeFacadeProvider = { kind: "host", bindings: mockBindings() };
    const mock: RuntimeFacadeProvider = { kind: "mock", bindings: mockBindings() };
    expect(() => assertLocalDevProviderIsMock(mock)).not.toThrow();

    let caught: unknown;
    try {
      assertLocalDevProviderIsMock(host);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).code).toBe("provider-is-not-a-mock");
    expect((caught as LocalDevRuntimeContractError).message).toMatch(/does not have one/);
  });
});

describe("dependency decisions under local development", () => {
  it("answers for every one of #4's strategies, exactly once", () => {
    expect(() => assertLocalDevStrategyHandlingsCoverStrategies()).not.toThrow();
    expect(LOCAL_DEV_STRATEGY_HANDLINGS.map(handling => handling.strategy)).toEqual([
      ...DEPENDENCY_STRATEGIES,
    ]);
    for (const strategy of DEPENDENCY_STRATEGIES) {
      expect(localDevHandlingForStrategy(strategy).strategy, strategy).toBe(strategy);
    }
  });

  it("refuses a list that has forgotten a strategy", () => {
    const withoutReplace = LOCAL_DEV_STRATEGY_HANDLINGS.filter(
      handling => handling.strategy !== "replace",
    );
    expect(() => assertLocalDevStrategyHandlingsCoverStrategies(withoutReplace)).toThrow(
      /have no local handling/,
    );
  });

  it("refuses two handlings for one strategy", () => {
    const duplicated = [...LOCAL_DEV_STRATEGY_HANDLINGS, LOCAL_DEV_STRATEGY_HANDLINGS[0]!];
    expect(() => assertLocalDevStrategyHandlingsCoverStrategies(duplicated)).toThrow(
      /more than one local handling/,
    );
  });

  // #22 names this requirement directly: an `extension` package needs an explicit
  // local shim/npm source, or it must be marked as requiring real-runtime
  // validation. Both branches are one field with two modes, so neither valid state
  // can be reported as the other.
  it("makes an extension dependency the project's decision, not the harness's", () => {
    const handling = localDevHandlingForStrategy("extension");
    expect(handling.localHandling).toBe("local-substitute-required");
    expect(handling.requiresFromTheProject).toMatch(/LocalDevExtensionChoice/);
    expect(handling.realRuntimeClaimedBy).toMatch(/#13/);
  });

  it("accepts the substitute branch and reports nothing for it", () => {
    const audit = auditLocalDevConfiguration({
      decisions: [extensionDecision],
      extensionChoices: [tanstackSubstitute],
    });
    expect(audit.diagnostics).toEqual([]);
    expect(audit.realRuntimeOnly).toEqual([]);
  });

  // The branch that used to be unrepresentable: recording the choice does not make
  // it an omission, and the finding says which packages the loop cannot exercise.
  it("accepts the real-runtime-only branch as a decision rather than an omission", () => {
    const audit = auditLocalDevConfiguration({
      decisions: [extensionDecision],
      extensionChoices: [tanstackRealRuntimeOnly],
    });

    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-extension-real-runtime-only");
    expect(codes).not.toContain("local-dev-extension-needs-substitute");
    expect(audit.realRuntimeOnly).toEqual(["@tanstack/react-query"]);

    const finding = audit.diagnostics.find(
      diagnostic => diagnostic.code === "local-dev-extension-real-runtime-only",
    );
    expect(finding?.subject).toBe("@tanstack/react-query");
    expect(finding?.detail).toContain(tanstackRealRuntimeOnly.reason);
    expect(finding?.detail).toContain(tanstackRealRuntimeOnly.consequence);

    // Non-blocking, and that is the difference the second branch exists to make.
    expect(LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-extension-real-runtime-only"].blocksLocalDevelopment).toBe(
      false,
    );
    expect(LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-extension-needs-substitute"].blocksLocalDevelopment).toBe(
      true,
    );
  });

  it("reports an undeclared extension dependency as an omission", () => {
    const audit = auditLocalDevConfiguration({ decisions: [extensionDecision] });
    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-extension-needs-substitute");
    expect(codes).not.toContain("local-dev-extension-real-runtime-only");
    expect(audit.realRuntimeOnly).toEqual([]);
  });

  it("records both modes, and only two", () => {
    expect([...LOCAL_DEV_EXTENSION_CHOICE_MODES]).toEqual(["substitute", "real-runtime-only"]);
  });

  // A mode name with nothing behind it is still an omission. Otherwise the fix for
  // "the second branch is unrepresentable" would be a branch that is representable
  // and empty.
  it("does not let an empty acknowledgement count as a decision", () => {
    const empty: LocalDevExtensionRealRuntimeOnly = {
      packageName: "@tanstack/react-query",
      mode: "real-runtime-only",
      reason: "   ",
      consequence: "local renders exercise less.",
    };
    expect(localDevExtensionChoiceProblem(empty)).toMatch(/gives no reason/);
    expect(() => assertLocalDevExtensionChoicesAreDeclared([empty])).toThrow(/is not a decision/);

    const audit = auditLocalDevConfiguration({
      decisions: [extensionDecision],
      extensionChoices: [empty],
    });

    // One finding for one mistake. The entry is reported as malformed on its own
    // terms — the fix is to fill in the missing reason — and the decision-level
    // "no choice is declared" is suppressed, because both findings would point at
    // the same empty field with the same fix.
    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-extension-choice-malformed");
    expect(codes).not.toContain("local-dev-extension-needs-substitute");

    const finding = audit.diagnostics.find(
      diagnostic => diagnostic.code === "local-dev-extension-choice-malformed",
    );
    expect(finding?.subject).toBe("@tanstack/react-query");
    expect(finding?.detail).toMatch(/gives no reason/);
    expect(audit.realRuntimeOnly).toEqual([]);
  });

  it("requires an acknowledgement to say what it leaves unexercised", () => {
    const noConsequence: LocalDevExtensionChoice = {
      packageName: "@tanstack/react-query",
      mode: "real-runtime-only",
      reason: "no local equivalent.",
      consequence: "",
    };
    expect(localDevExtensionChoiceProblem(noConsequence)).toMatch(/states no consequence/);
  });

  it("requires a substitute to say what it resolves to and why it is acceptable", () => {
    for (const broken of [
      { ...tanstackSubstitute, resolvesTo: "" },
      { ...tanstackSubstitute, justification: "" },
      { ...tanstackSubstitute, packageName: "" },
    ]) {
      expect(localDevExtensionChoiceProblem(broken), JSON.stringify(broken)).toBeDefined();
      expect(() => assertLocalDevExtensionChoicesAreDeclared([broken])).toThrow(
        LocalDevRuntimeContractError,
      );
    }
    expect(() => assertLocalDevExtensionChoicesAreDeclared([tanstackSubstitute])).not.toThrow();
    expect(localDevExtensionChoiceProblem(tanstackSubstitute)).toBeUndefined();
    expect(localDevExtensionChoiceProblem(tanstackRealRuntimeOnly)).toBeUndefined();
  });

  it("records the two substitute kinds, and only two", () => {
    expect([...LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS]).toEqual(["npm-package", "project-shim"]);
    expect(
      localDevExtensionChoiceProblem({ ...tanstackSubstitute, kind: "project-shim" }),
    ).toBeUndefined();
  });

  // The re-review's second finding: the validator claimed the untyped-JSON boundary
  // while reading `.trim()` off members it had not checked, so a value that was not a
  // string threw a `TypeError` instead of becoming a configuration finding. Every
  // case below reached the old version that way — a `null` entry, a numeric
  // `packageName`, a missing `mode` — and the promise being made is about the whole
  // list, not only the entries that happen to be shaped right.
  it("answers for a value that is not a choice at all, instead of throwing", () => {
    for (const garbage of [
      null,
      undefined,
      42,
      "substitute",
      [],
      {},
      { mode: "substitute", kind: "npm-package", resolvesTo: "x", justification: "y" },
      { packageName: 42, mode: "substitute", kind: "npm-package", resolvesTo: "x", justification: "y" },
      { packageName: "pkg" },
      { packageName: "pkg", mode: 7 },
      { packageName: "pkg", mode: "substitute", kind: 7 },
    ]) {
      expect(() => localDevExtensionChoiceProblem(garbage), JSON.stringify(garbage)).not.toThrow();
      expect(localDevExtensionChoiceProblem(garbage), JSON.stringify(garbage)).toBeDefined();
    }
  });

  it("validates the whole substitute shape, including the kind", () => {
    // `mode` was checked at runtime; `kind` was not, so a substitute with a kind
    // #22 never allowed passed as a decision.
    expect(localDevExtensionChoiceProblem({ ...tanstackSubstitute, kind: "webpack-alias" })).toMatch(
      /substitute kind/,
    );
    expect(localDevExtensionChoiceProblem({ ...tanstackSubstitute, kind: 7 })).toMatch(
      /substitute kind/,
    );

    // A non-string where a string is required is a finding, not a `TypeError`.
    expect(localDevExtensionChoiceProblem({ ...tanstackSubstitute, resolvesTo: 42 })).toMatch(
      /names nothing to resolve to/,
    );
    expect(localDevExtensionChoiceProblem({ ...tanstackSubstitute, justification: null })).toMatch(
      /gives no justification/,
    );
    expect(localDevExtensionChoiceProblem({ ...tanstackRealRuntimeOnly, reason: [] })).toMatch(
      /gives no reason/,
    );
    expect(localDevExtensionChoiceProblem({ ...tanstackRealRuntimeOnly, consequence: 3 })).toMatch(
      /states no consequence/,
    );
  });

  it("turns a malformed entry into a finding even when no decision list was supplied", () => {
    // The list is audited on its own. A caller who supplied choices but not decisions
    // still hears about an entry that is not a choice, and the audit does not need a
    // decision to notice.
    for (const garbage of [null, 42, { packageName: "pkg", mode: "substitute" }]) {
      const choices = [garbage as unknown as LocalDevExtensionChoice];
      expect(() => auditLocalDevConfiguration({ extensionChoices: choices })).not.toThrow();
      expect(
        auditLocalDevConfiguration({ extensionChoices: choices }).diagnostics.map(
          diagnostic => diagnostic.code,
        ),
        JSON.stringify(garbage),
      ).toEqual(["local-dev-extension-choice-malformed"]);
    }
  });

  it("names an entry it cannot name, rather than throwing on the name", () => {
    const audit = auditLocalDevConfiguration({
      extensionChoices: [null as unknown as LocalDevExtensionChoice],
    });
    expect(audit.diagnostics[0]?.subject).toBe("(an unnamed extension choice)");
  });

  it("refuses the guard a value that is not a choice, as a contract error", () => {
    for (const garbage of [null, 42, { packageName: "pkg" }]) {
      let caught: unknown;
      try {
        assertLocalDevExtensionChoicesAreDeclared([garbage as unknown as LocalDevExtensionChoice]);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(garbage)).toBeInstanceOf(LocalDevRuntimeContractError);
    }
  });

  // A mode the union does not have reaches here from untyped data (a JSON config),
  // and falling off the switch would read as "this choice is fine".
  it("does not let an unknown mode pass as a decision", () => {
    const alien = {
      packageName: "@tanstack/react-query",
      mode: "ignore-for-now",
    } as unknown as LocalDevExtensionChoice;

    expect(localDevExtensionChoiceProblem(alien)).toMatch(/not one of the two branches/);
    expect(() => assertLocalDevExtensionChoicesAreDeclared([alien])).toThrow(/is not a decision/);

    const audit = auditLocalDevConfiguration({
      decisions: [extensionDecision],
      extensionChoices: [alien],
    });
    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-extension-choice-malformed");
    expect(codes).not.toContain("local-dev-extension-needs-substitute");
    expect(audit.realRuntimeOnly).toEqual([]);
  });

  // The re-review's first finding. Each entry was individually valid, so a map keyed
  // on the package name held them last-write-wins and reversing the array moved the
  // package between the two branches. A decision that a reordering can reverse is not
  // a decision, so the pair is refused rather than resolved.
  it("refuses two choices for one package instead of letting the order pick a branch", () => {
    const conflict = [tanstackSubstitute, tanstackRealRuntimeOnly];
    const reversed = [...conflict].reverse();

    for (const choices of [conflict, reversed]) {
      const audit = auditLocalDevConfiguration({
        decisions: [extensionDecision],
        extensionChoices: choices,
      });
      const codes = audit.diagnostics.map(diagnostic => diagnostic.code);

      expect(codes).toContain("local-dev-extension-choice-duplicated");
      // Neither branch is selected, which is what makes the order irrelevant.
      expect(audit.realRuntimeOnly).toEqual([]);
      expect(codes).not.toContain("local-dev-extension-real-runtime-only");
      // And one finding for the one mistake, not a second "nothing is declared".
      expect(codes).not.toContain("local-dev-extension-needs-substitute");
    }

    // The report is identical in both orders — the property that was missing, since
    // order-dependence was the whole of "last write wins".
    const report = (choices: LocalDevExtensionChoice[]): string[] =>
      auditLocalDevConfiguration({ decisions: [extensionDecision], extensionChoices: choices })
        .diagnostics.map(diagnostic => `${diagnostic.code}:${diagnostic.subject}`)
        .sort();
    expect(report(conflict)).toEqual(report(reversed));
  });

  it("refuses a package named twice even when both entries pick the same branch", () => {
    // Uniqueness is not about the two entries disagreeing: a second entry is not a
    // second decision either way, and the check does not need a decision list to run.
    const audit = auditLocalDevConfiguration({
      extensionChoices: [tanstackSubstitute, { ...tanstackSubstitute }],
    });
    expect(audit.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "local-dev-extension-choice-duplicated",
    ]);
  });

  it("refuses duplicates in the guard too, not only in the audit", () => {
    expect(() =>
      assertLocalDevExtensionChoicesAreDeclared([tanstackSubstitute, tanstackRealRuntimeOnly]),
    ).toThrow(/more than one local choice/);

    let caught: unknown;
    try {
      assertLocalDevExtensionChoicesAreDeclared([tanstackSubstitute, tanstackRealRuntimeOnly]);
    } catch (error) {
      caught = error;
    }
    expect((caught as LocalDevRuntimeContractError).code).toBe("extension-choice-duplicated");
    // A single choice for a package is still accepted, so the guard has not simply
    // become stricter about everything.
    expect(() => assertLocalDevExtensionChoicesAreDeclared([tanstackSubstitute])).not.toThrow();
  });

  it("claims the inline strategy as the strongest local case", () => {
    expect(localDevHandlingForStrategy("inline").localHandling).toBe("bundled-verbatim");
    expect(localDevHandlingForStrategy("inline").localClaim).toMatch(/strongest/);
  });
});

describe("error surfacing", () => {
  it("leaves errors to the browser's and Vite's own tooling", () => {
    expect(LOCAL_DEV_ERROR_SURFACING.installsErrorBoundary).toBe(false);
    expect(LOCAL_DEV_ERROR_SURFACING.catchesCellErrors).toBe(false);
    expect([...LOCAL_DEV_ERROR_SURFACING.surfaces]).toContain("vite-hmr-overlay");
    expect([...LOCAL_DEV_ERROR_SURFACING.surfaces]).toContain("uncaught-render-error");
  });

  // The contrast is read off `core` rather than paraphrased, so the two halves
  // cannot be described correctly in one place and incorrectly in another.
  it("contrasts with production without modelling it", () => {
    expect(LOCAL_DEV_ERROR_SURFACING.forguncyBehaviour).toBe(
      CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior,
    );
    expect(LOCAL_DEV_ERROR_SURFACING.forguncyRendersErrorTextInCell).toBe(false);

    const contrast = localDevFailureContrast();
    expect(contrast.forguncy).toBe(CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior);
    expect(contrast.local).toMatch(/never converted into a rendered fallback/);
  });
});

// The mechanism that keeps "local green" from being reported as compatibility:
// the level is a literal type, so a real-runtime claim is not merely discouraged —
// it does not type-check.
describe("what the local loop establishes", () => {
  it("records its claims in order", () => {
    expect([...LOCAL_DEV_CLAIM_IDS]).toEqual([
      "cell-source-mounts-unmodified",
      "cell-ui-renders",
      "hmr-round-trip",
      "repo-checks-pass",
      "dependency-substitutions-resolve",
    ]);
    expect(LOCAL_DEV_CLAIMS.map(claim => claim.id)).toEqual([...LOCAL_DEV_CLAIM_IDS]);
    expect(() => assertLocalDevClaimsAreLocalOnly()).not.toThrow();
  });

  it("makes a real-runtime claim unrepresentable", () => {
    const claim: LocalDevClaim = {
      id: "cell-ui-renders",
      statement: "The cell renders.",
      level: "local",
      doesNotEstablish: "That it renders in a cell.",
      realRuntimeOwner: "#20",
    };
    // @ts-expect-error the local loop produces local evidence only
    const promoted: LocalDevClaim = { ...claim, level: "real-runtime" };
    expect(promoted.level).toBe("real-runtime");

    // And the guard catches one that arrived from untyped code anyway.
    let caught: unknown;
    try {
      assertLocalDevClaimsAreLocalOnly([promoted]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LocalDevRuntimeContractError);
    expect((caught as LocalDevRuntimeContractError).code).toBe("claim-not-local");
  });

  it("says what each claim fails to establish", () => {
    for (const claim of LOCAL_DEV_CLAIMS) {
      expect(claim.doesNotEstablish.trim().length, claim.id).toBeGreaterThan(40);
      expect(claim.realRuntimeOwner.trim().length, claim.id).toBeGreaterThan(3);
    }
    expect(
      LOCAL_DEV_CLAIMS.find(claim => claim.id === "cell-source-mounts-unmodified")?.doesNotEstablish,
    ).toMatch(/validator/);
  });

  // Derived from #4's own tables, so the list cannot be a second copy that drifts:
  // every strategy's real-runtime checks appear, and every local check is reported
  // as dischargeable rather than silently dropped.
  it("reads the owed checks from #4's strategy table", () => {
    const owed = localDevRealRuntimeOwedChecks();
    for (const strategy of DEPENDENCY_STRATEGIES) {
      expect(owed.filter(entry => entry.strategy === strategy), strategy).toHaveLength(
        checksForLevel(strategy, "real-runtime").length,
      );
      expect(
        owed.filter(entry => entry.strategy === strategy).map(entry => entry.check),
        strategy,
      ).toEqual(checksForLevel(strategy, "real-runtime").map(check => check.description));
      expect(localDevDischargeableChecks(strategy), strategy).toEqual(
        checksForLevel(strategy, "local").map(check => check.description),
      );
    }
    expect(owed.length).toBeGreaterThan(0);
  });

  // #22's fifth acceptance criterion, in the form a report can print.
  it("prints the local-versus-real distinction", () => {
    const text = formatLocalDevValidationDistinction();
    expect(text).toMatch(/produces `local` evidence only/);
    expect(text).toMatch(/Still owed to a real Forguncy page/);
    for (const claim of LOCAL_DEV_CLAIMS) {
      expect(text, claim.id).toContain(claim.statement);
    }
    for (const entry of localDevRealRuntimeOwedChecks()) {
      expect(text, entry.check).toContain(entry.check);
    }
    expect(text).not.toMatch(/compatibility is|validated the target|verified on the target/i);
  });
});

// Every code in the vocabulary has to be reachable, or the vocabulary reads as
// covering a question nobody actually checks (#12's review finding).
describe("the diagnostic vocabulary", () => {
  it("gives every code a rule with a fix owner and a blocking verdict", () => {
    expect(Object.keys(LOCAL_DEV_DIAGNOSTIC_RULES).sort()).toEqual(
      [...LOCAL_DEV_DIAGNOSTIC_CODES].sort(),
    );
    for (const code of LOCAL_DEV_DIAGNOSTIC_CODES) {
      const rule = LOCAL_DEV_DIAGNOSTIC_RULES[code];
      expect(rule.code, code).toBe(code);
      expect(rule.label.trim().length, code).toBeGreaterThan(10);
      expect(rule.states.trim().length, code).toBeGreaterThan(10);
      expect(rule.remediation.trim().length, code).toBeGreaterThan(60);
      expect(typeof rule.blocksLocalDevelopment, code).toBe("boolean");
    }
  });

  it("has a producing path for every declared code", () => {
    const produced = new Set<LocalDevDiagnosticCode>();

    for (const audit of [
      auditLocalDevConfiguration({ installedVersions: { react: "18.2.0" } }),
      auditLocalDevConfiguration({ decisions: [extensionDecision] }),
      auditLocalDevConfiguration({
        decisions: [extensionDecision],
        extensionChoices: [tanstackRealRuntimeOnly],
      }),
      // A declared entry that is not a decision, and a package that carries two.
      auditLocalDevConfiguration({
        extensionChoices: [null as unknown as LocalDevExtensionChoice],
      }),
      auditLocalDevConfiguration({
        extensionChoices: [tanstackSubstitute, tanstackRealRuntimeOnly],
      }),
      auditLocalDevConfiguration({ mockBindings: mockBindings(["Permissions"]) }),
      auditLocalDevConfiguration({ referencedSpecifiers: ["dayjs"] }),
      // A row the project cannot stand in for locally.
      auditLocalDevConfiguration({
        resolutions: [
          {
            specifier: "react",
            resolution: "unsupported",
            alignmentUnchecked: "no local stand-in for this fixture",
            note: "fixture: a row the project cannot stand in for locally",
          },
          ...LOCAL_DEV_MODULE_RESOLUTIONS.filter(resolution => resolution.specifier !== "react"),
        ],
      }),
      // A projection that has drifted from the table.
      auditLocalDevConfiguration({
        resolutions: LOCAL_DEV_MODULE_RESOLUTIONS.filter(
          resolution => resolution.specifier !== "antd",
        ),
      }),
    ]) {
      for (const diagnostic of audit.diagnostics) produced.add(diagnostic.code);
    }

    for (const code of LOCAL_DEV_DIAGNOSTIC_CODES) {
      expect(produced.has(code), code).toBe(true);
    }
  });

  it("carries a structured finding, not only a message", () => {
    const audit = auditLocalDevConfiguration({ installedVersions: { react: "19.0.0" } });
    const mismatch = audit.diagnostics.find(
      diagnostic => diagnostic.code === "local-dev-host-version-mismatch",
    );
    expect(mismatch?.subject).toBe("react");
    expect(mismatch?.detail).toContain("19.0.0");
    expect(mismatch?.detail).toContain(localDevRecordedVersion("hostReactVersion"));
    expect(LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-host-version-mismatch"].blocksLocalDevelopment).toBe(
      false,
    );
  });

  it("ignores a version the project installed at the recorded one", () => {
    const audit = auditLocalDevConfiguration({
      installedVersions: {
        react: localDevRecordedVersion("hostReactVersion"),
        "react-dom": localDevRecordedVersion("hostReactDomVersion"),
      },
    });
    expect(audit.diagnostics).toEqual([]);
  });

  it("abstains rather than reporting a clean result for a question it did not ask", () => {
    // No `installedVersions` means "the caller did not say", not "the versions are
    // fine" — so nothing is reported, while the alignment expectations the caller
    // would need are still handed over.
    const audit = auditLocalDevConfiguration();
    expect(audit.diagnostics).toEqual([]);
    expect(audit.alignment).toHaveLength(2);
    expect(audit.owed.length).toBeGreaterThan(0);
  });

  it("converts a table guard into a finding instead of abandoning the audit", () => {
    const audit = auditLocalDevConfiguration({
      resolutions: LOCAL_DEV_MODULE_RESOLUTIONS.filter(
        resolution => resolution.specifier !== "antd",
      ),
      decisions: [extensionDecision],
    });
    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-mapping-coverage");
    // The rest of the audit still ran.
    expect(codes).toContain("local-dev-extension-needs-substitute");
  });

  // The direction the first version of this suite missed: an *orphan* resolution row
  // trips the guard via `localDevModuleIdsOf`, and the derivations that run after the
  // guard used to throw on the same input — so a configuration error produced a stack
  // trace instead of the diagnostic that had just been constructed for it.
  const orphanRow: LocalDevModuleResolution = {
    specifier: "react-dom/server",
    resolution: "npm-package",
    localPackage: "react-dom",
    alignmentUnchecked: "fixture: a row whose specifier is not a bridge row",
    note: "fixture orphan",
  };

  it("returns a finding for an orphan resolution row instead of throwing after the guard", () => {
    const resolutions = [...LOCAL_DEV_MODULE_RESOLUTIONS, orphanRow];
    expect(() => auditLocalDevConfiguration({ resolutions })).not.toThrow();

    const audit = auditLocalDevConfiguration({ resolutions });
    const finding = audit.diagnostics.find(
      diagnostic => diagnostic.code === "local-dev-mapping-coverage",
    );
    expect(finding?.detail).toMatch(/react-dom\/server/);
    // An orphan row contributes no module id to the harness's worklist: it resolves
    // nothing, and `local-dev-mapping-coverage` is what says so.
    expect(audit.resolvable).not.toContain("react-dom/server");
    expect([...audit.resolvable].sort()).toEqual([...hostBridgeInterceptedModuleIds()].sort());
  });

  it("leaves the throwing guard intact for callers that want the failure", () => {
    expect(() =>
      assertLocalDevResolutionsCoverHostBridge([...LOCAL_DEV_MODULE_RESOLUTIONS, orphanRow]),
    ).toThrow(/not a row of the host bridge/);
  });

  // The promise is about the whole function, not only the guards it calls on purpose.
  //
  // The re-review's note on the previous version of this test: it already passed two
  // choices for one package and asserted only "does not throw", so it exercised the
  // order-dependent duplicate without noticing it. Asserting the findings here is what
  // turns the sweep into a check rather than a demonstration.
  it("never throws, whatever the configuration — and still reports what it found", () => {
    const brokenAtOnce: LocalDevModuleResolution[] = [
      ...LOCAL_DEV_MODULE_RESOLUTIONS.filter(resolution => resolution.specifier !== "antd"),
      orphanRow,
      orphanRow,
    ];

    const everythingWrong = {
      resolutions: brokenAtOnce,
      decisions: [extensionDecision],
      extensionChoices: [
        tanstackSubstitute,
        tanstackRealRuntimeOnly,
        null as unknown as LocalDevExtensionChoice,
      ],
      installedVersions: { react: "0.0.0" },
      mockBindings: mockBindings(["Permissions"]),
      referencedSpecifiers: ["dayjs", "echarts", "unmapped"],
    };
    const run = () => auditLocalDevConfiguration(everythingWrong);
    expect(run).not.toThrow();

    const audit = run();
    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("local-dev-mapping-coverage");
    expect(codes).toContain("local-dev-extension-choice-duplicated");
    expect(codes).toContain("local-dev-extension-choice-malformed");
    // Neither extension branch was selected, so no part of the result depends on the
    // order the choices arrived in.
    expect(audit.realRuntimeOnly).toEqual([]);
  });

  it("reads a bridge row without throwing, unlike the guard-facing accessor", () => {
    expect(findLocalDevBridgeRow("react-dom")?.specifier).toBe("react-dom");
    expect(findLocalDevBridgeRow("react-dom/server")).toBeUndefined();
  });
});

describe("authoring patterns the local loop must not reward", () => {
  it("records exactly the five patterns, in order", () => {
    expect([...LOCAL_DEV_FORBIDDEN_PATTERN_IDS]).toEqual([
      "local-only-source-branch",
      "global-installed-for-convenience",
      "mock-wider-than-the-host",
      "swallowed-render-error",
      "second-local-component",
    ]);
    expect(LOCAL_DEV_FORBIDDEN_PATTERNS.map(pattern => pattern.id)).toEqual([
      ...LOCAL_DEV_FORBIDDEN_PATTERN_IDS,
    ]);
  });

  it("gives every pattern something to look for and something to use instead", () => {
    for (const pattern of LOCAL_DEV_FORBIDDEN_PATTERNS) {
      expect(pattern.lookFor.trim().length, pattern.id).toBeGreaterThan(20);
      expect(pattern.reason.trim().length, pattern.id).toBeGreaterThan(60);
      expect(pattern.use.trim().length, pattern.id).toBeGreaterThan(20);
    }
  });

  it("explains the global-installing pattern by its nastier half", () => {
    const globals = LOCAL_DEV_FORBIDDEN_PATTERNS.find(
      pattern => pattern.id === "global-installed-for-convenience",
    );
    expect(globals?.reason).toMatch(/ForguncyReactHelper/);
    expect(globals?.reason).toMatch(/binds module ids, not globals/);
  });

  it("ties the swallowed-error pattern back to #22's fourth acceptance criterion", () => {
    const swallowed = LOCAL_DEV_FORBIDDEN_PATTERNS.find(
      pattern => pattern.id === "swallowed-render-error",
    );
    expect(swallowed?.reason).toMatch(/renders `null`/);
    expect(swallowed?.use).toMatch(/LOCAL_DEV_ERROR_SURFACING/);
  });

  it("records #22's non-goals", () => {
    expect(LOCAL_DEV_NON_GOALS.length).toBeGreaterThanOrEqual(4);
    expect(LOCAL_DEV_NON_GOALS.join("\n")).toMatch(/#25/);
    expect(LOCAL_DEV_NON_GOALS.join("\n")).toMatch(/host bridge/);
  });

  it("keeps the contract error codes and the diagnostic codes in separate namespaces", () => {
    for (const code of LOCAL_DEV_DIAGNOSTIC_CODES) {
      expect(LOCAL_DEV_CONTRACT_ERROR_CODES as readonly string[], code).not.toContain(code);
    }
  });
});

describe("local dev decision provenance", () => {
  it("points at Issue #22 as the governing Spec", () => {
    expect(LOCAL_DEV_RUNTIME_DECISION.issue).toBe(22);
    expect(LOCAL_DEV_RUNTIME_DECISION.repository).toBe("Mang-X/forguncy-react-workspace");
    expect(LOCAL_DEV_RUNTIME_DECISION.title).toBe(
      "Spec: local Vite+ development runtime for React Cells",
    );
    expect(LOCAL_DEV_RUNTIME_DECISION_REFERENCE).toBe("#22");
    expect(LOCAL_DEV_RUNTIME_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/22",
    );
    expect(LOCAL_DEV_RUNTIME_DECISION_QUALIFIED_REFERENCE).toBe(
      "Mang-X/forguncy-react-workspace#22",
    );
  });

  // #22 depends on #5, #6 and #9, and consumes #27's mock port — so a change here
  // answers to all of them, and the list says so without re-typing any of them.
  it("names its upstream decisions by identity rather than by copy", () => {
    expect(LOCAL_DEV_GOVERNING_DECISIONS).toEqual([
      ...GOVERNING_ARCHITECTURE_DECISIONS,
      HOST_BRIDGE_DECISION,
      RUNTIME_FACADE_DECISION,
      LOCAL_DEV_RUNTIME_DECISION,
    ]);
  });

  // Two Specs, two lists: a local dev change is not a façade change, and folding
  // #22 into the façade's list would relabel it as part of the façade's contract.
  it("keeps its governing list separate from the façade Spec's", () => {
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(LOCAL_DEV_RUNTIME_DECISION);
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(RUNTIME_FACADE_DECISION);
    // #22's list is strictly longer, because it is built on both.
    expect(LOCAL_DEV_GOVERNING_DECISIONS.length).toBeGreaterThan(
      GOVERNING_ARCHITECTURE_DECISIONS.length + 1,
    );
  });

  it("carries the reference line a PR body or report quotes", () => {
    expect(LOCAL_DEV_GOVERNING_SPEC_REFERENCE_LINE).toBe(
      "Governing architecture Spec Issue(s): #4, #5, #9, #27, #22",
    );
  });

  // `#2` is a prefix of `#22` and `#22` is a prefix of `#220`, so a substring match
  // would accept a citation of a different Issue in both directions.
  it("does not treat a longer or shorter issue number as a citation of this one", () => {
    expect(citesDecision("#22", LOCAL_DEV_RUNTIME_DECISION)).toBe(true);
    expect(citesDecision(LOCAL_DEV_RUNTIME_DECISION.url, LOCAL_DEV_RUNTIME_DECISION)).toBe(true);
    expect(
      citesDecision(LOCAL_DEV_RUNTIME_DECISION_QUALIFIED_REFERENCE, LOCAL_DEV_RUNTIME_DECISION),
    ).toBe(true);
    expect(citesDecision("#220", LOCAL_DEV_RUNTIME_DECISION)).toBe(false);
    expect(citesDecision("#2", LOCAL_DEV_RUNTIME_DECISION)).toBe(false);
    expect(citesDecision("#23", LOCAL_DEV_RUNTIME_DECISION)).toBe(false);
    expect(citesDecision("other-org/other-repo#22", LOCAL_DEV_RUNTIME_DECISION)).toBe(false);
    expect(LOCAL_DEV_RUNTIME_CITATION_PATTERNS).toHaveLength(3);
  });

  it("carries the governing references in the package entry point", () => {
    const index = readPackageFile(join("src", "index.ts"));
    for (const source of LOCAL_DEV_GOVERNING_DECISIONS) {
      expect(citesDecision(index, source), `#${source.issue}`).toBe(true);
    }
  });
});
