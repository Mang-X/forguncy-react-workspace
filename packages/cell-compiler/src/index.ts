/**
 * `@forguncy-react-workspace/cell-compiler` — the executable projection of the
 * generated-artifact contract and of the workspace-source contract built on it.
 *
 * Decision sources: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6) — and Issue #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14) — both downstream
 * of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * A third Spec is projected here: #9 "host module bridge for React, ReactDOM,
 * antd and built-in globals"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/9), which decides
 * what a `host` dependency compiles *to*. The mapping table itself is `core`'s —
 * the dependency resolver audits locks against the same table and may not depend
 * on this package — so what lives here is the generated source and the guard.
 *
 * A fourth Spec is projected here: #12 "`extension` dependencies as external modules
 * + `frontendLibraries` metadata"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/12), which decides what
 * an `extension` dependency compiles *to*. The same division holds — the mapping table
 * and the load-order rules are `core`'s, because the dependency resolver audits locks
 * against the same identity while being unable to depend on this package — so what
 * lives here is the generated module and the externals plan.
 *
 * Scope note: this package states the *artifact* contract, the boundary that
 * produces one, and the rules that make local workspace packages source rather than
 * runtime modules. It does not resolve dependencies (#8), and the artifact boundary
 * names no bundler: #7's Rolldown port ships here as an *implementation* of
 * `CellBundlerPort` that a caller injects, so the boundary stays bundler-agnostic
 * even though this package now provides one. It also does not load or parse a
 * project config (#26 owns that in `core` —
 * `registry-plan` consumes an already-loaded registry and never reads disk), package
 * Forguncy frontend extensions, or measure the cell code budget (#21) — it takes
 * that budget, and the workspace graph, as configuration. What it does own is every
 * question that separates a Cell artifact from a web bundle, so a caller cannot
 * produce one by accident.
 */

