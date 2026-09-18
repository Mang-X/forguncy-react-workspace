import { describe, expect, it } from "vitest";

import type { CellEntryKind, DependencyDecision } from "@forguncy-react-workspace/core";

import {
  CELL_ARTIFACT_BANNER,
  compileCell,
  formatCompileCellOutcome,
  packageNameOfSpecifier,
  serializeCompileCellResult,
  verifyCellArtifact,
} from "./artifact";
import type {
  BundledCellModule,
  CellBundlerPort,
  CellBundlingRequest,
  CompileCellInput,
  CompileCellOutcome,
  CompileCellResult,
} from "./artifact";
import { formatCellArtifactDiagnostics } from "./diagnostics";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry";
import { frontendLibraryReference } from "./frontend-libraries";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** What a bundler would return for a component with no third-party imports. */
const TRIVIAL_BUNDLE = [
  `var ${CELL_ENTRY_COMPONENT_BINDING} = (function () {`,
  '  return function App() { return React.createElement("div", null, "trivial"); };',
  "})();",
].join("\n");

/**
 * A bundler fixture.
 *
 * It returns the module it was given, which already declares the component under
 * `CELL_ENTRY_COMPONENT_BINDING` — the name the request asks for. The request's
 * own contents are asserted separately, so the fixture does not need to prove
 * anything about them.
 */
const bundlerOf = (module: BundledCellModule): CellBundlerPort => ({ bundle: async () => module });

const TRIVIAL_BUNDLER = bundlerOf({ code: TRIVIAL_BUNDLE, inlinedPackages: [] });

function compile(overrides: {
  readonly module?: BundledCellModule;
  readonly dependencies?: readonly DependencyDecision[];
  readonly entryKind?: CellEntryKind;
  readonly codeBudgetCharacters?: number;
  readonly bundler?: CellBundlerPort;
}): Promise<CompileCellOutcome> {
  return compileCell(
    { entry: "src/App.tsx", dependencies: overrides.dependencies ?? [] },
    {
      bundler: overrides.bundler ?? (overrides.module === undefined ? TRIVIAL_BUNDLER : bundlerOf(overrides.module)),
      ...(overrides.entryKind === undefined ? {} : { entryKind: overrides.entryKind }),
      ...(overrides.codeBudgetCharacters === undefined
        ? {}
        : { codeBudgetCharacters: overrides.codeBudgetCharacters }),
    },
  );
}

function artifactOf(outcome: CompileCellOutcome): CompileCellResult {
  if (outcome.status !== "compiled") {
    throw new Error(`Expected a compiled artifact, got:\n${formatCellArtifactDiagnostics(outcome.diagnostics)}`);
  }
  return outcome.artifact;
}

function rejectionCodes(outcome: CompileCellOutcome): readonly string[] {
  if (outcome.status !== "rejected") {
    throw new Error("Expected a rejection, but the artifact compiled.");
  }
  return outcome.diagnostics.map(diagnostic => diagnostic.code);
}

const extensionDecision = (packageName: string, libraryId: string, globalName: string): DependencyDecision => ({
  strategy: "extension",
  packageName,
  libraryId,
  globalName,
});

const architecturalRejection = (packageName: string): DependencyDecision => ({
  strategy: "replace",
  packageName,
  rejection: {
    kind: "architectural",
    code: "application-router-conflict",
    summary: "Navigation belongs to the application shell.",
    remediation: "Use host page navigation instead.",
  },
});

const technicalRejection = (packageName: string): DependencyDecision => ({
  strategy: "replace",
  packageName,
  rejection: {
    kind: "technical",
    code: "dynamic-module-loading",
    summary: "The package loads a sibling chunk at runtime.",
    remediation: "Use a browser-first alternative.",
  },
  alternatives: ["es-toolkit"],
});

// ---------------------------------------------------------------------------
// The boundary's happy path
// ---------------------------------------------------------------------------

