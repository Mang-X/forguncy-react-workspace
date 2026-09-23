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
 *    an omitted workspace package stops resolving to workspace source, so a *local*
 *    package is classified as a published one, which silently changes what the
 *    compiler reports.
 * 3. **The `workspace:` protocol is not a version.** The odd-looking assertion that
 *    a `workspace:*` range never reaches the graph is the load-bearing one: a
 *    protocol range is not a module id, and one leaked into `imports` would make
 *    `packageNameOfSpecifier` see `workspace:*` as a package named `workspace:*`.
 */
import { readFileSync } from "node:fs";
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

  it("includes this repository's own root package, as pnpm does", async () => {
    // The review finding this pins: the loader expanded only the `packages:` globs,
    // so this repository's root package — a real named workspace package that
    // `pnpm install` links and that `pnpm-workspace-state` lists as a project — was
    // absent from the graph. "Resolves through the real pnpm graph" was therefore a
    // strict subset of the truth, and a member depending on the root would have had
    // that dependency classified as published rather than as local source.
    //
    // pnpm's rule: "The root package is always included, even when custom location
    // wildcards are used."
    const { index } = await loadPnpmWorkspaceGraph({ root: repositoryRoot });

    const root = workspacePackageFor(index, "forguncy-react-workspace");
    expect(root).toBeDefined();
    // At the workspace root itself, written as "." rather than the empty string
    // #14's index refuses.
    expect(root?.directory).toBe(".");
    expect(classifyWorkspaceModule(index, "forguncy-react-workspace")).toBe("workspace-package");

    // And the graph is not missing any other member: pnpm's own state file is the
    // independent count, so this fails if the loader ever under- or over-reports.
    const pnpmProjects = Object.values(
      JSON.parse(readFileSync(join(repositoryRoot, "node_modules", ".pnpm-workspace-state-v1.json"), "utf8"))
        .projects as Record<string, { name: string }>,
    ).map(project => project.name);
    expect(index.packages.map(record => record.name).sort()).toEqual([...pnpmProjects].sort());
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

  it("refuses every glob shape it does not implement, in one authoritative list", async () => {
    // One list rather than three overlapping ones, so a new pattern has one place to
    // go and a reader can see the whole supported/unsupported boundary at once.
    //
    // Every entry here is a glob pnpm and `fast-glob` accept. A literal-path read of
    // any of them resolves to *nothing*: no error, no members, and every workspace
    // package reclassified as a published dependency — which is the silent failure
    // the refusal exists to prevent. The two supported forms (a literal directory,
    // and one trailing `/*`) are deliberately absent from this list.
    //
    // The extglob entries are the ones a guard built by enumerating remembered
    // syntax misses: `+(a|b)` and `@(a)` contain no star, no `?` and no brace, so a
    // check for those alone accepts them.
    for (const pattern of [
      // A star that is not the single permitted trailing one.
      "packages/*/src",
      "packages/*/*",
      "pkg-*",
      "*/packages",
      // Double star, in both positions.
      "packages/**",
      "packages/**/nested",
      // Single-character and character-class wildcards.
      "packages/?",
      "packages/[ab]",
      // Brace expansion and negation.
      "packages/{a,b}",
      "!packages/excluded",
      // Extglob groups: no star, no brace, still glob syntax.
      "examples/+(app|lib)",
      "examples/@(app)",
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

  it("trims a dependency key the same way, so the edge matches the member it names", async () => {
    // The symmetric case of the test above, and the one that is easier to miss: a
    // padded *dependency key* is stored as an id no member can match, so
    // `workspacePackageFor` misses it and the audit reports a bogus unresolved
    // transitive dependency for a workspace package that is in the graph.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({
        name: "@fixture/a",
        dependencies: { "  @fixture/b  ": "workspace:*", "": "1.0.0", "   ": "1.0.0" },
      }),
      "packages/b/package.json": manifest({ name: "@fixture/b" }),
    });

    const { index } = await loadPnpmWorkspaceGraph({ root });
    expect(workspacePackageFor(index, "@fixture/a")?.imports).toEqual(["@fixture/b"]);

    // And the edge resolves, so the audit reports a closure of two packages with no
    // unresolved transitive dependency.
    const audit = auditWorkspaceSource({
      workspace: { packages: [...index.packages] },
      dependencies: [],
      entryModuleIds: ["@fixture/a"],
    });
    expect(audit.closure?.packages).toEqual(["@fixture/a", "@fixture/b"]);
    expect(audit.diagnostics).toEqual([]);
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

  it("treats an absent `packages` key as the root-only workspace pnpm describes", async () => {
    // pnpm: "If the `packages` field is omitted, only the root package is included
    // in the workspace." So the root is the one member here — not an empty graph.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "allowBuilds:\n  esbuild: true\n",
      "package.json": manifest({ name: "root-project" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(index.packages.map(record => record.name)).toEqual(["root-project"]);
    // The root's directory is the workspace root itself, written as "." because the
    // empty string is what #14's index refuses as not-workspace-relative.
    expect(index.packages[0]?.directory).toBe(".");
    expect(diagnostics).toEqual([]);
  });

  it("includes the root as a member even when custom location wildcards are used", async () => {
    // pnpm: "The root package is always included, even when custom location wildcards
    // are used." This is the case the loader got wrong: the patterns alone expanded to
    // a strict subset of the graph `pnpm install` links, so a dependency on the root
    // package from a member resolved to a *published* dependency instead of to local
    // source. This repository is the worked example — its root is `forguncy-react-workspace`.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "package.json": manifest({ name: "root-project", dependencies: { "@fixture/child": "workspace:*" } }),
      "packages/child/package.json": manifest({ name: "@fixture/child" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(diagnostics).toEqual([]);
    expect(index.packages.map(record => record.name).sort()).toEqual(["@fixture/child", "root-project"]);

    // The point of including it: the root is now resolvable by name, so an import of
    // it is classified as workspace source rather than as a published dependency —
    // and the root's own edge to its child is in the graph.
    expect(workspacePackageFor(index, "root-project")?.imports).toEqual(["@fixture/child"]);
    expect(classifyWorkspaceModule(index, "root-project")).toBe("workspace-package");
  });

  it("does not invent a root member when the root declares no manifest", async () => {
    // A workspace root with no `package.json` is a real layout — a bare aggregator of
    // members — so the root is a *candidate*: it joins the graph only when it declares
    // a manifest. Without this, seeding the root unconditionally made a missing root
    // manifest a hard failure, which would refuse a legitimate project.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/child/package.json": manifest({ name: "@fixture/child" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(index.packages.map(record => record.name)).toEqual(["@fixture/child"]);
    expect(diagnostics).toEqual([]);
  });

  it("counts the root once when a pattern already names it", async () => {
    // `packages: ["."]` makes the root explicit. The root is then both pattern-matched
    // and seeded, so this asserts the deduplication rather than a second record — which
    // would be reported as a `workspace-graph-conflict` against the project itself.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: 'packages:\n  - "."\n  - packages/*\n',
      "package.json": manifest({ name: "root-project" }),
      "packages/child/package.json": manifest({ name: "@fixture/child" }),
    });

    const { index, diagnostics } = await loadPnpmWorkspaceGraph({ root });
    expect(diagnostics).toEqual([]);
    expect(index.packages.map(record => record.name).sort()).toEqual(["@fixture/child", "root-project"]);
  });

  it("throws when the workspace document is not a YAML mapping", async () => {
    const root = await fixtureRoot({ [PNPM_WORKSPACE_FILE]: "- a\n- b\n" });

    await expect(loadPnpmWorkspaceGraph({ root })).rejects.toThrow(/does not parse as a mapping/);
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

  it("returns the raw graph beside the index, so a graph finding survives a re-audit", async () => {
    // The two views exist for two consumers, and this is the property that makes the
    // distinction load-bearing: `compileCell`'s `workspace` option takes the *raw*
    // graph because the audit indexes its input itself. Handing the audit the
    // deduped `index.packages` would re-index a list the duplicate is no longer in,
    // and the `workspace-graph-conflict` this project actually has would vanish —
    // which is exactly what the assertion below demonstrates.
    const root = await fixtureRoot({
      [PNPM_WORKSPACE_FILE]: "packages:\n  - packages/*\n",
      "packages/a/package.json": manifest({ name: "@fixture/dup" }),
      "packages/b/package.json": manifest({ name: "@fixture/dup" }),
    });

    const loaded = await loadPnpmWorkspaceGraph({ root });
    expect(loaded.graph.packages).toHaveLength(2);
    expect(loaded.index.packages).toHaveLength(1);

    // Through the raw graph the conflict is reported; through the index's records it
    // is not, because there is nothing left to conflict.
    const raw = auditWorkspaceSource({ workspace: loaded.graph, dependencies: [] });
    expect(raw.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["workspace-graph-conflict"]);
    const deduped = auditWorkspaceSource({ workspace: { packages: [...loaded.index.packages] }, dependencies: [] });
    expect(deduped.diagnostics).toEqual([]);
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
