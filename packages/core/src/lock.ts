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

import type { ArchitectureDecisionSource } from "./governance.ts";
import {
  citesDecision,
  DEPENDENCY_LOCK_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
} from "./governance.ts";
import type { RuntimeContractTarget } from "./runtime-contract.ts";
import { RUNTIME_CONTRACT_TARGET } from "./runtime-contract.ts";
import {
  ARCHITECTURAL_REJECTION_CODES,
  TECHNICAL_REJECTION_CODES,
  isArtifactObservedRejectionCode,
} from "./rejection.ts";
import type { TechnicalRejectionCode } from "./rejection.ts";
import type { DependencyDecision, DependencyStrategy } from "./strategy.ts";
import { requiresRealRuntimeValidation, strategySemantics, validateDependencyDecisionShape } from "./strategy.ts";

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
   * Identity of the probe inputs the lock does *not* model separately.
   *
   * Deliberately not a fingerprint of everything the probe saw. The resolved
   * version, the Forguncy target and the toolchain each have their own field on
   * this record and their own freshness reason, so folding them in here would
   * report one change twice — and it would silently defeat `versionIndependent`:
   * an upgrade that flag permits would still move a fingerprint containing the
   * version, so the record would go stale anyway and the flag would mean nothing.
   *
   * What belongs here is the rest of the probe's declared inputs: the entry, the
   * probe id, the probe configuration, and any bundler input no other field
   * captures.
   *
   * The contract is that the value is a deterministic function of those inputs
   * and can therefore be *recomputed without re-running the probe*. That is what
   * lets `LockEnvironment.probeFingerprints` be compared against it, and why an
   * entry or configuration change is detectable while every version in the
   * record still matches. Composing it is the probe engine's job (#17); this
   * module only requires that both sides compose it the same way, and only over
   * the inputs listed above. Required once a probe has run, null while `status`
   * is `not-run`.
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
   * The named bindings the probe's synthetic entry imported, in canonical (sorted, deduplicated)
   * order; null when it kept the whole namespace.
   *
   * Recorded for two reasons, and **neither of them authorizes a rejection** (#77 revision 13:
   * no probe run files the cap verdict, because the probe's build and the compiler's do not share
   * a resolution graph and the surface is a caller's declaration anyway):
   *
   * - It is one of the fingerprint's declared inputs, so `status` has to read it back to rebuild
   *   the fingerprint the record was measured under. Without it a named-surface record would be
   *   rebuilt as a namespace run and report `probe-fingerprint-changed` for a measurement that
   *   had not moved.
   * - It makes the record's own size evidence interpretable: a namespace probe's number leans
   *   over what a Cell carries, a named one leans under. A reader weighing the estimate needs to
   *   know which it is; the estimate itself is never disqualifying.
   *
   * Optional, not required, and the read path is why: `inspectLockRecord` accepts an **absent**
   * key as the namespace surface, and `parseFgcLockDocument` casts the parsed JSON without
   * normalizing it. A required field would therefore be a type claiming a key that a lock
   * written before #77 does not have — the annotation would assert more than the read path
   * guarantees, and every consumer would be reading `undefined` where the type promised
   * `string[] | null`. Stating it as optional keeps the two in agreement, and the three spellings
   * of "the whole namespace" (absent, `undefined`, `null`) all mean one thing.
   *
   * The fingerprint composition omits the key entirely for that state, so such a record still
   * recomposes to the bytes it was written with.
   */
  readonly imports?: readonly string[] | null;
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
   * The runtime this evidence was validated against, or null when it has not
   * been validated in one yet.
   *
   * Null is a state rather than a gap: a locally probed decision awaiting its
   * first real-page check is exactly this, and `resolveLockDecision` reports it
   * as `not-validated` instead of verified. Its presence *is* the runtime claim,
   * and validation ties it to a passing probe, so the claim cannot be made from
   * a probe that failed or never ran.
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
  "artifact-rejection",
] as const;
export type LockEvidenceProfile = (typeof LOCK_EVIDENCE_PROFILES)[number];

