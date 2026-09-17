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
  ArchitecturalRejectionCode,
  DependencyRejection,
  DependencyRejectionCode,
  DependencyRejectionKind,
  DependencyRejectionResponse,
  TechnicalRejectionCode,
} from "./rejection";

export {
  APPLICATION_OWNED_ROLES,
  assessDependencyRole,
  findPlatformConflictRule,
  isPlatformConflict,
  PLATFORM_CONFLICT_PACKAGE_NAMES,
  PLATFORM_CONFLICT_RULES,
} from "./platform-conflicts";
export type { DependencyRole, PlatformConflictAssessment, PlatformConflictRule } from "./platform-conflicts";

export {
  assertDependencyDecision,
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_STRATEGY_SEMANTICS,
  isDependencyStrategy,
  requiresRealRuntimeValidation,
  strategySemantics,
  validateDependencyDecision,
} from "./strategy";
export type {
  DependencyCheck,
  DependencyCheckLevel,
  DependencyDecision,
  DependencyStrategy,
  DependencyStrategySemantics,
  ExtensionDependencyDecision,
  HostDependencyDecision,
  InlineDependencyDecision,
  ReplaceDependencyDecision,
} from "./strategy";

export {
  citesDecision,
  DECISION_CITATION_TOKENS,
  formatDecisionReference,
  GOVERNING_SPEC_REFERENCE_LINE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
} from "./governance";
export type { ArchitectureDecisionSource } from "./governance";
