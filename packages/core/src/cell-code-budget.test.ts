import { describe, expect, it } from "vitest";

import type { CellCodeBudgetBand } from "./cell-code-budget.ts";
import {
  CELL_CODE_BUDGET_BAND_DEFINITIONS,
  CELL_CODE_BUDGET_BANDS,
  CELL_CODE_BUDGET_DECISION,
  CELL_CODE_BUDGET_GOVERNING_DECISIONS,
  CELL_CODE_BUDGET_MEASUREMENT,
  CELL_CODE_INLINE_CEILING_CHARACTERS,
  CELL_CODE_PROJECT_VOLUME_OBSERVATION,
  CELL_CODE_REVIEW_CEILING_CHARACTERS,
  cellCodeBudgetBands,
  classifyCellCodeSize,
  findCellCodeBudgetBand,
} from "./cell-code-budget.ts";
import { RUNTIME_CONTRACT_DECISION } from "./governance.ts";

/**
 * The measured budget, and the properties a consumer depends on.
 *
 * Decision source: GitHub Issue #21. What these tests are for is the part of #21 a
 * reader is most likely to get wrong downstream:
 *
 * 1. **The bands are ordered, contiguous and open-ended at the top.** A gap would
 *    make `classifyCellCodeSize` throw or silently return `undefined`.
 * 2. **The boundary is inclusive**, because both readings are defensible and only
 *    one can be true — an artifact of exactly the ceiling is in the band.
 * 3. **The size is characters, and a byte count is refused rather than converted.**
 *    The one error this module can make that is silent in production is classifying
 *    UTF-8 bytes: a Chinese-language Cell would be triaged three bands too high and
 *    nobody would notice, because the number would still look plausible.
 * 4. **The bands are reported as tolerances, not as a discovered cliff.** Asserted,
 *    because it is the claim a reader is most likely to assume away.
 */

/**
 * The two series #21 publishes, which is also the set the module is allowed to quote.
 *
 * They cover different things and must not be mixed: the write path was measured on
 * six generated-toolkit artifacts, the browser entry path on four real compiled
 * ones. A figure in the module that is not in one of these lists is, by definition,
 * not traceable to #21 — which is what the table checks below enforce.
 */
const WRITE_SERIES = [
  { characters: 101_919, ms: 625 },
  { characters: 255_487, ms: 959 },
  { characters: 511_567, ms: 1691 },
  { characters: 1_048_203, ms: 4113 },
  { characters: 2_096_763, ms: 9440 },
  { characters: 4_193_986, ms: 20_339 },
] as const;

/** The four real compiled artifacts whose platform entry was measured. */
const REAL_ENTRY_SERIES = [
  { characters: 119_422, ms: 557 },
  { characters: 381_643, ms: 1504 },
  { characters: 1_459_501, ms: 3986 },
  { characters: 2_725_099, ms: 10_588 },
] as const;

/** Least-squares slope over a series, in milliseconds per kilobyte. */
function slopeMsPerKilobyte(series: readonly { readonly characters: number; readonly ms: number }[]): number {
  const n = series.length;
  const sumX = series.reduce((total, point) => total + point.characters, 0);
  const sumY = series.reduce((total, point) => total + point.ms, 0);
  const sumXX = series.reduce((total, point) => total + point.characters * point.characters, 0);
  const sumXY = series.reduce((total, point) => total + point.characters * point.ms, 0);
  return (((n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)) * 1024);
}

