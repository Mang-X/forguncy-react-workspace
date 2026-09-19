/**
 * The project-local dependency decision lock, `fgc.lock.json` — the model.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`". Governing architecture Specs: #4, which defines the four
 * strategies, and #5, which is where the Forguncy target a runtime claim is about
 * was converted into observed facts.
 *
 * Why the lock exists: npm compatibility cannot be captured by a hand-maintained
 * adapter registry, and letting an Agent re-decide every package on every run is
 * not reproducible. The lock is the middle path — a reviewable record of
 * decisions already made for *this* project.
 *
 * What this module is: the document shape, what each record has to carry, the
 * per-profile evidence policy, and the canonical form. It owns no filesystem and
 * no evaluation — reading and writing the file is `dependency-resolver`'s job,
 * and deciding whether a record is still usable is `lock-freshness.ts`.
 *
 * Two properties are load-bearing for review:
 *
 * - **Determinism.** Canonical ordering, a fixed key order and no timestamps mean
 *   identical decisions produce identical bytes, so a real strategy change is the
 *   only thing that shows up as a diff.
 * - **Portability.** Every recorded reference is a URL or a repository-relative
 *   path, and an absolute machine path *anywhere* in the document — including
 *   inside a fingerprint — is a validation failure rather than a style nit: it
 *   makes the decision unreproducible on another machine and in CI.
 */

import type { ArchitectureDecisionSource } from "./governance";
import {
  citesDecision,
  DEPENDENCY_LOCK_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
} from "./governance";
import type { RuntimeContractTarget } from "./runtime-contract";
import { RUNTIME_CONTRACT_TARGET } from "./runtime-contract";
import type { DependencyDecision, DependencyStrategy } from "./strategy";
import { requiresRealRuntimeValidation, strategySemantics, validateDependencyDecisionShape } from "./strategy";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to this module has to cite: the architecture decisions
 * first, then the lock Spec built on them.
 *
 * Composed from the records `core` owns rather than from a second copy of them,
 * so a consumer has one place to look and the two lists cannot drift.
 */
export const LOCK_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  DEPENDENCY_LOCK_DECISION,
];

/** The line a PR body, plan or report describing this model carries. */
export const LOCK_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(LOCK_GOVERNING_DECISIONS);

export const FGC_LOCK_FILE_NAME = "fgc.lock.json";

/**
 * Bumped whenever the on-disk shape changes incompatibly. An unknown version is
 * an explicit failure rather than a best-effort read: silently accepting a
 * future document would let a newer tool's decisions go unvalidated here.
 */
export const FGC_LOCK_SCHEMA_VERSION = 1;

export const SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS: readonly number[] = [1];

// ---------------------------------------------------------------------------
// Target identity (#5)
// ---------------------------------------------------------------------------

/**
 * The Forguncy identity a runtime claim is about.
 *
 * Derived from the verified target contract (#5) instead of being declared
 * afresh, because a lock that can name "Forguncy 12" in its own vocabulary will
 * eventually name a version the contract probe never measured.
 *
 * `hostReactVersion` is part of the identity because a `host` decision is a claim
 * about the global a specific product build injects: whether the mapped module
 * still has the identity and peer range the cell expects is decided by the host
 * React version, not by the product version string alone.
 */
export interface ForguncyTargetIdentity {
  readonly product: string;
  readonly productVersion: string;
  readonly productBuild: string;
  readonly hostReactVersion: string;
}

export function forguncyTargetIdentity(
  target: RuntimeContractTarget = RUNTIME_CONTRACT_TARGET,
): ForguncyTargetIdentity {
  return {
    product: target.product,
    productVersion: target.productVersion,
    productBuild: target.productBuild,
    hostReactVersion: target.hostReactVersion,
  };
}

/**
 * Field-by-field comparison, deliberately not object identity: a lock record is
 * deserialized from JSON and can never share an object with the live contract.
 */
export function matchesForguncyTargetIdentity(
  recorded: ForguncyTargetIdentity,
  current: ForguncyTargetIdentity,
): boolean {
  return (
    recorded.product === current.product &&
    recorded.productVersion === current.productVersion &&
    recorded.productBuild === current.productBuild &&
    recorded.hostReactVersion === current.hostReactVersion
  );
}

/** The toolchain that produced a record's technical evidence. */
export interface ToolchainIdentity {
  /** Vite+ version, e.g. `0.3.2`. */
  readonly vitePlus: string | null;
}

// ---------------------------------------------------------------------------
// Probe evidence
// ---------------------------------------------------------------------------

