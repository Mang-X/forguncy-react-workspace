/**
 * #19's flow, executed against a designer session.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19) and the
 * implementation Issue #20 —
 * "Implement: MCP sync for generated Cell code and extension references"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/20).
 *
 * ## What this module is, and what it is not
 *
 * `sync-plan.ts` decides *whether* a Cell may be written and assembles the payload;
 * this module *runs the flow* — read, verify, write, save, check, generate — against
 * whatever {@link ForguncySyncPort} it is handed. Both halves are needed and neither
 * is the other: a plan alone never touches a designer, and an executor that decided
 * its own policy would be a second copy of the rules the plan exists to enforce.
 *
 * It is still not a *transport*. The port is an interface; which MCP session, which
 * URL, which retry policy is the adapter's, and #20's evidence about the designer's
 * wire shape lives in the adapter rather than here. That split is what keeps this
 * module testable without a Forguncy install and keeps the adapter's mapping honest:
 * a call this module makes is a call some evidence named.
 *
 * ## The ordering, and why it is executed rather than described
 *
 * #19's flow is a sequence with safety consequences, and every one of them is a
 * *before* or *after* the single mutation:
 *
 * 1. verify the extension metadata from the listing **before** the write;
 * 2. read the target **before** the write, so a probable designer edit is found while
 *    it can still stop the write;
 * 3. write the Cell — only when the plan's own dispatch says `issue`;
 * 4. save the project **only if** it has unsaved changes;
 * 5. check the project's errors **after** the write;
 * 6. generate the page **after** the errors are known to be zero;
 * 7. return the runtime locator.
 *
 * Steps 4–7 are also what an `unchanged` run performs, and that is deliberate rather than
 * an exception to the order: steps 1–2 established there is nothing to write, and steps
 * 5–6 are the *validation* half of the flow, which a skip does not make unnecessary. What
 * an `unchanged` run does not do is step 3, and the save step is a read-only decision on
 * that path — the project is not dirty from a write that did not happen, and the step says
 * `skipped` rather than saving a clean project.
 *
 * Steps 1–2 are the executor's own calls, and that placement is the design: it reads the
 * extension listing and the target's current state through the port *immediately* before
 * planning, so "before mutation" means *at this moment* rather than *per the caller*. The
 * options type has no field for either observation, so a stale or fabricated read is not
 * expressible — the alternative, accepting a caller's `deployed`, would let a run write over
 * a Cell a designer had edited since the caller looked, and would call that a verified sync.
 * Step 3 is the only mutating call, and it is reachable only through `planSetCellsDispatch`:
 * handing the plan's payload straight to the port does not compile, which is what makes "the
 * payload is not the permission" a check rather than a convention.
 *
 * `planCellSync` still takes a required `deployed`, and deliberately: planning is a pure
 * function of a state someone supplies (a dry run, a review, a test) and has to stay
 * callable with one. Reading is the executor's obligation, not the planner's.
 *
 * ## What it will not do
 *
 * - **It will not write when the plan refused.** A refused or unassemblable plan produces
 *   a {@link CellSyncRun} whose `status` is `refused`, and the run stops before the write.
 *   The steps after it are `not-reached`: nothing about them is wrong, the flow simply did
 *   not get there, and there is no deployment to verify.
 * - **It will not read "nothing to write" as "nothing to verify".** A target that already
 *   holds this artifact is the one hold that is not a refusal. The run reports `unchanged`,
 *   issues no `setCells`, and *does* run the save-status read, the error check and the
 *   generation — because the Cell already holding this artifact says nothing about whether
 *   the project has errors or whether the page still generates. A caller that asked for a
 *   deployment locator gets one whether or not the write was needed.
 *
 *   The locator an `unchanged` run returns is **this run's**, never a previous run's: the
 *   step that produced it is on `steps`, and a generation that fails on this path fails the
 *   run rather than falling back to a stale URL. That is why the locator is a required field
 *   of the `unchanged` variant and of `written`, and absent from `refused` — its presence is
 *   the verification result, so "unchanged, but nothing was verified" is not expressible.
 * - **It will not hide a save it performed.** The save step is the one thing an `unchanged`
 *   run can still do to the project, and it is the caller's to know about: `mutated` is on
 *   the `unchanged` variant as well as on `failed`, because "nothing was written" is a claim
 *   about the *Cell* and not about the project. A skip that persisted the project and
 *   reported only `unchanged` would tell a caller nothing had changed while the project had
 *   just been written to disk.
 * - **It will not save unconditionally.** #20 measured that a `setCells` write leaves
 *   `containsUnsavedChanges: true`, so the save is required after a write — but it is
 *   requested as "save if the project says it is dirty", not "always save", because
 *   the second would make a clean project's state depend on sync running. On the `unchanged`
 *   path the same read is what keeps a clean project clean: the step reports `skipped` rather
 *   than saving, because sync's own write is not what made anything dirty.
 * - **It will not report a failed run as a successful one.** A non-zero error count
 *   or a generation with no locator produces `status: "failed"` with the diagnostic
 *   that says why; the locator is only present when the flow reached generation *and*
 *   it succeeded.
 * - **It will not swallow a transport failure.** A rejected port call is a thrown
 *   error, not a manufactured diagnostic: the stack is the only thing that helps for
 *   a transport problem, and manufacturing a finding would lose it. See
 *   `step-outcomes.ts` for the same rule stated on the other side.
 */

