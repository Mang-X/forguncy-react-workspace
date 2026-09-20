/**
 * The probe protocol: what a candidate-dependency probe must run, what it must
 * report, and — just as importantly — what it must not decide.
 *
 * Decision source: GitHub Issue #16 — "Spec: Agent-driven dependency selection
 * and empirical compatibility probe", section "Probe protocol".
 * https://github.com/Mang-X/forguncy-react-workspace/issues/16
 *
 * Governing Specs: #4 (ownership and strategy semantics — the probe reports on a
 * capability whose owner was already decided), #5 (the target/runtime contract a
 * runtime finding is about), #8 (the lock these findings are persisted into).
 *
 * Boundary with #17: #16 owns the *shape contract* — the steps, the report
 * sections, the separation between observation and decision, and the properties
 * that make the output machine-readable. `Implement: deterministic dependency
 * probe engine` (#17) owns the field-level schema and the code that actually runs
 * the steps. So this module deliberately does not fix a file name, a CLI or a
 * bundle layout.
 *
 * Two rules from #16 are load-bearing enough to be structure rather than prose:
 *
 * - **A probe reports; it does not decide.** Ownership classification, the choice
 *   of a replacement package and the choice of deployment strategy belong to the
 *   Agent (see {@link PROBE_ENGINE_NON_RESPONSIBILITIES}). The report therefore
 *   has no field to put a strategy in: a recommendation smuggled into the probe
 *   output would let a green build certify an architecture decision, and
 *   {@link findForbiddenProbeKeys} turns the presence of such a field into a
 *   validation failure instead of a harmless extra key.
 * - **A failure is evidence, not a boolean.** "build: false" cannot be acted on
 *   and cannot be reviewed six months later, so a `failed` step has to carry the
 *   diagnostics that show what happened; {@link validateProbeReport} refuses one
 *   that does not.
 */

import type { ForguncyTargetIdentity, ToolchainIdentity } from "./lock";
import { isEvidenceReference } from "./lock";
import type { SelectionSignalId, SignalObservationChannel } from "./selection-signals";
import { findSelectionSignal, validateSignalFindings } from "./selection-signals";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type ProbeStepId =
  | "package-identity"
  | "export-metadata"
  | "node-builtin-scan"
  | "build"
  | "artifact-scan"
  | "asset-inventory"
  | "runtime-pattern-scan"
  | "size"
  | "runtime-smoke";

export interface ProbeStep {
  readonly id: ProbeStepId;
  readonly label: string;
  /** What this step contributes to the report. */
  readonly records: string;
}

/**
 * The deterministic steps, in the order a probe should run them.
 *
 * Every step is a function of the lockfile and the toolchain, which is what makes
 * a report reproducible and therefore cacheable (#8). `runtime-smoke` is included
 * because #16 asks for a runtime/browser result "where needed" — it stays a real
 * step rather than an afterthought so that "was a runtime check run?" has an
 * answer in the report instead of being inferred from absence.
 */
export const PROBE_STEPS: readonly ProbeStep[] = [
  {
    id: "package-identity",
    label: "Resolve exact package identity",
    records: "Exact name, resolved version, license and source, so the evidence is about one artifact rather than a package name.",
  },
  {
    id: "export-metadata",
    label: "Read export and browser metadata",
    records: "The `exports`/`module`/`browser`/`types` entries and peer ranges, i.e. which entry point a browser build would actually consume.",
  },
  {
    id: "node-builtin-scan",
    label: "Scan the resolved dependency graph for Node assumptions",
    records: "Node builtin imports and native-addon indicators anywhere in the resolved graph, not just in the package's own source.",
  },
  {
    id: "build",
    label: "Build a minimal candidate fixture",
    records: "Whether the package builds through the same Vite+ stack the Cell compiler uses, and what the failure was when it does not.",
  },
  {
    id: "artifact-scan",
    label: "Scan the build output",
    records: "Emitted chunks, unresolved dynamic imports, and the markers of runtime asset loading.",
  },
  {
    id: "asset-inventory",
    label: "Inventory CSS and static assets",
    records: "Every stylesheet, font, image and data file the artifact references, and whether it is inlined.",
  },
  {
    id: "runtime-pattern-scan",
    label: "Scan for runtime-requirement patterns",
    records: "Worker, SharedWorker, WASM, `new URL(..., import.meta.url)` and runtime `fetch()` of package-relative assets.",
  },
  {
    id: "size",
    label: "Measure output size",
    records: "The generated artifact size, to be compared against the measured cell code budget.",
  },
  {
    id: "runtime-smoke",
    label: "Run a browser/runtime smoke check",
    records: "Whether the built bundle actually executes and the component mounts, where the finding needs a runtime to be observed.",
  },
];

export const PROBE_STEP_IDS: readonly ProbeStepId[] = PROBE_STEPS.map(step => step.id);

const STEP_BY_ID: ReadonlyMap<ProbeStepId, ProbeStep> = new Map(PROBE_STEPS.map(step => [step.id, step]));

export function isProbeStepId(value: unknown): value is ProbeStepId {
  return typeof value === "string" && STEP_BY_ID.has(value as ProbeStepId);
}

export function findProbeStep(id: string): ProbeStep | undefined {
  return STEP_BY_ID.get(id as ProbeStepId);
}

