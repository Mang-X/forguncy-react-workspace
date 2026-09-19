/**
 * `@forguncy-react-workspace/dependency-resolver` — turning recorded dependency
 * decisions into something a compiler and an Agent can act on.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/8
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * What is implemented here: the lock as a project artifact (read, write, upsert,
 * remove) and the projection onto compilation. The decision model, its
 * validation, its canonical form and its freshness rules are re-exported from
 * `core` so a consumer of this package gets the whole `fgc.lock.json` contract
 * without reaching into a second import.
 *
 * What is *not* implemented here: the empirical probe that produces the evidence
 * a record cites (`Implement: deterministic dependency probe engine` #17) and the
 * Agent-driven library selection that decides a strategy in the first place
 * (`Implement: Forguncy React dependency-selection Agent Skill` #18). Neither is
 * a non-goal of #8; both are downstream of it. Composing a probe fingerprint is
 * #17's, which is why this package only compares the values it is given.
 */

import type { DependencyDecision } from "@forguncy-react-workspace/core";

export type {
  DecisionEvidenceKind,
  DecisionEvidenceLink,
  DependencyCheck,
  DependencyCheckLevel,
  DependencyDecision,
  DependencyStrategy,
  ExtensionEvidence,
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockDecisionAssessment,
  LockDecisionQuery,
  LockDecisionResolution,
  LockDecisionState,
  LockedDependencyDecision,
  LockEnvironment,
  LockEvidencePolicy,
  LockEvidenceProfile,
  LockFreshness,
  LockProbeEvidence,
  LockProbeRequirement,
  LockRealRuntimeValidation,
  LockRecordMetadata,
  LockStalenessReason,
  ProbeStatus,
  RejectedCandidateEvidence,
  ToolchainIdentity,
} from "@forguncy-react-workspace/core";

export {
  assessLockDecision,
  assertFgcLockDocument,
  assertSupportedFgcLockSchemaVersion,
  canonicalizeFgcLock,
  createEmptyFgcLock,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockSchemaVersionError,
  FgcLockValidationError,
  findLockDecision,
  findMachineSpecificPaths,
  forguncyTargetIdentity,
  isCanonicallyOrdered,
  isEvidenceReference,
  isSupportedFgcLockSchemaVersion,
  LOCK_EVIDENCE_POLICY,
  LOCK_EVIDENCE_PROFILES,
  LOCK_GOVERNING_DECISIONS,
  LOCK_GOVERNING_SPEC_REFERENCE_LINE,
  LOCK_STALENESS_REASONS,
  lockDecisionBlockers,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  parseFgcLockDocument,
  resolveLockDecision,
  serializeFgcLock,
  validateFgcLockDocument,
} from "@forguncy-react-workspace/core";

export {
  compilationDependencies,
  fgcLockPath,
  readFgcLock,
  removeLockDecision,
  upsertLockDecision,
  writeFgcLock,
} from "./lock-store";
export type {
  CompilationDependencies,
  CompilationDependencyOptions,
  WithheldCompilationDependency,
} from "./lock-store";

export interface ResolveDependencyInput {
  packageName: string;
  version?: string;
}

/**
 * Placeholder for the probe-driven resolution path.
 *
 * Kept throwing rather than faked: without an executed probe there is no
 * evidence to record, and #8 explicitly rules out auto-selecting a library
 * without Agent reasoning and probe evidence.
 */
export async function resolveDependency(_input: ResolveDependencyInput): Promise<DependencyDecision> {
  throw new Error(
    "Probe-driven dependency resolution is not implemented yet. Recording and reading decisions from `fgc.lock.json` is implemented; producing the evidence belongs to the dependency probe engine (#17) and the dependency-selection Agent Skill (#18).",
  );
}
