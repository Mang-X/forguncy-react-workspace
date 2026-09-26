/**
 * The MCP flow #19 prescribes, and how far the evidence behind each call goes.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), governed by
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/12
 *
 * #19 writes its flow as "the actual available Forguncy MCP capabilities/semantics"
 * and then hedges each step with "(or the exact supported equivalent)". That hedge
 * is the whole problem this module solves: a flow whose call names are
 * approximately known compiles fine and fails against a real project, and #19's own
 * decision — the repository is the source of truth, sync writes deployment output —
 * makes a failed write a failed deployment. So every call name here is either
 * **established** by evidence and quoted verbatim, or **unestablished**, and the
 * registry refuses to let the second kind acquire a plausible-looking name.
 *
 * Three consequences, all deliberate:
 *
 * 1. **The port has no method a step cannot cite.** `port.ts` declares one method
 *    per established, required capability, and {@link assertMcpSyncFlowIsCoherent}
 *    checks the two registries against each other. Adding a call means adding
 *    evidence, not adding a method.
 * 2. **Steps are data with a phase, not a comment.** #19's ordering requirements
 *    (verify extensions before writing, check project errors after writing, generate
 *    after checking) become invariants a guard enforces, because the failure mode of
 *    getting them wrong is a project that was mutated and never validated.
 * 3. **Two required operations were unnamed, and are now established by execution.** Reading
 *    a Cell's current source is what #19's "surface a conflict instead of destroying
 *    probable designer edits" depends on; saving the project is what its step 4 depends on.
 *    Neither call name was recorded in the evidence available when this contract was written
 *    (#5 read persisted cell props back but did not record the call it used), so both were
 *    `unestablished` and every plan refused. #20 performed both against a real Forguncy
 *    12.0.100.0 session and recorded the calls: `api.page.getCells` to read, `api.app.saveProject`
 *    to persist. The evidence source records what was executed and, just as importantly, which
 *    *other* call was rejected and why — `readCellCode` is real but truncated at 12,000
 *    characters, so it cannot be the divergence reader.
 *
 * Scope note: this module states the flow, its evidence, and whether it can be
 * executed. It does not call anything — the transport is #20's — and it does not
 * decide the sync's policy, which lives in `divergence.ts` and `sync-plan.ts`.
 */

import type { RuntimeEvidenceChannel } from "@forguncy-react-workspace/core";

import { FORGUNCY_SYNC_PORT_METHODS } from "./port.ts";
import type { ForguncySyncPortMethod } from "./port.ts";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Where a claim about the designer's API surface was read.
 *
 * Two sources, because two exist, and the distinction matters for how much a claim
 * is worth: one is an operation that was *executed* against a real project during
 * #5's probe, the other is the product's own guide, which states intent but has not
 * been run here.
 *
 * The channel is `core`'s, not a new one: `RuntimeEvidenceChannel` is the
 * repository's single vocabulary for "how was this observed", and inventing a
 * parallel one for the designer surface would be two answers to one question.
 */
export const SYNC_EVIDENCE_SOURCE_IDS = [
  "issue-5-designer-probe",
  "forguncy-library-guide",
  "issue-20-designer-execution",
  "issue-115-designer-probe",
] as const;

export type SyncEvidenceSourceId = (typeof SYNC_EVIDENCE_SOURCE_IDS)[number];

export interface SyncEvidenceSource {
  readonly id: SyncEvidenceSourceId;
  /** The `core` channel this source records through. */
  readonly channel: RuntimeEvidenceChannel;
  /** Where to read it, so a reviewer can check the claim instead of trusting it. */
  readonly citation: string;
  /** What this source can and cannot establish. */
  readonly scope: string;
}