/** Throws for an unknown id so a typo cannot silently drop a step. */
export function probeStep(id: ProbeStepId): ProbeStep {
  const step = STEP_BY_ID.get(id);
  if (!step) {
    throw new Error(`Unknown probe step "${id}".`);
  }
  return step;
}

/** Position in {@link PROBE_STEPS} — the canonical order of a report. */
export function probeStepOrder(id: ProbeStepId): number {
  return PROBE_STEP_IDS.indexOf(id);
}

/**
 * Which steps can actually observe a given channel.
 *
 * A finding has to be produced by the step that can *see* what it claims, not merely
 * by a step that ran. Without this the report is internally consistent and still
 * false: a `cell-artifact-budget-exceeded` finding attributed to `package-identity`
 * passes every other check — the signal is in the right family, the evidence is
 * non-empty, the step did not skip — while asserting something that step never looked
 * at. The catalogue already states where each signal is observed
 * (`SelectionSignal.observedFrom`); this table states which step can do the observing,
 * so the two can be compared instead of assumed.
 *
 * `registry-metadata` maps to no step at all, and that is the honest answer: no probe
 * step reads the registry. A signal whose only channel is registry metadata is a
 * preference, never a finding, so it has no business in `risks` or
 * `rejectionFindings`, and this table is what says so.
 */
export const PROBE_STEPS_OBSERVING_CHANNEL: Readonly<Record<SignalObservationChannel, readonly ProbeStepId[]>> = {
  "registry-metadata": [],
  "package-manifest": ["package-identity", "export-metadata"],
  "package-files": ["package-identity", "export-metadata", "asset-inventory"],
  "dependency-graph": ["node-builtin-scan"],
  "build-output": ["build", "artifact-scan", "size"],
  "artifact-scan": ["artifact-scan", "asset-inventory", "runtime-pattern-scan"],
  "runtime-observation": ["runtime-smoke"],
};

export function probeStepsForChannel(channel: SignalObservationChannel): readonly ProbeStepId[] {
  return PROBE_STEPS_OBSERVING_CHANNEL[channel];
}

/** True when `step` is capable of making an observation of `channel`. */
export function probeStepObservesChannel(step: ProbeStepId, channel: SignalObservationChannel): boolean {
  return probeStepsForChannel(channel).includes(step);
}

// ---------------------------------------------------------------------------
// What the probe engine must not decide
// ---------------------------------------------------------------------------

export type ProbeEngineNonResponsibilityId =
  | "classify-capability-ownership"
  | "choose-replacement-package"
  | "choose-deployment-strategy";

export interface ProbeEngineNonResponsibility {
  readonly id: ProbeEngineNonResponsibilityId;
  /** The question the engine must not answer. */
  readonly question: string;
  /** Who answers it instead. */
  readonly answeredBy: "agent" | "ownership-decision";
  readonly reason: string;
}

/**
 * The decisions a probe is not allowed to make, exported as data so the boundary
 * is reviewable rather than implied by the absence of a field.
 *
 * Both halves matter. A probe that decided ownership would be substituting a
 * bundling result for a #4 boundary decision, and one that picked the replacement
 * would be choosing a capability's home from a build log. The Agent owns all
 * three, and the report exists to give the Agent facts to reason over.
 */
export const PROBE_ENGINE_NON_RESPONSIBILITIES: readonly ProbeEngineNonResponsibility[] = [
  {
    id: "classify-capability-ownership",
    question: "Which side of the #4 ownership boundary does the requested capability belong to?",
    answeredBy: "ownership-decision",
    reason:
      "Ownership is a property of the capability, not of any package: an unknown package filling an application-owned role is exactly as conflicting as a known one. The probe can report what a package does; only the ownership model can say who should do it.",
  },
  {
    id: "choose-replacement-package",
    question: "Which package should be used instead of the candidate that failed?",
    answeredBy: "agent",
    reason:
      "Choosing a replacement is a capability judgement across candidates, licenses and maintenance, and #16 rule 5 prefers an evaluated alternative over an adapter. A probe observes one candidate and has nothing to compare it against.",
  },
  {
    id: "choose-deployment-strategy",
    question: "Is this dependency `host`, `inline` or `extension`?",
    answeredBy: "agent",
    reason:
      "The strategy follows from ownership, module identity and size together. Encoding it in the engine would make a build result certify an architecture decision — which is precisely the failure #16 exists to prevent.",
  },
];

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

/**
 * The five sections, in the order a report reads.
 *
 * The separation is the contract #16 asks for: `facts` are deterministic
 * observations, `risks` are derived technical warnings, `validation` is which steps
 * actually ran and how they ended, and `environment` is the identity of everything
 * the other three were observed against. Folding them together would make "what did
 * we measure" and "what does it mean" the same field, which is how a warning becomes
 * a verdict.
 *
 * `rejectionFindings` is the one bucket #16's own list does not name, and it exists
 * because leaving it out is what made a rejection unfalsifiable. A `replace` decision
 * has to cite a reason, and before this bucket the only channels a reason could come
 * from were `risks` (which must never reject — that is the whole point of the risk
 * family) or a caller-supplied list of signal ids outside the report (which a caller
 * could simply omit). A finding that disqualifies the candidate is neither a warning
 * nor an optional annotation, so it gets its own section, and the decision layer binds
 * the recorded rejection code to it.
 */
