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

/**
 * The environment #115's real-project validation ran in.
 *
 * The second of the two executions on record, and the first recorded against a *different*
 * product version — which is the whole reason a version sits beside a route now. #115 re-probed
 * the two shapes that turned out to be version-sensitive (the read-back cell-type name, and
 * which generation call exists) and then drove both routes of the flow through the **shipped
 * adapter** on this build.
 *
 * Both scripts were run: `validate-sync-against-designer.mjs` (the write route, #20's script)
 * and `validate-unchanged-against-designer.mjs` (the unchanged route, #92's script), the latter
 * with the two port corrections it used to carry now removed — see its header.
 */
export const EXECUTED_AGAINST_REPROBE =
  "Forguncy 12.0.101.0 (designer assembly 12.0.101.0+92cefba44ce06dc75c2633bf5f6c6771e4ee41f0), a live MCP designer session against a disposable page, through the shipped adapter with no port corrections; re-run with packages/mcp-sync/scripts/validate-sync-against-designer.mjs and packages/mcp-sync/scripts/validate-unchanged-against-designer.mjs, evidence on #115.";

/**
 * The product versions the repository has *any* executed flow evidence on, oldest first.
 *
 * This is the **evidence vocabulary**, not the support claim: `12.0.100.0` is on it because
 * #20's run happened there and its record is still in the table, and a version cannot be named
 * by an execution row unless it appears here. Read {@link SYNC_SUPPORTED_VERSIONS} for the
 * versions the flow is currently claimed to work on — since #120 that is `12.0.101.0` alone,
 * and the two lists existing separately is what lets 100's evidence be *kept* without being
 * *claimed*.
 */
export const SYNC_MEASURED_VERSIONS = ["12.0.100.0", "12.0.101.0"] as const;

export type SyncMeasuredVersion = (typeof SYNC_MEASURED_VERSIONS)[number];

/**
 * The product versions the flow is currently claimed to work on.
 *
 * One, since #120: `12.0.100.0` is out of use, so coverage is owed — and reported — on
 * `12.0.101.0` only. {@link unexecutedRuntimeCoverage} iterates *this* list, which is why a
 * gap on a version nobody claims support for is no longer reported as an open item.
 *
 * Why this is separate from {@link SYNC_MEASURED_VERSIONS} rather than a deletion there: #20's
 * `12.0.100.0` execution row stays in {@link SYNC_EXECUTIONS} as history, and the version it
 * names has to remain a member of the vocabulary or the table stops type-checking. Dropping the
 * old version entirely would erase the record that the adapter's read-back tolerance exists
 * *because* of — the pinned build's read-back spelling was never measured, which is why the
 * adapter recognises both names. Keeping the evidence and narrowing the claim are two edits.
 *
 * Order is not what decides "which build is current" here, and the comment that used to say so
 * was describing an invariant that does not exist. `preferredCallOf` in
 * `capability-surface.ts` uses this list for **membership** — a call on a supported version wins
 * over one on a version that is only measured — and takes "newest" from `SYNC_MEASURED_VERSIONS`'s
 * own order. With one supported version the two agree, which is why the distinction only shows
 * up when someone adds a second; the lists are stated separately so that day is boring.
 *
 * What this list *is* for: it is the answer to "which versions may this repository claim", and it
 * only changes with a run. Adding a version is an edit against a run, never against a release note.
 */
export const SYNC_SUPPORTED_VERSIONS = ["12.0.101.0"] as const satisfies readonly SyncMeasuredVersion[];

export type SyncSupportedVersion = (typeof SYNC_SUPPORTED_VERSIONS)[number];

/**
 * One real-project execution of the flow, as a standalone record the promises point at.
 *
 * Separate from the guarantees because executions are **shared**: #20's run and #115's run each
 * discharged several promises, and #115's run covered two routes, so an execution is one event
 * with a route set rather than one promise's private field. #116's review is what forced the
 * split — the previous shape stored a *single* `executedAt`/`executedRoutes`/`executedVersion`
 * triple **per guarantee**, which cannot hold two runs against the same promise (the second
 * overwrites the first) and cannot say which run covered what.
 */