export const SYNC_EVIDENCE_SOURCES: Readonly<Record<SyncEvidenceSourceId, SyncEvidenceSource>> = {
  "issue-5-designer-probe": {
    id: "issue-5-designer-probe",
    channel: "designer-api",
    citation:
      "#5's executed evidence, labelled `[DT]` in that Issue's comment \"Runtime contract evidence — ReactCellType on Forguncy 12.0.100\" (https://github.com/Mang-X/forguncy-react-workspace/issues/5).",
    scope:
      "The calls actually made against a real designer session: `api.page.setCells`, `api.app.listFrontendLibraries`, `api.app.checkProjectErrors`, `api.app.generatePageAsync`, and `api.app.getProjectSaveStatus`. It also records the *results* of some of them (the persisted `cellTypeProps`, `errorCount: 0`, the generated runtime URL). It does not record the call #5 used to read persisted cell state back, which is why that operation is `unestablished` below.",
  },
  "forguncy-library-guide": {
    id: "forguncy-library-guide",
    channel: "product-documentation",
    citation:
      "The product guide the Forguncy frontend-library Skill ships in this repository: `.agents/skills/forguncy-frontend-library/references/upload-and-integrate.md` (§上传与覆盖, §ReactCellType 引用写法, §完整 MCP 验证流程), whose own header cites 指南 §12–15.",
    scope:
      "The argument shapes the product documents — in particular `api.page.setCells`'s request envelope (`pageName`, `cells[].cell`/`cellType`/`cellTypeProps`) — and the order the guide's own end-to-end flow runs in. It is documentation, not an execution: nothing in it was run in this repository, and a documented field is not a measured one.",
  },
  "issue-20-designer-execution": {
    id: "issue-20-designer-execution",
    channel: "designer-api",
    citation:
      "#20's own executed evidence against a real designer session — recorded on the Issue (https://github.com/Mang-X/forguncy-react-workspace/issues/20). Environment: MCP `http://localhost:11234/mcp`, `serverInfo = Forguncy 12.0.100.0`, designer assembly `12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623`; project `前端拓展包集成示例.fgcc`; the product's own API reference, which the designer serves over MCP VFS at `/apis/**`.",
    scope:
      "The two operations #5 left unnamed, *performed* (this source is an execution, not a reading of one) and the product reference that documents them: `api.page.getCells` and `api.page.getCellCodeContext` (both read a Cell's persisted state) and `api.app.saveProject` (persists it). It also records what `api.page.readCellCode` does — the segmented reader — and the measurement that decides which of the two readers the divergence check uses: `readCellCode` returned exactly 12,000 characters with `hasMore: true` for a 17,125-character cell, while `getCells` returned all 17,125 characters of the same `cellTypeProps.code`. It records the designer's own `baseHash` equals `sha256` of the stored code string byte-for-byte (LF line endings, trailing newline preserved). What it does **not** record: any claim that these calls are stable across Forguncy versions other than 12.0.100.0, or that `getCells` has no size budget — only that none was observed at 17,125 characters.",
  },
  "issue-115-designer-probe": {
    id: "issue-115-designer-probe",
    channel: "designer-api",
    citation:
      "#115's own executed evidence against a live designer session (https://github.com/Mang-X/forguncy-react-workspace/issues/115). Environment: MCP `http://localhost:11234/mcp`, `serverInfo = Forguncy 12.0.101.0`, designer assembly `12.0.101.0+92cefba44ce06dc75c2633bf5f6c6771e4ee41f0`; project `前端拓展包集成示例.fgcc`; the product's own API reference served over MCP VFS at `/apis/**`.",
    scope:
      "The two shapes #115 found to be version-sensitive between the pinned 12.0.100.0 and this 12.0.101.0 build. (1) **The read-back cell-type name.** `api.page.setCells` accepted `ReactCellTypeCellType`, `ReactCellType` and the display name `React AI 单元格` for the same cell type — which the `setCells` reference states as 内置别名、类型名或显示名 — and all three read back through `api.page.getCells` as `cellType: \"ReactCellType\"`, with the same `cellTypeProps.code` byte for byte. The product's own reference (`/apis/cellTypes/ReactCellType.md`, `/apis/cellTypes/index.md`) also calls the type `ReactCellType`; `ReactCellTypeCellType` appears in neither. `UserControlPageCellType` wrote and read back as itself with `cellTypeProps: { overflowMode }` and no `code`. (2) **The generation call.** `api.app.generatePageAsync` is not an own property of `api.app` on this build and calling it throws; `api.app.generateProject` exists, is documented at `/apis/app/generateProject.md` (permission `read/safe`, request `{ skipCheckProjectError? }`, response `{ url, message, checkResult, success? }`), and was executed: with `{}` and with `{ skipCheckProjectError: true }` it resolved `success: true` with `url = \"http://localhost:63982/Forguncy\"` and `checkResult.errorCount: 0` — the same runtime *base* #20 measured, so the page-route mapping is unchanged. What it does **not** record: any re-measurement of `12.0.100.0`. That build is not installed on this machine, so neither shape is claimed for it, and nothing here narrows or widens #20's own findings.",
  },
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const SYNC_CAPABILITY_IDS = [
  "list-frontend-libraries",
  "read-cell-source",
  "write-cell-source",
  "save-project",
  "check-project-errors",
  "generate-page",
  "project-save-status",
] as const;

export type SyncCapabilityId = (typeof SYNC_CAPABILITY_IDS)[number];

/**
 * How far the evidence for a designer call goes.
 *
 * Two levels, because two exist:
 *
 * - `established` — the exact call name is recorded by a source above. The name is
 *   quoted, never paraphrased.
 * - `unestablished` — the flow needs this operation and no recorded evidence names
 *   it. A capability in this state may not carry a method, may not be reached
 *   through the port, and must say what would establish it.
 *
 * There is deliberately no third, weaker level such as "documented equivalent" or
 * "expected": a level between the two would be where a guess lives, and the point of
 * the axis is that a guess has no name here. The axis survives its own success — every
 * required capability is `established` today, so the guards' `unestablished` branches are
 * exercised against supplied records in `capability-surface.test.ts` rather than against
 * the shipped table, which is how a check would otherwise stop checking anything.
 */
export type SyncCapabilityConfirmation = "established" | "unestablished";

export interface SyncCapability {
  readonly id: SyncCapabilityId;
  readonly summary: string;
  readonly evidenceSources: readonly SyncEvidenceSourceId[];
  readonly confirmation: SyncCapabilityConfirmation;
  /** The exact call, when {@link SyncCapability.confirmation} is `established`. */
  readonly method?: string;
  /** The port method, exactly when this capability is established *and* required. */
  readonly portMethod?: ForguncySyncPortMethod;
  /** The steps that need this capability. Empty for a recorded-but-unused call. */
  readonly usedByStepIds: readonly McpSyncStepId[];
  /** What would establish an unestablished call. Non-empty exactly in that state. */
  readonly blockedBy?: string;
  readonly note?: string;
}

export const SYNC_CAPABILITIES: readonly SyncCapability[] = [
  {
    id: "list-frontend-libraries",
    summary: "Read the project's installed frontend extensions, with their stable ids.",
    evidenceSources: ["issue-5-designer-probe", "forguncy-library-guide"],
    confirmation: "established",
    method: "api.app.listFrontendLibraries",
    portMethod: "listFrontendLibraries",
    usedByStepIds: ["verify-extension-metadata"],
    note: "#19's step 2 rests entirely on this call being the authority for `libraryId`, `globalName`, `exists` and `typeDefinitionAvailable`, which is also #12's rule: the id comes from this listing or from a verified catalog artifact, never from a display name.",
  },
  {
    id: "read-cell-source",
    summary: "Read the source and library references a target Cell currently holds.",
    evidenceSources: [
      "issue-5-designer-probe",
      "forguncy-library-guide",
      "issue-20-designer-execution",
      "issue-115-designer-probe",
    ],
    confirmation: "established",
    method: "api.page.getCells",
    portMethod: "readCellSource",
    usedByStepIds: ["read-target-state"],
    note: "Established by #20's execution rather than by #5's probe, which is why the call is `getCells` and not `readCellCode`. Both read a Cell's persisted state and both were run; `readCellCode` was rejected as the divergence reader on evidence, not on preference: it is a segmented reader (`一次最多返回 200 行和 12000 个字符`) and returned `hasMore: true` at 12,000 characters of a 17,125-character cell, so using it would splice a truncated prefix into the marker parse and report a whole generated Cell as `malformed-marker` — the one refusal that tells a person their source was edited. `getCells` returned that same cell's full 17,125 characters. It also reports the two things the divergence check needs *together* — `cellTypeProps.code` and `cellTypeProps.frontendLibraries` — where the code readers return source alone, and it distinguishes 'the Cell is blank' (absent from `cells`) from 'the Cell holds something that is not a ReactCellType' (present, with a `value` or another `cellType`). The *call* is unchanged by #115; what #115 adds is the name this read reports for a React Cell, which is one value (`ReactCellType`) and not the write alias, and therefore the input `readOneCell`'s recognition check must be built from.",
  },
  {
    id: "write-cell-source",
    summary: "Write one Cell's generated source and its `frontendLibraries` references.",
    evidenceSources: ["issue-5-designer-probe", "forguncy-library-guide"],
    confirmation: "established",
    method: "api.page.setCells",
    portMethod: "setCells",
    usedByStepIds: ["write-cell-source"],
    note: "The only mutating call in the flow, and the reason `assertMcpSyncFlowIsCoherent` insists the flow has exactly one mutation step: a second mutating call would be a second thing that has to be made idempotent.",
  },
  {
    id: "save-project",
    summary: "Persist the project after a mutation.",
    evidenceSources: ["forguncy-library-guide", "issue-20-designer-execution"],
    confirmation: "established",
    method: "api.app.saveProject",
    portMethod: "saveProject",
    usedByStepIds: ["save-project-if-required"],
    note: "The call #5 left unnamed, established by #20's execution. `api.app.saveProject({})` resolved `{ saved: true, message: \"工程保存成功。\" }` and the save status read back `containsUnsavedChanges: false`; the product reference documents its permission as `write/safe` and its return type as `ProjectSaveStatusResponse` — the *same* type `getProjectSaveStatus` returns, with `saved` set only by `saveProject`. The guide's step 保存工程 is therefore real and named, not a paraphrase.",
  },
  {
    id: "check-project-errors",
    summary: "Read the project's error count after a mutation.",
    evidenceSources: ["issue-5-designer-probe", "forguncy-library-guide"],
    confirmation: "established",
    method: "api.app.checkProjectErrors",
    portMethod: "checkProjectErrors",
    usedByStepIds: ["check-project-errors"],
    note: "#5 records the field this returns (`errorCount`), which is why the sync contract can state the failure condition — non-zero is a failed sync — instead of describing it.",
  },
  {
    id: "generate-page",
    summary: "Generate the target page and report the runtime locator a browser can open.",
    evidenceSources: ["issue-5-designer-probe", "forguncy-library-guide", "issue-115-designer-probe"],
    confirmation: "established",
    method: "api.app.generateProject",
    portMethod: "generatePageAsync",
    usedByStepIds: ["generate-page"],
    note: "Generation is project-wide and answers with the runtime *base*; the adapter turns that base into a page locator (`runtimePageUrl`), which is the mapping `port.ts`'s `GeneratedPage` leaves to it. **The call name is version-sensitive, and this entry names the one that exists on both builds the repository knows of.** #5 measured `api.app.generatePageAsync` on 12.0.100.0 and #20 executed the flow on it; #115 executed `api.app.generateProject` on 12.0.101.0, where `generatePageAsync` is absent — same argument (`{}`, or `skipCheckProjectError`), same response shape, same base URL. `generateProject` is therefore the established name and the one the adapter asks for first, with `generatePageAsync` recognised as the older build's spelling of the same operation (`GENERATE_PROJECT_SCRIPT`). This is not a name that 'looks like' the right one: both were executed, both are documented by the product, and the two are distinguished by `typeof api.app.<name>` — a fact about the build — rather than by a version table. A build exposing *neither* is refused rather than guessed at; see the adapter.",
  },
  {
    id: "project-save-status",
    summary: "Read whether the project has unsaved changes.",
    evidenceSources: ["issue-5-designer-probe", "issue-20-designer-execution"],
    confirmation: "established",
    method: "api.app.getProjectSaveStatus",
    portMethod: "getProjectSaveStatus",
    usedByStepIds: ["save-project-if-required"],
    note: "Recorded by #5, and made *required* by #20's execution rather than merely recorded. The step is named `save-project-if-required`, and #20 measured what makes it required: a `setCells` write leaves `containsUnsavedChanges: true`, and `saveProject` clears it. Without this read the step could only guess, and guessing 'always save' would make a clean project's state depend on sync having run. The same execution keeps #5's warning true — this call *reports* dirtiness and does not persist anything; `saveProject` is the call that does, and it is the only one whose response sets `saved`.",
  },
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Where a step sits relative to the one mutation.
 *
 * The axis exists because #19's safety rules are all about *order*: extensions are
 * verified and divergence is checked before the write, and the project is validated
 * and generated after it. A phase makes that checkable; a comment does not.
 */
export const MCP_SYNC_STEP_PHASES = ["before-mutation", "mutation", "after-mutation", "result"] as const;

export type McpSyncStepPhase = (typeof MCP_SYNC_STEP_PHASES)[number];

/**
 * How the step is carried out.
 *
 * `repository-config` steps are not designer calls at all — resolving the target
 * from project configuration (#19 step 1, #26/#28's output) and handing the runtime
 * locator back to the caller both happen on this side. The distinction is what keeps
 * "there is no MCP call for this" from looking like "we could not find the MCP call
 * for this": the first is a design fact, the second is a missing name, and only the
 * second is `unestablished`.
 */
export type McpSyncStepTransport = "repository-config" | "designer-api";

export const MCP_SYNC_STEP_IDS = [
  "resolve-cell-target",
  "verify-extension-metadata",
  "read-target-state",
  "write-cell-source",
  "save-project-if-required",
  "check-project-errors",
  "generate-page",
  "return-runtime-locator",
] as const;

export type McpSyncStepId = (typeof MCP_SYNC_STEP_IDS)[number];

export interface McpSyncStep {
  readonly id: McpSyncStepId;
  /** 1-based, and asserted to equal the step's position in the list. */
  readonly order: number;
  readonly phase: McpSyncStepPhase;
  readonly transport: McpSyncStepTransport;
  readonly summary: string;
  readonly capabilityIds: readonly SyncCapabilityId[];
  /** Non-empty exactly when the step is `repository-config`. */
  readonly carriedOutBy?: string;
}

export const MCP_SYNC_STEPS: readonly McpSyncStep[] = [
  {
    id: "resolve-cell-target",
    order: 1,
    phase: "before-mutation",
    transport: "repository-config",
    summary: "Resolve the target page and Cell from project configuration, not from a scan of the project.",
    capabilityIds: [],
    carriedOutBy:
      "The caller, from the Cell target registry (#26/#28). It is an input to sync rather than a step sync performs — see `target.ts` — which is what makes \"sync targets must be explicit\" a type error rather than a rule.",
  },
  {
    id: "verify-extension-metadata",
    order: 2,
    phase: "before-mutation",
    transport: "designer-api",
    summary: "Verify every extension the artifact references against the project's installed libraries.",
    capabilityIds: ["list-frontend-libraries"],
  },
  {
    id: "read-target-state",
    order: 3,
    phase: "before-mutation",
    transport: "designer-api",
    summary: "Read what the target Cell currently holds, so a probable designer edit is found before it is overwritten.",
    capabilityIds: ["read-cell-source"],
  },
  {
    id: "write-cell-source",
    order: 4,
    phase: "mutation",
    transport: "designer-api",
    summary: "Write the generated source and its `frontendLibraries` references into the target Cell.",
    capabilityIds: ["write-cell-source"],
  },
  {
    id: "save-project-if-required",
    order: 5,
    phase: "after-mutation",
    transport: "designer-api",
    summary: "Persist the project when the MCP contract requires it after a mutation.",
    capabilityIds: ["project-save-status", "save-project"],
  },
  {
    id: "check-project-errors",
    order: 6,
    phase: "after-mutation",
    transport: "designer-api",
    summary: "Read the project's error count and fail the sync when it is non-zero.",
    capabilityIds: ["check-project-errors"],
  },
  {
    id: "generate-page",
    order: 7,
    phase: "after-mutation",
    transport: "designer-api",
    summary: "Generate the page so the deployed Cell can be verified in a browser.",
    capabilityIds: ["generate-page"],
  },
  {
    id: "return-runtime-locator",
    order: 8,
    phase: "result",
    transport: "repository-config",
    summary: "Hand the runtime locator and metadata back to the caller for browser verification.",
    capabilityIds: [],
    carriedOutBy:
      "The caller. It is the flow's output rather than an operation: `GeneratedPage` is what the previous step produced, and returning it is the contract's result type doing its job.",
  },
];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const SYNC_CAPABILITY_CONTRACT_ERROR_CODES = [
  "unknown-capability",
  "unknown-step",
  "unknown-evidence-source",
  "step-not-coherent",
  "capability-not-coherent",
  "port-drift",
] as const;

export type SyncCapabilityContractErrorCode = (typeof SYNC_CAPABILITY_CONTRACT_ERROR_CODES)[number];

/** Thrown when the flow, the capability registry and the port stop agreeing. */
export class SyncCapabilityContractError extends Error {
  readonly code: SyncCapabilityContractErrorCode;

  constructor(code: SyncCapabilityContractErrorCode, message: string) {
    super(message);
    this.name = "SyncCapabilityContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findSyncEvidenceSource(id: SyncEvidenceSourceId): SyncEvidenceSource {
  const source = SYNC_EVIDENCE_SOURCES[id];
  if (!source) {
    throw new SyncCapabilityContractError("unknown-evidence-source", `Unknown sync evidence source "${id}".`);
  }
  return source;
}

export function findSyncCapability(id: SyncCapabilityId): SyncCapability {
  const capability = SYNC_CAPABILITIES.find(candidate => candidate.id === id);
  if (!capability) {
    throw new SyncCapabilityContractError("unknown-capability", `Unknown sync capability "${id}".`);
  }
  return capability;
}

export function findMcpSyncStep(id: McpSyncStepId): McpSyncStep {
  const step = MCP_SYNC_STEPS.find(candidate => candidate.id === id);
  if (!step) {
    throw new SyncCapabilityContractError("unknown-step", `Unknown MCP sync step "${id}".`);
  }
  return step;
}

/** Unique evidence channels behind a capability, first-seen order preserved. */
export function syncCapabilityEvidenceChannels(capability: SyncCapability): readonly RuntimeEvidenceChannel[] {
  return [...new Set(capability.evidenceSources.map(id => findSyncEvidenceSource(id).channel))];
}

/** The capabilities the flow needs, in step order, each listed once. */
export function requiredSyncCapabilities(): readonly SyncCapability[] {
  const required = new Set(MCP_SYNC_STEPS.flatMap(step => step.capabilityIds));
  return SYNC_CAPABILITIES.filter(capability => required.has(capability.id));
}

/**
 * The required capabilities no recorded evidence names.
 *
 * Read this before reporting the flow as runnable. An empty result is the
 * precondition for #20's end-to-end acceptance criteria; a non-empty one names the
 * operations that have to be established first, and each carries the evidence that
 * would establish it.
 */
export function unestablishedSyncCapabilities(): readonly SyncCapability[] {
  return requiredSyncCapabilities().filter(capability => capability.confirmation === "unestablished");
}

/** The capabilities an executed flow reaches through the port, in registry order. */
export function establishedSyncPortMethods(): readonly ForguncySyncPortMethod[] {
  return requiredSyncCapabilities()
    .filter(capability => capability.portMethod !== undefined)
    .map(capability => capability.portMethod as ForguncySyncPortMethod);
}

/** The single mutating step. The flow has exactly one, by contract. */
export function syncMutationStep(): McpSyncStep {
  return findMcpSyncStep("write-cell-source");
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse a step whose shape does not match the flow's rules.
 *
 * Exported with the other two guards so the rules can be asserted against a supplied
 * record rather than only against the shipped registries. A guard that can only ever run
 * over the current table is a guard whose failure branch is never executed, which is how
 * a check quietly stops checking anything.
 */
export function assertMcpSyncStepCoherent(step: McpSyncStep, index: number): void {
  const id = step.id;

  if (step.order !== index + 1) {
    throw new SyncCapabilityContractError(
      "step-not-coherent",
      `Step "${id}" is at position ${index + 1} but declares order ${step.order}, so the flow's order is no longer readable from the list.`,
    );
  }

  if (step.summary.trim().length === 0) {
    throw new SyncCapabilityContractError("step-not-coherent", `Step "${id}" has no summary.`);
  }

  if (step.transport === "repository-config") {
    if (step.capabilityIds.length > 0) {
      throw new SyncCapabilityContractError(
        "step-not-coherent",
        `Step "${id}" is carried out on the repository side but names designer capabilities, which makes "there is no MCP call for this" indistinguishable from "the MCP call is unknown".`,
      );
    }
    if (step.carriedOutBy === undefined || step.carriedOutBy.trim().length === 0) {
      throw new SyncCapabilityContractError(
        "step-not-coherent",
        `Step "${id}" is not a designer call and does not say who carries it out.`,
      );
    }
    return;
  }

  if (step.capabilityIds.length === 0) {
    throw new SyncCapabilityContractError(
      "step-not-coherent",
      `Step "${id}" is a designer call but names no capability, so nothing records which call it makes.`,
    );
  }
  if (step.carriedOutBy !== undefined) {
    throw new SyncCapabilityContractError(
      "step-not-coherent",
      `Step "${id}" is a designer call and also claims to be carried out on the repository side.`,
    );
  }

  for (const capabilityId of step.capabilityIds) {
    const capability = findSyncCapability(capabilityId);
    if (!capability.usedByStepIds.includes(id)) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Step "${id}" needs capability "${capabilityId}", which does not list it back. The two registries disagree about what the flow does.`,
      );
    }
  }
}

/** Refuse a capability that claims more than its evidence supports. See the guard below. */
export function assertSyncCapabilityCoherent(capability: SyncCapability): void {
  const id = capability.id;

  if (capability.evidenceSources.length === 0) {
    throw new SyncCapabilityContractError(
      "capability-not-coherent",
      `Capability "${id}" cites no evidence source, so its confirmation claims nothing.`,
    );
  }
  for (const sourceId of capability.evidenceSources) {
    findSyncEvidenceSource(sourceId);
  }

  for (const stepId of capability.usedByStepIds) {
    const step = findMcpSyncStep(stepId);
    if (!step.capabilityIds.includes(id)) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" claims to be needed by step "${stepId}", which does not list it.`,
      );
    }
  }

  if (capability.confirmation === "established") {
    if (capability.method === undefined || !capability.method.startsWith("api.")) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" is established without an exact designer call name. An established capability quotes the call; it never paraphrases it.`,
      );
    }
    if (capability.blockedBy !== undefined) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" is established and blocked at the same time.`,
      );
    }
  } else {
    if (capability.method !== undefined) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" has no established call name and carries "${capability.method}" anyway, which is the guess the confirmation axis exists to prevent.`,
      );
    }
    if (capability.portMethod !== undefined) {
      throw new SyncCapabilityContractError(
        "port-drift",
        `Capability "${id}" has no established call name and is on the port anyway. The port's shape is the evidence boundary: it may only carry calls that were established.`,
      );
    }
    if (capability.blockedBy === undefined || capability.blockedBy.trim().length === 0) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" is unestablished without naming the evidence that would establish it.`,
      );
    }
    if (capability.usedByStepIds.length === 0) {
      throw new SyncCapabilityContractError(
        "capability-not-coherent",
        `Capability "${id}" is unestablished and no step needs it, so nothing about the flow depends on it being resolved.`,
      );
    }
  }
}

