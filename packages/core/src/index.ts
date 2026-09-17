/**
 * `@forguncy-react-workspace/core` — the executable projection of the
 * architecture decisions that every other package must obey.
 *
 * Governing Spec Issue: #4 "application ownership boundaries and dependency
 * strategy semantics" — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 *
 * Scope note: this package states *semantics, boundaries and identity*. It
 * intentionally does not resolve dependencies, bundle anything, compile Cells, or
 * maintain a package compatibility database; those are separate Issues. The
 * project configuration contract it does own (#26/#28) stops at declaring and
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
  DECISION_CITATION_PATTERNS,
  formatDecisionReference,
  GOVERNING_SPEC_REFERENCE_LINE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
} from "./governance";
export type { ArchitectureDecisionSource } from "./governance";

// ---------------------------------------------------------------------------
// Project configuration and Cell target registry.
//
// Governing Spec Issue: #26; implementation Issue: #28. Declared separately
// because it is the one place where a logical Cell id is bound to a source entry
// and a Forguncy target, and every consumer (compiler, dev harness, MCP sync)
// must resolve Cells through these APIs instead of declaring its own mapping.
// ---------------------------------------------------------------------------

export {
  CELL_REFERENCE_PATTERN,
  CONFIG_ALLOWED_FIELDS,
  CELL_ALLOWED_FIELDS,
  DEFAULT_CODE_MARKER_NAMESPACE,
  DEFAULT_DEPENDENCY_LOCK_PATH,
  DEFAULT_FORGUNCY_CONFIG_FILE,
  defineForguncyConfig,
  DEPENDENCY_DECISION_FIELD_NAMES,
  FORGUNCY_CONFIG_FILE_CANDIDATES,
  FORGUNCY_CONFIG_SCHEMA_VERSION,
  isConfigRecord,
  normalizeCellReference,
  RUNTIME_ALLOWED_FIELDS,
  TARGET_LOCATOR_MODEL,
  targetLocatorKey,
} from "./forguncy-config";
export type {
  CellCodeBudgetOverrides,
  CellConfig,
  ForguncyConfig,
  ForguncyConfigSchemaVersion,
  ForguncyTargetLocator,
  RuntimeTargetConfig,
  TargetLocatorModel,
} from "./forguncy-config";

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
} from "./cell-registry";
export type {
  CellRegistry,
  ConfigDiagnostic,
  ConfigDiagnosticCode,
  CreateCellRegistryOptions,
  NormalizedCellTarget,
  NormalizedRuntimeTarget,
  RegisteredCell,
  TargetClaim,
} from "./cell-registry";

export {
  findForguncyConfigFile,
  importForguncyConfigModule,
  loadForguncyConfig,
} from "./config-loader";
export type {
  FindForguncyConfigFileOptions,
  ForguncyConfigModuleLoader,
  LoadForguncyConfigOptions,
} from "./config-loader";
