/**
 * The designer transport, against a fake caller.
 *
 * What this file can establish: that the module sends the script it says it sends, asks
 * for the permission mode it declares, and maps the product's three response shapes onto
 * the contract's three read states correctly. What it cannot: that a real designer accepts
 * any of it. #20's real-session validation is recorded on the Issue; this is its local
 * counterpart, and AGENTS.md rule 7 keeps the two apart.
 *
 * The fake caller is a *recorder*, and the assertions are mostly about the script text it
 * was handed. That is deliberate: the script is the wire shape, and the failure this
 * guards against is a payload that reads correctly in TypeScript and arrives at the
 * designer mangled — a generated source string interpolated into a script rather than
 * embedded as data, or a `frontendLibraries` entry keyed by something other than
 * `libraryId`.
 */

import { describe, expect, it } from "vitest";

import { createDesignerSyncPort, DESIGNER_EXECUTE_TOOL, runtimePageUrl } from "./designer-transport.ts";
import type { DesignerCallTool, DesignerPermissionMode } from "./designer-transport.ts";
import { issueSetCellsRequest } from "./port.ts";
import type { ReadCellSourceResult } from "./port.ts";

/** A code string chosen to break naive interpolation: quotes, backslashes, newlines. */
const AWKWARD_CODE =
  '/* Generated */\nvar s = "it\'s \\"fine\\"";\nfunction App() { return null; }\n';

interface Recorded {
  readonly name: string;
  readonly code: string;
  readonly permissionMode: DesignerPermissionMode;
}

/**
 * A caller that records, and answers with whatever the test set.
 *
 * `answer` receives the script so a test can assert on it and still return a canned
 * response — the two are usually about the same call.
 */
function recorder(answer: (script: string) => unknown): { callTool: DesignerCallTool; calls: readonly Recorded[] } {
  const calls: Recorded[] = [];
  const callTool: DesignerCallTool = async (name, args) => {
    calls.push({ name, code: args.code, permissionMode: args.permissionMode });
    return answer(args.code);
  };
  return { callTool, calls };
}

/**
 * The product's answer envelope, as MCP actually returns it.
 *
 * Wrapped in the JSON-RPC `result` on purpose: the first version of this fake returned the
 * bare `{ content }` object, and the real designer returned `{ result: { content } }` — so
 * the unit tests passed while the validation failed. The fake now matches the wire, which
 * is the whole reason a transport test is worth writing.
 */
function ok(value: unknown): unknown {
  return {
    result: { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "success", result: value }) }] },
  };
}