describe("compiling a trivial entry with no third-party dependency", () => {
  // The end-to-end shape #6 promises: ordinary source in, platform artifact out,
  // with no manually rewritten Forguncy-style globals anywhere in the fixture.
  it("produces an artifact that carries the banner, the entry and canonical metadata", async () => {
    const outcome = await compile({});
    expect(outcome.status).toBe("compiled");
    const artifact = artifactOf(outcome);

    expect(artifact.code.startsWith(CELL_ARTIFACT_BANNER)).toBe(true);
    expect(artifact.code).toContain("function App(props)");
    expect(artifact.code).toContain(CELL_ENTRY_COMPONENT_BINDING);
    expect(artifact.frontendLibraries).toEqual([]);
    expect(verifyCellArtifact(artifact)).toEqual([]);
  });

  it("reports the entry shape it emitted", async () => {
    const outcome = await compile({});
    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.entryKind).toBe("app-function-declaration");
  });

  // #6 guarantee 7. Two runs over one input have to agree byte for byte, which is
  // the only reason a generated artifact can be reviewed as a diff.
  it("is deterministic for identical inputs and configuration", async () => {
    const first = await compile({});
    const second = await compile({});

    expect(serializeCompileCellResult(artifactOf(first))).toBe(serializeCompileCellResult(artifactOf(second)));
  });

  it("serializes with a fixed key order, not object insertion order", async () => {
    const artifact = artifactOf(await compile({ dependencies: [extensionDecision("echarts", "lib-a", "echarts")] }));
    const parsed = JSON.parse(serializeCompileCellResult(artifact)) as {
      readonly code: string;
      readonly frontendLibraries: readonly Record<string, unknown>[];
    };

    expect(Object.keys(parsed)).toEqual(["code", "frontendLibraries"]);
    expect(parsed.frontendLibraries).toHaveLength(1);
    expect(Object.keys(parsed.frontendLibraries[0] ?? {})).toEqual(["libraryId"]);
    expect(serializeCompileCellResult(artifact).endsWith("\n")).toBe(true);
  });

  // #6's "proposed compiler boundary" names the input as "a normal module entry
  // plus resolved dependency decisions", so the finalized interface must still be
  // exactly that. Everything the compiler needs in order to run lives in the
  // options, which keeps the boundary from growing a knob at a time.
  it("keeps the compiler input to exactly what the Spec pins it to", async () => {
    const requests: CellBundlingRequest[] = [];
    const bundler: CellBundlerPort = {
      bundle: request => {
        requests.push(request);
        return Promise.resolve({ code: TRIVIAL_BUNDLE });
      },
    };

    const input: CompileCellInput = { entry: "src/App.tsx", dependencies: [] };
    await compileCell(input, { bundler, entryKind: "render-call" });

    expect(Object.keys(input)).toEqual(["entry", "dependencies"]);
    expect(requests[0]?.entry).toBe("src/App.tsx");
    expect(requests[0]?.dependencies).toEqual([]);
  });

  // The wrapper and the bundle are produced by different halves of the pipeline,
  // and the one thing that has to agree between them is the binding. It used to be
  // a caller option that never reached the bundler, so a caller setting it
  // produced a wrapper referencing an identifier nothing declared — an artifact
  // that assembled cleanly and failed only in ReactCellType.
  it("tells the bundler which identifier to bind the component to", async () => {
    const requests: CellBundlingRequest[] = [];
    const bundler: CellBundlerPort = {
      bundle: request => {
        requests.push(request);
        return Promise.resolve({ code: TRIVIAL_BUNDLE });
      },
    };

    const outcome = await compileCell({ entry: "src/App.tsx", dependencies: [] }, { bundler });
    const artifact = artifactOf(outcome);

    expect(requests.map(request => request.componentBinding)).toEqual([CELL_ENTRY_COMPONENT_BINDING]);
    // The same name the wrapper references, so the two halves cannot disagree.
    expect(artifact.code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);
  });
});

// ---------------------------------------------------------------------------
// Single logical artifact, no runtime chunk loading
// ---------------------------------------------------------------------------

describe("the artifact is one script", () => {
  it("refuses a bundler that emitted a sibling asset", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, emittedAssets: ["chunk-abc.js"] },
    });
    expect(rejectionCodes(outcome)).toEqual(["unsupported-runtime-asset"]);
  });

  // The platform validator accepts a dynamic import and the element still
  // renders, so nothing downstream catches this one.
  it("refuses a dynamic import that survived into the code", async () => {
    const outcome = await compile({
      module: { code: `${TRIVIAL_BUNDLE}\nvar later = () => import("./heavy.js");` },
    });
    expect(rejectionCodes(outcome)).toEqual(["unsupported-runtime-asset"]);
  });
});

// ---------------------------------------------------------------------------
// External imports, reported by what the decision says
// ---------------------------------------------------------------------------

