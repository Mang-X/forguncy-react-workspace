/**
 * The plan a sync is executed from.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), governed by
 * #4/#5 (architecture), #6 (the artifact) and #12 (extension identities).
 *
 * A **plan** rather than an executor, for the reason #6 has a `CellBundlerPort` and no
 * bundler: assembling what would be written is this package's contract, and issuing the
 * calls is #20's. Everything #19 decides that does not require a live project is decided
 * here — the mutation payload, whether the target may be overwritten, whether the
 * extensions are verified, which steps the flow can reach — which is also what makes the
 * contract testable at all. The alternative, an executor with a mock transport, tests
 * the mock.
 *
 * ## The two questions the plan answers, and why they are separate
 *
 * - {@link CellSyncPlan.gate} — *may this Cell be written right now?* A pre-mutation
 *   question, decided from diagnostics. `refused` covers a diverged target, an
 *   unreadable target, an extension that is not verified, an artifact that is not
 *   compiler output, and a required step whose call has no name.
 * - {@link CellSyncPlan.unestablishedCapabilities} and the per-step statuses — *can the
 *   flow be executed end to end?* Answerable today, and the answer is no: reading a
 *   Cell and saving the project have no recorded call names.
 *
 * They are not one field because they fail independently. A Cell may be writable while
 * the flow cannot be validated afterwards, and a caller that reads only a single
 * "executable" flag would deploy without knowing that.
 *
 * ## The one answer an executor may act on
 *
 * `write`, `gate` and `writeAction` are three separate facts, and **none of them alone is
 * permission to call `setCells`**. `write.kind === "assembled"` says a payload exists — a
 * plan deliberately keeps one even when it refuses, because that payload is what `force`
 * would send and what a reviewer reads, so the payload is not the permission.
 * `gate === "ready"` says no blocking diagnostic was raised; it does not say there is
 * anything to send. `writeAction === "write"` says the target may be replaced, and on its
 * own it would ignore a blocking diagnostic that has nothing to do with divergence — an
 * unverified extension, an absent designer call, an artifact that is not compiler output.
 *
 * {@link planSetCellsDispatch} is that answer, and it is the only way to obtain an
 * {@link IssuedSetCellsRequest} — the type `ForguncySyncPort.setCells` accepts. The payload
 * on `plan.write` is structurally a `SetCellsRequest` and stays readable there for
 * reporting, but it is deliberately not the type the port takes, so handing the plan's own
 * payload to `setCells` does not compile. A caller can still cast past any type-level
 * barrier; what that costs is having to write the cast on purpose, which is the difference
 * between a convention and a check.
 *
 * ## Why the write is normalized
 *
 * The mutation's `frontendLibraries` is put through #6's canonical form and the
 * fingerprint is taken over the canonical form too, so reference *order* can never make
 * two syncs of the same dependencies differ. That is not a check being skipped: #6 owns
 * artifact canonicality and reports it at compile time. It is what makes #19's
 * "extension reference order must be stable" and "same artifact sync is idempotent"
 * properties of the plan rather than of whoever happened to order an array.
 */

import {
  canonicalizeFrontendLibraries,
  CELL_ARTIFACT_BANNER,
  frontendLibraryIds,
} from "@forguncy-react-workspace/cell-compiler";
import type { ExtensionExternalMapping, ExtensionLibraryListing } from "@forguncy-react-workspace/core";

import {
  assertMcpSyncFlowIsCoherent,
  findSyncCapability,
  MCP_SYNC_STEPS,
  syncMutationStep,
  unestablishedSyncCapabilities,
} from "./capability-surface.ts";
import type { McpSyncStep, McpSyncStepId, McpSyncStepPhase, SyncCapabilityId } from "./capability-surface.ts";
import {
  createSyncDiagnostic,
  dedupeSyncDiagnostics,
  formatSyncDiagnostics,
  SYNC_DIAGNOSTIC_RULES,
} from "./diagnostics.ts";
import type { SyncDiagnostic } from "./diagnostics.ts";
import { cellDivergenceOverride, classifyCellDivergence, formatCellDivergence, resolveCellWriteAction } from "./divergence.ts";
import type { CellDivergence, CellOverwritePolicy, CellWriteAction, DeployedCellState } from "./divergence.ts";
import { DEFAULT_CELL_OVERWRITE_POLICY } from "./divergence.ts";
import { verifyExtensionReferences, formatExtensionReferenceVerification } from "./extension-verification.ts";
import type { ExtensionReferenceVerification } from "./extension-verification.ts";
import { fingerprintArtifact, stampSyncMarker, stripSyncMarker } from "./fingerprint.ts";
import { issueSetCellsRequest } from "./port.ts";
import type { IssuedSetCellsRequest, SetCellsCell } from "./port.ts";
import { cellTargetLabel } from "./target.ts";
import type { CellTarget, SyncCellInput } from "./target.ts";

