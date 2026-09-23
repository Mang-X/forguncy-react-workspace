/**
 * The workspace graph loader, against real manifests and real failure modes.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening
 * PoC" (https://github.com/Mang-X/forguncy-react-workspace/issues/15). This module
 * exists because #14 took the graph as an argument and recorded that supplying it
 * "is the project-configuration work (#26, #28)"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14) — so the thing the
 * loader has to be right about is *the reading*, and the tests here are about the
 * reading rather than about the data it happens to find in this repository.
 *
 * Three groups, each answering a different question:
 *
 * 1. **The repository's own graph.** There is no fixture here on purpose: the
 *    strongest statement available is that the loader reads *this* project's
 *    manifest and gets the packages `pnpm install` actually linked. A fixture would
 *    prove the parser works on input chosen to suit it.
 * 2. **Abstentions and refusals.** A missing manifest, malformed YAML and an
 *    unsupported glob form must fail loudly rather than produce a smaller graph —
 *    an omitted workspace package makes a *published* dependency look like local
 *    source, which silently changes what the compiler reports.
 * 3. **The `workspace:` protocol is not a version.** The odd-looking assertion that
 *    a `workspace:*` range never reaches the graph is the load-bearing one: a
 *    protocol range is not a module id, and one leaked into `imports` would make
 *    `packageNameOfSpecifier` see `workspace:*` as a package named `workspace:*`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { auditWorkspaceSource, classifyWorkspaceModule, traceWorkspaceSourceClosure, workspacePackageFor } from "./workspace-source";
import { loadPnpmWorkspaceGraph, PNPM_WORKSPACE_FILE } from "./workspace-graph";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");

const temporaryRoots: string[] = [];

/**
 * A throwaway project root, so a "missing manifest" or "malformed YAML" case can be
 * a real file on disk rather than a mocked `readFile`.
 */
async function fixtureRoot(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fgc-workspace-graph-"));
  temporaryRoots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ version: "0.0.0", private: true, type: "module", ...fields }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The repository's own graph
// ---------------------------------------------------------------------------

describe("the workspace graph read from this repository", () => {
  it("indexes every workspace member with no diagnostics", async () => {
    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    // An empty diagnostic list is the assertion that the manifest's globs expanded
    // to records the index could use: a nameless or duplicate member would report
    // `workspace-graph-conflict` here.
    expect(diagnostics).toEqual([]);

    const names = index.packages.map(record => record.name);
    // One package per workspace member, including the PoC's own shared packages —
    // which are members only because `pnpm-workspace.yaml` names them, so this
    // asserts the loader followed the manifest rather than the directory layout.
    expect(names).toContain("@app/ui");
    expect(names).toContain("@app/tokens");
    expect(names).toContain("@examples/workspace-package");
    expect(names).toContain("@forguncy-react-workspace/cell-compiler");
  });

  it("carries each member's declared dependencies as graph edges", async () => {
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    const ui = workspacePackageFor(index, "@app/ui");
    // The workspace edge, by name — this is what makes `@app/tokens` reachable
    // through `@app/ui` rather than only as a direct import.
    expect(ui?.imports).toContain("@app/tokens");
    // The published edge, by name, so the dependency layer can decide it. Nothing
    // in the graph says what `react` *is* — that is `fgc.lock.json`'s answer.
    expect(ui?.imports).toContain("react");

    const cellCompiler = workspacePackageFor(index, "@forguncy-react-workspace/cell-compiler");
    expect(cellCompiler?.imports).toContain("rolldown");
    expect(cellCompiler?.imports).toContain("@forguncy-react-workspace/core");
  });

  it("never puts a workspace protocol range into the graph", async () => {
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    // Every `workspace:*` range in this repository's manifests resolves to the
    // *package name*, never to the literal range. A leaked `workspace:*` would be
    // read downstream as a package of that name.
    const everything = index.packages.flatMap(record => [...(record.imports ?? [])]);
    expect(everything.some(moduleId => moduleId.startsWith("workspace:"))).toBe(false);
    // The positive half: the edge that *was* declared with the protocol is present
    // by name.
    expect(workspacePackageFor(index, "@app/ui")?.imports).toContain("@app/tokens");
  });

  it("records a workspace-relative POSIX directory, so a diagnostic is portable", async () => {
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    for (const record of index.packages) {
      expect(record.directory.startsWith("/")).toBe(false);
      expect(record.directory).not.toMatch(/^[A-Za-z]:/);
      expect(record.directory).not.toContain("\\");
      expect(record.directory.split("/")).not.toContain("..");
    }
  });

  it("classifies the PoC's imports through the graph it read", async () => {
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    // The three-way classification, against the real graph: two workspace
    // packages, one file, and one published dependency. `./orders` being a
    // `source-file` is what keeps the audit from demanding a decision for a file
    // beside the entry.
    expect(classifyWorkspaceModule(index, "@app/ui")).toBe("workspace-package");
    expect(classifyWorkspaceModule(index, "@app/tokens")).toBe("workspace-package");
    expect(classifyWorkspaceModule(index, "./orders")).toBe("source-file");
    expect(classifyWorkspaceModule(index, "../shared/ui")).toBe("source-file");
    expect(classifyWorkspaceModule(index, "react")).toBe("external-package");
    expect(classifyWorkspaceModule(index, "es-toolkit")).toBe("external-package");

    // The closure through the real edges: `@app/ui` reaches `@app/tokens`, and
    // `react` is the published module they bring with them.
    const closure = traceWorkspaceSourceClosure(index, ["@app/ui"]);
    expect(closure.packages).toEqual(["@app/tokens", "@app/ui"]);
    expect(closure.externalModules).toEqual([{ moduleId: "react", importedBy: ["@app/ui"] }]);
    expect(closure.cycles).toEqual([]);
  });

  it("is deterministic: two loads of one root produce identical graphs", async () => {
    // The filesystem is an input whose ordering a caller does not control, so this
    // is where an unsorted `readdir` would show up — as a report that reordered
    // itself between runs.
    const first = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
    const second = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    expect(second.index.packages).toEqual(first.index.packages);
    expect(second.diagnostics).toEqual(first.diagnostics);
  });
});

