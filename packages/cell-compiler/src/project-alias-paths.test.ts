import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, loadForguncyConfig } from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { buildCellProject, requireCompiledCells } from "./build-cell-project.ts";
import type { BuildCellProjectOptions } from "./build-cell-project.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

/**
 * Issue #97's first acceptance criterion, executed: "one registry/alias configuration drives local
 * and production actual resolution, with no implicit second set of defaults".
 *
 * ## Why this test is the ticket
 *
 * Before this change the build could not resolve a project alias **at all** — measured:
 * `CreateRolldownCellBundlerOptions` was `{ dir }` and the generated Rolldown options contained no
 * `resolve` key, so a project alias worked under `vp dev` and failed the compile. That is exactly
 * the "local uses a Vite config while production ignores it" split #97 names, and it is why the
 * alias set moved into `forguncy.config.ts` and onto the registry rather than staying a Vite-only
 * setting.
 *
 * ## What is asserted, and why each half is needed
 *
 * The fixture project imports `@app/shared/thing` by alias, and `shared/thing.ts` carries a string
 * that exists nowhere else. So "both paths resolved the alias to that file" is decidable by
 * looking for the marker — rather than by comparing two paths, which would only say both engines
 * named the same string.
 *
 * Both directions are covered because either alone is satisfiable by a wrong implementation:
 *
 * - without the compiler half, a build that ignored the alias would fail to resolve and the test
 *   would catch it — but a *dev-only* fix would pass a harness-only test;
 * - without the rejection half, "the compiler accepts any alias" would pass while the two engines
 *   silently diverged on the shapes they disagree about.
 *
 * The pre-bundle specifier pass is asserted too, and it is not redundant: the compiler's claim is
 * that the specifiers it *audits* are the ones it *builds*, so the two passes must resolve the
 * alias identically or the workspace audit describes a graph the artifact does not have.
 *
 * ## What this does not claim
 *
 * That Forguncy accepts the artifact, or that the page resolves the same file: the page has no
 * alias mechanism, which is precisely why an alias is a *source*-level convenience rather than a
 * runtime one. AGENTS.md rule 7 keeps a local build out of runtime compatibility claims.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "tests", "fixtures", "alias-project");

/** The marker that exists only in the file the alias points at. */
const ALIAS_MARKER = "resolved-via-project-alias";

/**
 * A second fixture project whose one Cell does not compile, for the strict/lenient split.
 *
 * A separate root rather than a Cell added to the alias fixture: the alias test asserts the exact
 * set of Cells a build returns, so a permanently-broken Cell in that project would make every other
 * assertion carry it along.
 */
const brokenRoot = join(here, "..", "tests", "fixtures", "unbuildable-cell");

