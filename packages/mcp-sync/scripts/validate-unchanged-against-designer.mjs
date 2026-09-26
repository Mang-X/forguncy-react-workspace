/**
 * #92's executed evidence — the `unchanged` path and the refusal path — through the **shipped
 * adapter**, against a live designer. Extended by #115 to be adapter-level.
 *
 * ## What this run establishes, and what it does not
 *
 * It establishes, against a real product and with **no port correction of any kind**, both of
 * #92's paths end to end: a second sync of the same artifact reports `unchanged` (not
 * `refused`), issues no `setCells`, and *still* runs the save-status read, the error check, the
 * generation and the locator — with a locator this run generated. And it establishes that a
 * hand-written Cell is `refused` with `gate-refused`, a different status and a different reason
 * from the skip.
 *
 * AGENTS.md rule 7: this is the runtime half. The local half is
 * `src/executor.test.ts`'s "syncing the same artifact twice" block, and neither substitutes
 * for the other.
 *
 * ## This run was executor-level, and is not any more
 *
 * The previous version of this script ran the executor against a port it corrected in **two**
 * places, because the shipped adapter could not reach this path on Forguncy 12.0.101.0: the
 * read-back cell-type name, and the generation call. Both were reported on #115 rather than
 * patched here, and both are now fixed in `designer-transport.ts`. The corrections are gone,
 * so this run's evidence is what it always claimed to be about — the whole flow, adapter
 * included. A `readCellSource` or `generatePageAsync` override returning here would silently
 * put the run back to its old scope, which is why the port is now the bare adapter with no
 * spread, no override and no explanatory comment to hide behind.
 *
 * The `port` is still wrapped the way #20's script wraps it — recorded, not corrected: the
 * write request is captured so a check can compare what was *dispatched* against what was
 * persisted, and the second sync's dispatch is captured so "it issued no write" is asserted
 * from the observable calls rather than from a step status alone.
 *
 * ## Known environment limit, reported not worked around
 *
 * On this project `api.app.saveProject` can exceed execute_code's fixed 60 s budget (#113
 * measured it; #115 re-measured it and saw it resolve in 6 s, so it is load-dependent rather
 * than deterministic). It is not an adapter contract question and this script does not treat
 * the timeout as a failure: the save completes server-side regardless, and the status read
 * afterwards is what says so — the same read the contract's conditional save is built on.
 *
 * ## Running it
 *
 *   node --experimental-strip-types scripts/validate-unchanged-against-designer.mjs
 *
 * Point `FGC_MCP_URL` at the designer if it is not on the default port.
 */
const URL_ = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
let sessionId = null;
async function rpc(method, params) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }) });
  const a = r.headers.get("mcp-session-id"); if (a) sessionId = a;
  const t = await r.text();
  const p = t.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5).trim()));
  return p.length === 1 ? p[0] : p;
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "issue92", version: "0" } });
// The `initialized` notification, sent the way the sibling validation script sends it: a
// streamable-HTTP session is not fully open until the client acknowledges `initialize`.
await fetch(URL_, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

// Relative, like the sibling script, so the run is reproducible from any checkout rather
// than from one machine's worktree path.
const { createDesignerSyncPort } = await import("../src/designer-transport.ts");
const { executeCellSync, executeCellSyncTargets } = await import("../src/executor.ts");
const { planCellSync, planSetCellsDispatch } = await import("../src/sync-plan.ts");
const { CELL_ARTIFACT_BANNER } = await import("@forguncy-react-workspace/cell-compiler");
const { EXTENSION_EXTERNAL_MAPPINGS, createCellRegistry } = await import("@forguncy-react-workspace/core");

const MAPPING = EXTENSION_EXTERNAL_MAPPINGS.find(r => r.libraryId === "tanstack-query") ?? EXTENSION_EXTERNAL_MAPPINGS[0];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = `fgc-issue92-${RUN_ID}`;
const raw = createDesignerSyncPort({ callTool });

async function designer(script, mode = "safeWriteAuto") {
  const r = await callTool("execute_code", { title: "probe", code: `const __r=async()=>{ ${script} };\nreturn await __r();`, permissionMode: mode });
  if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
  const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` - ${detail}`}`); };

await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 20, columnCount: 10 });
  return { created: ${JSON.stringify(PAGE)} };
`);