/**
 * Which probe outcome a profile's evidence is.
 *
 * Named for the outcome rather than for "how much evidence", because the profiles
 * want different outcomes and the difference is semantic:
 *
 * - `none` — no probe belongs to this record at all.
 * - `passed` — the record is usable once a probe passes. A failed or missing
 *   probe is still a legitimate record — an Agent should be able to see the
 *   attempt — so it is recorded and evaluates as stale rather than being refused
 *   when it is written. A failure is history; only success is compatibility.
 * - `not-passed` — a rejection's evidence is a probe that did *not* succeed.
 *   `not-run` is allowed, because a rejection can come from reading the
 *   package's requirements rather than from a bundle attempt, and freshness
 *   reports it as unverified. `passed` is refused: a record cannot both reject a
 *   candidate and hold a probe that accepted it.
 *
 * `passed` covers two profiles with opposite conclusions, and that is the point rather than a
 * conflation: a `resolved-dependency` record *adopts* the package a passing probe describes,
 * while an `artifact-rejection` record rejects a different document — the composed Cell — that
 * the probe never builds. In both cases the package itself passed, so requiring anything else
 * would make the expected state (a good package that produces a too-large Cell) unrecordable.
 */
export const LOCK_PROBE_REQUIREMENTS = ["none", "passed", "not-passed"] as const;
export type LockProbeRequirement = (typeof LOCK_PROBE_REQUIREMENTS)[number];

export interface LockEvidencePolicy {
  readonly profile: LockEvidenceProfile;
  /** A different Forguncy target invalidates this record's evidence. */
  readonly invalidatedByTargetChange: boolean;
  /** Which probe outcome the record's evidence is. */
  readonly probeRequirement: LockProbeRequirement;
  /** The package appears in the generated dependency graph (rule 4 of #8). */
  readonly participatesInCompilation: boolean;
}

export const LOCK_EVIDENCE_POLICY: Readonly<Record<LockEvidenceProfile, LockEvidencePolicy>> = {
  "resolved-dependency": {
    profile: "resolved-dependency",
    invalidatedByTargetChange: true,
    probeRequirement: "passed",
    participatesInCompilation: true,
  },
  "architectural-rejection": {
    profile: "architectural-rejection",
    // The capability cannot be moved by a product upgrade, so there is nothing
    // in the runtime to invalidate this. Its evidence is the ownership decision.
    invalidatedByTargetChange: false,
    probeRequirement: "none",
    participatesInCompilation: false,
  },
  "technical-rejection": {
    profile: "technical-rejection",
    // A product upgrade can fix a bundling failure, so the rejection is tied to
    // the target it was observed under.
    invalidatedByTargetChange: true,
    probeRequirement: "not-passed",
    participatesInCompilation: false,
  },
  "artifact-rejection": {
    profile: "artifact-rejection",
    // The package's own probe **passed** — the rejection is about the composed Cell, which no
    // probe builds (#77 revision 14). Its evidence is `artifactEvidence`: the measured
    // `codeCharacters` against the cap the compile used.
    //
    // Tied to the target because the Cell is compiled for one: a different host React, or a
    // different product build, composes a different artifact.
    invalidatedByTargetChange: true,
    probeRequirement: "passed",
    // False for the same reason as the other rejections: a `replace` keeps no dependency for the
    // compiled cell, so this package does not appear in its graph. What *is* compiled is the
    // replacement, under its own record.
    participatesInCompilation: false,
  },
};

/**
 * Technical rejections that cannot be confirmed without a real Forguncy runtime.
 *
 * The profile default — "a bundling failure is reproducible locally" — is true
 * for the artifact-shaped failures, and false for the three below, which are
 * observations of the host: which module identity a global actually has, whether
 * a global name collides with the host's, and whether a runtime API the package
 * needs exists at all. A record citing one of these without naming the target it
 * was observed under would claim a runtime fact it never observed, so validation
 * requires the target for exactly these codes.
 *
 * The split is a judgement per code rather than a property of `replace`, and
 * later Specs (#12 extension externals, #17 probe engine) may refine it — hence
 * a named list instead of logic buried in a validator.
 */
