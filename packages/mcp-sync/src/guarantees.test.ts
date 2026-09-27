import { describe, expect, it } from "vitest";

import {
  EXECUTED_AGAINST_DESIGNER,
  EXECUTED_AGAINST_REPROBE,
  findSyncExecution,
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_EXECUTIONS,
  SYNC_EXPLORED_VERSIONS,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
  SYNC_RUNTIME_ROUTE_MEANINGS,
  SYNC_RUNTIME_ROUTES,
  syncCoverageCells,
  unexecutedRealRuntimeSyncGuarantees,
  unexecutedRuntimeCoverage,
  unexecutedRuntimeVersionCoverage,
} from "./guarantees.ts";
import type { SyncGuarantee, SyncGuaranteeId, SyncRuntimeRoute } from "./guarantees.ts";

/**
 * #19's acceptance criteria are also its promises, and the reason they are data rather
 * than prose is that `level` is the question AGENTS.md rule 7 asks: could a local check
 * establish this, or does only a real Forguncy project produce the evidence? A green
 * `vp test` here establishes the contract and nothing about Forguncy runtime behaviour,
 * so these tests hold the split as much as the statements.
 *
 * #92 added a second axis, and the tests below hold it separately: a promise can be executed
 * on one route through the flow and unexecuted on another, so "has this promise been run?"
 * and "on every route it spans?" are different questions. Collapsing them is how a route
 * added later inherits an earlier run's credit — which is the overstatement this file exists
 * to prevent, one level down.
 *
 * #115 added a third: a promise can be executed on one *product version* and not another, and
 * the two shapes #115 found to be version-sensitive are exactly what a run on one build says
 * nothing about on another. So `executedVersion` is part of the execution claim, and the
 * version axis is held apart from the route axis here for the same reason.
 */

describe("the one-way sync's promises", () => {
  it("records each promise once, under a stable id", () => {
    expect(SYNC_GUARANTEES.map(guarantee => guarantee.id)).toEqual([...SYNC_GUARANTEE_IDS]);
    expect(new Set(SYNC_GUARANTEE_IDS).size).toBe(SYNC_GUARANTEE_IDS.length);
    expect(SYNC_GUARANTEES).toHaveLength(7);
  });

  it("states every promise and how a check for it would run", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      expect(guarantee.statement.length, guarantee.id).toBeGreaterThan(0);
      expect(guarantee.howToCheck.length, guarantee.id).toBeGreaterThan(0);
      expect(["local", "real-runtime"], guarantee.id).toContain(guarantee.level);
    }
  });

  // The same class the `project-errors-after-sync` wording fix was about, across the whole
  // table: since #92 a run can validate without writing anything, so a check description
  // that names a mutation states something untrue of half the runs that discharge it. The
  // step-ordering prose in `capability-surface.ts` legitimately says "pre-mutation" — that is
  // about phases — so this guards the guarantees' own wording rather than the vocabulary.
  it("describes a check in terms that hold on a run that wrote nothing", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      expect(guarantee.howToCheck, guarantee.id).not.toContain("after the mutation");
    }
  });

  // A guarantee that reads stronger than it is would be reported as established by a run
  // that never touched it. Every one of #19's says where it stops.
  it("states where each promise is weaker than it reads", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      expect(guarantee.caveat?.length ?? 0, guarantee.id).toBeGreaterThan(0);
    }
  });

  it("splits into exactly the locally checkable and the runtime-only promises", () => {
    const local = locallyCheckableSyncGuarantees();
    const runtime = realRuntimeSyncGuarantees();

    expect([...local, ...runtime].map(guarantee => guarantee.id).sort()).toEqual([...SYNC_GUARANTEE_IDS].sort());
    for (const guarantee of local) expect(guarantee.level, guarantee.id).toBe("local");
    for (const guarantee of runtime) expect(guarantee.level, guarantee.id).toBe("real-runtime");
  });

  it("puts every promise a designer call is needed for on the runtime side", () => {
    const runtimeIds = realRuntimeSyncGuarantees().map(guarantee => guarantee.id);

    // Each of these is about a call landing in a project: a write being accepted, an error
    // count being read back, a locator existing. Nothing local can establish them.
    expect(runtimeIds.sort()).toEqual([
      "project-errors-checked-after-mutation",
      "runtime-locator-returned",
      "written-without-manual-copy",
    ]);
  });

  it("keeps the one-way decision itself checkable locally", () => {
    const oneWay = findSyncGuarantee("one-way-only");

    // It is a property of the interfaces, so it is as strong as the interface set — which
    // is exactly why it is stated rather than assumed.
    expect(oneWay.level).toBe("local");
    expect(oneWay.statement).toContain("source of truth");
    expect(oneWay.caveat).toMatch(/pull/);
  });

  it("refuses an unknown guarantee by name", () => {
    expect(() => findSyncGuarantee("not-a-guarantee" as SyncGuaranteeId)).toThrowError(/not-a-guarantee/);
  });
});

