/**
 * `@forguncy-react-workspace/mcp-sync` — the executable projection of the one-way MCP
 * sync contract.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated artifacts
 * to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), which is itself
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/12
 *
 * Scope note: this package states *what a sync writes, from where, in what order, what it
 * refuses, and what it may not claim*. It does not issue a designer call — #20 owns the
 * transport — does not compile an artifact (#6/#7), does not resolve dependencies (#8),
 * does not read a project's Cell targets (#26/#28), and does not package a Forguncy
 * extension (that is `MangMax/forguncy-frontend-library`'s, which is also where #19 sends
 * a missing extension). What it owns is every question that separates a deployment step
 * from a file copy, so a caller cannot deploy by accident.
 *
 * The two things a caller should read first are `unestablishedSyncCapabilities()` — which
 * designer operations have no recorded call name, and therefore block the flow end to end
 * — and `realRuntimeSyncGuarantees()` — which promises a green local run says nothing
 * about. A green `vp test` here establishes the *contract*; it establishes nothing about
 * Forguncy runtime behaviour, and #20's own validation plan says a local mock is
 * insufficient for final acceptance.
 */

// Provenance
export {
  MCP_SYNC_CITATION_PATTERNS,
  MCP_SYNC_DECISION,
  MCP_SYNC_DECISION_QUALIFIED_REFERENCE,
  MCP_SYNC_DECISION_REFERENCE,
  MCP_SYNC_GOVERNING_DECISIONS,
  MCP_SYNC_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance";

// Where a sync writes, and what is still open about the locator
export { cellTargetLabel, SYNC_TARGET_LOCATOR } from "./target";
export type { CellTarget, SyncCellInput } from "./target";

// The designer surface the flow needs, and the operations it deliberately lacks
export { FORGUNCY_SYNC_PORT_METHODS } from "./port";
export type {
  ForguncySyncPort,
  ForguncySyncPortMethod,
  GeneratedPage,
  GeneratePageRequest,
  IssuedSetCellsRequest,
  ListFrontendLibrariesRequest,
  ListFrontendLibrariesResult,
  ProjectErrorReport,
  SetCellsCell,
  SetCellsCellType,
  SetCellsCellTypeProps,
  SetCellsRequest,
} from "./port";

// The flow, its evidence, and whether it can be executed
export {
  assertMcpSyncFlowIsCoherent,
  assertMcpSyncStepCoherent,
  assertSyncCapabilityCoherent,
  assertSyncPortMatchesCapabilities,
  establishedSyncPortMethods,
  findMcpSyncStep,
  findSyncCapability,
  findSyncEvidenceSource,
  formatMcpSyncFlow,
  MCP_SYNC_STEP_IDS,
  MCP_SYNC_STEP_PHASES,
  MCP_SYNC_STEPS,
  requiredSyncCapabilities,
  SyncCapabilityContractError,
  SYNC_CAPABILITIES,
  SYNC_CAPABILITY_CONTRACT_ERROR_CODES,
  SYNC_CAPABILITY_IDS,
  syncCapabilityEvidenceChannels,
  SYNC_EVIDENCE_SOURCE_IDS,
  SYNC_EVIDENCE_SOURCES,
  syncMutationStep,
  unestablishedSyncCapabilities,
} from "./capability-surface";
export type {
  McpSyncStep,
  McpSyncStepId,
  McpSyncStepPhase,
  McpSyncStepTransport,
  SyncCapability,
  SyncCapabilityConfirmation,
  SyncCapabilityContractErrorCode,
  SyncCapabilityId,
  SyncEvidenceSource,
  SyncEvidenceSourceId,
} from "./capability-surface";

// The error model
export {
  CONTRACT_SYNC_DIAGNOSTIC_CODES,
  createSyncDiagnostic,
  dedupeSyncDiagnostics,
  EXTENSION_AUDIT_DETECTOR,
  EXTENSION_AUDIT_TRANSLATION,
  EXTENSION_CREATION_DELEGATE,
  formatSyncDiagnostic,
  formatSyncDiagnostics,
  isSyncDiagnosticCode,
  REQUIRED_SYNC_DIAGNOSTIC_CODES,
  syncDiagnosticCodes,
  syncDiagnosticFromExtensionAudit,
  syncDiagnosticRule,
  SYNC_DIAGNOSTIC_CODES,
  SYNC_DIAGNOSTIC_RULES,
  translatedExtensionAuditCodes,
} from "./diagnostics";
export type {
  ContractSyncDiagnosticCode,
  RequiredSyncDiagnosticCode,
  SyncDiagnostic,
  SyncDiagnosticCode,
  SyncDiagnosticDerivation,
  SyncDiagnosticOrigin,
  SyncDiagnosticRule,
  SyncExtensionDelegate,
  SyncFixOwner,
} from "./diagnostics";

// What a sync promises
export {
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
} from "./guarantees";
export type { SyncGuarantee, SyncGuaranteeId } from "./guarantees";

// The generated-artifact fingerprint and its marker
export {
  fingerprintArtifact,
  fingerprintArtifactCode,
  readSyncMarker,
  stampSyncMarker,
  stripSyncMarker,
  SYNC_FINGERPRINT_ERROR_CODES,
  SYNC_MARKER_PREFIX,
  SYNC_MARKER_SUFFIX,
  SYNC_MARKER_VERSION,
  SyncFingerprintError,
  syncMarkerLine,
  verifySyncMarkerSelfConsistency,
} from "./fingerprint";
export type { SyncFingerprintErrorCode, SyncMarker, SyncMarkerState } from "./fingerprint";

// What the target holds, and what may be done about it
export {
  CELL_DIVERGENCE_ACTIONS,
  CELL_DIVERGENCE_KINDS,
  CELL_OVERWRITE_POLICIES,
  CELL_READ_UNAVAILABLE_REASONS,
  cellDivergenceOverride,
  classifyCellDivergence,
  DEFAULT_CELL_OVERWRITE_POLICY,
  formatCellDivergence,
  resolveCellWriteAction,
} from "./divergence";
export type {
  CellDivergence,
  CellDivergenceKind,
  CellMetadataComparison,
  CellOverwritePolicy,
  CellReadUnavailableReason,
  CellWriteAction,
  DeployedCellState,
} from "./divergence";

// Extension references, verified from the project rather than guessed
export {
  findSyncDiagnosticByCode,
  formatExtensionReferenceVerification,
  verifyExtensionReferences,
} from "./extension-verification";
export type {
  ExtensionReferenceVerification,
  ExtensionVerificationStatus,
  VerifyExtensionReferencesOptions,
} from "./extension-verification";

// What a resolved step result means
export {
  outcomeOfPageGeneration,
  outcomeOfProjectErrorCheck,
  SYNC_STEP_SUCCEEDED,
} from "./step-outcomes";
export type { SyncStepOutcome } from "./step-outcomes";

// The plan
export {
  CELL_SYNC_HOLD_REASONS,
  formatCellSyncPlan,
  formatCellSyncSteps,
  planCellSync,
  planSetCellsDispatch,
  serializeCellSyncMutation,
  SYNC_MUTATION_GEOMETRY_NOTE,
  SYNC_MUTATION_OMITTED_FIELDS,
} from "./sync-plan";
export type {
  CellSyncDispatch,
  CellSyncGate,
  CellSyncHoldReason,
  CellSyncMutation,
  CellSyncPlan,
  CellSyncWrite,
  PlanCellSyncOptions,
  SyncStepPlan,
  SyncStepStatus,
} from "./sync-plan";