// ---------------------------------------------------------------------------
// What gets written
// ---------------------------------------------------------------------------

/**
 * The Cell fields a sync deliberately does not send.
 *
 * The documented `api.page.setCells` example carries `rowSpan` / `colSpan` alongside
 * the fields sync does send, and nothing in the evidence records whether omitting them
 * preserves a cell's current geometry or resets it to a default. That makes this an
 * unmeasured question rather than a preference, so it is recorded instead of being
 * resolved by guessing: sync writes only what #19 says it writes, and
 * `SYNC_MUTATION_GEOMETRY_NOTE` states what a real project still has to confirm.
 */
export const SYNC_MUTATION_OMITTED_FIELDS = ["rowSpan", "colSpan"] as const;

export const SYNC_MUTATION_GEOMETRY_NOTE =
  "The mutation sets no row/column span, so a merged target Cell's geometry is the platform's to preserve. The probe evidence does not record whether `api.page.setCells` defaults or preserves those fields when they are omitted, so this is confirmed only by the real-runtime half of the `written-without-manual-copy` guarantee.";

/**
 * One Cell's write, with exactly one Cell in it.
 *
 * A one-element tuple rather than an array: sync writes one target per plan (#19's
 * "sync targets must be explicit"), and a type that can hold several would let a caller
 * add a second without anyone revisiting that rule.
 *
 * Structurally a `SetCellsRequest` — the port's shape stays multi-cell because the
 * platform's call is — which is what makes it readable as the artifact's deployment
 * representation, and what made it passable to the port as if it were permission. It is
 * not: `setCells` takes an {@link IssuedSetCellsRequest}, which only
 * {@link planSetCellsDispatch} mints, so this type is a report shape that happens to have
 * the same fields rather than a request that may be sent.
 */
export interface CellSyncMutation {
  readonly pageName: string;
  readonly cells: readonly [SetCellsCell];
}

/**
 * What a plan would write, or why it has nothing to write.
 *
 * A discriminated pair rather than two optional fields, because the two cases are not
 * "the same thing, maybe missing". An artifact that is not compiler output has no
 * deployment representation at all — `stampSyncMarker` refuses to claim a provenance
 * the code does not have — while every *other* refusal still has a payload worth
 * showing, because that payload is what `force` would write and what a reviewer reads.
 * Encoding the difference in the type is what keeps "nothing to write" from being
 * mistaken for "this write, refused for now", and it is why the refusal has to carry
 * its own diagnostic here rather than leaving a reader to find it among the plan's
 * other findings.
 */
export type CellSyncWrite =
  | {
      readonly kind: "assembled";
      /** The artifact's code with its marker stamped in — what the mutation writes. */
      readonly stampedCode: string;
      readonly mutation: CellSyncMutation;
    }
  | {
      readonly kind: "not-assembled";
      /** Why nothing could be assembled. Always `artifact-not-generated`. */
      readonly reason: SyncDiagnostic;
    };

/**
 * The mutation's canonical serialization.
 *
 * Key order is written out rather than relied upon, and the library list is already
 * canonical, so two plans over the same artifact serialize byte-identically. Nothing
 * else in the payload is a collection, deliberately: the payload is what makes a second
 * sync a no-op, and a field whose order or formatting could vary would make every sync
 * look like a change.
 */