export const PROBE_STATUSES = ["not-run", "passed", "failed"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

/**
 * Probe evidence, recorded as inputs rather than as a timestamp.
 *
 * A `Date` would make the lock non-deterministic and would still not answer the
 * question that matters ("was the probe run against the thing we have now?"), so
 * freshness is computed from the fingerprint and the recorded identities.
 */
export interface LockProbeEvidence {
  readonly status: ProbeStatus;
  /**
   * Identity of the probe's declared inputs — entry, probe id, resolved version,
   * toolchain, target.
   *
   * The contract is that this value is a deterministic function of those inputs
   * and can therefore be *recomputed without re-running the probe*. That is what
   * lets `LockEnvironment.currentProbeFingerprint` be compared against it, and
   * why an entry, probe configuration or bundler input change is detectable
   * even when every version in the record still matches.
   *
   * Composing the value is the probe engine's job (#17); this module only
   * requires that both sides compose it the same way. Required once a probe has
   * run, null while `status` is `not-run`.
   */
  readonly fingerprint: string | null;
  /**
   * Rule 2 of #8: set `true` only when the probe was *explicitly shown* to be
   * version-independent. Otherwise an exact package version change invalidates
   * this evidence rather than being assumed harmless.
   */
  readonly versionIndependent: boolean;
}

// ---------------------------------------------------------------------------
// Evidence links
// ---------------------------------------------------------------------------

export const DECISION_EVIDENCE_KINDS = ["spec-issue", "probe", "pull-request", "runtime-observation"] as const;
export type DecisionEvidenceKind = (typeof DECISION_EVIDENCE_KINDS)[number];

/**
 * A link to the evidence a decision rests on.
 *
 * #8's acceptance criteria require a strategy change to link to probe/decision
 * evidence. A link is a URL or a repository-relative path — see
 * `isEvidenceReference`.
 */
export interface DecisionEvidenceLink {
  readonly kind: DecisionEvidenceKind;
  readonly reference: string;
}

// ---------------------------------------------------------------------------
// Profile-specific evidence
// ---------------------------------------------------------------------------

/**
 * Which of the four strategies an `extension` record was validated against.
 *
 * Only the parts the decision itself does not already carry: `libraryId` and
 * `globalName` live on `ExtensionDependencyDecision`, so repeating them here
 * would create two sources of truth in one record.
 */
export interface ExtensionEvidence {
  /** Extension package version, when one is knowable. */
  readonly version: string | null;
  /**
   * Content identity when a version is not authoritative (a packaged upload, or a
   * ref in the extension repository). Never a machine path.
   */
  readonly identity: string | null;
}

/**
 * The exact candidate a *technical* rejection is about.
 *
 * Recorded because a bundling failure is a property of one artifact: without the
 * version, "this package cannot be inlined" silently becomes a permanent verdict
 * that survives every upgrade that might have fixed it. An architectural
 * rejection needs none of this — the capability belongs to Forguncy whatever
 * version the package is.
 */
export interface RejectedCandidateEvidence {
  readonly version: string;
}

export interface LockRecordMetadata {
  /**
   * Cell target the decision applies to, or null when it applies to every target.
   *
   * Present because #4 defines a strategy as a decision per (package, cell
   * target) pair, not as a property of the package: the same package can
   * legitimately be `inline` in one cell and `host`-mapped in another. Nullable
   * so the lock stays usable before Cell target declarations land (#26).
   */
  readonly cellTarget: string | null;
  /**
   * Exact resolved version of the package in this workspace.
   *
   * Null for every `replace` record, which by rule 4 of #8 keeps no dependency:
   * recording a version there would imply the package is still installed for the
   * cell. A technical rejection records the candidate it rejected in
   * `rejectedCandidate` instead.
   */
  readonly resolvedVersion: string | null;
  readonly probe: LockProbeEvidence;
  /**
   * Non-null only when runtime compatibility was validated against a known
   * Forguncy identity. Its presence *is* the record's runtime claim, and
   * validation ties it to a passing probe so the claim cannot be made from a
   * probe that failed or never ran.
   */
  readonly target: ForguncyTargetIdentity | null;
  /** Toolchain used for the technical probe, when material. */
  readonly probedWith: ToolchainIdentity | null;
  /** `extension` records only; null for every other strategy. */
  readonly extension: ExtensionEvidence | null;
  /** Technical rejections only; null everywhere else. */
  readonly rejectedCandidate: RejectedCandidateEvidence | null;
  /**
   * Why this strategy, required exactly when #4's semantics require a written
   * justification (`extension`, `replace`) and null otherwise.
   */
  readonly rationale: string | null;
  /** Never empty: a decision with no evidence is a decision nobody can re-check. */
  readonly evidence: readonly DecisionEvidenceLink[];
}

/**
 * A lock record: a dependency decision (#4) plus the provenance that lets it be
 * invalidated (#8).
 *
 * Intersected rather than re-declared on purpose — the lock cannot drift from
 * the decision model, and `validateDependencyDecisionShape` applies unchanged.
 */
export type LockedDependencyDecision = DependencyDecision & LockRecordMetadata;

export interface FgcLockDocument {
  readonly schemaVersion: number;
  readonly decisions: readonly LockedDependencyDecision[];
}

export function createEmptyFgcLock(): FgcLockDocument {
  return { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [] };
}

// ---------------------------------------------------------------------------
// Evidence policy (#8 rules 2, 3 and 4)
// ---------------------------------------------------------------------------

/**
 * What kind of claim a record is making.
 *
 * Keyed by profile rather than by strategy because `replace` is two different
 * things wearing one strategy name: an ownership conflict is a fact about the
 * capability, while a bundling failure is a fact about one artifact. Treating
 * them alike is what turns a technical rejection into a permanent cache.
 *
 * - `resolved-dependency` — `host`, `inline` and `extension`: the package reaches
 *   the generated graph, so the record has to survive both the package and the
 *   target moving.
 * - `architectural-rejection` — the capability belongs to Forguncy (#4, rule 5
 *   of #8). It does not expire with a version bump, because no version of the
 *   package can move the capability to the other side of the ownership boundary.
 * - `technical-rejection` — the right role, the wrong artifact. Re-evaluated when
 *   the candidate, the toolchain or the target moves, because any of them can
 *   turn the failure into a success.
 */
export const LOCK_EVIDENCE_PROFILES = [
  "resolved-dependency",
  "architectural-rejection",
  "technical-rejection",
] as const;
export type LockEvidenceProfile = (typeof LOCK_EVIDENCE_PROFILES)[number];

/** How much probe evidence a profile needs before its record can be used. */
export const LOCK_PROBE_REQUIREMENTS = ["none", "measured", "passed"] as const;
export type LockProbeRequirement = (typeof LOCK_PROBE_REQUIREMENTS)[number];

export interface LockEvidencePolicy {
  readonly profile: LockEvidenceProfile;
  /** A different Forguncy target invalidates this record's evidence. */
  readonly invalidatedByTargetChange: boolean;
  /** The record must name the target its runtime evidence is about. */
  readonly requiresTargetIdentity: boolean;
  /** How much probe evidence the record must carry. */
  readonly probeRequirement: LockProbeRequirement;
  /** The package appears in the generated dependency graph (rule 4 of #8). */
  readonly participatesInCompilation: boolean;
}

export const LOCK_EVIDENCE_POLICY: Readonly<Record<LockEvidenceProfile, LockEvidencePolicy>> = {
  "resolved-dependency": {
    profile: "resolved-dependency",
    invalidatedByTargetChange: true,
    requiresTargetIdentity: true,
    probeRequirement: "passed",
    participatesInCompilation: true,
  },
  "architectural-rejection": {
    profile: "architectural-rejection",
    // The capability cannot be moved by a product upgrade, so there is nothing
    // in the runtime to invalidate this. Its evidence is the ownership decision.
    invalidatedByTargetChange: false,
    requiresTargetIdentity: false,
    probeRequirement: "none",
    participatesInCompilation: false,
  },
  "technical-rejection": {
    profile: "technical-rejection",
    // A product upgrade can fix a bundling failure, so the rejection is tied to
    // the target it was observed under.
    invalidatedByTargetChange: true,
    // Not required: a bundling failure is reproducible without a Forguncy page,
    // so demanding a target would block a legitimate local rejection.
    requiresTargetIdentity: false,
    probeRequirement: "measured",
    participatesInCompilation: false,
  },
};

/**
 * Whether the strategy's real-runtime checks are still owed for this record.
 *
 * Delegates to #4 instead of restating its answer: `strategy.ts` already declares
 * `realRuntimeRequired: true` for every strategy, and a second table deciding the
 * same question is exactly how the two drift apart. `inline` is included, which
 * is the point — an inlined bundle is still executed by the runtime it was built
 * for, so a green local probe is never on its own a compatibility claim.
 *
 * `replace` is the one divergence, and it is not a disagreement: #4's
 * `realRuntimeRequired` for `replace` is a check on the *replacement*, which
 * carries its own record. This record compiles nothing, so it owes no runtime
 * check of its own.
 */
export function requiresRuntimeValidation(record: LockedDependencyDecision): boolean {
  return record.strategy === "replace" ? false : requiresRealRuntimeValidation(record.strategy);
}

export function lockEvidenceProfileOf(record: LockedDependencyDecision): LockEvidenceProfile {
  if (record.strategy !== "replace") {
    return "resolved-dependency";
  }
  return record.rejection.kind === "architectural" ? "architectural-rejection" : "technical-rejection";
}

export function lockEvidencePolicyFor(record: LockedDependencyDecision): LockEvidencePolicy {
  return LOCK_EVIDENCE_POLICY[lockEvidenceProfileOf(record)];
}

// ---------------------------------------------------------------------------
// Projection onto #4's decision model
// ---------------------------------------------------------------------------

/**
 * The lock record reduced to the decision the compiler is allowed to see.
 *
 * The compiler's input is `DependencyDecision[]` (#6), and lock metadata is not
 * part of that contract. Projecting explicitly rather than passing the whole
 * record stops a compiler from starting to depend on `probe` or `evidence`
 * fields that exist for invalidation, not for bundling.
 */
export function dependencyDecisionOf(record: LockedDependencyDecision): DependencyDecision {
  switch (record.strategy) {
    case "inline":
      return { strategy: "inline", packageName: record.packageName };
    case "host":
      return { strategy: "host", packageName: record.packageName, globalName: record.globalName };
    case "extension":
      return {
        strategy: "extension",
        packageName: record.packageName,
        libraryId: record.libraryId,
        globalName: record.globalName,
      };
    case "replace":
      return {
        strategy: "replace",
        packageName: record.packageName,
        rejection: record.rejection,
        ...(record.alternatives === undefined ? {} : { alternatives: record.alternatives }),
        ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
      };
  }
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export function isSupportedFgcLockSchemaVersion(version: unknown): version is number {
  return typeof version === "number" && SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.includes(version);
}

/**
 * Fails explicitly on an unknown schema version — the read path must not guess.
 */
export function assertSupportedFgcLockSchemaVersion(version: number): void {
  if (!isSupportedFgcLockSchemaVersion(version)) {
    throw new FgcLockSchemaVersionError(version);
  }
}

export class FgcLockSchemaVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(
      `${FGC_LOCK_FILE_NAME} declares unsupported schema version ${String(schemaVersion)}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}. Migrate the lock deliberately rather than reading it on a best-effort basis.`,
    );
    this.name = "FgcLockSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

export class FgcLockValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], context = FGC_LOCK_FILE_NAME) {
    super(`Invalid ${context}:\n- ${problems.join("\n- ")}`);
    this.name = "FgcLockValidationError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Portability
// ---------------------------------------------------------------------------

/**
 * Patterns that identify an absolute, machine-specific path *occurrence*.
 *
 * Anchored on the character before the path rather than on the start of the
 * string, because the path that leaks is rarely the whole value: a fingerprint
 * like `entry=/Users/mang/project/App.tsx` starts with `entry=`, and an
 * `^`-anchored check reports it as portable.
 *
 * The leading guard on the POSIX pattern is what keeps URLs out: in
 * `https://github.com/...` the first slash follows `:` and the second follows
 * `/`, so neither is the start of a path.
 */
const ABSOLUTE_PATH_OCCURRENCES: readonly RegExp[] = [
  // C:\Users\... or C:/Users/... — the guard keeps `https:` out (`s` is alphanumeric).
  /(?:^|[^0-9A-Za-z])[A-Za-z]:[\\/]/,
  // \\server\share
  /(?:^|[^\\])\\\\[^\\/]/,
  // ~/ or ~\ home-relative
  /(?:^|[^0-9A-Za-z._~-])~[\\/]/,
  // A slash that starts a path rather than continuing one, followed by a
  // path-ish character so prose containing " / " is not a hit.
  /(?:^|[^0-9A-Za-z._~:/#-])\/[0-9A-Za-z._~-]/,
];

function containsAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_OCCURRENCES.some(pattern => pattern.test(value));
}

/**
 * Every absolute or machine-specific path anywhere in the document.
 *
 * Exported as a document-wide scan rather than only as a field check so the
 * portability guarantee holds for the whole shape, including fields added later.
 */
export function findMachineSpecificPaths(value: unknown): readonly string[] {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (containsAbsolutePath(node)) {
        found.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const item of Object.values(node)) {
        visit(item);
      }
    }
  };