// Provenance
export {
  ARTIFACT_CONTRACT_CITATION_PATTERNS,
  ARTIFACT_CONTRACT_DECISION,
  ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE,
  ARTIFACT_CONTRACT_DECISION_REFERENCE,
  COMPILER_GOVERNING_DECISIONS,
  COMPILER_GOVERNING_SPEC_REFERENCE_LINE,
  WORKSPACE_SOURCE_CITATION_PATTERNS,
  WORKSPACE_SOURCE_DECISION,
  WORKSPACE_SOURCE_DECISION_QUALIFIED_REFERENCE,
  WORKSPACE_SOURCE_DECISION_REFERENCE,
  WORKSPACE_SOURCE_GOVERNING_DECISIONS,
  WORKSPACE_SOURCE_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance";

// The public guarantees
export {
  CELL_ARTIFACT_GUARANTEE_IDS,
  CELL_ARTIFACT_GUARANTEES,
  findCellArtifactGuarantee,
  locallyCheckableCellArtifactGuarantees,
  realRuntimeCellArtifactGuarantees,
} from "./guarantees";
export type { CellArtifactGuarantee, CellArtifactGuaranteeId } from "./guarantees";

// The error model
export {
  cellArtifactDiagnosticCodes,
  CELL_ARTIFACT_DIAGNOSTIC_CODES,
  CELL_ARTIFACT_DIAGNOSTIC_RULES,
  cellArtifactDiagnosticRule,
  CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES,
  createCellArtifactDiagnostic,
  dedupeCellArtifactDiagnostics,
  formatCellArtifactDiagnostic,
  formatCellArtifactDiagnostics,
  isCellArtifactDiagnosticCode,
  REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES,
} from "./diagnostics";
export type {
  CellArtifactDiagnostic,
  CellArtifactDiagnosticCode,
  CellArtifactDiagnosticOrigin,
  CellArtifactDiagnosticRule,
  CellArtifactFixOwner,
  ContractCellArtifactDiagnosticCode,
  RequiredCellArtifactDiagnosticCode,
} from "./diagnostics";

// The entry contract
export {
  acceptedButNotEmittableCellEntryKinds,
  CELL_ARTIFACT_DEFAULT_ENTRY_KIND,
  CELL_ENTRY_COMPONENT_BINDING,
  CELL_ENTRY_COMPONENT_PLACEHOLDER,
  CELL_ENTRY_WRAPPER_HOST_NAMES,
  CELL_ENTRY_WRAPPER_SUPPORT,
  JAVASCRIPT_IDENTIFIER_PATTERN,
  cellEntryWrapperHostNames,
  cellEntryWrapperNamesAreVerified,
  expressibleCellEntryKinds,
  findCellEntryWrapperSupport,
  renderCellEntryWrapper,
  runtimeContractEmittableCellEntryKinds,
} from "./entry";
export type { CellEntryWrapperRender, CellEntryWrapperSupport, RenderCellEntryWrapperInput } from "./entry";

// The metadata contract
export {
  auditFrontendLibraries,
  canonicalizeFrontendLibraries,
  collectFrontendLibraries,
  compareFrontendLibraries,
  FRONTEND_LIBRARIES_FIELD_NAME,
  FRONTEND_LIBRARY_REFERENCE_FIELD_NAME,
  FRONTEND_LIBRARY_REFERENCE_KEYS,
  frontendLibraryIds,
  frontendLibraryReference,
  isCanonicalFrontendLibraries,
} from "./frontend-libraries";
export type { FrontendLibrariesCollection } from "./frontend-libraries";

// The source guard
export {
  auditCellSource,
  CELL_SOURCE_SCAN_SKIPPED,
  findDynamicImportCall,
  refusedCalleeNames,
  rejectionForRefusedCalleeName,
  scanCellArtifactSource,
} from "./source-guard";
export type {
  CellSourceAudit,
  CellSourceCallFinding,
  CellSourceScanFinding,
  CellSourceScanOmission,
} from "./source-guard";

// The host module bridge (#9): the interposed modules and the artifact guard
export {
  createHostBridgeDiagnostic,
  formatHostBridgeDiagnostic,
  formatHostBridgeDiagnostics,
  formatHostBridgePlan,
  hostBridgeDiagnosticRule,
  interceptedHostBridgeModuleIds,
  HOST_BRIDGE_GENERATED_BANNER,
  planHostBridge,
  renderHostBridgeAdapterModule,
  renderHostBridgeGlobalModule,
  renderHostBridgeGuard,
  renderHostBridgeModule,
} from "./host-bridge";
export type {
  HostBridgeActivation,
  HostBridgeAdapterExportName,
  HostBridgeDiagnostic,
  HostBridgeInterception,
  HostBridgePlan,
  HostBridgeUsage,
  PlanHostBridgeOptions,
  RenderHostBridgeGuardOptions,
} from "./host-bridge";

// The extension externals (#12): the interposed modules that answer an authored
// import from a verified frontend extension's page global, and the plan a resolver
// hook and the artifact's `frontendLibraries` metadata are derived from.
export {
  extensionExternalModuleIds,
  formatExtensionExternalsPlan,
  interceptedExtensionExternalModuleIds,
  planExtensionExternals,
  renderExtensionExternalModule,
  EXTENSION_EXTERNAL_GENERATED_BANNER,
} from "./extension-externals";
export type {
  ExtensionExternalInterception,
  ExtensionExternalsActivation,
  ExtensionExternalsPlan,
  PlanExtensionExternalsOptions,
} from "./extension-externals";

// The workspace-source contract (#14): workspace packages are source, not runtime modules
export {
  auditWorkspaceSource,
  classifyWorkspaceModule,
  createWorkspaceSourceDiagnostic,
  findWorkspaceSourceGuarantee,
  findWorkspaceSourceReuseClass,
  formatWorkspaceSourceAudit,
  formatWorkspaceSourceDiagnostic,
  formatWorkspaceSourceDiagnostics,
  indexWorkspaceGraph,
  isWorkspaceSourceDiagnosticCode,
  isWorkspaceSourceSpecifier,
  locallyCheckableWorkspaceSourceGuarantees,
  orderWorkspaceSourceDiagnostics,
  realRuntimeWorkspaceSourceGuarantees,
  traceWorkspaceSourceClosure,
  WORKSPACE_CONTEXT_SEMANTICS,
  WORKSPACE_MODULE_KINDS,
  workspacePackageFor,
  workspaceReuseClassesRequiringDelegation,
  WORKSPACE_SOURCE_DIAGNOSTIC_CODES,
  WORKSPACE_SOURCE_DIAGNOSTIC_RULES,
  WORKSPACE_SOURCE_GUARANTEE_IDS,
  WORKSPACE_SOURCE_GUARANTEES,
  WORKSPACE_SOURCE_REUSE_CLASSES,
  WORKSPACE_SOURCE_REUSE_CLASS_IDS,
  WORKSPACE_SOURCE_SHARING_INVARIANT,
} from "./workspace-source";
export type {
  WorkspaceDelegationAssessment,
  WorkspaceDelegationGap,
  WorkspaceDelegationStatus,
  WorkspaceExternalModule,
  WorkspaceGraph,
  WorkspaceGraphIndex,
  WorkspaceGraphIndexResult,
  WorkspaceGraphState,
  WorkspaceImportCycle,
  WorkspaceModuleIdentity,
  WorkspaceModuleKind,
  WorkspacePackageRecord,
  WorkspaceSourceAudit,
  WorkspaceSourceAuditInput,
  WorkspaceSourceDiagnostic,
  WorkspaceSourceDiagnosticCode,
  WorkspaceSourceDiagnosticRule,
  WorkspaceSourceFixOwner,
  WorkspaceSourceGuarantee,
  WorkspaceSourceGuaranteeId,
  WorkspaceSourceClosure,
  WorkspaceSourceReuseClass,
  WorkspaceSourceReuseClassId,
  WorkspaceSourceReuseSafety,
  WorkspaceStateSharingEstablished,
  WorkspaceUsageState,
} from "./workspace-source";

// The boundary
export {
  assembleCellArtifact,
  CELL_ARTIFACT_BANNER,
  compileCell,
  dependencyDecisionsFor,
  findDependencyDecision,
  formatCompileCellOutcome,
  isSourceSpecifier,
  packageNameOfSpecifier,
  serializeCompileCellResult,
  verifyCellArtifact,
} from "./artifact";
export type {
  AssembleCellArtifactInput,
  BundledCellModule,
  CellBundlerPort,
  CellBundlingRequest,
  CompileCellInput,
  CompileCellOptions,
  CompileCellOutcome,
  CompileCellResult,
} from "./artifact";

// The Rolldown-backed bundler port (#7): the concrete `CellBundlerPort`
export { createRolldownCellBundler } from "./rolldown-bundler";
export type { CreateRolldownCellBundlerOptions } from "./rolldown-bundler";

// The #26 registry seam: declared Cell id in, compilable input + target out
export { planCellCompile, planCellCompiles } from "./registry-plan";
export type { CellCompilePlan, CellCompileTarget } from "./registry-plan";