import type { CellRegistry } from "@forguncy-react-workspace/core";

import {
  assertMcpSyncFlowIsCoherent,
  findMcpSyncStep,
  unestablishedSyncCapabilities,
} from "./capability-surface.ts";
import type { McpSyncStepId } from "./capability-surface.ts";
import { createSyncDiagnostic } from "./diagnostics.ts";
import type { SyncDiagnostic } from "./diagnostics.ts";
import type { CellDivergence, DeployedCellState } from "./divergence.ts";
import { planCellSync, planSetCellsDispatch } from "./sync-plan.ts";
import type { CellSyncPlan, CellSyncRefusalDispatch, PlanCellSyncOptions } from "./sync-plan.ts";
import { outcomeOfPageGeneration, outcomeOfProjectErrorCheck } from "./step-outcomes.ts";
import { cellTargetLabel } from "./target.ts";
import { resolveCellSyncTargets } from "./registry-target.ts";
import type { CellSyncTargetPlan } from "./registry-target.ts";
import type {
  ForguncySyncPort,
  GeneratedPage,
  ReadCellSourceResult,
} from "./port.ts";
import type { CellTarget } from "./target.ts";

// ---------------------------------------------------------------------------
// What one step did
// ---------------------------------------------------------------------------

/**
 * Whether a step ran.
 *
 * `skipped` is a *deliberate* non-run with a reason — a clean project needs no save, and an
 * unchanged target needs no write — and it is separate from `not-reached`, which is a step
 * the flow never got to because an earlier one stopped it. Reporting the two together would
 * make "we chose not to save" read as "the sync died before saving", and would describe an
 * unchanged run as a truncated one.
 */
export type SyncRunStepStatus = "ran" | "skipped" | "not-reached" | "blocked";

export interface SyncRunStep {
  readonly stepId: McpSyncStepId;
  readonly order: number;
  readonly status: SyncRunStepStatus;
  /** Why it did not run, when it did not. */
  readonly detail?: string;
}

/** One executed step's status, in flow order. */
export type SyncRunSteps = readonly SyncRunStep[];

// ---------------------------------------------------------------------------
// What a read established
// ---------------------------------------------------------------------------

/**
 * A read performed by the executor, and what it means for the plan.
 *
 * Two fields rather than one because they answer different questions: the raw
 * {@link ReadCellSourceResult} is what the adapter returned, and the
 * {@link DeployedCellState} is what the plan classifies. Keeping both means a
 * reviewer can see what the product actually said when a conflict is reported,
 * instead of inferring it from a classification.
 */