export const PROBE_REPORT_SECTIONS = ["environment", "facts", "risks", "rejectionFindings", "validation"] as const;
export type ProbeReportSection = (typeof PROBE_REPORT_SECTIONS)[number];

export const PROBE_REPORT_SCHEMA_VERSION = 1;
export const SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS: readonly number[] = [1];

export const PROBE_OUTCOMES = ["passed", "failed", "skipped"] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** A single deterministic observation. `value` is data, never a sentence. */
export interface ProbeFact {
  readonly step: ProbeStepId;
  readonly name: string;
  readonly value: string | number | boolean | readonly string[];
}

/**
 * How one step ended — and, when it failed, what actually happened.
 *
 * `diagnostics` is required non-empty on a `failed` outcome so a reviewable
 * record cannot degrade into a boolean. There is intentionally no `error`
 * convenience field of type `boolean`.
 */
export interface ProbeValidationEntry {
  readonly step: ProbeStepId;
  readonly outcome: ProbeOutcome;
  readonly detail: string;
  /** Tool output, chunk names, missing module ids — what makes the failure actionable. */
  readonly diagnostics: readonly string[];
}

/**
 * A derived technical warning, expressed in the signal vocabulary.
 *
 * A risk is filed under its `signal` rather than as free text so it can be
 * checked against the catalogue: only a `risk`-family signal belongs here, and a
 * `replacement`-family finding in this list would be a rejection wearing a
 * warning's clothes. See `validateSignalFindings`.
 */
export interface ProbeRisk {
  readonly signal: SelectionSignalId;
  readonly step: ProbeStepId;
  readonly summary: string;
  readonly evidence: readonly string[];
}

/**
 * A machine-observed finding that disqualifies the candidate for this target.
 *
 * Distinct from a {@link ProbeRisk} on purpose: a risk raises the cost of a candidate
 * and is weighed, whereas this says the artifact cannot reach the target and is what a
 * `replace` decision binds to. The signal must come from the `replacement` family, and
 * its mapped rejection code — `findReplacementSignalRejection` in
 * `selection-signals.ts` — is the code the decision has to carry. That mapping is what
 * turns "the build failed" into "the build failed for *this* reason", which is the
 * difference between evidence and a coincidence.
 */
export interface ProbeRejectionFinding {
  readonly signal: SelectionSignalId;
  readonly step: ProbeStepId;
  readonly summary: string;
  readonly evidence: readonly string[];
}

/**
 * The identity every other section was observed against.
 *
 * `target` is nullable because a static probe can run before a Forguncy runtime
 * is involved, and recording an unobserved target would make a local build look
 * like a runtime check. `source` is a URL or a repository-relative reference —
 * the same portability rule the lock enforces, applied here so a probe report and
 * the lock record that cites it stay reproducible on another machine.
 */
export interface ProbeEnvironment {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly license: string | null;
  readonly source: string | null;
  readonly toolchain: ToolchainIdentity;
  readonly target: ForguncyTargetIdentity | null;
}

/**
 * The engine's output.
 *
 * Note what is absent by construction: there is no strategy, no ownership verdict
 * and no chosen package, because the probe engine is not allowed to produce them
 * ({@link PROBE_ENGINE_NON_RESPONSIBILITIES}).
 */
export interface ProbeReport {
  readonly schemaVersion: number;
  readonly environment: ProbeEnvironment;
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  /**
   * Findings that disqualify the candidate. Present even when every step passed —
   * a size over budget is measured by a step that succeeded.
   */
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: readonly ProbeValidationEntry[];
}

/**
 * Report keys that must never appear, including anywhere nested.
 *
 * A recommendation field would be worse than useless: it would let a caller read
 * a verdict out of the probe output and skip both the Agent's reasoning and the
 * ownership gate. Since a probe is generated and consumed by machines, an
 * unexpected key means the writer had a different contract in mind, so it is
 * reported rather than ignored.
 */
export const FORBIDDEN_PROBE_REPORT_KEYS: readonly string[] = [
  "strategy",
  "recommendation",
  "recommendedStrategy",
  "ownership",
  "owner",
  "replacement",
  "replacementPackage",
  "chosenPackage",
  "selectedPackage",
  "decision",
  "verdict",
];

/** Where a forbidden key was found, as a dotted path. */
export function findForbiddenProbeKeys(value: unknown): readonly string[] {
  const found = new Set<string>();

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (FORBIDDEN_PROBE_REPORT_KEYS.includes(key)) {
        found.add(childPath);
      }
      visit(item, childPath);
    }
  };

  visit(value, "");
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Evidence policy
// ---------------------------------------------------------------------------

/**
 * What counts as a compatibility claim, stated once.
 *
 * The scope is part of the contract, not a footnote. This policy is about a claim that
 * a **package artifact works** in a cell, which is a dependency/compatibility decision.
 * An architectural rejection makes no such claim — it says the *capability* belongs to
 * Forguncy, and its evidence is the #4 ownership decision, which #8 records as
 * `probeRequirement: "none"`. So an architectural rejection is not a decision that
 * "skips" the probe; it is a decision the probe has nothing to say about, and it is
 * listed here as exempt so a consumer reading this exported data cannot infer an
 * unconditional probe requirement and rebuild the bug that the audit had to fix.
 */