describe("one project alias set drives both the local dev server and the Cell build", () => {
  it("compiles a Cell whose entry imports the project alias by name", async () => {
    // The defect in one assertion: before #97 this compile could not resolve `@app/shared/thing`
    // and was rejected with `bundler-failure`. Nothing else about the fixture is unusual, so a
    // failure here is about the alias and not about the Cell.
    const build = await buildCellProject({ root: fixtureRoot, dependencies: [] });

    const [probe] = build.cells;
    expect(probe?.cellId).toBe("probe");
    expect(probe?.outcome.status, JSON.stringify(probe?.outcome)).toBe("compiled");

    // The resolved file's code is *in* the artifact, which is what "the build resolved the alias"
    // means — a path comparison would not establish that the right file was read.
    const outcome = probe!.outcome;
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.code).toContain(ALIAS_MARKER);
  });

  it("resolves the alias through the pre-bundle pass as well as the build", async () => {
    // The two passes share one resolver, and this is the assertion that keeps that true: the
    // preflight's whole claim is that the specifiers it audits are the ones the build resolves, so
    // an alias applied in one hook and not the other would make the workspace audit describe a
    // graph the artifact does not have.
    //
    // Both passes are driven through the *bundler port* rather than through `compileCell`, because
    // the port is where the alias is applied and both passes are its methods.
    const registry = await loadForguncyConfig({ root: fixtureRoot });
    const request = { entry: join(fixtureRoot, "cells", "probe", "src", "index.ts"), dependencies: [] };
    const withAlias = createRolldownCellBundler({ dir: registry.root, alias: registry.resolve.alias });
    const withoutAlias = createRolldownCellBundler({ dir: registry.root });

    // The alias id is reported as a referenced specifier, and that is the honest answer rather than
    // a leak: the entry literally imports `@app/shared/thing`, so it *is* a specifier the graph
    // asked for. Which file it resolved to is a separate question, answered from the resolved
    // module ids.
    expect(await withAlias.resolveEntrySpecifiers!(request)).toEqual(["@app/shared/thing"]);

    // What distinguishes the two runs is the **build**, not the preflight: `scan` reports an
    // unresolvable specifier rather than failing on it, so the preflight succeeds either way. The
    // control therefore lives one call later.
    const resolved = await withAlias.bundle!({ ...request, componentBinding: "Cell" });
    const unresolved = await withoutAlias.bundle!({ ...request, componentBinding: "Cell" });

    expect(resolved.code).toContain(ALIAS_MARKER);
    expect(resolved.externalImports).toEqual([]);
    // Without the alias the id survives as an external import and the file's code is absent — which
    // is the defect in miniature, and the reason the control is not vacuous.
    expect(unresolved.externalImports).toEqual(["@app/shared/thing"]);
    expect(unresolved.code).not.toContain(ALIAS_MARKER);
  });

  it("hands the build the alias set the project declared, resolved against the project root", async () => {
    // The alias set travels on the registry (#97), so this pins the value the build received rather
    // than re-deriving what it should be — a test that normalized the config itself would compare
    // two normalizations instead of testing the one the build used.
    const build = await buildCellProject({ root: fixtureRoot, dependencies: [] });

    expect(build.alias).toEqual({ "@app/shared": join(fixtureRoot, "shared") });
    expect(build.registry.resolve.entries).toEqual([
      { find: "@app/shared", replacement: "./shared", target: join(fixtureRoot, "shared") },
    ]);
  });

  it("is byte-identical across two builds of one unchanged project", async () => {
    // #97's determinism criterion. It is a property of the inputs — a declaration-ordered registry,
    // pure per-Cell compilation and #6's fixed banner — and pinning it here is what makes a build
    // record comparable rather than merely reproducible by eye.
    const first = await buildCellProject({ root: fixtureRoot, dependencies: [] });
    const second = await buildCellProject({ root: fixtureRoot, dependencies: [] });

    const codeOf = (build: Awaited<ReturnType<typeof buildCellProject>>): string => {
      const [probe] = build.cells;
      const outcome = probe!.outcome;
      if (outcome.status !== "compiled") throw new Error("the fixture must compile");
      return outcome.artifact.code;
    };

    expect(codeOf(first)).toBe(codeOf(second));
    // The control: the fixture has content for the comparison to be about.
    expect(codeOf(first).length).toBeGreaterThan(200);
  });

  it("reports every declared Cell rather than throwing on the first failure", async () => {
    // The lenient half of the split, and the reason it is the default: `buildCellProject` answers
    // "which of my Cells are broken" for a whole project, so a rejected Cell is data rather than an
    // exception. The strict form is `requireCompiledCells`, which a deployment path uses.
    const build = await buildCellProject({ root: fixtureRoot, dependencies: [] });

    expect(build.cells.map(cell => cell.cellId)).toEqual(["probe"]);
    // The fixture compiles, so the strict form accepts it — which is what makes the refusal case
    // below a statement about a *rejected* Cell rather than about the helper being unreachable.
    expect(requireCompiledCells(build).map(cell => cell.cellId)).toEqual(["probe"]);
  });

  it("refuses, naming the Cell, when a caller asks for compiled artifacts only", async () => {
    // The strict half. Asserted with a Cell that genuinely does not compile — its entry exports no
    // component — so the refusal is exercised rather than assumed. The entry is chosen *because*
    // the rejection is unrelated to the alias under test: the point here is the build entry's
    // error shape, not alias resolution.
    const build = await buildCellProject({
      root: brokenRoot,
      dependencies: [],
    });

    const [cell] = build.cells;
    expect(cell?.outcome.status).toBe("rejected");

    let thrown: unknown;
    try {
      requireCompiledCells(build);
    } catch (error) {
      thrown = error;
    }

    // The refusal names the Cell, and this is the half that makes it actionable: a caller that only
    // learned "the build failed" would have to re-run the build to find out which Cell it was. The
    // code is the compiler's own (`bundler-failure` — the entry exposes no component, so there is
    // nothing for the wrapper to bind), reported rather than re-spelled here.
    expect(String(thrown)).toContain("broken");
    expect(String(thrown)).toContain("bundler-failure");
    // And the lenient path returned it rather than throwing, so the two behaviours are genuinely
    // different rather than two spellings of one.
    expect(build.cells).toHaveLength(1);
  });

  it("keeps the artifact free of the alias specifier itself", async () => {
    // An alias is a *source*-level convenience: it must be resolved away, never left in the
    // artifact, because the page has no alias mechanism. A surviving `@app/shared/thing` would be
    // an import a browser cannot resolve.
    const build = await buildCellProject({ root: fixtureRoot, dependencies: [] });
    const outcome = build.cells[0]!.outcome;
    if (outcome.status !== "compiled") throw new Error("the fixture must compile");

    expect(outcome.artifact.code).not.toContain("@app/shared");
    expect(readFileSync(join(fixtureRoot, "shared", "thing.ts"), "utf8")).toContain(ALIAS_MARKER);
  });
});