describe("the designer transport", () => {
  it("drives every operation through the one execute tool, as a script", async () => {
    const { callTool, calls } = recorder(() => ok([]));
    const port = createDesignerSyncPort({ callTool });

    await port.listFrontendLibraries({});

    expect(calls.map(call => call.name)).toEqual([DESIGNER_EXECUTE_TOOL]);
    expect(calls[0].code).toContain("api.app.listFrontendLibraries");
  });

  // The failure this pins: a generated source string with quotes and backslashes is
  // *data*, and a script built by interpolation would either break or, worse, run.
  it("embeds code as data, surviving quotes, backslashes and newlines", async () => {
    const { callTool, calls } = recorder(() => ok({}));
    const port = createDesignerSyncPort({ callTool });

    await port.setCells(
      issueSetCellsRequest({
        pageName: "OrderPage",
        cells: [
          {
            cell: "A1",
            cellType: "ReactCellTypeCellType",
            cellTypeProps: { code: AWKWARD_CODE, frontendLibraries: [] },
          },
        ],
      }),
    );

    const script = calls[0].code;
    // The code travels as a JSON string literal, so the awkward characters are escaped
    // and cannot terminate the literal or start a new statement.
    expect(script).toContain(JSON.stringify(AWKWARD_CODE));
    // And it is not present verbatim, which is what interpolation would have produced.
    expect(script).not.toContain(AWKWARD_CODE);
  });

  it("keys library references by `libraryId` and nothing else", async () => {
    const { callTool, calls } = recorder(() => ok({}));
    const port = createDesignerSyncPort({ callTool });

    await port.setCells(
      issueSetCellsRequest({
        pageName: "OrderPage",
        cells: [
          {
            cell: "A1",
            cellType: "ReactCellTypeCellType",
            cellTypeProps: {
              code: "x",
              // Canonical order, which is what the *plan* produces (see `sync-plan.ts`).
              // The transport preserves the order it is handed and does not reorder, which
              // is why that guarantee lives in one place rather than two.
              frontendLibraries: [{ libraryId: "es-toolkit" }, { libraryId: "tanstack-query" }],
            },
          },
        ],
      }),
    );

    const script = calls[0].code;
    expect(script).toContain('"libraryId":"es-toolkit"');
    expect(script).toContain('"libraryId":"tanstack-query"');
    // No display name, no file name — #12's rule, at the wire.
    expect(script).not.toContain("TanStack Query");
    expect(script).not.toContain("bundle.js");
  });

  it("sends no cell geometry, so a merged Cell keeps it", async () => {
    const { callTool, calls } = recorder(() => ok({}));
    const port = createDesignerSyncPort({ callTool });

    await port.setCells(
      issueSetCellsRequest({
        pageName: "OrderPage",
        cells: [{ cell: "A1", cellType: "ReactCellTypeCellType", cellTypeProps: { code: "x", frontendLibraries: [] } }],
      }),
    );

    // #20 measured that omitting these preserves geometry; sending a default would reset it.
    expect(calls[0].code).not.toContain("rowSpan");
    expect(calls[0].code).not.toContain("colSpan");
  });

  it("asks for write permission only where it mutates", async () => {
    const { callTool, calls } = recorder(script => {
      if (script.includes("getCells")) return ok({ cells: [] });
      if (script.includes("listFrontendLibraries")) return ok([]);
      if (script.includes("checkProjectErrors")) return ok({ errorCount: 0 });
      if (script.includes("getProjectSaveStatus")) return ok({ containsUnsavedChanges: false });
      return ok({});
    });
    const port = createDesignerSyncPort({ callTool });

    await port.listFrontendLibraries({});
    await port.readCellSource({ pageName: "P", cell: "A1" });
    await port.getProjectSaveStatus({});
    await port.checkProjectErrors();
    const reads = calls.map(call => call.permissionMode);

    await port.setCells(
      issueSetCellsRequest({
        pageName: "P",
        cells: [{ cell: "A1", cellType: "ReactCellTypeCellType", cellTypeProps: { code: "x", frontendLibraries: [] } }],
      }),
    );

    expect(reads).toEqual(["readAuto", "readAuto", "readAuto", "readAuto"]);
    // checkProjectErrors is a read; the write is not. A read that asked for write authority
    // would be asking the product for more than it needs.
    expect(calls.at(-1)?.permissionMode).toBe("safeWriteAuto");
  });
});

// ---------------------------------------------------------------------------
// The read mapping — where the product's three states meet the contract's
// ---------------------------------------------------------------------------

