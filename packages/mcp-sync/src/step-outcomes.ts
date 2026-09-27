/**
 * What the flow does with what a step returned.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19).
 *
 * #19 states two post-mutation gates rather than two optional checks: "Run
 * `checkProjectErrors`; treat non-zero errors as sync validation failure" and "Return
 * runtime URL/metadata needed by browser verification". Both are decisions about *a
 * result*, so they belong beside the diagnostics rather than inside #20's executor:
 * if the contract did not say where the threshold is, "non-zero" and "a usable URL"
 * would each get defined once per implementation, and the point of a Spec is that they
 * are defined once, here.
 *
 * ## What is *not* here, and why
 *
 * A call that **rejects** is not a finding. `api.page.setCells` failing, a read
 * failing, a generation request erroring — each is a transport failure with no partial
 * result to describe, and the honest shape for it is a thrown error the caller sees,
 * not a diagnostic this package manufactures out of an exception. Manufacturing one
 * would also lose the stack, which is the only thing that helps for a transport
 * problem. The two functions below therefore classify *resolved* results, where the
 * interesting case is a call that succeeded and still did not give sync what it needs.
 *
 * That distinction is why `runtime-generation-failed` exists at all: a resolved
 * generation call with no usable locator is a successful call with an unusable
 * answer, which is exactly the state a caller would otherwise treat as success and
 * hand to a browser step that then has nothing to open.
 */

import { createSyncDiagnostic } from "./diagnostics.ts";
import type { SyncDiagnostic } from "./diagnostics.ts";
import type { GeneratedPage, ProjectErrorReport } from "./port.ts";
import { cellTargetLabel } from "./target.ts";
import type { CellTarget } from "./target.ts";

/**
 * Whether a step left the sync in a usable state.
 *
 * One variant carries the diagnostic, rather than a boolean plus an optional
 * diagnostic: "failed with nothing to say" would then be representable, and the failure
 * a caller cannot read is the failure that gets ignored.
 */
export type SyncStepOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly diagnostic: SyncDiagnostic };

export const SYNC_STEP_SUCCEEDED: SyncStepOutcome = { kind: "succeeded" };

/**
 * The project-error gate: any error at all fails the sync.
 *
 * `=== 0` rather than `!== 0` is written as a positive test on purpose. #5 recorded a
 * healthy project as `errorCount: 0`, and the comparison here is the exact one #19
 * states; an inverted test would additionally fail a negative count, which cannot
 * happen and whose handling would be a rule nobody decided.
 *
 * `wroteCell` changes only the sentence, never the threshold. #92 made this gate reachable
 * on the `unchanged` path, where no write happened, and a message asserting one would
 * misreport the run it is attached to — the same defect as returning a locator for a
 * deployment that did not happen, applied to the text instead of the value. It is a required
 * parameter rather than an optional one so a caller has to answer the question rather than
 * inherit a default that is right half the time.
 */
export function outcomeOfProjectErrorCheck(
  report: ProjectErrorReport,
  target: CellTarget,
  wroteCell: boolean,
): SyncStepOutcome {
  if (report.errorCount === 0) return SYNC_STEP_SUCCEEDED;
  return {
    kind: "failed",
    diagnostic: createSyncDiagnostic("project-errors-after-sync", cellTargetLabel(target), {
      detail: `\`api.app.checkProjectErrors\` reported ${report.errorCount} error(s) ${
        wroteCell ? "after the Cell was written" : "on a run that wrote nothing"
      }.`,
    }),
  };
}

/**
 * The generation gate: the call has to answer with something a browser can open.
 *
 * An empty or whitespace-only locator is treated as no locator. Anything else is
 * accepted as-is rather than validated: #5 records the URL's shape
 * (`http://localhost:63982/Forguncy`, page route `.../Forguncy/<PageName>`) but the
 * response field this contract reads is its own (see `port.ts`), so a stricter check
 * here would be this repository inventing an URL policy for a value whose real shape
 * it has not measured.
 */
export function outcomeOfPageGeneration(page: GeneratedPage): SyncStepOutcome {
  if (page.pageUrl.trim().length > 0) return SYNC_STEP_SUCCEEDED;
  return {
    kind: "failed",
    diagnostic: createSyncDiagnostic("runtime-generation-failed", page.pageName, {
      detail:
        "`api.app.generatePageAsync` resolved without a runtime locator, so the generated page cannot be opened for verification.",
    }),
  };
}