export const PROBE_EVIDENCE_POLICY = {
  /** A dependency/compatibility claim may only be made on an executed probe. */
  requiresExecutedProbeForCompatibilityClaims: true,
  /** Evidence profiles this policy does not apply to, and why. */
  exemptEvidenceProfiles: ["architectural-rejection"] as const,
  /** Package documentation is a hypothesis source, never evidence. */
  acceptsDocumentationOnlyEvidence: false,
  /** A risk finding blocks nothing by itself; only a replacement signal rejects. */
  riskFindingsAreRejections: false,
} as const;

/**
 * The properties that make the output consumable by an Agent *and* by CI.
 *
 * CI has no judgement: it can compare and fail, so every property here is written
 * as something a machine can check without interpreting prose.
 */
export const PROBE_REPORT_MACHINE_READABILITY: readonly string[] = [
  "The document is JSON with a declared `schemaVersion`, so a consumer can refuse a shape it does not understand instead of guessing.",
  "Observation and interpretation are separable: `facts` never contains a conclusion, `risks` never contains a rejection, and a finding that disqualifies the candidate lives in `rejectionFindings` where a decision can bind to it.",
  "Every step's outcome is recorded exactly once, so `validation` answers \"which steps actually ran\" without inferring absence.",
  "A failure carries `diagnostics`, so a report can be acted on and re-reviewed without re-running the probe.",
  "Findings reference catalogue signal ids rather than free text, so a consumer can map a finding to a policy.",
  "Serialization is canonical: identical probe inputs produce identical bytes, so a diff means the candidate changed.",
];

// ---------------------------------------------------------------------------
// Deployment support
// ---------------------------------------------------------------------------

/**
 * The steps that must have **passed** before a strategy claiming the candidate
 * works (`host`, `inline`, `extension`) may be recorded.
 *
 * "At least one step passed" is far too weak to gate that claim: a report where
 * `package-identity` passed and `build` failed is a description of a candidate that
 * does not work, and it must not support `inline`. The eight steps below are the
 * ones whose failure means the artifact cannot be deployed at all.
 *
 * `runtime-smoke` is deliberately excluded. #16 asks for a runtime/browser result
 * "where needed", so a report is not incomplete without one, and requiring it would
 * make the static path unusable in a toolchain with no browser available.
 */
export const PROBE_DEPLOYMENT_REQUIRED_STEPS: readonly ProbeStepId[] = [
  "package-identity",
  "export-metadata",
  "node-builtin-scan",
  "build",
  "artifact-scan",
  "asset-inventory",
  "runtime-pattern-scan",
  "size",
];

export const PROBE_ASSESSMENT_STATUSES = ["supports-deployment", "supports-rejection-only", "inconclusive"] as const;
export type ProbeAssessmentStatus = (typeof PROBE_ASSESSMENT_STATUSES)[number];

export interface ProbeAssessment {
  /**
   * - `supports-deployment` — every deployment-required step passed and nothing
   *   disqualifying was observed.
   * - `supports-rejection-only` — something failed, or a rejection finding was
   *   observed, so the report can justify refusing the candidate but never accepting
   *   it.
   * - `inconclusive` — required steps were skipped and nothing failed, so the
   *   report neither shows the candidate working nor shows why it cannot.
   */
  readonly status: ProbeAssessmentStatus;
  /** Deployment-required steps that did not pass, in canonical step order. */
  readonly blockingSteps: readonly ProbeStepId[];
  /** Every failed step — possible rejection evidence, never a reason by itself. */
  readonly failedSteps: readonly ProbeStepId[];
  /** Risk findings a decision has to weigh, in canonical order. */
  readonly risksToWeigh: readonly ProbeRisk[];
  /**
   * Machine-observed findings that disqualify the candidate, in canonical order.
   *
   * A `replace` decision binds its rejection code to these. `failedSteps` alone is
   * not enough: a failure says the candidate cannot be accepted, not *why* it is
   * rejected, and the two are different claims.
   */
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly reason: string;
}

/**
 * What a report is actually able to support.
 *
 * This is the predicate the decision layer consumes, so that "the probe passed" is
 * never again reducible to "some step did not throw". Three outcomes, because the
 * middle case is the one a boolean loses: a candidate that failed to build is not
 * unusable *evidence* — it is evidence against deploying and in favour of
 * `replace`, which is a different conclusion from "we could not find out".
 *
 * A rejection finding counts even when every step passed, because the step that
 * reports a disqualifying property usually *succeeds* at reporting it: measuring an
 * artifact over budget is a successful `size` step.
 */
