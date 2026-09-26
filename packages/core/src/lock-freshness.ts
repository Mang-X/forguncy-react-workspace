/**
 * Is a recorded decision still usable? Two separate questions.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" — with the architecture Specs #4 (strategy semantics) and
 * #5 (verified target contract) governing the answers.
 *
 * The review of the first draft collapsed both questions into one `verified`
 * flag, which contradicted #4: `strategy.ts` declares `realRuntimeRequired: true`
 * for every strategy, so a passing local probe can never on its own be a Forguncy
 * runtime compatibility claim. Calling both things "verified" made an
 * `inline` record with no target look as strong as one validated in a real page.
 *
 * So there are two independent axes:
 *
 * - **freshness** — is the recorded technical evidence still about the inputs we
 *   have now? (`fresh` | `stale`) Answering it needs the current probe input
 *   fingerprint, resolved versions, target, toolchain and extension identity, and
 *   it is a pure comparison: nothing is re-run.
 * - **real-runtime validation** — did the strategy's real-runtime checks run
 *   against a named target? (`validated` | `not-validated` | `not-required`)
 *
 * A record is `verified` only when it is fresh *and* its profile does not owe a
 * runtime check that has not happened. The axes stay separate in the result
 * because the two answers send a caller in different directions: `stale` means
 * re-run the probe, `not-validated` means the local evidence is current but the
 * Forguncy-side check is still missing.
 *
 * Fail-closed rule: where a current input is not available, the record is not
 * verified. "Cannot prove the inputs are unchanged" and "the inputs changed" both
 * mean the same thing to a consumer — do not treat this evidence as valid — and a
 * lock whose whole purpose is reproducibility must not be the one place that
 * guesses in favour of the newer claim.
 */

import type { LockedDependencyDecision, LockEvidenceProfile, LockEvidencePolicy } from "./lock.ts";
import {
  forguncyTargetIdentity,
  LOCK_EVIDENCE_POLICY,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  requiresRuntimeValidation,
} from "./lock.ts";
import type { ForguncyTargetIdentity, ToolchainIdentity } from "./lock.ts";
import { isArtifactObservedRejectionCode } from "./rejection.ts";
import { isSubjectCompileDecision } from "./strategy.ts";
import type { RuntimeContractTarget } from "./runtime-contract.ts";

export const LOCK_STALENESS_REASONS = [
  "probe-never-run",
  "probe-failed",
  "probe-fingerprint-changed",
  "probe-fingerprint-unknown",
  "package-version-changed",
  "package-version-unknown",
  "rejected-candidate-version-changed",
  "forguncy-target-changed",
  "forguncy-target-unknown",
  "toolchain-changed",
  "toolchain-unknown",
  "extension-version-changed",
  "extension-version-unknown",
  "extension-identity-changed",
  "extension-identity-unknown",
  "artifact-evidence-missing",
  "artifact-compile-changed",
  "artifact-compile-unknown",
  "artifact-attribution-changed",
  "artifact-verdict-changed",
  "artifact-subject-decision-unreplayable",
] as const;
export type LockStalenessReason = (typeof LOCK_STALENESS_REASONS)[number];

export const LOCK_FRESHNESS_STATES = ["fresh", "stale"] as const;
export type LockFreshness = (typeof LOCK_FRESHNESS_STATES)[number];

export const LOCK_REAL_RUNTIME_VALIDATIONS = ["validated", "not-validated", "not-required"] as const;
export type LockRealRuntimeValidation = (typeof LOCK_REAL_RUNTIME_VALIDATIONS)[number];

/** What the workspace looks like now, against which a record is judged. */
/**
 * Everything a record's compile evidence states, as the current compile reports it.
 *
 * The four fields are exactly the reproducible half of `ArtifactBudgetEvidence` — the artifact's
 * identity, its measured size, the cap it was measured against, and the subject's rendered share —
 * so freshness can compare the whole evidence shape rather than a subset of it. A field left out is
 * a field a forged record can keep, which is how `codeCharacters` and `budgetCharacters` survived
 * as trusted input until revision 18 despite stating the hard rejection.
 *
 * Deliberately *not* here: `subjectDecision` (a replay input, not a compile output — freshness
 * checks it is legal, the recorder replays it) and the two `CompileCellOutcome` fields the compiler
 * does not report.
 */
