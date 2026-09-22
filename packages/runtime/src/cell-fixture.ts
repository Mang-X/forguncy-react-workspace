/**
 * The Cell fixture contract: what a project's `fixture` module declares, and
 * how a local harness consumes it.
 *
 * Decision sources: GitHub Issues
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26), which
 *   declares `cells.<id>.fixture` as the project-relative local-dev entry, and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose local
 *   loop stands the host up with mocks.
 *
 * Implementation: GitHub Issue #28 — "Implement: project config loader and Cell
 * target registry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/28). The registry
 * (#26/#56) already resolves *where* a fixture lives; this module answers the
 * remaining question — *what shape it must export* and *who turns that export
 * into the mock provider* (#27/#29) the harness installs.
 *
 * ## The contract
 *
 * A fixture module default-exports either:
 *
 * - the `MockRuntimeFacadeOptions` object itself, or
 * - a factory function that returns that object, receiving a
 *   `CellFixtureContext` (Cell id and fixture path) so one shared fixture can
 *   branch per Cell.
 *
 * Nothing else. The factory must be synchronous: the harness installs the
 * provider before the first render, and an async factory would make fixture
 * availability a race the host never has.
 *
 * ## Why unknown fields are refused rather than ignored
 *
 * A fixture is a *prediction of the page*. A typo'd field
 * (`serverCommand` for `serverCommands`) that was silently ignored would
 * produce a provider standing in for strictly less than the page does — local
 * development would pass while the real Cell saw an unconfigured name. Refusing
 * the field names the four addresses a fixture may use and stops the drift at
 * the seam instead of at the first differing render.
 *
 * This module validates the fixture's *structure*. It deliberately does not
 * re-validate whether a named member or base prop exists on the host surface:
 * that parity rule belongs to `mock-provider.ts` (`unknown-host-binding`), which
 * derives the host surface from `core`'s evidence. Two validators with one job
 * each cannot disagree about which failure class a problem is.
 */

import { isConfigRecord } from "@forguncy-react-workspace/core";

import type { RuntimeFacadeProvider } from "./contract";
import type { MockRuntimeFacadeOptions } from "./mock-provider";
import { createMockRuntimeFacadeProvider } from "./mock-provider";

/** Every way the fixture contract can be broken. */
export const CELL_FIXTURE_ERROR_CODES = [
  /** The Cell declares no fixture (or the module has no default export). */
  "fixture-absent",
  /** The default export is neither an options object nor a factory returning one. */
  "fixture-not-consumable",
  /** The factory threw; the original error is kept as `cause`. */
  "fixture-factory-failed",
  /** A top-level field is not one of the four option fields. */
  "fixture-unknown-field",
  /** A known field is present but has the wrong shape. */
  "fixture-invalid-field",
] as const;

export type CellFixtureErrorCode = (typeof CELL_FIXTURE_ERROR_CODES)[number];

/**
 * The option fields a fixture may declare.
 *
 * Exactly `MockRuntimeFacadeOptions`' keys — asserted in both directions by
 * `expectTypeOf` in the test suite, so adding an option field without admitting
 * it here fails the type check rather than making a valid fixture unresolvable.
 */
export const CELL_FIXTURE_OPTION_FIELDS = [
  "forguncyMembers",
  "cellProps",
  "serverCommands",
  "dataSources",
] as const;

/** Fields whose values must themselves be functions (the host's call shapes). */
const CALLABLE_FIELDS = ["serverCommands", "dataSources"] as const;

/**
 * What the harness knows about the Cell asking for the fixture.
 *
 * Passed to a factory fixture so one shared module can serve several Cells; it
 * is context for error messages and factory branching, not capability — a
 * fixture still may only stand in for the four option fields.
 */
export interface CellFixtureContext {
  /** Logical Cell id from the registry (`cells.<id>`). */
  readonly cellId?: string;
  /** Absolute fixture path the registry resolved, when one exists. */
  readonly fixturePath?: string;
}

/**
 * Raised when a fixture module cannot be turned into mock options.
 *
 * Carries one code (the failure class), the Cell context it was resolved for,
 * and — for a throwing factory — the original error as `cause`, because the
 * factory's own failure is the actionable message and hiding it behind a
 * wrapper would send the reader to the wrong file.
 */
export class CellFixtureError extends Error {
  readonly code: CellFixtureErrorCode;
  readonly context: CellFixtureContext;

  constructor(code: CellFixtureErrorCode, message: string, context: CellFixtureContext = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CellFixtureError";
    this.code = code;
    this.context = context;
  }
}

