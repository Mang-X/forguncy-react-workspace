/**
 * The designer-operation surface a sync needs, and the reason some operations are
 * missing from it.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19).
 *
 * #19's "Required MCP flow" is written against *actual* capabilities and then
 * hedges each one with "or the exact supported equivalent", which makes the
 * question "which call do we actually make" part of the contract rather than an
 * implementation detail. This module is how that question is answered without
 * anyone having to remember it: the port declares one method per designer call the
 * flow needs, and a method exists here **only** when some evidence established the
 * call's name. See `capability-surface.ts` for the registry that pairs each method
 * with the evidence, and `capability-surface.test.ts` for the regression that makes
 * "the port has no more methods than the evidence supports" a failing test rather
 * than a convention.
 *
 * Two operations #19's flow needs are deliberately **absent**, because the evidence
 * does not establish a name for either — reading a cell's current source, and
 * saving the project. A port method named by guesswork is exactly the failure this
 * arrangement prevents: it would look like a verified call, ship, and fail only
 * against a real project. `unestablishedCapabilities()` reports them, and
 * `planCellSync` refuses the flow that needs them.
 *
 * ## What these types are, and are not
 *
 * They describe what the *sync flow* needs, not the raw designer payloads. Where
 * the evidence pins a field name the name is the platform's — `pageName`, `cell`,
 * `cellTypeProps.code`, `cellTypeProps.frontendLibraries[].libraryId`,
 * `errorCount` — because renaming a field the product returns would hide the one
 * fact a reader most needs to check. Where it does not, the name is this contract's
 * and the adapter owns the correspondence; each such field says so.
 *
 * There is deliberately no index signature on any of them: `[key: string]: unknown`
 * would let a misspelled field type-check, which is how a call shape silently
 * drifts away from the one that was measured (#27's review reached the same rule).
 */

import type { ExtensionLibraryListing, FrontendLibraryReference } from "@forguncy-react-workspace/core";

// ---------------------------------------------------------------------------
// api.app.listFrontendLibraries
// ---------------------------------------------------------------------------

/**
 * The argument shape `api.app.listFrontendLibraries` was called with.
 *
 * `Record<string, never>` rather than `{}`: every observed call passes an empty
 * object — `api.app.listFrontendLibraries({})` — and this type says precisely that,
 * so adding an option is a deliberate edit against new evidence instead of a field
 * that quietly compiles.
 */
export type ListFrontendLibrariesRequest = Record<string, never>;

/** What `api.app.listFrontendLibraries` answers. `core` owns this shape (#12). */
export type ListFrontendLibrariesResult = readonly ExtensionLibraryListing[];

// ---------------------------------------------------------------------------
// api.page.setCells
// ---------------------------------------------------------------------------

/**
 * The cell type every managed Cell is written as.
 *
 * A literal rather than a `string`, because sync resolves *React* Cells: writing
 * this payload onto another cell type would be a silent platform-level mistake, and
 * the value is fixed by evidence (the skill's `api.page.setCells` example and #5's
 * probe pages both write `ReactCellTypeCellType`).
 */
export type SetCellsCellType = "ReactCellTypeCellType";

/**
 * The `cellTypeProps` half of one Cell.
 *
 * Exactly the two fields #19 requires sync to write, and they are exactly the two
 * the evidence records: `code` (the generated source) and `frontendLibraries`
 * (canonicalized to `[{ libraryId }]` by #6/#12, never a display name).
 */
export interface SetCellsCellTypeProps {
  readonly code: string;
  readonly frontendLibraries: readonly FrontendLibraryReference[];
}

/**
 * One Cell in a `api.page.setCells` request.
 *
 * The field names are the platform's. `rowSpan` / `colSpan` are *not* here on
 * purpose: the documented example carries them, nothing records whether omitting
 * them preserves or resets a cell's geometry, and geometry is a designer/layout
 * concern rather than a generated-artifact one (#4). `SYNC_MUTATION_OMITTED_FIELDS`
 * in `sync-plan.ts` records the omission and the guarantee that waits on it, so the
 * open question is a field a reader can find instead of a silence.
 */
export interface SetCellsCell {
  readonly cell: string;
  readonly cellType: SetCellsCellType;
  readonly cellTypeProps: SetCellsCellTypeProps;
}

export interface SetCellsRequest {
  readonly pageName: string;
  readonly cells: readonly SetCellsCell[];
}

/**
 * The mark that separates a request a plan authorised from the payload describing it.
 *
 * Declared rather than created: nothing reads it at runtime — the barrier is at the call
 * site — and a value that never exists cannot be printed, serialized or compared by
 * accident.
 */
declare const ISSUED_SET_CELLS_REQUEST: unique symbol;