export interface CellReadOutcome {
  readonly result: ReadCellSourceResult;
  readonly state: DeployedCellState;
}

/**
 * Translate what the product returned into what the plan classifies.
 *
 * The one place the product's three states and this contract's three states meet, so
 * the mapping exists once. It is deliberately a total function on the product's
 * result rather than a chain of `if`s at the call site: `blank` must become `read`
 * with an empty code (the target is genuinely vacant and writable), `occupied` must
 * become `occupied` (designer work, refused), and only a `react-cell` may become a
 * `read` with a real code. A reader that got this wrong in either direction would
 * either overwrite a designer's cell or refuse every fresh one.
 */
export function deployedStateOfRead(result: ReadCellSourceResult): DeployedCellState {
  switch (result.kind) {
    case "blank":
      return { kind: "read", code: "" };
    case "occupied":
      return { kind: "occupied", detail: result.code };
    case "react-cell":
      return { kind: "read", code: result.code, frontendLibraries: result.frontendLibraries };
  }
}

// ---------------------------------------------------------------------------
// What a run produced
// ---------------------------------------------------------------------------

export const CELL_SYNC_RUN_STATUSES = ["written", "unchanged", "refused", "failed"] as const;

export type CellSyncRunStatus = (typeof CELL_SYNC_RUN_STATUSES)[number];

/**
 * The result of executing one target's sync.
 *
 * Four statuses, and the split between `unchanged` and `refused` is the point of this shape.
 * The previous version reported both as `held`, which conflated "the write was not needed"
 * with "the write was forbidden": they call for different next actions — a refusal has to be
 * looked at by a person, an unchanged target is a finished sync — and a caller told the same
 * status for a skip as for a conflict would go looking for a conflict that is not there. The
 * plan's own vocabulary keeps both as *holds* (`CELL_SYNC_HOLD_REASONS`), because at that
 * layer "the dispatch did not issue" is the one fact; the run's status is where the two
 * consequences separate.
 *
 * A discriminated union rather than a status plus optional fields, for the reason
 * `sync-plan.ts` gives about `CellSyncWrite`: the four carry different things, and a shape
 * that could hold all of them would let a caller read the wrong one.
 *
 * `runtime` is present on `written` and on `unchanged` and **absent from `refused` and
 * `failed`**. On `written` it means the deployment happened; on `unchanged` it means the
 * deployment was already there and *this* run still checked the project and generated the
 * page. It is a required field on both rather than an optional one, so neither "written with
 * nothing to open" nor "unchanged with nothing verified" is representable — and it is
 * deliberately not carried on `refused`, because there is no deployment to locate.
 */