export function serializeCellSyncMutation(mutation: CellSyncMutation): string {
  const cell = mutation.cells[0];
  const canonical = {
    pageName: mutation.pageName,
    cells: [
      {
        cell: cell.cell,
        cellType: cell.cellType,
        cellTypeProps: {
          code: cell.cellTypeProps.code,
          frontendLibraries: cell.cellTypeProps.frontendLibraries.map(library => ({
            libraryId: library.libraryId,
          })),
        },
      },
    ],
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The per-step plan
// ---------------------------------------------------------------------------

/**
 * What the plan says about one step.
 *
 * - `ready` — every capability this step needs has an established call, and the flow
 *   reaches it.
 * - `blocked` — at least one of them does not, so the step cannot be carried out at
 *   all yet. {@link SyncStepPlan.unestablished} names which.
 * - `not-reached` — the flow stops before this step, because an earlier one is blocked
 *   or because the gate refuses the mutation. A step in this state is not a problem in
 *   itself; it is the consequence of one that is.
 */
export type SyncStepStatus = "ready" | "blocked" | "not-reached";

export interface SyncStepPlan {
  readonly stepId: McpSyncStepId;
  readonly order: number;
  readonly phase: McpSyncStepPhase;
  readonly status: SyncStepStatus;
  readonly capabilityIds: readonly SyncCapabilityId[];
  /** The step's capabilities with no established call. Non-empty exactly when blocked. */
  readonly unestablished: readonly SyncCapabilityId[];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Whether the Cell may be written in this run.
 *
 * `skipped` is not a refusal: the target already holds this artifact, so the mutation is
 * not issued and the read-only steps after it still run, because a caller that asked for
 * a deployment locator should get one whether or not the write was needed.
 */
export type CellSyncGate = "ready" | "skipped" | "refused";

export interface PlanCellSyncOptions extends SyncCellInput {
  /** The decisions the artifact was compiled against. Required: half of the reference check. */
  readonly decisions: Parameters<typeof verifyExtensionReferences>[0]["decisions"];
  /**
   * What the target Cell currently holds.
   *
   * Required rather than optional, and required to *say* when it is unknown: an
   * optional field would make "not supplied" the easiest thing to write, and #19's
   * safety rule is about the state where nobody looked.
   */
  readonly deployed: DeployedCellState;
  /** What `api.app.listFrontendLibraries` returned, when the caller has it. */
  readonly listings?: readonly ExtensionLibraryListing[];
  /** The extension mapping table to audit against. Defaults to `core`'s shipped table. */
  readonly mappings?: readonly ExtensionExternalMapping[];
  /** What to do about a diverged target. Defaults to preserving designer edits. */
  readonly overwrite?: CellOverwritePolicy;
}

export interface CellSyncPlan {
  readonly target: CellTarget;
  /** The artifact's identity, as the marker records it. */
  readonly fingerprint: string;
  /**
   * What the plan would write, or why it has nothing to write.
   *
   * Read `kind` before reaching for a payload: a plan whose artifact is not compiler
   * output has no deployment representation at all, and that is a different answer from
   * a refusal with a payload behind it.
   */
  readonly write: CellSyncWrite;
  readonly divergence: CellDivergence;
  readonly writeAction: CellWriteAction;
  /**
   * The conflict an explicit `force` overrode.
   *
   * Carried instead of logged, and instead of being reported as a diagnostic: an
   * overridden conflict is not a finding about the project, it is a record of what this
   * run chose to do, and a report that omitted it would make `force` a way to make the
   * check invisible.
   */
  readonly overriddenConflict?: CellDivergence;
  readonly extensionVerification: ExtensionReferenceVerification;
  readonly steps: readonly SyncStepPlan[];
  readonly gate: CellSyncGate;
  /**
   * The required designer operations no evidence names, in step order.
   *
   * Read this before executing: it is empty only when the flow can be run end to end.
   */
  readonly unestablishedCapabilities: readonly SyncCapabilityId[];
  readonly diagnostics: readonly SyncDiagnostic[];
}

function buildSteps(gate: CellSyncGate): readonly SyncStepPlan[] {
  const mutationOrder = syncMutationStep().order;
  const refusedAt = gate === "refused" ? mutationOrder : Number.POSITIVE_INFINITY;

  const withCapabilities = MCP_SYNC_STEPS.map((step: McpSyncStep) => ({
    step,
    unestablished: step.capabilityIds.filter(
      id => findSyncCapability(id).confirmation === "unestablished",
    ),
  }));

  // The first step whose capabilities are missing is where the flow stops. Later steps
  // are not-reached rather than blocked, because nothing about them is wrong.
  const blockedAt = withCapabilities
    .filter(entry => entry.unestablished.length > 0)
    .reduce((lowest, entry) => Math.min(lowest, entry.step.order), Number.POSITIVE_INFINITY);

  return withCapabilities.map(({ step, unestablished }) => {
    let status: SyncStepStatus = "ready";
    if (unestablished.length > 0) status = "blocked";
    else if (step.order > blockedAt || step.order >= refusedAt) status = "not-reached";

    return {
      stepId: step.id,
      order: step.order,
      phase: step.phase,
      status,
      capabilityIds: step.capabilityIds,
      unestablished,
    };
  });
}

/**
 * Assemble the plan for one target.
 *
 * Order of work follows the flow's own order, because the diagnostics read better in it:
 * the artifact's provenance, then the extensions, then the target, then the capabilities.
 * Nothing here calls anything.
 */
export function planCellSync(options: PlanCellSyncOptions): CellSyncPlan {
  // The registries are checked here rather than in a test alone, because every decision
  // below reads them and a plan built from a flow that contradicts itself would be a
  // confident answer to the wrong question. It is cheap: the guards are pure.
  assertMcpSyncFlowIsCoherent();

  const { artifact } = options;
  const declaredDiagnostics: SyncDiagnostic[] = [];

  const unstampedCode = stripSyncMarker(artifact.code);
  // Held as a value rather than pushed straight into the list, because it also decides
  // whether a write can be assembled at all: `stampSyncMarker` calls the same predicate
  // and throws, so a plan that reported only the diagnostic would still be the plan that
  // threw before anyone read it.
  const generationRefusal = unstampedCode.startsWith(CELL_ARTIFACT_BANNER)
    ? undefined
    : createSyncDiagnostic("artifact-not-generated", cellTargetLabel(options.target), {
        detail: "The artifact does not open with the compiler's banner.",
      });
  if (generationRefusal !== undefined) declaredDiagnostics.push(generationRefusal);

  const extensionVerification = verifyExtensionReferences({
    artifact,
    decisions: options.decisions,
    ...(options.listings === undefined ? {} : { listings: options.listings }),
    ...(options.mappings === undefined ? {} : { mappings: options.mappings }),
  });

  // Only asked when there is something to verify. A diagnostic about an artifact with no
  // extension references would make every inline-only Cell fail on a step it does not use.
  if (extensionVerification.references.length > 0 && extensionVerification.verification === "unstated") {
    declaredDiagnostics.push(
      createSyncDiagnostic("extension-metadata-unverified", cellTargetLabel(options.target), {
        detail: `The artifact references ${extensionVerification.references.length} library/libraries and no listing was supplied: ${extensionVerification.references.join(", ")}.`,
      }),
    );
  }
  declaredDiagnostics.push(...extensionVerification.diagnostics);

  const policy = options.overwrite ?? DEFAULT_CELL_OVERWRITE_POLICY;
  const divergence = classifyCellDivergence(options.deployed, artifact);
  const writeAction = resolveCellWriteAction(divergence, policy);
  const overriddenConflict = cellDivergenceOverride(divergence, policy);

  if (writeAction === "conflict") {
    declaredDiagnostics.push(
      divergence.kind === "unverifiable"
        ? createSyncDiagnostic("cell-state-unverifiable", cellTargetLabel(options.target), {
            detail: divergence.detail,
          })
        : createSyncDiagnostic("cell-diverged", cellTargetLabel(options.target), { detail: divergence.detail }),
    );
  }

  const unestablished = unestablishedSyncCapabilities();
  for (const capability of unestablished) {
    declaredDiagnostics.push(
      createSyncDiagnostic("sync-capability-unestablished", capability.id, {
        detail: capability.blockedBy ?? "",
      }),
    );
  }

  const diagnostics = dedupeSyncDiagnostics(declaredDiagnostics);

  // The gate is read off the diagnostics rather than recomputed from the inputs, so
  // "what stops the write" and "what the report says" cannot disagree. A rule that does
  // not block says so in the rule table, which is also where a new code has to state it.
  const blocked = diagnostics.some(diagnostic => SYNC_DIAGNOSTIC_RULES[diagnostic.code].blocksMutation);
  const gate: CellSyncGate = blocked ? "refused" : writeAction === "skip" ? "skipped" : "ready";

  const libraries = canonicalizeFrontendLibraries(artifact.frontendLibraries);
  let write: CellSyncWrite;
  if (generationRefusal === undefined) {
    const mutation: CellSyncMutation = {
      pageName: options.target.pageName,
      cells: [
        {
          cell: options.target.cell,
          cellType: "ReactCellTypeCellType",
          cellTypeProps: { code: stampSyncMarker(artifact), frontendLibraries: libraries },
        },
      ],
    };
    write = { kind: "assembled", stampedCode: mutation.cells[0].cellTypeProps.code, mutation };
  } else {
    write = { kind: "not-assembled", reason: generationRefusal };
  }

  return {
    target: options.target,
    fingerprint: fingerprintArtifact(artifact),
    write,
    divergence,
    writeAction,
    ...(overriddenConflict === undefined ? {} : { overriddenConflict }),
    extensionVerification,
    steps: buildSteps(gate),
    gate,
    unestablishedCapabilities: unestablished.map(capability => capability.id),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** The step statuses, as a compact line. */
export function formatCellSyncSteps(plan: CellSyncPlan): string {
  return plan.steps
    .map(step => `${step.order}.${step.stepId}=${step.status}${step.unestablished.length === 0 ? "" : `(${step.unestablished.join(",")})`}`)
    .join(" ");
}

/** A report block for a CI log or a PR body. */
export function formatCellSyncPlan(plan: CellSyncPlan): string {
  // Read from the same function an executor is bound by, so "what the report says" and
  // "what may be sent" cannot drift apart.
  const dispatch = planSetCellsDispatch(plan);
  const lines = [
    `Sync target: ${cellTargetLabel(plan.target)}`,
    `Artifact fingerprint: ${plan.fingerprint}`,
    formatCellDivergence(plan.divergence),
    `Write action: ${plan.writeAction} (gate: ${plan.gate})`,
    dispatch.kind === "issue"
      ? "Dispatch: issue the `setCells` call."
      : `Dispatch: hold — ${dispatch.reason}: ${dispatch.detail}`,
    plan.overriddenConflict === undefined
      ? "No conflict was overridden."
      : `Overridden by an explicit force: ${plan.overriddenConflict.kind} — ${plan.overriddenConflict.detail}`,
    formatExtensionReferenceVerification(plan.extensionVerification),
    `Steps: ${formatCellSyncSteps(plan)}`,
    plan.unestablishedCapabilities.length === 0
      ? "Every required designer operation has an established call name."
      : `Flow cannot be executed end to end: ${plan.unestablishedCapabilities.join(", ")} ${
          plan.unestablishedCapabilities.length === 1 ? "has" : "have"
        } no established call name.`,
    plan.write.kind === "assembled"
      ? `Libraries to write: ${
          frontendLibraryIds(plan.write.mutation.cells[0].cellTypeProps.frontendLibraries).join(", ") || "(none)"
        }`
      : `Nothing to write: ${plan.write.reason.message}`,
    formatSyncDiagnostics(plan.diagnostics),
    // The one thing a green local plan must not be read as, stated in the plan itself.
    "A plan establishes the contract this package checks. It does not establish Forguncy runtime behaviour.",
  ];
  return lines.join("\n");
}

/**
 * Why a plan's mutation may not be issued.
 *
 * Four reasons, and they are not interchangeable: the *next step* differs. A refused gate
 * stops the run and has to be reported; a resolved conflict has to be looked at by a person;
 * an identical target continues to the read-only steps, because a caller that asked for a
 * deployment locator should get one whether or not the write was needed; and an artifact
 * that is not compiler output means there was never anything to send.
 */
export const CELL_SYNC_HOLD_REASONS = [
  "nothing-to-write",
  "gate-refused",
  "target-diverged",
  "already-identical",
] as const;

export type CellSyncHoldReason = (typeof CELL_SYNC_HOLD_REASONS)[number];

/**
 * The reasons a hold can carry once a payload exists.
 *
 * `nothing-to-write` is deliberately not one of them: it is decided from the payload's own
 * absence, before either table below is consulted, so a table entry claiming it would be
 * describing a state it can never be reached in.
 */
type PayloadHoldReason = Exclude<CellSyncHoldReason, "nothing-to-write">;

/**
 * Which hold reason each gate implies, if any.
 *
 * Total, and consulted before the payload can be handed over, for the same reason the write
 * action table is: the failure mode of a chain of comparisons here is fail *open*. This was
 * written as `if (plan.gate === "refused")` first, which would send a plan issued by any gate
 * the author did not think of — and a write that should not have been sent is exactly the
 * defect this function exists to prevent. A new gate value is a compile error here instead.
 */
const HOLD_FOR_GATE: Readonly<Record<CellSyncGate, PayloadHoldReason | undefined>> = {
  ready: undefined,
  skipped: "already-identical",
  refused: "gate-refused",
};

/**
 * How each write action holds a mutation back. A total `Record` rather than a chain of
 * comparisons, so a new action cannot be added without deciding whether it may be issued —
 * the failure mode of a missing branch here is a call that should not be sent.
 */
const HOLD_FOR_WRITE_ACTION: Readonly<Record<CellWriteAction, PayloadHoldReason | undefined>> = {
  write: undefined,
  skip: "already-identical",
  conflict: "target-diverged",
};

/**
 * What an executor is allowed to do with a plan: issue its `setCells` call, or not, and why.
 *
 * A discriminated pair rather than a boolean plus a payload, and `issue` is the **only** case
 * that carries a request. That is the point: an executor cannot obtain a request for a plan
 * the contract refused, because there is nowhere to obtain it from. The refused payload stays
 * readable on `plan.write` for reporting — deliberately not from here, where an executor would
 * find it and send it.
 *
 * `hold.detail` names where the explanation lives rather than restating it, so this stays one
 * decision and does not become a second copy of the diagnostics.
 */
export type CellSyncDispatch =
  | {
      readonly kind: "issue";
      /**
       * The issued request — the only shape `ForguncySyncPort.setCells` accepts, and the
       * only one that exists. Minted here rather than read off the plan, which is what
       * makes `issue` the permission instead of `plan.write`.
       */
      readonly request: IssuedSetCellsRequest;
    }
  | {
      readonly kind: "hold";
      readonly reason: CellSyncHoldReason;
      readonly detail: string;
    };

/** Why a plan was held, in one sentence an executor can put in a log line. */
function holdDetail(plan: CellSyncPlan, reason: PayloadHoldReason): string {
  switch (reason) {
    case "gate-refused": {
      // Codes, not subjects, and deduplicated: several diagnostics can share a code (one per
      // unestablished capability, one per library), and a report line that repeated the code
      // would read as one finding per detector. The subjects and the remediation are on the
      // plan's own diagnostics, which the report prints directly below this line.
      const blocking = [
        ...new Set(
          plan.diagnostics
            .filter(diagnostic => SYNC_DIAGNOSTIC_RULES[diagnostic.code].blocksMutation)
            .map(diagnostic => diagnostic.code),
        ),
      ];
      return `Refused before the write: ${blocking.join(", ")}. See the plan's diagnostics for the remediation.`;
    }
    case "already-identical":
      return "The target already holds this artifact, so the mutation is not issued. The read-only steps after it still run.";
    case "target-diverged":
      return `The target diverged and the policy refused to overwrite it: ${plan.divergence.detail}`;
  }
}

/**
 * The single decision an executor is bound by, and the only way to an
 * `IssuedSetCellsRequest` — without it there is no value the port will accept.
 *
 * Both enums are resolved through a total table before a request can be built, and the gate
 * is resolved first: `gate === "ready"` implying `writeAction === "write"` is a property of
 * the *current* rule table — one divergence rule flipping `blocksMutation` would break it —
 * so the two are checked as the independent conditions they are rather than relying on a
 * coincidence. Being wrong here costs a write that should not have happened, which is worth
 * two lookups.
 */
export function planSetCellsDispatch(plan: CellSyncPlan): CellSyncDispatch {
  // Absence first: with no payload there is nothing to send whatever else is true, and
  // `nothing-to-write` is the more precise answer than a gate refusal it implies.
  if (plan.write.kind !== "assembled") {
    return { kind: "hold", reason: "nothing-to-write", detail: plan.write.reason.message };
  }

  const gateHold = HOLD_FOR_GATE[plan.gate];
  if (gateHold !== undefined) {
    return { kind: "hold", reason: gateHold, detail: holdDetail(plan, gateHold) };
  }

  const writeHold = HOLD_FOR_WRITE_ACTION[plan.writeAction];
  if (writeHold !== undefined) {
    return { kind: "hold", reason: writeHold, detail: holdDetail(plan, writeHold) };
  }

  const { mutation } = plan.write;
  return {
    kind: "issue",
    request: issueSetCellsRequest({ pageName: mutation.pageName, cells: [...mutation.cells] }),
  };
}