describe("the measured bands", () => {
  it("are the three #21 asked for: a normal range, a warning range, and one that recommends an extension", () => {
    expect([...CELL_CODE_BUDGET_BANDS]).toEqual(["inline", "review", "extension-recommended"]);
    expect(CELL_CODE_BUDGET_BAND_DEFINITIONS.map(definition => definition.band)).toEqual([
      ...CELL_CODE_BUDGET_BANDS,
    ]);
  });

  it("are ordered, contiguous, and open-ended at the top by exactly one band", () => {
    const ceilings = CELL_CODE_BUDGET_BAND_DEFINITIONS.map(definition => definition.maxCharacters);
    const closed = ceilings.filter((ceiling): ceiling is number => ceiling !== null);

    // Exactly one band is uncapped — the top one. Two would make the order
    // meaningless; none would leave the largest artifacts unclassifiable.
    expect(ceilings.filter(ceiling => ceiling === null)).toHaveLength(1);
    expect(ceilings[ceilings.length - 1]).toBeNull();

    // Ascending, so "the first band the size fits" is also "the smallest band".
    const ascending = [...closed].sort((left, right) => left - right);
    expect(closed).toEqual(ascending);
  });

  it("quotes each band's cost from a traceable #21 point, with the artifact named", () => {
    // Every figure in the table has to be findable on #21, and the checks below are
    // what makes that enforceable rather than a claim in a comment:
    //
    // 1. Each measured point names the artifact it came from. An unnamed figure is
    //    indistinguishable from an invented one.
    // 2. The write half is drawn from the published write series, and the entry half
    //    from the published real-artifact entry series. Mixing the two is the defect
    //    the review caught: this table once quoted entry times from the
    //    generated-toolkit series, which is roughly twice as expensive per character
    //    as real compiled code and was also missing from #21 at the time.
    // 3. Both figures rise across the bands, so no band quotes a cheaper cost than
    //    the band below it.
    let previousWrite = 0;
    let previousEntry = 0;

    for (const definition of CELL_CODE_BUDGET_BAND_DEFINITIONS) {
      const { write, browserEntry } = definition.measuredAtCeiling;

      for (const point of [write, browserEntry]) {
        expect(point.artifact.length).toBeGreaterThan(20);
        expect(point.characters).toBeGreaterThan(0);
        expect(point.ms).toBeGreaterThan(0);
      }

      // Each half is a real measured point, not a rounded ceiling: the size it is
      // quoted at has to be one of the published ones, and the implied per-character
      // cost has to be in that series' recorded range.
      expect(WRITE_SERIES.map(point => point.characters)).toContain(write.characters);
      expect(REAL_ENTRY_SERIES.map(point => point.characters)).toContain(browserEntry.characters);
      expect(WRITE_SERIES.find(point => point.characters === write.characters)?.ms).toBe(write.ms);
      expect(REAL_ENTRY_SERIES.find(point => point.characters === browserEntry.characters)?.ms).toBe(
        browserEntry.ms,
      );

      expect(write.ms).toBeGreaterThanOrEqual(previousWrite);
      previousWrite = write.ms;
      expect(browserEntry.ms).toBeGreaterThanOrEqual(previousEntry);
      previousEntry = browserEntry.ms;
    }
  });

  it("carries guidance at every band, because a band with no advice is not a policy", () => {
    for (const definition of CELL_CODE_BUDGET_BAND_DEFINITIONS) {
      expect(definition.guidance.length).toBeGreaterThan(40);
    }
  });
});

describe("classifyCellCodeSize", () => {
  it("places the measured artifacts in the band their cost implies", () => {
    // The real point of the table: the two artifacts #21 measured most precisely
    // have to land where their numbers say they should.
    expect(classifyCellCodeSize(511_567).band).toBe("inline");
    expect(classifyCellCodeSize(1_459_501).band).toBe("review");
    expect(classifyCellCodeSize(2_725_099).band).toBe("extension-recommended");
  });

  it("is inclusive at each ceiling, because an artifact of exactly the budget is inside it", () => {
    for (const definition of CELL_CODE_BUDGET_BAND_DEFINITIONS) {
      if (definition.maxCharacters === null) continue;
      expect(classifyCellCodeSize(definition.maxCharacters).band).toBe(definition.band);
      expect(classifyCellCodeSize(definition.maxCharacters + 1).band).not.toBe(definition.band);
    }
  });

  it("classifies the smallest possible artifact and a very large one without a gap", () => {
    expect(classifyCellCodeSize(0).band).toBe("inline");
    expect(classifyCellCodeSize(1).band).toBe("inline");
    // No ceiling anywhere: the top band has to absorb anything finite.
    expect(classifyCellCodeSize(64 * 1024 * 1024).band).toBe("extension-recommended");
    expect(classifyCellCodeSize(Number.MAX_SAFE_INTEGER).band).toBe("extension-recommended");
  });

  it("reports whether the size is in the ordinary band, derived from the band itself", () => {
    expect(classifyCellCodeSize(1).withinInlineBand).toBe(true);
    expect(classifyCellCodeSize(CELL_CODE_INLINE_CEILING_CHARACTERS).withinInlineBand).toBe(true);
    expect(classifyCellCodeSize(CELL_CODE_INLINE_CEILING_CHARACTERS + 1).withinInlineBand).toBe(false);
    expect(classifyCellCodeSize(CELL_CODE_REVIEW_CEILING_CHARACTERS + 1).withinInlineBand).toBe(false);
  });

  it("returns the definition it selected, so the two cannot disagree", () => {
    const verdict = classifyCellCodeSize(1_000_000);
    expect(verdict.definition).toBe(findCellCodeBudgetBand(verdict.band));
    expect(verdict.characters).toBe(1_000_000);
  });

  it("refuses a size that is not a non-negative finite number of characters", () => {
    // Refused rather than coerced: `-1`, `NaN` and `Infinity` are all reachable from
    // an arithmetic mistake upstream, and each silently classifies as `inline` if the
    // comparisons are allowed to run.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => classifyCellCodeSize(bad)).toThrow(/non-negative finite number of characters/);
    }
  });
});