export type CellSyncRun =
  | {
      readonly status: "written";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The locator the flow produced.
       *
       * Present exactly when the write landed, the project was checked and the page
       * generated — the three conditions the caller needs before opening a browser.
       */
      readonly runtime: GeneratedPage;
      readonly steps: SyncRunSteps;
      readonly divergence: CellDivergence;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      /**
       * The target already held this artifact, so nothing was written.
       *
       * A skip, not a refusal: the plan's dispatch held for `already-identical`, and the
       * run still performed the validation half of the flow.
       */
      readonly status: "unchanged";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The locator **this** run's generation produced.
       *
       * Required rather than optional, and it is the run's own: a skip says the Cell is
       * already correct, not that the project was checked or the page generated. Reusing a
       * previous run's locator here would claim a verification this run did not perform,
       * and the failure — an `unchanged` run reported as verified while generation failed —
       * is exactly what a browser-verification step would then act on.
       */
      readonly runtime: GeneratedPage;
      readonly steps: SyncRunSteps;
      readonly divergence: CellDivergence;
      /**
       * This run changed project state even though it wrote no Cell.
       *
       * True exactly when the save step persisted a project the product reported dirty. It
       * is the same question {@link CellSyncRun}'s `failed` variant asks, and it is here for
       * the same reason: "nothing was written" is a claim about the Cell, not about the
       * project, and a caller deciding whether it may discard a backup needs the project's
       * answer rather than the Cell's.
       */
      readonly mutated: boolean;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      readonly status: "refused";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The plan's own answer for why nothing was sent.
       *
       * Narrowed to a *refusing* hold rather than the full {@link CellSyncDispatch}: a run
       * is `refused` precisely because the dispatch held for a reason that stops the flow,
       * so a caller should not have to re-check what this type already knows — and a
       * `already-identical` dispatch is not assignable here, which is what keeps the skip
       * from being reported as a refusal.
       */
      readonly dispatch: CellSyncRefusalDispatch;
      readonly steps: SyncRunSteps;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      readonly steps: SyncRunSteps;
      /** What failed, in the sync's own vocabulary. Never empty. */
      readonly diagnostics: readonly SyncDiagnostic[];
      /**
       * This run changed project state before it failed.
       *
       * Two ways that happens, and both count: the Cell write landed, or the project
       * reported unsaved changes and the save persisted them. Carried so a caller knows
       * whether the project was changed before deciding what to do next — a run that failed
       * at the error check left a Cell written, a run that failed after a save left the
       * project persisted, and a run that failed to assemble left nothing.
       */
      readonly mutated: boolean;
    };

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Everything the executor needs to plan and then execute one target's sync.
 *
 * Deliberately **without** `deployed` or `listings`. Both are things #19 requires to be
 * true *at the moment of the write* — the target's current state, and the project's
 * installed extensions — and a caller-supplied copy of either is a value nobody just
 * observed. An executor that trusted them could be handed a stale `{ kind: "read", code: "" }`
 * for a Cell a designer had since edited, or a fabricated listing, and would write anyway;
 * "the caller says it read this" is not what `before mutation` means. So the executor reads
 * both through the port itself, immediately before planning, and the types make the
 * bypass unrepresentable rather than discouraged.
 *
 * That is why the plan's own `PlanCellSyncOptions` keeps its required `deployed`: planning
 * is a pure function of a state someone supplies (a dry run, a review, a test), and it must
 * stay callable with one. The read is the *executor's* obligation, not the planner's.
 *
 * `mappings` remains accepted because it is configuration — a table to audit against, not
 * an observation of the project.
 */
export interface ExecuteCellSyncOptions extends Omit<PlanCellSyncOptions, "deployed" | "listings"> {
  readonly port: ForguncySyncPort;
}

/** The steps a run performs, in the flow's own order, built once for every outcome. */
function runSteps(
  performed: ReadonlyMap<McpSyncStepId, SyncRunStepStatus>,
  detail: ReadonlyMap<McpSyncStepId, string> = new Map(),
): SyncRunSteps {
  return [...performed.entries()].map(([stepId, status]) => {
    const step = findMcpSyncStep(stepId);
    const why = detail.get(stepId);
    return { stepId, order: step.order, status, ...(why === undefined ? {} : { detail: why }) };
  });
}

/**
 * Execute one target's sync: read the project's live state, plan it, then run the flow.
 *
 * The order is load-bearing and it is why this function is the safe entry point:
 *
 * 1. **read** the installed extensions (`listFrontendLibraries`) and the target Cell's
 *    current state (`readCellSource`) through the port;
 * 2. **plan** from exactly what was just read;
 * 3. **execute** what the plan permits.
 *
 * Steps 1 and 2 are not separable by a caller — the options type has no `deployed` or
 * `listings` to supply — so "the extensions were verified before the mutation" and "the
 * target's current state was read before the mutation" are properties of the code path
 * rather than claims about a caller's diligence. A caller cannot hand this function a stale
 * read, and cannot skip the read: there is nowhere to put one.
 *
 * The plan is then consulted before any mutating call, so a refused or skipped target never
 * reaches `setCells`. A resolved-but-unusable post-mutation result fails the run rather than
 * being returned as a success: see the module docstring.
 */
