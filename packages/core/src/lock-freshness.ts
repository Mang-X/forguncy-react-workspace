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

import type { LockedDependencyDecision, LockEvidenceProfile, LockEvidencePolicy } from "./lock";
import {
  forguncyTargetIdentity,
  LOCK_EVIDENCE_POLICY,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  requiresRuntimeValidation,
} from "./lock";
import type { ForguncyTargetIdentity, ToolchainIdentity } from "./lock";
import type { RuntimeContractTarget } from "./runtime-contract";

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
] as const;
export type LockStalenessReason = (typeof LOCK_STALENESS_REASONS)[number];

export const LOCK_FRESHNESS_STATES = ["fresh", "stale"] as const;
export type LockFreshness = (typeof LOCK_FRESHNESS_STATES)[number];

export const LOCK_REAL_RUNTIME_VALIDATIONS = ["validated", "not-validated", "not-required"] as const;
export type LockRealRuntimeValidation = (typeof LOCK_REAL_RUNTIME_VALIDATIONS)[number];

/** What the workspace looks like now, against which a record is judged. */
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
    // A technical rejection is about the exact candidate that failed, so the
    // version that matters is the rejected one — and its movement is what
    // re-opens the decision instead of letting it stand forever.
    if (policy.profile !== "technical-rejection" || record.rejectedCandidate === null) {
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
