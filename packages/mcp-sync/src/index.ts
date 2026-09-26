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
 * refuses, and what it may not claim*, and — since #20 — executes that flow against an
 * injected {@link ForguncySyncPort}. It does not ship a *transport*: which MCP session,
 * URL or retry policy is the adapter's, and #20's evidence about the designer's wire shape
 * lives there rather than here. It does not compile an artifact (#6/#7), does not resolve
 * dependencies (#8), and does not package a Forguncy extension (that is
 * `MangMax/forguncy-frontend-library`'s, which is also where #19 sends a missing extension).
 * Reading a project's Cell targets is delegated, not owned: `registry-target` resolves an
 * explicit Cell id through `core`'s #26 registry — the one place "which entry is which
 * Forguncy Cell" is answered — so this package never parses a config or scans a project for
 * something to overwrite. What it owns is every question that separates a deployment step
 * from a file copy, so a caller cannot deploy by accident.
 *
 * The one thing a caller should read before reporting a sync as done is
 * `realRuntimeSyncGuarantees()` — which promises a green local run says nothing about. A
 * green `vp test` here establishes the *contract* and the executor's call sequence; it
 * establishes nothing about Forguncy runtime behaviour on its own. #20's validation is the
 * real-designer half, and its evidence is recorded on the Issue and in the
 * `issue-20-designer-execution` evidence source, deliberately kept separate from this
 * package's local checks.
 */

// Provenance
export {
  MCP_SYNC_CITATION_PATTERNS,
  MCP_SYNC_DECISION,
  MCP_SYNC_DECISION_QUALIFIED_REFERENCE,
  MCP_SYNC_DECISION_REFERENCE,
  MCP_SYNC_GOVERNING_DECISIONS,
  MCP_SYNC_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance.ts";

// Where a sync writes: the locator, #26's finalization of it, and the registry seam
export { cellTargetLabel, SYNC_TARGET_LOCATOR } from "./target.ts";
export type { CellTarget, SyncCellInput } from "./target.ts";
export {
  planCellSyncTargets,
  resolveCellSyncTarget,
  resolveCellSyncTargets,
  syncCellInput,
} from "./registry-target.ts";
export type { CellSyncTargetPlan, ResolvedCellSyncTarget } from "./registry-target.ts";

// The designer surface the flow needs, and the operations it deliberately lacks
export { FORGUNCY_SYNC_PORT_METHODS, REACT_CELL_TYPE_NAME } from "./port.ts";
export type {
  ForguncySyncPort,
  ForguncySyncPortMethod,
  GeneratedPage,
  GeneratePageRequest,
  IssuedSetCellsRequest,
  ListFrontendLibrariesRequest,
  ListFrontendLibrariesResult,
  ProjectErrorReport,
  ProjectSaveResult,
  ProjectSaveStatus,
  ProjectSaveStatusRequest,
  ReadCellSourceRequest,
  ReadCellSourceResult,
  SetCellsCell,
  SetCellsCellType,
  SetCellsCellTypeProps,
  SetCellsRequest,
} from "./port.ts";

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
} from "./capability-surface.ts";
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
} from "./capability-surface.ts";

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
} from "./diagnostics.ts";
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
} from "./diagnostics.ts";

// What a sync promises
export {
  EXECUTED_AGAINST_DESIGNER,
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
  unexecutedRealRuntimeSyncGuarantees,
} from "./guarantees.ts";
export type { SyncGuarantee, SyncGuaranteeId } from "./guarantees.ts";

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
} from "./fingerprint.ts";
export type { SyncFingerprintErrorCode, SyncMarker, SyncMarkerState } from "./fingerprint.ts";

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
} from "./divergence.ts";
export type {
  CellDivergence,
  CellDivergenceKind,
  CellMetadataComparison,
  CellOverwritePolicy,
  CellReadUnavailableReason,
  CellWriteAction,
  DeployedCellState,
} from "./divergence.ts";

// Extension references, verified from the project rather than guessed
export {
  findSyncDiagnosticByCode,
  formatExtensionReferenceVerification,
  verifyExtensionReferences,
} from "./extension-verification.ts";
export type {
  ExtensionReferenceVerification,
  ExtensionVerificationStatus,
  VerifyExtensionReferencesOptions,
} from "./extension-verification.ts";

// What a resolved step result means
export {
  outcomeOfPageGeneration,
  outcomeOfProjectErrorCheck,
  SYNC_STEP_SUCCEEDED,
} from "./step-outcomes.ts";
export type { SyncStepOutcome } from "./step-outcomes.ts";

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
} from "./sync-plan.ts";
export type {
  CellSyncDispatch,
  CellSyncGate,
  CellSyncHoldReason,
  CellSyncMutation,
  CellSyncPlan,
  CellSyncRefusalDispatch,
  CellSyncRefusalReason,
  CellSyncWrite,
  PlanCellSyncOptions,
  SyncStepPlan,
  SyncStepStatus,
} from "./sync-plan.ts";

// The flow, executed
export {
  CELL_SYNC_RUN_STATUSES,
  deployedStateOfRead,
  executeCellSync,
  executeCellSyncTargets,
  formatCellSyncRun,
  formatCellSyncRuns,
  readCellState,
} from "./executor.ts";
export type {
  CellReadOutcome,
  CellSyncRun,
  CellSyncRunStatus,
  ExecuteCellSyncOptions,
  ExecuteCellSyncTargetOptions,
  SyncRunStep,
  SyncRunStepStatus,
  SyncRunSteps,
} from "./executor.ts";

// The designer, as the port — the transport half of #20
export { createDesignerSyncPort, DESIGNER_EXECUTE_TOOL, runtimePageUrl } from "./designer-transport.ts";
export type { DesignerCallTool, DesignerPermissionMode, DesignerSyncPortOptions } from "./designer-transport.ts";
