/**
 * From the #26 registry to a compilable Cell: the compiler side of the seam.
 *
 * Decision source: GitHub Issue #26 — "Spec: project configuration and React Cell
 * target declarations"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/26), downstream of
 * #6's boundary ("a normal module entry plus resolved dependency decisions").
 *
 * `compileCell` takes a bare `entry` string and a decision list; it deliberately
 * knows nothing about projects, configs or Forguncy coordinates. Something has to
 * turn "cell id `orderList` in this loaded project" into that input, and the only
 * place the mapping is already true is the registry — so this module is the thin
 * adapter, and it stays thin on purpose:
 *
 * - **No compilation here.** The plan carries a `CompileCellInput`; calling
 *   `compileCell` is the caller's step, with its bundler and budget options.
 * - **No budget conversion.** `RegisteredCell.output.codeBudgetBytes` is copied
 *   through untouched. #21 owns the code budget and its units; converting bytes
 *   to the compiler's character budget here would be a second, unofficial answer
 *   to a question that Issue has not settled.
 * - **No second target spelling.** The `target` in the plan is the registry's
 *   normalized coordinates — the same two fields `mcp-sync` later writes with —
 *   so compile-time reporting and the eventual `setCells` call cannot disagree.
 *
 * The plan is also where the runtime constants a compiled artifact must agree
 * with travel: the code marker namespace the artifact's stamp will use comes from
 * `registry.runtime`, not from a default re-declared here.
 */

import type { CellRegistry, RegisteredCell } from "@forguncy-react-workspace/core";

import type { CompileCellInput } from "./artifact";

/** Where a compiled artifact would be written, exactly as the config declared it. */
export interface CellCompileTarget {
  readonly pageName: string;
  readonly cell: string;
  /** The registry's recomputed identity key, for logs and diagnostics only. */
  readonly locatorKey: string;
}

/**
 * Everything a caller needs to compile one declared Cell, resolved from the
 * registry rather than reassembled per call site.
 */
export interface CellCompilePlan {
  readonly cellId: string;
  /** The #6 input: a normal module entry plus resolved dependency decisions. */
  readonly input: CompileCellInput;
  readonly target: CellCompileTarget;
  /** The artifact stamp namespace, from `registry.runtime` (default `fgc`). */
  readonly codeMarkerNamespace: string;
  /**
   * The declared output overrides, verbatim.
   *
   * Absent when the config declares none, and never defaulted or unit-converted
   * here: #21 owns the budget semantics.
   */
  readonly output?: RegisteredCell["output"];
}

/**
 * Resolves one declared Cell id to a compilation plan.
 *
 * `registry.require` is used rather than `get`, so an unknown id fails with the
 * registry's own explanation of which ids exist instead of becoming a plan with
 * an `undefined` entry somewhere inside it.
 */
export function planCellCompile(options: {
  readonly registry: CellRegistry;
  readonly cellId: string;
  readonly dependencies: CompileCellInput["dependencies"];
}): CellCompilePlan {
  const { registry, cellId, dependencies } = options;
  const cell: RegisteredCell = registry.require(cellId);

  return buildPlan(cell, registry.runtime.codeMarkerNamespace, dependencies);
}

/**
 * Plans every declared Cell in the registry, in declaration order.
 *
 * For the whole-project callers — the Vite plugin's build loop and a batch CLI —
 * so "compile everything the config declares" has one implementation and one
 * order (the config's), rather than each caller iterating `registry.cells` and
 * re-deriving the plan fields itself.
 */
export function planCellCompiles(options: {
  readonly registry: CellRegistry;
  readonly dependencies: CompileCellInput["dependencies"];
}): readonly CellCompilePlan[] {
  const { registry, dependencies } = options;
  return registry.cells.map(cell => buildPlan(cell, registry.runtime.codeMarkerNamespace, dependencies));
}

function buildPlan(
  cell: RegisteredCell,
  codeMarkerNamespace: string,
  dependencies: CompileCellInput["dependencies"],
): CellCompilePlan {
  return {
    cellId: cell.id,
    input: { entry: cell.entryPath, dependencies },
    target: {
      pageName: cell.target.pageName,
      cell: cell.target.cell,
      locatorKey: cell.target.locatorKey,
    },
    codeMarkerNamespace,
    ...(cell.output === undefined ? {} : { output: cell.output }),
  };
}