/**
 * The two inputs review found could not be expressed, both as execution-level tests.
 *
 * ## 1. A workspace *member* is not a workspace root
 *
 * Measured before the fix: `readWorkspaceGraph` looked only at `<projectRoot>/pnpm-workspace.yaml`,
 * so for `examples/workspace-package` — a member of *this repository's* workspace, with no manifest
 * of its own — the build reported `workspaceAudited: false` and skipped #14's audit entirely. That
 * is not a cosmetic gap: the audit's fatal findings (`circular-workspace-dependency`,
 * `workspace-package-decided-as-dependency`) are the ones that must refuse a compile, and a build
 * that silently skips them is the "green build for an artifact that cannot exist" shape this whole
 * line of work removes. Existing tests had the same layout but assembled the graph by hand, which is
 * why the public entry could not express it.
 *
 * ## 2. The entry can consume a registry the caller already loaded
 *
 * #97's plan step 1 says the entry "复用已加载 registry，不再加载第二份配置". Without a `{ registry }`
 * input, a caller that already normalized the config had to load it again — a second normalization
 * of one file, free to disagree. Asserted by *identity*, since "the same object" is the property
 * being bought and deep equality would not distinguish it from a re-load that happened to match.
 */
describe("the public build entry consumes the project it is handed", () => {
  const packageRoot = join(here, "..");
  const repositoryRoot = join(packageRoot, "..", "..");
  /** A project with no manifest of its own, whose workspace root is the repository. */
  const memberRoot = join(here, "..", "tests", "fixtures", "member-project");

  it("audits the workspace of a member project, walking up to the workspace root", async () => {
    // `member-project` has no `pnpm-workspace.yaml`; the nearest one is the repository's, two levels
    // up. The walk is what makes this project audited rather than silently skipped — and the
    // layout is not contrived, it is how every example in this repository is arranged.
    expect(existsSync(join(memberRoot, "pnpm-workspace.yaml"))).toBe(false);
    expect(existsSync(join(repositoryRoot, "pnpm-workspace.yaml"))).toBe(true);

    const build = await buildCellProject({ root: memberRoot, dependencies: [] });

    expect(build.workspaceAudited).toBe(true);
    // The audit ran for real, so it carries a report rather than merely a flag.
    expect(build.cells[0]?.outcome.workspace).toBeDefined();
    // And the Cell still compiled, so the walk did not change what is built.
    expect(build.cells[0]?.outcome.status).toBe("compiled");
  });

  it("refuses a named workspace root with no manifest, rather than auditing nothing", async () => {
    // `{ workspace: { root } }` is the escape hatch for a layout the walk would answer differently.
    // Naming a root that holds no manifest is a claim about the project that is wrong, so it throws
    // instead of quietly producing an unaudited build — the `true`-vs-`"auto"` distinction applied
    // to the explicit form.
    await expect(
      buildCellProject({
        root: memberRoot,
        dependencies: [],
        workspace: { root: join(memberRoot, "no-such-workspace") },
      }),
    ).rejects.toThrowError(/pnpm-workspace\.yaml/);
  });

  it("builds through the registry object it was handed, without loading a second config", async () => {
    // The registry is normalized by the caller here, exactly as the dev server and a plan command
    // do. `{ registry }` returns that object unchanged, so identity is the assertion.
    const registry = await loadForguncyConfig({ root: fixtureRoot });

    const build = await buildCellProject({ registry, dependencies: [] });

    expect(build.registry).toBe(registry);
    // The alias set is the *same object* the caller's registry carries, which is the property #97
    // is about: one normalization, read by both paths.
    expect(build.alias).toBe(registry.resolve.alias);
    // And it still builds, so reusing the registry is not a mode that compiles nothing.
    expect(build.cells[0]?.outcome.status).toBe("compiled");
  });

  it("honours a registry whose root the registry itself carries", async () => {
    // A registry is already rooted, so there is no second root to reconcile — the property that
    // makes the `{ registry }` input safe rather than a way to build the wrong project.
    const registry = await loadForguncyConfig({ root: fixtureRoot });
    expect(registry.root).toBe(resolve(fixtureRoot));

    const build = await buildCellProject({ registry, dependencies: [] });

    expect(build.cells[0]?.target.locatorKey).toBe("探针#A1");
  });
});