const artifact = {
  code: `${CELL_ARTIFACT_BANNER}\nfunction App(props) {\n  var T = globalThis[${JSON.stringify(MAPPING.globalName)}];\n  return React.createElement("div", { "data-issue92": "1" }, "ok " + (typeof T) + " @" + props.cell);\n}\n`,
  frontendLibraries: [{ libraryId: MAPPING.libraryId }],
};
const decisions = [{ strategy: "extension", packageName: MAPPING.packageName, libraryId: MAPPING.libraryId, globalName: MAPPING.globalName }];

// The port under test: the real designer through the shipped adapter, with no correction.
//
// The previous version of this file overrode `readCellSource` and `generatePageAsync` here,
// because the shipped adapter could not reach the unchanged path on this build. #115 fixed both
// in `designer-transport.ts`, so the only wrapper left is one that *observes*: the write request
// is captured so a check can compare the persisted code against what crossed the port, and the
// second sync's dispatch is captured so "it issued no write" is asserted from the calls the
// adapter actually made. No method's answer is altered — `setCells` forwards and returns the
// adapter's result, so a rejected write still rejects.
const writes = [];
const port = {
  ...raw,
  setCells: async request => {
    writes.push(request);
    return raw.setCells(request);
  },
};

// --- Precondition: write A1 through the port ----------------------------------------
const listings = await raw.listFrontendLibraries({});
const target = { pageName: PAGE, cell: "A1" };
const plan0 = planCellSync({ target, artifact, decisions, deployed: { kind: "read", code: "" }, listings });
const d0 = planSetCellsDispatch(plan0);
if (d0.kind !== "issue") { console.log("SETUP FAILED: dispatch held", d0); process.exit(1); }
await port.setCells(d0.request);
console.log("### precondition: wrote A1 through the port");
const saveStatus = await raw.getProjectSaveStatus({});
console.log("### save status after the write:", JSON.stringify(saveStatus));
if (saveStatus.containsUnsavedChanges) {
  // The save completes server-side even when the tool budget expires, so the project is
  // persisted either way; the status read afterwards is what says so.
  try { await raw.saveProject(); console.log("### saveProject resolved"); }
  catch (e) { console.log("### saveProject exceeded the tool budget (known environment limit):", e.message.slice(0, 80)); }
  console.log("### save status afterwards:", JSON.stringify(await raw.getProjectSaveStatus({})));
}

console.log("\n### 1. the second sync of the same artifact (#92)");
const writesBeforeSecond = writes.length;
const second = await executeCellSync({ target, artifact, decisions, port });
console.log(JSON.stringify({ status: second.status, steps: second.steps.map(s => `${s.order}.${s.stepId}=${s.status}`), runtime: second.status === "unchanged" ? second.runtime : undefined }, null, 2));
// Observed off the port, which is #92's own acceptance criterion stated the strong way: the
// step status says the flow chose not to write, and this says no `setCells` reached the
// adapter. The two are different claims and #113's review was about one being read as the other.
check("no setCells reached the adapter on the second sync", writes.length === writesBeforeSecond, `${writes.length - writesBeforeSecond} write(s)`);
check("the second sync reports `unchanged`, not `refused`", second.status === "unchanged", second.status);
// `skipped`, not `not-reached`: the flow chose not to write rather than stopping before the
// write, and the step vocabulary exists to keep those two readings apart.
check("the second sync issues no write", second.steps.find(s => s.stepId === "write-cell-source")?.status === "skipped");
check("the second sync still checked the project's errors", second.steps.find(s => s.stepId === "check-project-errors")?.status === "ran");
check("the second sync generated the page", second.steps.find(s => s.stepId === "generate-page")?.status === "ran");
check("the second sync returned a locator naming this page", second.status === "unchanged" && second.runtime.pageUrl.includes(encodeURIComponent(PAGE)), second.status === "unchanged" ? second.runtime.pageUrl : second.status);