export function assessProbeReport(report: ProbeReport): ProbeAssessment {
  const outcomeOf = (step: ProbeStepId): ProbeOutcome | undefined =>
    report.validation.find(entry => entry.step === step)?.outcome;

  const canonical = canonicalizeProbeReport(report);
  const failedSteps = PROBE_STEP_IDS.filter(step => outcomeOf(step) === "failed");
  const blockingSteps = PROBE_DEPLOYMENT_REQUIRED_STEPS.filter(step => outcomeOf(step) !== "passed");
  const risksToWeigh = canonical.risks;
  const rejectionFindings = canonical.rejectionFindings;

  if (blockingSteps.length === 0 && rejectionFindings.length === 0) {
    return {
      status: "supports-deployment",
      blockingSteps,
      failedSteps,
      risksToWeigh,
      rejectionFindings,
      reason: `Every step a deployment depends on passed (${PROBE_DEPLOYMENT_REQUIRED_STEPS.length} steps), and no finding disqualifies the candidate.${
        risksToWeigh.length > 0
          ? ` ${String(risksToWeigh.length)} risk finding(s) still have to be weighed against the alternatives.`
          : ""
      }`,
    };
  }

  const reasons: string[] = [];
  if (failedSteps.length > 0) {
    reasons.push(`"${failedSteps.join(", ")}" failed`);
  }
  if (rejectionFindings.length > 0) {
    reasons.push(
      `${rejectionFindings.length} rejection finding(s) were observed (${rejectionFindings.map(finding => finding.signal).join(", ")})`,
    );
  }

  if (reasons.length > 0) {
    return {
      status: "supports-rejection-only",
      blockingSteps,
      failedSteps,
      risksToWeigh,
      rejectionFindings,
      reason: `${reasons.join(", and ")}. This report cannot support a strategy that claims the candidate works; a rejection has to cite the finding that disqualifies it, not merely the absence of success.`,
    };
  }

  return {
    status: "inconclusive",
    blockingSteps,
    failedSteps,
    risksToWeigh,
    rejectionFindings,
    reason: `"${blockingSteps.join(", ")}" were neither passed nor failed, so the report neither shows the candidate working nor shows why it cannot. Run the missing steps before deciding.`,
  };
}

/** True only when nothing that blocks deployment is unaccounted for. */
export function probeSupportsDeployment(report: ProbeReport): boolean {
  return assessProbeReport(report).status === "supports-deployment";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProbeReportSchemaVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(
      `Probe report declares unsupported schema version ${String(schemaVersion)}; this toolchain supports ${SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS.join(", ")}.`,
    );
    this.name = "ProbeReportSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

export class ProbeReportValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid probe report:\n- ${problems.join("\n- ")}`);
    this.name = "ProbeReportValidationError";
    this.problems = problems;
  }
}

export function isSupportedProbeReportSchemaVersion(version: unknown): version is number {
  return typeof version === "number" && SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS.includes(version);
}

export function assertSupportedProbeReportSchemaVersion(version: number): void {
  if (!isSupportedProbeReportSchemaVersion(version)) {
    throw new ProbeReportSchemaVersionError(version);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectFact(fact: unknown, where: string): readonly string[] {
  if (!isPlainObject(fact)) {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  problems.push(...inspectStep(fact.step, where));
  if (typeof fact.name !== "string" || fact.name.trim().length === 0) {
    problems.push(`${where} must name the observation.`);
  }
  const { value } = fact;
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      problems.push(`${where} must record a non-empty value, or omit the fact.`);
    }
  } else if (Array.isArray(value)) {
    if (value.some(item => typeof item !== "string")) {
      problems.push(`${where} must record \`value\` as an array of strings.`);
    }
  } else if (typeof value !== "number" && typeof value !== "boolean") {
    problems.push(`${where} must record \`value\` as a string, number, boolean or array of strings.`);
  }
  return problems;
}

function inspectStep(step: unknown, where: string): readonly string[] {
  return isProbeStepId(step) ? [] : [`${where} must name a known probe step.`];
}