export async function executeCellSync(options: ExecuteCellSyncOptions): Promise<CellSyncRun> {
  // The flow's own coherence before anything is executed: a run over a registry that
  // contradicts itself would be a confident answer to the wrong question, and this is
  // the same guard `planCellSync` runs so the two cannot disagree about the flow.
  assertMcpSyncFlowIsCoherent();

  const { port, target } = options;

  // Step 1a: the project's installed extensions, read now. Unconditional: the plan is what
  // decides whether an artifact's references matter, and it can only decide that against a
  // real listing.
  const listings = await port.listFrontendLibraries({});

  // Step 1b: the target's live state, read now, through the one three-way translation the
  // product requires. Reading through the port rather than accepting a caller's value is
  // what makes `before mutation` mean *at this moment* instead of *per the caller*.
  const { state: deployed } = await readCellState(port, target);

  // Step 2: the plan, from exactly what was just read.
  const plan = planCellSync({ ...options, deployed, listings });

  const performed = new Map<McpSyncStepId, SyncRunStepStatus>();
  const details = new Map<McpSyncStepId, string>();
  performed.set("resolve-cell-target", "ran");

  // The capabilities the flow needs. Read before executing rather than reported after
  // a failure: an empty result is the precondition for running at all, and #20's own
  // handover comment says exactly this — check it before executing, not after.
  const unestablished = unestablishedSyncCapabilities();
  if (unestablished.length > 0) {
    // Unreachable with the shipped registry (every required capability is
    // established as of #20), and written as a refusal rather than an assumption so a
    // future operation that loses its evidence stops the run here instead of sending a
    // write whose validation cannot complete.
    for (const step of plan.steps) performed.set(step.stepId, "blocked");
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: plan.diagnostics.filter(diagnostic => diagnostic.code === "sync-capability-unestablished"),
      mutated: false,
    };
  }

  // Both pre-mutation checks ran, in the two lines above the plan. The plan models the
  // "no listing supplied" state for dry runs; this entry point cannot reach it, which is
  // why the statuses are unconditional here.
  performed.set("verify-extension-metadata", "ran");
  performed.set("read-target-state", "ran");

  const dispatch = planSetCellsDispatch(plan);
  if (dispatch.kind === "hold") {
    // The skip is the one hold that does not stop the flow: the target already holds this
    // artifact, so the write is unnecessary — which says nothing about whether the project
    // is valid or whether the page still generates. So it runs the same validation half the
    // written path does, and reports `unchanged` rather than `refused`, because a caller
    // that conflated the two would go looking for a conflict that is not there.
    if (dispatch.reason === "already-identical") {
      // `skipped`, not `not-reached`: the flow did not die before the write, it chose not to
      // make one. The two are different answers — `SyncRunStepStatus` exists to keep "we
      // chose not to" from reading as "the sync stopped here" — and a step list that reported
      // this as `not-reached` would describe an unchanged run as a truncated one.
      performed.set("write-cell-source", "skipped");
      details.set("write-cell-source", "The target already holds this artifact, so nothing was written.");

      const completion = await completeSyncFlow({ port, target, performed, details, wroteCell: false });
      if (completion.kind === "failed") {
        return {
          status: "failed",
          target,
          plan,
          steps: runSteps(performed, details),
          diagnostics: completion.diagnostics,
          mutated: completion.mutated,
        };
      }

      return {
        status: "unchanged",
        target,
        plan,
        // This run's own locator. A skip is not a licence to reuse an earlier run's URL:
        // generation ran here, and its failure above would have failed the run.
        runtime: completion.runtime,
        steps: runSteps(performed, details),
        divergence: plan.divergence,
        // Whether the save step persisted the project. Not implied by the status: a run can
        // be `unchanged` and still have written to disk.
        mutated: completion.mutated,
        diagnostics: plan.diagnostics,
      };
    }

    // Every other hold stops the flow where it is, and there is no deployment to locate.
    // The steps after the write are `not-reached` rather than `blocked`: nothing is wrong
    // with them, the flow simply did not get there.
    performed.set("write-cell-source", "not-reached");
    performed.set("save-project-if-required", "not-reached");
    performed.set("check-project-errors", "not-reached");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return {
      status: "refused",
      target,
      plan,
      // The dispatch is narrowed by its own type: `already-identical` is not assignable
      // here, so this branch cannot report the skip as a refusal.
      dispatch,
      steps: runSteps(performed, details),
      diagnostics: plan.diagnostics,
    };
  }

  // Step 4: the write. The only mutating call, and it can only be reached with the
  // request the dispatch minted — the port's parameter type makes any other value a
  // compile error at this call site.
  await port.setCells(dispatch.request);
  performed.set("write-cell-source", "ran");

  const completion = await completeSyncFlow({ port, target, performed, details, wroteCell: true });
  if (completion.kind === "failed") {
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: completion.diagnostics,
      mutated: completion.mutated,
    };
  }

  return {
    status: "written",
    target,
    plan,
    runtime: completion.runtime,
    steps: runSteps(performed, details),
    divergence: plan.divergence,
    // The plan's diagnostics only. The read-only steps' outcomes are on `steps`, and
    // repeating them here would make a caller read two lists for one run.
    diagnostics: plan.diagnostics,
  };
}

