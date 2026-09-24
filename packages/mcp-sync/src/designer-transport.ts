/**
 * `ForguncySyncPort` over the Forguncy MCP designer surface.
 *
 * Decision sources: GitHub Issue #20 —
 * "Implement: MCP sync for generated Cell code and extension references"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/20), implementing the
 * flow #19 specifies (https://github.com/Mang-X/forguncy-react-workspace/issues/19).
 *
 * ## Why the transport is a separate module with an injected caller
 *
 * The port interface is deliberately transport-free, so that the contract and the
 * executor are testable without a Forguncy install. This module is the other half: it
 * knows the *wire shape* — that a designer operation is reached by sending JavaScript
 * to `execute_code` and reading a JSON result back — and that shape is what #20's
 * evidence is about. Keeping it behind an injected {@link DesignerCallTool} means two
 * things at once:
 *
 * - the mapping below (which the evidence measured) is unit-testable against a fake
 *   caller, so a regression in it fails a test instead of a deployment;
 * - the connection — which MCP session, which URL, which retry — stays the caller's,
 *   which is what keeps this module from becoming a second MCP client.
 *
 * ## The three mappings that are the platform's, not this contract's
 *
 * Everything here exists because the product's shape and the contract's shape differ in
 * a way #20 *measured* rather than assumed:
 *
 * 1. **Code has to be embedded in a script, not passed as a value.** The designer is
 *    reached by executing JavaScript, so a request's `code` — which is arbitrary
 *    generated source — cannot be string-interpolated into it. It is passed as
 *    `JSON.stringify`'d data instead, which is why every request below is a script
 *    whose first line defines the payload. A `readCellCode`-style API does not exist
 *    over MCP; `execute_code` is the whole surface.
 * 2. **A read reports three states, and the contract has three states that are not the
 *    same three.** The product omits a blank Cell from `cells` entirely, reports an
 *    occupied one with a `value`/`cellType` and no `cellTypeProps.code`, and omits an
 *    empty `frontendLibraries` rather than returning `[]`. {@link readCellSource} maps
 *    all three; getting any of them wrong is silent in a different direction.
 * 3. **`saved` is set only by `saveProject`.** The status call reports dirtiness; the
 *    save call reports whether the save happened. So the two are separate methods here
 *    rather than one "save" that checks and saves.
 *
 * ## What this module does not claim
 *
 * That these calls work on any Forguncy version other than the one #20 measured
 * (12.0.100.0). The evidence is a real session's, and a different version is a
 * re-probe rather than an assumption — see `capability-surface.ts`'s
 * `issue-20-designer-execution` source for exactly what was and was not established.
 */

import { EXTENSION_LIBRARY_REFERENCE_FIELD_NAME } from "@forguncy-react-workspace/core";
import type { ExtensionLibraryListing } from "@forguncy-react-workspace/core";

import type {
  ForguncySyncPort,
  GeneratedPage,
  IssuedSetCellsRequest,
  ListFrontendLibrariesRequest,
  ListFrontendLibrariesResult,
  ProjectErrorReport,
  ProjectSaveResult,
  ProjectSaveStatus,
  ProjectSaveStatusRequest,
  ReadCellSourceRequest,
  ReadCellSourceResult,
  SetCellsRequest,
} from "./port.ts";

/**
 * The one MCP tool the designer is driven through.
 *
 * Pinned as a literal because it is the whole surface: every operation below is a
 * script sent to this tool, and a module that accepted a different tool name would
 * suggest the product has other entry points. #20's evidence records this as the call
 * #5 and #13 both used.
 */
export const DESIGNER_EXECUTE_TOOL = "execute_code";

/**
 * How a designer operation is invoked.
 *
 * The injected seam. A caller supplies whichever MCP client it holds, and the shape is
 * the **JSON-RPC envelope** MCP `tools/call` answers with — `{ result: { content, isError } }`
 * — not the inner result. That distinction is load-bearing and was measured: a client
 * that hands back the inner `{ content }` object and one that hands back the envelope are
 * both plausible, and reading the wrong one produces an empty text block, which the parse
 * below rejects with a confusing message rather than a wrong answer. {@link resultOf}
 * accepts either so a caller is not required to unwrap, but the documented contract is the
 * envelope because that is what MCP actually returns.
 */
