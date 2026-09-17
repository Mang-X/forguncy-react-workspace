/**
 * The ReactCellType cell compiler boundary.
 *
 * Governing Spec Issue: #6 (generated artifact and compiler boundary);
 * implementation Issue: #7. Project identity is owned by #26/#28, which is why
 * this package never accepts a bare entry path or a bare `{ pageName, cell }`
 * pair: it resolves the Cell from the shared registry so the compiler, the dev
 * harness and MCP sync cannot disagree about what a Cell is.
 */

import type {
  CellRegistry,
  DependencyDecision,
  DependencyStrategy,
  NormalizedCellTarget,
  RegisteredCell,
} from "@forguncy-react-workspace/core";

export interface CompileCellInput {
  /** Normalized project registry; the Cell is resolved from it, never re-declared. */
  readonly registry: CellRegistry;
  /** Logical Cell id, i.e. the key in `forguncy.config.ts`. */
  readonly cellId: string;
  readonly dependencies: readonly DependencyDecision[];
}

/** Everything the compiler needs to know once the Cell has been resolved. */
export interface CellCompilePlan {
  readonly cellId: string;
  readonly entryPath: string;
  readonly target: NormalizedCellTarget;
  /** Marker namespace generated code carries, from the project runtime target. */
  readonly codeMarkerNamespace: string;
  /** Dependency strategies this build must implement, in declaration order. */
  readonly dependencyStrategies: readonly DependencyStrategy[];
}

export interface CompileCellResult {
  code: string;
  frontendLibraries: Array<{ libraryId: string }>;
}

/**
 * Resolves a Cell to its compile inputs.
 *
 * Re-exported rather than inlined into `compileCell` because every caller that
 * needs "where does this Cell deploy to" — a build script, an MCP plan, a test —
 * should ask the same question and get the same answer.
 */
export function planCellCompile(input: CompileCellInput): CellCompilePlan {
  const cell: RegisteredCell = input.registry.require(input.cellId);

  return {
    cellId: cell.id,
    entryPath: cell.entryPath,
    target: cell.target,
    codeMarkerNamespace: input.registry.runtime.codeMarkerNamespace,
    dependencyStrategies: input.dependencies.map(dependency => dependency.strategy),
  };
}

export async function compileCell(input: CompileCellInput): Promise<CompileCellResult> {
  const plan = planCellCompile(input);

  throw new Error(
    `Cell compilation is not implemented yet (Issue #7, which depends on Spec #6). ` +
      `Resolved "${plan.cellId}" -> ${plan.entryPath} for Forguncy target ${plan.target.locatorKey}.`,
  );
}