/**
 * The validation half of the flow: save if the project is dirty, check its errors, generate
 * the page, and hand back the locator.
 *
 * Extracted so the written and the unchanged paths cannot disagree about it. They differ in
 * exactly one input — whether this run wrote the Cell — and the point of the extraction is
 * that the difference stays that small: a second copy of the error gate or of the generation
 * call is where one path would quietly stop checking something.
 *
 * `wroteCell` decides one thing only, and it is the honest one: whether the run's own
 * mutation is what the project is being asked to persist. A save the product declines is
 * reported either way, because the safety rule is about the project being left unpersisted
 * rather than about who made it dirty — and `mutated` answers the caller's actual question,
 * "was anything changed before I decide what to do next?", so a run that persisted the
 * project reports it even though it never touched a Cell.
 */
async function completeSyncFlow(options: {
  readonly port: ForguncySyncPort;
  readonly target: CellTarget;
  readonly performed: Map<McpSyncStepId, SyncRunStepStatus>;
  readonly details: Map<McpSyncStepId, string>;
  readonly wroteCell: boolean;
}): Promise<
  | { readonly kind: "completed"; readonly runtime: GeneratedPage; readonly mutated: boolean }
  | { readonly kind: "failed"; readonly diagnostics: readonly SyncDiagnostic[]; readonly mutated: boolean }
