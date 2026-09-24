import { describe, expect, it } from "vitest";

import {
  EXECUTED_AGAINST_DESIGNER,
  findSyncGuarantee,
  locallyCheckableSyncGuarantees,
  realRuntimeSyncGuarantees,
  SYNC_GUARANTEE_IDS,
  SYNC_GUARANTEES,
  unexecutedRealRuntimeSyncGuarantees,
} from "./guarantees.ts";
import type { SyncGuaranteeId } from "./guarantees.ts";

/**
 * #19's acceptance criteria are also its promises, and the reason they are data rather
 * than prose is that `level` is the question AGENTS.md rule 7 asks: could a local check
 * establish this, or does only a real Forguncy project produce the evidence? A green
 * `vp test` here establishes the contract and nothing about Forguncy runtime behaviour,
 * so these tests hold the split as much as the statements.
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
