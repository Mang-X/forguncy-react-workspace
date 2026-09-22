/**
 * `@forguncy-react-workspace/runtime` — the executable projection of the runtime
 * façade contract (#27) and the local development runtime contract (#22).
 *
 * Decision sources: GitHub Issues
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * both of which are downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * and #22 additionally of:
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 *
 * Scope note: this package states *which capabilities the façade may expose, on
 * which boundary, and what it must not become* (#27), and *what a local process
 * may stand in for and what it may then claim* (#22). It does not implement the
 * façade's runtime delegation (#29), build the local dev harness (#23), resolve
 * dependencies (#8), or produce a Cell artifact (#6). What it does own is the
 * answer to every question that separates a façade from a second application
 * framework, and every question that separates a local feedback loop from a
 * validation path.
 *
 * A green `vp test` here says the *contracts* hold. It says nothing about
 * Forguncy runtime behaviour: `#5` owns that evidence, and this package only ever
 * cites it.
 */

// Provenance
export {
  LOCAL_DEV_RUNTIME_CITATION_PATTERNS,
  LOCAL_DEV_RUNTIME_DECISION,
  LOCAL_DEV_RUNTIME_DECISION_QUALIFIED_REFERENCE,
  LOCAL_DEV_RUNTIME_DECISION_REFERENCE,
  RUNTIME_FACADE_CITATION_PATTERNS,
  RUNTIME_FACADE_DECISION,
  RUNTIME_FACADE_DECISION_QUALIFIED_REFERENCE,
  RUNTIME_FACADE_DECISION_REFERENCE,
  RUNTIME_GOVERNING_DECISIONS,
  RUNTIME_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance";

// Which capabilities are admitted, and why the rest are not
export {
  admittedRuntimeFacadeFamilies,
  applicationOwnedRuntimeFacadeCapabilities,
  assertRuntimeFacadeCapabilityAdmissible,
  assertRuntimeFacadeFamilyAdmissible,
  assertRuntimeFacadeSurfaceIsConfirmed,
  dedupeEvidenceChannels,
  findRuntimeFacadeCapability,
  findRuntimeFacadeEvidenceSource,
  findRuntimeFacadeFamily,
  omittedRuntimeFacadeFamilies,
  RUNTIME_FACADE_CAPABILITIES,
  RUNTIME_FACADE_CAPABILITY_IDS,
  RUNTIME_FACADE_CONTRACT_ERROR_CODES,
  RUNTIME_FACADE_EVIDENCE_SOURCES,
  RUNTIME_FACADE_EVIDENCE_SOURCE_IDS,
  RUNTIME_FACADE_FAMILIES,
  RUNTIME_FACADE_FAMILY_IDS,
  RuntimeFacadeContractError,
  runtimeFacadeBindingName,
  runtimeFacadeBindingShadowsCellScope,
  runtimeFacadeCapabilitiesOfFamily,
  runtimeFacadeConcernOf,
  runtimeFacadeEvidenceChannels,
} from "./capabilities";
export type {
  CellPropKey,
  ForguncyPropMember,
  RuntimeFacadeCapability,
  RuntimeFacadeCapabilityId,
  RuntimeFacadeCapabilityScope,
  RuntimeFacadeConfirmation,
  RuntimeFacadeContractErrorCode,
  RuntimeFacadeEvidenceSource,
  RuntimeFacadeEvidenceSourceId,
  RuntimeFacadeFamily,
  RuntimeFacadeFamilyId,
  RuntimeFacadeFamilyVerdict,
  RuntimeFacadeHostBinding,
} from "./capabilities";

// The confirmed call shapes, the provider boundary, and the non-goals
export {
  APPLICATION_OWNED_CONCERNS,
  assertRuntimeFacadeBoundariesProtectApplicationConcerns,
  assertRuntimeFacadePortCoversAdmittedCapabilities,
  findRuntimeFacadeBoundaryForConcern,
  RUNTIME_FACADE_BOUNDARIES,
  RUNTIME_FACADE_BOUNDARY_IDS,
  RUNTIME_FACADE_FORBIDDEN_PATTERNS,
  RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS,
  RUNTIME_FACADE_PACKAGING_POLICY,
  RUNTIME_FACADE_PORT_CHANNELS,
  RUNTIME_FACADE_PORT_CHANNEL_MEMBERS,
  RUNTIME_FACADE_PORT_HOOK_NAME,
  RUNTIME_FACADE_PROVIDER_EXPECTATIONS,
  RUNTIME_FACADE_PROVIDER_KINDS,
  RUNTIME_FACADE_RESOLUTION_MODEL,
  runtimeFacadePortChannelOfBinding,
  runtimeFacadePortChannels,
  runtimeFacadePortCoversBinding,
} from "./contract";
export type {
  DataSourceBinding,
  DataSourceOrderByParam,
  DataSourceQueryOptions,
  DataSourceResult,
  RuntimeFacadeBoundary,
  RuntimeFacadeBoundaryId,
  RuntimeFacadeCellProps,
  RuntimeFacadeForbiddenPattern,
  RuntimeFacadeForbiddenPatternId,
  RuntimeFacadeHostBindings,
  RuntimeFacadePortChannel,
  RuntimeFacadeProvider,
  RuntimeFacadeProviderExpectation,
  RuntimeFacadeProviderKind,
  ServerCommandBindings,
  ServerCommandCall,
  ServerCommandParameterMap,
  ServerCommandResult,
  ServerCommandResultKey,
} from "./contract";

// The low-level escape hatch, kept out of the façade's public surface
export { getHostGlobal } from "./host-globals";

// The local development runtime contract (#22)
export {
  assertLocalDevBoundariesAreAdmissible,
  assertLocalDevClaimsAreLocalOnly,
  assertLocalDevLoopStagesAreAdmissible,
  assertLocalDevMockSuppliesEveryBaseProp,
  assertLocalDevProviderIsMock,
  assertLocalDevResolutionsCoverHostBridge,
  assertLocalDevStrategyHandlingsCoverStrategies,
  auditLocalDevConfiguration,
  createLocalDevDiagnostic,
  findLocalDevBoundaryForConcern,
  findLocalDevModuleIdResolution,
  formatLocalDevAudit,
  formatLocalDevDiagnostic,
  formatLocalDevDiagnostics,
  formatLocalDevValidationDistinction,
  LOCAL_DEV_BOUNDARIES,
  LOCAL_DEV_BOUNDARY_BEHAVIOURS,
  LOCAL_DEV_BOUNDARY_IDS,
  LOCAL_DEV_CLAIMS,
  LOCAL_DEV_CLAIM_IDS,
  LOCAL_DEV_CONTRACT_ERROR_CODES,
  LOCAL_DEV_DECISION_HANDLINGS,
  LOCAL_DEV_DIAGNOSTIC_CODES,
  LOCAL_DEV_DIAGNOSTIC_RULES,
  LOCAL_DEV_ERROR_SURFACES,
  LOCAL_DEV_ERROR_SURFACING,
  LOCAL_DEV_FORBIDDEN_PATTERNS,
  LOCAL_DEV_FORBIDDEN_PATTERN_IDS,
  LOCAL_DEV_GOVERNING_DECISIONS,
  LOCAL_DEV_GOVERNING_SPEC_REFERENCE_LINE,
  LOCAL_DEV_HOST_MAPPING_SOURCE,
  LOCAL_DEV_HOST_RESOLUTION_MODEL,
  LOCAL_DEV_LOCAL_RESOLUTION_KINDS,
  LOCAL_DEV_LOOP_STAGES,
  LOCAL_DEV_LOOP_STAGE_IDS,
  LOCAL_DEV_MODULE_RESOLUTIONS,
  LOCAL_DEV_MOCK_SURFACE,
  LOCAL_DEV_MOCK_SURFACE_SOURCE,
  LOCAL_DEV_NON_GOALS,
  LOCAL_DEV_STRATEGY_HANDLINGS,
  LOCAL_DEV_VERSION_FIELDS,
  LocalDevRuntimeContractError,
  localDevAlignmentChecks,
  localDevDeferredHostModules,
  localDevDischargeableChecks,
  localDevFailureContrast,
  localDevHandlingForStrategy,
  localDevModuleIdsOf,
  localDevProtectedConcerns,
  localDevRealRuntimeOwedChecks,
  localDevRealRuntimeStage,
  localDevRecordedVersion,
  localDevResolvableModuleIds,
  localDevResolvedBridgeRows,
  localDevUnsupportedModuleIds,
} from "./local-dev";
export type {
  LocalDevAlignmentExpectation,
  LocalDevAudit,
  LocalDevAuditInput,
  LocalDevBoundary,
  LocalDevBoundaryBehaviour,
  LocalDevBoundaryId,
  LocalDevClaim,
  LocalDevClaimId,
  LocalDevContractErrorCode,
  LocalDevDecisionHandling,
  LocalDevDiagnostic,
  LocalDevDiagnosticCode,
  LocalDevDiagnosticRule,
  LocalDevErrorSurface,
  LocalDevFixOwner,
  LocalDevForbiddenPattern,
  LocalDevForbiddenPatternId,
  LocalDevLocalResolutionKind,
  LocalDevLoopStage,
  LocalDevLoopStageId,
  LocalDevModuleIdResolution,
  LocalDevModuleResolution,
  LocalDevOwedCheck,
  LocalDevStrategyHandling,
  LocalDevSubstitute,
  LocalDevVersionField,
} from "./local-dev";