> {
  const { port, target, performed, details, wroteCell } = options;

  // Step 5: the save, conditional on the product's own answer. #20 measured that a
  // `setCells` write leaves `containsUnsavedChanges: true`, so the check is what turns
  // #19's conditional save into a decision rather than a guess. On the unchanged path the
  // same rule applies to the same read: the write did not happen, so this is the *project's*
  // dirtiness rather than sync's, and "save when the project says it is dirty" is still the
  // rule — an unconditional save would make a clean project's state depend on sync running.
  const saveStatus = await port.getProjectSaveStatus({});
  let persisted = false;
  if (saveStatus.containsUnsavedChanges) {
    const saved = await port.saveProject();
    performed.set("save-project-if-required", "ran");
    if (!saved.saved) {
      // A save the product declined. Reported through the project-state owner because
      // the project — not sync and not the extension — is what is left unpersisted. It
      // fails the run on both paths: a skip is not a reason to let an unpersisted project
      // through, and the gate is the same one.
      details.set("save-project-if-required", "The product was asked to save and did not.");
      performed.set("check-project-errors", "not-reached");
      performed.set("generate-page", "not-reached");
      performed.set("return-runtime-locator", "not-reached");
      return {
        kind: "failed",
        diagnostics: [
          createSyncDiagnostic("project-errors-after-sync", cellTargetLabel(target), {
            detail: wroteCell
              ? "`api.app.saveProject` reported `saved: false` after the Cell was written, so the project was mutated but not persisted."
              : "`api.app.saveProject` reported `saved: false` while the project reported unsaved changes, so the project was left unpersisted.",
          }),
        ],
        mutated: wroteCell,
      };
    }
    persisted = true;
  } else {
    performed.set("save-project-if-required", "skipped");
    details.set(
      "save-project-if-required",
      wroteCell
        ? "The project reported no unsaved changes after the write."
        : "The project reported no unsaved changes, so there was nothing for this run to persist.",
    );
  }

  // Step 6: the project's errors, and #19's gate — non-zero fails the sync. Checked
  // *before* generation so a broken project is reported instead of being generated and
  // handed to a browser step as if it were working. On the unchanged path this is the whole
  // point of continuing: the Cell being already correct does not mean the project builds.
  const errors = await port.checkProjectErrors();
  const errorOutcome = outcomeOfProjectErrorCheck(errors, target, wroteCell);
  if (errorOutcome.kind === "failed") {
    performed.set("check-project-errors", "ran");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return { kind: "failed", diagnostics: [errorOutcome.diagnostic], mutated: wroteCell || persisted };
  }
  performed.set("check-project-errors", "ran");

  // Step 7: generate, and step 8: hand back the locator.
  const runtime = await port.generatePageAsync({ pageName: target.pageName });
  const generationOutcome = outcomeOfPageGeneration(runtime);
  performed.set("generate-page", "ran");
  if (generationOutcome.kind === "failed") {
    performed.set("return-runtime-locator", "not-reached");
    return { kind: "failed", diagnostics: [generationOutcome.diagnostic], mutated: wroteCell || persisted };
  }
  performed.set("return-runtime-locator", "ran");

  // `wroteCell || persisted`: the write, or a save this run performed. The caller reports it
  // either way, because both change project state.
  return { kind: "completed", runtime, mutated: wroteCell || persisted };
}

// ---------------------------------------------------------------------------
// Reading a target
// ---------------------------------------------------------------------------

/**
 * Read the target and turn it into the plan's input.
 *
 * A convenience over the port rather than a second policy: it performs the read #19's
 * step 3 requires and maps the product's answer through {@link deployedStateOfRead}, so
 * a caller that has a port does not hand-write the three-way mapping. It exists because
 * the alternative is every caller doing it, and the two ways to get it wrong (treating
 * a blank Cell as unread, or an occupied one as blank) are both silent.
 */
export async function readCellState(
  port: ForguncySyncPort,
  target: CellTarget,
): Promise<CellReadOutcome> {
  const result = await port.readCellSource({ pageName: target.pageName, cell: target.cell });
  return { result, state: deployedStateOfRead(result) };
}

// ---------------------------------------------------------------------------
// A batch
// ---------------------------------------------------------------------------

/**
 * One target's sync in a batch: a declared Cell id, an artifact, and the port.
 *
 * Nothing observable about the project is accepted — no `deployed`, no `listings`.
 * {@link executeCellSync} reads both itself, per target, so a batch cannot be handed a
 * snapshot from the start of the run (which by the second target would already be stale) and
 * cannot be handed a fabricated one. The type makes that structural rather than a rule:
 * there is no field for a caller to put an observation in.
 *
 * `mappings` and `overwrite` remain, because they are configuration rather than
 * observations: a table to audit against, and a policy decision the caller owns.
 */
export interface ExecuteCellSyncTargetOptions extends Omit<CellSyncTargetPlan, "deployed" | "listings"> {
  readonly port: ForguncySyncPort;
}