describe("mapping a read", () => {
  async function readWith(cellsValue: unknown): Promise<ReadCellSourceResult> {
    const { callTool } = recorder(() => ok({ pageName: "P", cells: cellsValue }));
    const port = createDesignerSyncPort({ callTool });
    return port.readCellSource({ pageName: "P", cell: "A1" });
  }

  it("reads an absent cell as blank, not as a broken answer", async () => {
    // #20 measured this: `getCells` omits a fresh Cell entirely.
    expect(await readWith([])).toEqual({ kind: "blank" });
  });

  it("reads a value-only cell as occupied, naming what it holds", async () => {
    const result = await readWith([{ row: 0, col: 0, value: "b20" }]);

    expect(result.kind).toBe("occupied");
    if (result.kind !== "occupied") return;
    expect(result.code).toContain("b20");
  });

  it("reads another cell type as occupied", async () => {
    const result = await readWith([{ row: 0, col: 0, cellType: "TextCellType" }]);

    expect(result).toEqual({ kind: "occupied", code: "a TextCellType cell" });
  });

  // The reviewer's fourth finding. `react-cell` claims "this Cell *is* a managed
  // ReactCellType", and inferring that from the presence of a `code` property would claim it
  // from a weaker fact. These cases all have a `code` and are still not ours.
  it("reads a non-React cell type that carries a code as occupied, not as ours", async () => {
    for (const cellType of ["UserControlPageCellType", "SomeOtherCellType", "TextCellType"]) {
      const result = await readWith([{ row: 0, col: 0, cellType, cellTypeProps: { code: "function App(){}" } }]);

      expect(result.kind, cellType).toBe("occupied");
      if (result.kind !== "occupied") continue;
      expect(result.code).toContain(cellType);
    }
  });

  // The dangerous variant of the same: a foreign cell whose `code` is *empty* would become a
  // managed React Cell with empty source, classify `vacant`, and be overwritten.
  it("reads a foreign cell with an empty code as occupied, never as a vacant React Cell", async () => {
    const result = await readWith([
      { row: 0, col: 0, cellType: "UserControlPageCellType", cellTypeProps: { code: "" } },
    ]);

    expect(result.kind).toBe("occupied");
    expect(result).not.toEqual({ kind: "react-cell", code: "", frontendLibraries: [] });
  });

  // The other direction, so the stricter check is not simply stricter: the exact type with a
  // code is still read as ours.
  it("reads the exact React Cell type as a managed React Cell", async () => {
    const result = await readWith([
      { row: 0, col: 0, cellType: "ReactCellTypeCellType", cellTypeProps: { code: "x" } },
    ]);

    expect(result.kind).toBe("react-cell");
  });

  it("says a React-typed Cell with no readable code is damage, not a designer edit", async () => {
    const result = await readWith([{ row: 0, col: 0, cellType: "ReactCellTypeCellType", cellTypeProps: {} }]);

    expect(result).toEqual({ kind: "occupied", code: "a ReactCellType cell with no readable code" });
  });

  // The direction that must not happen: mapping an occupied Cell onto an empty read.
  it("never reads an occupied cell as an empty React cell", async () => {
    for (const occupant of [{ value: 1 }, { value: "x" }, { formula: "=A2" }, { name: "total" }]) {
      const result = await readWith([{ row: 0, col: 0, ...occupant }]);
      expect(result.kind, JSON.stringify(occupant)).toBe("occupied");
      expect(result).not.toEqual({ kind: "react-cell", code: "", frontendLibraries: [] });
    }
  });

  it("reads a React cell's code and references", async () => {
    const result = await readWith([
      {
        row: 0,
        col: 0,
        cellType: "ReactCellTypeCellType",
        cellTypeProps: { code: AWKWARD_CODE, frontendLibraries: [{ libraryId: "es-toolkit" }] },
      },
    ]);

    expect(result).toEqual({
      kind: "react-cell",
      code: AWKWARD_CODE,
      frontendLibraries: [{ libraryId: "es-toolkit" }],
    });
  });

  // The product drops the field when the list is empty, so absence means empty here —
  // and the contract's "not stated" cannot be produced by this call, which read the Cell.
  it("reads a dropped reference list as an empty one", async () => {
    const result = await readWith([
      { row: 0, col: 0, cellType: "ReactCellTypeCellType", cellTypeProps: { code: "x" } },
    ]);

    expect(result).toEqual({ kind: "react-cell", code: "x", frontendLibraries: [] });
  });

  it("refuses an answer with no cells array rather than guessing", async () => {
    const { callTool } = recorder(() => ok({ pageName: "P" }));
    const port = createDesignerSyncPort({ callTool });

    await expect(port.readCellSource({ pageName: "P", cell: "A1" })).rejects.toThrow(/`cells` array/);
  });
});

// ---------------------------------------------------------------------------
// The gates that must not fail open
// ---------------------------------------------------------------------------

