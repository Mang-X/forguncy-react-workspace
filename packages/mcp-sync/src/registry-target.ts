/**
 * From a declared Cell id to a sync target: the seam #26 owns, on #19's side.
 *
 * Decision source: GitHub Issue #26 — "Spec: project configuration and React Cell
 * target declarations"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/26), downstream of
 * #19's split ("resolve target page + cell from project configuration" /
 * "write/update ReactCellType using `page.setCells`").
 *
 * #19 deliberately did not read a project's targets: sync receives a target as
 * input, which is what makes "sync targets must be explicit" structurally true
 * rather than a convention. The missing half — where the explicit target comes
 * from — is exactly this module: the `core` registry is the single place
 * "which entry is which Forguncy Cell" is answered, so sync resolves through it
 * instead of parsing the config itself.
 *
 * Two invariants are enforced here rather than left to callers:
 *
 * - **The boundary re-check.** A registry may arrive from a host, a cache or a
 *   deserialized payload, so `assertUniqueTargets` runs before any target leaves
 *   this module. Identity is recomputed from `pageName` + `cell` there (a stored
 *   `locatorKey` is never trusted), because after a partial sync there is no
 *   safe rollback.
 * - **The request re-check.** The registry guard covers what the project
 *   *declares*; a request can still name one id twice, and two requests for one
 *   destination are the same last-write-wins hazard the guard exists for. So the
 *   resolved claims are re-asserted with `assertDistinctTargetClaims` before any
 *   of them leaves the module: one Cell owns one target, in the registry *and*
 *   in the batch being planned.
 * - **No second locator spelling.** The returned `CellTarget` is the registry's
 *   normalized `pageName`/`cell` verbatim — the two fields `api.page.setCells`
 *   takes — so the plan, the dispatch and the designer call all carry the same
 *   coordinates the config declared.
 *
 * Structurally, not by convention: every exported function that *produces* a
 * target resolves it through this module's guarded path. `syncCellInput` takes
 * a registry and a Cell id rather than a registry entry, so there is no way to
 * assemble a writable `SyncCellInput` from an unguarded registry.
 */

import { assertDistinctTargetClaims, assertUniqueTargets } from "@forguncy-react-workspace/core";
import type { CellRegistry, RegisteredCell } from "@forguncy-react-workspace/core";

import { planCellSync } from "./sync-plan";
import type { CellSyncPlan, PlanCellSyncOptions } from "./sync-plan";
import type { CellTarget, SyncCellInput } from "./target";

/**
 * One resolved destination: the logical Cell id and the coordinates sync writes.
 *
 * `locatorKey` is carried for diagnostics and log correlation only. It is never
 * an input to a write: the platform acts on `pageName` + `cell`.
 */
export interface ResolvedCellSyncTarget {
  readonly cellId: string;
  readonly target: CellTarget;
  readonly locatorKey: string;
}

/**
 * A registry entry's destination, spelled exactly as the platform spells it.
 *
 * One helper rather than the same object literal at three call sites: the two
 * fields are `api.page.setCells`'s own names, and copying them by hand is how a
 * local spelling would eventually sneak in.
 */
function targetOf(cell: RegisteredCell): CellTarget {
  return { pageName: cell.target.pageName, cell: cell.target.cell };
}

/**
 * Resolves one declared Cell id to the target sync would write to.
 *
 * Runs the mutation-boundary guard first, so a registry whose targets collide —
 * or whose carried keys contradict its coordinates — is refused here rather
 * than one `setCells` call later.
 */
export function resolveCellSyncTarget(registry: CellRegistry, cellId: string): ResolvedCellSyncTarget {
  const [resolved] = resolveCellSyncTargets(registry, [cellId]);
  if (resolved === undefined) {
    // Unreachable: the batch resolver returns one entry per requested id, and
    // `require` inside it throws for an unknown id before returning. Written as
    // a throw rather than an empty-target fallback because an empty `pageName`
    // would be a *writable* target, and this module's whole job is that no
    // unplanned destination is ever writable.
    throw new Error(`No resolved target for Cell ${cellId}.`);
  }
  return resolved;
}