describe("external imports", () => {
  const withExternal = (specifier: string): BundledCellModule => ({
    code: TRIVIAL_BUNDLE,
    externalImports: [specifier],
  });

  it("reports an import no decision covers", async () => {
    const outcome = await compile({ module: withExternal("es-toolkit") });
    expect(rejectionCodes(outcome)).toEqual(["unresolved-dependency-decision"]);
  });

  it("reports an inline dependency the bundler failed to flatten", async () => {
    const outcome = await compile({
      module: withExternal("es-toolkit"),
      dependencies: [{ strategy: "inline", packageName: "es-toolkit" }],
    });
    expect(rejectionCodes(outcome)).toEqual(["source-level-import-remains"]);
  });

  // A host import is resolved by nothing at runtime: it has to be a reference to
  // the global, so a surviving import is not a duplicate copy but an absence.
  it("reports a host dependency left as a source import", async () => {
    const outcome = await compile({
      module: withExternal("react"),
      dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }],
    });
    expect(rejectionCodes(outcome)).toEqual(["source-level-import-remains"]);
  });

  it("reports an extension dependency with no extension reference in its place", async () => {
    const outcome = await compile({
      module: withExternal("echarts"),
      dependencies: [extensionDecision("echarts", "lib-echarts", "echarts")],
    });
    expect(rejectionCodes(outcome)).toEqual(["missing-extension-mapping"]);
  });

  // The distinction #4 exists to protect: an ownership conflict must not be
  // reported as a bundling failure, or the fix would be a new adapter.
  it("reports an architecturally rejected package as a platform conflict", async () => {
    const outcome = await compile({
      module: withExternal("react-router-dom"),
      dependencies: [architecturalRejection("react-router-dom")],
    });
    expect(rejectionCodes(outcome)).toEqual(["platform-conflicting-dependency"]);
  });

  it("reports a technically rejected package as a remaining import", async () => {
    const outcome = await compile({
      module: withExternal("some-amd-package"),
      dependencies: [technicalRejection("some-amd-package")],
    });
    expect(rejectionCodes(outcome)).toEqual(["source-level-import-remains"]);
  });

  it("matches a subpath import to its package decision", async () => {
    const outcome = await compile({
      module: withExternal("es-toolkit/array"),
      dependencies: [{ strategy: "inline", packageName: "es-toolkit" }],
    });
    expect(rejectionCodes(outcome)).toEqual(["source-level-import-remains"]);
  });

  // Guarantee 6's code path. A relative path is workspace source, not a
  // dependency, so reporting "no decision covers it" would send the caller to the
  // wrong layer for the fix.
  it("reports workspace source left external against the workspace guarantee", async () => {
    const outcome = await compile({ module: withExternal("./components/Chart") });
    expect(rejectionCodes(outcome)).toEqual(["source-level-import-remains"]);
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics[0]?.message).toMatch(/workspace source/);
  });
});

// ---------------------------------------------------------------------------
// Inlined packages
// ---------------------------------------------------------------------------

describe("packages flattened into the artifact", () => {
  // Invisible in a working bundle, and a second React identity breaks hooks and
  // `instanceof` subtly rather than loudly.
  it("refuses a bundled copy of a host-owned package", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, inlinedPackages: ["react"] },
      dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }],
    });
    expect(rejectionCodes(outcome)).toEqual(["duplicate-host-mapping"]);
  });

  it("refuses an architecturally rejected package that was bundled anyway", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, inlinedPackages: ["react-router-dom"] },
      dependencies: [architecturalRejection("react-router-dom")],
    });
    expect(rejectionCodes(outcome)).toEqual(["platform-conflicting-dependency"]);
  });

  // A `replace` decision says the package is the wrong artifact. Bundling it
  // anyway means there is no decision that describes what the artifact contains.
  it("refuses a technically rejected package that was bundled anyway", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, inlinedPackages: ["some-amd-package"] },
      dependencies: [technicalRejection("some-amd-package")],
    });
    expect(rejectionCodes(outcome)).toEqual(["unresolved-dependency-decision"]);
  });

  // Guarantee 5's second half. An inlined copy is a duplicate of a library the
  // page is separately told to load, and it silently skips the extension's
  // readiness guarantee.
  it("refuses an inlined copy of a package the page loads as an extension", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, inlinedPackages: ["echarts"] },
      dependencies: [extensionDecision("echarts", "lib-echarts", "echarts")],
    });
    expect(rejectionCodes(outcome)).toEqual(["missing-extension-mapping"]);
  });

  it("accepts inlined workspace source, which has no decision at all", async () => {
    const outcome = await compile({
      module: { code: TRIVIAL_BUNDLE, inlinedPackages: ["@forguncy-react-workspace/example-ui"] },
    });
    expect(outcome.status).toBe("compiled");
  });
});

// ---------------------------------------------------------------------------
// The decision list
// ---------------------------------------------------------------------------

