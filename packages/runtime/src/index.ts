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
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29), which is the
 * executable projection of #27: `facade.ts` is the surface a Cell author calls,
 * `provider.ts` is the resolution and its absence taxonomy, and the two provider
 * kinds are `host-provider.ts` (production bindings) and `mock-provider.ts`
 * (local development).
 *
 * Scope note: this package states *which capabilities the façade may expose, on
 * which boundary, and what it must not become* (#27), *what a local process may
 * stand in for and what it may then claim* (#22), and *how the same surface is
 * reached from the host and from a mock* (#29). It does not build the local dev
 * harness (#23), resolve dependencies (#8), or produce a Cell artifact (#6) — the
 * generated binding that installs the host provider is emitted by the
 * artifact/compiler boundary (#7), and this package only states the shape it has
 * to satisfy. What it does own is the answer to every question that separates a
 * façade from a second application framework, and every question that separates a
 * local feedback loop from a validation path.
 *
 * A green `vp test` here says the *contracts* and the *resolution* hold. It says
 * nothing about Forguncy runtime behaviour: `#5` owns that evidence, and this
 * package only ever cites it. The host half of that evidence has since been
 * re-read from an executed Forguncy page, which confirmed the addresses and shapes
 * this package is built on; no part of this package has itself run in a page.
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
  assertLocalDevExtensionChoicesAreDeclared,
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
  LOCAL_DEV_EXTENSION_CHOICE_MODES,
  LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS,
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
  localDevExtensionChoiceProblem,
  localDevFailureContrast,
  localDevHandlingForStrategy,
  localDevModuleIdsOf,
  findLocalDevBridgeRow,
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
  LocalDevExtensionChoice,
  LocalDevExtensionChoiceMode,
  LocalDevExtensionRealRuntimeOnly,
  LocalDevExtensionSubstitute,
  LocalDevExtensionSubstituteKind,
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
  LocalDevVersionField,
} from "./local-dev";

// #29 — the façade surface: six members, each an address for admitted
// capabilities, plus the audit that keeps the registry and the implementation
// from drifting apart.
//
// Four of the six are typed, because #5 *called* four capabilities
// (`invokeServerCommand`, `useDataSource`, `hasPermission`, `getPermissions`);
// the other two are the declared-shape accessors `cellProp` and `forguncyMember`,
// which assert a confirmed address and resolve to `unknown` until the caller
// declares the shape it expects.
//
// `runtimeFacadeSurface()` (facade.ts) and `requireRuntimeFacadeProvider()`
// (provider.ts) are deliberately *not* re-exported. The first hands out the same
// surface without the fail-fast provider check, and the second hands out the raw
// host bindings — the coupling #27's problem statement exists to remove. Both are
// reachable inside the package, where the audit and the resolution need them.
export {
  assertRuntimeFacadeSurfaceIsExposed,
  auditRuntimeFacadeSurface,
  findRuntimeFacadeSurfaceMember,
  RUNTIME_FACADE_CELL_PROP_ADDRESSES,
  RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES,
  RUNTIME_FACADE_SURFACE,
  RUNTIME_FACADE_SURFACE_FINDING_IDS,
  RUNTIME_FACADE_SURFACE_MEMBER_IDS,
  RUNTIME_FACADE_SURFACE_SIGNATURES,
  runtimeFacade,
  runtimeFacadeExposedAddresses,
  runtimeFacadeExposedAddressNames,
  runtimeFacadeMemberCarriesBinding,
} from "./facade";
export type {
  ExposedCellPropKey,
  ExposedForguncyMember,
  RuntimeFacade,
  RuntimeFacadeSurfaceCarrier,
  RuntimeFacadeSurfaceFinding,
  RuntimeFacadeSurfaceFindingId,
  RuntimeFacadeSurfaceMember,
  RuntimeFacadeSurfaceMemberId,
  RuntimeFacadeSurfaceSignature,
} from "./facade";

// #29 — how the surface resolves, and every way of not resolving
export {
  findRuntimeFacadeAbsenceMode,
  installRuntimeFacadeProvider,
  RUNTIME_FACADE_ABSENCE_MODES,
  RUNTIME_FACADE_ABSENCE_SHAPES,
  RUNTIME_FACADE_ADDRESS_KINDS,
  RUNTIME_FACADE_RESOLUTION_ERROR_CODES,
  RuntimeFacadeResolutionError,
  runtimeFacadeProviderState,
  throwingRuntimeFacadeAbsenceCodes,
  uninstallRuntimeFacadeProvider,
} from "./provider";
export type {
  RuntimeFacadeAbsenceId,
  RuntimeFacadeAbsenceMode,
  RuntimeFacadeAbsenceShape,
  RuntimeFacadeAddressKind,
  RuntimeFacadeProviderState,
  RuntimeFacadeResolutionErrorCode,
} from "./provider";

// #29 — the two provider kinds
export { createHostRuntimeFacadeProvider, RUNTIME_FACADE_HOST_BINDING_CHANNELS } from "./host-provider";
export type { HostRuntimeFacadeProviderInput } from "./host-provider";

export {
  createMockDataSource,
  createMockRuntimeFacadeProvider,
  mockUndeclaredDataSourceMessage,
} from "./mock-provider";
export type {
  MockDataSourceResolver,
  MockRuntimeFacadeOptions,
  MockStandInCellPropKey,
} from "./mock-provider";
