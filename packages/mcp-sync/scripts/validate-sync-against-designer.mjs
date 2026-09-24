/**
 * #20's real-designer validation: the executor, against Forguncy 12.0.100.0.
 *
 * This is not an automated test. It is the *executed* half of #20's acceptance criteria —
 * "No manual copy/paste is needed for a generated Cell artifact", "Syncing the same
 * artifact twice is idempotent", "Project errors are surfaced as structured failures",
 * "Runtime generation output can be handed to browser/runtime verification" — run against
 * a live designer session with a disposable page, and it is recorded here so the run is
 * reproducible and its raw observations are the evidence rather than a summary of them.
 *
 * ## Why it is a script and not a vitest test
 *
 * It needs a running Forguncy designer with a project open. A `vp test` that required one
 * would fail on every machine that does not, and `describe.skipIf` would make the real
 * validation indistinguishable from the local half — which is exactly the confusion
 * AGENTS.md rule 7 forbids. Separate file, separate runner, and the output is pasted into
 * the Issue as the evidence.
 *
 * ## What it does, and what it cleans up
 *
 * It creates one page (`fgc-sync-probe-<date>`), drives the full flow into three Cells,
 * reads everything back, and reports. It does **not** delete the page: deleting is a
 * second mutation, and the run's value is the state a reviewer can inspect afterwards.
 * The page is disposable and the name says so.
 *
 * ## Running it
 *
 *   node --experimental-strip-types scripts/validate-sync-against-designer.mjs
 *
 * Point `FGC_MCP_URL` at the designer if it is not on the default port. The script speaks
 * the MCP streamable-HTTP transport directly (no SDK dependency) because the transport is
 * the one thing it must not share with the code under test — a bug in a shared client
 * would make the validation agree with itself.
 */

import { createHash } from "node:crypto";

// The transport and executor are loaded from source, so the validation runs the code
// under review rather than a build.
const { createDesignerSyncPort } = await import("../src/designer-transport.ts");
const { executeCellSync, executeCellSyncTargets, readCellState } = await import("../src/executor.ts");
const { planCellSync } = await import("../src/sync-plan.ts");
const { CELL_ARTIFACT_BANNER } = await import("@forguncy-react-workspace/cell-compiler");
const { EXTENSION_EXTERNAL_MAPPINGS, createCellRegistry } = await import("@forguncy-react-workspace/core");

const URL_ = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";

/**
 * A page name unique to this run.
 *
 * Unique rather than one fixed name, because the flow's *own* refusals are the point: a
 * second run against the first run's page would find a Cell whose marker the first run
 * wrote and either skip it (correctly, and uninformative) or — if anything had touched it
 * — refuse it as diverged. Neither exercises a fresh write. A new page per run makes every
 * assertion about a write that just happened.
 *
 * The cost is that each run leaves one disposable page behind, which the script says rather
 * than hides: `api.page.clearCells` and `api.page.deletePage` are both `write/dangerous` in
 * the product's own permission model and require a human confirmation, and a validation
 * script must not be the thing that asks for one. The name carries the run id, so the pages
 * are identifiable and removable by hand.
 */
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = process.env.FGC_PROBE_PAGE ?? `fgc-sync-probe-${RUN_ID}`;

/**
 * The extension decision to validate against.
 *
 * Taken from `core`'s shipped mapping table rather than invented here, because the plan
 * verifies the artifact's references against *that* table: a validation that supplied its
 * own `{ libraryId, globalName }` would exercise the sync's checks and then fail on a row
 * the repository does not have. The default is the one `extension` mapping #12 records —
 * `@tanstack/react-query` → `tanstack-query` / `TanStackQuery` — and the first run of this
 * script proved the point by failing on a hand-written `es-toolkit` decision, which is the
 * `inline` example and has no mapping row.
 */
const MAPPING =
  EXTENSION_EXTERNAL_MAPPINGS.find(row => row.libraryId === process.env.FGC_PROBE_LIBRARY) ??
  EXTENSION_EXTERNAL_MAPPINGS[0];

// ---------------------------------------------------------------------------
// A minimal MCP client — deliberately not shared with the code under test
// ---------------------------------------------------------------------------