export interface ArtifactCompileSnapshot {
  /** `composeCellCompileFingerprint` over the composed artifact and the cap. */
  readonly fingerprint: string;
  /** Characters in the composed Cell, as the compile measured them. */
  readonly codeCharacters: number;
  /** The cap that compile was given, read from the Cell's own declaration. */
  readonly budgetCharacters: number;
  /** Characters the subject's own modules contributed. */
  readonly subjectRenderedCharacters: number;
}

export interface LockEnvironment {
  /** Exact resolved versions installed for this workspace, by package name. */
  readonly resolvedVersions: Readonly<Record<string, string>>;
  /**
   * The target this compilation is being planned for.
   *
   * Null means the caller cannot say, which is not the same as "unchanged": a
   * record that made a runtime claim cannot be confirmed against an unknown
   * target, so it reports `forguncy-target-unknown` rather than passing.
   */
  readonly target: RuntimeContractTarget | null;
  /** The toolchain running now. */
  readonly toolchain: ToolchainIdentity | null;
  /**
   * The probe input fingerprint as it is now, by package name.
   *
   * Keyed by package because an environment describes one compilation for one
   * cell target; the Cell target itself is part of the query. Computable without
   * running the probe, because a fingerprint is a function of the probe's
   * declared inputs (see `LockProbeEvidence.fingerprint`). A package missing from
   * the map is a stale answer rather than a pass.
   */
  readonly probeFingerprints: Readonly<Record<string, string>>;
  /**
   * What each compile-observed rejection's Cell currently compiles to, keyed by the **record
   * identity** `packageName\u0000cellTarget`.
   *
   * One value carrying everything the record's own evidence states, rather than a map per field:
   * those all describe one compile, and separate maps could be updated independently — leaving a
   * record whose artifact identity is current but whose verdict numbers are stale, or vice versa.
   * Revision 17 made that mistake for the attribution; revision 18 closes it for the verdict too.
   *
   * Keyed by record rather than by Cell because *which* Cell state a rejection was measured from is
   * a property of the record: two rejections in one Cell may have been recorded from different
   * states, and one fingerprint per Cell could only answer for one of them.
   *
   * A record missing from the map is `artifact-compile-unknown` rather than a pass.
   *
   * Optional, because a caller that compiles nothing — the probe's own environment, a fixture — has
   * no compile to describe. Absent means the same thing an absent entry does.
   */
  readonly artifactFingerprints?: Readonly<Record<string, ArtifactCompileSnapshot>>;
  /** Installed extension versions by `libraryId`, when known. */
  readonly extensionVersions: Readonly<Record<string, string>>;
  /** Installed extension content identities by `libraryId`, when known. */
  readonly extensionIdentities: Readonly<Record<string, string>>;
}

export interface LockDecisionAssessment {
  readonly profile: LockEvidenceProfile;
  readonly freshness: LockFreshness;
  readonly stalenessReasons: readonly LockStalenessReason[];
  readonly realRuntimeValidation: LockRealRuntimeValidation;
}

/**
 * Whether a record's evidence still holds, and whether it ever held for the
 * runtime.
 *
 * Rule 2 of #8: an exact package version change invalidates probe evidence
 * unless the record states the probe was proven version-independent.
 * Rule 3: a Forguncy runtime change invalidates runtime-sensitive evidence.
 * Rule 4: a `replace` record compiles nothing, so a *technical* rejection is
 * re-opened by a candidate, toolchain or target change, while an architectural
 * one is not re-opened by anything.
 */
