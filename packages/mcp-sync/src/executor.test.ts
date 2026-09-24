/**
 * The flow, executed: #20's executor against a recording port.
 *
 * Decision sources: #19's flow and safety sections, and #20's acceptance criteria.
 *
 * Two halves of #20 need separating, and this file is careful about which is which:
 *
 * - **What a local test can establish.** That the executor calls the flow's operations in
 *   #19's order, that a held plan sends nothing, that a non-zero error count fails the run,
 *   that a save happens exactly when the project says it is dirty, and that the locator is
 *   returned only when the write landed and the page generated. All of it is asserted
 *   against a *recording* stub, which is the only honest way to test a call sequence whose
 *   real half is a designer session.
 * - **What it cannot.** Whether a real designer accepts these calls, in this order, with
 *   these payloads. The stub is a stub: it records that `setCells` was called, not that the
 *   Cell was written. #20's real-designer validation is recorded on the Issue, and AGENTS.md
 *   rule 7 forbids presenting this file as runtime compatibility.
 *
 * The stub is deliberately *not* a mock framework's. A hand-written recorder makes the
 * assertion "this call happened before that one" a property of an ordered array a reader can
 * see, rather than of a spy that has to be read through its framework's rules.
 */

import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, frontendLibraryReference } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import { createCellRegistry } from "@forguncy-react-workspace/core";

import { executeCellSync, executeCellSyncTargets, formatCellSyncRun, deployedStateOfRead, readCellState } from "./executor.ts";
import type { CellSyncRun, ExecuteCellSyncOptions, SyncRunStepStatus } from "./executor.ts";
import { stampSyncMarker } from "./fingerprint.ts";
import type {
  ForguncySyncPort,
  GeneratedPage,
  IssuedSetCellsRequest,
  ProjectErrorReport,
  ProjectSaveResult,
  ProjectSaveStatus,
  ReadCellSourceResult,
} from "./port.ts";
import { planCellSync, planSetCellsDispatch } from "./sync-plan.ts";
import type { CellSyncPlan, PlanCellSyncOptions } from "./sync-plan.ts";
import type { CellTarget } from "./target.ts";

const TARGET: CellTarget = { pageName: "OrderPage", cell: "A1" };
const CODE_BODY = "function App() { return null; }\n";

