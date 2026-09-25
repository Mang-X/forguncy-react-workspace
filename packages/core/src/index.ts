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
 * Spec Issues built on them:
 * - #8 "reproducible dependency decisions and `fgc.lock.json`"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * - #16 "Agent-driven dependency selection and empirical compatibility probe"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/16
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/12
 * - #26 "project configuration and React Cell target declarations"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 *
 * Scope note: this package states *semantics, boundaries, verified target facts,
 * the dependency-decision model, and the selection/probe policy*. It intentionally
 * does not resolve dependencies, bundle anything, run a probe, or maintain a
 * package compatibility database; those are separate Issues. Reading and writing
 * `fgc.lock.json` as a project artifact is `dependency-resolver`'s job. The
 * project configuration contract (#26) it does own stops at declaring and
 * normalizing "which source entry is which Forguncy Cell" — never at acting on a
 * Forguncy project.
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
} from "./ownership.ts";
export type { ApplicationOwner, OwnershipConcern, OwnershipConcernId } from "./ownership.ts";

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
} from "./rejection.ts";
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
} from "./rejection.ts";

export {
  APPLICATION_OWNED_ROLES,
  assessDependencyRole,
  findPlatformConflictRule,
  isApplicationOwnedRole,
  isPlatformConflict,
  isRoleMismatch,
  PLATFORM_CONFLICT_PACKAGE_NAMES,
  PLATFORM_CONFLICT_RULES,
} from "./platform-conflicts.ts";
export type {
  ApplicationOwnedRole,
  DependencyRole,
  PlatformConflict,
  PlatformConflictAllowed,
  PlatformConflictAssessment,
  PlatformConflictRoleMismatch,
  PlatformConflictRule,
  PlatformConflictUnclassified,
} from "./platform-conflicts.ts";

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
} from "./strategy.ts";
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
} from "./strategy.ts";

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
  DEPENDENCY_SELECTION_CITATION_PATTERNS,
  DEPENDENCY_SELECTION_DECISION,
  DEPENDENCY_SELECTION_DECISION_QUALIFIED_REFERENCE,
  DEPENDENCY_SELECTION_DECISION_REFERENCE,
  EXTENSION_EXTERNALS_CITATION_PATTERNS,
  EXTENSION_EXTERNALS_DECISION,
  EXTENSION_EXTERNALS_DECISION_QUALIFIED_REFERENCE,
  EXTENSION_EXTERNALS_DECISION_REFERENCE,
  formatDecisionReference,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE,
  GOVERNING_SPEC_REFERENCE_LINE,
  HOST_BRIDGE_CITATION_PATTERNS,
  HOST_BRIDGE_DECISION,
  HOST_BRIDGE_DECISION_QUALIFIED_REFERENCE,
  HOST_BRIDGE_DECISION_REFERENCE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
  PROJECT_CONFIG_CITATION_PATTERNS,
  PROJECT_CONFIG_DECISION,
  PROJECT_CONFIG_DECISION_QUALIFIED_REFERENCE,
  PROJECT_CONFIG_DECISION_REFERENCE,
  qualifiedDecisionReference,
  RUNTIME_CONTRACT_CITATION_PATTERNS,
  RUNTIME_CONTRACT_DECISION,
  RUNTIME_CONTRACT_DECISION_QUALIFIED_REFERENCE,
  RUNTIME_CONTRACT_DECISION_REFERENCE,
} from "./governance.ts";
export type { ArchitectureDecisionSource } from "./governance.ts";

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
} from "./runtime-contract.ts";
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
} from "./runtime-contract.ts";

// #9 — the host module bridge: which authored import is bound to which host
// identity, what the JSX runtime adapter must preserve, and the diagnostics both
// the build and the running page report under.

