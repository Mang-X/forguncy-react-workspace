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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { afterAll, describe, expect, it } from "vitest";

import { compileCell } from "./artifact";
import type { BundledCellModule, CellBundlerPort, CompileCellOutcome } from "./artifact";
import { createRolldownCellBundler } from "./rolldown-bundler";
import { loadPnpmWorkspaceGraph } from "./workspace-graph";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "workspace-package");

const scratchRoots: string[] = [];

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