function generated(libraryIds: readonly string[] = [], code = CODE_BODY): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\n${code}`,
    frontendLibraries: libraryIds.map(frontendLibraryReference),
  };
}

const RUNTIME: GeneratedPage = { pageName: TARGET.pageName, pageUrl: "http://localhost:63982/Forguncy/OrderPage" };

// ---------------------------------------------------------------------------
// The recording port
// ---------------------------------------------------------------------------

/**
 * A port that records the order and the arguments of every call it receives.
 *
 * `calls` is one flat ordered list across all methods, because the assertions this file
 * exists for are about *relative* order — the write before the error check, the check
 * before generation — and per-method arrays would let a reader compare two lists and miss
 * that the two operations interleaved.
 *
 * Every response is injectable so a test can put the flow into the state it is about
 * (`unsaved: true` for the save, `errorCount: 3` for the gate) without a second stub type.
 */
interface RecordingPortOptions {
  readonly read?: ReadCellSourceResult;
  readonly listings?: readonly { readonly id: string; readonly globalName: string }[];
  readonly saveStatus?: ProjectSaveStatus;
  readonly saveResult?: ProjectSaveResult;
  readonly errors?: ProjectErrorReport;
  readonly runtime?: GeneratedPage;
  /** Make a call reject, so the transport-failure path can be asserted. */
  readonly rejectAt?: "readCellSource" | "setCells" | "getProjectSaveStatus" | "saveProject" | "checkProjectErrors" | "generatePageAsync";
}

interface RecordingPort {
  readonly port: ForguncySyncPort;
  readonly calls: readonly { readonly method: string; readonly argument: unknown }[];
  readonly written: readonly IssuedSetCellsRequest[];
}

function recordingPort(options: RecordingPortOptions = {}): RecordingPort {
  const calls: { method: string; argument: unknown }[] = [];
  const written: IssuedSetCellsRequest[] = [];

  const record = (method: string, argument: unknown): void => {
    calls.push({ method, argument });
    if (options.rejectAt === method) throw new Error(`transport refused ${method}`);
  };

  const port: ForguncySyncPort = {
    listFrontendLibraries: async request => {
      record("listFrontendLibraries", request);
      return options.listings ?? [];
    },
    readCellSource: async request => {
      record("readCellSource", request);
      return options.read ?? { kind: "blank" };
    },
    setCells: async request => {
      record("setCells", request);
      written.push(request);
    },
    getProjectSaveStatus: async request => {
      record("getProjectSaveStatus", request);
      return options.saveStatus ?? { containsUnsavedChanges: false };
    },
    saveProject: async () => {
      record("saveProject", undefined);
      return options.saveResult ?? { saved: true };
    },
    checkProjectErrors: async () => {
      record("checkProjectErrors", undefined);
      return options.errors ?? { errorCount: 0 };
    },
    generatePageAsync: async request => {
      record("generatePageAsync", request);
      return options.runtime ?? RUNTIME;
    },
  };

  return { port, calls, written };
}

/** The methods called, in order. */
function methodOrder(calls: readonly { readonly method: string }[]): readonly string[] {
  return calls.map(call => call.method);
}

/** A run's per-step statuses, for asserting the flow's own bookkeeping. */
function stepStatuses(run: CellSyncRun): Record<string, SyncRunStepStatus> {
  return Object.fromEntries(run.steps.map(step => [step.stepId, step.status]));
}

/**
 * The options one run needs.
 *
 * There is deliberately no `deployed` or `listings` parameter, because the executor's own
 * type has no field for either: a test that wants the flow to see a particular target state
 * has to make the *port* answer with it (`recordingPort({ read })`), which is the same path
 * a real run takes. That is the point of the shape — a test cannot fabricate state any more
 * than a caller can.
 */
function runOptions(port: ForguncySyncPort, overrides: Record<string, unknown> = {}) {
  return {
    target: TARGET,
    artifact: generated(),
    decisions: [],
    port,
    ...overrides,
  } as Parameters<typeof executeCellSync>[0];
}

/**
 * A port whose read reports an occupied Cell, for the "someone else's work" cases.
 *
 * The product reports an occupied Cell without a `code`, which is why this is expressed as a
 * read *result* rather than as a code string: the adapter's translation is the thing under
 * test in `designer-transport.test.ts`, and here the flow only cares that the plan saw it.
 */
function occupiedPort(detail: string, other: RecordingPortOptions = {}): RecordingPort {
  return recordingPort({ ...other, read: { kind: "occupied", code: detail } });
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("executing a sync", () => {
  // The reviewer's first finding, as a test: the executor must read the project's live
  // state itself, *before* the mutation, rather than trusting a caller. "The caller says it
  // read this" is not what `before mutation` means, and the failure it allows — a stale
  // `{ kind: "read", code: "" }` for a Cell a designer has since edited — is silent.
  it("reads the extension listing and the target before it writes anything", async () => {
    const { port, calls } = recordingPort();

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("written");
    // Both reads precede the write, and they are the executor's own calls — a run that
    // trusted a caller's state would have no `readCellSource` here at all.
    expect(methodOrder(calls)).toEqual([
      "listFrontendLibraries",
      "readCellSource",
      "setCells",
      "getProjectSaveStatus",
      "checkProjectErrors",
      "generatePageAsync",
    ]);
    expect(stepStatuses(run)["verify-extension-metadata"]).toBe("ran");
    expect(stepStatuses(run)["read-target-state"]).toBe("ran");
  });

  // The enforcement is the type, so the assertion is the type. `ExecuteCellSyncOptions`
  // omits `deployed` and `listings`, which is what makes the bypass *unrepresentable*
  // rather than discouraged — a caller has nowhere to put a fabricated observation. This
  // test is mostly its annotations: widen the type and the file stops compiling.
  it("cannot be handed a caller's observation of the project", () => {
    /** Compile-time only: whether `T` has a field named `K`. */
    type HasField<T, K extends string> = K extends keyof T ? true : false;

    const hasDeployed: HasField<ExecuteCellSyncOptions, "deployed"> = false;
    const hasListings: HasField<ExecuteCellSyncOptions, "listings"> = false;
    // The plan, by contrast, *must* keep them: planning is a pure function of a state
    // someone supplies, and the read is the executor's obligation rather than the planner's.
    const planTakesDeployed: HasField<PlanCellSyncOptions, "deployed"> = true;

    // Read at runtime so a passing compile is not the whole story.
    expect(hasDeployed).toBe(false);
    expect(hasListings).toBe(false);
    expect(planTakesDeployed).toBe(true);
  });

  it("returns the runtime locator only after the write and the gates", async () => {
    const { port } = recordingPort();

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("written");
    if (run.status !== "written") return;
    expect(run.runtime).toEqual(RUNTIME);
    expect(run.runtime.pageUrl).toBe("http://localhost:63982/Forguncy/OrderPage");
    expect(stepStatuses(run)).toEqual({
      "resolve-cell-target": "ran",
      "verify-extension-metadata": "ran",
      "read-target-state": "ran",
      "write-cell-source": "ran",
      "save-project-if-required": "skipped",
      "check-project-errors": "ran",
      "generate-page": "ran",
      "return-runtime-locator": "ran",
    });
  });

  it("sends the payload the plan assembled, and nothing it did not", async () => {
    const { port, written } = recordingPort();

    await executeCellSync(runOptions(port));

    expect(written).toHaveLength(1);
    const [request] = written;
    expect(request.pageName).toBe(TARGET.pageName);
    expect(request.cells).toHaveLength(1);
    expect(request.cells[0].cell).toBe(TARGET.cell);
    expect(request.cells[0].cellType).toBe("ReactCellTypeCellType");
    expect(request.cells[0].cellTypeProps.code).toContain(CELL_ARTIFACT_BANNER);
    expect(request.cells[0].cellTypeProps.frontendLibraries).toEqual([]);
  });

  it("reports itself as a block, naming the locator it produced", async () => {
    const { port } = recordingPort();

    const run = await executeCellSync(runOptions(port));
    const text = formatCellSyncRun(run);

    expect(text).toContain("Sync run: OrderPage!A1 — written");
    expect(text).toContain(`Runtime locator: ${RUNTIME.pageUrl}`);
    // The one thing a green run must not be read as.
    expect(text).toContain("Runtime behaviour on the generated page is verified by opening the locator.");
  });
});

// ---------------------------------------------------------------------------
// The write is not reached
// ---------------------------------------------------------------------------

describe("when the plan holds", () => {
  it("sends nothing for a diverged target, though it did read it", async () => {
    const { port, calls } = recordingPort({ read: { kind: "react-cell", code: "designer work", frontendLibraries: [] } });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("held");
    if (run.status !== "held") return;
    expect(run.dispatch.reason).toBe("gate-refused");
    // The load-bearing assertion: the two reads happened, and *nothing that mutates* did. A
    // refusal that still called `setCells` would be the exact failure #19's safety section
    // describes, and the reads are what made the refusal possible.
    expect(methodOrder(calls)).toEqual(["listFrontendLibraries", "readCellSource"]);
    expect(stepStatuses(run)).toEqual({
      "resolve-cell-target": "ran",
      "verify-extension-metadata": "ran",
      "read-target-state": "ran",
      "write-cell-source": "not-reached",
      "save-project-if-required": "not-reached",
      "check-project-errors": "not-reached",
      "generate-page": "not-reached",
      "return-runtime-locator": "not-reached",
    });
  });

  it("holds a Cell holding something that is not a React Cell", async () => {
    const { port, calls } = occupiedPort("the value \"designer note\"");

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("held");
    if (run.status !== "held") return;
    expect(run.plan.divergence.kind).toBe("foreign-code");
    expect(methodOrder(calls)).toEqual(["listFrontendLibraries", "readCellSource"]);
    expect(stepStatuses(run)["write-cell-source"]).toBe("not-reached");
  });

  it("sends nothing when the artifact is not compiler output", async () => {
    const { port, calls } = recordingPort();

    const run = await executeCellSync(runOptions(port, { artifact: { code: CODE_BODY, frontendLibraries: [] } }));

    expect(run.status).toBe("held");
    if (run.status !== "held") return;
    expect(run.dispatch.reason).toBe("nothing-to-write");
    expect(methodOrder(calls)).toEqual(["listFrontendLibraries", "readCellSource"]);
  });

  it("reports a held run as held, never as written", async () => {
    const { port } = recordingPort({ read: { kind: "react-cell", code: "designer work", frontendLibraries: [] } });

    const run = await executeCellSync(runOptions(port));
    const text = formatCellSyncRun(run);

    expect(text).toContain("held");
    expect(text).not.toContain("Runtime locator");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("syncing the same artifact twice", () => {
  it("is a skip the second time, with no write", async () => {
    // The first run's *own output* is what the second run reads back — the round trip
    // through the designer is what a real project performs, and #20 measured it byte-identical.
    // The read comes from the port, which is the only way a run can learn a target's state.
    const artifact = generated();
    const stamped = stampSyncMarker(artifact);
    const { port, calls } = recordingPort({
      read: { kind: "react-cell", code: stamped, frontendLibraries: artifact.frontendLibraries },
    });

    const run = await executeCellSync(runOptions(port, { artifact }));

    expect(run.status).toBe("held");
    if (run.status !== "held") return;
    expect(run.plan.divergence.kind).toBe("identical");
    expect(run.dispatch.reason).toBe("already-identical");
    // Read, then decide not to write. Nothing that mutates was called.
    expect(methodOrder(calls)).toEqual(["listFrontendLibraries", "readCellSource"]);
  });

  it("plans a byte-identical payload for two runs of the same artifact", async () => {
    // Two runs of the same artifact must assemble the same bytes, or the second run would
    // report a change that is not one. Asserted on what the port actually received, because
    // that value is what crosses the wire.
    const first = recordingPort();
    const second = recordingPort();

    await executeCellSync(runOptions(first.port));
    await executeCellSync(runOptions(second.port));

    expect(first.written[0].cells[0].cellTypeProps.code).toBe(second.written[0].cells[0].cellTypeProps.code);
  });
});

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

describe("the conditional save", () => {
  it("saves when the project reports unsaved changes, and checks the status first", async () => {
    const { port, calls } = recordingPort({ saveStatus: { containsUnsavedChanges: true } });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("written");
    // The status read is what makes the save conditional; without it the step would have to
    // guess, and "always save" would make a clean project's state depend on sync running.
    // The two pre-mutation reads lead, as they must.
    expect(methodOrder(calls)).toEqual([
      "listFrontendLibraries",
      "readCellSource",
      "setCells",
      "getProjectSaveStatus",
      "saveProject",
      "checkProjectErrors",
      "generatePageAsync",
    ]);
    expect(stepStatuses(run)["save-project-if-required"]).toBe("ran");
  });

  it("does not save a project that reports no unsaved changes", async () => {
    const { port, calls } = recordingPort({ saveStatus: { containsUnsavedChanges: false } });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("written");
    expect(methodOrder(calls)).not.toContain("saveProject");
    expect(stepStatuses(run)["save-project-if-required"]).toBe("skipped");
  });

  it("fails the run when the product declines the save, without generating", async () => {
    const { port, calls } = recordingPort({
      saveStatus: { containsUnsavedChanges: true },
      saveResult: { saved: false },
    });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("failed");
    if (run.status !== "failed") return;
    // The Cell was written, so the caller has to know the project was mutated.
    expect(run.mutated).toBe(true);
    expect(run.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["project-errors-after-sync"]);
    // A project left unpersisted must not be generated and reported as a working sync.
    expect(methodOrder(calls)).not.toContain("generatePageAsync");
    expect(stepStatuses(run)["generate-page"]).toBe("not-reached");
  });
});

// ---------------------------------------------------------------------------
// The post-mutation gates
// ---------------------------------------------------------------------------

describe("the post-mutation gates", () => {
  it("fails the run on a non-zero error count, before generating", async () => {
    const { port, calls } = recordingPort({ errors: { errorCount: 2 } });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("failed");
    if (run.status !== "failed") return;
    expect(run.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["project-errors-after-sync"]);
    expect(run.mutated).toBe(true);
    // #19: a broken project is reported, not deployed and generated.
    expect(methodOrder(calls)).not.toContain("generatePageAsync");
    expect(formatCellSyncRun(run)).toContain("project-errors-after-sync");
  });

  it("fails the run when generation resolves with no locator", async () => {
    const { port } = recordingPort({ runtime: { pageName: TARGET.pageName, pageUrl: "  " } });

    const run = await executeCellSync(runOptions(port));

    expect(run.status).toBe("failed");
    if (run.status !== "failed") return;
    expect(run.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["runtime-generation-failed"]);
    // The write landed and the project was clean; only the locator is missing.
    expect(run.mutated).toBe(true);
    expect(stepStatuses(run)["return-runtime-locator"]).toBe("not-reached");
  });

  it("does not report a failed run as written, and carries no locator", async () => {
    const { port } = recordingPort({ errors: { errorCount: 1 } });

    const run = await executeCellSync(runOptions(port));

    // The union is the enforcement: there is no `runtime` on a failed run to read.
    expect(run.status).not.toBe("written");
    expect("runtime" in run).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A transport failure is not a finding
// ---------------------------------------------------------------------------

describe("a rejected designer call", () => {
  it("propagates rather than manufacturing a diagnostic", async () => {
    // `step-outcomes.ts` states the rule: a call that *rejects* is a transport failure with
    // no partial result to describe, and the honest shape is a thrown error the caller sees
    // — manufacturing a diagnostic here would lose the stack, which is the only thing that
    // helps for a transport problem.
    const { port } = recordingPort({ rejectAt: "setCells" });

    await expect(executeCellSync(runOptions(port))).rejects.toThrow(/transport refused setCells/);
  });

  it("propagates a rejected read too, leaving the writer with no state to classify", async () => {
    const { port } = recordingPort({ rejectAt: "readCellSource" });

    await expect(readCellState(port, TARGET)).rejects.toThrow(/transport refused readCellSource/);
  });
});

// ---------------------------------------------------------------------------
// The read mapping
// ---------------------------------------------------------------------------

describe("turning a read into a plan input", () => {
  it("maps a blank Cell to a vacant, writable target", () => {
    expect(deployedStateOfRead({ kind: "blank" })).toEqual({ kind: "read", code: "" });
  });

  it("maps a ReactCell to its code and references", () => {
    const state = deployedStateOfRead({
      kind: "react-cell",
      code: "x",
      frontendLibraries: [{ libraryId: "lib-a" }],
    });
    expect(state).toEqual({ kind: "read", code: "x", frontendLibraries: [{ libraryId: "lib-a" }] });
  });

  // The direction that matters: a Cell holding something else must not become an empty read.
  it("maps an occupied Cell to occupied, never to an empty read", () => {
    const state = deployedStateOfRead({ kind: "occupied", code: "a text value" });

    expect(state.kind).toBe("occupied");
    expect(state).not.toEqual({ kind: "read", code: "" });
    // And the classification agrees: it is a conflict, not a vacant target. Planned from the
    // translated state, which is the only value the executor ever passes on.
    expect(planCellSync({ target: TARGET, artifact: generated(), decisions: [], deployed: state }).divergence.kind).toBe(
      "foreign-code",
    );
  });

  it("performs the read the flow needs, and passes the request the platform takes", async () => {
    const { port, calls } = recordingPort({ read: { kind: "react-cell", code: "", frontendLibraries: [] } });

    const read = await readCellState(port, TARGET);

    expect(calls).toEqual([{ method: "readCellSource", argument: { pageName: "OrderPage", cell: "A1" } }]);
    expect(read.result.kind).toBe("react-cell");
    expect(read.state).toEqual({ kind: "read", code: "", frontendLibraries: [] });
  });
});

// ---------------------------------------------------------------------------
// A batch, through the registry
// ---------------------------------------------------------------------------

describe("executing a batch of declared Cells", () => {
  // The acceptance criterion this covers is "Cell id resolves through the shared project
  // config/target registry": the executor never sees a `pageName`/`cell` pair directly —
  // a declared Cell id does, through `core`'s registry — so the ids are what the test
  // names and the coordinates are what it asserts.
  const PROJECT_ROOT = process.platform === "win32" ? "C:\\probe\\project" : "/probe/project";

  function registryOf() {
    return createCellRegistry(
      {
        runtime: { forguncyVersion: "12.0.100", projectAlias: "sync-executor" },
        cells: {
          orderList: { entry: "cells/orderList/App.tsx", target: { pageName: "销售订单", cell: "A1" } },
          orderBoard: { entry: "cells/orderBoard/App.tsx", target: { pageName: "销售订单", cell: "D4" } },
        },
      },
      { root: PROJECT_ROOT, requireEntryFiles: false },
    );
  }

  it("resolves every id through the registry and writes each declared destination", async () => {
    const { port, written } = recordingPort();

    const runs = await executeCellSyncTargets(registryOf(), [
      { cellId: "orderList", artifact: generated(), decisions: [], port },
      { cellId: "orderBoard", artifact: generated(), decisions: [], port },
    ]);

    expect(runs.map(run => run.status)).toEqual(["written", "written"]);
    // The coordinates are the config's, not a caller's — which is the whole point of
    // resolving through the registry rather than accepting a target.
    expect(written.map(request => [request.pageName, request.cells[0].cell])).toEqual([
      ["销售订单", "A1"],
      ["销售订单", "D4"],
    ]);
  });

  it("reads each target and the listing immediately before its own write", async () => {
    const { port, calls } = recordingPort();

    await executeCellSyncTargets(registryOf(), [
      { cellId: "orderList", artifact: generated(), decisions: [], port },
      { cellId: "orderBoard", artifact: generated(), decisions: [], port },
    ]);

    // Per target, not once for the batch: a listing or a read taken at the start would be a
    // weaker claim by the time the last Cell was written, and `before mutation` means before
    // *this* one. Each read is immediately followed by that target's write.
    expect(methodOrder(calls)).toEqual([
      "listFrontendLibraries",
      "readCellSource",
      "setCells",
      "getProjectSaveStatus",
      "checkProjectErrors",
      "generatePageAsync",
      "listFrontendLibraries",
      "readCellSource",
      "setCells",
      "getProjectSaveStatus",
      "checkProjectErrors",
      "generatePageAsync",
    ]);
    expect(calls.filter(call => call.method === "readCellSource").map(call => call.argument)).toEqual([
      { pageName: "销售订单", cell: "A1" },
      { pageName: "销售订单", cell: "D4" },
    ]);
  });

  // The batch-wide guard, exercised through the executor rather than through the resolver
  // alone: the same id twice is a request-level collision that a well-formed registry
  // cannot express, and it is the one a caller can actually produce.
  it("fails the batch before reading or writing when one id is requested twice", async () => {
    const { port, calls } = recordingPort();

    await expect(
      executeCellSyncTargets(registryOf(), [
        { cellId: "orderList", artifact: generated(), decisions: [], port },
        { cellId: "orderList", artifact: generated(), decisions: [], port },
      ]),
    ).rejects.toThrow(/cell sync request|claim/i);
    // The batch's whole-request guard, not two guards racing: nothing reached the designer,
    // so there is no partially-written project to roll back. (Two *registry entries* cannot
    // express this collision — `createCellRegistry` refuses one at construction — which is
    // why the request-level guard exists as well.)
    expect(calls).toEqual([]);
  });

  it("refuses an id the registry does not declare", async () => {
    const { port, calls } = recordingPort();

    await expect(
      executeCellSyncTargets(registryOf(), [{ cellId: "notDeclared", artifact: generated(), decisions: [], port }]),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// The dispatch barrier, at the call site the executor uses
// ---------------------------------------------------------------------------

describe("the executor cannot send what the plan held", () => {
  it("only reaches `setCells` through the dispatch's own request", async () => {
    // Read from the same function the executor reads, so "what may be sent" and "what is
    // sent" cannot drift: an `issue` dispatch is the only case with a request to send.
    const plan = planCellSync({ target: TARGET, artifact: generated(), decisions: [], deployed: { kind: "read", code: "" } });
    const dispatch = planSetCellsDispatch(plan);

    expect(dispatch.kind).toBe("issue");
    if (dispatch.kind !== "issue") return;
    const { port, written } = recordingPort();
    await port.setCells(dispatch.request);

    expect(written[0]).toBe(dispatch.request);
  });

  it("has no request to send for a held plan", () => {
    const plan: CellSyncPlan = planCellSync({
      target: TARGET,
      artifact: generated(),
      decisions: [],
      deployed: { kind: "read", code: "designer work" },
    });
    const dispatch = planSetCellsDispatch(plan);

    expect(dispatch.kind).toBe("hold");
    expect("request" in dispatch).toBe(false);
  });
});