/**
 * Check the flow, the registry and the port against each other.
 *
 * Four questions, and each one is a way the three can silently disagree:
 *
 * - do the step list and the capability registry name the same steps;
 * - is there exactly one mutation, with every phase on the correct side of it, and
 *   are the project errors checked before the page is generated?
 * - does every capability's confirmation match whether it has a call name, a port
 *   method and a blocking reason;
 * - does the port expose exactly the established capabilities the flow needs?
 *
 * The last one is the load-bearing one. Without it, adding a method to
 * `ForguncySyncPort` would be enough to make an unverified call look like a
 * verified one, and the failure would only appear against a real project.
 */
/**
 * Refuse a port whose method set is not exactly the established capabilities' set.
 *
 * Takes both sides as arguments so the drift it exists to catch is testable: the shipped
 * call passes the registry's answer and the port's declaration, and a regression passes a
 * deliberately drifted pair. `missing` is the dangerous direction — a port method with no
 * established capability behind it is an unverified call wearing a verified call's shape.
 */
export function assertSyncPortMatchesCapabilities(
  established: readonly ForguncySyncPortMethod[],
  declared: readonly ForguncySyncPortMethod[] = FORGUNCY_SYNC_PORT_METHODS,
): void {
  const missing = declared.filter(method => !established.includes(method));
  const extra = established.filter(method => !declared.includes(method));
  if (missing.length > 0 || extra.length > 0) {
    throw new SyncCapabilityContractError(
      "port-drift",
      `The port and the capability registry disagree: ${
        missing.length > 0 ? `the port declares ${missing.join(", ")} with no established capability behind it` : ""
      }${missing.length > 0 && extra.length > 0 ? "; " : ""}${
        extra.length > 0 ? `${extra.join(", ")} is established but not on the port` : ""
      }.`,
    );
  }
}