export interface SyncExecution {
  readonly id: SyncExecutionId;
  /** The environment, quoted in full at every use so a reader sees the version and the session. */
  readonly environment: string;
  readonly version: SyncMeasuredVersion;
  /** The routes through the flow's validation half that this run actually reached. */
  readonly routes: readonly SyncRuntimeRoute[];
  /** What produced it, so the claim is reproducible rather than trusted. */
  readonly evidence: string;
}

export const SYNC_EXECUTION_IDS = ["issue-20-write-route", "issue-115-both-routes"] as const;

export type SyncExecutionId = (typeof SYNC_EXECUTION_IDS)[number];

/**
 * The executions on record.
 *
 * Two, and the fact that the second one *re-ran* the first one's route rather than replacing it
 * is the whole reason this is a table: #20's run remains the only evidence for `12.0.100.0`, so
 * dropping it because a newer run covered the same route on a newer build would erase the pinned
 * version's evidence from the repository.
 */
export const SYNC_EXECUTIONS: Readonly<Record<SyncExecutionId, SyncExecution>> = {
  "issue-20-write-route": {
    id: "issue-20-write-route",
    environment: EXECUTED_AGAINST_DESIGNER,
    version: "12.0.100.0",
    routes: ["write"],
    evidence:
      "Executed 2026-09-24 for #20. The script asserted the second run stopped before the write (`write-cell-source=not-reached`), so it never reached the validation half on the unchanged route — the run is write-route evidence even though the artifact was synced twice. **Caveat, recorded here rather than glossed:** the run predates the read-back recognition #115 corrected (that check was added during #74's review, after this run) and never recorded which `cellType` name this build *reported*. So this row covers the build's write-route cells — the mutation payload landing, the error count, byte-identity on a repeat — and does **not** speak to the recognition fix or to that build's read-back spelling, which remains unmeasured.",
  },
  "issue-115-both-routes": {
    id: "issue-115-both-routes",
    environment: EXECUTED_AGAINST_REPROBE,
    version: "12.0.101.0",
    routes: ["write", "unchanged"],
    evidence:
      "Executed 2026-09-27 for #115, through the shipped adapter with the two port corrections #92's script used to carry removed. Both scripts were run: `validate-sync-against-designer.mjs` (write route, 20/20) and `validate-unchanged-against-designer.mjs` (unchanged route, 13/13).",
  },
};

/**
 * The routes a run can take through the flow's validation half.
 *
 * A *route* rather than a guarantee, because #92 showed the two are independent: the write
 * route replaces the Cell and the unchanged route finds it already correct, and both feed the
 * same save-status read, error gate, generation and locator. So #20's execution can discharge
 * "the project's errors were checked after the sync" for the write route while saying nothing
 * whatever about the unchanged route — the script it ran asserted the *opposite* there (the
 * second run stopped before those steps, `write-cell-source=not-reached`).
 *
 * Collapsing the two back onto one `executedAt` is what would overstate coverage: a reader
 * asking "is the unchanged path validated?" would be answered by evidence from a run that
 * never reached it. Named here so the question is answerable.
 */
export const SYNC_RUNTIME_ROUTES = ["write", "unchanged"] as const;

export type SyncRuntimeRoute = (typeof SYNC_RUNTIME_ROUTES)[number];

/**
 * What each route did before the validation half, for a reader of a coverage gap.
 *
 * "checked save status and saved if it was required", not "saved": the save is conditional on
 * the product's own answer (`completeSyncFlow` calls `saveProject` only when
 * `getProjectSaveStatus()` reports unsaved changes, and a clean run marks the step `skipped`).
 * A route description asserting a save would claim a call a clean run never makes — the same
 * defect as a diagnostic naming a mutation on a run that wrote nothing, one field over. Both
 * routes are conditional, so both say so.
 */
