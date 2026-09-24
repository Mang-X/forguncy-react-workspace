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
 * Steps 1–2 are the ones whose *evidence* is the caller's obligation — the executor
 * cannot invent a listing or a read it was not given — so the plan receives them and
 * the executor only sequences the calls. Step 3 is the only mutating call, and it is
 * reachable only through `planSetCellsDispatch`: handing the plan's payload straight
 * to the port does not compile, which is what makes "the payload is not the
 * permission" a check rather than a convention.
 *
 * ## What it will not do
 *
 * - **It will not write when the plan held.** A refused, skipped or unassemblable
 *   plan produces a {@link CellSyncRun} whose `mutation` is `held`, and the run stops
 *   before the write. The read-only steps are *not* run either: with no write there is
 *   no new state to validate, and generating a page would report a locator for a
 *   deployment that did not happen.
 * - **It will not save unconditionally.** #20 measured that a `setCells` write leaves
 *   `containsUnsavedChanges: true`, so the save is required after a write — but it is
 *   requested as "save if the project says it is dirty", not "always save", because
 *   the second would make a clean project's state depend on sync running.
 * - **It will not report a failed run as a successful one.** A non-zero error count
 *   or a generation with no locator produces `outcome: "failed"` with the diagnostic
 *   that says why; the locator is only present when the flow reached generation *and*
 *   it succeeded.
 * - **It will not swallow a transport failure.** A rejected port call is a thrown
 *   error, not a manufactured diagnostic: the stack is the only thing that helps for
 *   a transport problem, and manufacturing a finding would lose it. See
 *   `step-outcomes.ts` for the same rule stated on the other side.
 */

import type { ExtensionLibraryListing } from "@forguncy-react-workspace/core";

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
import type { CellSyncDispatch, CellSyncPlan, PlanCellSyncOptions } from "./sync-plan.ts";
import { outcomeOfPageGeneration, outcomeOfProjectErrorCheck } from "./step-outcomes.ts";
import { cellTargetLabel } from "./target.ts";
import { planCellSyncTargets } from "./registry-target.ts";
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
 * `skipped` is a *deliberate* non-run with a reason — a clean project needs no save —
 * and it is separate from `not-reached`, which is a step the flow never got to
 * because an earlier one stopped it. Reporting the two together would make "we chose
 * not to save" read as "the sync died before saving".
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

export const CELL_SYNC_RUN_STATUSES = ["written", "held", "failed"] as const;

export type CellSyncRunStatus = (typeof CELL_SYNC_RUN_STATUSES)[number];

/**
 * The result of executing one target's sync.
 *
 * A discriminated union rather than a status plus optional fields, for the reason
 * `sync-plan.ts` gives about `CellSyncWrite`: "held" and "failed" carry different
 * things, and a shape that could hold both would let a caller read the wrong one. In
 * particular `runtime` is present **only** on `written`: a locator for a page that was
 * not written is exactly the value a browser-verification step would accept.
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
      readonly status: "held";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The plan's own answer for why nothing was sent.
       *
       * Narrowed to the `hold` case rather than the full {@link CellSyncDispatch}: a run
       * is `held` precisely because the dispatch did *not* issue, so a caller should not
       * have to re-check what this type already knows.
       */
      readonly dispatch: Extract<CellSyncDispatch, { readonly kind: "hold" }>;
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
       * The write landed, so the failure is *after* a mutation.
       *
       * Carried so a caller knows whether the project was changed before deciding what
       * to do next: a run that failed at the error check left a Cell written, and one
       * that failed to assemble left nothing.
       */
      readonly mutated: boolean;
    };

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Everything the executor needs to plan and then execute one target's sync.
 *
 * Extends {@link PlanCellSyncOptions} with the port, so a caller cannot plan with one
 * set of facts and execute with another: the plan and the run are constructed from
 * the same object. The listing and the read are still the *caller's* inputs — the
 * executor does not discover them itself — because deciding a project's extension
 * metadata or a target's state is a separate, evidence-bearing step, and an executor
 * that inferred them would be a second answer to a question the plan already owns.
 */