export type DesignerCallTool = (
  name: string,
  args: { readonly title: string; readonly code: string; readonly permissionMode: DesignerPermissionMode },
) => Promise<unknown>;

/**
 * The permission mode an operation needs.
 *
 * The product gates its own API by mode (`readAuto`, `safeWriteAuto`, `fullAuto`), and
 * a sync's operations divide cleanly: reading a Cell, the listing and the save status
 * are reads; the write, the save, the error check and generation touch project state.
 * Declaring the mode per operation is what keeps a read from asking for write
 * permission — a small thing that matters because the mode is what the *product* uses
 * to decide whether to run the script at all.
 */
export type DesignerPermissionMode = "readAuto" | "safeWriteAuto" | "fullAuto";

export interface DesignerSyncPortOptions {
  readonly callTool: DesignerCallTool;
}

/**
 * The script that reaches one designer operation.
 *
 * `payload` is embedded with `JSON.stringify`, not interpolated: the values include
 * generated source and a page name, and a script built by string concatenation would
 * break on the first quote in either. Everything else about the script is fixed.
 */
function scriptFor(payload: Record<string, unknown>, body: string): string {
  const bindings = Object.entries(payload)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join("\n");
  return `${bindings}\n${body}`;
}

/**
 * Read the JSON result out of an MCP `tools/call` response.
 *
 * The product answers `execute_code` with a text content block carrying a JSON document,
 * and a configured error arrives as `isError: true` with the message in the same place.
 * Both are read here and turned into a throw, because that is what the port contract says
 * a failed call is: a rejected promise, not a diagnostic (see `step-outcomes.ts`). This is
 * also why the parse is strict — a response that is not the documented shape is a
 * transport problem, and guessing at it would hide a real one.
 *
 * Accepts both the JSON-RPC envelope (`{ result: { content } }`, what MCP returns) and the
 * bare tool result (`{ content }`, what a client that unwrapped for the caller hands back),
 * because a caller should not have to know which its client does. It does *not* accept a
 * missing `content`: an empty text block is how reading the wrong layer presents itself,
 * and reporting that as a parse failure is more useful than reporting it as success.
 */