describe("the unit is characters, and that is load-bearing", () => {
  it("prices by character, so the same character count with triple the bytes is the same band", () => {
    // #21 measured this directly: a 100,095-character CJK artifact occupied 300,095
    // UTF-8 bytes and the product reported 100,095. The assertion below only means
    // something if the byte figure lands in a *different* band, so the size is chosen
    // to straddle a boundary rather than sit comfortably inside one: 700,000
    // characters is `review`, and its 3x byte figure clears the 2 MiB ceiling into
    // `extension-recommended`.
    const characters = 700_000;
    const utf8Bytes = characters * 3;

    expect(classifyCellCodeSize(characters).band).toBe("review");
    expect(classifyCellCodeSize(utf8Bytes).band).toBe("extension-recommended");
    // The claim the module makes: characters are what the product prices. A byte-based
    // classifier would put a Chinese-language Cell one band too high.
    expect(classifyCellCodeSize(characters).band).not.toBe(classifyCellCodeSize(utf8Bytes).band);
  });

  it("names the unit in the record, because a consumer cannot check it from the bands", () => {
    expect(CELL_CODE_BUDGET_MEASUREMENT.unit).toContain("characters");
  });

  it("takes exactly one argument, so a caller has no second door for a byte count", () => {
    // The parameter name is the only signal a caller gets. A second parameter, or a
    // differently-named one, is how the byte mistake becomes expressible without
    // reading any documentation.
    expect(classifyCellCodeSize).toHaveLength(1);
  });
});

