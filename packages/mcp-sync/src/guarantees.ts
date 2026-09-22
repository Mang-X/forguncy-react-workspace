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
      "Locally, only the flow's shape is checkable: `assertMcpSyncFlowIsCoherent` proves the step exists, is a post-mutation step, and runs before the page is generated. It cannot prove the call happens.",
  },
  {
    id: "runtime-locator-returned",
    statement: "Runtime generation result/URL is returned for verification.",
    level: "real-runtime",
    howToCheck:
      "Assert a completed sync returns a runtime locator for the target page, and that a generation failure is reported as a structured failure rather than an empty result.",
    caveat:
      "The locator's *field name* is this contract's, not the platform's — #5 records the URL the flow produced, not the response object it arrived in — so the correspondence is the adapter's to get right and only a real project can confirm it.",
  },
  {
    id: "sync-is-idempotent",
    statement:
      "Running sync twice with the same artifact does not materially change project state or generated code, and extension reference order is stable.",
    level: "local",
    howToCheck:
      "Stamp the same artifact twice and assert the stamped code is byte-identical; assert the plan's mutation serializes identically across runs; and assert that a target whose marker carries this artifact's fingerprint is classified `identical` and planned as a skip.",
    caveat:
      "Two halves are outside a local check. Whether a second `setCells` with an identical payload leaves the project byte-identical is the platform's behaviour, and so is whether the designer's own share of the cell around the code keeps its geometry. The local guarantee is that sync asks for no change it does not need.",
  },
  {
    id: "probable-designer-divergence-detected",
    statement: "Probable designer-side divergence is detected before overwrite.",
    level: "local",
    howToCheck:
      "Classify a target that carries a marker whose code hash no longer matches its source as `edited-after-generation`, and a non-empty target without a marker as `foreign-code`; assert both resolve to a conflict under the default policy and that a refusal names what it protected.",
    caveat:
      "Detection needs the target's current source, and the operation that reads one has no established call name yet (see `unestablishedSyncCapabilities()`). Until it does, a plan can only apply the classification to a state the caller supplied — which is why `cell-state-unverifiable` is a refusal rather than a silent pass.",
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