export const RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES: readonly TechnicalRejectionCode[] = [
  "host-module-identity-mismatch",
  "global-namespace-collision",
  "runtime-api-unavailable",
];

/**
 * Whether the record has to name the Forguncy target its evidence is about.
 *
 * Deliberately narrow, and narrow is the point. For a resolved dependency a
 * target is a *verification claim*, and its absence is a state —
 * `not-validated` — not a shape error. Requiring the field there made the states
 * the model exists to express unpresentable: a locally probed record awaiting its
 * runtime check, and a record whose probe failed or has not run, could not be
 * written to a real lock file at all, so `not-validated`, `probe-failed` and
 * `probe-never-run` only ever existed in hand-built test objects.
 *
 * The one place the field remains a shape requirement is a rejection that only a
 * runtime can observe: without a target the record would claim a runtime fact it
 * never saw. Which codes those are is {@link RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES}.
 */
export function requiresTargetIdentity(record: LockedDependencyDecision): boolean {
  return (
    record.strategy === "replace" &&
    record.rejection.kind === "technical" &&
    RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES.includes(record.rejection.code)
  );
}

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

/**
 * The evidence profile of a decision that has not been recorded yet.
 *
 * Extracted from {@link lockEvidenceProfileOf} so a caller holding a #4 decision but
 * no lock record — the selection audit in `selection-policy.ts` — can ask #8 which
 * probe outcome the decision owes, instead of keeping a second copy of this mapping.
 * The two would drift, and the drift would be invisible: a record written under one
 * answer and evaluated under the other looks like a fresh decision.
 */
export function lockEvidenceProfileForDecision(decision: DependencyDecision): LockEvidenceProfile {
  if (decision.strategy !== "replace") {
    return "resolved-dependency";
  }
  if (decision.rejection.kind === "architectural") {
    return "architectural-rejection";
  }
  // A technical rejection splits by *what observed it*: a probe reports the package's own
  // failure, while a compose reports the Cell's size. The two want different probe outcomes —
  // `not-passed` and `passed` respectively — so the split has to happen here, where the code is
  // known, rather than in a validator that would have to special-case the policy back.
  return isArtifactObservedRejectionCode(decision.rejection.code) ? "artifact-rejection" : "technical-rejection";
}

