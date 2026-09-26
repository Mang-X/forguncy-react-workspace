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
 * The product versions the repository has *any* executed flow evidence on.
 *
 * Read this with {@link unexecutedRuntimeVersionCoverage}. It is the set a coverage gap is
 * reported against, so it is deliberately the versions the repository actually claims support
 * for rather than a wish list: `12.0.100.0` is the version #5 pinned and #20 executed, and
 * `12.0.101.0` is the version #115 re-probed and executed. A third version is added here when
 * someone runs the flow on it, not when it is released.
 */
export const SYNC_EXPLORED_VERSIONS = ["12.0.100.0", "12.0.101.0"] as const;

export type SyncExploredVersion = (typeof SYNC_EXPLORED_VERSIONS)[number];

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
   * Present exactly when {@link SyncGuarantee.executedAt} is, and that pairing is the point:
   * the route list is part of an execution *claim*, so recording a run forces the question
   * "which route?" to be answered rather than left to a reader's assumption. It is keyed on
   * the execution rather than on `level`, because a locally checkable promise can still have
   * a real-project run against it — `sync-is-idempotent` does — and that run covers routes
   * too. A guarantee no run has touched has no execution claim to qualify, and is wholly
   * reported by {@link unexecutedRealRuntimeSyncGuarantees} instead.
   *
   * The list of routes the promise *spans*, not the ones executed — a route present here
   * without a matching {@link SyncGuarantee.executedRoutes} entry is exactly the gap
   * {@link unexecutedRuntimeRouteCoverage} reports.
   */
  readonly runtimeRoutes?: readonly SyncRuntimeRoute[];
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
   *
   * The *environment* of the most recent execution. Which routes it covered is
   * {@link SyncGuarantee.executedRoutes}, and the two are separate because one environment can
   * have covered only some of them.
   */
  readonly executedAt?: string;
  /**
   * Which of {@link SyncGuarantee.runtimeRoutes} the execution in `executedAt` covered.
   *
   * Required whenever `executedAt` is present, and a subset of `runtimeRoutes` — both are
   * asserted, so a route cannot be claimed as executed without being one the promise spans,
   * and an execution cannot be recorded without saying what it covered. Omitting a route here
   * is the honest and deliberate statement "this route has not been executed", which is what
   * a behaviour added later looks like until someone runs it.
   */
  readonly executedRoutes?: readonly SyncRuntimeRoute[];
  /**
   * Which product version the execution in `executedAt` ran on.
   *
   * Present exactly when `executedAt` is, for the same reason `executedRoutes` is: it is part
   * of the execution *claim*, not decoration. The route axis and the version axis are
   * independent and both are needed — #20's run covered the write route on `12.0.100.0`, #115's
   * covered both routes on `12.0.101.0`, and "is the unchanged path validated?" has a different
   * answer on each.
   *
   * One value, not a list: an `executedAt` string names one environment, and a second version
   * is a second execution record rather than a wider array here. It is a member of
   * {@link SYNC_EXPLORED_VERSIONS}, asserted, so a version cannot be claimed as run without
   * being one the repository has decided to track.
   */
  readonly executedVersion?: SyncExploredVersion;
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
    executedAt: EXECUTED_AGAINST_REPROBE,
    executedRoutes: ["write"],
    executedVersion: "12.0.101.0",
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
    // #20's run covered only the write route; #115's covered both, through the shipped adapter
    // — which is what the extra `executedRoutes` entry now rests on.
    runtimeRoutes: ["write", "unchanged"],
    executedAt: EXECUTED_AGAINST_REPROBE,
    executedRoutes: ["write", "unchanged"],
    executedVersion: "12.0.101.0",
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
    executedAt: EXECUTED_AGAINST_REPROBE,
    executedRoutes: ["write", "unchanged"],
    executedVersion: "12.0.101.0",
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
    executedAt: EXECUTED_AGAINST_REPROBE,
    executedRoutes: ["write", "unchanged"],
    executedVersion: "12.0.101.0",
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
 *
 * Read {@link unexecutedRuntimeRouteCoverage} with it. This answers "has this promise been
 * executed at all?"; that answers "on every route it spans?", and the second is the question
 * a route added to an already-executed promise turns into a real one. This function returns
 * nothing for such a promise — correctly, since *a* run did discharge it — which is exactly
 * why a route-level gap cannot be seen from here.
 */
export function unexecutedRealRuntimeSyncGuarantees(): readonly SyncGuarantee[] {
  return realRuntimeSyncGuarantees().filter(guarantee => guarantee.executedAt === undefined);
}

