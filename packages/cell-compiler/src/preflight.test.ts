/**
 * The two pre-bundle refusals, at the seam that has to make them.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening PoC"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/15), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * Both findings were raised in PR #63's review and reproduced before either was
 * fixed. Each test here states the failure mode it pins, because in both cases the
 * *absence* of the check looks like success: a compile that returns `compiled` is
 * exactly what a broken implementation produces, so "it rejects" is the assertion
 * that carries information.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { rolldown } from "rolldown";
import { scan } from "rolldown/experimental";
import { afterAll, describe, expect, it } from "vitest";

import { compileCell, formatCompileCellOutcome } from "./artifact";
import type { BundledCellModule, CellBundlerPort, CompileCellOutcome } from "./artifact";
import { createRolldownCellBundler } from "./rolldown-bundler";
import { loadPnpmWorkspaceGraph } from "./workspace-graph";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "workspace-package");
const packageSourceDirectory = dirname(fileURLToPath(import.meta.url));

const scratchRoots: string[] = [];

/** A graph-less fixture: `resolveEntrySpecifiers` must never be reached for it. */
const TRIVIAL_WORKSPACE_FREE_BUNDLER: CellBundlerPort = {
  resolveEntrySpecifiers: async () => {
    throw new Error("a graph-less compile must not run the preflight");
  },
  bundle: async (): Promise<BundledCellModule> => ({
    code: `function App() { return null; }`,
    externalImports: [],
    inlinedPackages: [],
  }),
};