/**
 * #4's `(packageName, cellTarget)` rule against the public build entry.
 *
 * ## The defect review found
 *
 * The first version took one project-wide `dependencies` array. That **cannot express** a
 * legitimate project, and the reason is structural rather than a missing convenience: the
 * projection that produces `DependencyDecision[]` has already applied the target —
 * `compilationDependencies(lock, environment, { cellTarget })` selects by target and
 * `dependencyDecisionOf()` then drops the `cellTarget` field — so the array carries no Cell
 * identity a later stage could narrow by. Measured on the two Cells below:
 *
 * | passed to the build | Alpha compiles | Beta compiles |
 * | --- | --- | --- |
 * | Alpha's projection | correct | **wrong** (Alpha's strategy) |
 * | Beta's projection | **wrong** | correct |
 * | both concatenated | `unresolved-dependency-decision` (one id, two decisions) |
 *
 * So there was no correct input at all. The entry now takes either one array or a per-Cell
 * callback, and this block exercises the case a single array cannot represent.
 *
 * ## Why `@tanstack/query-core` is the subject
 *
 * It is the one id in this workspace where **both** strategies are compilable: it is installed, so
 * `inline` has an artifact to flatten, and it carries a verified row in the built-in extension
 * table, so `extension` has a global to reference. A package with only one of those could not
 * support a two-strategy test — and several obvious candidates fail for exactly that reason
 * (measured: `es-toolkit` has no mapping row, `react`/`antd` are host-bridged and refuse `inline`).
 *
 * The two Cells import it with identical text, so the only thing that can make their artifacts
 * differ is the strategy each was decided under. The observable difference is stark and is what the
 * assertions use: `inline` flattens ~52,000 characters of implementation into the artifact with no
 * `frontendLibraries` entry, while `extension` emits ~1,900 characters referencing the page global
 * and declares the library.
 */