/** One promise and one route it spans that no recorded execution has covered. */
export interface UnexecutedRuntimeRoute {
  readonly guaranteeId: SyncGuaranteeId;
  readonly route: SyncRuntimeRoute;
  /** What a run on this route does, so the gap is readable without a second lookup. */
  readonly routeMeaning: string;
}

/**
 * The per-route coverage gaps: every (promise, route) pair a real project must establish and
 * no recorded execution has.
 *
 * The reason this exists beside {@link unexecutedRealRuntimeSyncGuarantees}: a promise can be
 * executed on one route and unexecuted on another, and the promise-level function cannot see
 * that. #92 is the case that produced it — the error gate and the locator gained an
 * `unchanged` route, #20's run covered only the write route, and
 * `unexecutedRealRuntimeSyncGuarantees()` stays empty either way.
 *
 * **Empty as of #115, and it took an adapter fix to get there.** #92's run asserted the
 * unchanged path through two *corrected* port calls, because the shipped adapter could not reach
 * it on the designer build available (see that script's header). #115 fixed both corrections in
 * `designer-transport.ts` — the read-back cell-type name and the generation call — and re-ran
 * both scripts through the bare adapter, which is what closes the three entries this function
 * used to report. An empty result here is therefore a claim about the *adapter*, not only about
 * the executor, and only a run through the shipped adapter keeps it true.
 */
export function unexecutedRuntimeRouteCoverage(): readonly UnexecutedRuntimeRoute[] {
  const gaps: UnexecutedRuntimeRoute[] = [];
  // Every guarantee, not `realRuntimeSyncGuarantees()`. The axis is the *execution claim*
  // (`runtimeRoutes` is present exactly when `executedAt` is), not the level: a locally
  // checkable promise can have a real-project execution recorded against it — and
  // `sync-is-idempotent` does and is affected here, because #92 gave the unchanged route a
  // save that can persist the project, which its "does not materially change project state"
  // wording is about. Filtering by level would silently drop exactly that entry.
  for (const guarantee of SYNC_GUARANTEES) {
    for (const route of guarantee.runtimeRoutes ?? []) {
      if (guarantee.executedRoutes?.includes(route)) continue;
      gaps.push({ guaranteeId: guarantee.id, route, routeMeaning: SYNC_RUNTIME_ROUTE_MEANINGS[route] });
    }
  }
  return gaps;
}

/** One product version the flow has not been executed against, and what that leaves open. */
export interface UnexecutedVersionCoverage {
  readonly version: SyncExploredVersion;
  /** What running the flow on this version would establish, in the promises' own terms. */
  readonly whatARunWouldEstablish: string;
}

/**
 * The version coverage gaps: every product version the repository claims support for that no
 * recorded execution ran on.
 *
 * A third axis, and the one #115 made necessary rather than invented. #92's route axis asked
 * "*which* route was executed?"; that question only has an answer per version, because the two
 * shapes #115 found to be version-sensitive — the read-back cell-type name and which generation
 * call exists — are exactly what a run on one build cannot tell you about another. Before #115
 * every execution on record was `12.0.100.0`, so a single `executedAt` string could carry the
 * whole claim; it cannot any more, because the run that closed the `unchanged` route ran on
 * `12.0.101.0`.
 *
 * **`12.0.100.0` is a gap on purpose, and it cannot be closed from here.** It is the version #5
 * pinned and #20 executed, but that execution predates the recognition change (#115 fixed a
 * check that was added after it) and this machine has only `12.0.101.0` installed — no second
 * build, no installer. Reporting it is the honest state; inheriting #115's result would be the
 * "a different version is a re-run rather than an inheritance" rule broken in the one direction
 * that matters. Adding `12.0.101.0` to {@link SYNC_EXPLORED_VERSIONS} without executing on it
 * would be the same error, which is why that list is only extended with a run.
 */
export function unexecutedRuntimeVersionCoverage(): readonly UnexecutedVersionCoverage[] {
  const executed = new Set(
    SYNC_GUARANTEES.filter(guarantee => guarantee.executedAt !== undefined).map(guarantee => guarantee.executedVersion),
  );
  return SYNC_EXPLORED_VERSIONS.filter(version => !executed.has(version)).map(version => ({
    version,
    whatARunWouldEstablish:
      version === "12.0.100.0"
        ? "That the read-back cell-type name and the generation call #115 corrected on 12.0.101.0 behave as the adapter now expects on the build this repository pins — i.e. that the fix did not trade one version's recognition for the other's. Re-run both validation scripts against a 12.0.100.0 designer."
        : `That the flow completes on ${version} at all, and which of the two version-sensitive shapes it reports.`,
  }));
}
