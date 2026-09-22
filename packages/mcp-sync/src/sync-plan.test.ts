import { describe, expect, it } from "vitest";

import type { ExtensionDependencyDecision, ExtensionLibraryListing } from "@forguncy-react-workspace/core";
import {
  CELL_ARTIFACT_BANNER,
  frontendLibraryReference,
  verifyCellArtifact,
} from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import { syncDiagnosticCodes } from "./diagnostics";
import { fingerprintArtifact, readSyncMarker, stampSyncMarker, SyncFingerprintError } from "./fingerprint";
import {
  formatCellSyncPlan,
  formatCellSyncSteps,
  planCellSync,
  serializeCellSyncMutation,
  SYNC_MUTATION_GEOMETRY_NOTE,
  SYNC_MUTATION_OMITTED_FIELDS,
  toSetCellsRequest,
} from "./sync-plan";
import type { CellSyncPlan, CellSyncWrite, PlanCellSyncOptions } from "./sync-plan";
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
    const plan = planFor();

    expect(plan.target).toBe(TARGET);
    expect(toSetCellsRequest(plan)).toEqual({
      pageName: "OrderPage",
      cells: [...assembledWrite(plan).mutation.cells],
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

  it("refuses a setCells request, with the same code the plan reported", () => {
    const plan = planFor({ artifact: notGenerated });

    let thrown: unknown;
    try {
      toSetCellsRequest(plan);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SyncFingerprintError);
    expect((thrown as SyncFingerprintError).code).toBe("artifact-not-generated");

    // The marker refuses for the same reason and with the same code, so the plan and the
    // marker cannot be about two different conditions.
    let markerRefusal: unknown;
    try {
      stampSyncMarker(notGenerated);
    } catch (error) {
      markerRefusal = error;
    }
    expect((markerRefusal as SyncFingerprintError).code).toBe("artifact-not-generated");
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
