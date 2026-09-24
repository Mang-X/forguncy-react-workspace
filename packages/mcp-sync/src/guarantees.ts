/**
 * The public guarantees of a one-way sync.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19).
 *
 * #19 fixes what the flow does and, in its acceptance criteria, what it promises.
 * They are recorded here as data rather than as prose, for the reason `core` records
 * its decisions as data: a guarantee that only exists in a comment cannot be asserted
 * by a test, a diagnostic or the implementation Issue (#20).
 *
 * Every statement below is #19's own wording, kept as close to verbatim as a
 * module-level sentence allows, so that editing a promise is a deliberate edit
 * against the Spec rather than an incidental rewrite.
 *
 * `level` answers one question, and it is the question AGENTS.md rule 7 is about:
 * could a local check establish this, or does only a real Forguncy project produce
 * the evidence? It is the same axis `core` uses (`DependencyCheckLevel`), reused
 * rather than restated. Read {@link realRuntimeSyncGuarantees} before reporting a
 * green local run as a working sync — every entry there is a promise a passing
 * `vp test` says nothing about, and #20's own validation plan says so too ("Local
 * mocks are insufficient for final acceptance").
 */

import type { DependencyCheckLevel } from "@forguncy-react-workspace/core";

export const SYNC_GUARANTEE_IDS = [
  "written-without-manual-copy",
  "extension-metadata-verified-before-mutation",
  "project-errors-checked-after-mutation",
  "runtime-locator-returned",
  "sync-is-idempotent",
  "probable-designer-divergence-detected",
  "one-way-only",
] as const;

export type SyncGuaranteeId = (typeof SYNC_GUARANTEE_IDS)[number];

/**
 * The environment #20's real-project validation ran in.
 *
 * One string rather than a struct, and quoted in full at every use, because the value's
 * job is to be *read*: a reader deciding whether a validation still applies needs the
 * product version and the fact that it was a real designer session, and both are in here.
 *
 * The evidence behind it — the executed checks, their raw output, the page they ran on and
 * the browser observation of the generated page — is on Issue #20
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/20), and the script that
 * produced it is `packages/mcp-sync/scripts/validate-sync-against-designer.mjs`.
 */
export const EXECUTED_AGAINST_DESIGNER =
  "Forguncy 12.0.100.0 (designer assembly 12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623), a live MCP designer session against a disposable page; re-run with packages/mcp-sync/scripts/validate-sync-against-designer.mjs, evidence on #20.";

export interface SyncGuarantee {
  readonly id: SyncGuaranteeId;
  /** The promise, in the Spec's wording. */
  readonly statement: string;
  /** Whether a local check can establish the promise, or a real project must. */
  readonly level: DependencyCheckLevel;
  /** What an executed check for this guarantee actually does. */
  readonly howToCheck: string;
  /** Set when the guarantee is deliberately weaker than it reads. */
  readonly caveat?: string;
  /**
   * Where the check was actually run, when it has been.
   *
   * Absent until an execution happens, and present afterwards, so "this could be checked
   * against a real project" and "this has been" are different facts a reader can tell
   * apart. `level` deliberately does not change when this is set: a real-runtime guarantee
   * does not become locally checkable because someone checked it once — the level says who
   * *can* establish the promise, and this says whether anyone has.
   *
   * AGENTS.md rule 7 is the reason both fields exist. A green `vp test` is not runtime
   * compatibility, and a completed runtime validation is not a permanent property of the
   * code: the record below names the environment it ran in, and a different Forguncy
   * version is a re-run rather than an inheritance.
   */
  readonly executedAt?: string;
}