describe("reading results that must not be guessed", () => {
  it("refuses an error count that is absent rather than defaulting to zero", async () => {
    // The one direction that must not fail open: defaulting would report an unchecked
    // project as clean, and the sync would call that success.
    const { callTool } = recorder(() => ok({ hasError: false, message: "工程检查完成。" }));
    const port = createDesignerSyncPort({ callTool });

    await expect(port.checkProjectErrors()).rejects.toThrow(/numeric `errorCount`/);
  });

  it("reports a save only when the product says it saved", async () => {
    const saved = recorder(() => ok({ saved: true, containsUnsavedChanges: false }));
    expect(await createDesignerSyncPort({ callTool: saved.callTool }).saveProject()).toEqual({ saved: true });

    const declined = recorder(() => ok({ containsUnsavedChanges: true }));
    expect(await createDesignerSyncPort({ callTool: declined.callTool }).saveProject()).toEqual({ saved: false });
  });

  it("reports dirtiness only when the product says so", async () => {
    const dirty = recorder(() => ok({ containsUnsavedChanges: true }));
    expect(await createDesignerSyncPort({ callTool: dirty.callTool }).getProjectSaveStatus({})).toEqual({
      containsUnsavedChanges: true,
    });

    const clean = recorder(() => ok({ currentFilePath: "x", canSave: true, containsUnsavedChanges: false }));
    expect(await createDesignerSyncPort({ callTool: clean.callTool }).getProjectSaveStatus({})).toEqual({
      containsUnsavedChanges: false,
    });
  });

  // The fail-open the review caught: `containsUnsavedChanges === true` turns a missing or
  // renamed field into "the project is clean", the executor then skips `saveProject`, and a
  // mutation that was never persisted is reported as a successful sync. The product's own
  // response set cannot be distinguished from a truncated one by shape alone, so absence has
  // to be refused rather than interpreted.
  it("refuses a save status without a boolean rather than reading it as clean", async () => {
    // Exactly the shape #5's evidence shows for the *status* call: no `saved` field at all,
    // and — in this case — no dirtiness field either.
    const missing = recorder(() => ok({ currentFilePath: "x", canSave: true, message: "ok" }));
    await expect(createDesignerSyncPort({ callTool: missing.callTool }).getProjectSaveStatus({})).rejects.toThrow(
      /boolean `containsUnsavedChanges`/,
    );

    // A field of the wrong type is the same failure: not a boolean is not an answer.
    const wrongType = recorder(() => ok({ containsUnsavedChanges: "true" }));
    await expect(createDesignerSyncPort({ callTool: wrongType.callTool }).getProjectSaveStatus({})).rejects.toThrow(
      /boolean `containsUnsavedChanges`/,
    );
  });

  it("reports a generation with no url as an empty locator, for the gate to catch", async () => {
    const { callTool } = recorder(() => ok({ success: false, url: "", message: "no" }));
    const port = createDesignerSyncPort({ callTool });

    expect(await port.generatePageAsync({ pageName: "P" })).toEqual({ pageName: "P", pageUrl: "" });
  });
});

// ---------------------------------------------------------------------------
// The runtime locator
// ---------------------------------------------------------------------------

/**
 * The response shape these tests use is the one #20 measured, not a convenient one.
 *
 * The previous version of this file stubbed `url` as `http://localhost:63982/Forguncy/OrderPage`
 * — already assembled — so the mapping from the product's answer to a page URL was never
 * exercised, and a real run returned the runtime *base* instead of the page. A stub that
 * only has the shape the code wants cannot find that class of bug.
 */
describe("turning the generation answer into a page locator", () => {
  const BASE = "http://localhost:63982/Forguncy";

  async function generateFor(pageName: string): Promise<string> {
    // Exactly what the product answers: `url` is the base, page argument or not.
    const { callTool } = recorder(() => ok({ success: true, url: BASE, message: "ok" }));
    const port = createDesignerSyncPort({ callTool });
    return (await port.generatePageAsync({ pageName })).pageUrl;
  }

  it("names the page the product's own answer leaves out", async () => {
    // The measured behaviour: `generatePageAsync` ignores its page argument and answers with
    // the base. Returning that base would send a caller to the project's start page.
    expect(await generateFor("OrderPage")).toBe(`${BASE}/OrderPage`);
  });

  it("encodes a page name, so a space or a non-ASCII name stays one path segment", async () => {
    // #20 opened the encoded form of a Chinese page name in a browser and got the page.
    expect(await generateFor("Tanstack Query拓展包示例")).toBe(
      `${BASE}/Tanstack%20Query%E6%8B%93%E5%B1%95%E5%8C%85%E7%A4%BA%E4%BE%8B`,
    );
    // A `/` in a name must not become a path segment.
    expect(await generateFor("a/b")).toBe(`${BASE}/a%2Fb`);
  });

  it("does not double a trailing slash on the base", async () => {
    const { callTool } = recorder(() => ok({ url: `${BASE}/` }));
    const port = createDesignerSyncPort({ callTool });

    expect((await port.generatePageAsync({ pageName: "P" })).pageUrl).toBe(`${BASE}/P`);
  });

  // If a future product version honours the argument, its answer is more specific than this
  // mapping's guess and must win.
  it("leaves an answer that already names a page alone", async () => {
    const { callTool } = recorder(() => ok({ url: `${BASE}/OrderPage` }));
    const port = createDesignerSyncPort({ callTool });

    expect((await port.generatePageAsync({ pageName: "OrderPage" })).pageUrl).toBe(`${BASE}/OrderPage`);
  });

  it("maps a base with no url to the empty locator the gate refuses", async () => {
    const { callTool } = recorder(() => ok({ success: false, url: "" }));
    const port = createDesignerSyncPort({ callTool });

    // Empty stays empty: appending a page name to nothing would invent a locator, and the
    // generation gate is what reports the failure.
    expect((await port.generatePageAsync({ pageName: "P" })).pageUrl).toBe("");
  });

  it("is the pure mapping, asserted directly", () => {
    expect(runtimePageUrl(BASE, "OrderPage")).toBe(`${BASE}/OrderPage`);
    expect(runtimePageUrl(BASE, "")).toBe(BASE);
    expect(runtimePageUrl("", "OrderPage")).toBe("");
    expect(runtimePageUrl(`${BASE}/`, "OrderPage")).toBe(`${BASE}/OrderPage`);
    expect(runtimePageUrl(`${BASE}/OrderPage`, "OrderPage")).toBe(`${BASE}/OrderPage`);
  });
});