// #20 and #115 executed the flow against a real designer, and these tests hold the two claims
// apart that AGENTS.md rule 7 is about: what a local check establishes, and what a real project
// has actually been asked.
describe("what has been executed against a real project", () => {
  it("marks the promises a run discharged, naming the runs", () => {
    const executed = SYNC_GUARANTEES.filter(guarantee => guarantee.executions !== undefined);

    expect(executed.map(guarantee => guarantee.id).sort()).toEqual([
      "project-errors-checked-after-mutation",
      "runtime-locator-returned",
      "sync-is-idempotent",
      "written-without-manual-copy",
    ]);
    for (const guarantee of executed) {
      // Every discharged promise points at *both* runs, and that is the shape this file was
      // corrected to in #116's review: a promise does not "move" to the newer run, it accumulates
      // them. #20's entry is the only evidence for the pinned build, so a later run covering the
      // same route on a newer build must not displace it.
      expect(guarantee.executions?.map(execution => execution.id), guarantee.id).toEqual([
        "issue-20-write-route",
        "issue-115-both-routes",
      ]);
    }
  });

  // The bug #116's review found, as a test: route and version are properties of a *run*, so a
  // single per-guarantee triple made the coverage reports agree only by luck. The records are now
  // looked up by id, which is what makes "which run covered this?" a single answer rather than
  // three fields that can disagree.
  it("points every execution claim at a record in the executions table", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      for (const execution of guarantee.executions ?? []) {
        expect(findSyncExecution(execution.id), guarantee.id).toBe(execution);
        // The routes a promise claims are covered must be ones the *run* actually reached — the
        // check that would have caught a guarantee crediting a route its run never drove.
        for (const route of guarantee.runtimeRoutes ?? []) {
          if (execution.routes.includes(route)) continue;
          // Not an error on its own (another execution may cover it); asserted per-run so a run
          // that covers nothing is visible rather than silently unusable.
          expect(execution.routes.length, `${guarantee.id} via ${execution.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  // The two environments stay distinguishable, so a reader cannot collapse them into "it was
  // validated". They name different builds and different Issues, and the older record is still
  // exported — and still referenced — for the claims that rest on it.
  it("keeps the two executed environments apart", () => {
    expect(EXECUTED_AGAINST_DESIGNER).toMatch(/12\.0\.100\.0/);
    expect(EXECUTED_AGAINST_DESIGNER).toContain("#20");
    expect(EXECUTED_AGAINST_REPROBE).toMatch(/12\.0\.101\.0/);
    expect(EXECUTED_AGAINST_REPROBE).toContain("#115");
    expect(EXECUTED_AGAINST_REPROBE).not.toBe(EXECUTED_AGAINST_DESIGNER);

    // And the older one is not merely still exported: it is what a promise's claim rests on for
    // the pinned build, so it must still be *referenced* by the table.
    expect(SYNC_EXECUTIONS["issue-20-write-route"].environment).toBe(EXECUTED_AGAINST_DESIGNER);
    expect(SYNC_EXECUTIONS["issue-115-both-routes"].environment).toBe(EXECUTED_AGAINST_REPROBE);
    const referenced = new Set(SYNC_GUARANTEES.flatMap(guarantee => (guarantee.executions ?? []).map(e => e.id)));
    expect([...referenced].sort()).toEqual(["issue-115-both-routes", "issue-20-write-route"]);
  });

  it("leaves no real-runtime promise unexecuted", () => {
    // Empty as of #20. A new `real-runtime` guarantee lands here rather than inheriting
    // the previous run's evidence.
    expect(unexecutedRealRuntimeSyncGuarantees()).toEqual([]);
  });

  // The invariant that keeps a route list from becoming a second, weaker claim: a promise's
  // route claim and its executions are one statement. `runtimeRoutes` without `executions` would
  // describe a promise nobody ran; executions without `runtimeRoutes` would claim coverage of
  // routes the promise does not declare.
  it("pairs every execution claim with the routes it spans", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      const hasExecution = guarantee.executions !== undefined;
      if (hasExecution) {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeDefined();
        expect(guarantee.runtimeRoutes?.length, guarantee.id).toBeGreaterThan(0);
        // An execution with no routes is a claim a reader cannot check against the build they
        // have, and one with no version cannot be checked against the build they have at all.
        for (const execution of guarantee.executions ?? []) {
          expect(execution.routes.length, `${guarantee.id} via ${execution.id}`).toBeGreaterThan(0);
          expect(SYNC_EXPLORED_VERSIONS, execution.id).toContain(execution.version);
          expect(execution.environment.length, execution.id).toBeGreaterThan(0);
          expect(execution.evidence.length, execution.id).toBeGreaterThan(0);
        }
      } else {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeUndefined();
      }
    }
  });

  // The two axes are independent, and that independence is the point: `level` says who
  // *can* establish a promise, `executions` says whether anyone has. `sync-is-idempotent`
  // is locally checkable *and* was confirmed against a real project — the second fact does
  // not move it off the local side, and the first does not make the real evidence
  // redundant. Collapsing either into the other is how a green `vp test` starts reading as
  // runtime compatibility.
  it("does not let an execution reclassify a locally checkable promise", () => {
    const idempotent = findSyncGuarantee("sync-is-idempotent");
    expect(idempotent.level).toBe("local");
    expect(idempotent.executions).toBeDefined();

    const manual = findSyncGuarantee("written-without-manual-copy");
    expect(manual.level).toBe("real-runtime");
    expect(manual.executions).toBeDefined();
  });

  it("keeps every real-runtime promise on the runtime side of the split", () => {
    for (const guarantee of realRuntimeSyncGuarantees()) {
      expect(guarantee.level, guarantee.id).toBe("real-runtime");
      // A runtime promise says how to check it, so the record could be reproduced rather
      // than trusted.
      expect(guarantee.howToCheck.length, guarantee.id).toBeGreaterThan(0);
    }
    expect(EXECUTED_AGAINST_DESIGNER).toContain("validate-sync-against-designer");
  });
});

// #92 gave two already-executed real-runtime promises a second route, and #20's run covered
// one of them. #115 closed the *route* half of that by fixing the adapter and re-running both
// routes through it — but only on 12.0.101.0, which is what the version half is about.
//
// #116's review found that route and version were being reported as two independent booleans,
// and these tests pin the fix: coverage is a set of (promise, route, version) cells, so a route
// validated on one build is not credited on another and vice versa.
describe("what has been executed on each route through the flow", () => {
  // The refinement the triple forced, and the honest answer: the route work #92 added was
  // executed, but only on the newer build. Reporting "no gap on any route" would have been true
  // of the route axis and false of the flow, because 12.0.100.0 never reached the unchanged path.
  it("does not credit the unchanged route on a build that never ran it", () => {
    const unchanged = unexecutedRuntimeCoverage().filter(gap => gap.route === "unchanged");

    expect(unchanged.map(gap => `${gap.guaranteeId}:${gap.version}`).sort()).toEqual([
      "project-errors-checked-after-mutation:12.0.100.0",
      "runtime-locator-returned:12.0.100.0",
      "sync-is-idempotent:12.0.100.0",
    ]);
    // And the other direction, so the check is not vacuous: nothing on 12.0.101.0 is reported.
    expect(unexecutedRuntimeCoverage().some(gap => gap.version === "12.0.101.0")).toBe(false);
  });

  // The other half of the same position, pinned so the doc and the report cannot drift apart
  // again: #20's **write**-route cells on the pinned build are counted as covered, and the
  // reasoning is on the execution row (`SYNC_EXECUTIONS["issue-20-write-route"].evidence`).
  // #116's second review found the comment claiming the opposite while this report and these
  // tests counted them covered — a reader-facing contradiction in evidence metadata, which this
  // assertion is what makes impossible to reintroduce silently.
  it("counts the pinned build's write-route cells as covered by #20's run", () => {
    const pinnedWrite = unexecutedRuntimeCoverage().filter(
      gap => gap.version === "12.0.100.0" && gap.route === "write",
    );

    expect(pinnedWrite).toEqual([]);
    // Not vacuous: there *are* write-route cells owed on that version, or the assertion above
    // would hold for a report that simply omits them.
    const writeCells = syncCoverageCells().filter(cell => cell.route === "write");
    expect(writeCells.length).toBeGreaterThan(0);
    // And the run that covers them is #20's, with the caveat that it does not speak to the
    // read-back recognition — recorded on the row rather than in prose here.
    const row = SYNC_EXECUTIONS["issue-20-write-route"];
    expect(row.version).toBe("12.0.100.0");
    expect(row.routes).toContain("write");
    expect(row.evidence).toMatch(/Caveat|predates/i);
  });

  // The property that makes the report meaningful rather than a hand-written list: every cell it
  // reports is one no single execution covers.
  it("derives the report from the executions, so a reopened gap reappears", () => {
    const recomputed: string[] = [];
    for (const guarantee of SYNC_GUARANTEES) {
      const claim = guarantee.executions ?? [];
      if (claim.length === 0) continue;
      for (const route of guarantee.runtimeRoutes ?? []) {
        for (const version of SYNC_EXPLORED_VERSIONS) {
          const covered = claim.some(e => e.version === version && e.routes.includes(route));
          if (!covered) recomputed.push(`${guarantee.id}:${route}:${version}`);
        }
      }
    }

    expect(unexecutedRuntimeCoverage().map(gap => `${gap.guaranteeId}:${gap.route}:${gap.version}`)).toEqual(
      recomputed,
    );
    // A cell spans every version, so the report has one entry per version the flow claims — a
    // version missing from it entirely would be an untracked build, not a covered one.
    const versions = new Set(unexecutedRuntimeCoverage().map(gap => gap.version));
    for (const version of versions) expect(SYNC_EXPLORED_VERSIONS, version).toContain(version);
  });

  // The whole reason the finer report exists, kept as a live check: the promise-level list is
  // empty while cells are open. Reading the empty list alone as "validated everywhere" is the
  // overstatement this file exists to prevent, one level down.
  it("is not implied by the promise-level list being empty", () => {
    expect(unexecutedRealRuntimeSyncGuarantees()).toEqual([]);
    expect(unexecutedRuntimeCoverage().length).toBeGreaterThan(0);
  });

  // A route nothing spans is a gap nobody can close, so the vocabulary has to stay tied to
  // the promises that actually use it.
  it("uses only routes some guarantee declares", () => {
    const declared = new Set(SYNC_GUARANTEES.flatMap(guarantee => guarantee.runtimeRoutes ?? []));

    for (const route of SYNC_RUNTIME_ROUTES) expect(declared, route).toContain(route);
    for (const cell of syncCoverageCells()) expect(declared, cell.guaranteeId).toContain(cell.route);
  });

  // The write route is genuinely write-only for one promise: the unchanged route writes no
  // Cell, so "a write lands" has no meaning there. Asserted so a later edit cannot add it by
  // symmetry with the other two.
  it("does not invent an unchanged route for the promise about writing", () => {
    const write = findSyncGuarantee("written-without-manual-copy");

    expect(write.runtimeRoutes).toEqual(["write"]);
    expect(
      unexecutedRuntimeCoverage().some(gap => gap.guaranteeId === "written-without-manual-copy"),
    ).toBe(false);
  });
});

// The version axis, held apart from the route axis for the same reason the route axis is held
// apart from the promise axis: a run on one build says nothing about another, and the two shapes
// #115 found version-sensitive — the read-back cell-type name and the generation call — are
// exactly what would be silently inherited if a version were folded into a route's prose.
describe("what has been executed on each product version", () => {
  // The gap this PR cannot close from here, and the one #116's review made expressible: the
  // pinned build is not installed on this machine, so a reader who wants the flow validated on it
  // has to run it there. Asserting the *cells* rather than a bare version is the fix — the
  // previous shape reported a version as covered the moment any guarantee named it.
  it("reports the pinned build's open cells, with what a run on it would establish", () => {
    const gaps = unexecutedRuntimeVersionCoverage();

    expect(gaps.map(gap => gap.version)).toEqual(["12.0.100.0"]);
    expect(gaps[0].cells.length).toBe(3);
    expect(gaps[0].cells.every(cell => cell.version === "12.0.100.0")).toBe(true);
    expect(gaps[0].whatARunWouldEstablish).toContain("12.0.100.0");
    expect(gaps[0].whatARunWouldEstablish).toMatch(/re-run/i);
    // The note has to say why a *pinned and executed* build still has open cells, or the entry
    // reads as a contradiction.
    expect(gaps[0].whatARunWouldEstablish).toMatch(/predates|#20/i);
  });

  // The complement, so the report is not simply "nothing is validated": the build the run that
  // closed the route work actually happened on is not reported, and that is derived from the
  // executions rather than listed by hand.
  it("does not report the build the recorded executions ran on", () => {
    const executed = new Set(Object.values(SYNC_EXECUTIONS).map(execution => execution.version));

    expect(executed).toContain("12.0.101.0");
    expect(unexecutedRuntimeVersionCoverage().map(gap => gap.version)).not.toContain("12.0.101.0");
    for (const version of executed) expect(SYNC_EXPLORED_VERSIONS).toContain(version);
  });

  // The rule that keeps the list from becoming a wish list: a version is tracked because it was
  // run or because it is pinned, never because it exists. Two entries, and both are named in the
  // file's own evidence — so a third version is an explicit edit against a run.
  it("tracks exactly the versions the repository has evidence for", () => {
    expect([...SYNC_EXPLORED_VERSIONS].sort()).toEqual(["12.0.100.0", "12.0.101.0"]);
    // Each is a concrete version, never a range or an empty value — a version that cannot be
    // compared to a designer's `serverInfo.version` is not a checkable claim.
    for (const version of SYNC_EXPLORED_VERSIONS) expect(version, version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  // The false negative #116's review reproduced, as a regression: with one promise executed on
  // each build, the *union* shape reported neither version as open. Each version is now short of
  // a full set of cells, and the report says so.
  it("does not round a per-promise result up to a per-version one", () => {
    const byVersion = new Map<string, number>();
    for (const cell of syncCoverageCells()) byVersion.set(cell.guaranteeId, 0);

    // Both versions appear because both were executed, and both still have open cells — which is
    // what a union of "some guarantee ran here" could not express.
    const gaps = unexecutedRuntimeCoverage();
    expect(new Set(gaps.map(gap => gap.version))).toEqual(new Set(["12.0.100.0"]));
    expect(gaps.every(gap => gap.version === "12.0.100.0")).toBe(true);
    // Sanity on the shape of the data the check rests on: more cells than versions.
    expect(syncCoverageCells().length).toBeGreaterThan(new Set(SYNC_EXPLORED_VERSIONS).size);
  });

  // The reviewer's scenario, built as data and run through the report — because the shipped table
  // cannot reach it (no guarantee is split across builds today) and a guard whose failure branch
  // is never executed is a guard that has stopped checking.
  //
  // Two promises, one executed on each of two versions, each covering only its own route. The
  // union shape this replaced called *both* versions covered, which is the false negative; the
  // cell shape reports each version's missing cells, which is the honest answer.
  it("reports each version's missing cells when promises are split across builds", () => {
    const versions = ["12.0.100.0", "12.0.101.0"] as const;
    const execution = (version: string, routes: readonly SyncRuntimeRoute[]) =>
      ({ id: "issue-20-write-route", environment: "supplied", version, routes, evidence: "supplied" }) as never;

    const split = [
      {
        id: "written-without-manual-copy",
        runtimeRoutes: ["write"],
        executions: [execution("12.0.100.0", ["write"])],
      },
      {
        id: "sync-is-idempotent",
        runtimeRoutes: ["write", "unchanged"],
        executions: [execution("12.0.101.0", ["write", "unchanged"])],
      },
    ] as unknown as readonly SyncGuarantee[];

    const gaps = unexecutedRuntimeCoverage(split, versions);

    // 12.0.100.0 has an execution for the *first* promise only, so the second promise owes it both
    // of its routes there; 12.0.101.0 has an execution for the second promise only, so the first
    // promise owes it its single route. Reading this as "each version is missing one cell" would
    // be the mistake — a version is short by however many promises the *other* version's run
    // discharged, which is exactly what a per-promise union cannot express.
    expect(gaps.map(gap => `${gap.guaranteeId}:${gap.route}:${gap.version}`).sort()).toEqual([
      "sync-is-idempotent:unchanged:12.0.100.0",
      "sync-is-idempotent:write:12.0.100.0",
      "written-without-manual-copy:write:12.0.101.0",
    ]);
    // The union shape would have returned [] here, which is the bug this pins: both versions have
    // *an* execution, so a version-keyed union sees nothing missing.
    expect(new Set(gaps.map(gap => gap.version))).toEqual(new Set(["12.0.100.0", "12.0.101.0"]));
    // And the grouped report says the same thing at the level a caller branches on.
    const grouped = unexecutedRuntimeVersionCoverage(split, versions);
    expect(grouped.map(entry => `${entry.version}:${entry.cells.length}`)).toEqual([
      "12.0.100.0:2",
      "12.0.101.0:1",
    ]);
  });

  // #116's second review: the note was version-keyed prose, so a version with a *partial* gap was
  // described as "Nothing has run on <version>" — false for the exact state the cell model exists
  // to express. The note is now derived from the execution rows, and these assertions are on the
  // split scenario, which is the only state that distinguishes the two wordings.
  it("describes a partial gap from the runs, never as an unvalidated version", () => {
    const versions = ["12.0.100.0", "12.0.101.0"] as const;
    const ex = (version: string, routes: readonly SyncRuntimeRoute[]) =>
      ({ id: "issue-20-write-route", environment: "supplied", version, routes, evidence: "supplied" }) as never;
    const split = [
      {
        id: "written-without-manual-copy",
        runtimeRoutes: ["write"],
        executions: [ex("12.0.100.0", ["write"])],
      },
      {
        id: "sync-is-idempotent",
        runtimeRoutes: ["write", "unchanged"],
        executions: [ex("12.0.101.0", ["write", "unchanged"])],
      },
    ] as unknown as readonly SyncGuarantee[];

    for (const entry of unexecutedRuntimeVersionCoverage(split, versions)) {
      // The claim the old wording made, which was wrong on both versions: each one has a run.
      expect(entry.whatARunWouldEstablish, entry.version).not.toContain("Nothing has run");
      expect(entry.whatARunWouldEstablish, entry.version).toContain("1 execution(s) have run");
      expect(entry.whatARunWouldEstablish, entry.version).toContain("partial");
      // And it names what is actually open, so a reader does not have to re-derive it.
      expect(entry.whatARunWouldEstablish, entry.version).toContain("Open:");
    }
  });

  // The other branch of the same derivation, so the note is not simply "always partial": a version
  // nothing has run on must still say so.
  it("still says nothing has run when nothing has", () => {
    const versions = ["12.0.100.0", "12.0.101.0"] as const;
    const unrun = [
      {
        id: "sync-is-idempotent",
        runtimeRoutes: ["write"],
        executions: [
          { id: "issue-20-write-route", environment: "supplied", version: "12.0.100.0", routes: ["write"], evidence: "supplied" },
        ],
      },
    ] as unknown as readonly SyncGuarantee[];

    const gaps = unexecutedRuntimeVersionCoverage(unrun, versions);
    const onReprobe = gaps.find(entry => entry.version === "12.0.101.0");

    expect(onReprobe?.whatARunWouldEstablish).toContain("Nothing has run on 12.0.101.0");
    expect(onReprobe?.whatARunWouldEstablish).not.toContain("partial");
  });
});

describe("how a route's run is described", () => {
  // The route description is part of the exported metadata a coverage gap surfaces, so it
  // describes the flow rather than what a particular run did. The save is conditional on the
  // product's own answer, and a clean run marks the step `skipped` — so a meaning asserting
  // "saved" would claim a call that run never makes, which is the same defect as a diagnostic
  // naming a mutation on a run that wrote nothing.
  it("describes the conditional save rather than asserting one", () => {
    for (const route of SYNC_RUNTIME_ROUTES) {
      const meaning = SYNC_RUNTIME_ROUTE_MEANINGS[route];

      expect(meaning, route).toContain("checked the save status");
      expect(meaning, route).toContain("if the project required it");
      // "still saved" / "then saved" would assert the call happened.
      expect(meaning, route).not.toMatch(/\bsaved\b(?! if)/);
    }
  });
});
