/**
 * The dependency-selection policy: the order the work happens in, who is allowed
 * to do each part, and when a candidate may be permanently adapted instead of
 * replaced.
 *
 * Decision source: GitHub Issue #16 — "Spec: Agent-driven dependency selection
 * and empirical compatibility probe".
 * https://github.com/Mang-X/forguncy-react-workspace/issues/16
 *
 * Governing architecture Spec Issues: #4 (ownership), #5 (verified target),
 * plus #8 (the lock a decision is persisted into).
 *
 * Problem this encodes: npm is unbounded, so a package-specific compatibility
 * module per library — and a global adapter registry keyed by package name — is
 * not maintainable, and static heuristics alone miss runtime constraints that only
 * appear under a Worker, a WASM asset or a hidden dynamic import. #16's answer is
 * a procedure rather than a table: decide the capability's owner first, research
 * and rank by the signals in `selection-signals.ts`, probe deterministically with
 * the protocol in `probe-protocol.ts`, and only then choose a strategy — replacing
 * an awkward package rather than accumulating an adapter for it.
 *
 * The stages below carry `authority` because the skill/scripts split is part of
 * the decision, not an implementation detail. #16 puts semantic reasoning
 * (ownership, candidate comparison, trade-offs, when to stop and replace) on the
 * Agent side, and *"package inspection, builds, artifact scan, size calculation,
 * deterministic browser checks, lock updates"* on the scripts side. So the split is
 * not "agent thinks, scripts measure": persisting the decision is scripts work too,
 * and the stage that writes the lock is where an unrecordable decision is refused.
 * A stage that quietly moves across that line turns judgement into a build output,
 * or measurement into an opinion.
 *
 * Ownership enters the flow as an input rather than as an observation. The first
 * stage consumes the #4 role assessment (`assessDependencyRole`), and no signal in
 * `selection-signals.ts` can stand in for it — see
 * `MACHINE_OBSERVED_SIGNAL_INVARIANT`.
 *
 * Deliberately absent: a package compatibility database, a strategy precedence
 * ranking, and any decision the probe engine could make on its own. #16 requires
 * the opposite — the probe reports, the Agent decides, and the lock records why.
 */

import type { ArchitectureDecisionSource } from "./governance";
import {
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_SELECTION_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "./governance";
import type { LockProbeRequirement, ProbeStatus } from "./lock";
import { LOCK_EVIDENCE_POLICY, lockEvidenceProfileForDecision } from "./lock";
import type { PlatformConflictAssessment } from "./platform-conflicts";
import { isPlatformConflict } from "./platform-conflicts";
import type { ProbeAssessment, ProbeReport } from "./probe-protocol";
import { assessProbeReport, PROBE_DEPLOYMENT_REQUIRED_STEPS, validateProbeReport } from "./probe-protocol";
import { DEPENDENCY_REJECTION_RESPONSE } from "./rejection";
import type { SelectionSignalId } from "./selection-signals";
import { findReplacementSignalRejection } from "./selection-signals";
import type { DependencyDecision, DependencyStrategy } from "./strategy";
import { strategySemantics, validateDependencyDecisionShape } from "./strategy";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to this module has to cite: the architecture decisions
 * first, then the dependency Specs built on them — the lock (#8, how a decision
 * is persisted and invalidated) and this one (#16, how a decision is reached and
 * evidenced).
 *
 * Composed from the records `core` owns rather than from a second copy of them,
 * so the two lists cannot drift.
 */
export const SELECTION_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_SELECTION_DECISION,
];

/** The line a PR body, plan or report describing this policy carries. */
export const SELECTION_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  SELECTION_GOVERNING_DECISIONS,
);

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const SELECTION_AUTHORITIES = ["agent", "scripts"] as const;
export type SelectionAuthority = (typeof SELECTION_AUTHORITIES)[number];

export type SelectionStageId =
  | "classify-ownership"
  | "research-candidates"
  | "rank-candidates"
  | "probe-candidate"
  | "decide-strategy"
  | "resolve-replacement"
  | "persist-decision";

export interface SelectionStage {
  readonly id: SelectionStageId;
  readonly label: string;
  /** Who performs it. Semantic judgement is `agent`; deterministic work is `scripts`. */
  readonly authority: SelectionAuthority;
  /** What the stage hands to the next one. */
  readonly produces: string;
  /** What the stage is not allowed to become. */
  readonly mustNot: readonly string[];
}

/**
 * The selection flow, in order.
 *
 * The order is the policy. Ownership is decided before any package is researched,
 * because otherwise a bundling result gets to imply an architecture decision;
 * ranking precedes probing, because probing every candidate is wasted work; and
 * persistence is last, because a lock record that exists before its evidence does
 * is a decision nobody can re-check.
 */