export function lockEvidenceProfileOf(record: LockedDependencyDecision): LockEvidenceProfile {
  return lockEvidenceProfileForDecision(record);
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
  // A file URL is a filesystem path wearing a scheme, and it is what a Node/Vite
  // probe produces from `import.meta.url` — so it is the shape a machine path
  // most easily re-enters the lock in. `http(s)://` stays allowed; this one
  // cannot be portable on any machine.
  /(?:^|[^0-9A-Za-z])file:[\\/]/i,
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

/**
 * Canonical order for evidence links: kind, then reference.
 *
 * Exported because a *writer* that merges new evidence into an existing record has
 * to produce the same order this serializer does, or the record it returns is not
 * the record on disk. Sharing the comparator is what keeps that true; a second
 * copy in the writer would be a second definition of "canonical", and the two
 * would only have to disagree once.
 */
export function compareEvidenceLinks(a: DecisionEvidenceLink, b: DecisionEvidenceLink): number {
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
 * The canonical spelling of a declared import surface: sorted, deduplicated, or `null`.
 *
 * The field is a **set** — `imports: ["add", "clamp"]` and `["clamp", "add"]` name one surface,
 * and the probe fingerprint already sorts them into one input — so the lock has to store one
 * byte sequence for it or #8's "deterministic and reviewable" guarantee is false for a document
 * that is otherwise fully ordered. `canonicalizeFgcLock` applies this, `inspectLockRecord`
 * rejects a document that has not, and the recording API writes it, so all three agree by
 * construction rather than by three copies of a sort.
 *
 * An empty array is the namespace surface, which this format spells as `null`: returning `null`
 * here means a caller cannot write the one spelling the lock's own validator refuses.
 */
export function canonicalizeImports(imports: readonly string[] | null | undefined): readonly string[] | null {
  if (imports === null || imports === undefined) {
    return null;
  }
  const unique = [...new Set(imports)].sort();
  return unique.length === 0 ? null : unique;
}

/**
 * The canonical document: decisions in canonical order, evidence links sorted, and each
 * declared import surface in set spelling.
 *
 * Sorting matters for the same reason each time — an Agent that lists the same things in a
 * different order must not produce a diff.
 */
export function canonicalizeFgcLock(lock: FgcLockDocument): FgcLockDocument {
  return {
    schemaVersion: lock.schemaVersion,
    decisions: [...lock.decisions]
      .sort(compareLockDecisions)
      .map(record => ({
        ...record,
        evidence: [...record.evidence].sort(compareEvidenceLinks),
        // Omitted entirely for the namespace surface, so a record written before this field
        // existed still serializes without the key — the same reason the fingerprint omits it.
        ...(record.imports == null ? {} : { imports: canonicalizeImports(record.imports) }),
      })),
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
 * Complete on purpose, and that completeness is the whole point: the semantic
 * pass reads fields with `.trim()`, `.kind`, `.length` and friends, so any field
 * this misses becomes a native `TypeError` thrown out of the parser instead of a
 * `FgcLockValidationError` naming the record. A missing field is therefore a
 * problem here even when `null` would be legal: the file is generated and
 * reviewed, so an absent key means the writer was wrong, and "must declare null"
 * is a better message than reading it as absent-and-fine.
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
    problems.push(...inspectLockRecord(record, `decisions[${index}]`));
  });

  return problems;
}

function inspectString(problems: string[], source: Record<string, unknown>, field: string, where: string): void {
  if (typeof source[field] !== "string") {
    problems.push(`${where} must declare \`${field}\` as a string.`);
  }
}

function inspectNullableString(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
): void {
  const value = source[field];
  if (value !== null && typeof value !== "string") {
    problems.push(`${where} must declare \`${field}\` as a string or null.`);
  }
}

function inspectStringArrayOrAbsent(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    problems.push(`${where} must declare \`${field}\` as an array of strings when it is present.`);
  }
}

function inspectOptionalObject(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
  inspect: (value: Record<string, unknown>, where: string) => readonly string[],
): void {
  const value = source[field];
  if (value === null) {
    return;
  }
  if (!isPlainObject(value)) {
    problems.push(`${where} must declare \`${field}\` as an object or null.`);
    return;
  }
  problems.push(...inspect(value, `${where}.${field}`));
}

