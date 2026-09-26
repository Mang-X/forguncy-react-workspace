import { describe, expect, it } from "vitest";

import {
  EXECUTED_AGAINST_DESIGNER,
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
  SYNC_RUNTIME_ROUTE_MEANINGS,
  SYNC_RUNTIME_ROUTES,
  unexecutedRealRuntimeSyncGuarantees,
  unexecutedRuntimeRouteCoverage,
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
      // The version and the fact it was a real session, not "verified somewhere".
      expect(guarantee.executedAt, guarantee.id).toBe(EXECUTED_AGAINST_DESIGNER);
      expect(guarantee.executedAt, guarantee.id).toMatch(/12\.0\.100\.0/);
      expect(guarantee.executedAt, guarantee.id).toContain("#20");
    }
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
  it("pairs every execution record with the routes it covered", () => {
    for (const guarantee of SYNC_GUARANTEES) {
      const hasExecution = guarantee.executedAt !== undefined;
      if (hasExecution) {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeDefined();
        expect(guarantee.executedRoutes, guarantee.id).toBeDefined();
      } else {
        expect(guarantee.runtimeRoutes, guarantee.id).toBeUndefined();
        expect(guarantee.executedRoutes, guarantee.id).toBeUndefined();
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

// #92 gave two already-executed real-runtime promises a second route, and #20's run — the
// only execution on record — covers one of them. The promise-level check above cannot see
// that: the error gate has been executed, so it is not "unexecuted". These tests hold the
// finer question apart, which is the one a reader deciding whether the unchanged path is
// validated actually asks.
describe("what has been executed on each route through the flow", () => {
  it("reports the routes added after the recorded execution, with what each one does", () => {
    const gaps = unexecutedRuntimeRouteCoverage();

    // Deterministic order: guarantees in declaration order, routes in `SYNC_RUNTIME_ROUTES`
    // order, so a report is stable rather than dependent on object iteration.
    expect(gaps.map(gap => `${gap.guaranteeId}:${gap.route}`)).toEqual([
      "project-errors-checked-after-mutation:unchanged",
      "runtime-locator-returned:unchanged",
      "sync-is-idempotent:unchanged",
    ]);
    for (const gap of gaps) {
      // A gap names what a run on that route does, so it is readable without a second lookup
      // — an entry that only named a route id would make a reader reconstruct the flow.
      expect(gap.routeMeaning, `${gap.guaranteeId}:${gap.route}`).toContain("wrote nothing");
      expect(SYNC_RUNTIME_ROUTE_MEANINGS[gap.route]).toBe(gap.routeMeaning);
    }
  });

  // The property that makes the gap meaningful rather than a permanent list: nothing in the
  // write route is missing, so the report is not simply "everything is unvalidated".
  it("reports no gap on the route #20 executed", () => {
    const writeGaps = unexecutedRuntimeRouteCoverage().filter(gap => gap.route === "write");

    expect(writeGaps).toEqual([]);
  });

  // The whole reason this axis exists, stated as the test that would have caught the
  // original overstatement: the promise-level function is empty while a route-level gap is
  // open, so the empty list alone must not be read as full coverage.
  it("is not implied by the promise-level list being empty", () => {
    expect(unexecutedRealRuntimeSyncGuarantees()).toEqual([]);
    expect(unexecutedRuntimeRouteCoverage().length).toBeGreaterThan(0);
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
