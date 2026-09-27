import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadForguncyConfig } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { buildCellProject, requireCompiledCells } from "./build-cell-project.ts";
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
