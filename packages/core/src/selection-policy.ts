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
import type { PlatformConflictAssessment } from "./platform-conflicts";
import { isPlatformConflict } from "./platform-conflicts";
import type { ProbeAssessment, ProbeReport } from "./probe-protocol";
import { assessProbeReport, PROBE_DEPLOYMENT_REQUIRED_STEPS, validateProbeReport } from "./probe-protocol";
import { DEPENDENCY_REJECTION_RESPONSE } from "./rejection";
import type { SelectionSignalId } from "./selection-signals";
import { decideFromSignals } from "./selection-signals";
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
    produces: "An ownership decision for the capability, or a statement that it is React-island-owned.",
    mustNot: [
      "Do not research, shortlist or install a package before the capability's owner has been decided.",
      "Do not install a competing application framework for a capability Forguncy already owns; route it to the host instead.",
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
    label: "Choose one of host/inline/extension/replace from the probe evidence",
    authority: "agent",
    produces: "One strategy per (package, cell target) pair, backed by probe evidence.",
    mustNot: [
      "Do not choose a strategy the probe did not support, or claim compatibility from inspection alone.",
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
    produces: "A lock record that links the probe it rests on and can be invalidated when its inputs move.",
    mustNot: [
      "Do not decide the strategy, invent a rationale, or fill in evidence the Agent did not produce.",
      "Do not write a record that links no probe evidence, or whose evidence this run replaced with an assumption; refuse it and report why.",
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
    enforcedBy: `auditSelectionDecision requiring a probe report before a decision is recorded, and the lock's evidence profiles, which are keyed on the same technical/architectural split this policy produces.`,
  },
  {
    id: "end-to-end-proof",
    criterion: "At least one simple ESM package and one Worker/WASM-risk package are evaluated end-to-end.",
    // Deliberately not phrased as "enforcedBy". This criterion is *evidence*, and no
    // PR against #16 can produce it: it needs the probe engine (#17) to run and the
    // selection flow (#18) to exercise both cases. `SPEC_PROVING_CASES` only fixes
    // which two cases have to appear in that evaluation, so that neither can be
    // dropped — which is why #16 stays open until they are discharged.
    enforcedBy: `Not enforced in this repository yet. SPEC_PROVING_CASES fixes both cases for the evaluation that #17 and #18 produce; this criterion is outstanding.`,
  },
];

// ---------------------------------------------------------------------------
// Strategy support
// ---------------------------------------------------------------------------

export interface StrategyProbeSupport {
  readonly supported: boolean;
  readonly assessment: ProbeAssessment;
  readonly reason: string;
}

/**
 * Whether a probe report can carry the strategy being recorded.
 *
 * This exists because "the probe had at least one passing step" is a different claim
 * from "the probe supports this strategy", and conflating them is a live failure
 * mode rather than a pedantic one: a report where `package-identity` passed and
 * `build` failed is a description of a candidate that does not work, so it must not
 * be recordable as `inline`. Gating on "something passed" allows exactly that.
 *
 * - `host` / `inline` / `extension` claim the candidate *works*, so every
 *   deployment-required step has to have passed.
 * - `replace` claims only that this candidate is not the answer, so it is carried by
 *   any report that reached a conclusion — either something failed, or everything
 *   passed and a disqualifying signal did the work. `inconclusive` carries neither,
 *   because refusing a candidate still requires having actually looked at it.
 */
export function probeSupportsStrategy(report: ProbeReport, strategy: DependencyStrategy): StrategyProbeSupport {
  const assessment = assessProbeReport(report);

  if (strategy === "replace") {
    const supported = assessment.status !== "inconclusive";
    return {
      supported,
      assessment,
      reason: supported
        ? `A \`replace\` decision rests on refusal evidence. ${assessment.reason}`
        : `A \`replace\` decision is not supported either. ${assessment.reason}`,
    };
  }

  const supported = assessment.status === "supports-deployment";
  return {
    supported,
    assessment,
    reason: supported
      ? assessment.reason
      : `"${strategy}" claims the candidate works, so every deployment-required step (${PROBE_DEPLOYMENT_REQUIRED_STEPS.join(", ")}) has to have passed. ${assessment.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Decision audit
// ---------------------------------------------------------------------------

export interface SelectionAuditInput {
  readonly decision: DependencyDecision;
  /** The probe report the decision rests on, or null when no probe was run. */
  readonly probe: ProbeReport | null;
  /** Signals observed while researching and ranking, if the caller tracked them. */
  readonly signals?: readonly string[];
  /** A project-local repair recipe the decision proposes, if any. */
  readonly repairRecipe?: RepairRecipeInput | null;
  /**
   * The #4 role assessment for the capability the dependency is being asked to fill.
   *
   * Ownership arrives as an *input*, never as an observation. Nothing in a package
   * artifact can establish which side of the ownership boundary a capability belongs
   * to, so the answer comes from `assessDependencyRole` in `platform-conflicts.ts`
   * and is consumed here instead of being reconstructed from a signal.
   */
  readonly ownership?: PlatformConflictAssessment | null;
}

/**
 * Whether a selection decision may be recorded — shape, evidence and boundary.
 *
 * This is the composition point, and it delegates rather than restates. #4's
 * rules about decision records run through `validateDependencyDecisionShape`, the
 * signal vocabulary's rules run through `decideFromSignals`, the report's own
 * contract runs through `validateProbeReport`, and the ownership answer runs through
 * the `ownership` assessment the caller supplies. What is new here is only what #16
 * adds: a decision cannot exist without an executed probe, the probe has to be about
 * the package being decided *and* to actually support the strategy, a replacement
 * signal cannot coexist with a non-`replace` strategy, a `replace` of a candidate
 * whose probe passed has to name the signal that disqualifies it, and a repair
 * recipe has to pass the three conditions.
 *
 * Returning problems instead of throwing keeps it usable as a checklist by the
 * Agent and as an assertion by the script stage that writes the lock — which is
 * where an unrecordable decision has to be refused rather than written.
 */
export function auditSelectionDecision(input: SelectionAuditInput): readonly string[] {
  const problems: string[] = [];
  const { decision, probe, signals, repairRecipe, ownership } = input;

  if (probe === null) {
    problems.push(
      `"${decision.packageName}" was decided without a probe report. #16 requires an executed deterministic probe — never inspection of the package's documentation alone — before any strategy is chosen, because the failure modes that break a cell only appear once something is built and executed.`,
    );
  } else {
    if (probe.environment.packageName !== decision.packageName) {
      problems.push(
        `The probe report is about "${probe.environment.packageName}" but the decision is about "${decision.packageName}"; a decision has to cite evidence for the package it decides.`,
      );
    }

    // An invalid report must not reach the decision layer. Its problems become this
    // audit's problems, so a caller cannot record a decision on a report that its own
    // contract rejects (an unaccounted step, a boolean-only failure, a risk filed
    // under a non-risk signal).
    for (const problem of validateProbeReport(probe)) {
      problems.push(`The probe report for "${decision.packageName}" fails its own contract. ${problem}`);
    }

    const support = probeSupportsStrategy(probe, decision.strategy);
    if (!support.supported) {
      problems.push(
        `The probe does not support recording "${decision.strategy}" for "${decision.packageName}". ${support.reason}`,
      );
    }

    // A fully passing probe plus a *technical* `replace` needs a named disqualifying
    // signal. Otherwise a candidate that works can be replaced with no recorded
    // reason, which is the mirror image of choosing a strategy the probe did not
    // support. An architectural rejection is exempt because its reason is ownership,
    // which the `ownership` input already carries.
    if (
      decision.strategy === "replace" &&
      decision.rejection.kind === "technical" &&
      support.assessment.status === "supports-deployment"
    ) {
      const replacementSignals = decideFromSignals(signals ?? []).replacementSignals;
      if (replacementSignals.length === 0) {
        problems.push(
          `The probe for "${decision.packageName}" passed every deployment-required step, so a technical \`replace\` has to name the replacement signal that disqualifies the candidate (for example \`cell-artifact-budget-exceeded\`); without one the replacement has no recorded reason.`,
        );
      }
    }
  }

  if (signals !== undefined && signals.length > 0) {
    const verdict = decideFromSignals(signals);
    if (verdict.unknownSignals.length > 0) {
      problems.push(
        `The selection records unknown signals (${verdict.unknownSignals.join(", ")}); a decision has to rest on signals from the catalogue so its reasoning can be checked.`,
      );
    }
    if (verdict.verdict === "reject-candidate" && decision.strategy !== "replace") {
      problems.push(
        `A replacement signal (${verdict.replacementSignals.join(", ")}) was observed, so "${decision.packageName}" cannot be deployed to this target; the decision cannot be "${decision.strategy}". Use \`replace\`, or decide about the alternative candidate instead.`,
      );
    }
  }

  if (repairRecipe !== undefined && repairRecipe !== null) {
    const assessment = evaluateRepairRecipe(repairRecipe);
    if (assessment.status === "refused") {
      problems.push(`A project-local repair recipe for "${decision.packageName}" is refused. ${assessment.reason}`);
    }
  }

  // Ownership, consumed as #4's decision rather than inferred from an artifact.
  if (ownership !== undefined && ownership !== null && isPlatformConflict(ownership)) {
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
