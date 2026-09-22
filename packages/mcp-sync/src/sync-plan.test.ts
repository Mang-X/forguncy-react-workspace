import { describe, expect, it } from "vitest";

import type { ExtensionDependencyDecision, ExtensionLibraryListing } from "@forguncy-react-workspace/core";
import {
  CELL_ARTIFACT_BANNER,
  frontendLibraryReference,
  verifyCellArtifact,
} from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import { syncDiagnosticCodes } from "./diagnostics";
import { fingerprintArtifact, readSyncMarker, stampSyncMarker } from "./fingerprint";
import {
  CELL_SYNC_HOLD_REASONS,
  formatCellSyncPlan,
  formatCellSyncSteps,
  planCellSync,
  planSetCellsDispatch,
  serializeCellSyncMutation,
  SYNC_MUTATION_GEOMETRY_NOTE,
  SYNC_MUTATION_OMITTED_FIELDS,
} from "./sync-plan";
import type { CellSyncDispatch, CellSyncPlan, CellSyncWrite, PlanCellSyncOptions } from "./sync-plan";
import type { CellTarget } from "./target";

/**
 * The plan is where #19's decisions that need no live project are made: what the mutation
 * payload is, whether the target may be overwritten, whether the extensions are verified,
 * and how far the flow can reach. These tests hold three things in particular — that the
 * two failure questions (may this be written / can the flow run) are independent, that a
 * second sync of the same artifact asks for no change, and that an artifact which is not
 * compiler output has no deployment representation at all.
 */

const TANSTACK_DECISION: ExtensionDependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "tanstack-query",
  globalName: "TanStackQuery",
};

const TANSTACK_LISTING: ExtensionLibraryListing = {
  id: "tanstack-query",
  name: "TanStack Query",
  globalName: "TanStackQuery",
  exists: true,
  typeDefinitionAvailable: true,
};

const TARGET: CellTarget = { pageName: "OrderPage", cell: "cell-1" };

const CODE_BODY = "function App() { return null; }\n";