// ---------------------------------------------------------------------------
// Abstentions and refusals
// ---------------------------------------------------------------------------

describe("the workspace graph loader's refusals", () => {
  it("throws when the workspace manifest is absent", async () => {
    const root = await fixtureRoot({});

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/No "pnpm-workspace\.yaml"/);
  });

  it("throws on malformed YAML rather than reading a partial graph", async () => {
    const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: "packages: [a, b\n" });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/Cannot parse/);
  });

  it("refuses a glob form it does not implement instead of guessing", async () => {
    // A `**` glob is the case that matters: expanding it wrongly would *omit* a
    // package, and an omitted package makes a published dependency look like local
    // source. A loud failure is the only safe answer.
    const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/**\n" });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/does not implement/);
  });

  it("refuses every wildcard shape that would expand to nothing silently", async () => {
    // Each of these is a glob pnpm/fast-glob accept and a literal-path read would
    // resolve to *nothing*: no error, no members, and every workspace package
    // reclassified as a published dependency. The trailing-`/*` form is the one
    // supported case, so it must not appear here.
    for (const pattern of [
      "packages/*/src",
      "packages/?",
      "pkg-*",
      "packages/{a,b}",
      "!packages/excluded",
      "packages/[ab]",
      "packages/**/nested",
    ]) {
      const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: `packages:\n  - "${pattern}"\n` });
      await expect(loadPnpmWorkspaceGraph({ root }), pattern).rejects.toThrow(/does not implement/);
    }
  });

  it("reads the workspace root as a member when the manifest says so", async () => {
    // `packages: ["."]` is a real pnpm state that makes the root a member. The
    // root's relative directory is the empty string, which #14's own index refuses
    // as not-workspace-relative — so the loader has to write `"."` or a correct
    // project gets a bogus "machine-specific path" finding.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: 'packages:\n  - "."\n  - packages/*\n',
      "package.json": manifest({ name: "root-project", dependencies: { "@fixture/child": "workspace:*" } }),
      "packages/child/package.json": manifest({ name: "@fixture/child" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(diagnostics).toEqual([]);
    expect(workspacePackageFor(index, "root-project")?.directory).toBe(".");
    expect(workspacePackageFor(index, "@fixture/child")?.directory).toBe("packages/child");
    // The root's own workspace edge is an edge, so the two members are connected.
    expect(workspacePackageFor(index, "root-project")?.imports).toEqual(["@fixture/child"]);
  });

  it("trims a manifest name, so the stored name is the one source can import", async () => {
    // An untrimmed name would be stored under a padded key, where `byName.get` on
    // the real name cannot reach it — silently reclassifying a workspace package as
    // a published dependency and demanding a decision for local source.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({ name: "  @fixture/padded  " }),
    });

    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(index.packages.map(record => record.name)).toEqual(["@fixture/padded"]);
    expect(workspacePackageFor(index, "@fixture/padded")?.name).toBe("@fixture/padded");
    expect(classifyWorkspaceModule(index, "@fixture/padded")).toBe("workspace-package");
  });

  it("refuses a brace and a negation pattern for the same reason", async () => {
    for (const pattern of ["packages/{a,b}", "!packages/excluded"]) {
      const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: `packages:\n  - "${pattern}"\n` });
      await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/does not implement/);
    }
  });

  it("refuses a malformed `packages` key rather than reading it as an empty graph", async () => {
    // The dangerous direction: an empty member list makes every workspace package
    // look like a published dependency, which silently changes what the compiler
    // reports. So each of these is refused, and each names the key.
    const cases: Readonly<Record<string, string>> = {
      "not a list": "packages: ui\n",
      "lists a non-string": "packages:\n  - ui\n  - 42\n",
      "lists an empty string": 'packages:\n  - ""\n',
      "is a mapping": "packages:\n  ui: true\n",
    };

    for (const [label, contents] of Object.entries(cases)) {
      const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: contents });
      await expect(loadPnpmWorkspaceGraph({ root }), label).rejects.toThrow(/packages/);
    }
  });

  it("treats an absent `packages` key as no members, which is a real pnpm state", async () => {
    // Distinct from the malformed cases above: a workspace file with no `packages`
    // key declares the root as its only member, which is an empty member list for
    // this loader rather than an error. The root's own manifest is not a member
    // unless a glob matches it.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "allowBuilds:\n  esbuild: true\n",
      "package.json": manifest({ name: "root-project" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(index.packages).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("throws when the workspace document is not a YAML mapping", async () => {
    const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: "- a\n- b\n" });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/does not parse as a mapping/);
  });

  it("refuses a star that is not the single trailing one, so nothing is silently omitted", async () => {
    // The silent case this refusal exists for: `packages/*/src` contains a `*`,
    // ends in neither `/*` nor `**`, and would otherwise be read as the literal
    // directory `packages/*/src` — which does not exist, so the pattern would
    // expand to nothing and a whole subtree of members would vanish with no error.
    for (const pattern of ["packages/*/src", "packages/**", "*/packages", "packages/*/*"]) {
      const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: `packages:\n  - "${pattern}"\n` });
      await expect(loadPnpmWorkspaceGraph({ root }), pattern).rejects.toThrow(/does not implement/);
    }
  });

  it("reads a literal member entry, not only a child glob", async () => {
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - ui\n",
      "ui/package.json": manifest({ name: "@literal/ui", dependencies: { react: "19.2.7" } }),
    });

    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(index.packages.map(record => record.name)).toEqual(["@literal/ui"]);
    expect(workspacePackageFor(index, "@literal/ui")?.imports).toEqual(["react"]);
  });

  it("skips a member directory that has no manifest, and refuses one with a broken name", async () => {
    // Two different problems, answered differently on purpose:
    //
    // - a directory with no `package.json` at all is a mis-specified glob, so it is
    //   skipped;
    // - a directory that *declares* a name it cannot use is a malformed manifest,
    //   so it throws like the unreadable-manifest case — reporting it as a graph
    //   conflict would send the reader to the graph instead of to the file.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/real/package.json": manifest({ name: "@fixture/real" }),
      "packages/not-a-package/README.md": "no manifest here",
      "packages/no-name-key/package.json": manifest({ private: true }),
      "packages/unnamed/package.json": manifest({ name: "" }),
    });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/declares a "name" that is not/);

    // With the malformed member removed, the members without a `name` key are
    // simply absent — a mis-specified glob, not a project error.
    const clean = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/real/package.json": manifest({ name: "@fixture/real" }),
      "packages/not-a-package/README.md": "no manifest here",
      "packages/no-name-key/package.json": manifest({ private: true }),
    });
    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root: clean });
    expect(index.packages.map(record => record.name)).toEqual(["@fixture/real"]);
    expect(diagnostics).toEqual([]);
  });

  it("reports an incoherent graph as diagnostics rather than throwing", async () => {
    // Two members claiming one name: the graph is *usable* (the index resolves it
    // to one record) and still wrong, which is exactly the split #14 records — a
    // report carrying the record and a finding beats an exception that discards
    // the rest of the audit.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({ name: "@fixture/dup" }),
      "packages/b/package.json": manifest({ name: "@fixture/dup" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["workspace-graph-conflict"]);
    expect(index.packages.map(record => record.name)).toEqual(["@fixture/dup"]);
  });

  it("throws when a member manifest cannot be read", async () => {
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/broken/package.json": "{ not json",
    });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/Cannot read the workspace manifest/);
  });

  it("collects a member's dependencies from the fields that can reach an artifact", async () => {
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({
        name: "@fixture/a",
        dependencies: { react: "19.2.7" },
        peerDependencies: { "@fixture/b": "workspace:*" },
        optionalDependencies: { "optional-dep": "1.0.0" },
        devDependencies: { vitest: "4.1.11" },
      }),
      "packages/b/package.json": manifest({ name: "@fixture/b" }),
    });

    // `dependencies`, `peerDependencies` and `optionalDependencies` are edges: a
    // package reached through any of them can be flattened into a consuming Cell.
    // `devDependencies` is deliberately *not*, and `vitest` being absent is the
    // assertion — a dev dependency of a workspace package never reaches an
    // artifact, so an edge for one would report a transitive dependency that
    // cannot exist.
    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(workspacePackageFor(index, "@fixture/a")?.imports).toEqual([
      "@fixture/b",
      "optional-dep",
      "react",
    ]);
  });

  it("does not carry this repository's dev dependencies into the graph", async () => {
    // The worked example of the rule above: `cell-compiler` declares `react` and
    // `react-dom` as *dev* dependencies for its host-bridge regression, and neither
    // may appear as an edge — otherwise the audit would demand a dependency decision
    // for a module no artifact contains.
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
    const compiler = workspacePackageFor(index, "@forguncy-react-workspace/cell-compiler");

    expect(compiler?.imports).toContain("rolldown");
    expect(compiler?.imports).toContain("@forguncy-react-workspace/core");
    expect(compiler?.imports).not.toContain("react");
    expect(compiler?.imports).not.toContain("react-dom");
  });

  it("ignores a dependency field whose value is not a declaration record", async () => {
    // npm's contract is that these are records. Nothing here invents a name for a
    // malformed entry — a guess would put a package in the graph that no manifest
    // declared, and the graph is what the audit reports from.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({
        name: "@fixture/a",
        dependencies: ["react"],
        peerDependencies: "react",
        optionalDependencies: { react: 19 },
      }),
    });

    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(workspacePackageFor(index, "@fixture/a")?.imports).toEqual([]);
  });

  it("treats a declared member with no dependencies as having none", async () => {
    // The distinction #14's contract is built on: an empty `imports` says "there
    // are no edges", which is different from an absent one ("nobody said"). The
    // loader always states the list, so a package's outgoing edges are never
    // reported as unknown by accident.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({ name: "@fixture/a" }),
    });

    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(workspacePackageFor(index, "@fixture/a")?.imports).toEqual([]);

    // And the audit reads it as a closure of one package with no external modules
    // rather than abstaining: `usage` is `stated` because the entry was.
    const audit = auditWorkspaceSource({
      workspace: { packages: [...index.packages] },
      dependencies: [],
      entryModuleIds: ["@fixture/a", "@fixture/b"],
    });
    expect(audit.usage).toBe("stated");
    expect(audit.closure?.packages).toEqual(["@fixture/a"]);
    expect(audit.closure?.externalModules).toEqual([]);
  });
});