export const SYNC_GUARANTEES: readonly SyncGuarantee[] = [
  {
    id: "written-without-manual-copy",
    statement:
      "A compiled artifact can be written into a designated ReactCellType Cell without manual copy/paste.",
    // The mutation itself is a designer call, so nothing local can establish that
    // the write landed. What is local is the *payload*: the plan assembles it and
    // its shape is asserted here.
    level: "real-runtime",
    howToCheck:
      "Sync against a real project and read the Cell back: the persisted `cellTypeProps` carries the generated `code` and the `frontendLibraries` references that were planned, and no step was performed by hand.",
    caveat:
      "The local half is the mutation payload — its field names are the platform's (`pageName`, `cell`, `cellType`, `cellTypeProps.code`, `cellTypeProps.frontendLibraries[].libraryId`) and `planCellSync` refuses to emit anything else. Whether the write is *accepted* is the platform's answer, not this contract's.",
    executedAt: EXECUTED_AGAINST_DESIGNER,
  },
  {
    id: "extension-metadata-verified-before-mutation",
    statement: "Extension metadata is verified from MCP rather than guessed.",
    level: "local",
    howToCheck:
      "Supply the listing `api.app.listFrontendLibraries` returned and assert the plan reports, per referenced library, that its stable id resolves, that the global the listing publishes is the one the artifact's decisions name, and that its bundle and type definitions are present — and that a library the listing does not know produces `missing-extension` rather than a silent pass.",
    caveat:
      "#12 owns the audit itself; this package consumes it rather than restating it, so the local check is 'the plan applies the audit and gates the mutation on it'. The listing is input: a plan verified against a hand-written listing proves the *check* works, not that a project's extensions resolve.",
  },
  {
    id: "project-errors-checked-after-mutation",
    statement: "Project errors are checked immediately after sync.",
    level: "real-runtime",
    howToCheck:
      "Complete a sync against a real project and assert `api.app.checkProjectErrors` was called after the mutation and that a non-zero `errorCount` failed the operation instead of being reported as success.",
    caveat:
      "Locally, only the flow's shape is checkable: `assertMcpSyncFlowIsCoherent` proves the step exists, is a post-mutation step, and runs before the page is generated, and the executor's own tests assert the call order it performs against a stub port. Neither can prove a *real* project returned the count the run reports; only a real project can.",
    executedAt: EXECUTED_AGAINST_DESIGNER,
  },
  {
    id: "runtime-locator-returned",
    statement: "Runtime generation result/URL is returned for verification.",
    level: "real-runtime",
    howToCheck:
      "Assert a completed sync returns a runtime locator for the target page, and that a generation failure is reported as a structured failure rather than an empty result.",
    caveat:
      "The locator's *field name* is this contract's, not the platform's — #5 records the URL the flow produced, not the response object it arrived in — so the correspondence is the adapter's to get right and only a real project can confirm it.",
    executedAt: EXECUTED_AGAINST_DESIGNER,
  },
  {
    id: "sync-is-idempotent",
    statement:
      "Running sync twice with the same artifact does not materially change project state or generated code, and extension reference order is stable.",
    level: "local",
    howToCheck:
      "Stamp the same artifact twice and assert the stamped code is byte-identical; assert the plan's mutation serializes identically across runs; and assert that a target whose marker carries this artifact's fingerprint is classified `identical` and planned as a skip.",
    caveat:
      "Two halves are outside a local check, and #20 executed both: a second `setCells` with an identical payload left the Cell byte-identical, and a merged Cell kept its `rowSpan`/`colSpan` when the mutation omitted them. What a local check establishes is that sync asks for no change it does not need.",
    executedAt: EXECUTED_AGAINST_DESIGNER,
  },
  {
    id: "probable-designer-divergence-detected",
    statement: "Probable designer-side divergence is detected before overwrite.",
    level: "local",
    howToCheck:
      "Classify a target that carries a marker whose code hash no longer matches its source as `edited-after-generation`, a non-empty target without a marker as `foreign-code`, and a target holding a value or another cell type as `foreign-code` too — assert all three resolve to a conflict under the default policy and that a refusal names what it protected.",
    caveat:
      "The *classification* is local; the *read* that feeds it is a designer call. #20 established that call (`api.page.getCells`) and measured that the product reports an occupied Cell without a `code` property, which is why `occupied` is a refusal rather than an empty string. What remains the platform's is whether a read always reports the full source: #20 observed a complete 17,125-character read, and the adapter is what maps the product's response onto `DeployedCellState`.",
  },
  {
    id: "one-way-only",
    statement:
      "The repository is the source of truth: sync writes generated deployment output and does not reconcile designer edits, and designer-to-repository synchronisation is not an implicit behaviour.",
    level: "local",
    howToCheck:
      "Assert the port exposes no operation that returns repository source or writes it, and that the plan's every output is deployment-side.",
    caveat:
      "This is a property of the interfaces, so it is only as strong as the interface set: a future `pull` feature is an explicit Spec, and adding one here would be the change this guarantee is there to make visible.",
  },
];

export function findSyncGuarantee(id: SyncGuaranteeId): SyncGuarantee {
  const guarantee = SYNC_GUARANTEES.find(candidate => candidate.id === id);
  if (!guarantee) {
    throw new Error(`Unknown sync guarantee "${id}".`);
  }
  return guarantee;
}

/** The guarantees a local check can establish. */
export function locallyCheckableSyncGuarantees(): readonly SyncGuarantee[] {
  return SYNC_GUARANTEES.filter(guarantee => guarantee.level === "local");
}

/**
 * The guarantees that only a real Forguncy project can establish.
 *
 * Read this list before reporting a sync as working: every entry here is a promise a
 * green `vp test` says nothing about.
 */
export function realRuntimeSyncGuarantees(): readonly SyncGuarantee[] {
  return SYNC_GUARANTEES.filter(guarantee => guarantee.level === "real-runtime");
}

/**
 * The real-runtime guarantees nobody has executed yet.
 *
 * The complement of {@link executedAt} among the promises a local check cannot reach. It
 * is empty as of #20, and kept as a function rather than asserted once because the next
 * guarantee added at `real-runtime` level should appear here rather than being assumed
 * discharged by the run that preceded it.
 */
export function unexecutedRealRuntimeSyncGuarantees(): readonly SyncGuarantee[] {
  return realRuntimeSyncGuarantees().filter(guarantee => guarantee.executedAt === undefined);
}