describe("dependency decisions", () => {
  it("refuses an unresolved host global", async () => {
    const outcome = await compile({
      dependencies: [{ strategy: "host", packageName: "@company/ui", globalName: "CompanyUi" }],
    });
    expect(rejectionCodes(outcome)).toEqual(["duplicate-host-mapping"]);
  });

  it("accepts every global the runtime contract verified", async () => {
    const outcome = await compile({
      dependencies: [
        { strategy: "host", packageName: "react", globalName: "React" },
        { strategy: "host", packageName: "antd", globalName: "antd" },
        { strategy: "host", packageName: "react-dom", globalName: "ReactDOM" },
      ],
    });
    expect(outcome.status).toBe("compiled");
  });

  // Being a verified *name* is not the same as being a runtime *identity*. The
  // wrapper-locals exist inside the cell's own generated closure, so there is no
  // module identity for a dependency to share with them.
  it("refuses a host mapping onto a wrapper-local rather than a host identity", async () => {
    for (const globalName of ["props", "useState", "render", "useDataSource"]) {
      expect(rejectionCodes(await compile({
        dependencies: [{ strategy: "host", packageName: "some-package", globalName }],
      })), globalName).toEqual(["duplicate-host-mapping"]);
    }
  });

  it("refuses two packages claiming one host global", async () => {
    const outcome = await compile({
      dependencies: [
        { strategy: "host", packageName: "react", globalName: "React" },
        { strategy: "host", packageName: "preact-compat", globalName: "React" },
      ],
    });
    expect(rejectionCodes(outcome)).toEqual(["duplicate-host-mapping"]);
  });

  it("refuses two decisions for one package", async () => {
    const outcome = await compile({
      dependencies: [
        { strategy: "inline", packageName: "dayjs" },
        { strategy: "host", packageName: "dayjs", globalName: "dayjs" },
      ],
    });
    expect(rejectionCodes(outcome)).toEqual(["unresolved-dependency-decision"]);
  });

  it("reports an unnamed decision under a readable placeholder", async () => {
    const outcome = await compile({ dependencies: [{ strategy: "inline", packageName: "  " }] });
    expect(rejectionCodes(outcome)).toEqual(["unresolved-dependency-decision"]);
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics[0]?.subject).toBe("<unnamed package>");
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("frontendLibraries metadata", () => {
  it("carries one canonical reference per extension library", async () => {
    const outcome = await compile({
      dependencies: [extensionDecision("echarts", "lib-echarts", "echarts")],
    });
    const artifact = artifactOf(outcome);
    expect(artifact.frontendLibraries).toEqual([frontendLibraryReference("lib-echarts")]);
  });

  it("sorts metadata so the artifact does not depend on decision order", async () => {
    const forward = artifactOf(
      await compile({
        dependencies: [extensionDecision("a", "lib-a", "A"), extensionDecision("b", "lib-b", "B")],
      }),
    );
    const reversed = artifactOf(
      await compile({
        dependencies: [extensionDecision("b", "lib-b", "B"), extensionDecision("a", "lib-a", "A")],
      }),
    );

    expect(forward.frontendLibraries).toEqual(reversed.frontendLibraries);
    expect(serializeCompileCellResult(forward)).toBe(serializeCompileCellResult(reversed));
  });

  it("reports an extension decision with no library id, once", async () => {
    const outcome = await compile({ dependencies: [extensionDecision("echarts", "  ", "echarts")] });
    expect(rejectionCodes(outcome)).toEqual(["missing-extension-mapping"]);
  });
});

// ---------------------------------------------------------------------------
// Entry shapes and the source guard
// ---------------------------------------------------------------------------

describe("entry selection", () => {
  it("emits an explicitly requested shape", async () => {
    const outcome = await compile({ entryKind: "render-call" });
    expect(outcome.status).toBe("compiled");
    expect(artifactOf(outcome).code).toContain("render(React.createElement(");
  });

  it("refuses the shapes that validate but do not mount", async () => {
    for (const entryKind of ["app-async-function-declaration", "no-entry", "whole-source-expression"] as const) {
      expect(rejectionCodes(await compile({ entryKind })), entryKind).toEqual(["rejected-cell-entry-shape"]);
    }
  });
});

describe("the source guard", () => {
  it("refuses an export declaration in the bundle", async () => {
    const outcome = await compile({
      module: { code: `export default function App() { return null; }` },
    });
    expect(rejectionCodes(outcome)).toEqual(["rejected-cell-source-construct"]);
  });

  // The guard looks at syntax positions only, so a bundle that merely *mentions* a
  // refused name in text is not refused — the platform's own AST walk would not
  // refuse it either.
  it("accepts a bundle that only mentions a refused name in a string", async () => {
    const outcome = await compile({
      module: { code: `${TRIVIAL_BUNDLE}\nvar hint = "useFormStatus() is unsupported";` },
    });
    expect(outcome.status).toBe("compiled");
  });

  // Rejected by bare name, so a library that defines one is indistinguishable to
  // the platform from cell code that calls it. That makes this a real finding.
  it("refuses a hook the target rejects by name, even inside bundled code", async () => {
    const outcome = await compile({
      module: { code: `${TRIVIAL_BUNDLE}\nvar pending = useFormStatus();` },
    });
    expect(rejectionCodes(outcome)).toEqual(["rejected-cell-source-construct"]);
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics[0]?.message).toMatch(/bundled dependency code/);
  });

  it("refuses React.use", async () => {
    const outcome = await compile({
      module: { code: `${TRIVIAL_BUNDLE}\nvar v = React.use(promise);` },
    });
    expect(rejectionCodes(outcome)).toEqual(["rejected-cell-source-construct"]);
  });
});

// ---------------------------------------------------------------------------
// Budget and failures
// ---------------------------------------------------------------------------

describe("the cell code budget", () => {
  it("refuses an artifact over the configured budget", async () => {
    expect(rejectionCodes(await compile({ codeBudgetCharacters: 32 }))).toEqual(["cell-code-budget-exceeded"]);
  });

  // No default is applied: #5 found no hard platform limit, so a default would be
  // policy the compiler is not entitled to invent.
  it("applies no budget when the caller supplies none", async () => {
    expect((await compile({})).status).toBe("compiled");
  });

  it("accepts an artifact exactly at the budget", async () => {
    const artifact = artifactOf(await compile({}));
    expect((await compile({ codeBudgetCharacters: artifact.code.length })).status).toBe("compiled");
  });
});

describe("bundler failure", () => {
  it("returns a diagnostic instead of letting an exception escape", async () => {
    const outcome = await compile({
      bundler: {
        bundle: () => Promise.reject(new Error("ENOENT: src/App.tsx")),
      },
    });

    expect(rejectionCodes(outcome)).toEqual(["bundler-failure"]);
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics[0]?.message).toContain("ENOENT");
    expect(outcome.diagnostics[0]?.remediation.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Verification, reporting and helpers
// ---------------------------------------------------------------------------

describe("verifying an artifact assembled elsewhere", () => {
  it("reports an artifact that lost its banner", async () => {
    const artifact = artifactOf(await compile({}));
    const tampered: CompileCellResult = { ...artifact, code: artifact.code.replace(CELL_ARTIFACT_BANNER, "") };
    expect(verifyCellArtifact(tampered).map(diagnostic => diagnostic.code)).toEqual([
      "non-canonical-artifact-metadata",
    ]);
  });

  it("reports metadata that is not in canonical order", async () => {
    const artifact = artifactOf(await compile({}));
    const tampered: CompileCellResult = {
      ...artifact,
      frontendLibraries: [frontendLibraryReference("b"), frontendLibraryReference("a")],
    };
    expect(verifyCellArtifact(tampered).map(diagnostic => diagnostic.code)).toEqual([
      "non-canonical-artifact-metadata",
    ]);
  });
});

describe("reporting", () => {
  it("says out loud that a local compile is not runtime validation", async () => {
    const report = formatCompileCellOutcome(await compile({}));
    expect(report).toContain("Real Forguncy runtime validation is not established by a local compile.");
    expect(report).toContain("frontendLibraries: (none)");
  });

  it("lists the diagnostics of a rejection", async () => {
    const outcome = await compile({ module: { code: TRIVIAL_BUNDLE, emittedAssets: ["a.js"] } });
    const report = formatCompileCellOutcome(outcome);
    expect(report).toContain("Compilation rejected with 1 diagnostic(s):");
    expect(report).toContain("[unsupported-runtime-asset]");
  });
});

describe("specifier helpers", () => {
  it("resolves a specifier to the package a decision is keyed by", () => {
    expect(packageNameOfSpecifier("react")).toBe("react");
    expect(packageNameOfSpecifier("react/jsx-runtime")).toBe("react");
    expect(packageNameOfSpecifier("@scope/ui/button")).toBe("@scope/ui");
    expect(packageNameOfSpecifier("@scope/ui")).toBe("@scope/ui");
    expect(packageNameOfSpecifier("./local")).toBe("./local");
    expect(packageNameOfSpecifier("/absolute")).toBe("/absolute");
  });
});