export function assessLockDecision(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
): LockDecisionAssessment {
  const profile = lockEvidenceProfileOf(record);
  const policy = LOCK_EVIDENCE_POLICY[profile];
  const reasons: LockStalenessReason[] = [];

  reasons.push(...assessProbeFreshness(record, environment, policy));
  reasons.push(...assessPackageVersionFreshness(record, environment, policy));
  reasons.push(...assessTargetFreshness(record, environment, policy));
  reasons.push(...assessToolchainFreshness(record, environment));
  reasons.push(...assessExtensionFreshness(record, environment));
  reasons.push(...assessArtifactEvidenceFreshness(record, environment));

  return {
    profile,
    freshness: reasons.length === 0 ? "fresh" : "stale",
    stalenessReasons: reasons,
    realRuntimeValidation: realRuntimeValidationOf(record),
  };
}

function assessProbeFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
  policy: LockEvidencePolicy,
): readonly LockStalenessReason[] {
  const { probe } = record;
  const reasons: LockStalenessReason[] = [];

  if (policy.probeRequirement !== "none") {
    if (probe.status === "not-run") {
      reasons.push("probe-never-run");
    } else if (policy.probeRequirement === "passed" && probe.status !== "passed") {
      // A failed probe on a dependency is a legitimate record — an Agent should
      // be able to see the attempt — so it reports as stale here instead of
      // being refused when the record is written.
      reasons.push("probe-failed");
    }
  }

  // The fingerprint is why a change to the entry or the probe configuration is
  // detected at all: every version in the record can still match while the thing
  // that was measured has moved. It covers only the inputs no other field
  // models, so a version, target or toolchain change is reported once, by its
  // own reason, rather than also as a fingerprint change.
  if (probe.status !== "not-run" && probe.fingerprint !== null) {
    const current = environment.probeFingerprints[record.packageName];
    if (current === undefined) {
      reasons.push("probe-fingerprint-unknown");
    } else if (current !== probe.fingerprint) {
      reasons.push("probe-fingerprint-changed");
    }
  }

  return reasons;
}

function assessPackageVersionFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
  policy: LockEvidencePolicy,
): readonly LockStalenessReason[] {
  if (record.probe.versionIndependent) {
    return [];
  }

  if (record.strategy === "replace") {
    // A rejection is about the exact candidate that failed, so the version that matters is the
    // rejected one — and its movement is what re-opens the decision instead of letting it stand
    // forever. Every rejection that *records* a rejected candidate is assessed, not just the
    // probe-observed profile (#77 round 5, P1): an `artifact-rejection` records one too, so gating
    // on the profile let a genuinely smaller candidate keep an old size rejection reporting
    // `fresh`. `rejectedCandidate === null` is the architectural case, which has no version to
    // compare and no bundle to re-measure.
    if (record.rejectedCandidate === null) {
      return [];
    }
    const installed = environment.resolvedVersions[record.packageName];
    if (installed === undefined) {
      return ["package-version-unknown"];
    }
    return installed === record.rejectedCandidate.version ? [] : ["rejected-candidate-version-changed"];
  }

  if (record.resolvedVersion === null) {
    return [];
  }

  const installed = environment.resolvedVersions[record.packageName];
  if (installed === undefined) {
    return ["package-version-unknown"];
  }
  return installed === record.resolvedVersion ? [] : ["package-version-changed"];
}

function assessTargetFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
  policy: LockEvidencePolicy,
): readonly LockStalenessReason[] {
  if (!policy.invalidatedByTargetChange || record.target === null) {
    return [];
  }

  const current: ForguncyTargetIdentity | null =
    environment.target === null ? null : forguncyTargetIdentity(environment.target);

  if (current === null) {
    return ["forguncy-target-unknown"];
  }
  return matchesForguncyTargetIdentity(record.target, current) ? [] : ["forguncy-target-changed"];
}

function assessToolchainFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
): readonly LockStalenessReason[] {
  const recorded = record.probedWith?.vitePlus ?? null;
  const current = environment.toolchain?.vitePlus ?? null;

  if (recorded === null) {
    return [];
  }
  if (current === null) {
    return ["toolchain-unknown"];
  }
  return current === recorded ? [] : ["toolchain-changed"];
}

function assessExtensionFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
): readonly LockStalenessReason[] {
  if (record.strategy !== "extension" || record.extension === null) {
    return [];
  }

  const reasons: LockStalenessReason[] = [];
  const { version, identity } = record.extension;
  const { libraryId } = record;

  // A version-only or identity-only record is only half checkable, which is why
  // either half being unknown is a stale answer rather than a pass: the caller
  // cannot show the extension is still the one the cell was validated against.
  if (version !== null) {
    const current = environment.extensionVersions[libraryId];
    if (current === undefined) {
      reasons.push("extension-version-unknown");
    } else if (current !== version) {
      reasons.push("extension-version-changed");
    }
  }

  if (identity !== null) {
    const current = environment.extensionIdentities[libraryId];
    if (current === undefined) {
      reasons.push("extension-identity-unknown");
    } else if (current !== identity) {
      reasons.push("extension-identity-changed");
    }
  }

  return reasons;
}

/**
 * Whether a compile-observed rejection still carries evidence that describes the *current* Cell.
 *
 * #77 revision 14 gave `cell-code-budget-exceeded` a real evidence shape and revision 15 bound it
 * to the compile that produced it, so this axis answers two questions in order:
 *
 * 1. **Is there evidence at all?** A record written before revision 14 cites the code with none.
 *    Reporting that here rather than refusing it at parse time is deliberate: an existing lock has
 *    to stay **readable and stale** (`lock-migration.ts`), and a migration must not silently
 *    delete or re-decide what it cannot interpret.
 * 2. **Is it still the same compile?** The recorded `compileFingerprint` covers the composed
 *    artifact's bytes, the dependency decision set and the cap. If the entry (or anything it
 *    imports) changed, or a dependency decision moved, this workspace would now compose a
 *    different artifact — and a size verdict about the old one must not report `fresh`. This is the
 *    question the round-5 review asked for, and the reason the fingerprint exists.
 *
 * A Cell the environment cannot compile is `artifact-compile-unknown` rather than a pass, for the
 * same reason a missing probe fingerprint is: an absent answer is not agreement. A record whose
 * code is *not* compile-observed is untouched — the shape validator already refuses artifact
 * evidence under any other code, so there is no second case to assess here.
 */
function assessArtifactEvidenceFreshness(
  record: LockedDependencyDecision,
  environment: LockEnvironment,
): readonly LockStalenessReason[] {
  if (record.strategy !== "replace" || record.rejection.kind !== "technical") {
    return [];
  }
  if (!isArtifactObservedRejectionCode(record.rejection.code)) {
    return [];
  }

  const evidence = record.artifactEvidence;
  if (evidence === undefined) {
    return ["artifact-evidence-missing"];
  }

  // A record with no Cell target cannot be compared against a compile at all. Revision 15 requires
  // a concrete target for *new* compile-observed rejections, so this is the pre-revision-15 shape —
  // reportable as stale rather than invalid, so the lock stays readable.
  if (record.cellTarget === null) {
    return ["artifact-compile-unknown"];
  }

  // The pre-revision-18 subject shape, which revision 16's own writer could emit: a `replace` that
  // overwrote the subject's real decision on a re-record. The record is *readable* — the parser
  // accepts it on purpose — but it cannot be replayed, because a `replace` keeps the package out of
  // the Cell the record names. Reported as its own reason rather than as `artifact-compile-unknown`
  // so a reader can tell "nobody has recompiled this" from "this can never be recompiled as
  // written", which need different fixes.
  if (!isSubjectCompileDecision(evidence.subjectDecision)) {
    return ["artifact-subject-decision-unreplayable"];
  }

  const current = environment.artifactFingerprints?.[lockRecordIdentity(record)];
  if (current === undefined) {
    return ["artifact-compile-unknown"];
  }
  const reasons: LockStalenessReason[] = [];
  // The artifact identity: an edit to anything the entry reaches, a moved dependency decision, or a
  // changed cap all move this.
  if (current.fingerprint !== evidence.compileFingerprint) {
    reasons.push("artifact-compile-changed");
  }
  // The verdict's own two numbers (#77 revision 18), recomputed rather than trusted. Revision 17
  // compared the fingerprint and the attribution but not these, so a record could keep a real
  // fingerprint — the artifact is genuinely the one it names — beside a forged `codeCharacters`
  // and stay fresh, reporting a hard rejection the current compiler does not emit. `codeCharacters`
  // is not in the fingerprint (the fingerprint is a hash, not a size), so nothing else caught it.
  if (current.codeCharacters !== evidence.codeCharacters || current.budgetCharacters !== evidence.budgetCharacters) {
    reasons.push("artifact-verdict-changed");
  }
  // The attribution is advisory evidence, so a moved share is reported rather than refused: a reader
  // weighs it, and the record still says truthfully what was measured at the time.
  if (current.subjectRenderedCharacters !== evidence.subjectRenderedCharacters) {
    reasons.push("artifact-attribution-changed");
  }
  return reasons;
}