function resultOf(response: unknown, operation: string): Record<string, unknown> {
  if (typeof response !== "object" || response === null) {
    throw new Error(`The designer returned no response for ${operation}.`);
  }
  const envelope = response as Record<string, unknown>;
  const inner = envelope.result;
  const record =
    typeof inner === "object" && inner !== null && "content" in (inner as Record<string, unknown>)
      ? (inner as Record<string, unknown>)
      : envelope;

  if (record.isError === true) {
    throw new Error(`The designer refused ${operation}: ${textOf(record)}`);
  }
  const text = textOf(record);
  if (text.trim().length === 0) {
    throw new Error(
      `The designer's answer to ${operation} carried no text. An MCP \`tools/call\` result has a \`content\` array; a response without one was read at the wrong layer.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The designer's answer to ${operation} was not JSON (${error instanceof Error ? error.message : String(error)}): ${text.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`The designer's answer to ${operation} was not an object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The concatenated text of an MCP result's content blocks. */
function textOf(record: Record<string, unknown>): string {
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (typeof block !== "object" || block === null) return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * The `result` field of an `execute_code` answer, or the whole document.
 *
 * The tool wraps its value in `{ status, result }`, and #20's execution confirms the
 * wrapper. A response without it is read as the value itself rather than refused: the
 * wrapper is the product's presentation, and a version that dropped it would still be
 * answering the same question.
 */
function valueOf(parsed: Record<string, unknown>, operation: string): Record<string, unknown> {
  const result = parsed.result;
  if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  if (parsed.status === "success") {
    throw new Error(`The designer's answer to ${operation} reported success with no result.`);
  }
  return parsed;
}

function arrayOf(value: unknown, operation: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`The designer's answer to ${operation} did not include the array it was asked for.`);
  }
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function stringField(record: Record<string, unknown>, field: string, operation: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`The designer's answer to ${operation} had no string \`${field}\`.`);
  }
  return value;
}

/**
 * The designer, as the sync flow's port.
 *
 * Every method below is one script and one parse. The scripts are fixed strings apart
 * from their embedded payload, because the *call* is the evidence: a script that
 * branched on its input would be a second, unmeasured path to the same operation.
 */
export function createDesignerSyncPort(options: DesignerSyncPortOptions): ForguncySyncPort {
  const { callTool } = options;

  return {
    // api.app.listFrontendLibraries
    async listFrontendLibraries(request: ListFrontendLibrariesRequest): Promise<ListFrontendLibrariesResult> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: list frontend libraries",
        code: scriptFor({ request }, "return await api.app.listFrontendLibraries(request);"),
        permissionMode: "readAuto",
      });
      const result = valueOf(resultOf(response, "listFrontendLibraries"), "listFrontendLibraries");
      const listed = Array.isArray(result) ? result : result.libraries;
      return arrayOf(listed, "listFrontendLibraries").map(entry => ({
        id: stringField(entry, "id", "listFrontendLibraries"),
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        globalName: stringField(entry, "globalName", "listFrontendLibraries"),
        ...(typeof entry.exists === "boolean" ? { exists: entry.exists } : {}),
        ...(typeof entry.typeDefinitionAvailable === "boolean"
          ? { typeDefinitionAvailable: entry.typeDefinitionAvailable }
          : {}),
      })) satisfies readonly ExtensionLibraryListing[];
    },

    // api.page.getCells
    async readCellSource(request: ReadCellSourceRequest): Promise<ReadCellSourceResult> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: read target cell",
        code: scriptFor(
          { pageName: request.pageName, cell: request.cell },
          "return await api.page.getCells({ pageName, range: cell });",
        ),
        permissionMode: "readAuto",
      });
      const result = valueOf(resultOf(response, "readCellSource"), "readCellSource");
      // Not `arrayOf`: an empty `cells` is the *answer* for a blank Cell, not a broken
      // response, and `arrayOf` would throw on the array being absent while the missing
      // case here is a missing Cell. Both are checked, and they are different errors.
      const cells = Array.isArray(result.cells) ? result.cells : undefined;
      if (cells === undefined) {
        throw new Error("The designer's answer to readCellSource did not include a `cells` array.");
      }
      if (cells.length === 0) {
        // #20 measured this: `getCells` returns only cells that have content, a type, a
        // name or a binding, so a fresh Cell is absent rather than empty.
        return { kind: "blank" };
      }
      const [cell] = cells as readonly Record<string, unknown>[];
      if (typeof cell !== "object" || cell === null) {
        throw new Error("The designer's answer to readCellSource held a cell that was not an object.");
      }
      return readOneCell(cell);
    },

    // api.page.setCells
    async setCells(request: IssuedSetCellsRequest): Promise<void> {
      const payload = mutationPayloadOf(request);
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: write target cell",
        code: scriptFor({ payload }, "return await api.page.setCells(payload);"),
        // The only mutating operation in the flow, and the only one that asks for write
        // permission. A read that requested it would be asking the product for authority
        // it does not need.
        permissionMode: "safeWriteAuto",
      });
      // The result is read rather than discarded so the *warnings* the product reports
      // are not silently dropped; a warning is not a failure, so it does not throw.
      resultOf(response, "setCells");
    },

    // api.app.getProjectSaveStatus
    async getProjectSaveStatus(request: ProjectSaveStatusRequest): Promise<ProjectSaveStatus> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: read project save status",
        code: scriptFor({ request }, "return await api.app.getProjectSaveStatus(request);"),
        permissionMode: "readAuto",
      });
      const result = valueOf(resultOf(response, "getProjectSaveStatus"), "getProjectSaveStatus");
      return { containsUnsavedChanges: result.containsUnsavedChanges === true };
    },

    // api.app.saveProject
    async saveProject(): Promise<ProjectSaveResult> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: save project",
        code: scriptFor({}, "return await api.app.saveProject({});"),
        permissionMode: "safeWriteAuto",
      });
      const result = valueOf(resultOf(response, "saveProject"), "saveProject");
      return { saved: result.saved === true };
    },

    // api.app.checkProjectErrors
    async checkProjectErrors(): Promise<ProjectErrorReport> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: check project errors",
        code: scriptFor({}, "return await api.app.checkProjectErrors({});"),
        permissionMode: "readAuto",
      });
      const result = valueOf(resultOf(response, "checkProjectErrors"), "checkProjectErrors");
      // `errorCount` is the field #5 recorded and #19's gate reads. A response without it
      // is refused rather than defaulted to zero: defaulting would turn "the product did
      // not answer" into "the project is clean", which is the one direction that must not
      // fail open — the sync would report success on an unchecked project.
      const errorCount = result.errorCount;
      if (typeof errorCount !== "number") {
        throw new Error(
          "`api.app.checkProjectErrors` answered without a numeric `errorCount`, so the sync cannot tell a clean project from an unchecked one.",
        );
      }
      return { errorCount };
    },

    // api.app.generatePageAsync
    async generatePageAsync(request): Promise<GeneratedPage> {
      const response = await callTool(DESIGNER_EXECUTE_TOOL, {
        title: "sync: generate page",
        code: scriptFor({ request }, "return await api.app.generatePageAsync({});"),
        permissionMode: "safeWriteAuto",
      });
      const result = valueOf(resultOf(response, "generatePageAsync"), "generatePageAsync");
      // `skipCheckProjectError` is deliberately not sent: the executor calls
      // `checkProjectErrors` itself and gates on it, so asking the product to skip its own
      // check would let generation proceed past a project the sync already failed on.
      const url = typeof result.url === "string" ? result.url : "";
      return { pageName: request.pageName, pageUrl: url };
    },
  };
}