// ---------------------------------------------------------------------------
// Failures are thrown, not manufactured
// ---------------------------------------------------------------------------

describe("a refused or unreadable answer", () => {
  it("throws on the product's own error flag, keeping the message", async () => {
    const { callTool } = recorder(() => ({
      result: { isError: true, content: [{ type: "text", text: "Error: boom-inner" }] },
    }));
    const port = createDesignerSyncPort({ callTool });

    await expect(port.listFrontendLibraries({})).rejects.toThrow(/refused listFrontendLibraries.*boom-inner/);
  });

  it("throws when the answer is not JSON, rather than inventing a value", async () => {
    const { callTool } = recorder(() => ({
      result: { isError: false, content: [{ type: "text", text: "<html>" }] },
    }));
    const port = createDesignerSyncPort({ callTool });

    await expect(port.listFrontendLibraries({})).rejects.toThrow(/was not JSON/);
  });

  // The layer confusion this guard exists for: reading `response.content` off a JSON-RPC
  // envelope yields nothing, and reporting an empty answer as a parse error is more useful
  // than reporting it as a value.
  it("says so when the answer was read at the wrong layer", async () => {
    const { callTool } = recorder(() => ({ jsonrpc: "2.0", id: 1, result: { isError: false } }));
    const port = createDesignerSyncPort({ callTool });

    await expect(port.listFrontendLibraries({})).rejects.toThrow(/carried no text/);
  });

  // A caller whose client already unwrapped should not have to know it must not.
  it("accepts a bare tool result as well as the envelope", async () => {
    const { callTool } = recorder(() => ({
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ status: "success", result: [] }) }],
    }));
    const port = createDesignerSyncPort({ callTool });

    expect(await port.listFrontendLibraries({})).toEqual([]);
  });

  it("throws when a listing entry has no stable id", async () => {
    const { callTool } = recorder(() => ok([{ name: "TanStack Query", globalName: "TanStackQuery" }]));
    const port = createDesignerSyncPort({ callTool });

    // A display name is not an id (#12), so an entry without one is refused rather than
    // resolved by guessing which string was meant.
    await expect(port.listFrontendLibraries({})).rejects.toThrow(/no string `id`/);
  });

  it("keeps the listing's own fields, naming them as the product does", async () => {
    const { callTool } = recorder(() =>
      ok([
        {
          id: "tanstack-query",
          name: "TanStack Query",
          globalName: "TanStackQuery",
          exists: true,
          typeDefinitionAvailable: true,
          integrity: "sha256:…",
        },
      ]),
    );
    const port = createDesignerSyncPort({ callTool });

    expect(await port.listFrontendLibraries({})).toEqual([
      {
        id: "tanstack-query",
        name: "TanStack Query",
        globalName: "TanStackQuery",
        exists: true,
        typeDefinitionAvailable: true,
      },
    ]);
  });
});
