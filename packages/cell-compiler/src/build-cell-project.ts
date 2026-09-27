/**
 * The public build entry: one declared project in, one artifact per Cell out.
 *
 * Decision sources: GitHub Issues
 * - #97 — "构建入口：统一 Cell registry、别名与生产构建配置的消费路径"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/97), which owns this entry, and
 * - #6 — "generated ReactCellType artifact and compiler boundary"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/6), whose boundary this
 *   composes without widening,
 *
 * both downstream of #4 "application ownership boundaries and dependency strategy semantics"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/4).
 *
 * ## The gap this closes
 *
 * Everything this entry calls already existed and nothing connected them. Measured on the
 * baseline: `compileCell` had **no non-test caller anywhere in the workspace's package sources**,
 * and the only end-to-end call chain in the repository lived in an Agent skill script (`.mjs`).
 * A project that wanted a Cell artifact had to assemble, by hand, a registry, a bundler port, the
 * workspace graph, a per-Cell budget and the plan — and the one thing it could not assemble
 * correctly was the alias set, because the bundler had no way to receive one, so the dev server
 * and the artifact resolved different files.
 *
 * So this module is the composition #97 asks for, and the composition is deliberately thin:
 *
 * | step | owned by |
 * | --- | --- |
 * | config → normalized registry (entries, targets, aliases, extension mappings) | `core` (#26/#85/#97) |
 * | registry → one plan per declared Cell | `registry-plan` (#26) |
 * | plan → artifact | `compileCell` (#6) |
 * | the alias set the build resolves through | `registry.resolve`, from the project config |
 *
 * ## What it deliberately does not do, and why the absence is the contract
 *
 * - **It does not read `fgc.lock.json`.** The compiler takes resolved decisions and does not
 *   resolve dependencies (#6/#8): projecting a lock onto a Cell is `dependency-resolver`'s job,
 *   and it is a *different* question from the one this entry answers. `dependencies` is therefore
 *   an input. #99 is the ticket that feeds it from the lock, and pinning the boundary here is what
 *   keeps this entry usable by a caller whose decisions came from somewhere else — a probe run, a
 *   test fixture, an Agent — without this module growing a second resolver.
 * - **It does not write files.** A `CompileCellResult` is handed back in memory, beside the target
 *   it belongs to, which is exactly the `SyncCellInput` shape `mcp-sync` consumes
 *   (`{ target, artifact }`) — #6's fifth criterion is that the artifact crosses that boundary
 *   with no translation step. Where the bytes land on disk is a deployment decision, and the one
 *   deployment path this repository has is the MCP sync, not a file copy.
 * - **It does not sync.** No transport, no project mutation, nothing remote. Building and
 *   deploying are separate verbs in #97's own wording ("可执行 build、只读 plan/校验、显式 sync"),
 *   and an entry that did both would make a build that touched a project possible by accident.
 * - **A rejected Cell does not fail the build.** One Cell that does not compile is reported in its
 *   own entry rather than thrown, because "which of my Cells are broken" is a question a caller
 *   asks about the whole project, and an exception on the first failure answers only "one of them".
 *   A caller that wants the strict behaviour tests `.outcome.status` per Cell.
 */

import { loadForguncyConfig } from "@forguncy-react-workspace/core";
import type { CellRegistry, DependencyDecision, ForguncyConfigModuleLoader } from "@forguncy-react-workspace/core";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import type { CellEntryKind } from "@forguncy-react-workspace/core";
import { planCellCompiles } from "./registry-plan.ts";
import type { CellCompileTarget } from "./registry-plan.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";
import { loadPnpmWorkspaceGraph, PNPM_WORKSPACE_FILE } from "./workspace-graph.ts";

/**
 * What one built Cell is: where it goes, and what came out.
 *
 * `target` is the registry's normalized coordinates, carried beside the artifact so the pair is
 * literally `mcp-sync`'s `SyncCellInput` — the caller does not look the Cell up a second time and
 * cannot pair the wrong target with the wrong code.
 */