export const SELECTION_STAGES: readonly SelectionStage[] = [
  {
    id: "classify-ownership",
    label: "Classify the requested capability against the #4 ownership boundary",
    authority: "agent",
    produces:
      "An ownership decision for the capability — and with it the branch to run, and on the Forguncy-owned branch the architectural `replace` decision itself (strategy `replace`, the assessment's own rejection). A React-island capability continues to candidate selection instead.",
    mustNot: [
      "Do not research, shortlist or install a package before the capability's owner has been decided.",
      "Do not install a competing application framework for a capability Forguncy already owns; route it to the host instead.",
      "Do not continue into candidate research, ranking or probing for a Forguncy-owned capability — see SELECTION_BRANCHES.",
    ],
  },
  {
    id: "research-candidates",
    label: "Research current candidate packages for the capability",
    authority: "agent",
    produces: "A shortlist of current candidates, each with the signals it actually exhibits.",
    mustNot: [
      "Do not treat a well-known package as a candidate on recall alone; check what its current distribution and requirements are.",
      "Do not shortlist a candidate on documentation claims that no observation channel can confirm.",
    ],
  },
  {
    id: "rank-candidates",
    label: "Rank candidates by the selection signals",
    authority: "agent",
    produces: "A ranked shortlist, with the reason each candidate is preferred or disfavoured.",
    mustNot: [
      "Do not accept a candidate on positive signals alone; a positive signal narrows the field and is never proof.",
      "Do not reject a candidate because it carries a risk signal; a risk is probed, not assumed broken.",
    ],
  },
  {
    id: "probe-candidate",
    label: "Probe the candidate with the deterministic probe protocol",
    authority: "scripts",
    produces: "A versioned, machine-readable probe report whose findings a consumer can independently re-check.",
    mustNot: [
      "Do not decide product ownership, choose a replacement package, or choose a deployment strategy.",
      "Do not report a failed step as a boolean; a failure has to carry actionable evidence.",
    ],
  },
  {
    id: "decide-strategy",
    label: "Choose one of host/inline/extension/replace for the candidate, on the probe evidence",
    authority: "agent",
    produces:
      "One strategy per (package, cell target) pair, backed by the evidence #8's profile names for it. An ownership conflict never reaches this stage: it was decided by the gate.",
    mustNot: [
      "Do not choose a deployment strategy the probe did not support, or claim compatibility from inspection alone.",
      "Do not report a green local build as Forguncy runtime compatibility; only an executed real-runtime check supports that.",
    ],
  },
  {
    id: "resolve-replacement",
    label: "Resolve an awkward candidate by replacing it, not by adapting it",
    authority: "agent",
    produces: "An evaluated alternative, or a host-owned capability, or a justified project-local repair.",
    mustNot: [
      "Do not write a package-specific adapter before alternatives have actually been evaluated.",
      "Do not add an entry to a global package compatibility or adapter registry.",
    ],
  },
  {
    id: "persist-decision",
    label: "Persist the decision and its evidence into the project lock",
    // #16 puts "lock updates" explicitly on the scripts/tooling side, next to
    // inspection, builds, artifact scanning and size calculation. The *content* of
    // the record is the Agent's, produced by `decide-strategy`; writing it is
    // deterministic work, and it is the point at which an unrecordable decision has
    // to be refused rather than written.
    authority: "scripts",
    produces:
      "A lock record linking the evidence #8's profile names for the decision — probe evidence for a dependency decision, the ownership decision for an architectural rejection — and can be invalidated when its inputs move.",
    mustNot: [
      "Do not decide the strategy, invent a rationale, or fill in evidence the Agent did not produce.",
      "Do not write a record whose evidence does not match #8's profile for the decision: probe evidence for a dependency decision, the ownership decision for an architectural rejection. Refuse it and report why.",
    ],
  },
];

export const SELECTION_STAGE_IDS: readonly SelectionStageId[] = SELECTION_STAGES.map(stage => stage.id);

const STAGE_BY_ID: ReadonlyMap<SelectionStageId, SelectionStage> = new Map(SELECTION_STAGES.map(stage => [stage.id, stage]));

export function isSelectionStageId(value: unknown): value is SelectionStageId {
  return typeof value === "string" && STAGE_BY_ID.has(value as SelectionStageId);
}

export function findSelectionStage(id: string): SelectionStage | undefined {
  return STAGE_BY_ID.get(id as SelectionStageId);
}

/** Throws for an unknown id so a typo cannot silently drop a stage. */
export function selectionStage(id: SelectionStageId): SelectionStage {
  const stage = STAGE_BY_ID.get(id);
  if (!stage) {
    throw new Error(`Unknown dependency-selection stage "${id}".`);
  }
  return stage;
}

/** Position in {@link SELECTION_STAGES} — the flow's fixed order. */
export function selectionStageOrder(id: SelectionStageId): number {
  return SELECTION_STAGE_IDS.indexOf(id);
}

export function stagesBefore(id: SelectionStageId): readonly SelectionStage[] {
  const order = selectionStageOrder(id);
  return SELECTION_STAGES.filter(stage => selectionStageOrder(stage.id) < order);
}

export function stagesWithAuthority(authority: SelectionAuthority): readonly SelectionStage[] {
  return SELECTION_STAGES.filter(stage => stage.authority === authority);
}