export {
  assertHostBridgeContract,
  assertHostBridgeMappingIsAdmissible,
  assertHostBridgeMappingIsNotAnOwnershipConflict,
  assertHostBridgeMappingsAreUnambiguous,
  findHostBridgeModuleMapping,
  hostBridgeAdapterMappings,
  hostBridgeAvailabilityOf,
  hostBridgeBindingFor,
  hostBridgeBindingOf,
  hostBridgeDiagnosticIsBuildTime,
  hostBridgeDiagnosticIsRuntime,
  hostBridgeGlobalIsAlwaysAvailable,
  hostBridgeGlobalMappings,
  hostBridgeIdentityBasis,
  hostBridgeIdentitySensitiveMappings,
  hostBridgeInterceptedModuleIds,
  hostBridgeMappingsForPackage,
  hostBridgeModuleIds,
  hostBridgePresetConditionalGlobals,
  hostBridgeShapeFor,
  HOST_BRIDGE_BINDING_SHAPES,
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_DIAGNOSTIC_CODES,
  HOST_BRIDGE_DIAGNOSTIC_RULES,
  HOST_BRIDGE_GOVERNING_DECISIONS,
  HOST_BRIDGE_GOVERNING_SPEC_REFERENCE_LINE,
  HOST_BRIDGE_IDENTITY_FIELDS,
  HOST_BRIDGE_INTERCEPTION_POINT,
  HOST_BRIDGE_MAPPINGS,
  HOST_BRIDGE_MAPPING_KINDS,
  HOST_BRIDGE_MECHANISM,
  HOST_BRIDGE_NON_GOALS,
  HostBridgeContractError,
  JSX_RUNTIME_ADAPTER_CASES,
  JSX_RUNTIME_ADAPTER_EXPORTS,
  JSX_RUNTIME_ADAPTER_NON_GOALS,
  JSX_RUNTIME_ADAPTER_RULES,
  JSX_RUNTIME_ADAPTER_RULE_IDS,
  packageNameOfModuleId,
  sharedHostBridgeDiagnosticCodes,
} from "./host-bridge.ts";
export type {
  HostBridgeAdapterId,
  HostBridgeAdapterMapping,
  HostBridgeBindingShape,
  HostBridgeDeferredModule,
  HostBridgeDiagnosticCode,
  HostBridgeDiagnosticMoment,
  HostBridgeDiagnosticRule,
  HostBridgeFixOwner,
  HostBridgeGlobalMapping,
  HostBridgeIdentityBasis,
  HostBridgeIdentityField,
  HostBridgeMapping,
  HostBridgeMappingKind,
  HostBridgeModuleIdBinding,
  HostBridgeModuleShape,
  JsxRuntimeAdapterCase,
  JsxRuntimeAdapterExport,
  JsxRuntimeAdapterRule,
  JsxRuntimeAdapterRuleId,
} from "./host-bridge.ts";

// #12 — the `extension` external mapping: which npm import a verified Forguncy
// Frontend Extension stands in for, what keeps the compiled module independent of
// library load order, and the diagnostics the build and the sync report under.

export {
  assertExtensionExternalContract,
  assertExtensionExternalMappingIsAdmissible,
  assertExtensionExternalMappingsAreUnambiguous,
  auditExtensionLibraryMetadata,
  createExtensionExternalDiagnostic,
  extensionExternalDiagnosticCanBeReported,
  extensionExternalDiagnosticRule,
  extensionGlobalClaimReason,
  extensionInterceptedModuleIds,
  extensionMappingForPackage,
  extensionMappingGlobals,
  extensionMappingsForLibrary,
  extensionModuleIds,
  extensionVerificationBasis,
  EXTENSION_EXTERNAL_DIAGNOSTIC_CODES,
  EXTENSION_EXTERNAL_DIAGNOSTIC_MOMENTS,
  EXTENSION_EXTERNAL_DIAGNOSTIC_RULES,
  EXTENSION_EXTERNALS_GOVERNING_DECISIONS,
  EXTENSION_EXTERNALS_GOVERNING_SPEC_REFERENCE_LINE,
  EXTENSION_EXTERNAL_INTERCEPTION_POINT,
  EXTENSION_EXTERNAL_INTEROP_BEHAVIOUR,
  EXTENSION_EXTERNAL_MAPPINGS,
  EXTENSION_EXTERNAL_MECHANISM,
  EXTENSION_EXTERNAL_NON_GOALS,
  EXTENSION_GLOBAL_NAME_PATTERN,
  EXTENSION_GLOBAL_READ_TIMING,
  EXTENSION_LIBRARY_ID_PATTERN,
  EXTENSION_LIBRARY_REFERENCE_FIELD_NAME,
  EXTENSION_LOAD_ORDER_RULES,
  EXTENSION_METADATA_SOURCES,
  EXTENSION_RESERVED_GLOBAL_NAMES,
  EXTENSION_RESERVED_LIBRARY_ID_SEGMENTS,
  EXTENSION_RESERVED_LIBRARY_IDS,
  ExtensionExternalContractError,
  findExtensionExternalMapping,
  formatExtensionExternalDiagnostic,
  formatExtensionExternalDiagnostics,
  isExtensionGlobalName,
  isExtensionLibraryId,
} from "./extension-externals.ts";
export type {
  AuditExtensionLibraryMetadataOptions,
  ExtensionExternalContractOptions,
  ExtensionExternalDiagnostic,
  ExtensionExternalDiagnosticCode,
  ExtensionExternalDiagnosticMoment,
  ExtensionExternalDiagnosticRule,
  ExtensionExternalFixOwner,
  ExtensionExternalMapping,
  ExtensionLibraryListing,
  ExtensionLoadOrderRule,
  ExtensionMetadataSource,
  ExtensionVerificationBasis,
} from "./extension-externals.ts";

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
  lockEvidenceProfileForDecision,
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
} from "./lock.ts";
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
} from "./lock.ts";

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
} from "./lock-migration.ts";
export type { FgcLockMigrationOptions, FgcLockMigrationResult, FgcLockMigrationStep } from "./lock-migration.ts";