function generated(libraryIds: readonly string[] = [], code = CODE_BODY): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\n${code}`,
    frontendLibraries: libraryIds.map(frontendLibraryReference),
  };
}

/**
 * A plan with no extensions and a vacant target: the one combination whose diagnostics are
 * the flow's own, so a test that adds a condition does not have to filter out unrelated
 * findings.
 *
 * `listings: []` is a *stated* empty listing rather than an omitted one, deliberately — an
 * omitted listing means "nobody looked", which is a different plan.
 */
function planFor(overrides: Partial<PlanCellSyncOptions> = {}): CellSyncPlan {
  return planCellSync({
    target: TARGET,
    artifact: generated(),
    decisions: [],
    deployed: { kind: "read", code: "" },
    listings: [],
    ...overrides,
  });
}

function assembledWrite(plan: CellSyncPlan): Extract<CellSyncWrite, { kind: "assembled" }> {
  if (plan.write.kind !== "assembled") throw new Error("Expected an assembled write.");
  return plan.write;
}

/**
 * A plan shaped so that a write would be issued.
 *
 * Synthetic on purpose: `planCellSync` cannot produce an issuable plan today, because the two
 * designer operations with no established call name make every plan refuse. That is the
 * honest state, and it is exactly why the permission logic has to be testable without it —
 * otherwise the only path to `issue` would be an unverifiable one.
 */
function issuablePlan(overrides: Partial<CellSyncPlan> = {}): CellSyncPlan {
  return { ...planFor(), gate: "ready", writeAction: "write", diagnostics: [], ...overrides };
}

function statusByStep(plan: CellSyncPlan): Record<string, string> {
  return Object.fromEntries(plan.steps.map(step => [step.stepId, step.status]));
}

describe("assembling the write", () => {
  it("stamps the marker into the payload the port would send", () => {
    const artifact = generated();
    const plan = planFor({ artifact });
    const { stampedCode, mutation } = assembledWrite(plan);
    const [cell] = mutation.cells;

    expect(plan.fingerprint).toBe(fingerprintArtifact(artifact));
    expect(stampedCode.split("\n")[0]).toBe(CELL_ARTIFACT_BANNER);
    expect(readSyncMarker(stampedCode).kind).toBe("present");
    // The plan's own output has to survive the compiler's verification, or the deploy step
    // would invalidate what it just wrote.
    expect(
      verifyCellArtifact({ code: stampedCode, frontendLibraries: cell.cellTypeProps.frontendLibraries }),
    ).toEqual([]);

    expect(mutation.pageName).toBe("OrderPage");
    expect(mutation.cells).toHaveLength(1);
    expect(cell.cell).toBe("cell-1");
    expect(cell.cellType).toBe("ReactCellTypeCellType");
    expect(cell.cellTypeProps.code).toBe(stampedCode);
  });

  it("asks for exactly one target, located the way the platform does", () => {
    const plan = issuablePlan();

    expect(plan.target).toBe(TARGET);
    expect(planSetCellsDispatch(plan)).toEqual({
      kind: "issue",
      request: { pageName: "OrderPage", cells: [...assembledWrite(plan).mutation.cells] },
    });
  });

  it("never sends a cell geometry it did not measure", () => {
    const serialized = serializeCellSyncMutation(assembledWrite(planFor()).mutation);

    expect([...SYNC_MUTATION_OMITTED_FIELDS]).toEqual(["rowSpan", "colSpan"]);
    for (const field of SYNC_MUTATION_OMITTED_FIELDS) expect(serialized, field).not.toContain(field);
    // The omission is recorded rather than resolved by guessing, and it is the real-runtime
    // half of the write guarantee that confirms it.
    expect(SYNC_MUTATION_GEOMETRY_NOTE).toContain("api.page.setCells");
    expect(SYNC_MUTATION_GEOMETRY_NOTE).toContain("written-without-manual-copy");
  });
});

describe("the two questions the plan answers", () => {
  // The property that makes them separate fields: a Cell may be writable while the flow
  // still cannot be validated afterwards, and a caller reading one "executable" flag would
  // deploy without knowing that.
  it("reports a writable target and an unexecutable flow at the same time", () => {
    const plan = planFor();

    expect(plan.writeAction).toBe("write");
    expect(plan.divergence.kind).toBe("vacant");
    expect(plan.gate).toBe("refused");
    expect([...plan.unestablishedCapabilities]).toEqual(["read-cell-source", "save-project"]);
    expect(
      syncDiagnosticCodes(plan.diagnostics).filter(code => code === "sync-capability-unestablished"),
    ).toHaveLength(2);
  });

  it("stops the step plan at the first step whose call has no name", () => {
    const plan = planFor();

    expect(plan.steps.map(step => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.steps.map(step => step.phase)).toEqual([
      "before-mutation",
      "before-mutation",
      "before-mutation",
      "mutation",
      "after-mutation",
      "after-mutation",
      "after-mutation",
      "result",
    ]);
    expect(statusByStep(plan)).toEqual({
      "resolve-cell-target": "ready",
      "verify-extension-metadata": "ready",
      "read-target-state": "blocked",
      "write-cell-source": "not-reached",
      "save-project-if-required": "blocked",
      "check-project-errors": "not-reached",
      "generate-page": "not-reached",
      "return-runtime-locator": "not-reached",
    });

    // A `not-reached` step is not a problem in itself; it is the consequence of one that is.
    for (const step of plan.steps) {
      expect(step.unestablished.length > 0, step.stepId).toBe(step.status === "blocked");
    }
    expect(formatCellSyncSteps(plan)).toBe(
      "1.resolve-cell-target=ready 2.verify-extension-metadata=ready 3.read-target-state=blocked(read-cell-source) " +
        "4.write-cell-source=not-reached 5.save-project-if-required=blocked(save-project) " +
        "6.check-project-errors=not-reached 7.generate-page=not-reached 8.return-runtime-locator=not-reached",
    );
  });
});

describe("what an executor may send", () => {
  // A plan keeps an assembled payload even for a refused target, deliberately: that payload
  // is what `force` would send and what a reviewer reads. So the payload cannot also be the
  // permission — this block is what makes the permission fail closed.

  it("hands back a request only for a plan that may be issued", () => {
    const plan = issuablePlan();

    expect(planSetCellsDispatch(plan)).toEqual({
      kind: "issue",
      request: { pageName: "OrderPage", cells: [...assembledWrite(plan).mutation.cells] },
    });
  });

  it("holds a refused plan even though it carries a payload", () => {
    const plan = planFor();

    expect(plan.gate).toBe("refused");
    expect(plan.write.kind).toBe("assembled");
    const dispatch = planSetCellsDispatch(plan);
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("gate-refused");
    // Named once, not once per detector: two capabilities are unestablished, and the
    // subjects and their remediation live on the plan's own diagnostics.
    expect(dispatch.detail.match(/sync-capability-unestablished/g)).toHaveLength(1);
  });

  it("holds a skipped target even though it carries an assembled payload", () => {
    // The idempotency half of the review: `writeAction === "skip"` with a payload present.
    // Built to the shape the contract allows rather than read off a real plan, because a real
    // identical target is still refused today — see the test below — so the plan is
    // synthesized the same way the conflict case above is.
    const dispatch = planSetCellsDispatch(issuablePlan({ gate: "skipped", writeAction: "skip" }));

    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("already-identical");
  });

  it("reports the refusal, not the idempotency, when an identical target is also refused", () => {
    // Pinned because it is easy to get backwards, and because it states where the two
    // defences sit relative to each other. A real identical target never reaches
    // `already-identical`: the two designer operations with no established call name refuse
    // the plan first, so this is what an executor actually sees today. The write-action table
    // is the second line of defence, not the first — `already-identical` becomes reachable
    // once those operations are established.
    const first = planFor();
    const second = planFor({
      deployed: {
        kind: "read",
        code: assembledWrite(first).stampedCode,
        frontendLibraries: generated().frontendLibraries,
      },
    });

    expect(second.writeAction).toBe("skip");
    expect(second.gate).toBe("refused");
    const dispatch = planSetCellsDispatch(second);
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("gate-refused");
  });

  it("does not depend on a conflict always blocking the gate", () => {
    // `writeAction === "conflict"` with a non-refused gate is unreachable under the current
    // rule table — every divergence that conflicts also raises a blocking diagnostic. The
    // adapter must not rely on that coincidence: one rule flipping `blocksMutation` would
    // otherwise make a refused overwrite issuable.
    const conflicted = planFor({ deployed: { kind: "read", code: "designer work" } });
    expect(conflicted.writeAction).toBe("conflict");

    const dispatch = planSetCellsDispatch(issuablePlan({ writeAction: "conflict", divergence: conflicted.divergence }));
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("target-diverged");
  });

  it("holds a plan that has nothing to write before asking about the gate", () => {
    const plan = planFor({ artifact: { code: CODE_BODY, frontendLibraries: [] } });

    // Both conditions are true for this plan; `nothing-to-write` is the more precise answer,
    // because there is nothing to send whatever else is true.
    expect(plan.gate).toBe("refused");
    const dispatch = planSetCellsDispatch(plan);
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("nothing-to-write");
  });

  it("names its hold reasons, so an executor can report the one it hit", () => {
    expect([...CELL_SYNC_HOLD_REASONS]).toEqual([
      "nothing-to-write",
      "gate-refused",
      "target-diverged",
      "already-identical",
    ]);
  });

  it("cannot be made to yield a request from a hold", () => {
    const hold: CellSyncDispatch = { kind: "hold", reason: "gate-refused", detail: "…" };

    // @ts-expect-error a hold carries no request, so there is nothing for an executor to send
    expect(hold.request).toBeUndefined();
  });
});

describe("idempotency", () => {
  it("classifies its own output as identical and plans a skip, byte-for-byte unchanged", () => {
    const first = planFor();
    const second = planFor({
      deployed: { kind: "read", code: assembledWrite(first).stampedCode, frontendLibraries: generated().frontendLibraries },
    });

    expect(second.divergence.kind).toBe("identical");
    expect(second.writeAction).toBe("skip");
    expect(serializeCellSyncMutation(assembledWrite(second).mutation)).toBe(
      serializeCellSyncMutation(assembledWrite(first).mutation),
    );
  });

  it("claims no skip when it could not confirm the references", () => {
    const first = planFor();
    const second = planFor({ deployed: { kind: "read", code: assembledWrite(first).stampedCode } });

    // A marker proves the *code* is ours; the designer's cell properties panel can change
    // the library list without touching the code, so the write simply re-asserts both.
    expect(second.divergence.kind).toBe("previous-generation");
    expect(second.writeAction).toBe("write");
  });

  it("normalizes reference order, so the same dependencies cannot plan two payloads", () => {
    const overlapping: Partial<PlanCellSyncOptions> = {
      decisions: [TANSTACK_DECISION],
      listings: [TANSTACK_LISTING],
    };
    const ascending = planFor({ ...overlapping, artifact: generated(["tanstack-query", "zzz-extra"]) });
    const descending = planFor({ ...overlapping, artifact: generated(["zzz-extra", "tanstack-query"]) });

    expect(ascending.fingerprint).toBe(descending.fingerprint);
    expect(assembledWrite(ascending).mutation.cells[0].cellTypeProps.frontendLibraries).toEqual([
      { libraryId: "tanstack-query" },
      { libraryId: "zzz-extra" },
    ]);
    expect(serializeCellSyncMutation(assembledWrite(ascending).mutation)).toBe(
      serializeCellSyncMutation(assembledWrite(descending).mutation),
    );
  });
});

describe("refusing a diverged target", () => {
  it("stops the write and still describes what a force would send", () => {
    const plan = planFor({ deployed: { kind: "read", code: "function App() { return 1; }\n" } });

    expect(plan.divergence.kind).toBe("foreign-code");
    expect(plan.writeAction).toBe("conflict");
    expect(plan.gate).toBe("refused");
    expect(syncDiagnosticCodes(plan.diagnostics)).toContain("cell-diverged");
    // The payload is present because a refusal is not the same as having nothing to write:
    // this is what a reviewer reads, and what an explicit force would send.
    expect(plan.write.kind).toBe("assembled");
  });

  it("records what an explicit force overrode, and reports nothing to override by default", () => {
    const deployed = { kind: "read", code: "designer work" } as const;

    const forced = planFor({ deployed, overwrite: "force" });
    expect(forced.writeAction).toBe("write");
    expect(forced.overriddenConflict?.kind).toBe("foreign-code");
    expect(syncDiagnosticCodes(forced.diagnostics)).not.toContain("cell-diverged");
    expect(formatCellSyncPlan(forced)).toContain("Overridden by an explicit force: foreign-code");

    expect(planFor({ deployed }).overriddenConflict).toBeUndefined();
    expect(formatCellSyncPlan(planFor({ deployed }))).toContain("No conflict was overridden.");
  });

  it("refuses a target it could not read, rather than writing over it blindly", () => {
    const plan = planFor({ deployed: { kind: "unread", reason: "no-established-read-capability" } });

    expect(plan.divergence.kind).toBe("unverifiable");
    expect(plan.writeAction).toBe("conflict");
    expect(syncDiagnosticCodes(plan.diagnostics)).toContain("cell-state-unverifiable");
  });
});

describe("an artifact that is not compiler output", () => {
  const notGenerated: CompileCellResult = { code: CODE_BODY, frontendLibraries: [] };

  it("has no deployment representation, and the plan says so instead of throwing", () => {
    const plan = planFor({ artifact: notGenerated });

    expect(plan.write.kind).toBe("not-assembled");
    if (plan.write.kind !== "not-assembled") return;
    expect(plan.write.reason.code).toBe("artifact-not-generated");
    expect(syncDiagnosticCodes(plan.diagnostics)).toContain("artifact-not-generated");
    expect(plan.gate).toBe("refused");
    expect(formatCellSyncPlan(plan)).toContain("Nothing to write:");
  });

  it("hands out no request, and gives the same reason the plan reported", () => {
    const plan = planFor({ artifact: notGenerated });

    if (plan.write.kind !== "not-assembled") throw new Error("Expected no assembled write.");
    const dispatch = planSetCellsDispatch(plan);
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("nothing-to-write");
    expect(dispatch.detail).toBe(plan.write.reason.message);

    // The marker refuses for the same reason and with the same code, so the plan and the
    // marker cannot be about two different conditions.
    let markerRefusal: unknown;
    try {
      stampSyncMarker(notGenerated);
    } catch (error) {
      markerRefusal = error;
    }
    expect((markerRefusal as { code?: string }).code).toBe("artifact-not-generated");
  });
});

describe("verifying the extensions before the write", () => {
  it("refuses when the artifact has references and no listing was supplied", () => {
    const plan = planFor({
      artifact: generated(["tanstack-query"]),
      decisions: [TANSTACK_DECISION],
      listings: undefined,
    });

    expect(plan.extensionVerification.verification).toBe("unstated");
    expect(syncDiagnosticCodes(plan.diagnostics)).toContain("extension-metadata-unverified");
    expect(plan.gate).toBe("refused");
  });

  it("reports a reference its own decisions do not back", () => {
    const plan = planFor({ artifact: generated(["lib-echarts"]) });

    expect([...plan.extensionVerification.unbackedReferences]).toEqual(["lib-echarts"]);
    expect(syncDiagnosticCodes(plan.diagnostics)).toContain("library-reference-mismatch");
  });

  it("does not ask every artifact to have extensions", () => {
    // An inline-only Cell referencing nothing must not fail on a step it does not use.
    const plan = planFor();

    expect(plan.extensionVerification.references).toEqual([]);
    expect(syncDiagnosticCodes(plan.diagnostics)).not.toContain("extension-metadata-unverified");
  });
});

describe("reporting a plan", () => {
  it("is one block a CI log or a PR body can carry", () => {
    const plan = planFor();
    const text = formatCellSyncPlan(plan);

    expect(text).toContain("Sync target: OrderPage!cell-1");
    expect(text).toContain(`Artifact fingerprint: ${plan.fingerprint}`);
    expect(text).toContain("Target state: vacant");
    expect(text).toContain("Write action: write (gate: refused)");
    expect(text).toContain("Libraries to write: (none)");
    expect(text).toContain(
      "Flow cannot be executed end to end: read-cell-source, save-project have no established call name.",
    );
    // The one thing a green local plan must not be read as, stated in the plan itself.
    expect(text).toContain("It does not establish Forguncy runtime behaviour.");
  });
});