console.log("\n### 2. a hand-written Cell is refused, for a different reason (#92)");
// The write half of #19's promise, through the shipped adapter: what the adapter dispatched
// must be what the product persisted, byte for byte. #20's script checks this against
// *dispatched* rather than against another read of the same Cell, which would be tautological —
// the same rule applies here, and this is the adapter-level counterpart rather than a re-run.
const dispatched = writes[0]?.cells?.[0]?.cellTypeProps?.code;
const persisted = await designer(`
  const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "A1" });
  const c = g.cells[0];
  return { cellType: c?.cellType, code: typeof c?.cellTypeProps?.code === "string" ? c.cellTypeProps.code : null };
`, "readAuto");
check(
  "the product read the written Cell back as a ReactCellType the adapter recognises",
  persisted.cellType === "ReactCellType",
  String(persisted.cellType),
);
check(
  "the persisted code is byte-identical to what the adapter dispatched",
  typeof dispatched === "string" && dispatched.length > 0 && persisted.code === dispatched,
  `dispatched ${typeof dispatched === "string" ? dispatched.length : "?"} bytes, persisted ${typeof persisted.code === "string" ? persisted.code.length : "?"} bytes`,
);
await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{ cell: "B1", cellType: "ReactCellTypeCellType", cellTypeProps: { code: "function App() { return null; } // by hand\\n", frontendLibraries: [] } }] });
  return true;
`);
const foreign = await executeCellSync({ target: { pageName: PAGE, cell: "B1" }, artifact, decisions, port });
console.log(JSON.stringify({ status: foreign.status, reason: foreign.status === "refused" ? foreign.dispatch.reason : undefined, divergence: foreign.plan.divergence.kind }, null, 2));
check("a hand-written Cell is refused", foreign.status === "refused", foreign.status);
check("the refusal's reason is gate-refused, not the skip's", foreign.status === "refused" && foreign.dispatch.reason === "gate-refused");
check("the two outcomes carry different statuses", second.status !== foreign.status);
check("a refusal carries no locator", foreign.status === "refused" && !("runtime" in foreign));

console.log("\n### 3. a batch, through the registry, on the unchanged path (#92)");
// Section 2's raw designer write left the project dirty, and this project's `saveProject`
// cannot answer inside execute_code's 60 s budget. The save still completes server-side, so
// settle the project here — otherwise the batch's own save would abort the run on the
// environment's limit rather than on anything the executor did.
if ((await raw.getProjectSaveStatus({})).containsUnsavedChanges) {
  try { await raw.saveProject(); } catch { /* completes server-side; see the status below */ }
  console.log("### settled the project before the batch:", JSON.stringify(await raw.getProjectSaveStatus({})));
}
const registry = createCellRegistry({
  runtime: { forguncyVersion: "12.0.100", projectAlias: "issue92" },
  cells: { probeA: { entry: "cells/probeA/App.tsx", target: { pageName: PAGE, cell: "A1" } } },
}, { root: process.cwd(), requireEntryFiles: false });
const batch = await executeCellSyncTargets(registry, [{ cellId: "probeA", artifact, decisions, port }]);
check("the batch reports the unchanged status for an already-synced Cell", batch[0].status === "unchanged", batch[0].status);

const failed = checks.filter(c => !c.ok);
console.log("\n### RESULT");
console.log(JSON.stringify({ page: PAGE, passed: checks.length - failed.length, total: checks.length, failed: failed.map(f => f.name) }, null, 2));
if (failed.length) process.exitCode = 1;