export {
  assessLockDecision,
  findLockDecision,
  LOCK_FRESHNESS_STATES,
  LOCK_REAL_RUNTIME_VALIDATIONS,
  LOCK_STALENESS_REASONS,
  lockDecisionBlockers,
  resolveLockDecision,
} from "./lock-freshness.ts";
export type {
  LockDecisionAssessment,
  LockDecisionQuery,
  LockDecisionResolution,
  LockDecisionState,
  LockEnvironment,
  LockFreshness,
  LockRealRuntimeValidation,
  LockStalenessReason,
} from "./lock-freshness.ts";

// #16 — dependency selection: what makes a package a good candidate, what a probe
// must observe, and in what order the Agent is allowed to decide anything.

export {
  decideFromSignals,
  findReplacementSignalRejection,
  findSelectionSignal,
  isSelectionSignalFamily,
  isSelectionSignalId,
  MACHINE_OBSERVED_SIGNAL_INVARIANT,
  NON_EVIDENCE_SIGNAL_SOURCES,
  replacementRejectionFor,
  REPLACEMENT_SIGNAL_REJECTIONS,
  SELECTION_SIGNALS,
  SELECTION_SIGNAL_FAMILIES,
  SELECTION_SIGNAL_FAMILY_SEMANTICS,
  SELECTION_SIGNAL_IDS,
  selectionSignal,
  selectionSignalFamilyOf,
  selectionSignalFamilySemantics,
  selectionSignalsObservedFrom,
  SIGNAL_OBSERVATION_CHANNELS,
  signalsInFamily,
  validateSignalFindings,
} from "./selection-signals.ts";
export type {
  NonEvidenceSignalSource,
  ReplacementSignalRejection,
  SelectionSignal,
  SelectionSignalFamily,
  SelectionSignalFamilySemantics,
  SelectionSignalFinding,
  SelectionSignalId,
  SignalObservationChannel,
  SignalVerdict,
} from "./selection-signals.ts";

export {
  assessProbeReport,
  assertProbeReport,
  assertSupportedProbeReportSchemaVersion,
  canonicalizeProbeReport,
  executedProbeSteps,
  findForbiddenProbeKeys,
  findProbeStep,
  FORBIDDEN_PROBE_REPORT_KEYS,
  hasPassingEvidence,
  inspectProbeReport,
  isProbeStepId,
  isSupportedProbeReportSchemaVersion,
  parseProbeReport,
  PROBE_ASSESSMENT_STATUSES,
  PROBE_DEPLOYMENT_REQUIRED_STEPS,
  PROBE_ENGINE_NON_RESPONSIBILITIES,
  PROBE_EVIDENCE_POLICY,
  PROBE_OUTCOMES,
  probeRisksOf,
  PROBE_REPORT_MACHINE_READABILITY,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_REPORT_SECTIONS,
  PROBE_STEPS,
  PROBE_STEPS_OBSERVING_SIGNAL,
  PROBE_STEP_IDS,
  ProbeReportSchemaVersionError,
  ProbeReportValidationError,
  probeStep,
  probeStepObservesSignal,
  probeStepOrder,
  probeStepsObserving,
  probeSupportsDeployment,
  serializeProbeReport,
  signalObservesForguncyTarget,
  SUPPORTED_PROBE_REPORT_SCHEMA_VERSIONS,
  validateProbeReport,
} from "./probe-protocol.ts";
export type {
  ProbeAssessment,
  ProbeAssessmentStatus,
  ProbeEngineNonResponsibility,
  ProbeEngineNonResponsibilityId,
  ProbeEnvironment,
  ProbeFact,
  ProbeOutcome,
  ProbeRejectionFinding,
  ProbeReport,
  ProbeReportSection,
  ProbeRisk,
  ProbeStep,
  ProbeStepId,
  ProbeValidationEntry,
} from "./probe-protocol.ts";

