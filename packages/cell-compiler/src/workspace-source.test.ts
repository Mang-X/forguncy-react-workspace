import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { DependencyDecision, FrontendLibraryReference } from "@forguncy-react-workspace/core";
import { citesDecision, citesEveryArchitectureDecision } from "@forguncy-react-workspace/core";

import {
  WORKSPACE_GRAPH_IMPLEMENTATION,
  WORKSPACE_SOURCE_DECISION,
  WORKSPACE_SOURCE_DECISION_REFERENCE,
  WORKSPACE_SOURCE_GOVERNING_DECISIONS,
  WORKSPACE_SOURCE_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance";
import {
  auditWorkspaceSource,
  classifyWorkspaceModule,
  findWorkspaceSourceGuarantee,
  findWorkspaceSourceReuseClass,
  formatWorkspaceSourceAudit,
  indexWorkspaceGraph,
  isWorkspaceSourceSpecifier,
  locallyCheckableWorkspaceSourceGuarantees,
  realRuntimeWorkspaceSourceGuarantees,
  traceWorkspaceSourceClosure,
  workspacePackageFor,
  workspaceReuseClassesRequiringDelegation,
  WORKSPACE_CONTEXT_SEMANTICS,
  WORKSPACE_SOURCE_DIAGNOSTIC_CODES,
  WORKSPACE_SOURCE_DIAGNOSTIC_RULES,
  WORKSPACE_SOURCE_GUARANTEE_IDS,
  WORKSPACE_SOURCE_GUARANTEES,
  WORKSPACE_SOURCE_REUSE_CLASS_IDS,
  WORKSPACE_SOURCE_REUSE_CLASSES,
  WORKSPACE_SOURCE_SHARING_INVARIANT,
} from "./workspace-source";
import type {
  WorkspaceGraph,
  WorkspacePackageRecord,
  WorkspaceSourceDiagnostic,
  WorkspaceSourceDiagnosticCode,
} from "./workspace-source";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRepositoryFile(...segments: readonly string[]): string {
  return readFileSync(join(repositoryRoot, ...segments), "utf8");
}

// ---------------------------------------------------------------------------
// Fixtures — a small application workspace
// ---------------------------------------------------------------------------

const UI: WorkspacePackageRecord = {
  name: "@app/ui",
  directory: "packages/ui",
  imports: ["react", "@app/tokens"],
};

const TOKENS: WorkspacePackageRecord = {
  name: "@app/tokens",
  directory: "packages/tokens",
  imports: ["react-dom"],
};

/** A package whose transitive npm dependency is the one worth deciding. */
const DOMAIN: WorkspacePackageRecord = {
  name: "@app/domain",
  directory: "packages/domain",
  imports: ["es-toolkit", "@app/tokens"],
};

function workspace(...extra: readonly WorkspacePackageRecord[]): WorkspaceGraph {
  return { packages: [UI, TOKENS, DOMAIN, ...extra] };
}

function codesOf(diagnostics: readonly WorkspaceSourceDiagnostic[]): readonly string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

function subjectsOf(diagnostics: readonly WorkspaceSourceDiagnostic[]): readonly string[] {
  return diagnostics.map(diagnostic => diagnostic.subject);
}

function withCode(
  diagnostics: readonly WorkspaceSourceDiagnostic[],
  code: WorkspaceSourceDiagnosticCode,
): readonly WorkspaceSourceDiagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.code === code);
}