/**
 * Resolves a batch of declared Cell ids, guarding the registry *and* the batch.
 *
 * Two guards, because they cover different ways to arrive at one destination
 * twice: `assertUniqueTargets` covers what the project declares, and
 * `assertDistinctTargetClaims` runs on the *resolved request* — so `["orderList",
 * "orderList"]`, or two ids a forged registry maps onto one coordinates pair,
 * fails here rather than producing two plans for one Forguncy Cell. One guard
 * call for the batch rather than one per cell: the conflict is between the
 * members, and only the full set can show it.
 */
export function resolveCellSyncTargets(
  registry: CellRegistry,
  cellIds: readonly string[],
): readonly ResolvedCellSyncTarget[] {
  assertUniqueTargets(registry);

  const resolved = cellIds.map(cellId => {
    const cell = registry.require(cellId);
    return {
      cellId: cell.id,
      target: targetOf(cell),
      locatorKey: cell.target.locatorKey,
    };
  });

  assertDistinctTargetClaims(
    resolved.map(claim => ({
      cellId: claim.cellId,
      pageName: claim.target.pageName,
      cell: claim.target.cell,
      locatorKey: claim.locatorKey,
    })),
    "cell sync request",
  );

  return resolved;
}

/**
 * The minimal sync input, assembled from a registry and a declared Cell id.
 *
 * Takes `registry` + `cellId` rather than a registry entry on purpose: the
 * entry is the value that could have come from a forged or stale registry
 * without passing any guard, so the helper resolves through the guarded batch
 * path itself. `SyncCellInput` stays exactly `{ target, artifact }` — this
 * helper removes the *lookup* step (id → entry → coordinates), not the
 * boundary, and nothing else about a plan — decisions, deployed state, policy —
 * is folded in here.
 */
export function syncCellInput(
  registry: CellRegistry,
  cellId: string,
  artifact: SyncCellInput["artifact"],
): SyncCellInput {
  const [resolved] = resolveCellSyncTargets(registry, [cellId]);
  if (resolved === undefined) {
    // Unreachable for the same reason as in `resolveCellSyncTarget`.
    throw new Error(`No resolved target for Cell ${cellId}.`);
  }
  return { target: resolved.target, artifact };
}

/** One planned sync: the declared Cell id plus everything `planCellSync` needs. */
export interface CellSyncTargetPlan extends Pick<PlanCellSyncOptions, "artifact" | "decisions" | "deployed"> {
  readonly cellId: string;
  readonly listings?: PlanCellSyncOptions["listings"];
  readonly mappings?: PlanCellSyncOptions["mappings"];
  readonly overwrite?: PlanCellSyncOptions["overwrite"];
}

/**
 * Plans a batch of declared Cells against one loaded project.
 *
 * The batch is resolved — and uniqueness re-asserted across all of it — before
 * any plan is built, so a project where two ids claim one destination fails as
 * a whole instead of producing N-1 plans and one silent overwrite.
 */
export function planCellSyncTargets(
  registry: CellRegistry,
  plans: readonly CellSyncTargetPlan[],
): readonly CellSyncPlan[] {
  const resolved = resolveCellSyncTargets(
    registry,
    plans.map(plan => plan.cellId),
  );

  return plans.map((plan, index) => {
    const resolvedTarget = resolved[index];
    if (resolvedTarget === undefined) {
      // Unreachable: `resolveCellSyncTargets` returned one entry per input.
      throw new Error(`No resolved target for Cell ${plan.cellId}.`);
    }

    return planCellSync({
      target: resolvedTarget.target,
      artifact: plan.artifact,
      decisions: plan.decisions,
      deployed: plan.deployed,
      ...(plan.listings === undefined ? {} : { listings: plan.listings }),
      ...(plan.mappings === undefined ? {} : { mappings: plan.mappings }),
      ...(plan.overwrite === undefined ? {} : { overwrite: plan.overwrite }),
    });
  });
}