function inspectLockRecord(record: unknown, where: string): readonly string[] {
  if (!isPlainObject(record)) {
    return [`${where} must be an object.`];
  }

  const problems: string[] = [];

  inspectString(problems, record, "packageName", where);
  if (typeof record.packageName === "string" && record.packageName.trim().length === 0) {
    problems.push(`${where} must name the package it decides about.`);
  }

  inspectNullableString(problems, record, "cellTarget", where);
  if (typeof record.cellTarget === "string" && record.cellTarget.trim().length === 0) {
    problems.push(`${where} must either name a cell target or record null for "applies to every target".`);
  }

  // `imports` is inspected on its own rather than through `inspectStringArrayOrAbsent`, because
  // null is a *meaning* here — the namespace surface — and that helper rejects it. The two
  // spellings of "no named surface" are an absent key (a lock written before #77) and an explicit
  // null (what the merge writes); both are valid, and the rejected forms are an empty array, which
  // would compose a fingerprint carrying a surface no build ever used, a blank name, and — since
  // revision 13 — a non-canonical spelling (unsorted, or with duplicates).
  if (record.imports !== undefined && record.imports !== null) {
    if (!Array.isArray(record.imports) || record.imports.some(item => typeof item !== "string")) {
      problems.push(`${where} must declare \`imports\` as an array of strings, or null for the whole namespace.`);
    } else if (record.imports.length === 0) {
      problems.push(
        `${where} records an empty \`imports\` array. An empty surface is the namespace probe, which this field spells as null — an empty array would compose a fingerprint carrying a surface no build ever used.`,
      );
    } else if (record.imports.some(name => name.trim().length === 0)) {
      problems.push(`${where} records a blank binding name in \`imports\`; every entry must name an imported binding.`);
    } else {
      // The surface is set-like — the fingerprint sorts it — so two spellings of one surface must
      // not be two byte sequences in a committed lock. This is a *validation* rather than a
      // silent canonicalization, matching how the lock treats decision and evidence order: the
      // reader is told to serialize, instead of the document being quietly reordered under a
      // reviewer. `canonicalizeImports` is the one definition both this and the serializer use,
      // so the accepted spelling cannot drift from the produced one.
      // `?? []` cannot fire here — the branch above already returned for an empty array — but the
      // helper is total by design, so its `null` return has to be narrowed for the caller rather
      // than asserted away.
      const canonical = canonicalizeImports(record.imports) ?? [];
      if (canonical.join("\u0000") !== record.imports.join("\u0000")) {
        problems.push(
          `${where} records \`imports\` as [${record.imports.join(", ")}], which is not the canonical spelling [${canonical.join(", ")}]. The surface is a set: serialize through \`serializeFgcLock\` (or record through \`recordDependencyDecision\`) so two spellings of one surface cannot be two lock bytes.`,
        );
      }
    }
  }

  inspectNullableString(problems, record, "resolvedVersion", where);
  inspectNullableString(problems, record, "rationale", where);

  if (!isKnownStrategy(record.strategy)) {
    problems.push(`${where} must declare one of the four dependency strategies.`);
  } else if (record.strategy === "host") {
    inspectString(problems, record, "globalName", where);
  } else if (record.strategy === "extension") {
    inspectString(problems, record, "globalName", where);
    inspectString(problems, record, "libraryId", where);
  } else if (record.strategy === "replace") {
    problems.push(...inspectRejection(record.rejection, `${where}.rejection`));
    inspectStringArrayOrAbsent(problems, record, "alternatives", where);
    if (record.supersededBy !== undefined && !isKnownStrategy(record.supersededBy)) {
      problems.push(`${where} must declare \`supersededBy\` as one of the four dependency strategies.`);
    }
  }

  if (!isPlainObject(record.probe)) {
    problems.push(`${where} must record probe evidence, even when no probe has run.`);
  } else {
    problems.push(...inspectProbe(record.probe, `${where}.probe`));
  }

  inspectOptionalObject(problems, record, "target", where, inspectTarget);
  inspectOptionalObject(problems, record, "probedWith", where, inspectToolchain);
  inspectOptionalObject(problems, record, "extension", where, inspectExtension);
  inspectOptionalObject(problems, record, "rejectedCandidate", where, inspectRejectedCandidate);

  if (!Array.isArray(record.evidence)) {
    problems.push(`${where} must record an \`evidence\` array linking the decision to its probe/decision evidence.`);
  } else {
    record.evidence.forEach((link, index) => {
      const evidenceWhere = `${where}.evidence[${index}]`;
      if (!isPlainObject(link)) {
        problems.push(`${evidenceWhere} must be an object.`);
        return;
      }
      inspectString(problems, link, "kind", evidenceWhere);
      inspectString(problems, link, "reference", evidenceWhere);
    });
  }

  return problems;
}

function inspectProbe(probe: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];

  if (typeof probe.status !== "string" || !PROBE_STATUSES.includes(probe.status as ProbeStatus)) {
    problems.push(`${where} must record a probe status of ${PROBE_STATUSES.join(", ")}.`);
  }
  inspectNullableString(problems, probe, "fingerprint", where);
  if (typeof probe.versionIndependent !== "boolean") {
    problems.push(`${where} must declare \`versionIndependent\` as a boolean.`);
  }

  return problems;
}