function inlineDecision(packageName: string): DependencyDecision {
  return { strategy: "inline", packageName };
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

describe("the workspace graph index", () => {
  const { index } = indexWorkspaceGraph(workspace());

  it("resolves a workspace package id and its subpaths, and nothing else", () => {
    expect(workspacePackageFor(index, "@app/ui")?.directory).toBe("packages/ui");
    // A subpath is workspace source because its package is — the question
    // `artifact.findDependencyDecision` answers for decisions, asked here through
    // the same package-name rule rather than a second one.
    expect(workspacePackageFor(index, "@app/ui/theme.css")?.name).toBe("@app/ui");
    expect(workspacePackageFor(index, "@app/tokens/dist/index.js")?.name).toBe("@app/tokens");

    expect(workspacePackageFor(index, "react")).toBeUndefined();
    expect(workspacePackageFor(index, "@app/unknown")).toBeUndefined();
    // A file path is source too, but #6 already reports a leftover one, and the
    // manifest changes nothing about a path that was never ambiguous.
    expect(workspacePackageFor(index, "./local.ts")).toBeUndefined();
    expect(isWorkspaceSourceSpecifier(index, "@app/ui")).toBe(true);
    expect(isWorkspaceSourceSpecifier(index, "es-toolkit")).toBe(false);
  });

  it("keeps a canonical order whatever order the caller lists packages in", () => {
    const forward = indexWorkspaceGraph(workspace()).index.packages.map(entry => entry.name);
    const reversed = indexWorkspaceGraph({ packages: [DOMAIN, TOKENS, UI] }).index.packages.map(
      entry => entry.name,
    );
    expect(forward).toEqual(["@app/domain", "@app/tokens", "@app/ui"]);
    expect(reversed).toEqual(forward);
  });

  it("classifies a specifier as workspace source, a file, or a published dependency", () => {
    const { index } = indexWorkspaceGraph(workspace());

    expect(classifyWorkspaceModule(index, "@app/ui")).toBe("workspace-package");
    expect(classifyWorkspaceModule(index, "@app/ui/theme.css")).toBe("workspace-package");

    // Files inside a package. Nothing resolves these as a dependency, so nothing may
    // ask for a decision about them.
    expect(classifyWorkspaceModule(index, "./Button")).toBe("source-file");
    expect(classifyWorkspaceModule(index, "../shared/utils")).toBe("source-file");
    expect(classifyWorkspaceModule(index, "./styles.css")).toBe("source-file");
    expect(classifyWorkspaceModule(index, "/abs/polyfill.ts")).toBe("source-file");

    expect(classifyWorkspaceModule(index, "es-toolkit")).toBe("external-package");
    expect(classifyWorkspaceModule(index, "es-toolkit/compat")).toBe("external-package");
    // A Node builtin is not a npm package, and it is still a dependency question: #4
    // records `platform-api-unavailable` for exactly this case.
    expect(classifyWorkspaceModule(index, "node:fs")).toBe("external-package");
  });

  it("reports a duplicated name and resolves it the same way in either input order", () => {
    const first: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui" };
    const second: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui-copy" };

    const forward = indexWorkspaceGraph({ packages: [first, second] });
    const backward = indexWorkspaceGraph({ packages: [second, first] });

    const conflicts = withCode(forward.diagnostics, "workspace-graph-conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.subject).toBe("@app/ui");
    expect(conflicts[0]?.message).toContain("packages/ui");
    expect(conflicts[0]?.message).toContain("packages/ui-copy");

    // Whichever array order the caller used, the same record answers lookups: a
    // collision must not be resolved by whichever entry happened to come first.
    expect(forward.index.byName.get("@app/ui")?.directory).toBe("packages/ui");
    expect(backward.index.byName.get("@app/ui")?.directory).toBe("packages/ui");
  });

  // The review's third finding. A comparator that returns 0 for two records leaves the
  // winner to JavaScript's stable sort — that is, to the caller's array order — and two
  // records can share a name *and* a directory while disagreeing about their edges or
  // their identity.
  it("resolves records that share a name and a directory by content, not by input order", () => {
    const react: WorkspacePackageRecord = {
      name: "@app/ui",
      directory: "packages/ui",
      imports: ["react"],
    };
    const esToolkit: WorkspacePackageRecord = {
      name: "@app/ui",
      directory: "packages/ui",
      imports: ["es-toolkit"],
    };

    const forward = indexWorkspaceGraph({ packages: [react, esToolkit] });
    const backward = indexWorkspaceGraph({ packages: [esToolkit, react] });

    expect(forward.index.byName.get("@app/ui")?.imports).toEqual(["es-toolkit"]);
    expect(backward.index.byName.get("@app/ui")?.imports).toEqual(["es-toolkit"]);
    expect(forward.diagnostics).toEqual(backward.diagnostics);
    expect(forward.diagnostics[0]?.message).toContain("declare this package differently");

    // And the answer the rest of the audit is built on agrees, not just the index.
    expect(traceWorkspaceSourceClosure(forward.index, ["@app/ui"])).toEqual(
      traceWorkspaceSourceClosure(backward.index, ["@app/ui"]),
    );
  });

  // The second review's third finding. A key that normalises `imports` makes two distinct
  // raw records compare equal, and a stable sort then keeps whichever came first — so the
  // public index could still retain a different record when the input was reversed. The
  // key is raw now, and the retained record is asserted rather than assumed.
  it("retains the same record when two declarations are equivalent but written differently", () => {
    const verbose: WorkspacePackageRecord = {
      name: "@app/ui",
      directory: "packages/ui",
      imports: ["react", "react"],
    };
    const terse: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui", imports: ["react"] };

    const forward = indexWorkspaceGraph({ packages: [verbose, terse] });
    const backward = indexWorkspaceGraph({ packages: [terse, verbose] });

    // The invariant: whichever record wins, it is the same one in both directions. Which
    // one that is comes from raw text order and carries no preference, since the two are
    // interchangeable for every check here — asserted so a change to the key has to mean it.
    expect(forward.index.byName.get("@app/ui")?.imports).toEqual(
      backward.index.byName.get("@app/ui")?.imports,
    );
    expect(forward.index.byName.get("@app/ui")?.imports).toEqual(["react", "react"]);
    expect(forward.diagnostics).toEqual(backward.diagnostics);
    // Equivalent, so the report says the duplicate changed nothing — while the retained
    // record is still chosen by content rather than by position.
    expect(forward.diagnostics[0]?.message).toContain("equivalently");
  });

  it("does not fold an unstated imports list into an empty one when ordering records", () => {
    const unstated: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui" };
    const empty: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui", imports: [] };

    for (const packages of [
      [unstated, empty],
      [empty, unstated],
    ]) {
      const { index } = indexWorkspaceGraph({ packages });
      // They are different declarations — "nobody said" is not "there are none" — so they
      // must not tie, and the same one has to win in both orders.
      expect(index.byName.get("@app/ui")?.imports).toEqual([]);
    }
  });

  // The third review's finding, and the last fold that was left in the selection key: an
  // absent `moduleIdentity` and an explicit `{ kind: "cell-local" }` mean the same thing —
  // and stay folded in the *meaning* comparison — but they are not the same record, so the
  // key has to keep them apart or the exported index retains whichever came first.
  it("does not fold an explicit cell-local identity into an absent one when ordering records", () => {
    const implicit: WorkspacePackageRecord = { name: "@app/ui", directory: "packages/ui" };
    const explicit: WorkspacePackageRecord = {
      name: "@app/ui",
      directory: "packages/ui",
      moduleIdentity: { kind: "cell-local" },
    };

    const forward = indexWorkspaceGraph({ packages: [implicit, explicit] });
    const backward = indexWorkspaceGraph({ packages: [explicit, implicit] });

    // The contract: the retained record is the same one in both directions.
    expect(forward.index.byName.get("@app/ui")?.moduleIdentity).toEqual(
      backward.index.byName.get("@app/ui")?.moduleIdentity,
    );
    // And which one that is, so a later change to the key has to mean it deliberately. The
    // choice is by raw text order and carries no preference — `null` sorts before
    // `{"kind":"cell-local"}` — because the two are interchangeable for every check here.
    expect(forward.index.byName.get("@app/ui")?.moduleIdentity).toBeUndefined();

    // Still reported as equivalent: the duplicate changed nothing downstream.
    expect(forward.diagnostics[0]?.message).toContain("equivalently");
    expect(forward.diagnostics).toEqual(backward.diagnostics);
  });

  it("says a duplicate that declares the same thing is equivalent rather than ambiguous", () => {
    const record: WorkspacePackageRecord = {
      name: "@app/ui",
      directory: "packages/ui",
      imports: ["react"],
    };

    for (const packages of [[record, { ...record }], [{ ...record }, record]]) {
      const { index, diagnostics } = indexWorkspaceGraph({ packages });
      const conflict = withCode(diagnostics, "workspace-graph-conflict")[0];
      expect(conflict?.message).toContain("equivalently");
      expect(conflict?.message).toContain("nothing downstream changes");
      expect(index.byName.get("@app/ui")).toBeDefined();
    }
  });

  it("refuses a record whose name source cannot import", () => {
    const { index, diagnostics } = indexWorkspaceGraph({
      packages: [{ name: "./src/ui", directory: "packages/ui" }],
    });

    const conflict = withCode(diagnostics, "workspace-graph-conflict")[0];
    expect(conflict?.subject).toBe("./src/ui");
    expect(conflict?.message).toContain("named, not pathed");
    expect(conflict?.fixOwner).toBe("workspace-graph");
    // A record nothing can look up is not in the index; that it was dropped is
    // what the diagnostic says.
    expect(index.packages).toEqual([]);
  });

  it("reports a directory that is not workspace-relative, and keeps the record", () => {
    const { index, diagnostics } = indexWorkspaceGraph({
      packages: [
        { name: "@app/a", directory: "C:/Users/someone/app/packages/a" },
        { name: "@app/b", directory: "../outside/b" },
        { name: "@app/c", directory: "/absolute/c" },
      ],
    });

    expect(withCode(diagnostics, "workspace-graph-conflict")).toHaveLength(3);
    // The record still answers the resolution question, so dropping it would
    // silently change the graph to hide a reporting problem.
    expect(index.packages.map(entry => entry.name)).toEqual(["@app/a", "@app/b", "@app/c"]);
  });

  it("reports a delegation naming a module id that is not importable", () => {
    const { diagnostics } = indexWorkspaceGraph({
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          moduleIdentity: { kind: "delegated", via: "../shared/state" },
        },
      ],
    });

    const delegation = withCode(diagnostics, "undelegated-workspace-module-identity")[0];
    expect(delegation?.subject).toBe("@app/state");
    expect(delegation?.message).toContain("../shared/state");
    expect(delegation?.fixOwner).toBe("workspace-graph");
  });
});