export interface BuiltCell {
  readonly cellId: string;
  readonly target: CellCompileTarget;
  /**
   * The compile outcome, unreduced.
   *
   * Not a widened `CompileCellResult`: a rejected Cell's diagnostics are what a caller reports,
   * and flattening the union here would force every caller to test `code` for presence — the
   * failure mode #6 replaced the union to prevent.
   */
  readonly outcome: CompileCellOutcome;
  /** The budget this Cell was compiled against, from its own declaration. Absent when it declared none. */
  readonly codeBudgetCharacters?: number;
}

export interface CellProjectBuild {
  /** The normalized registry the whole build was resolved from. */
  readonly registry: CellRegistry;
  /** One entry per declared Cell, in the config's declaration order. */
  readonly cells: readonly BuiltCell[];
  /**
   * The alias set every Cell was compiled through, from the project config.
   *
   * Carried so a caller can report *what* the build resolved with rather than describing it from
   * memory — and so a test can assert the build and the dev server were handed the same object
   * rather than two objects that happen to be equal.
   */
  readonly alias: Readonly<Record<string, string>>;
  /** Whether a workspace graph was found and audited. */
  readonly workspaceAudited: boolean;
}

export interface BuildCellProjectOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Explicit config file, absolute or relative to `root`. Defaults to the candidate search. */
  readonly configFile?: string;
  /**
   * Overrides the config module loader.
   *
   * Forwarded to `loadForguncyConfig`, whose default is right for a one-shot process. A host that
   * lets its config import project files must supply one with module-graph invalidation — see that
   * loader's own contract.
   */
  readonly loadModule?: ForguncyConfigModuleLoader;
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
  /**
   * One resolved decision per non-source dependency, for every Cell in the project.
   *
   * Per project rather than per Cell, matching `planCellCompiles`, because a decision is keyed by
   * `(packageName, cellTarget)` and the *projection* is what narrows it to one Cell —
   * `compilationDependencies(lock, environment, { cellTarget })`. Passing the whole lock's
   * projection and letting each Cell pick its own records is the resolver's rule; re-deriving it
   * here would be a second implementation.
   */
  readonly dependencies: readonly DependencyDecision[];
  /** Which #5 entry shape to expose. Defaults to a function `App` binding. */
  readonly entryKind?: CellEntryKind;
  /**
   * Whether to read and audit the project's pnpm workspace graph (#14/#15).
   *
   * Defaults to `"auto"`: the graph is read when a `pnpm-workspace.yaml` sits at `root`, and
   * skipped when it does not. `true` refuses a project with no workspace file rather than
   * silently compiling without the audit, because "I asked for the audit and got none" is the
   * failure a boolean cannot distinguish from "there was nothing to audit".
   *
   * The workspace root is `root`, the same directory the registry used. In this repository the
   * examples are members of the *repository* workspace rather than workspace roots themselves, so
   * an example that wants the audit passes its own root-relative file — which is why the option
   * is reachable rather than inferred from a package.json walk.
   */
  readonly workspace?: "auto" | boolean;
}

/** The workspace graph this build was handed, or nothing when the project has none. */
async function readWorkspaceGraph(
  root: string,
  requested: "auto" | boolean,
): Promise<{ readonly graph: Awaited<ReturnType<typeof loadPnpmWorkspaceGraph>>["graph"] } | undefined> {
  const workspaceFile = join(root, PNPM_WORKSPACE_FILE);

  if (requested === false) {
    return undefined;
  }

  if (requested === "auto" && !existsSync(workspaceFile)) {
    // Not an error, and saying so matters: `compileCell`'s workspace option is an *audit*, so a
    // project with no workspace manifest has nothing to audit rather than a missing input —
    // #14's rule that an absent input is not an empty one, applied in the direction that keeps
    // an ordinary single-package project compiling.
    return undefined;
  }

  const loaded = await loadPnpmWorkspaceGraph({ root });
  return { graph: loaded.graph };
}