describe("a build compiles each Cell under its own dependency projection", () => {
  const perCellRoot = join(here, "..", "tests", "fixtures", "per-cell-strategy");
  const PACKAGE = "@tanstack/query-core";

  /** One projection per Cell — the input a single array structurally cannot be. */
  const perCell: Readonly<Record<string, readonly DependencyDecision[]>> = {
    alpha: [{ strategy: "inline", packageName: PACKAGE }],
    beta: [{ strategy: "extension", packageName: PACKAGE, libraryId: "tanstack-query", globalName: "TanStackQuery" }],
  };

  /** The fixture's registry, normalized once and handed to the build as `{ registry }`. */
  function fixtureRegistry() {
    return createCellRegistry(
      {
        cells: {
          alpha: { entry: "./cells/alpha/src/index.ts", target: { pageName: "探针", cell: "A1" } },
          beta: { entry: "./cells/beta/src/index.ts", target: { pageName: "探针", cell: "B2" } },
        },
      },
      { root: perCellRoot },
    );
  }

  /** One built Cell, or a failure naming which Cell did not compile. */
  function cellOf(build: Awaited<ReturnType<typeof buildCellProject>>, id: string) {
    const cell = build.cells.find(candidate => candidate.cellId === id);
    if (cell?.outcome.status !== "compiled") {
      throw new Error(`Cell "${id}" must compile; it was: ${JSON.stringify(cell?.outcome)}`);
    }
    return cell.outcome.artifact;
  }

  it("compiles two Cells of one package under their own strategies", async () => {
    const build = await buildCellProject({
      registry: fixtureRegistry(),
      dependencies: cellId => perCell[cellId] ?? [],
      workspace: false,
    });

    const alpha = cellOf(build, "alpha");
    const beta = cellOf(build, "beta");

    // Alpha inlined the package: the implementation is present and no library is declared.
    expect(alpha.code.length).toBeGreaterThan(10_000);
    expect(alpha.frontendLibraries).toEqual([]);

    // Beta externalized the same package: the implementation is absent, the artifact is small, and
    // the metadata declares the library it now depends on.
    expect(beta.code.length).toBeLessThan(5_000);
    expect(beta.frontendLibraries.map(library => library.libraryId)).toEqual(["tanstack-query"]);
    expect(beta.code).toContain("TanStackQuery");
  });

  it("does not give either Cell the other's strategy", async () => {
    // The cross-check that makes the test above specific: a build that applied `alpha`'s projection
    // to both Cells would produce two inlined artifacts, and one that applied `beta`'s would produce
    // two externalized ones. Both are excluded by asserting the two differ in the direction each was
    // decided, rather than only that each compiled.
    const build = await buildCellProject({
      registry: fixtureRegistry(),
      dependencies: cellId => perCell[cellId] ?? [],
      workspace: false,
    });

    const alpha = cellOf(build, "alpha");
    const beta = cellOf(build, "beta");

    // `alpha` must NOT be externalized (that would be Beta's strategy leaking into Alpha)...
    expect(alpha.frontendLibraries).toEqual([]);
    expect(alpha.code).toContain("QueryClient");
    // ...and `beta` must NOT be inlined (that would be Alpha's leaking into Beta).
    expect(beta.frontendLibraries).toHaveLength(1);
    expect(beta.code.length).toBeLessThan(alpha.code.length);
  });

  it("still accepts one array for every Cell, the single-strategy case", async () => {
    // The flat array remains the common case rather than being replaced: a project whose Cells share
    // a projection should not have to write a callback. Asserted so the per-Cell form did not make
    // the simple form unreachable.
    const build = await buildCellProject({
      registry: fixtureRegistry(),
      dependencies: [{ strategy: "inline", packageName: PACKAGE }],
      workspace: false,
    });

    for (const cellId of ["alpha", "beta"]) {
      expect(cellOf(build, cellId).frontendLibraries, cellId).toEqual([]);
    }
  });

  it("plans every Cell in the registry's declaration order", async () => {
    // The batch call was replaced by a per-Cell loop, so the ordering that used to come from
    // `planCellCompiles` is now this build's responsibility and is asserted rather than assumed.
    const build = await buildCellProject({
      registry: fixtureRegistry(),
      dependencies: cellId => perCell[cellId] ?? [],
      workspace: false,
    });

    expect(build.cells.map(cell => cell.cellId)).toEqual(["alpha", "beta"]);
  });
});

/**
 * The `{ registry }` / `{ root }` exclusion, asserted at the type level.
 *
 * Review found the first version's docstring claimed the compiler enforced mutual exclusion while a
 * plain structural union did not: an object carrying **both** `registry` and `root` satisfied either
 * branch, so the ambiguous input compiled and `resolveProjectRegistry`'s runtime check silently
 * picked the registry and ignored the root and loader options. That is the "two project sources, one
 * consumed" ambiguity the input exists to remove, and a comment cannot enforce it.
 *
 * Each branch now forbids the other's fields with `never`, so the compiler rejects the combination
 * rather than the runtime having to notice. These are `@ts-expect-error` assertions: if a future edit
 * loosens the type, the *directive* becomes the error, so the guard fails loudly instead of silently
 * ceasing to test anything.
 */
