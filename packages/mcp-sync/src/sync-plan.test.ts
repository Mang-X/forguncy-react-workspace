import { describe, expect, it } from "vitest";

import type { ExtensionDependencyDecision, ExtensionLibraryListing } from "@forguncy-react-workspace/core";
import {
  CELL_ARTIFACT_BANNER,
  frontendLibraryReference,
  verifyCellArtifact,
} from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import { syncDiagnosticCodes } from "./diagnostics.ts";
import { fingerprintArtifact, readSyncMarker, stampSyncMarker } from "./fingerprint.ts";
import * as mcpSync from "./index.ts";
import {
  CELL_SYNC_HOLD_REASONS,
  formatCellSyncPlan,
  formatCellSyncSteps,
  planCellSync,
  planSetCellsDispatch,
  serializeCellSyncMutation,
  SYNC_MUTATION_GEOMETRY_NOTE,
  SYNC_MUTATION_OMITTED_FIELDS,
} from "./sync-plan.ts";
import type {
  CellSyncDispatch,
  CellSyncMutation,
  CellSyncPlan,
  CellSyncWrite,
  PlanCellSyncOptions,
} from "./sync-plan.ts";
import type { ForguncySyncPort, IssuedSetCellsRequest } from "./port.ts";
import type { CellTarget } from "./target.ts";

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
 * Synthetic on purpose: it exists so the permission logic is testable *without* the
 * flow being runnable at all — the value of a gate is that it can be asserted against a
 * plan the author built, not only against one the current rule table happens to produce.
 * Before #20 every real plan refused (two operations had no established call), which is
 * why this helper was the only path to `issue`; now a real plan can reach `issue` too,
 * and the tests below assert both — the synthesized shape *and* the real one.
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
  it("reports a writable target and a runnable flow at the same time", () => {
    const plan = planFor();

    expect(plan.writeAction).toBe("write");
    expect(plan.divergence.kind).toBe("vacant");
    expect(plan.gate).toBe("ready");
    // #20 established both operations the flow needed, so no plan refuses on a missing
    // call any more. The two questions are still separate fields — a plan can still hold a
    // write for a divergence or an unverified extension — but they no longer disagree by
    // default.
    expect([...plan.unestablishedCapabilities]).toEqual([]);
    expect(
      syncDiagnosticCodes(plan.diagnostics).filter(code => code === "sync-capability-unestablished"),
    ).toHaveLength(0);
  });

  it("reaches every step of the flow, none of them blocked", () => {
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
      "read-target-state": "ready",
      "write-cell-source": "ready",
      "save-project-if-required": "ready",
      "check-project-errors": "ready",
      "generate-page": "ready",
      "return-runtime-locator": "ready",
    });

    // No step is blocked, so none is not-reached either: the flow runs end to end.
    for (const step of plan.steps) {
      expect(step.unestablished, step.stepId).toEqual([]);
      expect(step.status, step.stepId).toBe("ready");
    }
    expect(formatCellSyncSteps(plan)).toBe(
      "1.resolve-cell-target=ready 2.verify-extension-metadata=ready 3.read-target-state=ready " +
        "4.write-cell-source=ready 5.save-project-if-required=ready " +
        "6.check-project-errors=ready 7.generate-page=ready 8.return-runtime-locator=ready",
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
    // A real refusal now comes from the target, not from a missing call: a foreign Cell is
    // refused by the divergence rule, which is the refusal #19's safety section is about.
    const plan = planFor({ deployed: { kind: "read", code: "designer work" } });

    expect(plan.gate).toBe("refused");
    expect(plan.write.kind).toBe("assembled");
    const dispatch = planSetCellsDispatch(plan);
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("gate-refused");
    expect(dispatch.detail).toContain("cell-diverged");
  });

  it("holds a skipped target even though it carries an assembled payload", () => {
    // The idempotency half: `writeAction === "skip"` with a payload present. Built to the
    // shape the real rule table now produces — a target holding this artifact's own output
    // is classified `identical`, not refused — which is what #20's real-runtime evidence
    // confirmed end to end.
    const first = planFor();
    const second = planFor({
      deployed: {
        kind: "read",
        code: assembledWrite(first).stampedCode,
        frontendLibraries: generated().frontendLibraries,
      },
    });
    const dispatch = planSetCellsDispatch(second);

    expect(second.gate).toBe("skipped");
    expect(dispatch.kind).toBe("hold");
    if (dispatch.kind !== "hold") return;
    expect(dispatch.reason).toBe("already-identical");
  });

  it("reports the refusal, not the idempotency, when an identical target is also refused", () => {
    // Pinned because it is easy to get backwards, and because it states where the two
    // defences sit relative to each other. A plan that is both identical *and* refused
    // (here: the artifact's references could not be confirmed, so the plan refuses on
    // `extension-metadata-unverified` while the target still reads as a skip) must report
    // the refusal: the write-action table is the second line of defence, not the first —
    // and a caller told "already identical" would never learn the plan was refused.
    const first = planFor({ artifact: generated(["lib-echarts"]) });
    const second = planFor({
      artifact: generated(["lib-echarts"]),
      deployed: {
        kind: "read",
        code: assembledWrite(first).stampedCode,
        frontendLibraries: generated(["lib-echarts"]).frontendLibraries,
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

  it("cannot be handed to the port without going through the dispatch", () => {
    // The payload being readable is not the same as the payload being sendable, and until
    // the port stopped accepting `SetCellsRequest` the difference was a convention: the plan
    // keeps an assembled mutation for a refused target, `CellSyncMutation` is structurally a
    // `SetCellsRequest`, so `port.setCells(plan.write.mutation)` compiled and skipped the gate.
    // This test is mostly its type annotations, because the barrier has to hold before
    // anything runs.

    /** Compile-time only: whether `From` may be passed where `To` is expected. */
    type Assignable<From, To> = [From] extends [To] ? true : false;
    type SetCellsParameter = Parameters<ForguncySyncPort["setCells"]>[0];

    // The assertion *is* these two annotations: swap the expected values, or make the port
    // accept `SetCellsRequest` again, and the test file stops compiling.
    const mutationIsNotAccepted: Assignable<CellSyncMutation, SetCellsParameter> = false;
    const issuedIsAccepted: Assignable<IssuedSetCellsRequest, SetCellsParameter> = true;

    // Never called. It exists so the compiler checks the call site, and it is a function
    // rather than a statement so the test does not make the call it forbids.
    const bypass = (port: ForguncySyncPort, mutation: CellSyncMutation): Promise<void> => {
      // @ts-expect-error the plan's payload is a report shape; only the dispatch mints a request
      return port.setCells(mutation);
    };

    const calls: SetCellsParameter[] = [];
    const port: ForguncySyncPort = {
      listFrontendLibraries: async () => [],
      readCellSource: async () => ({ kind: "blank" }),
      setCells: async request => {
        calls.push(request);
      },
      getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
      saveProject: async () => ({ saved: true }),
      checkProjectErrors: async () => ({ errorCount: 0 }),
      generatePageAsync: async () => ({ pageName: TARGET.pageName, pageUrl: "http://localhost:63982/Forguncy" }),
    };

    const plan = issuablePlan();
    const dispatch = planSetCellsDispatch(plan);
    expect(dispatch.kind).toBe("issue");
    if (dispatch.kind !== "issue") return;
    port.setCells(dispatch.request);

    // Read at runtime so a passing compile is not the whole story: if `Assignable` were ever
    // widened to `boolean`, both assertions below would still have to hold.
    expect(issuedIsAccepted).toBe(true);
    expect(mutationIsNotAccepted).toBe(false);
    expect(typeof bypass).toBe("function");

    expect(calls).toHaveLength(1);
    expect(calls[0].pageName).toBe(TARGET.pageName);
    expect(calls[0].cells).toEqual([...assembledWrite(plan).mutation.cells]);
  });

  it("keeps the request mint off the package's public surface", () => {
    // `issueSetCellsRequest` has to be exported from `port.ts` for the dispatch to use it,
    // and whoever can call it can bypass the gate — so the barrel names its exports one by
    // one. A future `export * from "./port"` would reopen the bypass silently, which is the
    // failure this asserts against rather than a stylistic preference.
    expect("issueSetCellsRequest" in mcpSync).toBe(false);
    expect("planSetCellsDispatch" in mcpSync).toBe(true);
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
    expect(text).toContain("Write action: write (gate: ready)");
    expect(text).toContain("Libraries to write: (none)");
    // #20 established both operations, so a real plan reports a runnable flow and an
    // issuable dispatch rather than the two refusals it used to report.
    expect(text).toContain("Every required designer operation has an established call name.");
    expect(text).toContain("Dispatch: issue the `setCells` call.");
    // The one thing a green local plan must not be read as, stated in the plan itself.
    expect(text).toContain("It does not establish Forguncy runtime behaviour.");
  });
});