/**
 * Rule 4 of #4 for one record.
 *
 * `validated` means the record names a target, and validation only lets a target
 * be recorded once a probe against it has passed — so the presence of the target
 * is the whole claim.
 */
function realRuntimeValidationOf(record: LockedDependencyDecision): LockRealRuntimeValidation {
  if (!requiresRuntimeValidation(record)) {
    return "not-required";
  }
  return record.target === null ? "not-validated" : "validated";
}

export type LockDecisionState = "verified" | "stale" | "missing";

export interface LockDecisionQuery {
  readonly packageName: string;
  /** Defaults to null, i.e. the target-independent record. */
  readonly cellTarget?: string | null;
}

/**
 * Finds the record for a package, preferring one declared for the given cell
 * target over the target-independent record for the same package.
 */
/**
 * The identity of one lock record: `(packageName, cellTarget)`.
 *
 * Exported because it is what both the lock's keying and `LockEnvironment.artifactFingerprints`
 * key on, and two spellings of it — one in a caller, one here — would silently make every lookup
 * miss. The separator is a NUL because neither half can contain one, so no pair of names can
 * compose another pair's key.
 */
export function lockRecordIdentity(record: {
  readonly packageName: string;
  readonly cellTarget: string | null;
}): string {
  return `${record.packageName}\u0000${record.cellTarget ?? ""}`;
}

export function findLockDecision(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  query: LockDecisionQuery,
): LockedDependencyDecision | null {
  const cellTarget = query.cellTarget ?? null;
  const forPackage = lock.decisions.filter(record => record.packageName === query.packageName);
  return (
    forPackage.find(record => record.cellTarget === cellTarget) ??
    forPackage.find(record => record.cellTarget === null) ??
    null
  );
}

export interface LockDecisionResolution {
  /**
   * `verified` — fresh, and every runtime check this profile owes has happened.
   * `stale` — not usable as evidence; see `assessment.stalenessReasons` and
   * `assessment.realRuntimeValidation` for which of the two sent it here.
   * `missing` — the lock holds no decision for the query.
   */
  readonly state: LockDecisionState;
  readonly record: LockedDependencyDecision | null;
  /** Null only when `state` is `missing`: there is nothing to assess. */
  readonly assessment: LockDecisionAssessment | null;
}

export function resolveLockDecision(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  query: LockDecisionQuery,
  environment: LockEnvironment,
): LockDecisionResolution {
  const record = findLockDecision(lock, query);
  if (record === null) {
    return { state: "missing", record: null, assessment: null };
  }

  const assessment = assessLockDecision(record, environment);
  const verified = assessment.freshness === "fresh" && assessment.realRuntimeValidation !== "not-validated";
  return { state: verified ? "verified" : "stale", record, assessment };
}

/**
 * The blocker a caller reports when a decision cannot be used, in the vocabulary
 * of the two axes rather than a bare boolean.
 */
export function lockDecisionBlockers(assessment: LockDecisionAssessment): readonly string[] {
  const blockers = [...assessment.stalenessReasons] as string[];
  if (assessment.realRuntimeValidation === "not-validated") {
    blockers.push("real-runtime-not-validated");
  }
  return blockers;
}
