/**
 * `@forguncy-react-workspace/dev-harness` — the local Vite+ development loop for React
 * Cells, as an executable projection of #22's contract (#23).
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), the implementation, and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), the contract it implements,
 *
 * both downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 * - #27 "typed Forguncy runtime facade for application-owned capabilities"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/27
 *
 * ## The division inside this package
 *
 * `runtime`'s `local-dev.ts` decides what a local loop *may do and claim*; this package does
 * it. The split is deliberate and it is the reason this package has almost no rules in it:
 *
 * | question | answered by | module |
 * | --- | --- | --- |
 * | which host packages does the dev server substitute, and at which version | #9's table via `runtime`'s projection | `host-modules.ts` |
 * | which source file is a Cell, and does it expose a component | `vite-plugin-fgc` (#28) | composed in `vite-plugin.ts` |
 * | what shape a fixture has, and how a bad one fails | `runtime`'s fixture contract (#28) | `mount.ts` |
 * | which provider a Cell resolves through | `runtime`'s façade (#27) | `mount.ts` |
 * | what the loop is not allowed to claim | `runtime`'s `local-dev.ts` (#22) | consumed, never restated |
 *
 * What is *new* here is only the wiring: a Vite plugin that composes the Cell seam with the
 * host substitutions, and a browser module that mounts the result. Everything a reader might
 * expect to be a decision in this package is a citation of one made upstream, which is what
 * #22's third acceptance criterion asks for and what keeps the dev loop and the artifact from
 * drifting apart.
 *
 * ## Scope
 *
 * It does not compile a Cell (#6/#7), sync through MCP (#19/#20), or validate anything in a
 * real Forguncy project (#20/#25). It serves one Cell's authored source as ordinary React and
 * says what that proves — which is `local` evidence only. `runtime`'s
 * `formatLocalDevValidationDistinction()` is the report of what remains owed, and this package
 * prints it rather than paraphrasing it.
 *
 * That last sentence was false when it was written, and the way it was false is worth keeping:
 * nothing in this package called `formatLocalDevValidationDistinction()`, so the report existed,
 * was tested, and was never shown to anybody. `local-dev-audit.ts` now prints it at server start.
 * The general shape — a rule that is correct and that nothing acts on — is the one this package
 * keeps meeting, and it is why the extension audit lives behind a `configureServer` hook rather
 * than behind an exported function a project may call.
 */

// The loop's stage record and the distinction it exists to make (#22)
export {
  findLocalDevModuleIdResolution,
  formatLocalDevAudit,
  formatLocalDevValidationDistinction,
  LOCAL_DEV_BOUNDARIES,
  LOCAL_DEV_ERROR_SURFACING,
  LOCAL_DEV_FORBIDDEN_PATTERNS,
  LOCAL_DEV_LOOP_STAGES,
  LOCAL_DEV_MODULE_RESOLUTIONS,
  localDevRealRuntimeOwedChecks,
} from "@forguncy-react-workspace/runtime";

// Provenance
export {
  DEV_HARNESS_CITATION_PATTERNS,
  DEV_HARNESS_DECISION,
  DEV_HARNESS_DECISION_QUALIFIED_REFERENCE,
  DEV_HARNESS_DECISION_REFERENCE,
  DEV_HARNESS_GOVERNING_DECISIONS,
  DEV_HARNESS_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance.ts";

// The host substitutions (#9 via #22's projection)
export {
  findHostModuleStandIn,
  hostModuleAliases,
  hostModuleDedupePackages,
  hostModuleStandIns,
  hostPackageVersionExpectations,
  hostPackageVersionMismatches,
  installedHostPackageVersion,
  LocalHostResolutionError,
} from "./host-modules.ts";
export type {
  HostModuleStandIn,
  HostPackageVersionExpectation,
  HostPackageVersionMismatch,
} from "./host-modules.ts";

// The Vite plugin (#23's steps 1, 2, 4, 5 and 6)
export {
  devHarness,
  DEV_HARNESS_PLUGIN_NAME,
  formatFastRefreshWarning,
  formatHostVersionWarning,
  HARNESS_ENTRY_URL_PATH,
  HARNESS_MOUNT_ELEMENT_ID,
  harnessHostModulePlan,
  REACT_FAST_REFRESH_PLUGIN_NAME,
  reactFastRefresh,
} from "./vite-plugin.ts";
export type { DevHarnessOptions, DevHarnessVitePlugin } from "./vite-plugin.ts";

// The project's local-dev configuration, audited at server start (#23 plan step 5)
export {
  auditHarnessConfiguration,
  blockingLocalDevFindings,
  BlockingLocalDevFindingError,
  formatHarnessAudit,
  readProjectDependencyDecisions,
} from "./local-dev-audit.ts";
export type { HarnessAuditInput } from "./local-dev-audit.ts";

// The seam between the node half and the browser half. Types only: the modules themselves
// are reached by path (`./mount`), because the browser half must not be pulled in here.
export type { DevHarnessMountableCell, DevHarnessMountTarget } from "./types.ts";