/** The Cell a diagnostic is about, phrased for a message a human pastes. */
function describeSubject(context: CellFixtureContext): string {
  if (context.cellId !== undefined && context.fixturePath !== undefined) {
    return `Cell "${context.cellId}" fixture (${context.fixturePath})`;
  }
  if (context.cellId !== undefined) {
    return `Cell "${context.cellId}" fixture`;
  }
  if (context.fixturePath !== undefined) {
    return `Fixture (${context.fixturePath})`;
  }
  return "Cell fixture";
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function") ||
    (typeof value === "function" && typeof (value as { then?: unknown }).then === "function")
  );
}

/**
 * Turns a fixture module's default export into mock options, or refuses with
 * the exact failure class.
 *
 * Accepts the options object or the factory — never the module namespace: the
 * seam that hands this a value (`virtual:forguncy/cell/<id>`'s `fixture`
 * export, or `module.default` from a direct import) has already picked the
 * default export, and guessing here would let a namespace object (which *is* a
 * record) masquerade as options with a `default` field nobody validated.
 */
export function resolveCellFixtureOptions(
  defaultExport: unknown,
  context: CellFixtureContext = {},
): MockRuntimeFacadeOptions {
  const subject = describeSubject(context);

  if (defaultExport === undefined || defaultExport === null) {
    throw new CellFixtureError(
      "fixture-absent",
      `${subject} has no default export. Declare \`export default\` (options object or factory), or remove the fixture so the harness reports its absence instead of consuming it.`,
      context,
    );
  }

  let candidate: unknown = defaultExport;
  if (typeof candidate === "function") {
    try {
      candidate = (candidate as (factoryContext: CellFixtureContext) => unknown)(context);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CellFixtureError(
        "fixture-factory-failed",
        `${subject} declared a factory that threw: ${reason}`,
        context,
        cause,
      );
    }
  }

  if (isThenable(candidate)) {
    throw new CellFixtureError(
      "fixture-not-consumable",
      `${subject} resolved to a Promise. A fixture factory must return its options synchronously: the harness installs the provider before the first render, and waiting would make fixture availability a race the host never has.`,
      context,
    );
  }

  if (!isConfigRecord(candidate)) {
    throw new CellFixtureError(
      "fixture-not-consumable",
      `${subject} must default-export an options object or a factory returning one; it resolved to ${describeValue(candidate)}.`,
      context,
    );
  }

  const unknownFields = Object.keys(candidate).filter(
    key => !(CELL_FIXTURE_OPTION_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    throw new CellFixtureError(
      "fixture-unknown-field",
      `${subject} declares unknown field${unknownFields.length > 1 ? "s" : ""} ${unknownFields
        .map(key => `"${key}"`)
        .join(", ")}. Allowed fields: ${CELL_FIXTURE_OPTION_FIELDS.join(
        ", ",
      )}. A misspelled field would be silently ignored and the fixture would stand in for less than the page does.`,
      context,
    );
  }

  for (const field of Object.keys(candidate)) {
    const value = candidate[field];
    if (value === undefined) {
      // An explicitly `undefined` known field means "not supplied", the same way
      // the config loader treats an absent `fixture`. Unknown *names* were
      // already refused above, so this cannot hide a typo — only a no-op.
      continue;
    }
    if (!isConfigRecord(value)) {
      throw new CellFixtureError(
        "fixture-invalid-field",
        `${subject} field "${field}" must be an object; it is ${describeValue(value)}.`,
        context,
      );
    }
    if ((CALLABLE_FIELDS as readonly string[]).includes(field)) {
      for (const [name, binding] of Object.entries(value)) {
        if (typeof binding !== "function") {
          throw new CellFixtureError(
            "fixture-invalid-field",
            `${subject} field "${field}" entry "${name}" must be a function, the same call shape the host injects; it is ${describeValue(
              binding,
            )}. A non-function here would silently behave as unconfigured at call time.`,
            context,
          );
        }
      }
    }
  }

  return candidate as MockRuntimeFacadeOptions;
}

/**
 * The consumption half of the seam: default export in, mock provider out.
 *
 * Everything after this line is `mock-provider.ts`'s already-tested path, so a
 * harness (Issue #23) only has to hand over the export — the structure check,
 * the parity check and the provider construction are one call.
 */
export function createCellFixtureProvider(
  defaultExport: unknown,
  context: CellFixtureContext = {},
): RuntimeFacadeProvider {
  return createMockRuntimeFacadeProvider(resolveCellFixtureOptions(defaultExport, context));
}
