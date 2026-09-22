/**
 * `@forguncy-react-workspace/runtime` — the executable projection of the runtime
 * façade contract.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27), which is
 * itself downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
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
 * which boundary, what it must not become, and how the same surface is reached
 * from the host and from a mock*. It does not build the local dev harness
 * (#22/#23), resolve dependencies (#8), or produce a Cell artifact (#6) — the
 * generated binding that installs the host provider is emitted by the
 * artifact/compiler boundary (#7), and this package only states the shape it has
 * to satisfy.
 *
 * A green `vp test` here says the *contract* and the *resolution* hold. It says
 * nothing about Forguncy runtime behaviour: `#5` owns that evidence, and this
 * package only ever cites it. No part of this package has been executed against
 * a real Forguncy page.
 */

// Provenance
export {
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

// #29 — the façade surface: four members, each an address for admitted
// capabilities, plus the audit that keeps the registry and the implementation
// from drifting apart.
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
