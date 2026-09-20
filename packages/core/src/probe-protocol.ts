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
 * Boundary with #17: #16 owns the *shape contract* — the steps, the four report
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
import type { SelectionSignalId } from "./selection-signals";
import { validateSignalFindings } from "./selection-signals";

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
 * The four sections, in the order a report reads.
 *
 * The separation is the contract #16 asks for: `facts` are deterministic
 * observations, `risks` are derived technical warnings, `validation` is which
 * steps actually ran and how they ended, and `environment` is the identity of
 * everything the other three were observed against. Folding them together would
 * make "what did we measure" and "what does it mean" the same field, which is how
 * a warning becomes a verdict.
 */
export const PROBE_REPORT_SECTIONS = ["environment", "facts", "risks", "validation"] as const;
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
 * #16 rule 4 rejects README inspection as a basis for a compatibility claim, and
 * the reason is contained here rather than restated per call site: prose describes
 * the intent of a release, while the failure modes that actually break a cell —
 * an AMD branch taken at runtime, a sibling chunk, a WASM asset — are invisible
 * until something is built and executed.
 */
export const PROBE_EVIDENCE_POLICY = {
  /** A strategy may only be chosen on the strength of an executed probe. */
  requiresExecutedProbe: true,
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
  "Observation and interpretation are separable: `facts` never contains a conclusion, `risks` never contains a rejection.",
  "Every step's outcome is recorded exactly once, so `validation` answers \"which steps actually ran\" without inferring absence.",
  "A failure carries `diagnostics`, so a report can be acted on and re-reviewed without re-running the probe.",
  "Findings reference catalogue signal ids rather than free text, so a consumer can map a finding to a policy.",
  "Serialization is canonical: identical probe inputs produce identical bytes, so a diff means the candidate changed.",
];

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

function inspectRisk(risk: unknown, where: string): readonly string[] {
  if (!isPlainObject(risk)) {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  if (typeof risk.signal !== "string") {
    problems.push(`${where} must name the selection signal the finding belongs to.`);
  }
  problems.push(...inspectStep(risk.step, where));
  if (typeof risk.summary !== "string" || risk.summary.trim().length === 0) {
    problems.push(`${where} must summarise the finding.`);
  }
  if (!Array.isArray(risk.evidence) || risk.evidence.some(item => typeof item !== "string")) {
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

  for (const section of ["facts", "risks", "validation"] as const) {
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
      problems.push(...inspectRisk(risk, `risks[${index}]`));
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
  const { environment, facts, risks, validation } = report;

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

  risks.forEach((risk, index) => {
    const where = `risks[${index}] ("${risk.signal}")`;
    if (risk.evidence.length === 0) {
      problems.push(`${where} records no evidence, so the finding is an assertion rather than an observation.`);
    }
    // A finding has to come from a step that ran. This is the rule that keeps the
    // report honest: without it an engine could carry a suspicion it never tested
    // and present it next to measurements, and a consumer could not tell them
    // apart.
    const outcome = validation.find(entry => entry.step === risk.step)?.outcome;
    if (outcome === "skipped") {
      problems.push(
        `${where} is attributed to step "${risk.step}", which the report records as skipped. A finding cannot come from a step that did not run; run the step, or drop the finding.`,
      );
    }
  });

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
 * The canonical report: validation in step order, facts and risks in a stable
 * order derived from their own content.
 *
 * Sorting by content rather than preserving discovery order matters because an
 * engine that scans files in a different order must not produce a diff — the diff
 * has to mean the candidate changed.
 */
export function canonicalizeProbeReport(report: ProbeReport): ProbeReport {
  return {
    schemaVersion: report.schemaVersion,
    environment: report.environment,
    facts: [...report.facts].sort(
      (a, b) => probeStepOrder(a.step) - probeStepOrder(b.step) || compareStrings(a.name, b.name),
    ),
    risks: [...report.risks].sort(
      (a, b) => compareStrings(a.signal, b.signal) || probeStepOrder(a.step) - probeStepOrder(b.step),
    ),
    validation: [...report.validation].sort((a, b) => probeStepOrder(a.step) - probeStepOrder(b.step)),
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

/** True when at least one step passed, i.e. the report observed something working. */
export function hasPassingEvidence(report: ProbeReport): boolean {
  return report.validation.some(entry => entry.outcome === "passed");
}

/** The risks a decision has to account for, in canonical order. */
export function probeRisksOf(report: ProbeReport): readonly ProbeRisk[] {
  return canonicalizeProbeReport(report).risks;
}