export {
  ARCHITECTURAL_REJECTION_PROBE_STATUS,
  auditSelectionDecision,
  branchForOwnership,
  CONDITIONAL_SELECTION_STAGES,
  evaluateRepairRecipe,
  findConditionalSelectionStage,
  findSelectionBranch,
  findSelectionStage,
  isConditionalSelectionStage,
  isOwnershipGateFirst,
  isSelectionBranchId,
  isSelectionDecisionRecordable,
  isSelectionStageId,
  lockProbeStatusForAssessment,
  NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT,
  OWNERSHIP_GATE_STAGE_ID,
  probeSupportsStrategy,
  REPAIR_RECIPE_CONDITIONS,
  SELECTION_ACCEPTANCE_CRITERIA,
  SELECTION_AUTHORITIES,
  SELECTION_BRANCHES,
  SELECTION_GOVERNING_DECISIONS,
  SELECTION_GOVERNING_SPEC_REFERENCE_LINE,
  SELECTION_STAGES,
  SELECTION_STAGE_IDS,
  selectionBranch,
  selectionJustificationRequired,
  selectionStage,
  selectionStageOrder,
  SPEC_PROVING_CASES,
  stagesBefore,
  stagesForBranch,
  stagesForIslandDecision,
  stagesSkippedOnEarlyExit,
  stagesWithAuthority,
} from "./selection-policy.ts";
export type {
  ConditionalSelectionStage,
  RepairRecipeAssessment,
  RepairRecipeCondition,
  RepairRecipeConditionId,
  RepairRecipeInput,
  SelectionAcceptanceCriterion,
  SelectionAuditInput,
  SelectionAuthority,
  SelectionBranch,
  SelectionBranchId,
  SelectionStage,
  SelectionStageId,
  SpecProvingCase,
  StrategyProbeSupport,
} from "./selection-policy.ts";

// ---------------------------------------------------------------------------
// Project configuration and React Cell target declarations (#26)
// ---------------------------------------------------------------------------

export {
  CELL_ALLOWED_FIELDS,
  CELL_REFERENCE_PATTERN,
  CONFIG_ALLOWED_FIELDS,
  DEFAULT_CODE_MARKER_NAMESPACE,
  DEFAULT_DEPENDENCY_LOCK_PATH,
  DEFAULT_FORGUNCY_CONFIG_FILE,
  DEPENDENCY_DECISION_FIELD_NAMES,
  defineForguncyConfig,
  FORGUNCY_CONFIG_FILE_CANDIDATES,
  FORGUNCY_CONFIG_SCHEMA_VERSION,
  isConfigRecord,
  normalizeCellReference,
  RUNTIME_ALLOWED_FIELDS,
  TARGET_LOCATOR_FINALIZATION,
  TARGET_LOCATOR_MODEL,
  targetLocatorKey,
} from "./forguncy-config.ts";
export type {
  CellCodeBudgetOverrides,
  CellConfig,
  ForguncyConfig,
  ForguncyConfigSchemaVersion,
  ForguncyTargetLocator,
  RuntimeTargetConfig,
  TargetLocatorModel,
} from "./forguncy-config.ts";

export {
  CELL_CODE_BUDGET_BAND_DEFINITIONS,
  CELL_CODE_BUDGET_BANDS,
  CELL_CODE_BUDGET_DECISION,
  CELL_CODE_BUDGET_GOVERNING_DECISIONS,
  CELL_CODE_BUDGET_MEASUREMENT,
  CELL_CODE_INLINE_CEILING_CHARACTERS,
  CELL_CODE_PROJECT_VOLUME_OBSERVATION,
  CELL_CODE_REVIEW_CEILING_CHARACTERS,
  cellCodeBudgetBands,
  classifyCellCodeSize,
  findCellCodeBudgetBand,
} from "./cell-code-budget.ts";
export type {
  CellCodeBudgetBand,
  CellCodeBudgetBandDefinition,
  CellCodeBudgetVerdict,
  CellCodeMeasurementPoint,
} from "./cell-code-budget.ts";

export {
  assertDistinctTargetClaims,
  assertUniqueTargets,
  CELL_ID_PATTERN,
  createCellRegistry,
  ForguncyConfigError,
  isCellRegistry,
  isSecretLikeKey,
  machineSpecificPathProblem,
  OUTPUT_ALLOWED_FIELDS,
  TARGET_ALLOWED_FIELDS,
} from "./cell-registry.ts";
export type {
  CellRegistry,
  ConfigDiagnostic,
  ConfigDiagnosticCode,
  CreateCellRegistryOptions,
  NormalizedCellTarget,
  NormalizedRuntimeTarget,
  RegisteredCell,
  TargetClaim,
} from "./cell-registry.ts";

export {
  findForguncyConfigFile,
  importForguncyConfigModule,
  loadForguncyConfig,
} from "./config-loader.ts";
export type {
  FindForguncyConfigFileOptions,
  ForguncyConfigModuleLoader,
  LoadForguncyConfigOptions,
} from "./config-loader.ts";
