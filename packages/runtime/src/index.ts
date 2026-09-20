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
 * Scope note: this package states *which capabilities the façade may expose, on
 * which boundary, and what it must not become*. It does not implement the
 * façade's runtime delegation (#29), build the local dev harness (#22/#23),
 * resolve dependencies (#8), or produce a Cell artifact (#6). What it does own is
 * the answer to every question that separates a façade from a second application
 * framework, so a caller cannot reach the host by accident and call it a façade.
 *
 * A green `vp test` here says the *contract* holds. It says nothing about
 * Forguncy runtime behaviour: `#5` owns that evidence, and this package only ever
 * cites it.
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
