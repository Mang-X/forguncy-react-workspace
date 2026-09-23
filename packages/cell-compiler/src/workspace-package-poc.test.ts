/**
 * The workspace package flattening PoC: `examples/workspace-package` compiled for
 * real, through the real pnpm workspace graph.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening
 * PoC" (https://github.com/Mang-X/forguncy-react-workspace/issues/15), which owns
 * the two acceptance criteria #14 could not evidence
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14):
 *
 * - *"Workspace package resolution follows the Vite+/pnpm workspace graph **end to
 *   end** — a real compile through the workspace graph, not the contract's input
 *   type."* The graph this file compiles against is read from the repository's own
 *   `pnpm-workspace.yaml` and each member's `package.json` by
 *   `loadPnpmWorkspaceGraph`, never written by hand here. A hand-written graph would
 *   be the contract's input type wearing the PoC's clothes, which is the one thing
 *   that criterion rules out.
 * - *"Tree-shaking removes unused workspace exports where the bundler supports it,
 *   asserted against a compiled artifact."* Asserted against the compiled string,
 *   with comments removed first — see {@link codeOf}.
 *
 * The remaining criteria are covered as follows:
 *
 * | criterion | where |
 * | --- | --- |
 * | normal workspace imports, no path rewriting | `reads the package names...`, and the source-shape test below |
 * | generated Cell has no runtime dependency on another workspace package | `flattens...` (no external import, no `frontendLibraries`, no workspace name in code) |
 * | transitive third-party dependencies honor the decision system | `routes a workspace package's react import through the decision system` |
 * | circular dependencies surface a useful diagnostic | `reports a real circular workspace dependency` (a fixture workspace) |
 * | a shared React component renders in a real runtime | `runs the flattened component...` |
 *
 * ## What is deliberately *not* claimed here
 *
 * Two things, and both matter more than the assertions above.
 *
 * 1. **AGENTS.md rule 7.** Nothing here is Forguncy runtime compatibility. These
 *    tests prove compilation, assembly and evaluation inside `node:vm` against a
 *    React the test itself supplies. The real ReactCellType execution is performed
 *    against a real project and recorded on #15, not asserted here; #15's last
 *    criterion ("real-runtime validate the generated Cell after MCP sync becomes
 *    available") is #20's path and stays open until it runs.
 * 2. **`cells-do-not-share-workspace-module-state`.** The anti-claim is that two
 *    Cells share no module state, and it is a property of what a *page* runs. The
 *    sandbox below evaluates one artifact; it can show that this Cell's component
 *    works, never that a second Cell would not see its state. #14 records that as
 *    `real-runtime` for exactly this reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import { createRequire } from "node:module";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact";
import type { CompileCellOutcome } from "./artifact";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry";
import { createRolldownCellBundler } from "./rolldown-bundler";
import { auditWorkspaceSource, traceWorkspaceSourceClosure, workspacePackageFor } from "./workspace-source";
import { loadPnpmWorkspaceGraph } from "./workspace-graph";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "workspace-package");
const entry = "src/App.tsx";

/**
 * The graph read from the real project files, exactly once.
 *
 * Read from `repositoryRoot` rather than from the example: `examples/workspace-package`
 * is a *member* of the repository's workspace, not a workspace of its own, and the
 * interesting property is that the compiler's graph is the same one `pnpm install`
 * linked. A graph read from anywhere else would be a second answer to "which
 * packages are local".
 */
const workspaceGraph = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
const workspaceIndex = workspaceGraph.index;

/**
 * The decisions a real project would supply for this Cell.
 *
 * `react` is `host` because that is #9's answer and the only one that keeps the
 * shared component on the page's React identity. Deliberately *only* `react`: the
 * two `@app/*` names must never appear here, and a test below asserts the audit
 * refuses them if they do — #14's rule is that a workspace package "never receives
 * a dependency decision and never appears in `frontendLibraries`".
 */