function inspectValidationEntry(entry: unknown, where: string): readonly string[] {
  if (!isPlainObject(entry)) {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  problems.push(...inspectStep(entry.step, where));
  if (typeof entry.outcome !== "string" || !(PROBE_OUTCOMES as readonly string[]).includes(entry.outcome)) {
    problems.push(`${where} must record an outcome of ${PROBE_OUTCOMES.join(", ")}.`);
  }
  if (typeof entry.detail !== "string") {
    problems.push(`${where} must record \`detail\` as a string.`);
  }
  if (!Array.isArray(entry.diagnostics) || entry.diagnostics.some(item => typeof item !== "string")) {
    problems.push(`${where} must record \`diagnostics\` as an array of strings.`);
  }
  return problems;
}

/** Shared by risks and rejection findings — same shape, different family. */
function inspectFinding(finding: unknown, where: string): readonly string[] {
  if (!isPlainObject(finding)) {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  if (typeof finding.signal !== "string") {
    problems.push(`${where} must name the selection signal the finding belongs to.`);
  }
  problems.push(...inspectStep(finding.step, where));
  if (typeof finding.summary !== "string" || finding.summary.trim().length === 0) {
    problems.push(`${where} must summarise the finding.`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.some(item => typeof item !== "string")) {
    problems.push(`${where} must record \`evidence\` as an array of strings.`);
  }
  return problems;
}

function inspectEnvironment(environment: unknown, where: string): readonly string[] {
  if (!isPlainObject(environment)) {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  for (const field of ["packageName", "packageVersion"]) {
    if (typeof environment[field] !== "string" || (environment[field] as string).trim().length === 0) {
      problems.push(`${where} must declare \`${field}\`.`);
    }
  }
  for (const field of ["license", "source"]) {
    const value = environment[field];
    if (value !== null && typeof value !== "string") {
      problems.push(`${where} must declare \`${field}\` as a string or null.`);
    }
  }
  if (!isPlainObject(environment.toolchain)) {
    problems.push(`${where} must record the toolchain the probe ran under.`);
  } else if (typeof environment.toolchain.vitePlus !== "string" && environment.toolchain.vitePlus !== null) {
    problems.push(`${where}.toolchain must declare \`vitePlus\` as a string or null.`);
  }
  if (environment.target !== null) {
    if (!isPlainObject(environment.target)) {
      problems.push(`${where} must declare \`target\` as an object or null.`);
    } else {
      for (const field of ["product", "productVersion", "productBuild", "hostReactVersion"]) {
        if (typeof environment.target[field] !== "string" || (environment.target[field] as string).trim().length === 0) {
          problems.push(`${where}.target must declare \`${field}\`.`);
        }
      }
    }
  }
  return problems;
}

/**
 * Structural problems with untrusted input, before any typed access.
 *
 * Shape first and shape alone, for the same reason the lock parser does it: the
 * rules below read typed fields, and running them over a document that is not that
 * shape is how a `.trim()` on `undefined` escapes as a `TypeError`.
 */
export function inspectProbeReport(input: unknown): readonly string[] {
  if (!isPlainObject(input)) {
    return ["A probe report must contain a JSON object."];
  }

  const problems: string[] = [];

  if (typeof input.schemaVersion !== "number") {
    problems.push("A probe report must declare a numeric `schemaVersion`.");
  } else if (!isSupportedProbeReportSchemaVersion(input.schemaVersion)) {
    problems.push(
      `Unsupported schema version ${input.schemaVersion}; this toolchain supports ${SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  problems.push(...inspectEnvironment(input.environment, "environment"));

  for (const section of ["facts", "risks", "rejectionFindings", "validation"] as const) {
    if (!Array.isArray(input[section])) {
      problems.push(`A probe report must declare a \`${section}\` array.`);
    }
  }

  if (Array.isArray(input.facts)) {
    input.facts.forEach((fact, index) => {
      problems.push(...inspectFact(fact, `facts[${index}]`));
    });
  }
  if (Array.isArray(input.risks)) {
    input.risks.forEach((risk, index) => {
      problems.push(...inspectFinding(risk, `risks[${index}]`));
    });
  }
  if (Array.isArray(input.rejectionFindings)) {
    input.rejectionFindings.forEach((finding, index) => {
      problems.push(...inspectFinding(finding, `rejectionFindings[${index}]`));
    });
  }
  if (Array.isArray(input.validation)) {
    input.validation.forEach((entry, index) => {
      problems.push(...inspectValidationEntry(entry, `validation[${index}]`));
    });
  }

  return problems;
}

/**
 * The report's own contract, on top of its shape.
 *
 * The rules are the ones a consumer would otherwise have to re-derive: the report
 * describes one artifact, every step is accounted for, a failure is actionable,
 * findings are filed in the right bucket, and the engine did not decide anything.
 */
export function validateProbeReport(report: ProbeReport): readonly string[] {
  const structural = inspectProbeReport(report);
  if (structural.length > 0) {
    return structural;
  }
  return validateProbeReportRules(report);
}

function validateProbeReportRules(report: ProbeReport): readonly string[] {
  const problems: string[] = [];
  const { environment, facts, risks, rejectionFindings, validation } = report;

  if (!isSupportedProbeReportSchemaVersion(report.schemaVersion)) {
    problems.push(
      `Unsupported schema version ${String(report.schemaVersion)}; this toolchain supports ${SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  if (environment.source !== null && !isEvidenceReference(environment.source)) {
    problems.push(
      `environment.source "${environment.source}" is neither an http(s) URL nor a repository-relative path. A machine-specific path makes the report unreproducible on another machine and in CI.`,
    );
  }

  if (facts.length === 0) {
    problems.push(
      "The report records no facts, so it is not evidence of anything. Record what the steps observed, or report the run as not performed rather than as a report with no observations.",
    );
  }

  // Every step exactly once: `skipped` is the way to say a step did not run, so a
  // missing entry means the report does not answer "which steps actually ran" —
  // and absence would then be indistinguishable from a step nobody thought about.
  const seen = new Map<ProbeStepId, number>();
  for (const entry of validation) {
    seen.set(entry.step, (seen.get(entry.step) ?? 0) + 1);
  }
  for (const stepId of PROBE_STEP_IDS) {
    const count = seen.get(stepId) ?? 0;
    if (count === 0) {
      problems.push(
        `validation records no outcome for step "${stepId}". Record it as "skipped" with a reason when it was not run, so the report states which steps actually ran instead of leaving it to be inferred.`,
      );
    } else if (count > 1) {
      problems.push(`validation records step "${stepId}" ${count} times; a step has one outcome per run.`);
    }
  }
  for (const [stepId] of seen) {
    if (!isProbeStepId(stepId)) {
      problems.push(`validation records an outcome for unknown step "${String(stepId)}".`);
    }
  }

  validation.forEach((entry, index) => {
    const where = `validation[${index}] ("${entry.step}")`;
    if (entry.outcome === "failed" && entry.diagnostics.length === 0) {
      problems.push(
        `${where} failed without diagnostics. A failed step has to carry actionable evidence — the tool output, the unresolved module id, the offending chunk — because "failed: true" cannot be acted on and cannot be re-reviewed later.`,
      );
    }
    if (entry.outcome === "failed" && entry.detail.trim().length === 0) {
      problems.push(`${where} failed without stating what happened.`);
    }
    if (entry.outcome === "skipped" && entry.detail.trim().length === 0) {
      problems.push(`${where} was skipped without a reason, which makes the gap in coverage unreadable.`);
    }
    if (entry.outcome !== "failed" && entry.diagnostics.length > 0) {
      problems.push(
        `${where} is "${entry.outcome}" but carries diagnostics. Diagnostics belong to a failure; keeping them on a passing step blurs what was observed from what went wrong.`,
      );
    }
  });

  // Delegated to the signal catalogue so the "a risk is not a rejection" rule has
  // one implementation, and a replacement-family finding filed here is refused
  // rather than silently treated as a warning.
  for (const problem of validateSignalFindings(risks, "risk")) {
    problems.push(problem);
  }

  // And the mirror image: a `risk`-family signal in the rejection bucket would be a
  // warning promoted into a refusal.
  for (const problem of validateSignalFindings(rejectionFindings, "replacement")) {
    problems.push(problem);
  }

  const validateFindings = (
    findings: readonly { readonly signal: string; readonly step: ProbeStepId; readonly evidence: readonly string[] }[],
    bucket: "risks" | "rejectionFindings",
  ): void => {
    findings.forEach((finding, index) => {
      const where = `${bucket}[${index}] ("${finding.signal}")`;

      if (finding.evidence.length === 0) {
        problems.push(`${where} records no evidence, so the finding is an assertion rather than an observation.`);
      }

      // A finding has to come from a step that ran. This is the rule that keeps the
      // report honest: without it an engine could carry a suspicion it never tested
      // and present it next to measurements, and a consumer could not tell them apart.
      if (validation.find(entry => entry.step === finding.step)?.outcome === "skipped") {
        problems.push(
          `${where} is attributed to step "${finding.step}", which the report records as skipped. A finding cannot come from a step that did not run; run the step, or drop the finding.`,
        );
      }

      const descriptor = findSelectionSignal(finding.signal);
      if (!descriptor) {
        // Already reported by `validateSignalFindings`; the channel is unknowable.
        return;
      }

      // …and from a step that can *see* it. Running is not observing.
      const observingSteps = probeStepsForChannel(descriptor.observedFrom);
      if (!observingSteps.includes(finding.step)) {
        problems.push(
          `${where} claims a "${descriptor.observedFrom}" observation, which step "${finding.step}" cannot make. Steps that observe "${descriptor.observedFrom}": ${
            observingSteps.length > 0 ? observingSteps.join(", ") : "none"
          }. A finding has to be produced by the step that can see it, not merely by a step that ran.`,
        );
      }

      // A runtime observation names the runtime it was made against. Otherwise the
      // report asserts host behaviour while leaving out which host, which is not
      // re-checkable and cannot be invalidated when the target moves.
      if (descriptor.observedFrom === "runtime-observation" && environment.target === null) {
        problems.push(
          `${where} is a runtime observation, but the report names no Forguncy target. Observing runtime behaviour without recording which runtime makes the finding unverifiable; set environment.target, or record the finding against the step that observes it statically.`,
        );
      }
    });
  };

  validateFindings(risks, "risks");
  validateFindings(rejectionFindings, "rejectionFindings");

  const forbidden = findForbiddenProbeKeys(report);
  if (forbidden.length > 0) {
    problems.push(
      `A probe report must not carry a decision: found ${forbidden.join(", ")}. Ownership classification, the choice of a replacement and the choice of deployment strategy belong to the Agent, so the engine's output has no field for them.`,
    );
  }

  return problems;
}

export function assertProbeReport(report: ProbeReport): void {
  const problems = validateProbeReport(report);
  if (problems.length > 0) {
    throw new ProbeReportValidationError(problems);
  }
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * Code-unit comparison, deliberately not `localeCompare`: a report that sorts
 * differently depending on the reviewer's locale would serialize differently on
 * two machines, which defeats the determinism the report is cached on.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Field order for the serialized document, mirroring the lock's approach: the
 * listed keys come first so a report reads as environment → observations →
 * findings → what ran, and anything unlisted falls in afterwards alphabetically so
 * a future field stays deterministic without an edit here.
 */
const PROBE_KEY_ORDER: readonly string[] = [
  "schemaVersion",
  "environment",
  "facts",
  "risks",
  "validation",
  "packageName",
  "packageVersion",
  "license",
  "source",
  "toolchain",
  "target",
  "vitePlus",
  "product",
  "productVersion",
  "productBuild",
  "hostReactVersion",
  "step",
  "name",
  "value",
  "signal",
  "summary",
  "evidence",
  "outcome",
  "detail",
  "diagnostics",
];

function compareCanonicalKeys(a: string, b: string): number {
  const rankA = PROBE_KEY_ORDER.indexOf(a);
  const rankB = PROBE_KEY_ORDER.indexOf(b);
  if (rankA !== rankB) {
    return (rankA === -1 ? PROBE_KEY_ORDER.length : rankA) - (rankB === -1 ? PROBE_KEY_ORDER.length : rankB);
  }
  return compareStrings(a, b);
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCanonicalKeys)) {
      const child = canonicalizeValue(source[key]);
      if (child !== undefined) {
        result[key] = child;
      }
    }
    return result;
  }
  return value;
}

/**
 * Set-like arrays are sorted, because an inventory is a set.
 *
 * A fact whose value is a list of unresolved module ids, or a risk whose evidence is
 * a list of chunk names, carries no meaning in its discovery order. Leaving those
 * arrays as found is what breaks the determinism the canonical form claims: the same
 * report built by a scanner that walked the same files in a different order would
 * serialize differently. A list whose order *is* meaningful belongs in separate
 * facts, where the order is expressed by the fact names.
 */
function canonicalizeArrayValues(value: readonly string[]): readonly string[] {
  return [...value].sort(compareStrings);
}

function canonicalizeFact(fact: ProbeFact): ProbeFact {
  return {
    step: fact.step,
    name: fact.name,
    value: Array.isArray(fact.value) ? canonicalizeArrayValues(fact.value as readonly string[]) : fact.value,
  };
}

function canonicalizeRisk(risk: ProbeRisk): ProbeRisk {
  return {
    signal: risk.signal,
    step: risk.step,
    summary: risk.summary,
    evidence: canonicalizeArrayValues(risk.evidence),
  };
}

function canonicalizeRejectionFinding(finding: ProbeRejectionFinding): ProbeRejectionFinding {
  return {
    signal: finding.signal,
    step: finding.step,
    summary: finding.summary,
    evidence: canonicalizeArrayValues(finding.evidence),
  };
}

/** Risks and rejection findings share a shape; only their signal family differs. */
type AnyFinding = ProbeRisk | ProbeRejectionFinding;

function compareFacts(a: ProbeFact, b: ProbeFact): number {
  return (
    probeStepOrder(a.step) - probeStepOrder(b.step) ||
    compareStrings(a.name, b.name) ||
    compareStrings(JSON.stringify(canonicalizeValue(a)), JSON.stringify(canonicalizeValue(b)))
  );
}

function compareFindings(a: AnyFinding, b: AnyFinding): number {
  return (
    compareStrings(a.signal, b.signal) ||
    probeStepOrder(a.step) - probeStepOrder(b.step) ||
    compareStrings(JSON.stringify(canonicalizeValue(a)), JSON.stringify(canonicalizeValue(b)))
  );
}

function compareValidationEntries(a: ProbeValidationEntry, b: ProbeValidationEntry): number {
  return probeStepOrder(a.step) - probeStepOrder(b.step) || compareStrings(a.step, b.step);
}

/**
 * The canonical report: validation in step order, facts and risks in a *total* order
 * derived from their own content.
 *
 * Two properties are needed, not one:
 *
 * - **Content ordering.** A diff has to mean the candidate changed, so discovery
 *   order must not survive into the document.
 * - **Totality.** Comparing only the primary key (`step` + `name`, `signal` + `step`)
 *   leaves ties, and a stable sort resolves ties by keeping discovery order — which
 *   is the very thing this function exists to remove. Two findings that share a key
 *   but differ in value or evidence are therefore ordered by their full canonical
 *   content as well.
 *
 * `validation` needs no content tiebreak beyond the step name, because
 * `validateProbeReport` has already required one entry per step.
 */
export function canonicalizeProbeReport(report: ProbeReport): ProbeReport {
  return {
    schemaVersion: report.schemaVersion,
    environment: report.environment,
    facts: report.facts.map(canonicalizeFact).sort(compareFacts),
    risks: report.risks.map(canonicalizeRisk).sort(compareFindings),
    rejectionFindings: report.rejectionFindings.map(canonicalizeRejectionFinding).sort(compareFindings),
    validation: [...report.validation].sort(compareValidationEntries),
  };
}

export function serializeProbeReport(report: ProbeReport, options: { readonly indent?: number } = {}): string {
  const canonical = canonicalizeValue(canonicalizeProbeReport(report));
  return `${JSON.stringify(canonical, null, options.indent ?? 2)}\n`;
}

/**
 * Parse a report's text into a validated document.
 *
 * An unsupported `schemaVersion` fails with its own error type before anything
 * else, so a consumer that knows how to migrate can catch it specifically and the
 * read path never guesses at a shape it does not understand.
 */
export function parseProbeReport(text: string): ProbeReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProbeReportValidationError([`Probe report is not valid JSON: ${(error as Error).message}`]);
  }

  if (isPlainObject(parsed) && typeof parsed.schemaVersion === "number") {
    assertSupportedProbeReportSchemaVersion(parsed.schemaVersion);
  }

  const structural = inspectProbeReport(parsed);
  if (structural.length > 0) {
    throw new ProbeReportValidationError(structural);
  }

  const report = parsed as ProbeReport;
  assertProbeReport(report);
  return report;
}

/** The steps that actually ran, as opposed to the steps the report accounts for. */
export function executedProbeSteps(report: ProbeReport): readonly ProbeStepId[] {
  return PROBE_STEP_IDS.filter(
    id => report.validation.find(entry => entry.step === id)?.outcome === "passed",
  );
}

/**
 * Whether any step passed at all — an informational rollup, **not** a gate.
 *
 * Deliberately not the predicate the decision layer uses: "at least one step passed"
 * is satisfied by a report whose only passing step is `package-identity`, which is a
 * statement about a package name rather than about whether a candidate works. Gate on
 * {@link assessProbeReport} instead — that is what `probeSupportsStrategy` in
 * `selection-policy.ts` consumes.
 */
export function hasPassingEvidence(report: ProbeReport): boolean {
  return report.validation.some(entry => entry.outcome === "passed");
}

/** The risks a decision has to account for, in canonical order. */
export function probeRisksOf(report: ProbeReport): readonly ProbeRisk[] {
  return canonicalizeProbeReport(report).risks;
}