export function assertMcpSyncFlowIsCoherent(): void {
  MCP_SYNC_STEPS.forEach(assertMcpSyncStepCoherent);
  SYNC_CAPABILITIES.forEach(assertSyncCapabilityCoherent);

  const mutations = MCP_SYNC_STEPS.filter(step => step.phase === "mutation");
  if (mutations.length !== 1) {
    throw new SyncCapabilityContractError(
      "step-not-coherent",
      `The flow has ${mutations.length} mutating steps. Every phase invariant below is written against there being exactly one.`,
    );
  }
  const mutation = mutations[0] as McpSyncStep;

  for (const step of MCP_SYNC_STEPS) {
    if (step.phase === "before-mutation" && step.order > mutation.order) {
      throw new SyncCapabilityContractError(
        "step-not-coherent",
        `Step "${step.id}" is a pre-mutation check but runs after the mutation, so it cannot prevent it.`,
      );
    }
    if (step.phase === "after-mutation" && step.order < mutation.order) {
      throw new SyncCapabilityContractError(
        "step-not-coherent",
        `Step "${step.id}" validates the mutation but runs before it.`,
      );
    }
  }

  // #19's order, kept as an invariant rather than as prose: "Run checkProjectErrors;
  // treat non-zero errors as sync validation failure" precedes the generate step, so
  // a broken project is reported instead of being deployed and generated.
  const errors = findMcpSyncStep("check-project-errors");
  const generate = findMcpSyncStep("generate-page");
  if (errors.order >= generate.order) {
    throw new SyncCapabilityContractError(
      "step-not-coherent",
      `"check-project-errors" (order ${errors.order}) must run before "generate-page" (order ${generate.order}); otherwise a project with errors is generated and reported as a successful sync.`,
    );
  }

  const portMethods = establishedSyncPortMethods();
  assertSyncPortMatchesCapabilities(portMethods);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A report block for a CI log or a PR body. */
export function formatMcpSyncFlow(): string {
  const missing = unestablishedSyncCapabilities();
  const lines = [
    `MCP sync flow: ${MCP_SYNC_STEPS.length} step(s), ${requiredSyncCapabilities().length} required designer capabilities.`,
    ...MCP_SYNC_STEPS.map(step =>
      `  ${step.order}. ${step.id} [${step.phase}] ${
        step.capabilityIds.length === 0
          ? "(repository side)"
          : step.capabilityIds
              .map(id => {
                const capability = findSyncCapability(id);
                return `${id} -> ${capability.method ?? "NO ESTABLISHED CALL"}`;
              })
              .join(", ")
      }`,
    ),
    missing.length === 0
      ? "Every required designer operation has an established call name."
      : `${missing.length} required designer operation(s) have no established call name: ${missing
          .map(capability => capability.id)
          .join(", ")}. The flow cannot be executed end to end until each is established.`,
  ];
  return lines.join("\n");
}