/**
 * Read and execute a batch of declared Cells.
 *
 * The batch's targets are resolved — and their uniqueness re-asserted across all of
 * them — *before* any read or write, so a project where two ids claim one destination
 * fails as a whole instead of writing N-1 Cells and one overwrite. That is
 * `resolveCellSyncTargets`'s rule, and running it here is what keeps the executor from
 * being a path around it.
 *
 * Each target then goes through {@link executeCellSync}, which reads that target and the
 * project's extension listing immediately before planning it. The reads are per target
 * rather than once for the batch on purpose: a listing taken at the start would be a weaker
 * claim by the time the last Cell was written, and the whole point of `before mutation` is
 * that it is *before this one*.
 */
export async function executeCellSyncTargets(
  registry: CellRegistry,
  plans: readonly ExecuteCellSyncTargetOptions[],
): Promise<readonly CellSyncRun[]> {
  // Resolve the whole batch up front: an unresolvable or colliding request throws here,
  // before any read or write has happened, so there is no partially-written project to
  // reason about. `resolveCellSyncTargets` is the guarded path — it re-asserts registry
  // uniqueness and the batch's own distinctness — and it is called *once* for the batch so
  // the cross-member check sees every claim.
  const resolved = resolveCellSyncTargets(
    registry,
    plans.map(plan => plan.cellId),
  );

  const runs: CellSyncRun[] = [];
  for (const [index, planOptions] of plans.entries()) {
    const target = resolved[index];
    if (target === undefined) {
      // Unreachable: the resolver returns one entry per input.
      throw new Error(`No resolved target for Cell ${planOptions.cellId}.`);
    }

    runs.push(
      await executeCellSync({
        target: target.target,
        artifact: planOptions.artifact,
        decisions: planOptions.decisions,
        port: planOptions.port,
        ...(planOptions.mappings === undefined ? {} : { mappings: planOptions.mappings }),
        ...(planOptions.overwrite === undefined ? {} : { overwrite: planOptions.overwrite }),
      }),
    );
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A report block for a CI log or a PR body. */
export function formatCellSyncRun(run: CellSyncRun): string {
  const header = [
    `Sync run: ${cellTargetLabel(run.target)} — ${run.status}`,
    `Artifact fingerprint: ${run.plan.fingerprint}`,
    `Steps: ${run.steps.map(step => `${step.order}.${step.stepId}=${step.status}`).join(" ")}`,
  ];

  if (run.status === "written") {
    return [
      ...header,
      `Runtime locator: ${run.runtime.pageUrl}`,
      // The one thing a green local run must not be read as, stated in the run itself.
      "A run establishes that the designer accepted these calls. Runtime behaviour on the generated page is verified by opening the locator.",
    ].join("\n");
  }

  if (run.status === "unchanged") {
    return [
      ...header,
      `Nothing written: ${run.plan.divergence.detail}`,
      // Reported for the same reason `failed` reports it: a skip that persisted the project
      // changed something, and a report that omitted it would tell a reader nothing had.
      `Project persisted by this run: ${run.mutated}`,
      `Runtime locator: ${run.runtime.pageUrl}`,
      // A skip is not a weaker result than a write, and it is not a stronger one either:
      // the same validation steps ran, so the same sentence applies and says why they matter.
      "The target already held this artifact, so no write was issued. The project's errors were checked and the page generated by this run, which is what the locator above is.",
    ].join("\n");
  }

  if (run.status === "refused") {
    return [...header, `Refused: ${run.dispatch.reason} — ${run.dispatch.detail}`, ...run.diagnostics.map(diagnostic => `- ${diagnostic.code}: ${diagnostic.message}`)].join(
      "\n",
    );
  }

  return [
    ...header,
    `Failed (mutated: ${run.mutated})`,
    ...run.diagnostics.map(diagnostic => `- ${diagnostic.code}: ${diagnostic.message}`),
  ].join("\n");
}

/** One line per target, for a batch's summary. */
export function formatCellSyncRuns(runs: readonly CellSyncRun[]): string {
  return runs.map(run => formatCellSyncRun(run)).join("\n\n");
}