/**
 * The `api.page.setCells` payload for an issued request.
 *
 * Key order is fixed and the library list is already canonical, so two syncs of the same
 * artifact send byte-identical scripts — which is the first half of #19's idempotency
 * requirement and the reason this is a named function rather than an inline object: the
 * order is a property of the transport, and a reviewer has to be able to see it.
 *
 * `rowSpan`/`colSpan` are deliberately absent, as the contract says; #20 measured that
 * omitting them *preserves* a merged Cell's geometry rather than resetting it.
 */
function mutationPayloadOf(request: IssuedSetCellsRequest): SetCellsRequest {
  return {
    pageName: request.pageName,
    cells: request.cells.map(cell => ({
      cell: cell.cell,
      cellType: cell.cellType,
      cellTypeProps: {
        code: cell.cellTypeProps.code,
        frontendLibraries: cell.cellTypeProps.frontendLibraries.map(library => ({
          libraryId: library.libraryId,
        })),
      },
    })),
  };
}

/**
 * One Cell from a `getCells` response, as the contract's read result.
 *
 * The three-way split #20 measured. The order of the checks is the safety property: a
 * Cell is a managed React Cell only when it *has* a `code`, and everything else — a plain
 * value, another cell type, a name — is occupied. Testing for `occupied` first and
 * falling back to `react-cell` would be the same thing here, but the reverse fallback
 * (`code` absent ⇒ treat as empty) is the one that overwrites designer work, so the
 * branch that could make that mistake does not exist.
 */
function readOneCell(cell: Record<string, unknown>): ReadCellSourceResult {
  const props = cell.cellTypeProps;
  const propsRecord = typeof props === "object" && props !== null ? (props as Record<string, unknown>) : undefined;
  const code = propsRecord?.code;

  if (typeof code !== "string") {
    // Not a managed React Cell. Say what it does hold, so the conflict is actionable
    // rather than a generic "not ours".
    return { kind: "occupied", code: describeOccupant(cell) };
  }

  return {
    kind: "react-cell",
    code,
    // The product drops the field for an empty list, so "absent" here means "empty" to
    // the contract — `DeployedCellState`'s optional field is for "not stated", which this
    // call always states, because it read the Cell.
    frontendLibraries: libraryReferencesOf(propsRecord?.frontendLibraries),
  };
}

function describeOccupant(cell: Record<string, unknown>): string {
  if (typeof cell.cellType === "string") return `a ${cell.cellType} cell`;
  if (cell.value !== undefined) {
    return typeof cell.value === "string" ? `the value ${JSON.stringify(cell.value)}` : "a non-text value";
  }
  if (cell.formula !== undefined) return "a formula";
  if (cell.name !== undefined) return "a named cell";
  return "content this flow did not write";
}

function libraryReferencesOf(value: unknown): readonly { readonly libraryId: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => {
      if (typeof entry !== "object" || entry === null) return undefined;
      const libraryId = (entry as Record<string, unknown>)[EXTENSION_LIBRARY_REFERENCE_FIELD_NAME];
      return typeof libraryId === "string" ? { libraryId } : undefined;
    })
    .filter((entry): entry is { readonly libraryId: string } => entry !== undefined);
}
