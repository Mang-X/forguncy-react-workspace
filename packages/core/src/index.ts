/**
 * `@forguncy-react-workspace/core` — the executable projection of the
 * architecture decisions that every other package must obey.
 *
 * Governing Spec Issue: #4 "application ownership boundaries and dependency
 * strategy semantics" — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 *
 * Scope note: this package states *semantics and boundaries*. It intentionally
 * does not resolve dependencies, bundle anything, or maintain a package
 * compatibility database; those are separate Issues.
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