describe("what the measurement does and does not establish", () => {
  it("records the slopes #21's points actually produce, not convenient round numbers", () => {
    // The check that makes the published slopes falsifiable: recompute them from the
    // measured points and compare. A slope that drifted from its data is the single
    // most damaging thing this module could publish, because a consumer extrapolates
    // with it and a wrong constant looks exactly like a right one.
    expect(CELL_CODE_BUDGET_MEASUREMENT.writeMsPerKilobyte).toBeCloseTo(slopeMsPerKilobyte(WRITE_SERIES), 1);
    expect(CELL_CODE_BUDGET_MEASUREMENT.browserEntryMsPerKilobyte).toBeCloseTo(
      slopeMsPerKilobyte(REAL_ENTRY_SERIES),
      1,
    );
  });

  it("brackets the write slope with the real per-point range, so the spread is visible", () => {
    const perKb = WRITE_SERIES.map(point => point.ms / (point.characters / 1024));
    const [low, high] = CELL_CODE_BUDGET_MEASUREMENT.writeMsPerKilobyteRange;
    expect(low).toBeCloseTo(Math.min(...perKb), 1);
    expect(high).toBeCloseTo(Math.max(...perKb), 1);
    // A published range that did not contain the published slope would let a reader
    // conclude the slope describes a point outside its own series.
    expect(CELL_CODE_BUDGET_MEASUREMENT.writeMsPerKilobyte).toBeGreaterThanOrEqual(low);
    expect(CELL_CODE_BUDGET_MEASUREMENT.writeMsPerKilobyte).toBeLessThanOrEqual(high);
  });

  it("publishes only the entry slope #21 can support, from the published series", () => {
    // The published entry series is the real compiled artifacts, whose slope is
    // 3.83 ms/KB. An earlier draft also carried a
    // `browserEntryMsPerKilobyteHandGenerated: 6.93` from the generated-toolkit
    // series — a real measurement, but not the one a Cell's entry cost should be
    // planned from, since real bundled code is about half as expensive per
    // character. Two slopes in one record invite using the wrong one; the honest
    // fix is to publish both series (done, on #21) and quote only the one that
    // describes real artifacts.
    expect(Object.keys(CELL_CODE_BUDGET_MEASUREMENT)).not.toContain(
      "browserEntryMsPerKilobyteHandGenerated",
    );
    // And the one that remains is recomputed from the published points rather than
    // asserted against a literal the test also wrote.
    expect(CELL_CODE_BUDGET_MEASUREMENT.browserEntryMsPerKilobyte).toBeCloseTo(
      slopeMsPerKilobyte(REAL_ENTRY_SERIES),
      1,
    );
    const [low, high] = CELL_CODE_BUDGET_MEASUREMENT.browserEntryMsPerKilobyteRange;
    const perKb = REAL_ENTRY_SERIES.map(point => point.ms / (point.characters / 1024));
    expect(low).toBeCloseTo(Math.min(...perKb), 1);
    expect(high).toBeCloseTo(Math.max(...perKb), 1);
  });

  it("states coverage per series, since the two series do not reach equally far", () => {
    // The entry slope is computed over the real compiled artifacts, so its coverage
    // is what that series reached. An earlier draft recorded a single
    // `largestEntryObservedCharacters` holding a generated-toolkit point (4,193,986)
    // beside a real-series slope, which read as if the slope had been measured that
    // far — it had not.
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestRealArtifactEntryCharacters).toBe(2_725_099);
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestGeneratedToolkitEntryCharacters).toBe(4_193_986);
    // The real series is the shorter of the two, and that is the bound the slope has.
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestRealArtifactEntryCharacters).toBeLessThan(
      CELL_CODE_BUDGET_MEASUREMENT.largestGeneratedToolkitEntryCharacters,
    );
    // The write path reaches furthest of all, and never completed inside the tool's
    // own timeout at that size — so the write curve is bounded by the largest point
    // it actually measured cleanly, not by this.
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestWriteObservedCharacters).toBe(8_388_166);
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestGeneratedToolkitEntryCharacters).toBeLessThan(
      CELL_CODE_BUDGET_MEASUREMENT.largestWriteObservedCharacters,
    );
  });

  it("records that the curves are linear and no hard limit was found", () => {
    expect(CELL_CODE_BUDGET_MEASUREMENT.curveShape).toBe("linear");
    expect(CELL_CODE_BUDGET_MEASUREMENT.hardLimitFound).toBe(false);
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestWriteObservedCharacters).toBeGreaterThan(4 * 1024 * 1024);
  });

  it("says the observed ceiling is the harness's, not the product's", () => {
    // A reader who takes the ceiling for a product limit will design around a
    // constraint that does not exist.
    expect(CELL_CODE_BUDGET_MEASUREMENT.ceilingExplanation).toMatch(/60-second|timeout/i);
    expect(CELL_CODE_BUDGET_MEASUREMENT.ceilingExplanation).toMatch(/persisted/);
  });

  it("records the project-volume observation, and proposes no threshold from it", () => {
    expect(CELL_CODE_PROJECT_VOLUME_OBSERVATION.observation).toMatch(/ReactCellType write/);
    expect(CELL_CODE_PROJECT_VOLUME_OBSERVATION.observation).toMatch(/41 ms/);
    // The conclusion has to be an admission, not a number. This is the assertion
    // that stops the single observation becoming a calibrated ceiling later.
    expect(CELL_CODE_PROJECT_VOLUME_OBSERVATION.conclusion).toMatch(/single point|no project-level ceiling/);
    expect(Object.keys(CELL_CODE_PROJECT_VOLUME_OBSERVATION)).not.toContain("thresholdCharacters");
  });

  it("never states a size as a refusal, because no measured size was refused", () => {
    // `extension-recommended` recommends. If the guidance ever reads like a
    // verdict, the band has outgrown its evidence.
    const top = findCellCodeBudgetBand("extension-recommended");
    expect(top.guidance).toMatch(/recommendation, not a refusal/i);
    expect(top.maxCharacters).toBeNull();
  });
});

describe("provenance", () => {
  it("names #21 as the measurement and #5 as the target it was taken against", () => {
    expect(CELL_CODE_BUDGET_DECISION.issue).toBe(21);
    expect(CELL_CODE_BUDGET_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/21",
    );
    // A change to these numbers is a claim about a specific verified target.
    expect(CELL_CODE_BUDGET_GOVERNING_DECISIONS).toContain(RUNTIME_CONTRACT_DECISION);
    expect(CELL_CODE_BUDGET_MEASUREMENT.target).toContain("12.0.100");
  });

  it("cites the consumer Specs #21's result feeds, not only the measurement itself", () => {
    // #21's acceptance criterion is that its result "feeds #8/#16 decision policy and
    // compiler diagnostics". A change to these bands that a lock or a selection
    // procedure depends on therefore has to cite them, and the convention is to
    // compose the list from the architecture decisions rather than restate them.
    const issues = CELL_CODE_BUDGET_GOVERNING_DECISIONS.map(decision => decision.issue);
    expect(issues).toContain(4);
    expect(issues).toContain(5);
    expect(issues).toContain(8);
    expect(issues).toContain(16);
    expect(issues).toContain(21);
  });

  it("keeps a stable band order for a report table", () => {
    expect(cellCodeBudgetBands()).toBe(CELL_CODE_BUDGET_BAND_DEFINITIONS);
  });

  it("refuses an unknown band id rather than returning undefined", () => {
    expect(() => findCellCodeBudgetBand("enormous" as CellCodeBudgetBand)).toThrow(
      /Unknown cell code budget band "enormous"/,
    );
  });
});