function inspectRejection(rejection: unknown, where: string): readonly string[] {
  if (!isPlainObject(rejection)) {
    return [`${where} must be an object describing why the package was rejected.`];
  }

  const problems: string[] = [];

  if (rejection.kind !== "architectural" && rejection.kind !== "technical") {
    problems.push(`${where} must declare \`kind\` as "architectural" or "technical".`);
  } else if (typeof rejection.code === "string") {
    // A code from the other family would make the record claim both answers at
    // once, which is the one distinction #4 exists to keep apart.
    const family = rejection.kind === "architectural" ? ARCHITECTURAL_REJECTION_CODES : TECHNICAL_REJECTION_CODES;
    if (!(family as readonly string[]).includes(rejection.code)) {
      problems.push(`${where} must declare a rejection code from the ${rejection.kind} family.`);
    }
  } else {
    problems.push(`${where} must declare \`code\` as a string.`);
  }

  inspectString(problems, rejection, "summary", where);
  inspectString(problems, rejection, "remediation", where);
  inspectStringArrayOrAbsent(problems, rejection, "evidence", where);

  return problems;
}

function inspectTarget(target: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  for (const field of ["product", "productVersion", "productBuild", "hostReactVersion"]) {
    inspectString(problems, target, field, where);
  }
  return problems;
}

function inspectToolchain(toolchain: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectNullableString(problems, toolchain, "vitePlus", where);
  return problems;
}

function inspectExtension(extension: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectNullableString(problems, extension, "version", where);
  inspectNullableString(problems, extension, "identity", where);
  return problems;
}

function inspectRejectedCandidate(candidate: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectString(problems, candidate, "version", where);
  return problems;
}

/**
 * The lock's own contract: schema version, required metadata, the evidence each
 * profile owes, portable references, canonical ordering, and unique keys.
 *
 * Shape first, and shape alone when the document fails it: the rules below read
 * typed fields, and running them over a document that is not that shape is how a
 * `.trim()` on `undefined` escapes the parser as a `TypeError`. A structurally
 * broken file is reported as broken rather than half-interpreted.
 *
 * Decision-field semantics (a host global must be named, an architectural
 * rejection may not list package alternatives, …) stay in
 * `validateDependencyDecisionShape`, so #4's rules have one implementation.
 */
export function validateFgcLockDocument(input: FgcLockDocument): readonly string[] {
  const structural = inspectFgcLockDocument(input);
  if (structural.length > 0) {
    return structural;
  }
  return validateFgcLockDocumentRules(input);
}

function validateFgcLockDocumentRules(lock: FgcLockDocument): readonly string[] {
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
    problems.push(...validateProbedWith(where, record));
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

  // A rejection's evidence is a probe that did not succeed. A `passed` probe
  // beside it would mean the record both rejected and accepted the same
  // candidate, and the current shape would carry that into the lock and evaluate
  // it as verified — so it is refused rather than interpreted.
  if (policy.probeRequirement === "not-passed" && status === "passed") {
    problems.push(
      `${where} is a "${policy.profile}" record, whose evidence is a probe that did not pass; status "passed" contradicts the rejection. Record the failure, or record the strategy the package actually resolved to.`,
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

  if (requiresTargetIdentity(record) && target === null) {
    problems.push(
      `${where} uses strategy "${record.strategy}"${
        record.strategy === "replace" ? ` and rejection code "${record.rejection.code}"` : ""
      }, whose evidence is a property of the Forguncy runtime; the record must name the target it was observed under.`,
    );
  }

  return problems;
}

function validateProbedWith(where: string, record: LockedDependencyDecision): readonly string[] {
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
  // once a probe has run the identity itself cannot be absent, or a Vite+ upgrade
  // could never invalidate this evidence and the record would be verified for
  // ever. A probe that never ran has no toolchain to record.
  if (probe.status !== "not-run" && probedWith === null) {
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
 * Throws unless the document is structurally sound, judging no rule.
 *
 * Exported because canonicalization *assumes* the shape — `[...lock.decisions]`,
 * `[...record.evidence]` — so a writer that canonicalizes before validating
 * throws a native `TypeError` from the canonicalizer instead of reporting a
 * broken document. Shape first, canonical form second, rules third; a canonical
 * order this has no opinion about, which is why it is not just
 * `assertFgcLockDocument`.
 */
export function assertFgcLockDocumentShape(input: unknown): void {
  const problems = inspectFgcLockDocument(input);
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
