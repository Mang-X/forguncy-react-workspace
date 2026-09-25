import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CellBundlerPort } from "./artifact.ts";

/**
 * The compiler's budget diagnostic, after #21.
 *
 * The assertion is on what the diagnostic *says*, not that it fired: before #21 it
 * already fired, and the whole change is that a caller can now tell "worth a look"
 * from "get an extension" without re-deriving thresholds. A test that only checked
 * the code could not fail against the old behaviour.
 */
function bundlerEmitting(code: string): CellBundlerPort {
  return { bundle: async () => ({ code, sourceSpecifiers: [] }) } as unknown as CellBundlerPort;
}

async function budgetDiagnostic(codeLength: number, budget: number) {
  const outcome = await compileCell(
    { entry: "cells/bench/App.tsx", dependencies: [] },
    { bundler: bundlerEmitting("x".repeat(codeLength)), codeBudgetCharacters: budget },
  );
  if (outcome.status !== "rejected") throw new Error(`expected a rejection, got ${outcome.status}`);
  const diagnostic = outcome.diagnostics.find(candidate => candidate.code === "cell-code-budget-exceeded");
  if (!diagnostic) throw new Error("no cell-code-budget-exceeded diagnostic");
  return diagnostic;
}

// The banner and entry wrapper add a fixed number of characters around the bundle,
// so the assertions below are about the *band* the composed size lands in, and the
// bundle lengths are chosen well clear of a boundary rather than exactly on one.
describe("the cell code budget diagnostic names the measured band", () => {
  it("reports the review band for a size the measurement puts there", async () => {
    const diagnostic = await budgetDiagnostic(700_000, 512 * 1024);
    expect(diagnostic.message).toContain("Measured band: review");
    // The cost that band implies, from #21, so a caller is not sent to the Issue to
    // find out whether it matters.
    expect(diagnostic.message).toMatch(/designer write took \d+ ms at \d+ characters/);
    expect(diagnostic.message).toMatch(/first cell entry took \d+ ms at \d+ characters/);
    // Each figure names the artifact it came from, so it can be located on #21 — and
    // they are two *different* artifacts, which is the point of splitting them.
    expect(diagnostic.message).toMatch(/the 2 MiB generated-toolkit artifact\)/);
    expect(diagnostic.message).toMatch(/the real `three` addons\+postprocessing build\)/);
  });

  it("reports the extension-recommended band for a multi-megabyte artifact", async () => {
    const diagnostic = await budgetDiagnostic(3_000_000, 512 * 1024);
    expect(diagnostic.message).toContain("Measured band: extension-recommended");
    // The band recommends; it must not read as a refusal, because nothing was refused.
    expect(diagnostic.message).toMatch(/recommendation, not a refusal/i);
  });

  it("still reports the size and the budget, which is what the caller configured", async () => {
    const diagnostic = await budgetDiagnostic(700_000, 512 * 1024);
    expect(diagnostic.message).toMatch(/against a configured budget of 524288/);
    expect(diagnostic.message).toMatch(/The composed artifact is \d+ characters/);
  });
});

// ---------------------------------------------------------------------------
// The two ways this diagnostic could contradict itself
// ---------------------------------------------------------------------------

describe("a rejection whose artifact is inside the measured ordinary range", () => {
  it("blames the budget rather than telling the caller nothing needs review", async () => {
    // The defect: the band's own guidance for `inline` says no review is needed, and
    // copying it into a hard rejection produced an error whose text argued against
    // itself. A tight budget with a small artifact is a real configuration, so the
    // diagnostic has to name the budget as the cause.
    const diagnostic = await budgetDiagnostic(200_000, 100_000);
    expect(diagnostic.message).toMatch(/Measured band: inline/);
    expect(diagnostic.message).toMatch(/this rejection is the configured budget's/);
    // And it must not carry the inline band's "no review" advice next to a rejection.
    expect(diagnostic.message).not.toMatch(/No review beyond the ordinary one/);
  });

  it("does not tell the caller a raised budget will report the band instead of refusing", async () => {
    // The false claim this replaced: the old text said to raise the budget to the
    // measured review ceiling "to let the compiler report the band's own cost instead
    // of refusing". Raising it above the artifact makes the compile succeed outright,
    // so no band is ever reported — the advice described behaviour that cannot happen.
    // Reproduced: a 200,219-character artifact with `codeBudgetCharacters` at the
    // review ceiling compiles, and produces no diagnostic at all.
    const diagnostic = await budgetDiagnostic(200_000, 100_000);
    expect(diagnostic.message).not.toMatch(/to let the compiler report the band's own/);
    expect(diagnostic.message).not.toMatch(/Raise the budget/);
    // What it says instead has to be true of the two concepts: the budget is the
    // caller's hard cap, and the band is advisory.
    expect(diagnostic.message).toMatch(/Raising the budget accepts the artifact outright/);
    expect(diagnostic.message).toMatch(/bands are an advisory classification/);
  });

  it("still gives the band's own guidance when the artifact is genuinely large", async () => {
    const diagnostic = await budgetDiagnostic(700_000, 512 * 1024);
    expect(diagnostic.message).toMatch(/should be justified/);
    expect(diagnostic.message).not.toMatch(/this rejection is the configured budget's/);
  });
});

describe("the budget itself is validated", () => {
  it("refuses a budget that is not a non-negative finite number, naming the budget", async () => {
    // `code.length <= Number.NaN` is `false`, so an unvalidated NaN budget rejects
    // every artifact with "against a configured budget of NaN" — which reads like a
    // size problem and is a caller's typo. The size is already guarded this way; the
    // budget was not.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(
        compileCell(
          { entry: "cells/bench/App.tsx", dependencies: [] },
          { bundler: bundlerEmitting("x".repeat(10)), codeBudgetCharacters: bad },
        ),
      ).rejects.toThrow(/A cell code budget must be a non-negative finite number of characters/);
    }
  });

  it("still accepts a budget of zero, which is restrictive rather than invalid", async () => {
    // Zero is legitimate — a caller may want every non-empty artifact reported — so it
    // must be rejected as a *budget*, not as a malformed value.
    const diagnostic = await budgetDiagnostic(10, 0);
    expect(diagnostic.message).toMatch(/Measured band: inline/);
  });
});
