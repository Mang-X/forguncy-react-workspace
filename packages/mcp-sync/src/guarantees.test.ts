import { describe, expect, it } from "vitest";

import {
  EXECUTED_AGAINST_DESIGNER,
  EXECUTED_AGAINST_REPROBE,
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_EXPLORED_VERSIONS,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
  SYNC_RUNTIME_ROUTE_MEANINGS,
  SYNC_RUNTIME_ROUTES,
  unexecutedRealRuntimeSyncGuarantees,
  unexecutedRuntimeRouteCoverage,
  unexecutedRuntimeVersionCoverage,
} from "./guarantees.ts";
import type { SyncGuaranteeId } from "./guarantees.ts";

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

// #20 executed the flow against a real designer, and these tests hold the two claims apart
// that AGENTS.md rule 7 is about: what a local check establishes, and what a real project
// has actually been asked.
describe("what has been executed against a real project", () => {
  it("marks the promises the run discharged, naming the environment", () => {
    const executed = SYNC_GUARANTEES.filter(guarantee => guarantee.executedAt !== undefined);

    expect(executed.map(guarantee => guarantee.id).sort()).toEqual([
      "project-errors-checked-after-mutation",
      "runtime-locator-returned",
      "sync-is-idempotent",
      "written-without-manual-copy",
    ]);
    for (const guarantee of executed) {
      // The version and the fact it was a real session, not "verified somewhere". Every one of
      // these now names #115's re-probe rather than #20's write-route-only execution, because
      // #115 re-ran both routes through the shipped adapter on the build it fixed the adapter
      // for — so the claim on each is the stronger one. #20's environment is still what the
      // *write* route rests on for 12.0.100.0, and that version's gap is reported separately by
      // the version axis rather than folded into these records.
      expect(guarantee.executedAt, guarantee.id).toBe(EXECUTED_AGAINST_REPROBE);
      expect(guarantee.executedAt, guarantee.id).toMatch(/12\.0\.101\.0/);
      expect(guarantee.executedAt, guarantee.id).toContain("#115");
    }
  });

  // The two environments stay distinguishable, so a reader cannot collapse them into "it was
  // validated". They name different builds and different Issues, and the older record is still
  // exported for the claims that rest on it.
  it("keeps the two executed environments apart", () => {
    expect(EXECUTED_AGAINST_DESIGNER).toMatch(/12\.0\.100\.0/);
    expect(EXECUTED_AGAINST_DESIGNER).toContain("#20");
    expect(EXECUTED_AGAINST_REPROBE).toMatch(/12\.0\.101\.0/);
    expect(EXECUTED_AGAINST_REPROBE).toContain("#115");
    expect(EXECUTED_AGAINST_REPROBE).not.toBe(EXECUTED_AGAINST_DESIGNER);
  });

  it("leaves no real-runtime promise unexecuted", () => {
    // Empty as of #20. A new `real-runtime` guarantee lands here rather than inheriting
    // the previous run's evidence.
    expect(unexecutedRealRuntimeSyncGuarantees()).toEqual([]);
  });

  // The invariant that keeps a route list from becoming a second, weaker claim: an execution
  // record and the routes it covered are one statement. A `runtimeRoutes` without
  // `executedAt` would describe a promise nobody ran; `executedRoutes` without `runtimeRoutes`
  // would claim coverage of routes the promise does not declare.
  it("pairs every execution record with the routes and the version it covered", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      const hasExecution = guarantee.executedAt !== undefined;
      if (hasExecution) {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeDefined();
        expect(guarantee.executedRoutes, guarantee.id).toBeDefined();
        // #115: an execution without a version is a claim a reader cannot check against the
        // build they have.
        expect(guarantee.executedVersion, guarantee.id).toBeDefined();
        expect(SYNC_EXPLORED_VERSIONS, guarantee.id).toContain(guarantee.executedVersion);
      } else {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeUndefined();
        expect(guarantee.executedRoutes, guarantee.id).toBeUndefined();
        expect(guarantee.executedVersion, guarantee.id).toBeUndefined();
      }
      // No route may be claimed as executed unless the promise spans it.
      for (const route of guarantee.executedRoutes ?? []) {
        expect(guarantee.runtimeRoutes, `${guarantee.id} claims ${route}`).toContain(route);
      }
    }
  });

  // The two axes are independent, and that independence is the point: `level` says who
  // *can* establish a promise, `executedAt` says whether anyone has. `sync-is-idempotent`
  // is locally checkable *and* was confirmed against a real project — the second fact does
  // not move it off the local side, and the first does not make the real evidence
  // redundant. Collapsing either into the other is how a green `vp test` starts reading as
  // runtime compatibility.
  it("does not let an execution reclassify a locally checkable promise", () => {
    const idempotent = findSyncGuarantee("sync-is-idempotent");
    expect(idempotent.level).toBe("local");
    expect(idempotent.executedAt).toBeDefined();

    const manual = findSyncGuarantee("written-without-manual-copy");
    expect(manual.level).toBe("real-runtime");
    expect(manual.executedAt).toBeDefined();
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
// one of them. #115 closed the route axis by fixing the adapter and re-running both routes
// through it. These tests hold the finer question apart from the promise-level one — the
// question a reader deciding whether the unchanged path is validated actually asks.
describe("what has been executed on each route through the flow", () => {
  it("reports no gap on any route", () => {
    // Empty as of #115, and *earned* rather than asserted: the three entries that used to be
    // reported here were closed by a run through the bare adapter, not by editing this list.
    // The entries themselves are still reachable — see the "kept honest" test below — because a
    // check whose failure branch can never run is a check that has stopped checking.
    expect(unexecutedRuntimeRouteCoverage()).toEqual([]);
  });

  // The property that makes an empty report meaningful rather than a formality: it is derived
  // from the guarantees, so reopening a route gap has to be a real edit to one of them.
  it("derives the report from the guarantees, so a reopened gap reappears", () => {
    const routes = new Set(SYNC_GUARANTEES.flatMap(guarantee => guarantee.runtimeRoutes ?? []));
    const executed = new Set(
      SYNC_GUARANTEES.filter(guarantee => guarantee.executedAt !== undefined).flatMap(
        guarantee =>
          (guarantee.runtimeRoutes ?? [])
            .filter(route => !guarantee.executedRoutes?.includes(route))
            .map(route => `${guarantee.id}:${route}`),
      ),
    );

    // The reported set is exactly that computation, not a hand-maintained list.
    expect(unexecutedRuntimeRouteCoverage().map(gap => `${gap.guaranteeId}:${gap.route}`)).toEqual([...executed]);
    for (const route of SYNC_RUNTIME_ROUTES) expect(routes, route).toContain(route);
    // And every reported gap would carry its route's meaning, so an entry is readable without a
    // second lookup. Asserted against the mapping rather than the (now empty) list.
    for (const route of SYNC_RUNTIME_ROUTES) {
      expect(SYNC_RUNTIME_ROUTE_MEANINGS[route]).toContain("checked the save status");
    }
  });

  // The whole reason this axis exists, kept as a live check rather than a comment: the
  // promise-level function is empty *and* the route-level one is, and the two being empty
  // together is what "the flow is validated on both routes" means. A route added to a promise
  // without a run re-splits them, which is the overstatement this file exists to prevent.
  it("is not implied by the promise-level list being empty, and both are empty together", () => {
    expect(unexecutedRealRuntimeSyncGuarantees()).toEqual([]);
    expect(unexecutedRuntimeRouteCoverage()).toEqual([]);
  });

  // A route nothing spans is a gap nobody can close, so the vocabulary has to stay tied to
  // the promises that actually use it.
  it("uses only routes some guarantee declares", () => {
    const declared = new Set(SYNC_GUARANTEES.flatMap(guarantee => guarantee.runtimeRoutes ?? []));

    for (const route of SYNC_RUNTIME_ROUTES) expect(declared, route).toContain(route);
  });

  // The write route is genuinely write-only for one promise: the unchanged route writes no
  // Cell, so "a write lands" has no meaning there. Asserted so a later edit cannot add it by
  // symmetry with the other two.
  it("does not invent an unchanged route for the promise about writing", () => {
    const write = findSyncGuarantee("written-without-manual-copy");

    expect(write.runtimeRoutes).toEqual(["write"]);
    expect(unexecutedRuntimeRouteCoverage().some(gap => gap.guaranteeId === "written-without-manual-copy")).toBe(false);
  });
});

// #115 added the version axis, and these tests hold it apart from the route axis for the same
// reason the route axis is held apart from the promise axis: a run on one build says nothing
// about another, and the two shapes #115 found version-sensitive are exactly what would be
// silently inherited if the version were folded into `executedAt`'s prose.
describe("what has been executed on each product version", () => {
  // The gap that makes this axis load-bearing, and the one this PR cannot close: the pinned
  // build was executed *before* the recognition change, and it is not installed here. Asserting
  // it is a gap is the honest state — a reader who wants the flow validated on 12.0.100.0 has to
  // run it there.
  it("reports the pinned build as unexecuted, with what a run on it would establish", () => {
    const gaps = unexecutedRuntimeVersionCoverage();

    expect(gaps.map(gap => gap.version)).toEqual(["12.0.100.0"]);
    expect(gaps[0].whatARunWouldEstablish).toContain("12.0.100.0");
    expect(gaps[0].whatARunWouldEstablish).toMatch(/re-run/i);
  });

  // The complement, so the report is not simply "nothing is validated": the version the run that
  // closed the route axis actually happened on is recorded as executed, and it is derived from
  // the guarantees rather than listed by hand.
  it("records the version the recorded executions ran on", () => {
    const executed = new Set(
      SYNC_GUARANTEES.filter(guarantee => guarantee.executedAt !== undefined).map(
        guarantee => guarantee.executedVersion,
      ),
    );

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
