/**
 * `@forguncy-react-workspace/core` — the executable projection of the
 * architecture decisions that every other package must obey.
 *
 * Governing architecture Spec Issues:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * Scope note: this package states *semantics, boundaries, verified target facts
 * and the dependency-decision model*. It intentionally does not resolve
 * dependencies, bundle anything, or maintain a package compatibility database;
 * those are separate Issues. Reading and writing `fgc.lock.json` as a project
 * artifact is `dependency-resolver`'s job.
 */

export {
  APPLICATION_OWNERSHIP_INVARIANT,
  assertOwnedBy,
  concernsOwnedBy,
  findOwnershipConcern,
  isApplicationOwned,
  ownerOf,
  OwnershipViolationError,
  OWNERSHIP_CONCERNS,
} from "./ownership";
export type { ApplicationOwner, OwnershipConcern, OwnershipConcernId } from "./ownership";

export {
  DEPENDENCY_REJECTION_KINDS,
  ARCHITECTURAL_REJECTION_CODES,
  DEPENDENCY_REJECTION_RESPONSE,
  groupRejectionsByKind,
  isArchitecturalRejection,
  isArchitecturalRejectionCode,
  isTechnicalRejection,
  isTechnicalRejectionCode,
  TECHNICAL_REJECTION_CODES,
} from "./rejection";
export type {
  ArchitecturalDependencyRejection,
  ArchitecturalRejectionCode,
  DependencyRejection,
  DependencyRejectionCode,
  DependencyRejectionKind,
  DependencyRejectionResponse,
  GroupedRejections,
  TechnicalDependencyRejection,
  TechnicalRejectionCode,
} from "./rejection";

export {
  APPLICATION_OWNED_ROLES,
  assessDependencyRole,
  findPlatformConflictRule,
  isApplicationOwnedRole,
  isPlatformConflict,
  isRoleMismatch,
  PLATFORM_CONFLICT_PACKAGE_NAMES,
  PLATFORM_CONFLICT_RULES,
} from "./platform-conflicts";
export type {
  ApplicationOwnedRole,
  DependencyRole,
  PlatformConflict,
  PlatformConflictAllowed,
  PlatformConflictAssessment,
  PlatformConflictRoleMismatch,
  PlatformConflictRule,
  PlatformConflictUnclassified,
} from "./platform-conflicts";

export {
  assertDependencyDecision,
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_STRATEGY_SEMANTICS,
  isDependencyStrategy,
  requiresRealRuntimeValidation,
  strategySemantics,
  validateDependencyDecision,
  validateDependencyDecisionShape,
  validateDependencyVerification,
} from "./strategy";
export type {
  DependencyCheck,
  DependencyCheckLevel,
  DependencyDecision,
  DependencyStrategy,
  DependencyStrategySemantics,
  DependencyVerificationEvidence,
  ExtensionDependencyDecision,
  HostDependencyDecision,
  InlineDependencyDecision,
  ReplaceDependencyDecision,
} from "./strategy";

export {
  citesDecision,
  citesEveryArchitectureDecision,
  citationPatternsFor,
  DECISION_CITATION_PATTERNS,
  decisionReference,
  DEPENDENCY_LOCK_CITATION_PATTERNS,
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_LOCK_DECISION_QUALIFIED_REFERENCE,
  DEPENDENCY_LOCK_DECISION_REFERENCE,
  formatDecisionReference,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE,
  GOVERNING_SPEC_REFERENCE_LINE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
  qualifiedDecisionReference,
  RUNTIME_CONTRACT_CITATION_PATTERNS,
  RUNTIME_CONTRACT_DECISION,
  RUNTIME_CONTRACT_DECISION_QUALIFIED_REFERENCE,
  RUNTIME_CONTRACT_DECISION_REFERENCE,
} from "./governance";
export type { ArchitectureDecisionSource } from "./governance";