describe("the project input is an exclusive union", () => {
  it("refuses a registry together with a root", () => {
    const registry = createCellRegistry({ cells: {} }, { root: join(here, ".."), requireEntryFiles: false });

    // @ts-expect-error a registry and a root are two project sources; exactly one may be given
    const both: BuildCellProjectOptions = { registry, root: join(here, ".."), dependencies: [] };
    expect(both).toBeDefined();
  });

  it("refuses a registry together with the loader options", () => {
    const registry = createCellRegistry({ cells: {} }, { root: join(here, ".."), requireEntryFiles: false });

    // @ts-expect-error the loader options are inputs to *loading*, which a registry has already done
    const both: BuildCellProjectOptions = { registry, configFile: "./forguncy.config.ts", dependencies: [] };
    expect(both).toBeDefined();
  });

  it("accepts each branch on its own", () => {
    // The control: the exclusions above must not have made the two valid shapes unusable, or the
    // type would be enforcing something narrower than "exactly one source".
    const withRoot: BuildCellProjectOptions = { root: join(here, ".."), dependencies: [] };
    const withRegistry: BuildCellProjectOptions = {
      registry: createCellRegistry({ cells: {} }, { root: join(here, ".."), requireEntryFiles: false }),
      dependencies: [],
    };

    expect(withRoot.root).toBeDefined();
    expect(withRegistry.registry).toBeDefined();
  });
});

/**
 * The callback contract the per-Cell form rests on.
 *
 * A callback is only correct if it is consulted **once per Cell, with that Cell's own id** — and
 * that is not observable from the artifacts alone, because a build that called it once and reused
 * the answer would still produce a plausible result for a single-strategy project. So the ids are
 * recorded and asserted, which also pins the shape a caller composes with the resolver:
 * `cellId => compilationDependencies(lock, environment, { cellTarget: cellId })`.
 */
describe("the per-Cell dependency callback", () => {
  it("is consulted once per Cell, with that Cell's own id", async () => {
    const asked: string[] = [];

    await buildCellProject({
      registry: createCellRegistry(
        {
          cells: {
            alpha: { entry: "./cells/alpha/src/index.ts", target: { pageName: "探针", cell: "A1" } },
            beta: { entry: "./cells/beta/src/index.ts", target: { pageName: "探针", cell: "B2" } },
          },
        },
        { root: join(here, "..", "tests", "fixtures", "per-cell-strategy") },
      ),
      dependencies: cellId => {
        asked.push(cellId);
        return [{ strategy: "inline", packageName: "@tanstack/query-core" }];
      },
      workspace: false,
    });

    // Every Cell, and only real ids — a build that asked for `undefined` or reused one answer would
    // fail both halves of this.
    expect(asked.sort()).toEqual(["alpha", "beta"]);
  });

  it("treats an absent projection as no non-source dependencies", async () => {
    // A Cell with no decisions is normal (a Cell whose imports are all workspace source, #14), so
    // the callback is not required to cover every id. The fixture's Cells import an installed
    // package, so this is asserted through the *rejection*: with no decision the compiler reports
    // `unresolved-dependency-decision` rather than silently inlining, which is the behaviour that
    // makes an omitted projection loud instead of permissive.
    const build = await buildCellProject({
      registry: createCellRegistry(
        {
          cells: {
            alpha: { entry: "./cells/alpha/src/index.ts", target: { pageName: "探针", cell: "A1" } },
          },
        },
        { root: join(here, "..", "tests", "fixtures", "per-cell-strategy") },
      ),
      dependencies: () => [],
      workspace: false,
    });

    const [cell] = build.cells;
    expect(cell?.outcome.status).toBe("rejected");
    if (cell?.outcome.status !== "rejected") return;
    expect(cell.outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      "unresolved-dependency-decision",
    );
  });
});