const DECISIONS: readonly DependencyDecision[] = [{ strategy: "host", packageName: "react", globalName: "React" }];

function compileExample(dependencies: readonly DependencyDecision[] = DECISIONS): Promise<CompileCellOutcome> {
  return compileCell({ entry, dependencies }, { bundler: createRolldownCellBundler({ dir: exampleRoot }) });
}

function compiledArtifactOf(outcome: CompileCellOutcome): Extract<CompileCellOutcome, { status: "compiled" }> {
  if (outcome.status !== "compiled") {
    throw new Error(`Expected a compiled artifact, got a rejection:\n${JSON.stringify(outcome.diagnostics, null, 2)}`);
  }
  return outcome;
}

/**
 * The artifact's code with comments removed.
 *
 * Load-bearing, and the reason is visible in the artifact itself: rolldown keeps
 * the authored JSDoc above a function it inlines, so an unused export's *name*
 * appears in the artifact inside the comment that documented it. A raw substring
 * test for `excerpt` therefore passes on a correctly tree-shaken artifact, which
 * is the opposite of what the tree-shaking criterion needs to show.
 *
 * Block comments and line comments only. This is not a lexer and does not need to
 * be: it is applied to a *generated* artifact, and the assertion it protects is
 * "is this identifier in the code", where a false positive (comment text that
 * survives) is the only failure mode that matters. A string literal that happened
 * to contain `/*` would be stripped too — and would then have to contain one of
 * the two distinctive export names below to affect any assertion here.
 */