export {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_ENTRY_RESOLUTION_ORDER,
  CELL_ENTRY_SHAPES,
  CELL_FORGUNCY_FACADE,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_HOST_RUNTIME_SEMANTICS,
  CELL_PRESET_LIBRARIES,
  CELL_PRESET_LIBRARY_DEFAULT,
  CELL_PROPS_BASE_KEYS,
  CELL_PROPS_KEY_ORDER,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  CELL_SERVER_COMMANDS_CONTRACT,
  CELL_SERVER_COMMAND_RESULT_KEYS,
  CELL_SOURCE_EXECUTION_MODEL,
  CELL_SOURCE_REJECTIONS,
  CELL_SOURCE_REJECTION_ENVELOPE,
  CELL_SOURCE_SIZE_OBSERVATIONS,
  CELL_SOURCE_VALIDATION_MECHANISM,
  CELL_USER_SCOPE_BINDINGS,
  cellSourceValidationVisitsAstKey,
  cellUserScopeBinding,
  describeRuntimeContractTarget,
  emitCellEntryShapes,
  findCellEntryShape,
  findCellHostRuntimeFact,
  findCellPresetLibrary,
  findCellSourceRejection,
  FRONTEND_LIBRARY_REFERENCE_CONTRACT,
  FRONTEND_LIBRARY_REFERENCE_EXAMPLE,
  FRONTEND_LIBRARY_RUNTIME_SEMANTICS,
  nonWorkingCellEntryShapes,
  openRuntimeContractQuestions,
  persistedDefaultCellPreset,
  rejectedCellSourceConstructs,
  RUNTIME_CONTRACT_TARGET,
  RUNTIME_CONTRACT_UNKNOWNS,
  RUNTIME_EVIDENCE_CHANNELS,
} from "./runtime-contract";
export type {
  CellBindingAvailability,
  CellEntryKind,
  CellEntryResolutionStep,
  CellEntryShape,
  CellHostRuntimeFact,
  CellHostRuntimeFactId,
  CellPresetLibrary,
  CellSourceExecutionModel,
  CellSourceRejection,
  CellSourceRejectionId,
  CellSourceValidationMechanism,
  CellUserScopeBinding,
  FrontendLibraryReference,
  RuntimeContractTarget,
  RuntimeContractUnknown,
  RuntimeEvidenceChannel,
} from "./runtime-contract";

export {
  assertFgcLockDocument,
  assertFgcLockDocumentShape,
  assertSupportedFgcLockSchemaVersion,
  canonicalizeFgcLock,
  compareEvidenceLinks,
  compareLockDecisions,
  createEmptyFgcLock,
  DECISION_EVIDENCE_KINDS,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockSchemaVersionError,
  FgcLockValidationError,
  findMachineSpecificPaths,
  forguncyTargetIdentity,
  inspectFgcLockDocument,
  isCanonicallyOrdered,
  isEvidenceReference,
  isEvidenceUrl,
  isRepositoryRelativeReference,
  isSupportedFgcLockSchemaVersion,
  LOCK_EVIDENCE_POLICY,
  LOCK_EVIDENCE_PROFILES,
  LOCK_GOVERNING_DECISIONS,
  LOCK_GOVERNING_SPEC_REFERENCE_LINE,
  LOCK_PROBE_REQUIREMENTS,
  lockEvidencePolicyFor,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  parseFgcLockDocument,
  PROBE_STATUSES,
  requiresRuntimeValidation,
  requiresTargetIdentity,
  RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES,
  serializeFgcLock,
  SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS,
  validateFgcLockDocument,
} from "./lock";
export type {
  DecisionEvidenceKind,
  DecisionEvidenceLink,
  ExtensionEvidence,
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockedDependencyDecision,
  LockEvidencePolicy,
  LockEvidenceProfile,
  LockProbeEvidence,
  LockProbeRequirement,
  LockRecordMetadata,
  ProbeStatus,
  RejectedCandidateEvidence,
  ToolchainIdentity,
} from "./lock";

export {
  FGC_LOCK_MIGRATION_STEPS,
  findFgcLockMigrationStep,
  FgcLockMigrationError,
  FgcLockMigrationStepError,
  migrateFgcLockDocument,
  migratableFgcLockSchemaVersions,
  parseMigratedFgcLockDocument,
  planFgcLockMigration,
  validateFgcLockMigrationSteps,
} from "./lock-migration";
export type { FgcLockMigrationOptions, FgcLockMigrationResult, FgcLockMigrationStep } from "./lock-migration";

export {
  assessLockDecision,
  findLockDecision,
  LOCK_FRESHNESS_STATES,
  LOCK_REAL_RUNTIME_VALIDATIONS,
  LOCK_STALENESS_REASONS,
  lockDecisionBlockers,
  resolveLockDecision,
} from "./lock-freshness";
export type {
  LockDecisionAssessment,
  LockDecisionQuery,
  LockDecisionResolution,
  LockDecisionState,
  LockEnvironment,
  LockFreshness,
  LockRealRuntimeValidation,
  LockStalenessReason,
} from "./lock-freshness";