  visit(value);
  return [...found].sort(compareStrings);
}

/**
 * A path that means the same thing on every machine: relative, no drive, no home
 * directory, no `..` escape out of the repository, and no absolute path hidden
 * inside it.
 */
export function isRepositoryRelativeReference(reference: string): boolean {
  const value = reference.trim();
  if (value.length === 0) {
    return false;
  }
  // A URI scheme means it is not a relative path, whatever else it is.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return false;
  }
  if (containsAbsolutePath(value)) {
    return false;
  }
  return !value.split(/[\\/]/).includes("..");
}

export function isEvidenceUrl(reference: string): boolean {
  return /^https?:\/\/\S+$/.test(reference.trim());
}

export function isEvidenceReference(reference: string): boolean {
  return isEvidenceUrl(reference) || isRepositoryRelativeReference(reference);
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * Code-unit comparison, deliberately not `localeCompare`: sorting that depends on
 * the reviewer's locale would make the same lock serialize differently on two
 * machines, which is exactly what the lock exists to prevent.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Canonical decision order: package name, then cell target.
 *
 * A null cell target sorts before any named target, so the target-independent
 * record for a package always reads first.
 */
export function compareLockDecisions(a: LockedDependencyDecision, b: LockedDependencyDecision): number {
  return compareStrings(a.packageName, b.packageName) || compareStrings(a.cellTarget ?? "", b.cellTarget ?? "");
}

function compareEvidenceLinks(a: DecisionEvidenceLink, b: DecisionEvidenceLink): number {
  return compareStrings(a.kind, b.kind) || compareStrings(a.reference, b.reference);
}

/**
 * Field order for the serialized document.
 *
 * Listed fields come first, in this order, so a record reads as identity →
 * strategy → strategy-specific detail → evidence. Anything unlisted falls in
 * alphabetically afterwards, which keeps a future field deterministic without
 * requiring an edit here.
 */
const LOCK_KEY_ORDER: readonly string[] = [
  "schemaVersion",
  "decisions",
  "packageName",
  "cellTarget",
  "strategy",
  "resolvedVersion",
  "globalName",
  "libraryId",
  "rejection",
  "alternatives",
  "supersededBy",
  "probe",
  "target",
  "probedWith",
  "extension",
  "rejectedCandidate",
  "rationale",
  "evidence",
  "status",
  "fingerprint",
  "versionIndependent",
  "product",
  "productVersion",
  "productBuild",
  "hostReactVersion",
  "vitePlus",
  "version",
  "identity",
  "kind",
  "code",
  "summary",
  "remediation",
  "reference",
];

function compareCanonicalKeys(a: string, b: string): number {
  const rankA = LOCK_KEY_ORDER.indexOf(a);
  const rankB = LOCK_KEY_ORDER.indexOf(b);
  if (rankA !== rankB) {
    return (rankA === -1 ? LOCK_KEY_ORDER.length : rankA) - (rankB === -1 ? LOCK_KEY_ORDER.length : rankB);
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

export function isCanonicallyOrdered(decisions: readonly LockedDependencyDecision[]): boolean {
  for (let index = 1; index < decisions.length; index += 1) {
    if (compareLockDecisions(decisions[index - 1]!, decisions[index]!) >= 0) {
      return false;
    }
  }
  return true;
}

/**
 * The canonical document: decisions in canonical order, evidence links sorted.
 *
 * Sorting the links matters for the same reason as sorting the decisions — an
 * Agent that discovers evidence in a different order must not produce a diff.
 */
export function canonicalizeFgcLock(lock: FgcLockDocument): FgcLockDocument {
  return {
    schemaVersion: lock.schemaVersion,
    decisions: [...lock.decisions]
      .sort(compareLockDecisions)
      .map(record => ({ ...record, evidence: [...record.evidence].sort(compareEvidenceLinks) })),
  };
}

/**
 * The exact bytes a lock file should contain.
 *
 * Always canonicalizes, so calling this on any decision set yields review-ready
 * output, and serializing an already-serialized document is a no-op.
 */
export function serializeFgcLock(lock: FgcLockDocument, options: { readonly indent?: number } = {}): string {
  const canonical = canonicalizeValue(canonicalizeFgcLock(lock));
  return `${JSON.stringify(canonical, null, options.indent ?? 2)}\n`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKnownStrategy(value: unknown): value is DependencyStrategy {
  return value === "host" || value === "inline" || value === "extension" || value === "replace";
}

/**
 * Structural problems with untrusted input, before any typed access.
 *
 * Split out from `validateFgcLockDocument` so `parseFgcLockDocument` can reject a
 * malformed file with a readable message instead of crashing while reading a
 * field the document does not have.
 */
export function inspectFgcLockDocument(input: unknown): readonly string[] {
  if (!isPlainObject(input)) {
    return [`${FGC_LOCK_FILE_NAME} must contain a JSON object.`];
  }

  const problems: string[] = [];
  const { schemaVersion, decisions } = input;

  if (typeof schemaVersion !== "number") {
    problems.push(`${FGC_LOCK_FILE_NAME} must declare a numeric \`schemaVersion\`.`);
  } else if (!isSupportedFgcLockSchemaVersion(schemaVersion)) {
    problems.push(
      `Unsupported schema version ${schemaVersion}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  if (!Array.isArray(decisions)) {
    problems.push(`${FGC_LOCK_FILE_NAME} must declare a \`decisions\` array.`);
    return problems;
  }

  decisions.forEach((record, index) => {
    const where = `decisions[${index}]`;
    if (!isPlainObject(record)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    if (typeof record.packageName !== "string" || record.packageName.trim().length === 0) {
      problems.push(`${where} must name the package it decides about.`);
    }
    if (!isKnownStrategy(record.strategy)) {
      problems.push(`${where} must declare one of the four dependency strategies.`);
    }
    if (!isPlainObject(record.probe)) {
      problems.push(`${where} must record probe evidence, even when no probe has run.`);
    }
    if (!Array.isArray(record.evidence)) {
      problems.push(`${where} must record an \`evidence\` array linking the decision to its probe/decision evidence.`);
    }
  });

  return problems;
}

/**
 * The lock's own contract: schema version, required metadata, the evidence each
 * profile owes, portable references, canonical ordering, and unique keys.
 *
 * Decision-field semantics (a host global must be named, an architectural
 * rejection may not list package alternatives, …) stay in
 * `validateDependencyDecisionShape`, so #4's rules have one implementation.
 */
export function validateFgcLockDocument(lock: FgcLockDocument): readonly string[] {
  const problems: string[] = [];

  if (!isSupportedFgcLockSchemaVersion(lock.schemaVersion)) {
    problems.push(
      `Unsupported schema version ${String(lock.schemaVersion)}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  const seenKeys = new Set<string>();

  lock.decisions.forEach((record, index) => {
    const where = `decisions[${index}] ("${record.packageName}")`;
    const key = `${record.packageName}\u0000${record.cellTarget ?? ""}`;

    if (seenKeys.has(key)) {
      problems.push(
        `${where} duplicates an existing decision for the same package and cell target. Keep one record per (package, cell target) pair and let the strategy change show up as an ordinary diff.`,
      );
    }
    seenKeys.add(key);

    if (record.cellTarget !== null && record.cellTarget.trim().length === 0) {
      problems.push(`${where} must either name a cell target or record null for "applies to every target".`);
    }

    for (const problem of validateDependencyDecisionShape(record)) {
      problems.push(`${where}: ${problem}`);
    }

    const policy = lockEvidencePolicyFor(record);

    problems.push(...validateVersions(where, record));
    problems.push(...validateProbe(where, record, policy));
    problems.push(...validateTarget(where, record, policy));
    problems.push(...validateProbedWith(where, record, policy));
    problems.push(...validateExtension(where, record));
    problems.push(...validateRejectedCandidate(where, record));
    problems.push(...validateRationale(where, record));
    problems.push(...validateEvidence(where, record));
  });

  if (!isCanonicallyOrdered(lock.decisions)) {
    problems.push(
      "Decisions are not in canonical order (package name, then cell target). Serialize through `serializeFgcLock` so identical decisions produce identical bytes.",
    );
  }

  for (const path of findMachineSpecificPaths(lock)) {
    problems.push(
      `"${path}" contains a machine-specific absolute path. Use a URL or a repository-relative path so the decision is reproducible on another machine and in CI.`,
    );
  }

  return problems;
}

function validateVersions(where: string, record: LockedDependencyDecision): readonly string[] {
  const problems: string[] = [];
  const { resolvedVersion, strategy } = record;

  if (resolvedVersion !== null && resolvedVersion.trim().length === 0) {
    problems.push(`${where} must record the exact resolved version, or null when the package is not resolved.`);
  }

  if (strategy === "replace" && resolvedVersion !== null) {
    problems.push(
      `${where} is a \`replace\` decision, which keeps no dependency for the compiled cell; record resolvedVersion as null and let \`rejectedCandidate\`/\`alternatives\` describe what was rejected.`,
    );
  }

  if (strategy !== "replace" && resolvedVersion === null) {
    problems.push(
      `${where} records strategy "${strategy}" without the exact resolved version, so a later upgrade could not be detected as staleness.`,
    );
  }

  return problems;
}

function validateProbe(
  where: string,
  record: LockedDependencyDecision,
  policy: LockEvidencePolicy,
): readonly string[] {
  const problems: string[] = [];
  const { status, fingerprint, versionIndependent } = record.probe;

  if (!PROBE_STATUSES.includes(status)) {
    problems.push(`${where} must record a probe status of ${PROBE_STATUSES.join(", ")}.`);
    return problems;
  }

  if (status === "not-run" && fingerprint !== null) {
    problems.push(`${where} has no probe run, so it must not carry a probe fingerprint.`);
  }

  if (status !== "not-run" && (fingerprint === null || fingerprint.trim().length === 0)) {
    problems.push(
      `${where} claims a "${status}" probe without a fingerprint of what it ran against; without it the evidence cannot be invalidated when its inputs change.`,
    );
  }

  if (versionIndependent && status === "not-run") {
    problems.push(
      `${where} marks a probe version-independent without a probe run. Version independence is a property of a measured probe, not an assumption.`,
    );
  }

  if (policy.probeRequirement === "none" && status !== "not-run") {
    problems.push(
      `${where} is a "${policy.profile}" record, whose evidence is the decision itself; a probe run here would claim a measurement that this profile does not make.`,
    );
  }

  return problems;
}

function validateTarget(
  where: string,
  record: LockedDependencyDecision,
  policy: LockEvidencePolicy,
): readonly string[] {
  const problems: string[] = [];
  const { target } = record;

  if (target !== null) {
    if (target.product.trim().length === 0 || target.productVersion.trim().length === 0 || target.productBuild.trim().length === 0) {
      problems.push(`${where} must name the product, version and build its runtime evidence is about.`);
    }
    if (target.hostReactVersion.trim().length === 0) {
      problems.push(`${where} must name the host React version its runtime evidence is about.`);
    }
  }

  // A target means "this evidence was observed under that runtime", which is a
  // compatibility claim only for the records that make one. For a technical
  // rejection it is the opposite — the failure is the evidence — so the passing
  // probe is asked for only where the record claims compatibility.
  if (requiresRuntimeValidation(record) && target !== null && record.probe.status !== "passed") {
    problems.push(
      `${where} names a Forguncy target while its probe is "${record.probe.status}". Runtime compatibility cannot be claimed from a probe that has not passed; record target as null until the probe passes against it.`,
    );
  }

  // Nothing was observed, so there is no runtime the evidence belongs to.
  if (policy.probeRequirement === "none" && target !== null) {
    problems.push(
      `${where} is a "${policy.profile}" record whose evidence is the decision itself, so it cannot name a runtime it was observed under; record target as null.`,
    );
  }

  if (policy.requiresTargetIdentity && target === null) {
    problems.push(
      `${where} uses strategy "${record.strategy}", whose evidence is a property of the Forguncy runtime; the record must name the target it was validated against.`,
    );
  }

  return problems;
}

function validateProbedWith(
  where: string,
  record: LockedDependencyDecision,
  policy: LockEvidencePolicy,
): readonly string[] {
  const { probedWith, probe } = record;

  if (probedWith !== null && probedWith.vitePlus !== null && probedWith.vitePlus.trim().length === 0) {
    return [`${where} must either name the Vite+ version used for the probe or record null.`];
  }

  if (probedWith !== null && probe.status === "not-run") {
    return [
      `${where} records a toolchain for a probe that never ran. Either run the probe or record probedWith as null.`,
    ];
  }

  // #8 asks for the toolchain "when material", so the version may be null — but
  // the identity itself cannot be absent, or a Vite+ upgrade could never
  // invalidate this evidence and the record would be verified for ever.
  if (policy.probeRequirement !== "none" && probedWith === null) {
    return [
      `${where} records a "${probe.status}" probe without the toolchain it ran under. Record probedWith, and record vitePlus as null there only when its version is genuinely immaterial.`,
    ];
  }

  return [];
}

function validateExtension(where: string, record: LockedDependencyDecision): readonly string[] {
  const { extension, strategy } = record;

  if (strategy !== "extension") {
    return extension === null
      ? []
      : [`${where} records extension evidence on a "${strategy}" decision; extension identity belongs to \`extension\` records only.`];
  }

  if (extension === null) {
    return [`${where} is an \`extension\` decision and must record the extension version or identity it consumes.`];
  }

  if (extension.version === null && extension.identity === null) {
    return [
      `${where} must record the extension version or a content identity; an \`extension\` decision that names neither cannot be re-checked when the extension changes.`,
    ];
  }

  return [];
}

function validateRejectedCandidate(where: string, record: LockedDependencyDecision): readonly string[] {
  const { rejectedCandidate, strategy } = record;

  if (strategy !== "replace") {
    return rejectedCandidate === null
      ? []
      : [`${where} records a rejected candidate on a "${strategy}" decision; only a rejection has one.`];
  }

  if (record.rejection.kind === "architectural") {
    return rejectedCandidate === null
      ? []
      : [
          `${where} is an architectural rejection: the capability belongs to Forguncy whatever version the package is, so recording a rejected candidate version would tie an ownership conflict to a release.`,
        ];
  }

  if (rejectedCandidate === null || rejectedCandidate.version.trim().length === 0) {
    return [
      `${where} is a technical rejection and must record the exact version of the candidate that failed; without it, one observed bundling failure becomes a permanent verdict on every future version.`,
    ];
  }

  return [];
}

function validateRationale(where: string, record: LockedDependencyDecision): readonly string[] {
  const requiresJustification = strategySemantics(record.strategy).requiresJustification;
  const { rationale } = record;

  if (requiresJustification && (rationale === null || rationale.trim().length === 0)) {
    return [
      `${where} uses strategy "${record.strategy}", which #4 requires a written justification for; fill \`rationale\` so the PR diff explains the strategy choice.`,
    ];
  }

  if (!requiresJustification && rationale !== null && rationale.trim().length === 0) {
    return [`${where} must either explain the strategy choice in \`rationale\` or record null.`];
  }

  return [];
}

function validateEvidence(where: string, record: LockedDependencyDecision): readonly string[] {
  const problems: string[] = [];
  const { evidence, probe } = record;

  if (evidence.length === 0) {
    problems.push(
      `${where} records no evidence. A strategy change must link the probe or decision it rests on, or it cannot be reviewed.`,
    );
    return problems;
  }

  for (const link of evidence) {
    if (!DECISION_EVIDENCE_KINDS.includes(link.kind)) {
      problems.push(`${where} references evidence of unknown kind "${String(link.kind)}".`);
    }
    if (!isEvidenceReference(link.reference)) {
      problems.push(
        `${where} references "${link.reference}", which is neither an http(s) URL nor a repository-relative path.`,
      );
    }
  }

  const hasProbeLink = evidence.some(link => link.kind === "probe" || link.kind === "runtime-observation");
  if (probe.status !== "not-run" && !hasProbeLink) {
    problems.push(
      `${where} claims a "${probe.status}" probe but links no \`probe\` or \`runtime-observation\` evidence to it.`,
    );
  }

  // Rule 5 of #8: an architectural conflict comes from #4, so the record has to
  // be traceable to the ownership decision rather than to a bundle experiment.
  if (record.strategy === "replace" && record.rejection.kind === "architectural") {
    const citesOwnership = evidence.some(link => citesDecision(link.reference, OWNERSHIP_AND_DEPENDENCY_DECISION));
    if (!citesOwnership) {
      problems.push(
        `${where} is an architectural rejection but links no evidence citing ${OWNERSHIP_AND_DEPENDENCY_DECISION.url}. Rule 5 of #8 routes these conflicts to the ownership decision in #4, so the record has to name it.`,
      );
    }
  }

  return problems;
}

export function assertFgcLockDocument(lock: FgcLockDocument): void {
  const problems = validateFgcLockDocument(lock);
  if (problems.length > 0) {
    throw new FgcLockValidationError(problems);
  }
}

/**
 * Parse a lock file's text into a validated document.
 *
 * Structural checks run first so a malformed file reports what is wrong instead
 * of throwing from deep inside validation. An unsupported `schemaVersion` fails
 * here — the read path never silently accepts a shape it does not understand.
 */
export function parseFgcLockDocument(text: string): FgcLockDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FgcLockValidationError([`${FGC_LOCK_FILE_NAME} is not valid JSON: ${(error as Error).message}`]);
  }

  // A declared-but-unsupported version fails with its own error type, so a
  // migration path can catch it specifically and refuse to read on a guess.
  if (isPlainObject(parsed) && typeof parsed.schemaVersion === "number") {
    assertSupportedFgcLockSchemaVersion(parsed.schemaVersion);
  }

  const structural = inspectFgcLockDocument(parsed);
  if (structural.length > 0) {
    throw new FgcLockValidationError(structural);
  }

  const lock = parsed as FgcLockDocument;
  assertFgcLockDocument(lock);
  return lock;
}
