/**
 * `@forguncy-react-workspace/cell-compiler` — the executable projection of the
 * generated-artifact contract.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6), which is itself
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * Scope note: this package states the *artifact* contract and the boundary that
 * produces one. It does not resolve dependencies (#8), bundle a project with a
 * concrete bundler (#7), package Forguncy frontend extensions, or measure the
 * cell code budget (#21) — it takes that budget as configuration. What it does
 * own is every question that separates a Cell artifact from a web bundle, so a
 * caller cannot produce one by accident.
 */

// Provenance
export {
  ARTIFACT_CONTRACT_CITATION_PATTERNS,
  ARTIFACT_CONTRACT_DECISION,
  ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE,
  ARTIFACT_CONTRACT_DECISION_REFERENCE,
  COMPILER_GOVERNING_DECISIONS,
  COMPILER_GOVERNING_SPEC_REFERENCE_LINE,
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

// The boundary
export {
  assembleCellArtifact,
  CELL_ARTIFACT_BANNER,
  compileCell,
  formatCompileCellOutcome,
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