/**
 * A `setCells` request a plan authorised, and the only thing
 * {@link ForguncySyncPort.setCells} accepts.
 *
 * The brand cannot be named outside this module, so no caller can construct a value of this
 * type; {@link issueSetCellsRequest} is the single construction point. Without it the claim
 * "the payload is not the permission" is only a convention: `CellSyncMutation` is
 * deliberately structurally equal to `SetCellsRequest` — it is the plan's report shape and
 * has to read like the platform's call does — so handing `plan.write.mutation` straight to
 * the port compiles, and skips `planSetCellsDispatch` for exactly the refused and skipped
 * plans the gate exists to hold back.
 */
export type IssuedSetCellsRequest = SetCellsRequest & { readonly [ISSUED_SET_CELLS_REQUEST]: true };

/**
 * Mint the one value {@link ForguncySyncPort.setCells} accepts.
 *
 * Deliberately **not** exported from the package barrel: whoever can mint an issued request
 * can bypass the gate, so this stays reachable only from the dispatch that makes the
 * decision. The assertion is the standard opaque-type construction — the brand has no
 * runtime representation, so there is no other way to produce one.
 */
export function issueSetCellsRequest(request: SetCellsRequest): IssuedSetCellsRequest {
  return request as IssuedSetCellsRequest;
}

// ---------------------------------------------------------------------------
// api.app.checkProjectErrors
// ---------------------------------------------------------------------------

/**
 * What `api.app.checkProjectErrors` answers.
 *
 * `errorCount` is the platform's own field name, recorded in #5's probe as
 * `errorCount: 0`. Nothing else about the payload is included because nothing else
 * was observed, and #19 cares about exactly this one number: non-zero is a sync
 * validation failure.
 */
export interface ProjectErrorReport {
  readonly errorCount: number;
}

// ---------------------------------------------------------------------------
// api.app.generatePageAsync
// ---------------------------------------------------------------------------

/**
 * Which page to generate.
 *
 * The argument shape of `api.app.generatePageAsync` is **not** recorded in the
 * evidence — #5 records the call as the *source* of the dev runtime URL
 * (`http://localhost:63982/Forguncy`, page route `.../Forguncy/<PageName>`), not its
 * parameters. The field name below is therefore this contract's, and the adapter
 * owns mapping it onto whatever the product accepts.
 */
export interface GeneratePageRequest {
  readonly pageName: string;
}

/**
 * The runtime locator #19 requires sync to return for browser verification.
 *
 * `pageUrl` is this contract's name for the generated runtime URL, not a field the
 * product is known to return: #5 observed the *URL* (through `location.href` on the
 * generated page), not the response object it came in. `pageName` travels with it so
 * a caller holding several sync results can tell which page each locator belongs to.
 */
export interface GeneratedPage {
  readonly pageName: string;
  readonly pageUrl: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The designer operations the one-way flow is defined over.
 *
 * A port rather than a client, for the reason #6's `CellBundlerPort` is one: this
 * package states the *contract*, and the transport — which MCP session, which
 * connection, which retry policy — belongs to the implementation Issue (#20). It
 * also keeps the contract testable: the regressions here supply a stub, which is
 * the only honest way to test a boundary that cannot be executed without a real
 * Forguncy project.
 *
 * Every method's name is the capability id in camel case, so the registry and the
 * port cannot drift: `capability-surface.ts` types each capability's `portMethod` as
 * `keyof ForguncySyncPort`.
 *
 * Deliberately **not** a method: anything that reads repository source. #19 makes the
 * repository the source of truth and designer-to-repo synchronisation a future
 * explicit feature, so the port has no shape that could carry designer state *into*
 * the project — "one-way" is a property of this interface rather than a rule someone
 * has to remember.
 */
export interface ForguncySyncPort {
  /** Resolve the stable ids and globals of the extensions the artifact references. */
  readonly listFrontendLibraries: (request: ListFrontendLibrariesRequest) => Promise<ListFrontendLibrariesResult>;
  /**
   * Write one Cell's generated source and its library references.
   *
   * Takes {@link IssuedSetCellsRequest} rather than `SetCellsRequest` on purpose: that is
   * the request `planSetCellsDispatch` minted, so this call cannot be reached with a
   * payload the plan refused or with one for a target the plan had decided to skip. The
   * transport never inspects the brand — it is a compile-time barrier at the call site,
   * which is where the mistake would otherwise be made.
   */
  readonly setCells: (request: IssuedSetCellsRequest) => Promise<void>;
  /** Report the project's current error count. */
  readonly checkProjectErrors: () => Promise<ProjectErrorReport>;
  /** Generate the page and report the runtime locator for browser verification. */
  readonly generatePageAsync: (request: GeneratePageRequest) => Promise<GeneratedPage>;
}

/** The established designer calls, as the port names them. */
export const FORGUNCY_SYNC_PORT_METHODS = [
  "listFrontendLibraries",
  "setCells",
  "checkProjectErrors",
  "generatePageAsync",
] as const satisfies readonly (keyof ForguncySyncPort)[];

export type ForguncySyncPortMethod = (typeof FORGUNCY_SYNC_PORT_METHODS)[number];