let sessionId = null;

async function rpc(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(URL_, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const assigned = response.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await response.text();
  const payloads = text
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => JSON.parse(line.slice(5).trim()));
  if (payloads.length === 0) return null;
  return payloads.length === 1 ? payloads[0] : payloads;
}

async function connect() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fgc-sync-validation", version: "0" },
  });
  await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return init;
}

const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

const findings = [];
const record = (step, value) => {
  findings.push({ step, value });
  console.log(`\n### ${step}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
};

/** Run one designer script and return its `result`, for direct observation. */
async function designer(script) {
  const response = await callTool("execute_code", {
    title: "validation",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: "safeWriteAuto",
  });
  if (response?.result?.isError) throw new Error(response.result.content?.[0]?.text ?? "designer error");
  const text = response?.result?.content?.map(block => block.text).join("\n") ?? "";
  const parsed = JSON.parse(text);
  return parsed.result;
}

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  const init = await connect();
  record("environment", {
    server: init?.result?.serverInfo,
    page: PAGE,
    extension: { libraryId: MAPPING.libraryId, packageName: MAPPING.packageName, globalName: MAPPING.globalName },
  });

  // A disposable page, created fresh for this run. Nothing existing is touched, and no
  // `write/dangerous` call (clear, delete) is made — see `RUN_ID` for why a new page is the
  // way to get blank Cells without asking for a permission a script should not ask for.
  await designer(`
    const pages = await api.page.listPages({});
    if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) {
      throw new Error("Page " + ${JSON.stringify(PAGE)} + " already exists; this run needs a fresh page.");
    }
    await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 30, columnCount: 12 });
    return { page: ${JSON.stringify(PAGE)}, created: true };
  `);

  const port = createDesignerSyncPort({ callTool });

  // --- The listing, through the port, is what the plan verifies against -------------
  const listings = await port.listFrontendLibraries({});
  record("1. listFrontendLibraries through the port", listings);

  // --- A compiled artifact, as the compiler would produce it -------------------------
  // Banner + a real component body, plus the extension reference the decision implies.
  // The code is synthetic but its *shape* is the compiler's: the banner first, a
  // `function App(props)` binding, no import/export — and it reads the extension global
  // through `props` rather than importing it, which is what an `extension` decision
  // compiles to (#12).
  const artifact = {
    code:
      `${CELL_ARTIFACT_BANNER}\n` +
      `function App(props) {\n` +
      `  var Toolkit = globalThis[${JSON.stringify(MAPPING.globalName)}];\n` +
      `  var label = "synced by mcp-sync; extension global " + (typeof Toolkit) + ` +
      `(Toolkit === undefined ? " MISSING" : " present");\n` +
      `  return React.createElement("div", { "data-sync-probe": "1" }, label + " @ " + props.cell);\n` +
      `}\n`,
    frontendLibraries: [{ libraryId: MAPPING.libraryId }],
  };

  /**
   * The decision the artifact was compiled against.
   *
   * `decisions` is half of the reference check (`verifyExtensionReferences` compares what
   * the artifact declares against what its decisions imply), so passing the mapping's own
   * three fields is what makes the check meaningful rather than vacuous.
   */
  const decisions = [
    {
      strategy: "extension",
      packageName: MAPPING.packageName,
      libraryId: MAPPING.libraryId,
      globalName: MAPPING.globalName,
    },
  ];

  // --- The flow, per target ---------------------------------------------------------
  const targets = [
    { pageName: PAGE, cell: "A1" },
    { pageName: PAGE, cell: "B1" },
  ];

  const runs = [];
  for (const target of targets) {
    const { state } = await readCellState(port, target);
    record(`2. read ${target.cell} before the write`, state);

    const run = await executeCellSync({
      target,
      artifact,
      decisions,
      deployed: state,
      listings,
      port,
    });
    runs.push(run);
    record(`3. executeCellSync ${target.cell}`, {
      status: run.status,
      steps: run.steps.map(step => `${step.order}.${step.stepId}=${step.status}`),
      diagnostics: run.diagnostics.map(diagnostic => diagnostic.code),
      runtime: run.status === "written" ? run.runtime : undefined,
    });
  }

  const first = runs[0];
  if (first.status !== "written") {
    record("RESULT: FAILED — the flow did not complete", first);
    process.exitCode = 1;
    return;
  }

  // --- Read back: what the designer actually persisted ------------------------------
  const readBack = await designer(`
    const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "A1:B1" });
    return g.cells.map(c => ({ row: c.row, col: c.col, cellType: c.cellType, keys: Object.keys(c.cellTypeProps ?? {}), code: c.cellTypeProps?.code, frontendLibraries: c.cellTypeProps?.frontendLibraries ?? null }));
  `);
  record("4. read back what was persisted", readBack);

  const [cellA, cellB] = readBack;
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  };

  console.log("\n### 5. acceptance checks");
  check(
    "no manual copy/paste: the persisted code is the artifact's, banner and all",
    cellA.code?.startsWith(CELL_ARTIFACT_BANNER) === true,
  );
  check(
    "the marker survived the round trip, so a second sync can recognise its own output",
    cellA.code?.includes("fgc-sync") === true,
  );
  check(
    "the persisted code is byte-identical to what was written",
    cellA.code === readBack[0].code && sha256(cellA.code) === sha256(readBack[0].code),
  );
  check(
    "both Cells carry the artifact (one artifact, N targets)",
    cellB.code === cellA.code,
  );
  check(
    "the library reference persisted, keyed by libraryId and nothing else",
    cellA.frontendLibraries?.length === 1 && cellA.frontendLibraries[0].libraryId === MAPPING.libraryId,
    JSON.stringify(cellA.frontendLibraries),
  );
  check(
    "runtime locator returned for browser verification",
    typeof first.runtime.pageUrl === "string" && first.runtime.pageUrl.length > 0,
    first.runtime.pageUrl,
  );

  // --- Idempotency: sync the same artifact again ------------------------------------
  const secondState = await readCellState(port, targets[0]);
  const secondPlan = planCellSync({
    target: targets[0],
    artifact,
    decisions,
    deployed: secondState.state,
    listings,
  });
  record("6. second sync of the same artifact", {
    readBackState: secondState.state.kind,
    divergence: secondPlan.divergence.kind,
    writeAction: secondPlan.writeAction,
    gate: secondPlan.gate,
  });
  check(
    "a second sync of the same artifact is classified identical and skipped",
    secondPlan.divergence.kind === "identical" && secondPlan.writeAction === "skip",
    `${secondPlan.divergence.kind} / ${secondPlan.writeAction}`,
  );

  const secondRun = await executeCellSync({
    target: targets[0],
    artifact,
    decisions,
    deployed: secondState.state,
    listings,
    port,
  });
  record("7. second run", {
    status: secondRun.status,
    steps: secondRun.steps.map(step => `${step.order}.${step.stepId}=${step.status}`),
  });
  check(
    "the second run issues no write",
    secondRun.status === "held" && secondRun.steps.find(step => step.stepId === "write-cell-source")?.status === "not-reached",
  );

  // --- Divergence: a Cell the repository did not write is refused -------------------
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{ cell: "C1", cellType: "ReactCellTypeCellType", cellTypeProps: { code: "function App() { return null; } // designed by hand\\n", frontendLibraries: [] } }] });
    return true;
  `);
  const foreignTarget = { pageName: PAGE, cell: "C1" };
  const foreignState = await readCellState(port, foreignTarget);
  const foreignRun = await executeCellSync({
    target: foreignTarget,
    artifact,
    decisions,
    deployed: foreignState.state,
    listings,
    port,
  });
  record("8. a hand-written Cell", {
    divergence: foreignRun.plan.divergence.kind,
    status: foreignRun.status,
    dispatch: foreignRun.status === "held" ? foreignRun.dispatch.reason : undefined,
  });
  check(
    "a hand-written Cell is refused, not overwritten",
    foreignRun.status === "held" &&
      foreignRun.plan.divergence.kind === "foreign-code" &&
      foreignRun.dispatch.reason === "gate-refused",
  );

  // --- A Cell holding a plain value, which is not blank ------------------------------
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{ cell: "D1", value: "designer note" }] });
    return true;
  `);
  const valueState = await readCellState(port, { pageName: PAGE, cell: "D1" });
  record("9. a Cell holding a plain value", valueState);
  check(
    "a Cell holding a text value reads as occupied, not as blank",
    valueState.state.kind === "occupied",
    valueState.state.kind,
  );

  // --- The error gate, and the save -------------------------------------------------
  const errors = await port.checkProjectErrors();
  record("10. checkProjectErrors through the port", errors);
  check("the project reports zero errors after the sync", errors.errorCount === 0, String(errors.errorCount));

  const saved = await port.saveProject();
  const after = await port.getProjectSaveStatus({});
  record("11. saveProject through the port", { saved, after });
  check("the project was saved", saved.saved === true);
  check("the project reports no unsaved changes after the save", after.containsUnsavedChanges === false);

  // --- Geometry: a merged Cell keeps its merge ---------------------------------------
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{ cell: "E1", rowSpan: 2, colSpan: 2, cellType: "ReactCellTypeCellType", cellTypeProps: { code: "function App() { return null; }\\n", frontendLibraries: [] } }] });
    return true;
  `);
  const mergedRun = await executeCellSync({
    target: { pageName: PAGE, cell: "E1" },
    artifact,
    decisions,
    deployed: (await readCellState(port, { pageName: PAGE, cell: "E1" })).state,
    listings,
    overwrite: "force",
    port,
  });
  const merged = await designer(`
    const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "E1" });
    return { rowSpan: g.cells[0].rowSpan ?? null, colSpan: g.cells[0].colSpan ?? null };
  `);
  record("12. a merged Cell after the sync", merged);
  check(
    "a merged Cell keeps its geometry (the mutation omits rowSpan/colSpan)",
    merged.rowSpan === 2 && merged.colSpan === 2,
    JSON.stringify(merged),
  );
  check("the merged Cell was written", mergedRun.status === "written", mergedRun.status);

  // --- A batch, reached through the shared registry ---------------------------------
  // The criterion is "Cell id resolves through the shared project config/target registry":
  // the executor is given *ids*, and the coordinates it writes are the config's.
  const registry = createCellRegistry(
    {
      runtime: { forguncyVersion: "12.0.100", projectAlias: "fgc-sync-validation" },
      cells: {
        probeA: { entry: "cells/probeA/App.tsx", target: { pageName: PAGE, cell: "F1" } },
        probeB: { entry: "cells/probeB/App.tsx", target: { pageName: PAGE, cell: "G1" } },
      },
    },
    { root: process.cwd(), requireEntryFiles: false },
  );
  const batchRuns = await executeCellSyncTargets(registry, [
    { cellId: "probeA", artifact, decisions, listings, port },
    { cellId: "probeB", artifact, decisions, listings, port },
  ]);
  const batchRead = await designer(`
    const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "F1:G1" });
    return g.cells.map(c => ({ row: c.row, col: c.col, hasCode: typeof c.cellTypeProps?.code === "string" }));
  `);
  record("13. a batch resolved through the registry", {
    runs: batchRuns.map(run => `${run.target.pageName}!${run.target.cell}=${run.status}`),
    persisted: batchRead,
  });
  check(
    "the batch wrote the coordinates the config declared, not a caller's",
    batchRuns.map(run => `${run.target.pageName}!${run.target.cell}`).join(",") === `${PAGE}!F1,${PAGE}!G1` &&
      batchRuns.every(run => run.status === "written"),
    batchRuns.map(run => run.status).join(","),
  );
  check("both batch Cells persisted generated code", batchRead.length === 2 && batchRead.every(c => c.hasCode));

  // --- Summary ----------------------------------------------------------------------
  const failed = checks.filter(entry => !entry.ok);
  record("RESULT", {
    page: PAGE,
    passed: checks.length - failed.length,
    failed: failed.map(entry => entry.name),
    verdict: failed.length === 0 ? "all acceptance checks passed against a real project" : "FAILED",
  });
  if (failed.length > 0) process.exitCode = 1;
}

await main();