// ---------------------------------------------------------------------------
// Ownership gate
// ---------------------------------------------------------------------------

export const OWNERSHIP_GATE_STAGE_ID: SelectionStageId = "classify-ownership";

/**
 * The gate has to be the first stage, and that is the whole point of the flow.
 *
 * Reversing it — classifying the package first and asking about ownership later —
 * is what lets any package outside a rule table fill an application-owned role as
 * "unclassified", and it is how a cell ends up hosting a second router or business
 * store. Whether the gate is first is therefore a property worth asserting rather
 * than a diagram worth drawing.
 */
export function isOwnershipGateFirst(stages: readonly SelectionStage[] = SELECTION_STAGES): boolean {
  return stages[0]?.id === OWNERSHIP_GATE_STAGE_ID;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export type SelectionBranchId = "forguncy-owned" | "react-island-owned";

/**
 * One arm of the flow the ownership gate selects.
 *
 * `SELECTION_STAGES` is the vocabulary; it is *not* a pipeline to execute item by item,
 * and an earlier revision of this module left that open to misreading. The gate decides
 * between two arms, and the Forguncy-owned arm exits before any candidate work: probing
 * a package to discover that a capability belongs to the host would be the ownership-first
 * rule running backwards, and #8 gives the resulting architectural rejection no probe.
 *
 * Exporting the arms is what makes "the ownership gate is earlier than the probe" a
 * checkable fact for #18 rather than something it has to notice.
 */
export interface SelectionBranch {
  readonly id: SelectionBranchId;
  readonly label: string;
  /** The assessment outcome that selects this arm. */
  readonly enteredWhen: "ownership-assessment-is-a-platform-conflict" | "ownership-assessment-is-not-a-platform-conflict";
  /** The stage that decides it. */
  readonly decidedAt: SelectionStageId;
  /** The stages this arm runs, in order. */
  readonly stages: readonly SelectionStageId[];
  /** True when the arm stops before researching, ranking or probing a candidate. */
  readonly skipsCandidateWork: boolean;
  /**
   * The stage that forms the decision this arm records.
   *
   * The two arms record different things, and saying who forms it closes a gap the
   * stage list alone leaves open: `persist-decision` is forbidden from deciding the
   * strategy, so on the early-exit arm the architectural `replace` decision has to be
   * formed by the gate itself — the ownership assessment is a rejection, not yet a
   * `{ strategy: "replace", packageName, rejection }` record.
   */
  readonly formsDecisionAt: SelectionStageId;
  readonly decisionKind: "architectural-rejection" | "package-strategy";
}

export const SELECTION_BRANCHES: readonly SelectionBranch[] = [
  {
    id: "forguncy-owned",
    label: "The capability belongs to Forguncy: route it to the host",
    enteredWhen: "ownership-assessment-is-a-platform-conflict",
    decidedAt: OWNERSHIP_GATE_STAGE_ID,
    // Straight from the gate to the lock: no candidate, so nothing to research, rank,
    // probe or replace, and the recorded evidence is the ownership decision.
    stages: ["classify-ownership", "persist-decision"],
    skipsCandidateWork: true,
    // The gate forms the architectural `replace` from the assessment it just made.
    formsDecisionAt: OWNERSHIP_GATE_STAGE_ID,
    decisionKind: "architectural-rejection",
  },
  {
    id: "react-island-owned",
    label: "The capability is a React-island concern: select and probe a package",
    enteredWhen: "ownership-assessment-is-not-a-platform-conflict",
    decidedAt: OWNERSHIP_GATE_STAGE_ID,
    stages: SELECTION_STAGE_IDS,
    skipsCandidateWork: false,
    formsDecisionAt: "decide-strategy",
    decisionKind: "package-strategy",
  },
];

const BRANCH_BY_ID: ReadonlyMap<SelectionBranchId, SelectionBranch> = new Map(
  SELECTION_BRANCHES.map(branch => [branch.id, branch]),
);

export function isSelectionBranchId(value: unknown): value is SelectionBranchId {
  return typeof value === "string" && BRANCH_BY_ID.has(value as SelectionBranchId);
}

export function findSelectionBranch(id: SelectionBranchId): SelectionBranch | undefined {
  return BRANCH_BY_ID.get(id);
}

/** Throws for an unknown id so a typo cannot silently select no branch. */
export function selectionBranch(id: SelectionBranchId): SelectionBranch {
  const branch = BRANCH_BY_ID.get(id);
  if (!branch) {
    throw new Error(`Unknown dependency-selection branch "${id}".`);
  }
  return branch;
}

export function stagesForBranch(id: SelectionBranchId): readonly SelectionStage[] {
  return selectionBranch(id).stages.map(stageId => selectionStage(stageId));
}

/**
 * Which arm a #4 ownership assessment selects.
 *
 * Consumes the assessment rather than re-deriving the answer, so a caller holding the
 * gate's output does not decide the branch by inspecting the stage list.
 */
export function branchForOwnership(ownership: PlatformConflictAssessment): SelectionBranch {
  return selectionBranch(isPlatformConflict(ownership) ? "forguncy-owned" : "react-island-owned");
}

/**
 * The stages the Forguncy-owned arm skips.
 *
 * Named explicitly because this is the difference a reader is most likely to miss when
 * treating `SELECTION_STAGES` as linear — and the difference that decides whether an
 * ownership conflict is answered by routing it to the host or by researching packages.
 */
export function stagesSkippedOnEarlyExit(): readonly SelectionStageId[] {
  const early = new Set(stagesForBranch("forguncy-owned").map(stage => stage.id));
  return SELECTION_STAGE_IDS.filter(stageId => !early.has(stageId));
}

/**
 * A stage that only runs for some outcomes of the stage before it.
 *
 * The React-island arm is not unconditional either. `resolve-replacement` exists to
 * resolve an awkward candidate by replacing it, so a run that ends in `inline` has
 * nothing for it to do — and listing it as an obligatory step told a consumer to go and
 * replace a candidate it had just accepted. The strategy is decided at
 * {@link SELECTION_STAGE_IDS}'s `decide-strategy`, so the condition belongs to the
 * transition rather than to the reader.
 */
export interface ConditionalSelectionStage {
  readonly stage: SelectionStageId;
  readonly enteredWhen: "decision-strategy-is-replace";
  /** The stage whose outcome selects it. */
  readonly decidedAt: SelectionStageId;
  readonly reason: string;
}

export const CONDITIONAL_SELECTION_STAGES: readonly ConditionalSelectionStage[] = [
  {
    stage: "resolve-replacement",
    enteredWhen: "decision-strategy-is-replace",
    decidedAt: "decide-strategy",
    reason:
      "Only a `replace` decision has an awkward candidate to resolve. `host`, `inline` and `extension` accepted the candidate, so there is nothing to replace and the run goes straight to persisting the record.",
  },
];

export function findConditionalSelectionStage(stage: SelectionStageId): ConditionalSelectionStage | undefined {
  return CONDITIONAL_SELECTION_STAGES.find(entry => entry.stage === stage);
}

export function isConditionalSelectionStage(stage: SelectionStageId): boolean {
  return findConditionalSelectionStage(stage) !== undefined;
}

/**
 * The stages a React-island run executes for a given decision.
 *
 * The answer a consumer actually wants: `decide-strategy` chooses the strategy, and the
 * stage list follows from it. A `replace` decision runs `resolve-replacement`; any other
 * strategy does not.
 */
export function stagesForIslandDecision(strategy: DependencyStrategy): readonly SelectionStage[] {
  const conditional = new Set(CONDITIONAL_SELECTION_STAGES.map(entry => entry.stage));
  return SELECTION_STAGE_IDS.filter(stageId => !conditional.has(stageId) || strategy === "replace").map(stageId =>
    selectionStage(stageId),
  );
}

// ---------------------------------------------------------------------------
// Replacement over adaptation
// ---------------------------------------------------------------------------

/**
 * #16's first acceptance criterion, stated as an invariant.
 *
 * The absence of a registry is not a style preference. A registry is the shape
 * that makes every future incompatible package look like a task; without one, an
 * awkward candidate has nowhere to go except `replace` — which is exactly the
 * pressure #16 wants applied.
 */
export const NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT =
  "No package-specific global adapter registry is required for normal operation." as const;

export type RepairRecipeConditionId =
  | "capability-still-valuable"
  | "alternatives-materially-worse"
  | "repair-can-be-validated";

export interface RepairRecipeCondition {
  readonly id: RepairRecipeConditionId;
  readonly requires: string;
  readonly why: string;
}

/**
 * The three conditions #16 rule 6 puts on a project-local repair recipe, and
 * nothing else is allowed to justify one.
 *
 * The conjunction is deliberate: each condition alone is routinely true. A
 * capability is usually valuable, and almost any repair can be validated once
 * someone writes it — so on its own each of them licenses exactly the permanent
 * adapter the Spec exists to avoid. Only "the alternatives are materially worse"
 * makes a repair the cheaper answer than a replacement.
 */
export const REPAIR_RECIPE_CONDITIONS: readonly RepairRecipeCondition[] = [
  {
    id: "capability-still-valuable",
    requires: "The capability the package provides is genuinely needed by a cell.",
    why: "A repair is engineering effort spent on a requirement; without the requirement there is nothing to spend it on.",
  },
  {
    id: "alternatives-materially-worse",
    requires: "Alternatives were evaluated and are materially worse on API fit, runtime complexity or maintenance.",
    why: "This is the condition that decides between a repair and a replacement. Without it, the repair is the option nobody evaluated.",
  },
  {
    id: "repair-can-be-validated",
    requires: "The repair can be shown to work by an executed local or real-runtime check.",
    why: "An unvalidated repair is indistinguishable from giving up while keeping the dependency, and it cannot be recorded in the lock as evidence.",
  },
];

export interface RepairRecipeInput {
  readonly capabilityStillValuable: boolean;
  readonly alternativesMateriallyWorse: boolean;
  readonly repairCanBeValidated: boolean;
}

export interface RepairRecipeAssessment {
  readonly status: "allowed" | "refused";
  readonly unmetConditions: readonly RepairRecipeConditionId[];
  readonly reason: string;
}

export function evaluateRepairRecipe(input: RepairRecipeInput): RepairRecipeAssessment {
  const unmetConditions: RepairRecipeConditionId[] = [];
  if (!input.capabilityStillValuable) {
    unmetConditions.push("capability-still-valuable");
  }
  if (!input.alternativesMateriallyWorse) {
    unmetConditions.push("alternatives-materially-worse");
  }
  if (!input.repairCanBeValidated) {
    unmetConditions.push("repair-can-be-validated");
  }

  if (unmetConditions.length === 0) {
    return {
      status: "allowed",
      unmetConditions,
      reason:
        "All three conditions hold, so a project-local repair recipe is justified. Record it as evidence on the decision and keep it out of any shared registry, so the next Agent sees the reasoning rather than an unexplained special case.",
    };
  }

  return {
    status: "refused",
    unmetConditions,
    reason: `A project-local repair recipe is only justified when the capability is valuable, alternatives are materially worse, and the repair can be validated. Unmet: ${unmetConditions.join(", ")}. Prefer \`replace\` with an evaluated alternative (#16 rule 5) over building a permanent adapter.`,
  };
}

// ---------------------------------------------------------------------------
// Proving the Spec
// ---------------------------------------------------------------------------

export interface SpecProvingCase {
  readonly id: "simple-esm-package" | "worker-or-wasm-risk-package";
  readonly capability: string;
  readonly signalsExercised: readonly SelectionSignalId[];
  readonly proves: string;
}

/**
 * The two end-to-end cases #16 requires before the Spec counts as proven.
 *
 * They are named here rather than left to the evaluation work in #18 so the two
 * cases cannot be silently reduced to whichever one is convenient: the plain case
 * demonstrates the ordinary path needs no special handling at all, and the risky
 * case is the one where a purely heuristic policy would have produced a verdict
 * instead of a measurement.
 */
export const SPEC_PROVING_CASES: readonly SpecProvingCase[] = [
  {
    id: "simple-esm-package",
    capability: "A pure utility or React-island capability whose best candidates are browser-first ESM packages.",
    signalsExercised: ["browser-first-esm-distribution", "no-node-builtins", "shipped-typescript-declarations"],
    proves:
      "That the ordinary case reaches a strategy through the probe alone, with no per-package entry anywhere — i.e. that normal operation needs no adapter registry.",
  },
  {
    id: "worker-or-wasm-risk-package",
    capability:
      "A viewer, editor or 3D capability whose best-known candidates carry a Worker, WASM or runtime-asset requirement.",
    signalsExercised: ["worker", "wasm", "dynamic-import-or-code-splitting"],
    proves:
      "That a risk is surfaced as a finding through the probe and weighed against alternatives, rather than sliding from \"this has a Worker\" into \"this is unsupported\" without anyone measuring it.",
  },
];

// ---------------------------------------------------------------------------
// Acceptance criteria as data
// ---------------------------------------------------------------------------

export interface SelectionAcceptanceCriterion {
  readonly id: string;
  readonly criterion: string;
  /** Where the criterion is actually enforced, so it is checkable rather than aspirational. */
  readonly enforcedBy: string;
}

/**
 * #16's acceptance criteria with their enforcement points.
 *
 * Exported because a criterion with no mechanism behind it is a wish. Naming the
 * mechanism makes it possible to review a change to this policy against the list
 * instead of against the Issue text, and makes a criterion that loses its
 * enforcement visible.
 */
export const SELECTION_ACCEPTANCE_CRITERIA: readonly SelectionAcceptanceCriterion[] = [
  {
    id: "no-adapter-registry",
    criterion: "No package-specific global adapter registry is required for normal operation.",
    enforcedBy: `NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT plus evaluateRepairRecipe, which leaves \`replace\` as the only unconstrained answer for an awkward candidate.`,
  },
  {
    id: "machine-readable-probe-output",
    criterion: "Probe output is machine-readable enough for Agent and CI consumption.",
    enforcedBy: `PROBE_REPORT_MACHINE_READABILITY, the canonical serialization in serializeProbeReport, and validateProbeReport's refusal of an unaccounted step or a boolean-only failure.`,
  },
  {
    id: "replacement-preferred",
    criterion: "The Skill explicitly prefers replacement over permanent adaptation for long-tail incompatible packages.",
    enforcedBy: `stage "resolve-replacement" and the replacement family in SELECTION_SIGNAL_FAMILY_SEMANTICS, which is the only family that rejects a candidate.`,
  },
  {
    id: "lock-integration",
    criterion: "Results integrate with #8 lock invalidation semantics.",
    enforcedBy: `auditSelectionDecision requiring the evidence #8's evidence profile names for the decision — a probe for a dependency decision, the ownership decision for an architectural rejection — and the lock's evidence profiles, which are keyed on the same technical/architectural split this policy produces.`,
  },
  {
    id: "end-to-end-proof",
    criterion: "At least one simple ESM package and one Worker/WASM-risk package are evaluated end-to-end.",
    // This one is *evidence* rather than a mechanism, and it took a while to be
    // discharged: it needs the probe engine (#17) to run against something other than
    // a fixture, which no PR against #16 itself could produce. `SPEC_PROVING_CASES`
    // fixes which two cases have to appear, so that neither can be dropped.
    //
    // The evaluation is `packages/dependency-resolver/src/selection-proving-cases.test.ts`,
    // which runs the two cases — `es-toolkit` and `@embedpdf/pdfium`, installed at
    // exact versions from `examples/probe-proving-cases` — through the whole selection
    // flow: ownership gate, probe, audit, lock record, freshness read-back.
    //
    // It is a test rather than a report because of what the first real-package run
    // uncovered: three false `platform-api-unavailable` rejections that every synthetic
    // fixture had passed, because each fixture ships one source file per package and so
    // could not distinguish "the whole tree" from "what a browser build reaches". Only a
    // genuine published artifact separates those sets, and a report cannot be re-run when
    // someone next changes a scanner.
    //
    // What this does not cover: #18's Skill-level evaluation of the same cases (candidate
    // research, ranking, the choice among alternatives) is a separate deliverable and
    // remains open. This criterion is about the evidence the policy requires, which now
    // exists and is executed on every run.
    enforcedBy: `packages/dependency-resolver/src/selection-proving-cases.test.ts — the two cases SPEC_PROVING_CASES fixes (es-toolkit for the plain case, @embedpdf/pdfium for the Worker/WASM-risk case), each run end to end against a real installed artifact.`,
  },
];

// ---------------------------------------------------------------------------
// Recording: report outcome to lock evidence status
// ---------------------------------------------------------------------------

/**
 * The probe status an architectural rejection's record must carry.
 *
 * `not-run`, and that is the design rather than an omission: #8's
 * `architectural-rejection` profile has `probeRequirement: "none"`, so a record that
 * carried a probe status other than `not-run` would be claiming evidence the decision
 * does not have.
 */
export const ARCHITECTURAL_REJECTION_PROBE_STATUS: ProbeStatus = "not-run";

/**
 * #8's three statuses are about evidence, not about whether a script exited cleanly.
 *
 * This is the half of "results integrate with #8" that was still missing: the audit
 * already reads #8's profile to decide *which* probe a decision owes, but nothing said
 * what the report's outcome becomes in the record. Without it a writer has no answer
 * for a report where every step succeeded and the conclusion was still a refusal — the
 * case `supports-rejection-only` exists to express — and would have to guess between
 * `passed` and `failed`.
 *
 * `failed` is the right answer there, and it reads as one: the candidate failed the
 * probe. The step that discovered the disqualifying property succeeded at discovering
 * it; that is a fact about the step, not about the candidate.
 */
export function lockProbeStatusForAssessment(assessment: ProbeAssessment): ProbeStatus | null {
  switch (assessment.status) {
    case "supports-deployment":
      return "passed";
    case "supports-rejection-only":
      return "failed";
    case "inconclusive":
      // Not a status choice: an inconclusive report cannot support any record, which is
      // why the audit refuses it too.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy support
// ---------------------------------------------------------------------------

export interface StrategyProbeSupport {
  readonly supported: boolean;
  /**
   * The outcome #8's evidence profile requires of this decision, so a caller can see
   * *which* contract refused it rather than only that something did.
   */
  readonly required: LockProbeRequirement;
  readonly assessment: ProbeAssessment;
  readonly reason: string;
}

/**
 * Whether a probe report satisfies the evidence the decision owes.
 *
 * Two questions, kept apart on purpose — the reviewer's framing of this bug was
 * exactly that they had been conflated:
 *
 * - **What does this decision owe?** That is #8's call, not this module's:
 *   `lockEvidenceProfileForDecision` selects `resolved-dependency` /
 *   `architectural-rejection` / `technical-rejection`, and each profile states a
 *   `probeRequirement` of `"passed"`, `"none"` or `"not-passed"`. Reading it here
 *   instead of restating it is what makes the record written by this flow and the
 *   record evaluated by the lock agree.
 * - **What does this report provide?** That is the probe protocol's call, via
 *   `assessProbeReport`.
 *
 * The comparison is therefore between two independently-defined answers, and the
 * earlier bug — `replace` supported by "any outcome that is not `inconclusive`" — was
 * the result of answering both questions in one step. A failed step shows the
 * candidate cannot be *accepted*; it does not show *why* it is rejected, so a
 * rejection now additionally requires a machine-observed rejection finding.
 */
export function probeSupportsStrategy(report: ProbeReport, decision: DependencyDecision): StrategyProbeSupport {
  const profile = lockEvidenceProfileForDecision(decision);
  const required = LOCK_EVIDENCE_POLICY[profile].probeRequirement;
  const assessment = assessProbeReport(report);

  if (required === "none") {
    return {
      supported: false,
      required,
      assessment,
      reason: `#8 records the evidence of a "${profile}" decision as probeRequirement "${required}", so it owes no probe: its evidence is the ownership decision. A probe report here means the ownership gate was bypassed, not that the rejection is better evidenced.`,
    };
  }

  if (assessment.status === "inconclusive") {
    return {
      supported: false,
      required,
      assessment,
      reason: `The report reached no conclusion, so it satisfies neither a "${required}" requirement nor its opposite. ${assessment.reason}`,
    };
  }

  if (required === "passed") {
    const supported = assessment.status === "supports-deployment";
    return {
      supported,
      required,
      assessment,
      reason: supported
        ? assessment.reason
        : `A "${profile}" decision owes a passing probe, so every deployment-required step (${PROBE_DEPLOYMENT_REQUIRED_STEPS.join(", ")}) has to have passed and nothing may disqualify the candidate. ${assessment.reason}`,
    };
  }

  // required === "not-passed": the refusal has to rest on a finding.
  const supported = assessment.status === "supports-rejection-only" && assessment.rejectionFindings.length > 0;
  return {
    supported,
    required,
    assessment,
    reason: supported
      ? assessment.reason
      : `A "${profile}" decision owes a probe that did not succeed, and the refusal has to rest on a rejection finding rather than on the mere absence of success. ${assessment.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Decision audit
// ---------------------------------------------------------------------------

export interface SelectionAuditInput {
  readonly decision: DependencyDecision;
  /** The probe report the decision rests on, or null when no probe was run. */
  readonly probe: ProbeReport | null;
  /** A project-local repair recipe the decision proposes, if any. */
  readonly repairRecipe?: RepairRecipeInput | null;
  /**
   * The #4 role assessment for the capability the dependency is being asked to fill.
   *
   * **Required, not optional.** Ownership arrives as an *input*, never as an
   * observation: nothing in a package artifact can establish which side of the
   * ownership boundary a capability belongs to, so the answer comes from
   * `assessDependencyRole` in `platform-conflicts.ts`. Leaving it optional made
   * #16 rule 1 optional too — every caller that simply omitted it got an audit that
   * never ran the gate.
   */
  readonly ownership: PlatformConflictAssessment;
}

/**
 * Whether a selection decision may be recorded — shape, evidence and boundary.
 *
 * This is the composition point, and it delegates rather than restates. #4's
 * rules about decision records run through `validateDependencyDecisionShape`, the
 * report's own contract through `validateProbeReport`, the probe each decision *owes*
 * through #8's `LOCK_EVIDENCE_POLICY` (via `probeSupportsStrategy`), and the ownership
 * answer through the `ownership` assessment the caller supplies. What is new here is
 * only what #16 adds: the ownership gate is mandatory and runs first, a decision cannot
 * exist without the probe it owes, the probe has to be about the package being decided
 * and to actually satisfy the evidence policy, a technical refusal has to bind to a
 * machine-observed finding, and a repair recipe has to pass the three conditions.
 *
 * The gate is a branch, not a check. A Forguncy-owned capability stops the flow: it
 * owes a `replace` with the assessment's own architectural rejection and, per #8's
 * `architectural-rejection` profile, **no probe at all**. Requiring a probe there — as
 * an earlier revision did — turned "route this to the host" back into "go and probe a
 * package first", which is the ownership-first rule inverted.
 *
 * Returning problems instead of throwing keeps it usable as a checklist by the
 * Agent and as an assertion by the script stage that writes the lock — which is
 * where an unrecordable decision has to be refused rather than written.
 */
export function auditSelectionDecision(input: SelectionAuditInput): readonly string[] {
  const problems: string[] = [];
  const { decision, probe, repairRecipe, ownership } = input;

  const profile = lockEvidenceProfileForDecision(decision);
  const probeRequirement = LOCK_EVIDENCE_POLICY[profile].probeRequirement;

  // Ownership is assessed per (capability, package) pair, so an assessment for a
  // different package cannot justify this decision: role "application-navigation"
  // yields `application-router-conflict` for react-router-dom and the generic
  // `ownership-boundary-violation` for anything else, and borrowing the specific code
  // is exactly how a decision gets a precise-looking reason it did not earn.
  if (ownership.packageName !== decision.packageName) {
    problems.push(
      `The ownership assessment is about "${ownership.packageName}" but the decision is about "${decision.packageName}". Ownership is assessed per (capability, package) pair, so an assessment for another package cannot justify this decision.`,
    );
  }

  if (isPlatformConflict(ownership)) {
    // #16 rule 1: the gate stops the flow here, and #8 encodes the same answer as
    // probeRequirement "none" for an architectural rejection. Its evidence is the
    // ownership decision, not a bundle.
    if (decision.strategy !== "replace") {
      problems.push(
        `The capability was assessed as Forguncy-owned ("${ownership.rejection.code}" for "${ownership.packageName}" in role "${ownership.role}"), so it cannot be recorded as "${decision.strategy}". Route the capability to the host: ${DEPENDENCY_REJECTION_RESPONSE.architectural.resolutionOwner} owns the fix, and no replacement package can resolve an ownership conflict.`,
      );
    } else if (decision.rejection.kind !== "architectural") {
      problems.push(
        `The #4 role assessment rejected "${ownership.packageName}" architecturally ("${ownership.rejection.code}"), but the recorded rejection is technical ("${decision.rejection.code}"). These are different answers, and an ownership conflict reported as a bundling failure is exactly the confusion #4 exists to prevent.`,
      );
    } else if (decision.rejection.code !== ownership.rejection.code) {
      problems.push(
        `The recorded architectural rejection is "${decision.rejection.code}" but the #4 role assessment produced "${ownership.rejection.code}"; record the assessment's rejection instead of a hand-written one.`,
      );
    }

    if (probe !== null) {
      problems.push(
        `"${decision.packageName}" carries a probe report, but #8 records the evidence of a "${profile}" decision as probeRequirement "${probeRequirement}". An architectural rejection's evidence is the ownership decision; probing a candidate first is what the ownership-first gate exists to prevent.`,
      );
    }
  } else {
    // React-island / allowed path: the decision now depends on a probe whose required
    // outcome #8 states.
    if (decision.strategy === "replace" && decision.rejection.kind === "architectural") {
      problems.push(
        `"${decision.packageName}" records an architectural rejection, but the #4 role assessment for role "${ownership.role}" did not find the capability to be Forguncy-owned. An architectural rejection is an ownership answer, and the ownership answer disagrees.`,
      );
    }

    if (probe === null) {
      problems.push(
        `"${decision.packageName}" was decided without a probe report, but #8 records the evidence of a "${profile}" decision as probeRequirement "${probeRequirement}". #16 requires the executed deterministic probe this decision owes — never inspection of the package's documentation alone — because the failure modes that break a cell only appear once something is built and executed.`,
      );
    } else {
      if (probe.environment.packageName !== decision.packageName) {
        problems.push(
          `The probe report is about "${probe.environment.packageName}" but the decision is about "${decision.packageName}"; a decision has to cite evidence for the package it decides.`,
        );
      }

      // An invalid report must not reach the decision layer. Its problems become this
      // audit's problems, so a caller cannot record a decision on a report that its own
      // contract rejects (an unaccounted step, a boolean-only failure, a finding filed
      // under the wrong family).
      for (const problem of validateProbeReport(probe)) {
        problems.push(`The probe report for "${decision.packageName}" fails its own contract. ${problem}`);
      }

      const support = probeSupportsStrategy(probe, decision);
      if (!support.supported) {
        problems.push(
          `The probe does not satisfy the evidence "${decision.packageName}" owes. ${support.reason}`,
        );
      }

      // The refusal has to name *this* reason. A failure shows the candidate cannot be
      // accepted; it does not show that it failed for the reason the decision records,
      // and an unrelated build error must not be able to certify a size or asset
      // rejection. `REPLACEMENT_SIGNAL_REJECTIONS` already maps a finding to a code, so
      // the check is a comparison rather than a judgement.
      if (decision.strategy === "replace" && decision.rejection.kind === "technical") {
        const observedCodes = support.assessment.rejectionFindings
          .map(finding => findReplacementSignalRejection(finding.signal)?.code)
          .filter((code): code is NonNullable<typeof code> => code !== undefined);

        if (!observedCodes.includes(decision.rejection.code)) {
          const observed =
            observedCodes.length > 0
              ? observedCodes.join(", ")
              : "none (the report contains no rejection finding)";
          problems.push(
            `The recorded technical rejection is "${decision.rejection.code}", but the machine-observed rejection codes are: ${observed}. A failed step shows the candidate cannot be accepted; it does not prove this reason. Record the code the finding maps to, or produce the finding that supports this one.`,
          );
        }
      }
    }
  }

  if (repairRecipe !== undefined && repairRecipe !== null) {
    const assessment = evaluateRepairRecipe(repairRecipe);
    if (assessment.status === "refused") {
      problems.push(`A project-local repair recipe for "${decision.packageName}" is refused. ${assessment.reason}`);
    }
  }

  // #4's rules, composed rather than duplicated; the prefix is what makes the
  // problem readable next to this module's own.
  for (const problem of validateDependencyDecisionShape(decision)) {
    problems.push(`${problem} (#4 decision shape)`);
  }

  return problems;
}

/** True when `auditSelectionDecision` found nothing to object to. */
export function isSelectionDecisionRecordable(input: SelectionAuditInput): boolean {
  return auditSelectionDecision(input).length === 0;
}

/**
 * The justification #4 owes for a strategy, or null when none is owed.
 *
 * Exposed so a caller does not re-derive which strategies need a written rationale
 * from the strategy's own semantics — the answer lives in `strategy.ts` and is
 * read here rather than copied.
 */
export function selectionJustificationRequired(strategy: DependencyStrategy): boolean {
  return strategySemantics(strategy).requiresJustification;
}
