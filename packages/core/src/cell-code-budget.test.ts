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
 * The measured points from #21, as (characters, writeMs, entryMs).
 *
 * Two series, and the disagreement between them is real rather than noise: the
 * write column is the hand-generated series (six points, 101,919 to 4,193,986
 * characters), the entry column mixes that series with the four real compiled
 * artifacts, which measure the same path noticeably cheaper per character. The
 * module records both slopes for that reason, and the test below asserts the
 * recorded slopes match these points rather than merely being positive.
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

  it("quotes each band's cost pair from one named artifact, and states which", () => {
    // Two properties, and both are things a later edit can quietly break:
    //
    // 1. Every band names the artifact its pair came from. Without it the figures
    //    are unfalsifiable — a reader cannot tell a measurement from a guess.
    // 2. The pair is monotone across the bands. Write and entry cost both have to
    //    rise as the band rises; a band whose entry figure is *below* a smaller
    //    band's would mean one of the two was quoted from the wrong series.
    let previousWrite = 0;
    let previousEntry = 0;
    for (const definition of CELL_CODE_BUDGET_BAND_DEFINITIONS) {
      const { writeMs, browserEntryMs, characters, artifact } = definition.measuredAtCeiling;

      expect(artifact.length).toBeGreaterThan(20);
      expect(characters).toBeGreaterThan(0);
      // Each pair is quoted at a real measured size, so the implied per-character
      // cost has to be in the range #21 recorded rather than wildly off it.
      const writePerKb = writeMs / (characters / 1024);
      const entryPerKb = browserEntryMs / (characters / 1024);
      expect(writePerKb).toBeGreaterThan(1);
      expect(writePerKb).toBeLessThan(30);
      expect(entryPerKb).toBeGreaterThan(1);
      expect(entryPerKb).toBeLessThan(20);

      expect(writeMs).toBeGreaterThanOrEqual(previousWrite);
      previousWrite = writeMs;
      expect(browserEntryMs).toBeGreaterThanOrEqual(previousEntry);
      previousEntry = browserEntryMs;
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

  it("keeps both entry-path slopes, because the two series disagree and hiding it would mislead", () => {
    // The hand-generated series measured the entry path much steeper per character
    // than the real compiled artifacts did. Quoting only the flattering one would
    // understate the cost for padding-heavy artifacts, so the module records both.
    const handGenerated = CELL_CODE_BUDGET_MEASUREMENT.browserEntryMsPerKilobyteHandGenerated;
    expect(handGenerated).toBeGreaterThan(CELL_CODE_BUDGET_MEASUREMENT.browserEntryMsPerKilobyte);
    expect(handGenerated).toBeCloseTo(6.93, 1);
  });

  it("bounds each curve by the range it was actually measured over", () => {
    // The entry curve reaches the 4 MiB band (the hand-generated series measured it
    // there) but not the 8.4 MiB write, which never completed within the tool's own
    // timeout. Claiming the entry curve out to 8.4 MiB would be an extrapolation
    // presented as a measurement.
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestEntryObservedCharacters).toBe(4_193_986);
    expect(CELL_CODE_BUDGET_MEASUREMENT.largestEntryObservedCharacters).toBeLessThan(
      CELL_CODE_BUDGET_MEASUREMENT.largestWriteObservedCharacters,
    );
    expect(CELL_CODE_BUDGET_MEASUREMENT.writeRepeatabilitySpread).toBeGreaterThan(1);
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