function codeOf(artifact: CompileCellOutcome): string {
  return compiledArtifactOf(artifact)
    .artifact.code.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Sandbox evaluation
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const React = require("react") as Record<string, unknown>;
const { renderToString } = require("react-dom/server") as { renderToString: (element: unknown) => string };

/**
 * Evaluates an artifact in an isolated `vm` context seeded with the page's React.
 *
 * `node:vm` rather than the test process, for the reason the host-bridge tests
 * give: the artifact under test must read the *page* object through the generated
 * JSX runtime adapter — that is what #9's bridge exists for — and a sandbox makes
 * that observable. An artifact that had bundled its own React would ignore this
 * object entirely and fail here.
 *
 * The real React build, not a stub: the component under test calls `useState`, and
 * a stub that returned a fake hook would prove the wiring while proving nothing
 * about whether the code runs.
 */
function runArtifact(code: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { React, console };
  sandbox.globalThis = sandbox;
  new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
  return sandbox;
}

type CellComponent = () => unknown;

function componentFrom(sandbox: Readonly<Record<string, unknown>>): CellComponent {
  const component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
  if (typeof component !== "function") {
    throw new Error(`The artifact did not bind a function to ${CELL_ENTRY_COMPONENT_BINDING}.`);
  }
  return component as CellComponent;
}

// ---------------------------------------------------------------------------
// The PoC
// ---------------------------------------------------------------------------

describe("workspace package flattening PoC (#15)", () => {
  it("reads the workspace graph from the real pnpm manifest, not from this file", async () => {
    // The graph is the repository's, so the packages the compile resolves are the
    // ones `pnpm install` linked. An empty diagnostic list is the assertion that
    // the manifest's globs expanded to something the index could use.
    expect(workspaceGraph.diagnostics).toEqual([]);

    const names = workspaceIndex.packages.map(record => record.name);
    expect(names).toContain("@app/ui");
    expect(names).toContain("@app/tokens");
    expect(names).toContain("@examples/workspace-package");

    // The edge the transitive criteria depend on: `@app/ui` imports its sibling by
    // name, and the *manifest* is where that edge came from.
    const ui = workspacePackageFor(workspaceIndex, "@app/ui");
    expect(ui?.imports).toContain("@app/tokens");
    // And the published dependency it brings with it, which has to reach the
    // decision pipeline rather than be silently bundled.
    expect(ui?.imports).toContain("react");

    // A workspace-relative directory is what makes a diagnostic portable; an
    // absolute one would carry this machine into a report.
    expect(ui?.directory).toBe("examples/workspace-package/packages/ui");
  });

  it("authors ordinary workspace imports, with no path rewriting in the source", () => {
    // The comment block is the file's own documentation, so the assertions below
    // run against the *code*. The negative halves are what make this a claim: a
    // relative `../../packages/ui` import would compile just as well and would not
    // be workspace resolution.
    const code = readFileSync(join(exampleRoot, entry), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // #15's first criterion, as source shape: the imports are package *names*.
    expect(code).toContain('from "@app/ui"');
    expect(code).toContain('from "@app/tokens"');
    expect(code).not.toContain("../../packages");
    expect(code).not.toContain("alias");
    expect(code).not.toContain("paths");
    // No imports into the workspace package's files, which is the coupling a
    // package boundary exists to prevent.
    expect(code).not.toMatch(/@app\/(ui|tokens)\/src\//);
  });

  it("resolves the cell's own imports entirely inside the workspace graph", () => {
    // Every bare specifier the Cell writes, classified by #14's own function
    // against the real graph. `@app/ui` and `@app/tokens` are workspace packages
    // and `./orders` is a source file — the two kinds the walk has to tell apart,
    // both present in one real compile.
    const closure = traceWorkspaceSourceClosure(workspaceIndex, ["@app/ui", "@app/tokens", "./orders"]);

    expect(closure.packages).toEqual(["@app/tokens", "@app/ui"]);
    expect(closure.cycles).toEqual([]);

    // `react` is the one published module reached through workspace source, and it
    // is reported with the package that imports it — which is what lets the
    // decision check below be about a *reachable* dependency rather than a guess.
    expect(closure.externalModules).toEqual([{ moduleId: "react", importedBy: ["@app/ui"] }]);
  });

  it("flattens the workspace source into one self-contained artifact", async () => {
    const code = codeOf(await compileExample());

    // The source really is inlined: the component body and the pure helper are
    // present as code, and the JSX the package authored was compiled too.
    expect(code).toContain("function ThemeScope");
    expect(code).toContain("function formatMoney");
    expect(code).toContain("theme-scope");
    expect(code).toContain("workspace package flattening PoC");

    // "No runtime dependency on another workspace package", three ways. A
    // surviving import or `require` would mean the page has to resolve a module
    // nothing installs; a `frontendLibraries` entry would tell it to load a
    // library that does not exist.
    expect(code).not.toMatch(/\bfrom\s*["']@app\//);
    expect(code).not.toContain('require("@app/ui")');
    expect(code).not.toContain('require("@app/tokens")');
    expect(code).not.toMatch(/\bimport\s*\(/);
    const artifact = compiledArtifactOf(await compileExample()).artifact;
    expect(artifact.frontendLibraries).toEqual([]);
    const libraries = JSON.stringify(artifact.frontendLibraries);
    expect(libraries).not.toContain("@app/");

    // The artifact is the #5/#6 wrapper around the bundle, not a web bundle.
    expect(code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);
  });

  it("tree-shakes the workspace exports the Cell does not use", async () => {
    const code = codeOf(await compileExample());

    // Both directions, because either alone is passable by an artifact that is
    // wrong: "the used code is present" passes on a bundle that failed to shake,
    // and "the unused code is absent" passes on an empty artifact.
    //
    // `formatMoney` is imported by the Cell, so it survives.
    expect(code).toContain("function formatMoney");
    // `excerpt` is a direct export of `@app/ui` the Cell never imports. Its name
    // survives only in the JSDoc that `codeOf` strips, so this is the real test.
    expect(code).not.toContain("function excerpt");
    expect(code).not.toContain("excerpt");
    // `trimmed` is two workspace hops away — an export of `@app/tokens` reached
    // through `@app/ui` — so the transitive case is covered as well.
    expect(code).not.toContain("function trimmed");
    expect(code).not.toContain("trimmed");

    // The values the Cell *does* use from the second package are inlined rather
    // than dropped, which is what makes the two absences above tree-shaking rather
    // than a package that failed to load at all.
    expect(code).toContain("surface-step=");
    expect(code).toContain("data-surface-radius");
  });

  it("compiles the package's react import through the host bridge, not a second copy", async () => {
    const code = codeOf(await compileExample());

    // #9's bridge, by its generated *code* rather than by its banner: the banner is
    // a comment and the bundler drops it, while these identifiers are what the
    // bridge actually emits. The module reads the page's React off the global.
    expect(code).toContain('globalThis["React"]');
    expect(code).toContain("__fgcHostBridgeJsx");
    expect(code).toContain("__fgcHostBridgeReact");

    // The package's `useState` reaches the page's React *through the generated
    // bridge module* — the binding is the interposed module, and that module's
    // exports are the page object. `globalThis["React"].useState` is deliberately
    // not what is asserted: the bridge is the indirection that keeps the host
    // identity, and asserting the direct read would pass for an artifact that had
    // bypassed it.
    expect(code).toContain("import__cell_host_react.useState");

    // No React implementation is bundled. A second copy would have to define React's
    // own API surface, so the absence of its distinctive members is the evidence —
    // this is the "no bundled second React" half of the criterion.
    expect(code).not.toMatch(/react\.production\.min\.js/);
    expect(code).not.toContain("__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED");
    expect(code).not.toContain("react.element");
  });

  it("routes a workspace package's react import through the decision system", async () => {
    // Criterion 3, as an executed check rather than a description: `react` is only
    // reached through `@app/ui`, and the audit walks the real graph to find it.
    const closure = traceWorkspaceSourceClosure(workspaceIndex, ["@app/ui"]);
    const reached = closure.externalModules.map(entry => entry.moduleId);
    expect(reached).toContain("react");

    const declared = auditWorkspaceSource({
      workspace: { packages: [...workspaceIndex.packages] },
      dependencies: DECISIONS,
      entryModuleIds: ["@app/ui", "@app/tokens"],
    });
    // With `react` decided, the transitive check is satisfied.
    expect(declared.diagnostics).toEqual([]);

    // The negative half, which is what makes the positive one meaningful: with the
    // decision list *empty* the same trace reports `react` as undecided, naming the
    // workspace package that reaches it. That is "the transitive dependency went
    // through the pipeline" rather than "nothing ever complained".
    const undecided = auditWorkspaceSource({
      workspace: { packages: [...workspaceIndex.packages] },
      dependencies: [],
      entryModuleIds: ["@app/ui", "@app/tokens"],
    });
    const reported = undecided.diagnostics.filter(
      diagnostic => diagnostic.code === "unresolved-workspace-transitive-dependency",
    );
    expect(reported.map(diagnostic => diagnostic.subject)).toEqual(["react"]);
    expect(reported[0]?.message).toContain("@app/ui");
  });

  it("refuses a dependency decision that names a workspace package", () => {
    // #14's rule, executed: a workspace package is source, so a decision about one
    // is an error in *either* direction — and `frontendLibraries` likewise. The
    // `react` decision is included so the negative half below is meaningful: the
    // audit has to report the workspace findings *without* also flagging the
    // published dependency that is correctly decided.
    const audit = auditWorkspaceSource({
      workspace: { packages: [...workspaceIndex.packages] },
      dependencies: [...DECISIONS, { strategy: "inline", packageName: "@app/ui" }],
      entryModuleIds: ["@app/ui"],
      frontendLibraries: [{ libraryId: "@app/ui" }],
      externalImports: ["@app/ui"],
    });

    const codes = audit.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("workspace-package-decided-as-dependency");
    expect(codes).toContain("workspace-package-in-frontend-libraries");
    expect(codes).toContain("workspace-source-left-external");
    // None of them is about the published dependency that *is* decided correctly.
    expect(audit.diagnostics.some(diagnostic => diagnostic.subject === "react")).toBe(false);
  });

  it("reports a real circular workspace dependency as a structured diagnostic", async () => {
    // A cycle has to be *declared* by two real packages to be read from a manifest,
    // so this one is a fixture workspace rather than the repository: adding a
    // circular dependency to this repository's own graph to test the detector would
    // be a project defect committed for a test. The graph is still loaded from a
    // real `pnpm-workspace.yaml` and real `package.json` files by the same loader.
    const fixtureRoot = join(packageRoot, "tests", "fixtures", "circular-workspace");
    const fixture = await loadPnpmWorkspaceGraph({ root: fixtureRoot });
    expect(fixture.diagnostics).toEqual([]);

    const audit = auditWorkspaceSource({
      workspace: { packages: [...fixture.index.packages] },
      dependencies: [],
      entryModuleIds: ["@fixture/a"],
    });

    const cycle = audit.diagnostics.filter(diagnostic => diagnostic.code === "circular-workspace-dependency");
    expect(cycle).toHaveLength(1);
    // The chain names both packages and closes on its first member, which is #14's
    // requirement: "identify the relevant workspace packages/import chain".
    expect(cycle[0]?.message).toContain("@fixture/a → @fixture/b → @fixture/a");
    expect(cycle[0]?.fixOwner).toBe("workspace-graph");
    expect(cycle[0]?.remediation.length ?? 0).toBeGreaterThan(0);
    // And it is reachable as a closure result too, not only as a diagnostic.
    expect(traceWorkspaceSourceClosure(fixture.index, ["@fixture/a"]).cycles).toEqual([
      { chain: ["@fixture/a", "@fixture/b", "@fixture/a"] },
    ]);
  });

  it("runs the flattened shared component against a real React", async () => {
    // The third criterion, executed: the component the workspace package declares
    // has to *render*, with its own state hook working, inside the generated Cell.
    const sandbox = runArtifact(codeOf(await compileExample()));
    const markup = renderToString(componentFrom(sandbox)() as never);

    // The component's own wrapper and computed attributes are in the output, so
    // the source that ran is the package's.
    expect(markup).toContain('data-workspace-component="theme-scope"');
    expect(markup).toContain("workspace package flattening PoC");
    // Both workspace packages contributed: the component is `@app/ui`'s and the
    // value it renders came from `@app/tokens` through `formatMoney`.
    expect(markup).toContain("CNY 1234.50");
    // The Cell's own relative import rendered too — the `source-file` kind.
    expect(markup).toContain("surface-step=2");
    // `useState` came from the page's React: the hook ran, so the counter rendered.
    expect(markup).toContain("clicks=0");

    // The example computes its own verdict from the workspace packages' functions,
    // and the verdict is what makes this more than "a string rendered". Both the
    // marker and the verdict itself are asserted: a `fail` would satisfy a
    // substring test on `"fail"`, so the two assertions are on the *answers*.
    expect(markup).toContain('data-workspace-self-check="pass"');
    expect(markup).toContain("money=pass");
    expect(markup).toContain("radius=pass");
    expect(markup).toContain("step=pass");
    expect(markup).not.toContain("=fail");
  });

  it("produces byte-identical artifacts for identical inputs", async () => {
    // #6's determinism guarantee, re-asserted through the workspace path: a graph
    // loaded from disk is an input like any other, and an ordering that leaked out
    // of the filesystem would show up here.
    const original = compiledArtifactOf(await compileExample());
    const rerun = compiledArtifactOf(await compileExample());

    expect(rerun.artifact.code).toBe(original.artifact.code);
    expect(rerun.artifact.frontendLibraries).toEqual(original.artifact.frontendLibraries);
  });
});
