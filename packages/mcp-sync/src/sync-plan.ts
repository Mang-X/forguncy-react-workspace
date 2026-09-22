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
} from "./capability-surface";
import type { McpSyncStep, McpSyncStepId, McpSyncStepPhase, SyncCapabilityId } from "./capability-surface";
import {
  createSyncDiagnostic,
  dedupeSyncDiagnostics,
  formatSyncDiagnostics,
  SYNC_DIAGNOSTIC_RULES,
} from "./diagnostics";
import type { SyncDiagnostic } from "./diagnostics";
import { cellDivergenceOverride, classifyCellDivergence, formatCellDivergence, resolveCellWriteAction } from "./divergence";
import type { CellDivergence, CellOverwritePolicy, CellWriteAction, DeployedCellState } from "./divergence";
import { DEFAULT_CELL_OVERWRITE_POLICY } from "./divergence";
import { verifyExtensionReferences, formatExtensionReferenceVerification } from "./extension-verification";
import type { ExtensionReferenceVerification } from "./extension-verification";
import { fingerprintArtifact, stampSyncMarker, stripSyncMarker, SyncFingerprintError } from "./fingerprint";
import type { SetCellsCell, SetCellsRequest } from "./port";
import { cellTargetLabel } from "./target";
import type { CellTarget, SyncCellInput } from "./target";

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
 * add a second without anyone revisiting that rule. It is assignable to the port's
 * `SetCellsRequest`, which stays multi-cell because the platform's call is.
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
  const lines = [
    `Sync target: ${cellTargetLabel(plan.target)}`,
    `Artifact fingerprint: ${plan.fingerprint}`,
    formatCellDivergence(plan.divergence),
    `Write action: ${plan.writeAction} (gate: ${plan.gate})`,
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
 * A `SetCellsRequest` for a plan's mutation, ready to hand to the port.
 *
 * The one adapter between the contract's single-Cell mutation and the platform's
 * multi-Cell call. Explicit rather than an implicit widening at each call site, so the
 * place where "sync writes exactly one target" stops being expressible is a single
 * function a reader can find.
 *
 * Throws when the plan assembled no write, and the throw is a programming error rather
 * than a routine outcome: a caller reaches an executor only after reading the plan, so
 * asking for the request of a plan that refused to assemble one means the plan's
 * `write.kind` was not read. The error carries the same code the plan's diagnostic does,
 * so the two answers cannot be about different conditions.
 */
export function toSetCellsRequest(plan: CellSyncPlan): SetCellsRequest {
  if (plan.write.kind !== "assembled") {
    throw new SyncFingerprintError(
      "artifact-not-generated",
      `A \`setCells\` request was asked of a plan that has nothing to write: ${plan.write.reason.message}`,
    );
  }
  const { mutation } = plan.write;
  return { pageName: mutation.pageName, cells: [...mutation.cells] };
}