export const SYNC_RUNTIME_ROUTE_MEANINGS: Readonly<Record<SyncRuntimeRoute, string>> = {
  write:
    "the run wrote the Cell, then checked the save status and saved if the project required it, checked the project and generated the page",
  unchanged:
    "the run found the Cell already holding this artifact, wrote nothing, and still checked the save status and saved if the project required it, checked the project and generated the page",
};

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
   * The routes this promise spans, on the guarantees some run has been recorded against.
   *
   * Part of the execution *claim*, so recording a run forces the question "which route?" to be
   * answered rather than left to a reader's assumption. It is present exactly when
   * {@link SyncGuarantee.executions} is non-empty, and keyed on the execution rather than on
   * `level`, because a locally checkable promise can still have a real-project run against it —
   * `sync-is-idempotent` does — and that run covers routes too. A guarantee no run has touched
   * has no execution claim to qualify, and is wholly reported by
   * {@link unexecutedRealRuntimeSyncGuarantees} instead.
   *
   * The list of routes the promise *spans* — the claim — not the ones executed. A route here
   * covered by none of {@link SyncGuarantee.executions} *on some tracked version* is exactly the
   * gap {@link unexecutedRuntimeCoverage} reports, as part of a (promise, route, version) cell.
   */
  readonly runtimeRoutes?: readonly SyncRuntimeRoute[];
  /**
   * The executions that discharged this promise, in the order they happened.
   *
   * **A list, and the list is the point.** The route, the product version and the environment are
   * properties of a *run*, not of a promise: one run can cover several promises and several
   * routes, and one promise can be discharged by several runs. #116's review is what this shape
   * is answering — the previous version kept a single `executedAt`/`executedRoutes`/
   * `executedVersion` triple on each guarantee, which (a) cannot hold two runs against one
   * promise, because the second overwrites the first, and (b) made "which runs happened?" a
   * per-promise question whose answers could disagree with each other.
   *
   * **A non-empty tuple, not an array, and that is load-bearing.** `readonly []` would mean "this
   * promise has been executed zero times", which is spelled *absent* — so an array type would let
   * a record read as executed while claiming nothing, and `executions: []` would then satisfy
   * both the report that asks "has this been run?" and the one that asks "which cells are open?".
   * That is a double false negative in the direction that matters, and #116's third review
   * reproduced it. Typing the field non-empty makes `executions: []` a compile error rather than
   * a state the reports have to be careful about; the reports *also* treat it as unexecuted,
   * because a cast can still produce one and a guard that only holds for well-typed input is a
   * guard that fails open on exactly the input that is wrong.
   *
   * Absent until the promise has been executed at least once. `level` deliberately does not change
   * when this is set: a real-runtime guarantee does not become locally checkable because someone
   * checked it once — the level says who *can* establish the promise, and this says whether anyone
   * has.
   *
   * AGENTS.md rule 7 is why this exists at all. A green `vp test` is not runtime compatibility,
   * and a completed runtime validation is not a permanent property of the code: each entry names
   * the environment and version it ran in, and a different Forguncy version is a re-run rather
   * than an inheritance.
   */
  readonly executions?: readonly [SyncExecution, ...SyncExecution[]];
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
    // Write only, and that is not an omission: the promise is that a write lands, and it has
    // no meaning on a run that wrote nothing. #92's unchanged route does not touch it.
    runtimeRoutes: ["write"],
    // Both runs: a write landing on the write route is what this promise is, and both executed it
    // — #20 on the pinned build, #115 through the shipped adapter. Keeping #20's entry is not
    // sentiment: it is the only evidence for 12.0.100.0, and it is the *reason* the read-back
    // tolerance exists.
    executions: [SYNC_EXECUTIONS["issue-20-write-route"], SYNC_EXECUTIONS["issue-115-both-routes"]],
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
      "Complete a sync against a real project and assert `api.app.checkProjectErrors` was called after the sync's own work — on either route, write or unchanged — and that a non-zero `errorCount` failed the operation instead of being reported as success.",
    caveat:
      "Locally, only the flow's shape is checkable: `assertMcpSyncFlowIsCoherent` proves the step exists, is a post-mutation step, and runs before the page is generated, and the executor's own tests assert the call order it performs against a stub port. Neither can prove a *real* project returned the count the run reports; only a real project can.",
    // #92 made the gate reachable on a run that wrote nothing, so the promise spans two routes.
    // #20's run covered only the write route; #115's covered both, through the shipped adapter —
    // and only on 12.0.101.0, so the `unchanged` cells on the pinned build stay open below.
    runtimeRoutes: ["write", "unchanged"],
    // Both runs: #115's covers both routes on 12.0.101.0, #20's covers the write route on
    // 12.0.100.0. Both are listed, so "the unchanged route is executed" and "the pinned build's
    // write route is executed" are two facts a reader can get from here rather than one that
    // displaces the other.
    executions: [SYNC_EXECUTIONS["issue-20-write-route"], SYNC_EXECUTIONS["issue-115-both-routes"]],
  },
  {
    id: "runtime-locator-returned",
    statement: "Runtime generation result/URL is returned for verification.",
    level: "real-runtime",
    howToCheck:
      "Assert a completed sync returns a runtime locator for the target page, and that a generation failure is reported as a structured failure rather than an empty result.",
    caveat:
      "The locator's *field name* is this contract's, not the platform's — #5 records the URL the flow produced, not the response object it arrived in — so the correspondence is the adapter's to get right and only a real project can confirm it.",
    // Same split as the error gate: #92 returns a locator from a run that wrote nothing, and
    // that route is a different moment in the flow from the write route. #115's run returned a
    // locator on both routes through the adapter, which is what the second entry rests on.
    runtimeRoutes: ["write", "unchanged"],
    // #115's run covers both routes; #20's covers the write route on the pinned build. Both are
    // listed, so "the unchanged route is executed" and "12.0.100.0's write route is executed"
    // are two facts a reader can get from here rather than one that displaces the other.
    executions: [SYNC_EXECUTIONS["issue-20-write-route"], SYNC_EXECUTIONS["issue-115-both-routes"]],
  },
  {
    id: "sync-is-idempotent",
    statement:
      "Running sync twice with the same artifact does not materially change project state or generated code, and extension reference order is stable.",
    level: "local",
    howToCheck:
      "Stamp the same artifact twice and assert the stamped code is byte-identical; assert the plan's mutation serializes identically across runs; and assert that a target whose marker carries this artifact's fingerprint is classified `identical` and planned as a skip.",
    caveat:
      "Two halves are outside a local check, and #20 executed both: a second `setCells` with an identical payload left the Cell byte-identical, and a merged Cell kept its `rowSpan`/`colSpan` when the mutation omitted them. What a local check establishes is that sync asks for no change it does not need. #92 adds a third: on the `unchanged` route the run writes nothing but can still *persist the project* when the product reports it dirty, which is why that route reports `mutated` — a state #20's write-only execution never produced.",
    runtimeRoutes: ["write", "unchanged"],
    // #115's run covers both routes; #20's covers the write route on the pinned build. Both are
    // listed, so "the unchanged route is executed" and "12.0.100.0's write route is executed"
    // are two facts a reader can get from here rather than one that displaces the other.
    executions: [SYNC_EXECUTIONS["issue-20-write-route"], SYNC_EXECUTIONS["issue-115-both-routes"]],
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

export function findSyncExecution(id: SyncExecutionId): SyncExecution {
  const execution = SYNC_EXECUTIONS[id];
  if (!execution) {
    throw new Error(`Unknown sync execution "${id}".`);
  }
  return execution;
}

/** Every (promise, route) pair the flow promises and some run must establish. */
export interface SyncCoverageCell {
  readonly guaranteeId: SyncGuaranteeId;
  readonly route: SyncRuntimeRoute;
}

/**
 * The (promise, route) pairs coverage is measured over: the cross product of the promises that
 * carry an execution claim and the routes each spans.
 *
 * Exported because both coverage reports are *defined* over this set rather than over the
 * guarantees directly, and a reader asking "what is there to cover?" should be able to get the
 * same answer the reports use. Empty of claims is the honest state for a promise nothing has
 * run: it is reported by {@link unexecutedRealRuntimeSyncGuarantees}, not as a coverage cell.
 */
export function syncCoverageCells(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
): readonly SyncCoverageCell[] {
  const cells: SyncCoverageCell[] = [];
  for (const guarantee of guarantees) {
    // The same non-empty test as `unexecutedRealRuntimeSyncGuarantees`, and the same reason: a
    // promise with an empty execution list has been executed zero times, so it owes cells rather
    // than being skipped into looking covered.
    if (!guarantee.executions?.length) continue;
    for (const route of guarantee.runtimeRoutes ?? []) {
      cells.push({ guaranteeId: guarantee.id, route });
    }
  }
  return cells;
}

/**
 * The guarantees a local check can establish.
 *
 * Read {@link unexecutedRuntimeCoverage} rather than any single flag here. This answers "who
 * *can* establish the promise?"; that answers "has anyone, on each (route, version) it is owed
 * on?", and the two are independent: `sync-is-idempotent` is locally checkable *and* has been
 * run against real projects.
 */
export function locallyCheckableSyncGuarantees(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
): readonly SyncGuarantee[] {
  return guarantees.filter(guarantee => guarantee.level === "local");
}

/**
 * The guarantees that only a real Forguncy project can establish.
 *
 * Read this list before reporting a sync as working: every entry here is a promise a
 * green `vp test` says nothing about.
 */
export function realRuntimeSyncGuarantees(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
): readonly SyncGuarantee[] {
  return guarantees.filter(guarantee => guarantee.level === "real-runtime");
}

/**
 * The real-runtime guarantees nobody has executed yet.
 *
 * The complement of {@link SyncGuarantee.executions} among the promises a local check cannot
 * reach. It is empty as of #20, and kept as a function rather than asserted once because the next
 * guarantee added at `real-runtime` level should appear here rather than being assumed
 * discharged by the run that preceded it.
 *
 * Read {@link unexecutedRuntimeCoverage} with it — that is the finer and now primary report.
 * This answers "has this promise been executed at all?"; that answers "on every (route, version)
 * it is owed on?", and the second is the question a route *or a version* added later turns into a
 * real one. This function returns nothing for such a promise — correctly, since *a* run did
 * discharge it — which is exactly why the finer gaps cannot be seen from here.
 */
export function unexecutedRealRuntimeSyncGuarantees(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
): readonly SyncGuarantee[] {
  // `?.length` rather than `!== undefined`: an *empty* execution list is "executed zero times", and
  // that is spelled absent. Treating `[]` as a claim would let a promise read as executed while
  // naming no run — #116's third review reproduced exactly that, where `executions: []` vanished
  // from this report and from `unexecutedRuntimeCoverage` at the same time. The field is typed
  // non-empty so the state is a compile error; this is the runtime half, because a cast can still
  // produce one and a guard that holds only for well-typed input fails open on the input that is
  // wrong.
  return realRuntimeSyncGuarantees(guarantees).filter(guarantee => !guarantee.executions?.length);
}

/** One (promise, route, version) triple the flow owes and no recorded execution covers. */
export interface UnexecutedCoverage {
  readonly guaranteeId: SyncGuaranteeId;
  readonly route: SyncRuntimeRoute;
  readonly version: SyncMeasuredVersion;
  /** What a run on this route does, so the gap is readable without a second lookup. */
  readonly routeMeaning: string;
}

/**
 * The coverage gaps, one per (promise, route, version) triple: what the flow owes, and what no
 * recorded execution has discharged.
 *
 * ## Why the triple and not three separate reports
 *
 * #92 asked "which *route* was executed?" and #115 asked "which *version* was it executed on?",
 * and each question was first answered with its own per-guarantee field. That shape is wrong,
 * and #116's review is what showed it: route and version are properties of a *run*, so two
 * questions asked of one record can only agree by luck. Concretely, the previous
 * `unexecutedRuntimeVersionCoverage()` unioned every guarantee's version and reported a version
 * as covered the moment *any* guarantee named it — so with one promise executed on `12.0.100.0`
 * and the rest on `12.0.101.0` it returned empty, claiming both versions fully covered when
 * neither was. That is a **false negative in exactly the direction that matters**, and it gets
 * worse the more versions are added.
 *
 * Coverage here is a set of cells rather than a pair of lists. A triple is covered when **one**
 * execution covers all three of its parts — the promise counted it, the route is in that
 * execution's routes, and the execution's version is the one asked about. That is the property
 * three independent booleans cannot express, and stating it as one lookup is what makes a
 * half-covered version visible instead of rounded up.
 *
 * ## What is open, and what the historical evidence still covers
 *
 * Three cells on `12.0.100.0` are open as of #115: the **unchanged** route for the three promises
 * that span it. That route's work was executed only on `12.0.101.0`, so the pinned build owes it.
 *
 * `12.0.100.0`'s **write**-route cells are counted as covered by #20's run, and that is a
 * deliberate position rather than an oversight — an earlier version of this comment claimed the
 * opposite while the report and tests counted them covered, which #116's second review caught.
 * The reasoning: #115 changed the read path and the generation negotiation, and #20's write-route
 * cells are about neither — they are the mutation payload landing, the error count being read, and
 * the write being byte-identical on a repeat, all measured on the write path whose calls this
 * change did not touch.
 *
 * The one place that deserves a caveat is recorded on the execution itself rather than glossed
 * here — see `SYNC_EXECUTIONS["issue-20-write-route"].evidence`. What #20's run does **not**
 * establish is the recognition fix: it predates the read-back check this change corrected and
 * never recorded which name that build reported, which is why the adapter recognises both
 * spellings and why the pinned build's read-back name is still listed as unmeasured.
 *
 * ## Empty is the honest target, and empty does not mean "validated everywhere"
 *
 * The per-cell report is the one to read before reporting a version as supported; this function
 * only groups it. A version with no entry is covered on every cell it is owed.
 */
export function unexecutedRuntimeCoverage(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
  versions: readonly SyncMeasuredVersion[] = SYNC_SUPPORTED_VERSIONS,
): readonly UnexecutedCoverage[] {
  const gaps: UnexecutedCoverage[] = [];
  for (const guarantee of guarantees) {
    // No `length === 0` skip, and that is the fix #116's third review asked for. A promise whose
    // `runtimeRoutes` are known owes those cells on every tracked version *unless* an execution
    // covers them — so an empty (or cast) execution list must produce the full set of gaps, not
    // none. Skipping it was the second half of the double false negative: the promise vanished
    // from this report and from `unexecutedRealRuntimeSyncGuarantees` at the same time.
    //
    // Every guarantee, not `realRuntimeSyncGuarantees()`. The axis is the *execution claim*, not
    // the level: a locally checkable promise can have a real-project execution recorded against
    // it — `sync-is-idempotent` does, and its "does not materially change project state" wording is
    // what the `unchanged` route's save bears on. Filtering by level would silently drop exactly
    // that entry.
    const claim = guarantee.executions ?? [];
    for (const route of guarantee.runtimeRoutes ?? []) {
      for (const version of versions) {
        const covered = claim.some(execution => execution.version === version && execution.routes.includes(route));
        if (covered) continue;
        gaps.push({
          guaranteeId: guarantee.id,
          route,
          version,
          routeMeaning: SYNC_RUNTIME_ROUTE_MEANINGS[route],
        });
      }
    }
  }
  return gaps;
}

/**
 * The gap report a caller branches on, one entry per product version.
 *
 * The shape a caller wants is per *version* — "is 12.0.100.0 validated?" — while
 * {@link unexecutedRuntimeCoverage} is per cell, so this is the grouping and the one to read
 * before reporting a version as supported. A version with no entry is covered on every cell it
 * is owed on.
 */
export interface UnexecutedVersionCoverage {
  readonly version: SyncMeasuredVersion;
  /** The cells still owed on this version, in declaration order. */
  readonly cells: readonly UnexecutedCoverage[];
  /** What running the flow on this version would establish, in the promises' own terms. */
  readonly whatARunWouldEstablish: string;
}

/**
 * The per-version coverage gaps: every version asked about, together with the cells no
 * execution has covered on it.
 *
 * **Defaults to the versions support is claimed for** ({@link SYNC_SUPPORTED_VERSIONS}), so the
 * default report answers "is any version this repository claims still missing evidence?" — and
 * with #120's re-base that is 12.0.101.0 alone, which is complete. Passing
 * {@link SYNC_MEASURED_VERSIONS} instead asks the historical question, and *that* is where
 * `12.0.100.0`'s three open `unchanged` cells appear.
 *
 * The distinction matters because the two answers are different claims and only one of them is a
 * work item. 12.0.100.0 is out of use, so its uncovered cells are a fact about what was measured
 * rather than something outstanding — reporting it as a gap by default would keep a retired build
 * on the board indefinitely, and *not* reporting it would hide what the evidence does and does not
 * cover. Hence: reported when asked for, never in the default answer.
 */
export function unexecutedRuntimeVersionCoverage(
  guarantees: readonly SyncGuarantee[] = SYNC_GUARANTEES,
  versions: readonly SyncMeasuredVersion[] = SYNC_SUPPORTED_VERSIONS,
): readonly UnexecutedVersionCoverage[] {
  const gaps = unexecutedRuntimeCoverage(guarantees, versions);
  // The runs on each version are taken from the *same* guarantees the gaps came from, rather than
  // from the global table. They have to be: the note says "N executions have run here", and a
  // report computed over supplied records must not describe them with facts from the shipped
  // table. Deriving one from the other is also what makes the two impossible to disagree.
  const runsByVersion = new Map<SyncMeasuredVersion, SyncExecution[]>();
  for (const guarantee of guarantees) {
    for (const execution of guarantee.executions ?? []) {
      const runs = runsByVersion.get(execution.version) ?? [];
      if (!runs.some(run => run.id === execution.id)) runs.push(execution);
      runsByVersion.set(execution.version, runs);
    }
  }
  return versions
    .map(version => ({
      version,
      cells: gaps.filter(gap => gap.version === version),
    }))
    .filter(entry => entry.cells.length > 0)
    .map(entry => ({
      ...entry,
      whatARunWouldEstablish: unexecutedCoverageNote(
        entry.version,
        entry.cells,
        runsByVersion.get(entry.version) ?? [],
      ),
    }));
}

/**
 * Per-version context for a coverage note: the facts that are *about a version* rather than
 * derivable from the executions table.
 *
 * A `Record` keyed by the version union rather than a chain of `if (version === …)` inside the
 * note, for two reasons: adding a version to {@link SYNC_MEASURED_VERSIONS} then fails to compile
 * until someone says what is known about it, and the note function stays a composition of derived
 * facts and stated context instead of a place where a version-specific claim can hide.
 *
 * The wording here is deliberately *additional* to the derived part, never a replacement for it.
 * An earlier version of this note hardcoded "Nothing has run on <version>" for every version but
 * the pinned one, which is false the moment a version has a partial gap — the exact state
 * (promise, route, version) coverage exists to express. #116's second review caught that.
 */
export const SYNC_MEASURED_VERSION_CONTEXT: Readonly<Record<SyncMeasuredVersion, string>> = {
  "12.0.100.0":
    "A build this repository was measured against and no longer supports: it was the pinned target for #5 and #20, and was retired when the contract re-based on 12.0.101.0 (#120). #20's run predates the read-back recognition #115 corrected, and that build's read-back cell-type name was never measured — which is why the adapter recognises both spellings rather than narrowing to one.",
  "12.0.101.0": "The build the repository targets, and the one #115 probed and drove both routes through.",
};

/** Why the given version's cells are open, and what would close them. */
function unexecutedCoverageNote(
  version: SyncMeasuredVersion,
  cells: readonly UnexecutedCoverage[],
  executionsOnVersion: readonly SyncExecution[],
): string {
  const openRoutes = [...new Set(cells.map(cell => cell.route))];
  const coveredRoutes = [...new Set(executionsOnVersion.flatMap(execution => execution.routes))];
  const scenarios = [...new Set(cells.map(cell => cell.guaranteeId))];

  // The derived part: what *has* run on this version, and therefore which cells are open. The
  // two branches are the two states the model distinguishes — an unexecuted build and a
  // partially covered one — and both are stated from the rows rather than assumed from the
  // version, so a partial gap can never be described as "nothing has run".
  const state =
    executionsOnVersion.length === 0
      ? `Nothing has run on ${version}, so every cell the flow owes there is open.`
      : `${executionsOnVersion.length} execution(s) have run on ${version}, covering the ${coveredRoutes.join("/")} route(s), so ${cells.length} cell(s) there are a *partial* gap rather than an unvalidated build.`;

  return `${state} Open: ${openRoutes.join("/")} route(s) for ${scenarios.length} promise(s) (${scenarios.join(", ")}). Re-run both validation scripts against a ${version} designer to close them. ${SYNC_MEASURED_VERSION_CONTEXT[version]}`;
}