/** A throwaway project: a cell importing `name` from a locally installed package. */
function projectImporting(name: string, source: string): string {
  const dir = join(packageRoot, `preflight-${name.replace(/[^a-z0-9]/gi, "-")}`);
  scratchRoots.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "src", "App.tsx"), `import * as local from ${JSON.stringify(name)};\nexport function App() { return <div>{local}</div>; }\n`);
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  return dir;
}

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function rejectionOf(outcome: CompileCellOutcome): { codes: readonly string[]; workspaceCodes: readonly string[] } {
  if (outcome.status !== "rejected") {
    throw new Error(`Expected a rejection, got: ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return {
    codes: outcome.diagnostics.map(diagnostic => diagnostic.code),
    workspaceCodes: (outcome.workspace?.diagnostics ?? []).map(diagnostic => diagnostic.code),
  };
}

// ---------------------------------------------------------------------------
// One: a decision must not be able to intercept workspace source
// ---------------------------------------------------------------------------

describe("a dependency decision that can intercept workspace source", () => {
  it("rejects the compile instead of silently discarding the local package", async () => {
    // The failure this pins, exactly: `antd` is *both* a host-bridge mapping and,
    // in this graph, a local workspace package. The bundler consults the host plan
    // during resolution, so without a pre-bundle check the interposition replaces
    // the import with the plan's virtual module — the local source is never
    // resolved, never bundled, and the artifact contains no workspace import for the
    // artifact audits to reject. The compile returned `compiled` and the artifact
    // used `globalThis.antd`, so the cell silently got the page's antd instead of
    // the package it imported.
    const dir = projectImporting("antd", 'exports.Button = function Button() { return "LOCAL-ANTD-SOURCE"; };\n');

    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [{ strategy: "host", packageName: "antd", globalName: "antd" }] },
      {
        bundler: createRolldownCellBundler({ dir }),
        workspace: { packages: [{ name: "antd", directory: "packages/antd", imports: [] }] },
      },
    );

    const { codes, workspaceCodes } = rejectionOf(outcome);
    expect(workspaceCodes).toContain("workspace-package-decided-as-dependency");
    // Nothing was built, so #14's vocabulary is the only one that speaks.
    expect(codes).toEqual([]);
  });

  it("rejects the same way when the interposing decision is an extension decision", async () => {
    // The other interception route, deliberately asserted separately: the check is
    // about the *effect* — a decision can replace workspace source during resolution
    // — not about which plan produced it. The two plans are separate code paths, so a
    // fix wired into only one of them would pass the host test above.
    const dir = projectImporting("@tanstack/react-query", "module.exports = { local: true };\n");

    const outcome = await compileCell(
      {
        entry: "src/App.tsx",
        dependencies: [
          {
            strategy: "extension",
            packageName: "@tanstack/react-query",
            libraryId: "tanstack-query",
            globalName: "TanStackQuery",
          },
        ],
      },
      {
        bundler: createRolldownCellBundler({ dir }),
        workspace: { packages: [{ name: "@tanstack/react-query", directory: "packages/query", imports: [] }] },
      },
    );

    const { workspaceCodes } = rejectionOf(outcome);
    expect(workspaceCodes).toContain("workspace-package-decided-as-dependency");
  });

  it("compiles when a decision names a package the graph does not claim", async () => {
    // The bound on the rule, and the reason it is a check about the *graph* rather
    // than about decisions alone: a `host` decision for `react` is entirely correct
    // when `react` is a published dependency. A check keyed on the decision alone
    // would refuse every ordinary host-mapped compile.
    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }] },
      {
        bundler: createRolldownCellBundler({ dir: exampleRoot }),
        workspace: (await loadPnpmWorkspaceGraph({ root: repositoryRoot })).graph,
      },
    );

    expect(outcome.status).toBe("compiled");
    expect(outcome.workspace?.diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two: a reachable cycle must stop the compile before the bundler runs
// ---------------------------------------------------------------------------

describe("a reachable workspace cycle", () => {
  /** A bundler that records whether it was asked to build, and never builds. */
  function recordingBundler(): CellBundlerPort & { readonly buildCalls: () => number; readonly resolveCalls: () => number } {
    let buildCalls = 0;
    let resolveCalls = 0;
    return {
      resolveEntrySpecifiers: async request => {
        resolveCalls += 1;
        // The entry imports `@cyc/a`, which closes the cycle.
        expect(request.entry).toBe("src/App.tsx");
        return ["@cyc/a"];
      },
      bundle: async (): Promise<BundledCellModule> => {
        buildCalls += 1;
        return { code: "/* should never be reached */", externalImports: [], inlinedPackages: [] };
      },
      buildCalls: () => buildCalls,
      resolveCalls: () => resolveCalls,
    };
  }

  const cyclic = {
    packages: [
      { name: "@cyc/a", directory: "packages/a", imports: ["@cyc/b"] },
      { name: "@cyc/b", directory: "packages/b", imports: ["@cyc/a"] },
    ],
  };

  it("rejects without calling bundle(), which is what 'before bundling' means", async () => {
    // The failure this pins: the audit used to run *after* `bundle()` returned, so
    // #14's "fail before bundling rather than to be resolved by whichever traversal
    // happens to run first" was not honoured — a real build was spent, and a bundler
    // error racing the check could hide the structured cycle diagnostic entirely.
    const bundler = recordingBundler();

    const outcome = await compileCell({ entry: "src/App.tsx", dependencies: [] }, { bundler, workspace: cyclic });

    expect(bundler.resolveCalls()).toBe(1);
    // The assertion that carries information: no code was generated.
    expect(bundler.buildCalls()).toBe(0);

    const { codes, workspaceCodes } = rejectionOf(outcome);
    expect(workspaceCodes).toContain("circular-workspace-dependency");
    expect(codes).toEqual([]);

    const cycle = (outcome.workspace?.diagnostics ?? []).find(
      diagnostic => diagnostic.code === "circular-workspace-dependency",
    );
    expect(cycle?.message).toContain("@cyc/a → @cyc/b → @cyc/a");
  });

  it("still calls bundle() when the cycle is not reachable from the entry", async () => {
    // The other bound: #14 requires a *reachable* cycle to fail, and an unreachable
    // one is a fact about a package the cell does not use. Refusing on it would fail
    // a compile for a dependency the artifact does not contain.
    //
    // The graph holds both a cycle and a standalone package, and this bundler
    // resolves only the standalone one — so the cycle is present but unreachable.
    let buildCalls = 0;
    const bundler: CellBundlerPort = {
      resolveEntrySpecifiers: async () => ["@cyc/standalone"],
      bundle: async (): Promise<BundledCellModule> => {
        buildCalls += 1;
        return { code: `function App() { return null; }`, externalImports: [], inlinedPackages: [] };
      },
    };

    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [] },
      {
        bundler,
        workspace: {
          packages: [...cyclic.packages, { name: "@cyc/standalone", directory: "packages/s", imports: [] }],
        },
      },
    );

    // The build ran, so the unbundlable graph did not stop it...
    expect(buildCalls).toBe(1);
    // ...and the cycle was not reported, because the closure never entered it.
    expect((outcome.workspace?.diagnostics ?? []).map(diagnostic => diagnostic.code)).not.toContain(
      "circular-workspace-dependency",
    );
    expect(outcome.workspace?.closure?.packages).toEqual(["@cyc/standalone"]);
  });
});

// ---------------------------------------------------------------------------
// The preflight is analysis-only, pinned against the *concrete* port
// ---------------------------------------------------------------------------

describe("the concrete bundler's preflight is an analysis pass", () => {
  it("uses Rolldown's analysis-only entry, not one that generates code", async () => {
    // The review's point, and the reason a mock cannot carry this test: a spy that
    // counts calls to `bundle()` proves only that `CellBundlerPort.bundle` was not
    // invoked. It says nothing about whether the *concrete* implementation generated
    // code, and the first version of `resolveEntrySpecifiers` did — it ran
    // `rolldown()` + `generate()`, which renders chunks and bundles them, merely
    // discarding the output. So the cycle was still discovered after Rolldown had
    // bundled once, and a failure from that pass would have won the race against the
    // structured diagnostic.
    //
    // Two assertions, and both are needed. The first establishes the fact the
    // implementation depends on — that `scan` and `generate` really do run different
    // stages — by observing them rather than trusting the API's name. The second
    // pins that the port uses the analysis-only one; it reads the module's source,
    // the same technique `workspace-source.test.ts` uses for its own "no filesystem"
    // boundary, because the choice of entry point is not otherwise observable from
    // outside.
    const scanStages: string[] = [];
    const generateStages: string[] = [];
    const spy = (into: string[]) => ({
      name: "stage-spy",
      resolveId(source: string) {
        into.push("resolve");
        return source.startsWith(" ") ? null : null;
      },
      transform() {
        into.push("transform");
        return null;
      },
      renderChunk() {
        into.push("renderChunk");
        return null;
      },
      generateBundle() {
        into.push("generateBundle");
      },
    });

    await scan({ input: join(exampleRoot, "src", "App.tsx"), transform: { jsx: "react-jsx" }, plugins: [spy(scanStages)] });

    const build = await rolldown({ input: join(exampleRoot, "src", "App.tsx"), transform: { jsx: "react-jsx" }, plugins: [spy(generateStages)] });
    await build.generate({ format: "iife", name: "__stageProbe", codeSplitting: false });
    await build.close();

    // `scan` stops after transform; `generate` additionally renders and bundles.
    expect([...new Set(scanStages)]).not.toContain("renderChunk");
    expect([...new Set(scanStages)]).not.toContain("generateBundle");
    expect([...new Set(generateStages)]).toContain("renderChunk");
    expect([...new Set(generateStages)]).toContain("generateBundle");

    // And the concrete port chose the analysis-only entry.
    const source = readFileSync(join(packageSourceDirectory, "rolldown-bundler.ts"), "utf8");
    expect(source).toMatch(/import \{ scan \} from "rolldown\/experimental"/);
    // The preflight's own body must not call `generate` — the defect being fixed was
    // exactly a `generate()` hidden inside it, and discarding the output was what made
    // it look harmless. Sliced between the preflight's declaration and the next
    // function, so the assertion is about that function rather than about the file.
    const preflightStart = source.indexOf("async function resolveEntrySpecifiersWithRolldown");
    const preflightBody = source.slice(
      preflightStart,
      source.indexOf("\nfunction renderEntryShim", preflightStart),
    );
    expect(preflightBody.length).toBeGreaterThan(0);
    expect(preflightBody).not.toContain(".generate(");
  });

  it("produces the same specifier set the build resolves", async () => {
    // The property the whole preflight rests on: the specifiers it audits are the
    // ones the build resolves. If these two ever disagreed, the audit would be
    // deciding about a graph the artifact does not have — and, as the review noted,
    // a fix wired into one path and not the other is exactly how that happens.
    const bundler = createRolldownCellBundler({ dir: exampleRoot });
    const resolveEntrySpecifiers = bundler.resolveEntrySpecifiers;
    // The concrete port always provides it; the type is optional for ports that do
    // not, and this test is about the concrete one.
    expect(resolveEntrySpecifiers).toBeDefined();
    if (resolveEntrySpecifiers === undefined) return;

    const decisions: readonly DependencyDecision[] = [
      { strategy: "host", packageName: "react", globalName: "React" },
    ];

    const preflight = await resolveEntrySpecifiers({ entry: "src/App.tsx", dependencies: decisions });
    const built = await bundler.bundle({
      entry: "src/App.tsx",
      dependencies: decisions,
      componentBinding: "__forguncyCellEntry",
    });

    expect(preflight).toEqual(built.referencedSpecifiers);
  });
});

// ---------------------------------------------------------------------------
// A graph without a port that can resolve it
// ---------------------------------------------------------------------------

describe("a workspace graph supplied to a port with no preflight capability", () => {
  it("refuses the compile rather than auditing after the build", async () => {
    // The bound on `resolveEntrySpecifiers` being optional. Optional keeps the
    // graph-less #6 boundary unchanged — a port that implements only `bundle` stays
    // complete for every caller who supplies no graph — but it must not become a
    // silent fallback: with a graph supplied, the pre-bundle guarantee is exactly
    // what makes #14's fatal findings observable, and auditing afterwards would
    // restore the defect the split exists to prevent.
    let buildCalls = 0;
    const bundlerWithoutPreflight: CellBundlerPort = {
      bundle: async (): Promise<BundledCellModule> => {
        buildCalls += 1;
        return { code: `function App() { return null; }`, externalImports: [], inlinedPackages: [] };
      },
    };

    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [] },
      { bundler: bundlerWithoutPreflight, workspace: { packages: [] } },
    );

    expect(outcome.status).toBe("rejected");
    // Nothing was built: the refusal is the point, not a late finding.
    expect(buildCalls).toBe(0);
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["bundler-failure"]);
    // The message names the missing capability and the two ways out, because
    // "the bundler failed" alone would not tell a caller what to change.
    expect(outcome.diagnostics[0]?.message).toContain("resolveEntrySpecifiers");
    expect(outcome.diagnostics[0]?.message).toContain("omit `workspace`");
  });

  it("compiles the same port when no graph is supplied", async () => {
    // The other half, and the reason the method can be optional at all: the identical
    // port is complete for a graph-less compile.
    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [] },
      {
        bundler: {
          bundle: async (): Promise<BundledCellModule> => ({
            code: `function App() { return null; }`,
            externalImports: [],
            inlinedPackages: [],
          }),
        },
      },
    );

    expect(outcome.status).toBe("compiled");
    expect(outcome.workspace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The preflight is conditional on a graph being supplied
// ---------------------------------------------------------------------------

describe("a compile with no workspace graph", () => {
  it("never asks the bundler to resolve entry specifiers", async () => {
    // The review's P2: the preflight ran unconditionally, so every ordinary #6
    // compile paid for an analysis pass whose result it discarded, and graph-less
    // callers acquired a failure path through a port method they never needed.
    // `resolveEntrySpecifiers` exists to make #14's fatal findings observable before
    // the build; with no graph there is no #14 audit to make observable.
    let resolveCalls = 0;
    let buildCalls = 0;
    const bundler: CellBundlerPort = {
      resolveEntrySpecifiers: async () => {
        resolveCalls += 1;
        return ["@app/ui"];
      },
      bundle: async (): Promise<BundledCellModule> => {
        buildCalls += 1;
        return { code: `function App() { return null; }`, externalImports: [], inlinedPackages: [] };
      },
    };

    const outcome = await compileCell({ entry: "src/App.tsx", dependencies: [] }, { bundler });

    expect(resolveCalls).toBe(0);
    expect(buildCalls).toBe(1);
    expect(outcome.status).toBe("compiled");
    // No graph means no workspace field, which is #14's "an absent input is not an
    // empty one" — and the reason the preflight has nothing to decide.
    expect(outcome.workspace).toBeUndefined();
  });

  it("still reports a bundler failure from bundle() rather than from a resolve pass", async () => {
    // The other half of the P2: the failure path a graph-less caller sees must be the
    // one it always had. With the preflight skipped, a broken entry is reported by
    // `bundle()` — so the diagnostic is the one `compileCell` has always produced for
    // a graph-less compile, not a new one from a method that caller never chose.
    let resolveCalls = 0;
    const bundler: CellBundlerPort = {
      resolveEntrySpecifiers: async () => {
        resolveCalls += 1;
        throw new Error("resolve pass should not have run");
      },
      bundle: async () => {
        throw new Error("ENOENT: src/App.tsx");
      },
    };

    const outcome = await compileCell({ entry: "src/App.tsx", dependencies: [] }, { bundler });

    expect(resolveCalls).toBe(0);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["bundler-failure"]);
    expect(outcome.diagnostics[0]?.message).toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// The canonical report surfaces the workspace vocabulary
// ---------------------------------------------------------------------------

describe("formatCompileCellOutcome on a workspace finding", () => {
  it("prints a preflight cycle rejection's chain, not '0 diagnostic(s)'", async () => {
    // The review's finding: the rejection carries `diagnostics: []` by design — #14's
    // vocabulary is not #6's — so a formatter that read only `outcome.diagnostics`
    // printed `Compilation rejected with 0 diagnostic(s):` and dropped the cycle
    // entirely. The structured diagnostic existed and reached nobody, which is worse
    // than not having it: the CI log would read as a clean rejection with no cause.
    const bundler: CellBundlerPort = {
      resolveEntrySpecifiers: async () => ["@cyc/a"],
      bundle: async (): Promise<BundledCellModule> => ({
        code: `function App() { return null; }`,
        externalImports: [],
        inlinedPackages: [],
      }),
    };

    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [] },
      {
        bundler,
        workspace: {
          packages: [
            { name: "@cyc/a", directory: "packages/a", imports: ["@cyc/b"] },
            { name: "@cyc/b", directory: "packages/b", imports: ["@cyc/a"] },
          ],
        },
      },
    );

    expect(outcome.status).toBe("rejected");
    const report = formatCompileCellOutcome(outcome);

    // The code, the chain, and the fix owner — the three things a reader acts on.
    expect(report).toContain("circular-workspace-dependency");
    expect(report).toContain("@cyc/a → @cyc/b → @cyc/a");
    expect(report).toContain("Fix (workspace-graph)");
    // And the artifact vocabulary is still reported, honestly, as empty.
    expect(report).toContain("Compilation rejected with 0 diagnostic(s):");
  });

  it("prints a workspace-package decision rejection's finding", async () => {
    // The other fatal workspace code, which takes the interception path rather than
    // the cycle path — a fix that special-cased cycles in the formatter would pass
    // the test above and fail this one.
    const dir = projectImporting("antd", `exports.Button = function Button() { return "local"; };\n`);
    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [{ strategy: "host", packageName: "antd", globalName: "antd" }] },
      { bundler: createRolldownCellBundler({ dir }), workspace: { packages: [{ name: "antd", directory: "packages/antd", imports: [] }] } },
    );

    const report = formatCompileCellOutcome(outcome);
    expect(report).toContain("workspace-package-decided-as-dependency");
    expect(report).toContain("Fix (dependency-decision)");
  });

  it("prints the workspace summary on a compiled outcome, so a clean audit is visible as one", async () => {
    // The bound on printing it: a compiled compile with a graph still reports the
    // workspace summary, because `formatWorkspaceSourceAudit`'s contract is that
    // "no diagnostics" must not be readable as "the declared sharing was verified".
    // Without this, the formatter's workspace block would appear only on failures and
    // a reader would learn to read its absence as success.
    const graph = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
    const outcome = await compileCell(
      { entry: "src/App.tsx", dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }] },
      { bundler: createRolldownCellBundler({ dir: exampleRoot }), workspace: graph.graph },
    );

    expect(outcome.status).toBe("compiled");
    const report = formatCompileCellOutcome(outcome);
    expect(report).toContain("Compiled Cell artifact:");
    expect(report).toContain("Workspace graph: stated");
    expect(report).toContain("No workspace source diagnostics.");
  });

  it("prints no workspace block when no graph was supplied", async () => {
    // The other bound: without a graph there is no audit, and the report must not
    // imply one ran. This is the pre-existing behaviour for every #6 caller.
    const outcome = await compileCell({ entry: "src/App.tsx", dependencies: [] }, { bundler: TRIVIAL_WORKSPACE_FREE_BUNDLER });
    const report = formatCompileCellOutcome(outcome);
    expect(report).not.toContain("Workspace graph:");
  });
});