// ---------------------------------------------------------------------------
// The source closure — #14's acceptance criteria 3 and 4
// ---------------------------------------------------------------------------

describe("the workspace source closure", () => {
  const { index } = indexWorkspaceGraph(workspace());

  // The review's first finding, as the case that made it visible: a graph derived from
  // *source* imports — which the record type explicitly allows — carries ordinary
  // relative imports, and classifying "not in the graph" as "a published dependency"
  // made the audit demand a decision for a component file.
  it("does not demand a decision for a package's own source files", () => {
    const sourceDerived: WorkspaceGraph = {
      packages: [
        {
          name: "@app/ui",
          directory: "packages/ui",
          imports: ["./Button", "../shared/utils", "./styles.css", "/abs/polyfill.ts", "react"],
        },
        { name: "@app/shared", directory: "packages/shared", imports: ["./internal"] },
      ],
    };
    const { index: sourceIndex } = indexWorkspaceGraph(sourceDerived);

    expect(traceWorkspaceSourceClosure(sourceIndex, ["@app/ui"]).externalModules.map(entry => entry.moduleId)).toEqual([
      "react",
    ]);

    // With no decisions at all, exactly one diagnostic: the real dependency. Not four.
    const missing = auditWorkspaceSource({
      workspace: sourceDerived,
      dependencies: [],
      entryModuleIds: ["@app/ui"],
    });
    expect(subjectsOf(missing.diagnostics)).toEqual(["react"]);

    expect(
      auditWorkspaceSource({
        workspace: sourceDerived,
        dependencies: [inlineDecision("react")],
        entryModuleIds: ["@app/ui"],
      }).diagnostics,
    ).toEqual([]);
  });

  it("collects the workspace source the entry reaches, transitively", () => {
    const closure = traceWorkspaceSourceClosure(index, ["@app/ui"]);
    expect(closure.packages).toEqual(["@app/tokens", "@app/ui"]);
  });

  it("collects only published dependencies reached *through* workspace source", () => {
    // `react` is imported by the cell directly and by nothing in the workspace, so
    // it is the artifact contract's business (#6 audits the decisions list); what
    // this closure answers is what the workspace packages drag in.
    const closure = traceWorkspaceSourceClosure(index, ["react", "@app/domain"]);
    expect(closure.externalModules.map(entry => entry.moduleId)).toEqual([
      "es-toolkit",
      "react-dom",
    ]);
  });

  it("names every workspace package that imports a published dependency", () => {
    const twoImporters: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: ["react"] },
        { name: "@app/b", directory: "packages/b", imports: ["react", "@app/a"] },
      ],
    };
    const closure = traceWorkspaceSourceClosure(indexWorkspaceGraph(twoImporters).index, ["@app/b"]);
    expect(closure.externalModules).toEqual([{ moduleId: "react", importedBy: ["@app/a", "@app/b"] }]);
  });

  it("does not turn an unstated imports list into an empty one", () => {
    const opaque: WorkspaceGraph = {
      packages: [{ name: "@app/opaque", directory: "packages/opaque" }],
    };
    const closure = traceWorkspaceSourceClosure(indexWorkspaceGraph(opaque).index, ["@app/opaque"]);

    // Reached, because the entry imports it; nothing is claimed about its edges.
    expect(closure.packages).toEqual(["@app/opaque"]);
    expect(closure.externalModules).toEqual([]);
    expect(closure.cycles).toEqual([]);
  });

  it("reports a cycle once, closing the chain on its first member", () => {
    const cyclic: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: ["@app/b"] },
        { name: "@app/b", directory: "packages/b", imports: ["@app/a"] },
      ],
    };
    const closure = traceWorkspaceSourceClosure(indexWorkspaceGraph(cyclic).index, ["@app/a"]);

    expect(closure.cycles).toEqual([{ chain: ["@app/a", "@app/b", "@app/a"] }]);
  });

  it("reports one chain for a cycle however the walk enters it", () => {
    const cyclic: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: ["@app/b"] },
        { name: "@app/b", directory: "packages/b", imports: ["@app/c"] },
        { name: "@app/c", directory: "packages/c", imports: ["@app/a"] },
      ],
    };
    const { index: cyclicIndex } = indexWorkspaceGraph(cyclic);

    // Both members are entry points, so the walk reaches the same cycle twice. A
    // rotation is not a second cycle, and canonicalising to the smallest member is
    // what makes that true whichever package is entered first.
    for (const entry of [["@app/a"], ["@app/b"], ["@app/c"], ["@app/a", "@app/b", "@app/c"]]) {
      const closure = traceWorkspaceSourceClosure(cyclicIndex, entry);
      expect(closure.cycles).toEqual([{ chain: ["@app/a", "@app/b", "@app/c", "@app/a"] }]);
    }
  });

  it("reports a self-import as a cycle", () => {
    const selfImporting: WorkspaceGraph = {
      packages: [{ name: "@app/a", directory: "packages/a", imports: ["@app/a/theme.css"] }],
    };
    const closure = traceWorkspaceSourceClosure(indexWorkspaceGraph(selfImporting).index, ["@app/a"]);
    expect(closure.cycles).toEqual([{ chain: ["@app/a", "@app/a"] }]);
  });

  it("does not report a cycle the entry cannot reach", () => {
    const unreachable: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: [] },
        { name: "@app/orphan-1", directory: "packages/orphan-1", imports: ["@app/orphan-2"] },
        { name: "@app/orphan-2", directory: "packages/orphan-2", imports: ["@app/orphan-1"] },
      ],
    };
    const closure = traceWorkspaceSourceClosure(indexWorkspaceGraph(unreachable).index, ["@app/a"]);
    expect(closure.packages).toEqual(["@app/a"]);
    expect(closure.cycles).toEqual([]);
  });

  // The traversal is iterative because a deeply nested graph is exactly the
  // malformed input it exists to report, and a `RangeError` escaping it would turn
  // a diagnostic into a crash. The chain is far longer than any call stack, and it
  // closes, so the cycle has to be reported from a path the recursion would never
  // have finished building.
  it("walks a chain far deeper than the call stack, and still finds the cycle it closes", () => {
    const depth = 20_000;
    const packages: WorkspacePackageRecord[] = [];
    for (let position = 0; position < depth; position += 1) {
      packages.push({
        name: `@app/p${position}`,
        directory: `packages/p${position}`,
        imports: position + 1 < depth ? [`@app/p${position + 1}`] : ["@app/p0"],
      });
    }

    const { index: deep } = indexWorkspaceGraph({ packages });
    const closure = traceWorkspaceSourceClosure(deep, ["@app/p0"]);

    expect(closure.packages).toHaveLength(depth);
    expect(closure.cycles).toHaveLength(1);
    expect(closure.cycles[0]?.chain).toHaveLength(depth + 1);
    expect(closure.cycles[0]?.chain[0]).toBe(closure.cycles[0]?.chain[depth]);
  });
});

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