export interface ExecuteCellSyncOptions extends PlanCellSyncOptions {
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
 * Execute one target's sync: plan it, then run the flow the plan permits.
 *
 * The plan is built first and its dispatch consulted before any mutating call, so a
 * refused or skipped target never reaches `setCells`. That ordering is not an
 * optimization — it is the safety rule: a write must be preceded by both a verified
 * extension listing and a read of the target, and both of those are the caller's
 * inputs *to the plan*, so "we skipped the check" is not a state this function can be
 * in.
 *
 * A resolved-but-unusable post-mutation result fails the run rather than being
 * returned as a success: see the module docstring.
 */
export async function executeCellSync(options: ExecuteCellSyncOptions): Promise<CellSyncRun> {
  // The flow's own coherence before anything is executed: a run over a registry that
  // contradicts itself would be a confident answer to the wrong question, and this is
  // the same guard `planCellSync` runs so the two cannot disagree about the flow.
  assertMcpSyncFlowIsCoherent();

  const plan = planCellSync(options);
  const { port, target } = options;

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

  // Step 2: the extension metadata. The plan already verified the *supplied* listing;
  // recording the step as run is what makes the executor's report distinguish "the
  // extension check happened" from "no listing was supplied".
  performed.set("verify-extension-metadata", options.listings === undefined ? "skipped" : "ran");
  if (options.listings === undefined) {
    details.set("verify-extension-metadata", "No listing was supplied, so no extension identity was confirmed.");
  }

  // Step 3: the read. The caller supplies what it read (`deployed`); the executor
  // records that a state was supplied, and whether it was a read at all.
  performed.set("read-target-state", options.deployed.kind === "unread" ? "skipped" : "ran");
  if (options.deployed.kind === "unread") {
    details.set("read-target-state", `No read was performed (${options.deployed.reason}).`);
  }

  const dispatch = planSetCellsDispatch(plan);
  if (dispatch.kind === "hold") {
    // No write, so nothing after it can run. The steps are marked `not-reached` rather
    // than `blocked`: nothing is wrong with them, the flow simply did not get there.
    performed.set("write-cell-source", "not-reached");
    performed.set("save-project-if-required", "not-reached");
    performed.set("check-project-errors", "not-reached");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return {
      status: "held",
      target,
      plan,
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

  // Step 5: the save, conditional on the product's own answer. #20 measured that a
  // `setCells` write leaves `containsUnsavedChanges: true`, so the check is what turns
  // #19's conditional save into a decision rather than a guess.
  const saveStatus = await port.getProjectSaveStatus({});
  if (saveStatus.containsUnsavedChanges) {
    const saved = await port.saveProject();
    performed.set("save-project-if-required", "ran");
    if (!saved.saved) {
      // A save the product declined. Reported through the project-state owner because
      // the project — not sync and not the extension — is what is left unpersisted.
      details.set("save-project-if-required", "The product was asked to save and did not.");
      performed.set("check-project-errors", "not-reached");
      performed.set("generate-page", "not-reached");
      performed.set("return-runtime-locator", "not-reached");
      return {
        status: "failed",
        target,
        plan,
        steps: runSteps(performed, details),
        diagnostics: [
          createSyncDiagnostic("project-errors-after-sync", cellTargetLabel(target), {
            detail:
              "`api.app.saveProject` reported `saved: false` after the Cell was written, so the project was mutated but not persisted.",
          }),
        ],
        mutated: true,
      };
    }
  } else {
    performed.set("save-project-if-required", "skipped");
    details.set("save-project-if-required", "The project reported no unsaved changes after the write.");
  }

  // Step 6: the project's errors, and #19's gate — non-zero fails the sync. Checked
  // *before* generation so a broken project is reported instead of being generated and
  // handed to a browser step as if it were working.
  const errors = await port.checkProjectErrors();
  const errorOutcome = outcomeOfProjectErrorCheck(errors, target);
  if (errorOutcome.kind === "failed") {
    performed.set("check-project-errors", "ran");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: [errorOutcome.diagnostic],
      mutated: true,
    };
  }
  performed.set("check-project-errors", "ran");

  // Step 7: generate, and step 8: hand back the locator.
  const runtime = await port.generatePageAsync({ pageName: target.pageName });
  const generationOutcome = outcomeOfPageGeneration(runtime);
  performed.set("generate-page", "ran");
  if (generationOutcome.kind === "failed") {
    performed.set("return-runtime-locator", "not-reached");
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: [generationOutcome.diagnostic],
      mutated: true,
    };
  }
  performed.set("return-runtime-locator", "ran");

  return {
    status: "written",
    target,
    plan,
    runtime,
    steps: runSteps(performed, details),
    divergence: plan.divergence,
    // The plan's diagnostics only. The read-only steps' outcomes are on `steps`, and
    // repeating them here would make a caller read two lists for one run.
    diagnostics: plan.diagnostics,
  };
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

/** One target's sync, executed after the batch's targets were resolved and guarded. */
export interface ExecuteCellSyncTargetOptions extends CellSyncTargetPlan {
  readonly port: ForguncySyncPort;
  readonly listings?: readonly ExtensionLibraryListing[];
}

/**
 * Read and execute a batch of declared Cells.
 *
 * The batch's targets are resolved — and their uniqueness re-asserted across all of
 * them — *before* any read or write, so a project where two ids claim one destination
 * fails as a whole instead of writing N-1 Cells and one overwrite. That is
 * `planCellSyncTargets`'s rule, and running it here is what keeps the executor from
 * being a path around it.
 *
 * Each target is read immediately before its own plan is built, so the state the plan
 * classifies is the state the write would replace rather than a snapshot from the
 * start of the batch.
 */
export async function executeCellSyncTargets(
  registry: Parameters<typeof planCellSyncTargets>[0],
  plans: readonly ExecuteCellSyncTargetOptions[],
): Promise<readonly CellSyncRun[]> {
  // Resolve once, up front: an unresolvable or colliding batch throws here, before any
  // read or write has happened.
  planCellSyncTargets(registry, plans);

  const runs: CellSyncRun[] = [];
  for (const planOptions of plans) {
    const [resolved] = planCellSyncTargets(registry, [planOptions]);
    if (resolved === undefined) {
      // Unreachable: the resolver returns one entry per input.
      throw new Error(`No resolved target for Cell ${planOptions.cellId}.`);
    }
    const { state } = await readCellState(planOptions.port, resolved.target);
    runs.push(
      await executeCellSync({
        target: resolved.target,
        artifact: planOptions.artifact,
        decisions: planOptions.decisions,
        deployed: state,
        port: planOptions.port,
        ...(planOptions.listings === undefined ? {} : { listings: planOptions.listings }),
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

  if (run.status === "held") {
    return [...header, `Held: ${run.dispatch.reason} — ${run.dispatch.detail}`, ...run.diagnostics.map(diagnostic => `- ${diagnostic.code}: ${diagnostic.message}`)].join(
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
