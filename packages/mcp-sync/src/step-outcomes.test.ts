import { describe, expect, it } from "vitest";

import { syncDiagnosticRule } from "./diagnostics.ts";
import { SYNC_STEP_SUCCEEDED, outcomeOfPageGeneration, outcomeOfProjectErrorCheck } from "./step-outcomes.ts";
import type { CellTarget } from "./target.ts";

/**
 * #19 states two post-mutation gates rather than two optional checks: "treat non-zero
 * errors as sync validation failure", and "return runtime URL/metadata needed by browser
 * verification". Both are decisions about *a resolved result*, so these tests pin where the
 * threshold is — the one place it is defined, rather than once per implementation.
 */

const TARGET: CellTarget = { pageName: "OrderPage", cell: "cell-1" };

describe("the project-error gate", () => {
  it("passes a project with no errors", () => {
    expect(outcomeOfProjectErrorCheck({ errorCount: 0 }, TARGET, true)).toBe(SYNC_STEP_SUCCEEDED);
  });

  it("fails on any error at all, and says how many", () => {
    const outcome = outcomeOfProjectErrorCheck({ errorCount: 3 }, TARGET, true);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.diagnostic.code).toBe("project-errors-after-sync");
    expect(outcome.diagnostic.subject).toBe("OrderPage!cell-1");
    expect(outcome.diagnostic.message).toContain("3 error(s)");
  });

  // The comparison is `=== 0` on purpose: an inverted test would additionally fail a
  // negative count, which cannot happen and whose handling would be a rule nobody decided.
  it("treats a count that is not exactly zero as a failure", () => {
    expect(outcomeOfProjectErrorCheck({ errorCount: -1 }, TARGET, true).kind).toBe("failed");
  });

  it("reports a gate that cannot stop the write it already happened after", () => {
    const outcome = outcomeOfProjectErrorCheck({ errorCount: 1 }, TARGET, true);

    if (outcome.kind !== "failed") throw new Error("expected a failure");
    expect(syncDiagnosticRule(outcome.diagnostic.code).blocksMutation).toBe(false);
    expect(outcome.diagnostic.fixOwner).toBe("project-state");
  });

  // #92 made this gate reachable on a run that wrote nothing, and the message must not claim
  // a write that did not happen — the same defect as a locator for a deployment that did not
  // occur, applied to the text. The threshold is unchanged; only the sentence is.
  it("does not claim a Cell was written on a run that wrote none", () => {
    const wrote = outcomeOfProjectErrorCheck({ errorCount: 1 }, TARGET, true);
    const skipped = outcomeOfProjectErrorCheck({ errorCount: 1 }, TARGET, false);

    if (wrote.kind !== "failed" || skipped.kind !== "failed") throw new Error("expected failures");
    expect(wrote.diagnostic.message).toContain("after the Cell was written");
    expect(skipped.diagnostic.message).toContain("on a run that wrote nothing");
    expect(skipped.diagnostic.message).not.toContain("after the Cell was written");
    // Same code, same subject, same fix route: only the fact differs, so a caller branching
    // on the code sees one condition rather than two.
    expect(skipped.diagnostic.code).toBe(wrote.diagnostic.code);
    expect(skipped.diagnostic.fixOwner).toBe(wrote.diagnostic.fixOwner);
  });
});

describe("the page-generation gate", () => {
  it("passes a resolved call that answered with a locator", () => {
    expect(outcomeOfPageGeneration({ pageName: "OrderPage", pageUrl: "http://localhost:63982/Forguncy/OrderPage" })).toBe(
      SYNC_STEP_SUCCEEDED,
    );
  });

  it("fails a resolved call that answered with nothing to open", () => {
    const outcome = outcomeOfPageGeneration({ pageName: "OrderPage", pageUrl: "  " });

    // A successful call with an unusable answer is exactly the state a caller would
    // otherwise treat as success and hand to a browser step that has nothing to open.
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.diagnostic.code).toBe("runtime-generation-failed");
    expect(outcome.diagnostic.subject).toBe("OrderPage");
    expect(syncDiagnosticRule(outcome.diagnostic.code).blocksMutation).toBe(false);
  });

  it("accepts a locator without inventing a URL policy for it", () => {
    // The response field this contract reads is its own, and #5 recorded the URL's shape
    // rather than the object it arrived in, so anything non-empty is accepted as-is.
    expect(outcomeOfPageGeneration({ pageName: "OrderPage", pageUrl: "not-a-url" })).toBe(SYNC_STEP_SUCCEEDED);
  });
});
