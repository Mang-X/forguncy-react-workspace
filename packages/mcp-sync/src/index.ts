/**
 * One-way MCP sync from generated artifacts into Forguncy ReactCellType Cells.
 *
 * Governing Spec Issue: #19 (one-way MCP sync); implementation Issue: #20. The
 * Forguncy-facing mutation itself is not implemented yet, but the part that must
 * be true *before* any mutation is: a Cell resolves from the shared registry, an
 * unknown id is refused, and two Cells claiming one Forguncy target are refused
 * before the first write.
 *
 * Spec #26 puts the target locator model under #5/#19 evidence. Until that
 * evidence lands, the locator is carried here as `pageName` + `cell` — exactly the
 * coordinates `api.page.setCells` consumes.
 */

import { assertDistinctTargetClaims, assertUniqueTargets } from "@forguncy-react-workspace/core";
import type { CellRegistry } from "@forguncy-react-workspace/core";

import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

/** The Forguncy destination of one Cell, ready to be written. */
export interface CellSyncTarget {
  readonly cellId: string;
  readonly pageName: string;
  readonly cell: string;
  readonly locatorKey: string;
  /** Source entry the artifact was generated from, for the sync report. */
  readonly entryPath: string;
}

export interface SyncCellInput {
  readonly registry: CellRegistry;
  readonly cellId: string;
  readonly artifact: CompileCellResult;
}

/**
 * Resolves one Cell to its Forguncy destination.
 *
 * Throws a `ForguncyConfigError` for an unknown id, so an MCP caller gets the list
 * of declared Cells instead of writing to a guessed page.
 */
export function resolveCellSyncTarget(registry: CellRegistry, cellId: string): CellSyncTarget {
  const cell = registry.require(cellId);

  return {
    cellId: cell.id,
    pageName: cell.target.pageName,
    cell: cell.target.cell,
    locatorKey: cell.target.locatorKey,
    entryPath: cell.entryPath,
  };
}

/**
 * Resolves a whole sync batch and refuses it if it would write one target twice.
 *
 * The two failure modes are deliberately separated: an unknown id is a config
 * problem (`unknown-cell-id`), while two ids reaching one target is a duplicate
 * (`duplicate-target`). Both must stop the batch before the first MCP call,
 * because a partially synced project cannot be rolled back safely.
 */
export function planCellSyncTargets(registry: CellRegistry, cellIds: readonly string[]): readonly CellSyncTarget[] {
  // Registry invariant first, then the batch: a collision anywhere in the project's
  // target map means the map is ambiguous, and a partial sync cannot be rolled back.
  assertUniqueTargets(registry);

  const targets = cellIds.map(cellId => resolveCellSyncTarget(registry, cellId));
  assertDistinctTargetClaims(
    targets.map(target => ({ cellId: target.cellId, locatorKey: target.locatorKey })),
    registry.configPath ?? "cell registry",
  );
  return targets;
}

export async function syncCell(input: SyncCellInput): Promise<void> {
  // The registry invariant is checked first and on its own: a collision anywhere in
  // the project's target map means the map is ambiguous, and a partially synced
  // Forguncy project cannot be rolled back.
  assertUniqueTargets(input.registry);

  const target = resolveCellSyncTarget(input.registry, input.cellId);

  throw new Error(
    `Forguncy MCP synchronization is not implemented yet (Issue #20, which depends on Spec #19). ` +
      `Resolved "${target.cellId}" -> ${target.pageName}!${target.cell} (entry ${target.entryPath}); ` +
      `no project mutation was attempted.`,
  );
}
