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
 * What is implemented here:
 *
 * - the lock as a project artifact — read (with migration), write, upsert,
 *   remove, exact-key and target-preferring lookup (`lock-store`);
 * - the projection onto compilation, which hands the compiler verified decisions
 *   only (`lock-store`), plus the clearly local-only projection
 *   (`localCompilationDependencies`) — freshness enforced, real-runtime
 *   validation deliberately relaxed while `target` is honestly null, never a
 *   shipping path;
 * - the exact installed versions the staleness rules compare against, read out of
 *   the workspace install graph (`install-graph`);
 * - the update API an Agent or probe flow records through, which merges a
 *   measurement into a record instead of replacing the record (`decision-recording`);
 * - conformance auditing against the facts a lock cannot contain — the target's
 *   host globals (#9) and the verified extension catalog (#12)
 *   (`decision-conformance`);
 * - the deterministic dependency probe engine that produces the evidence a
 *   lock record cites (`probe/*`): nine protocol steps, one canonical
 *   `ProbeReport`, a recomputable fingerprint and a file cache under
 *   `.fgc/probe-cache/` (#17).
 *
 * The decision model, its validation, its canonical form, its migration chain and
 * its freshness rules are re-exported from `core` so a consumer of this package
 * gets the whole `fgc.lock.json` contract without reaching into a second import.
 *
 * What is *not* implemented here: the Agent-driven library selection that decides
 * a strategy in the first place (`Implement: Forguncy React dependency-selection
 * Agent Skill` #18). Composing a probe fingerprint is #17's; selecting a package
 * from a probe's assessment remains the Agent's job.
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
  assertFgcLockDocumentShape,
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
  requiresRuntimeValidation,
  requiresTargetIdentity,
  resolveLockDecision,
  RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES,
  serializeFgcLock,
  validateFgcLockDocument,
} from "@forguncy-react-workspace/core";

export {
  compilationDependencies,
  fgcLockPath,
  findExactLockDecision,
  localCompilationDependencies,
  readFgcLock,
  recordedPackageNames,
  removeLockDecision,
  upsertLockDecision,
  writeFgcLock,
} from "./lock-store.ts";
export type {
  CompilationDependencies,
  CompilationDependencyOptions,
  LocalCompilationDependencyOptions,
  WithheldCompilationDependency,
} from "./lock-store.ts";

export { resolveInstalledVersions } from "./install-graph.ts";
export type {
  InstalledVersions,
  UnresolvedInstalledPackage,
  UnresolvedInstalledPackageReason,
} from "./install-graph.ts";

export {
  mergeDependencyDecisionUpdate,
  recordDependencyDecision,
  recordDependencyDecisions,
} from "./decision-recording.ts";
export type {
  DependencyDecisionUpdate,
  RecordedDependencyDecision,
  RecordedDependencyDecisions,
} from "./decision-recording.ts";

export {
  auditLockDecisionConformance,
  conformanceErrors,
  CONFORMANCE_PROBLEM_CODES,
  DEFAULT_HOST_BRIDGE_MANIFEST,
  JSX_RUNTIME_MODULE_IDS,
  PRESET_PROVIDED_HOST_GLOBALS,
  validateLockDecisionConformance,
} from "./decision-conformance.ts";
export type {
  ConformanceDiagnostic,
  ConformanceOptions,
  ConformanceProblemCode,
  ConformanceSeverity,
  ExtensionCatalog,
  HostBridgeManifest,
  HostBridgeMapping,
  PresetProvidedGlobal,
  VerifiedExtensionMapping,
} from "./decision-conformance.ts";

// ---------------------------------------------------------------------------
// The dependency probe engine (#17)
// ---------------------------------------------------------------------------

export {
  probeLockEnvironment,
  probeRunLockEvidence,
  ProbeIdentityError,
  runDependencyProbe,
} from "./probe/probe-engine.ts";
export type {
  DependencyProbeResult,
  ProbeLockEnvironmentOptions,
  PreSmokeReport,
  RuntimeSmokeHook,
  RuntimeSmokeResult,
  ResolvedPackageIdentity,
  RunDependencyProbeOptions,
} from "./probe/probe-engine.ts";

export { composeProbeFingerprint } from "./probe/fingerprint.ts";
export type { ComposedProbeFingerprint, ComposeProbeFingerprintInput } from "./probe/fingerprint.ts";

export { createFileProbeCache, PROBE_CACHE_DIRECTORY, probeCacheRelativePath } from "./probe/cache.ts";
export type { ProbeCache } from "./probe/cache.ts";

export { BUILD_CONFIGURATION_FINGERPRINT, probeEntryPath, runCandidateBuild } from "./probe/build.ts";
export type { CandidateBuildOptions, CandidateBuildResult } from "./probe/build.ts";

export { findNodeOnlySpecifiers, observeNodeBuiltins } from "./probe/node-scan.ts";
export type { NodeScanObservation } from "./probe/node-scan.ts";

// Which files a browser build can reach, and what a package's source actually says.
// Exported because both are answers a consumer may want to re-check independently of
// a probe report — the reachability rule is what makes a "no Node builtins" finding
// mean "not in the artifact" rather than "not in any file the package ships".
export {
  ACTIVE_EXPORT_CONDITIONS,
  FALLBACK_BROWSER_FIELDS,
  resolveBrowserEntryPaths,
  resolveSelfReferenceSubpath,
  selfReferenceResolver,
} from "./probe/browser-entry.ts";
export type { BrowserEntryResolution } from "./probe/browser-entry.ts";

export {
  analyzeModuleSource,
  collectReachableSourceFiles,
  isRelativeSpecifier,
  maskComments,
  sourceWithoutComments,
} from "./probe/module-source.ts";
export type {
  CommentRange,
  ImportReference,
  ImportReferenceKind,
  ModuleSourceAnalysis,
  PackageSourceFile,
  ReachableSourceResult,
  SelfReferenceResolver,
} from "./probe/module-source.ts";

export { observeExportMetadata } from "./probe/export-metadata.ts";
export type { ExportMetadataObservation } from "./probe/export-metadata.ts";

export { observeArtifact } from "./probe/artifact-scan.ts";
export type { ArtifactScanObservation } from "./probe/artifact-scan.ts";

export { observeAssets } from "./probe/asset-inventory.ts";
export type { AssetInventoryObservation } from "./probe/asset-inventory.ts";

export { observeRuntimePatterns } from "./probe/runtime-pattern-scan.ts";
export type { RuntimePatternObservation } from "./probe/runtime-pattern-scan.ts";

export { measureArtifactSize, observeSize } from "./probe/size.ts";
export type { ArtifactSize, SizeObservation } from "./probe/size.ts";

export {
  buildProbeEnvironment,
  defaultProbeTarget,
  normalizeSourceReference,
  resolvePackageIdentity,
} from "./probe/identity.ts";

export { describeBuildFailureLines, portableText, stripAnsi } from "./probe/scan-utils.ts";

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