/**
 * Compiles every Cell a project declares, from the project's own configuration.
 *
 * The order is the config's declaration order, because `planCellCompiles` is what orders it and
 * two callers reporting "the Cells of this project" should not disagree about the sequence.
 *
 * Determinism is #97's criterion and it is a property of the inputs rather than of this function:
 * the registry is declaration-ordered, every artifact is a pure function of its entry and
 * decisions, and the bundler applies no timestamps (#6's banner is fixed text). So two builds of
 * one unchanged project produce byte-identical artifacts, which is what makes a build record
 * comparable rather than merely reproducible by eye.
 */
export async function buildCellProject(options: BuildCellProjectOptions): Promise<CellProjectBuild> {
  const registry = await loadForguncyConfig({
    root: options.root,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
    requireEntryFiles: options.requireEntryFiles ?? true,
  });

  const workspace = await readWorkspaceGraph(registry.root, options.workspace ?? "auto");

  // One bundler for the whole project, carrying the two project-scope inputs: the directory
  // entries resolve against, and the alias set. Both come from the registry — the alias set is
  // `registry.resolve.alias`, which is the normalization of the project's own `resolve.alias`
  // block — so there is no second place a caller could inject a different alias set for the
  // build, and none for the dev server either (the harness reads the same field).
  const bundler = createRolldownCellBundler({
    dir: registry.root,
    ...(Object.keys(registry.resolve.alias).length === 0 ? {} : { alias: registry.resolve.alias }),
  });

  const plans = planCellCompiles({ registry, dependencies: options.dependencies });

  const cells: BuiltCell[] = [];
  for (const plan of plans) {
    const codeBudgetCharacters = plan.output?.codeBudgetCharacters;
    const outcome = await compileCell(plan.input, {
      bundler,
      ...(options.entryKind === undefined ? {} : { entryKind: options.entryKind }),
      ...(codeBudgetCharacters === undefined ? {} : { codeBudgetCharacters }),
      ...(workspace === undefined ? {} : { workspace: workspace.graph }),
    });

    cells.push({
      cellId: plan.cellId,
      target: plan.target,
      outcome,
      ...(codeBudgetCharacters === undefined ? {} : { codeBudgetCharacters }),
    });
  }

  return {
    registry,
    cells,
    alias: registry.resolve.alias,
    workspaceAudited: workspace !== undefined,
  };
}

/**
 * The Cells a build compiled, or a thrown refusal naming the ones that did not.
 *
 * Offered because the two behaviours are both wanted and the choice belongs to the caller rather
 * than to this module: `buildCellProject` reports every Cell so a project can be inspected, and a
 * *deployment* caller has no business writing a project whose build is half-failing. So this
 * helper exists for the second caller instead of `buildCellProject` choosing for both.
 *
 * The message names each failing Cell and its diagnostic codes, because a caller that only learns
 * "the build failed" has to re-run the build to find out which Cell it was.
 */
export function requireCompiledCells(build: CellProjectBuild): readonly (BuiltCell & { readonly outcome: Extract<CompileCellOutcome, { status: "compiled" }> })[] {
  const failures = build.cells.filter(cell => cell.outcome.status === "rejected");
  if (failures.length > 0) {
    const detail = failures
      .map(cell => {
        const outcome = cell.outcome as Extract<CompileCellOutcome, { status: "rejected" }>;
        const codes = outcome.diagnostics.map(diagnostic => diagnostic.code).join(", ");
        const workspaceCodes = (outcome.workspace?.diagnostics ?? []).map(diagnostic => diagnostic.code).join(", ");
        return `  - ${cell.cellId}: ${[codes, workspaceCodes].filter(part => part.length > 0).join(", ") || "(no named diagnostic)"}`;
      })
      .join("\n");
    throw new Error(
      `The project's build does not compile ${failures.length} of ${build.cells.length} Cell(s):\n${detail}`,
    );
  }

  return build.cells as readonly (BuiltCell & { readonly outcome: Extract<CompileCellOutcome, { status: "compiled" }> })[];
}