describe("the workspace source audit", () => {
  it("abstains entirely when the caller did not state a workspace graph", () => {
    const audit = auditWorkspaceSource({
      dependencies: [inlineDecision("es-toolkit")],
      entryModuleIds: ["@app/ui"],
      externalImports: ["@app/ui"],
      frontendLibraries: [{ libraryId: "@app/ui" }],
    });

    // This is #6's recorded caveat, not a clean bill of health: without a manifest a
    // named workspace package is indistinguishable from a published one, so there is
    // nothing to report *and* nothing to claim.
    expect(audit.graphActivation).toBe("unstated");
    expect(audit.usage).toBe("unstated");
    expect(audit.packages).toEqual([]);
    expect(audit.closure).toBeUndefined();
    expect(audit.diagnostics).toEqual([]);
    expect(formatWorkspaceSourceAudit(audit)).toContain("no claim is made about workspace packages");
  });

  it("reports nothing for a cell whose workspace source is inlined", () => {
    const audit = auditWorkspaceSource({
      workspace: workspace(),
      dependencies: [inlineDecision("es-toolkit"), inlineDecision("react-dom"), inlineDecision("react")],
      entryModuleIds: ["@app/ui", "react"],
      externalImports: [],
      frontendLibraries: [{ libraryId: "tanstack-query" }],
    });

    expect(audit.diagnostics).toEqual([]);
    expect(audit.closure?.packages).toEqual(["@app/tokens", "@app/ui"]);
  });

  it("refuses a dependency decision for a workspace package, whatever the strategy", () => {
    const decisions: readonly DependencyDecision[] = [
      { strategy: "host", packageName: "@app/ui", globalName: "React" },
      inlineDecision("@app/ui"),
      { strategy: "extension", packageName: "@app/ui", libraryId: "app-ui", globalName: "AppUi" },
      {
        strategy: "replace",
        packageName: "@app/ui",
        rejection: {
          kind: "technical",
          code: "dynamic-module-loading",
          summary: "The package loads a module at runtime.",
          remediation: "Not applicable to a workspace package.",
        },
      },
    ];

    for (const decision of decisions) {
      const audit = auditWorkspaceSource({ workspace: workspace(), dependencies: [decision] });
      const reported = withCode(audit.diagnostics, "workspace-package-decided-as-dependency");
      expect(reported, decision.strategy).toHaveLength(1);
      expect(reported[0]?.subject).toBe("@app/ui");
      expect(reported[0]?.message).toContain("packages/ui");
      expect(reported[0]?.fixOwner).toBe("dependency-decision");
    }
  });

  it("reports workspace source the bundler left external, including a subpath", () => {
    const audit = auditWorkspaceSource({
      workspace: workspace(),
      externalImports: ["@app/ui", "@app/ui/theme.css", "es-toolkit"],
    });

    const reported = withCode(audit.diagnostics, "workspace-source-left-external");
    expect(subjectsOf(reported)).toEqual(["@app/ui", "@app/ui/theme.css"]);
    expect(reported[0]?.fixOwner).toBe("bundler-configuration");
  });

  it("leaves a relative source path to the artifact contract", () => {
    // #6 already reports a leftover relative path as `source-level-import-remains`,
    // and a manifest changes nothing about a path that was never ambiguous.
    const audit = auditWorkspaceSource({ workspace: workspace(), externalImports: ["./helper.ts"] });
    expect(audit.diagnostics).toEqual([]);
  });

  it("reports a workspace package name in frontendLibraries, and not a real library id", () => {
    const frontendLibraries: readonly FrontendLibraryReference[] = [
      { libraryId: "tanstack-query" },
      { libraryId: "@app/domain" },
    ];
    const audit = auditWorkspaceSource({ workspace: workspace(), frontendLibraries });

    const reported = withCode(audit.diagnostics, "workspace-package-in-frontend-libraries");
    expect(subjectsOf(reported)).toEqual(["@app/domain"]);
    expect(reported[0]?.message).toContain("packages/domain");
  });

  it("reports a published dependency reached through workspace source with no decision", () => {
    const audit = auditWorkspaceSource({
      workspace: workspace(),
      dependencies: [inlineDecision("react-dom")],
      entryModuleIds: ["@app/domain"],
    });

    const reported = withCode(audit.diagnostics, "unresolved-workspace-transitive-dependency");
    expect(subjectsOf(reported)).toEqual(["es-toolkit"]);
    // The chain is the point: a dependency reached only through workspace source is
    // the one that used to be bundled without passing the decision pipeline.
    expect(reported[0]?.message).toContain("imported by @app/domain");
    expect(reported[0]?.breaksGuarantees).toEqual(["transitive-third-party-dependencies-decided"]);
  });

  it("lets a decision on the package govern a subpath import", () => {
    // The engine already owns this rule (`artifact.findDependencyDecision`), and the
    // workspace audit has to agree with it or a cell would be told a dependency is
    // undecided while the artifact contract considers it decided.
    const withSubpath: WorkspaceGraph = {
      packages: [{ name: "@app/a", directory: "packages/a", imports: ["es-toolkit/compat"] }],
    };

    expect(
      auditWorkspaceSource({
        workspace: withSubpath,
        dependencies: [inlineDecision("es-toolkit")],
        entryModuleIds: ["@app/a"],
      }).diagnostics,
    ).toEqual([]);

    expect(
      auditWorkspaceSource({
        workspace: withSubpath,
        dependencies: [inlineDecision("es-toolkit/compat")],
        entryModuleIds: ["@app/a"],
      }).diagnostics,
    ).toEqual([]);
  });

  it("treats an empty decision list as stated, and an absent one as unstated", () => {
    const stated = auditWorkspaceSource({
      workspace: workspace(),
      dependencies: [],
      entryModuleIds: ["@app/domain"],
    });
    expect(codesOf(stated.diagnostics)).toEqual([
      "unresolved-workspace-transitive-dependency",
      "unresolved-workspace-transitive-dependency",
    ]);
    expect(subjectsOf(stated.diagnostics)).toEqual(["es-toolkit", "react-dom"]);

    // "The caller did not tell us the decisions" is not "there are no decisions".
    const unstated = auditWorkspaceSource({ workspace: workspace(), entryModuleIds: ["@app/domain"] });
    expect(unstated.diagnostics).toEqual([]);
  });

  it("reports a cycle as a structured diagnostic naming the chain", () => {
    const cyclic: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: ["@app/b"] },
        { name: "@app/b", directory: "packages/b", imports: ["@app/a"] },
      ],
    };
    const audit = auditWorkspaceSource({ workspace: cyclic, entryModuleIds: ["@app/a"] });

    const reported = withCode(audit.diagnostics, "circular-workspace-dependency");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.subject).toBe("@app/a");
    expect(reported[0]?.message).toContain("@app/a → @app/b → @app/a");
    expect(reported[0]?.breaksGuarantees).toEqual(["workspace-import-graph-is-acyclic"]);
  });

  it("abstains from the closure checks when the caller did not say what the cell imports", () => {
    const cyclic: WorkspaceGraph = {
      packages: [
        { name: "@app/a", directory: "packages/a", imports: ["@app/b"] },
        { name: "@app/b", directory: "packages/b", imports: ["@app/a", "es-toolkit"] },
      ],
    };
    const audit = auditWorkspaceSource({ workspace: cyclic, dependencies: [] });

    expect(audit.usage).toBe("unstated");
    expect(audit.closure).toBeUndefined();
    // Neither the cycle nor the undecided transitive dependency is claimed to be
    // absent — they were not looked for.
    expect(audit.diagnostics).toEqual([]);
    expect(formatWorkspaceSourceAudit(audit)).toContain("cycles were not looked for");
  });

  it("accepts a delegation backed by a host or extension decision", () => {
    for (const decision of [
      { strategy: "host", packageName: "react", globalName: "React" },
      { strategy: "extension", packageName: "react", libraryId: "react", globalName: "React" },
    ] satisfies readonly DependencyDecision[]) {
      const delegating: WorkspaceGraph = {
        packages: [
          {
            name: "@app/state",
            directory: "packages/state",
            imports: ["react"],
            moduleIdentity: { kind: "delegated", via: "react" },
          },
        ],
      };
      const audit = auditWorkspaceSource({ workspace: delegating, dependencies: [decision] });
      expect(audit.diagnostics, decision.strategy).toEqual([]);
    }
  });

  // The review's second finding. `import React from "react"` plus a package-local
  // `React.createContext(null)` passes every check this contract can make — the module
  // is provided by the page and the package reaches it — while each inlined Cell still
  // declares its own Context. So a clean audit must not be readable as "your state is
  // shared", and the assessment is where that is stated instead of implied.
  it("reports a backed delegation as backed without claiming the state is shared", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          imports: ["react"],
          moduleIdentity: { kind: "delegated", via: "react" },
        },
      ],
    };
    const audit = auditWorkspaceSource({
      workspace: delegating,
      dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }],
    });

    expect(audit.diagnostics).toEqual([]);
    expect(audit.delegations).toEqual([
      { package: "@app/state", via: "react", status: "backed", stateSharingEstablished: false },
    ]);

    // The report says it too, so the one line a reader skims cannot be read as a
    // verification of sharing.
    const report = formatWorkspaceSourceAudit(audit);
    expect(report).toContain("@app/state → react (backed");
    expect(report).toContain("state sharing NOT established");

    // And the promise is split the same way: the local guarantee is about the
    // declaration, the sharing half is the real-runtime one.
    const declaration = findWorkspaceSourceGuarantee("workspace-module-identity-is-delegated");
    expect(declaration.level).toBe("local");
    expect(declaration.caveat).toMatch(/declared and backed/);
    expect(declaration.caveat).toMatch(/never that the package's state actually lives in/);
  });

  it("lists every delegation, including the ones that failed a check", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          imports: ["react"],
          moduleIdentity: { kind: "delegated", via: "react" },
        },
        {
          name: "@app/cache",
          directory: "packages/cache",
          imports: ["es-toolkit"],
          moduleIdentity: { kind: "delegated", via: "es-toolkit" },
        },
      ],
    };
    const audit = auditWorkspaceSource({
      workspace: delegating,
      dependencies: [
        { strategy: "host", packageName: "react", globalName: "React" },
        inlineDecision("es-toolkit"),
      ],
    });

    expect(audit.delegations).toEqual([
      { package: "@app/cache", via: "es-toolkit", status: "unbacked", stateSharingEstablished: false },
      { package: "@app/state", via: "react", status: "backed", stateSharingEstablished: false },
    ]);
    expect(subjectsOf(withCode(audit.diagnostics, "undelegated-workspace-module-identity"))).toEqual(["@app/cache"]);
  });

  // The second review's first finding. `backed` means every check ran and passed; with the
  // package's imports unstated, the reachability half never ran, so `backed` would claim
  // something nobody verified.
  it("marks a delegation undetermined when the package's imports were not stated", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        { name: "@app/state", directory: "packages/state", moduleIdentity: { kind: "delegated", via: "react" } },
      ],
    };
    const audit = auditWorkspaceSource({
      workspace: delegating,
      dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }],
    });

    expect(audit.diagnostics).toEqual([]);
    expect(audit.delegations).toEqual([
      {
        package: "@app/state",
        via: "react",
        status: "undetermined",
        gaps: ["package-imports-absent"],
        stateSharingEstablished: false,
      },
    ]);
    expect(formatWorkspaceSourceAudit(audit)).toContain("(undetermined: package-imports-absent)");
  });

  // Both abstentions at once, and neither may read as `backed`.
  it("names every reason a delegation could not be decided", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        { name: "@app/state", directory: "packages/state", moduleIdentity: { kind: "delegated", via: "react" } },
      ],
    };
    const audit = auditWorkspaceSource({ workspace: delegating });

    expect(audit.delegations).toEqual([
      {
        package: "@app/state",
        via: "react",
        status: "undetermined",
        gaps: ["decision-list-absent", "package-imports-absent"],
        stateSharingEstablished: false,
      },
    ]);
  });

  // A check that can run still runs when another input is missing: the declaration is
  // decorative whether or not anyone stated the decisions, and returning at the first
  // absent input would have called that undetermined instead of unbacked.
  it("still refuses a decorative delegation when the decision list is absent", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          imports: ["es-toolkit"],
          moduleIdentity: { kind: "delegated", via: "react" },
        },
      ],
    };
    const audit = auditWorkspaceSource({ workspace: delegating });

    expect(audit.delegations).toEqual([
      { package: "@app/state", via: "react", status: "unbacked", stateSharingEstablished: false },
    ]);
    expect(withCode(audit.diagnostics, "undelegated-workspace-module-identity")[0]?.message).toContain(
      "delegates nothing",
    );
  });

  // The second review's second finding. A lock with two records for one module has no
  // single provider, and #6 refuses the same list — so one arbitarily chosen record must
  // not be enough to call a delegation backed, in either array order.
  it("refuses to call a delegation backed when two decisions cover the module", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          imports: ["react"],
          moduleIdentity: { kind: "delegated", via: "react" },
        },
      ],
    };
    const host: DependencyDecision = { strategy: "host", packageName: "react", globalName: "React" };
    const inline = inlineDecision("react");

    for (const dependencies of [
      [host, inline],
      [inline, host],
    ]) {
      const audit = auditWorkspaceSource({ workspace: delegating, dependencies });

      expect(audit.delegations).toEqual([
        {
          package: "@app/state",
          via: "react",
          status: "undetermined",
          gaps: ["decision-list-conflicted"],
          stateSharingEstablished: false,
        },
      ]);
      const reported = withCode(audit.diagnostics, "conflicting-module-identity-decisions");
      expect(reported).toHaveLength(1);
      expect(reported[0]?.subject).toBe("react");
      expect(reported[0]?.message).toContain("(`host`, `inline`)");
      expect(reported[0]?.fixOwner).toBe("dependency-decision");
    }
  });

  it("marks a delegation undetermined when no decision list was supplied", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          imports: ["react"],
          moduleIdentity: { kind: "delegated", via: "react" },
        },
      ],
    };

    // Neither `backed` (nobody checked) nor `unbacked` (nothing failed) — and not
    // missing either, because an empty list would read as "no declarations".
    const audit = auditWorkspaceSource({ workspace: delegating });
    expect(audit.diagnostics).toEqual([]);
    expect(audit.delegations).toEqual([
      {
        package: "@app/state",
        via: "react",
        status: "undetermined",
        gaps: ["decision-list-absent"],
        stateSharingEstablished: false,
      },
    ]);
    expect(formatWorkspaceSourceAudit(audit)).toContain("(undetermined: decision-list-absent)");
  });

  it("names every strategy when several decisions name one workspace package", () => {
    const audit = auditWorkspaceSource({
      workspace: workspace(),
      dependencies: [
        inlineDecision("@app/ui"),
        { strategy: "host", packageName: "@app/ui", globalName: "React" },
      ],
    });

    const reported = withCode(audit.diagnostics, "workspace-package-decided-as-dependency");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('2 decisions name it (`host`, `inline`)');
  });

  it("refuses a delegation backed by inline, replace, or nothing at all", () => {
    const delegating = (imports?: readonly string[]): WorkspaceGraph => ({
      packages: [
        {
          name: "@app/state",
          directory: "packages/state",
          ...(imports === undefined ? {} : { imports }),
          moduleIdentity: { kind: "delegated", via: "react" },
        },
      ],
    });

    const decisions: readonly DependencyDecision[] = [
      inlineDecision("react"),
      {
        strategy: "replace",
        packageName: "react",
        rejection: {
          kind: "technical",
          code: "non-inlineable-asset",
          summary: "The published build needs a sibling asset.",
          remediation: "Use a browser-first React build.",
        },
      },
    ];

    for (const decision of decisions) {
      const reported = withCode(
        auditWorkspaceSource({ workspace: delegating(["react"]), dependencies: [decision] }).diagnostics,
        "undelegated-workspace-module-identity",
      );
      expect(reported, decision.strategy).toHaveLength(1);
      expect(reported[0]?.subject).toBe("@app/state");
      expect(reported[0]?.fixOwner).toBe("workspace-graph");
    }

    // No decision at all: nothing says the page provides the module.
    const undecided = withCode(
      auditWorkspaceSource({ workspace: delegating(["react"]), dependencies: [] }).diagnostics,
      "undelegated-workspace-module-identity",
    );
    expect(undecided[0]?.message).toContain("no decision covers that module");
  });

  it("refuses a delegation to workspace source even with no decisions supplied", () => {
    const delegating: WorkspaceGraph = {
      packages: [
        { name: "@app/state", directory: "packages/state", imports: ["@app/ui"] },
        {
          name: "@app/ui",
          directory: "packages/ui",
          moduleIdentity: { kind: "delegated", via: "@app/state" },
        },
      ],
    };

    const reported = withCode(
      auditWorkspaceSource({ workspace: delegating }).diagnostics,
      "undelegated-workspace-module-identity",
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.subject).toBe("@app/ui");
    // Workspace source cannot back a delegation whether or not any decisions were
    // stated, which is why this half does not abstain with them.
    expect(reported[0]?.message).toContain("workspace source");
  });

  it("refuses a delegation the package does not import, and abstains when its imports are unstated", () => {
    const delegating = (imports?: readonly string[]): WorkspacePackageRecord => ({
      name: "@app/state",
      directory: "packages/state",
      ...(imports === undefined ? {} : { imports }),
      moduleIdentity: { kind: "delegated", via: "react" },
    });
    const dependencies: readonly DependencyDecision[] = [{ strategy: "host", packageName: "react", globalName: "React" }];

    // Stated imports that do not reach the delegated module: the declaration
    // delegates nothing.
    const decorative = withCode(
      auditWorkspaceSource({ workspace: { packages: [delegating(["es-toolkit"])] }, dependencies }).diagnostics,
      "undelegated-workspace-module-identity",
    );
    expect(decorative).toHaveLength(1);
    expect(decorative[0]?.message).toContain("delegates nothing");

    // An unstated imports list is not an empty one, so this cannot be concluded.
    expect(
      auditWorkspaceSource({ workspace: { packages: [delegating()] }, dependencies }).diagnostics,
    ).toEqual([]);

    // A package that imports the delegated module through a subpath has delegated
    // to it.
    expect(
      auditWorkspaceSource({ workspace: { packages: [delegating(["react/jsx-runtime"])] }, dependencies }).diagnostics,
    ).toEqual([]);
  });

  it("orders and collapses its diagnostics independently of the input order", () => {
    const forward = auditWorkspaceSource({
      workspace: workspace(),
      dependencies: [],
      entryModuleIds: ["@app/domain"],
      externalImports: ["@app/ui/theme.css", "@app/ui"],
      frontendLibraries: [{ libraryId: "@app/ui" }],
    });
    const backward = auditWorkspaceSource({
      workspace: { packages: [...workspace().packages].reverse() },
      dependencies: [],
      entryModuleIds: ["@app/domain"],
      externalImports: ["@app/ui", "@app/ui/theme.css"],
      frontendLibraries: [{ libraryId: "@app/ui" }],
    });

    expect(subjectsOf(forward.diagnostics)).toEqual(subjectsOf(backward.diagnostics));
    expect(forward.diagnostics).toEqual(backward.diagnostics);
    expect(forward.packages).toEqual(backward.packages);
    // Two external imports of one package are one problem, reported once, in the
    // order the code table declares rather than the order the checks happened to run.
    expect(codesOf(forward.diagnostics)).toEqual([
      "workspace-source-left-external",
      "workspace-source-left-external",
      "workspace-package-in-frontend-libraries",
      "unresolved-workspace-transitive-dependency",
      "unresolved-workspace-transitive-dependency",
    ]);
  });

  it("surfaces the graph's own problems through the audit", () => {
    const audit = auditWorkspaceSource({
      workspace: { packages: [{ name: "  ", directory: "packages/unnamed" }] },
    });

    expect(codesOf(audit.diagnostics)).toEqual(["workspace-graph-conflict"]);
    // A record with no usable name is identified by its directory, which is the only
    // thing about it a reader can act on.
    expect(audit.diagnostics[0]?.subject).toBe("packages/unnamed");
    expect(audit.packages).toEqual([]);
  });

  it("reports the closure it traced, and says so when there is nothing to report", () => {
    const report = formatWorkspaceSourceAudit(
      auditWorkspaceSource({
        workspace: workspace(),
        dependencies: [],
        entryModuleIds: ["@app/domain"],
      }),
    );

    expect(report).toContain("Workspace source in the closure: @app/domain, @app/tokens");
    expect(report).toContain("Published dependencies reached through it: es-toolkit, react-dom");
    expect(report).toContain("Cycles: (none)");
    expect(report).toContain("2 workspace source diagnostic(s)");
  });

  it("gives every code a remediation and a fix owner", () => {
    for (const code of WORKSPACE_SOURCE_DIAGNOSTIC_CODES) {
      const rule = WORKSPACE_SOURCE_DIAGNOSTIC_RULES[code];
      expect(rule.label.length, code).toBeGreaterThan(0);
      expect(rule.states.length, code).toBeGreaterThan(0);
      expect(rule.remediation.length, code).toBeGreaterThan(0);
      expect(rule.fixOwner.length, code).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The guarantees
// ---------------------------------------------------------------------------

describe("the workspace source guarantees", () => {
  /**
   * #14's acceptance criteria, each against the promise that carries it.
   *
   * Written out so a criterion cannot be dropped silently: a new criterion either
   * maps to a guarantee or the list changes deliberately.
   */
  const ACCEPTANCE_CRITERIA_GUARANTEES = [
    // Resolution follows the Vite+/pnpm workspace graph.
    "workspace-source-flattened-into-the-cell",
    // Tree-shaking can remove unused workspace exports where supported.
    "tree-shaking-not-defeated-by-the-toolchain",
    // Transitive third-party dependencies enter the decision pipeline.
    "transitive-third-party-dependencies-decided",
    // Circular dependencies identify the packages and the import chain.
    "workspace-import-graph-is-acyclic",
    // Development-stage source sharing does not imply deployed module sharing.
    "cells-do-not-share-workspace-module-state",
  ] as const;

  it("carries every acceptance criterion of #14 on a recorded promise", () => {
    for (const id of ACCEPTANCE_CRITERIA_GUARANTEES) {
      expect(WORKSPACE_SOURCE_GUARANTEE_IDS).toContain(id);
      const guarantee = findWorkspaceSourceGuarantee(id);
      expect(guarantee.statement.length).toBeGreaterThan(0);
      expect(guarantee.howToCheck.length).toBeGreaterThan(0);
    }
  });

  it("names the promises no build-time code can break, rather than leaving them unsaid", () => {
    const referenced = new Set(
      WORKSPACE_SOURCE_DIAGNOSTIC_CODES.flatMap(code => WORKSPACE_SOURCE_DIAGNOSTIC_RULES[code].breaksGuarantees),
    );

    // A diagnostic may only break a promise that exists.
    for (const id of referenced) {
      expect(WORKSPACE_SOURCE_GUARANTEE_IDS, id).toContain(id);
    }

    // Two promises have no build-time failure mode. Naming them here is what stops a
    // new guarantee from quietly joining them: a guarantee nothing can violate is
    // either a report the contract owes or a sentence that should not be a guarantee.
    expect([...WORKSPACE_SOURCE_GUARANTEE_IDS].filter(id => !referenced.has(id)).sort()).toEqual([
      // real-runtime: only a page shows whether two cells share state.
      "cells-do-not-share-workspace-module-state",
      // The bundler's property; the artifact diff is where it is observed (#7).
      "tree-shaking-not-defeated-by-the-toolchain",
    ]);
  });

  it("separates local checks from real-runtime ones", () => {
    const local = locallyCheckableWorkspaceSourceGuarantees();
    const runtime = realRuntimeWorkspaceSourceGuarantees();

    expect(local.length + runtime.length).toBe(WORKSPACE_SOURCE_GUARANTEES.length);
    expect(runtime.map(guarantee => guarantee.id)).toEqual(["cells-do-not-share-workspace-module-state"]);
    expect(runtime[0]?.howToCheck).toContain("two cells");
    // The real-runtime half is the anti-claim: nothing local can establish that two
    // cells do *not* share what they appear to share.
    expect(local.map(guarantee => guarantee.id)).not.toContain("cells-do-not-share-workspace-module-state");
  });

  it("finds a guarantee by id and refuses a typo", () => {
    expect(findWorkspaceSourceGuarantee("workspace-import-graph-is-acyclic").level).toBe("local");
    expect(() => findWorkspaceSourceGuarantee("no-such-guarantee" as "workspace-import-graph-is-acyclic")).toThrow(
      /Unknown workspace source guarantee/,
    );
  });

  it("classifies reuse, and requires delegation exactly where the guard looks", () => {
    expect(WORKSPACE_SOURCE_REUSE_CLASSES.map(entry => entry.id)).toEqual([...WORKSPACE_SOURCE_REUSE_CLASS_IDS]);

    // #14's two "always safe" classes, and the two that are safe to reuse while
    // sharing nothing.
    expect(findWorkspaceSourceReuseClass("types").safety).toBe("always-safe");
    expect(findWorkspaceSourceReuseClass("pure-functions-and-constants").safety).toBe("always-safe");
    expect(findWorkspaceSourceReuseClass("components-and-hooks").safety).toBe("cell-local");
    expect(findWorkspaceSourceReuseClass("react-context").safety).toBe("cell-local");

    // The Context statement is the exported anti-claim rather than a second sentence
    // that could drift from it.
    expect(findWorkspaceSourceReuseClass("react-context").statement).toBe(WORKSPACE_CONTEXT_SEMANTICS);
    expect(WORKSPACE_CONTEXT_SEMANTICS).toContain("local to the Cell's React tree");

    // The classes that require delegation are the ones the `moduleIdentity` guard
    // exists to check; the audit's delegation tests are that guard.
    expect(workspaceReuseClassesRequiringDelegation().map(entry => entry.id)).toEqual([
      "module-scope-mutable-state",
      "module-initialisation-side-effects",
    ]);

    expect(() => findWorkspaceSourceReuseClass("no-such-class" as "types")).toThrow(
      /Unknown workspace source reuse class/,
    );
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("workspace source decision provenance", () => {
  it("points at #14 and cites every governing Spec", () => {
    expect(WORKSPACE_SOURCE_DECISION.issue).toBe(14);
    expect(WORKSPACE_SOURCE_DECISION_REFERENCE).toBe("#14");
    expect(WORKSPACE_SOURCE_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/14",
    );
    // #15 is in the list because it is the implementation Issue that supplies the
    // graph #14 takes as an argument — the contract and the code that feeds it are
    // bound together, and a report about either has to name both.
    expect(WORKSPACE_SOURCE_GOVERNING_DECISIONS.map(source => `#${source.issue}`)).toEqual([
      "#4",
      "#5",
      "#6",
      "#14",
      "#15",
    ]);
    expect(WORKSPACE_SOURCE_GOVERNING_SPEC_REFERENCE_LINE).toBe(
      "Governing architecture Spec Issue(s): #4, #5, #6, #14, #15",
    );
  });

  it("cites every governing Spec in its own source", () => {
    const source = readRepositoryFile("packages", "cell-compiler", "src", "workspace-source.ts");
    expect(citesEveryArchitectureDecision(source)).toBe(true);
    expect(citesDecision(source, WORKSPACE_SOURCE_DECISION)).toBe(true);
  });

  // The contract's stated boundary: the graph is an argument, not something
  // discovered here. #6 forbids inventing a second module resolver, and a filesystem
  // read would be the first step of one.
  it("stays out of resolution: no filesystem, no module loader", () => {
    const source = readRepositoryFile("packages", "cell-compiler", "src", "workspace-source.ts");
    expect(source).not.toMatch(/node:fs/);
    expect(source).not.toMatch(/node:path/);
    expect(source).not.toMatch(/node:module/);
    expect(source).not.toMatch(/require\(/);
  });

  // #15's answer to the same boundary, and the reason the loader is a *separate*
  // module rather than an addition to this one: the contract still takes its graph
  // as an argument and still reads nothing, while something else does the reading.
  // A loader folded into `workspace-source.ts` would have broken the check above,
  // which is exactly the drift this pair of tests exists to catch.
  it("keeps the graph loader out of the contract, and cites #15 where it lives", () => {
    const loader = readRepositoryFile("packages", "cell-compiler", "src", "workspace-graph.ts");
    expect(loader).toMatch(/node:fs/);
    expect(citesDecision(loader, WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(true);
    expect(citesEveryArchitectureDecision(loader)).toBe(true);
    // The loader consumes the contract rather than restating it: the index and the
    // record type come from `workspace-source`, so there is no second definition of
    // what a workspace package is.
    expect(loader).toMatch(/from "\.\/workspace-source"/);
    expect(loader).not.toMatch(/interface WorkspacePackageRecord/);
    expect(loader).not.toMatch(/function indexWorkspaceGraph/);
  });

  // #14's acceptance criterion 5. The sentence is asserted in the repository's agent
  // rules because the failure it prevents is a reading failure, and the invariant is
  // exported so the rule and the contract cannot drift apart.
  it("keeps the workspace sharing invariant in the repository agent rules", () => {
    const agents = readRepositoryFile("AGENTS.md");
    expect(agents).toContain(WORKSPACE_SOURCE_SHARING_INVARIANT);
    expect(agents).toMatch(/flattens that source into each consuming cell artifact/);
    expect(agents).toMatch(/never receive a dependency decision/);
    expect(agents).toMatch(/never appear in `frontendLibraries`/);
  });
});
