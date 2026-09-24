/**
 * The measured cell-code budget: what a generated Cell artifact may weigh, in
 * characters, and what a consumer is expected to do at each band.
 *
 * Decision source: GitHub Issue #21 — "Research: measure ReactCellType
 * generated-code budget and performance envelope"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/21), downstream of
 * #3 (the v0.1 epic) and feeding #8's decision policy and #16's selection
 * procedure. The target itself is #5's verified contract.
 *
 * ## What was actually measured, and where
 *
 * Every number below is from an executed run against a live Forguncy 12.0.100.0
 * designer with a real project (`前端拓展包集成示例.fgcc`), a real generated page
 * served at `localhost:63982`, and a real Chromium tab. The raw observations are
 * on #21; this module is the policy projected from them.
 *
 * Two cost curves were measured, both as a function of the **character** count of
 * the generated artifact (the unit the product itself reports — `getCellCodeContext`
 * returns `length` in characters, and a 100,095-character artifact of CJK text is
 * reported as exactly 100,095 while occupying 300,095 UTF-8 bytes, so bytes are
 * not the unit this target uses).
 *
 * - **Write path** — `api.page.setCells` through the designer, ~5.0 ms/KB by least
 *   squares over six points (per-point 3.4–6.3 ms/KB), linear from 100 KiB to 4 MiB.
 * - **Browser entry** — the platform's own `App` invocation, ~3.8 ms/KB over four
 *   real compiled artifacts (119 KB to 2.7 MB), linear over that range. The platform
 *   compiles the cell source with Babel on the client before running it, which is
 *   why this is the larger of the two at small sizes: an isolated measurement of
 *   that pass alone costs 184 ms at 100 KB rising to 3,191 ms at 4 MB.
 *
 * ## Why these are bands and not a discovered cliff
 *
 * Both curves are straight. No hard product limit was found: a 4 MiB artifact wrote
 * in 20 s and reached its entry in 28 s with no error, and an 8.4 MiB artifact
 * persisted and read back intact (its write exceeded the designer MCP tool's own
 * 60-second timeout, which is a harness limit and not a platform one). So the bands
 * below are **selected tolerances**, not thresholds the data contains. They are
 * stated as such deliberately: a reader who believes there is a cliff will look for
 * it in the measurements, not find one, and distrust the whole table.
 *
 * The tolerances are chosen against the two costs a human actually feels — how long
 * the write blocks the designer, and how long the page takes to show the cell.
 *
 * ## The observation that is not in either curve
 *
 * Total project cell-code volume degrades a *different* path. With ~31 MB of Cell
 * code present across 40 pages, every `ReactCellType` write timed out at the 60 s
 * designer cap — including a 526-character artifact, and including writes to pages
 * that had none — while plain-value writes (7 ms) and reads (215 ms for an 8.4 MB
 * cell) stayed fast. Deleting those pages restored a `ReactCellType` write to 41 ms.
 * So the cost of cell code is not only per-artifact: it is also aggregated per
 * project, and the aggregate bites at a size no single-cell budget can express.
 * `CELL_CODE_PROJECT_VOLUME_OBSERVATION` records it; it is deliberately *not*
 * turned into a threshold, because one observation is not a calibration.
 */

import type { ArchitectureDecisionSource } from "./governance.ts";
import {
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_SELECTION_DECISION,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "./governance.ts";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** The measurement Issue this module projects. */
export const CELL_CODE_BUDGET_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 21,
  title: "Research: measure ReactCellType generated-code budget and performance envelope",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/21",
};

/**
 * The Specs a change here also answers to.
 *
 * The architecture decisions first, then the measurement Issue itself — the same
 * shape `LOCK_GOVERNING_DECISIONS` and `HOST_BRIDGE_GOVERNING_DECISIONS` use, and
 * for the same reason: every number in this module is a claim about a specific
 * verified target (#5), and #21's own acceptance criterion is that its result
 * "feeds #8/#16 decision policy and compiler diagnostics", so a change here that a
 * lock or a selection procedure depends on has to cite them. Composed from the
 * records `core` owns rather than restated, so the lists cannot drift.
 */
export const CELL_CODE_BUDGET_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_SELECTION_DECISION,
  CELL_CODE_BUDGET_DECISION,
];

// ---------------------------------------------------------------------------
// The bands
// ---------------------------------------------------------------------------

/**
 * How a generated artifact's size should be treated.
 *
 * Three values rather than two: the middle one exists so a consumer is not forced
 * to pretend a 900 KiB artifact is either obviously fine or obviously a problem.
 * `review` is where a human should look at the number and decide; it is not a
 * failure and must not be reported as one.
 */
export const CELL_CODE_BUDGET_BANDS = ["inline", "review", "extension-recommended"] as const;

export type CellCodeBudgetBand = (typeof CELL_CODE_BUDGET_BANDS)[number];

/** One band: the ceiling, the cost it implies, and what a consumer should do. */
export interface CellCodeBudgetBandDefinition {
  readonly band: CellCodeBudgetBand;
  /**
   * Inclusive upper bound in **characters** of generated artifact source, or
   * `null` for the open-ended top band. `null` rather than `Infinity` so a
   * consumer that serializes this record cannot mistake it for a number.
   */
  readonly maxCharacters: number | null;
  /**
   * The measured cost at this band's ceiling.
   *
   * Both figures come from the **same** artifact, because reporting a write time
   * from one size and an entry time from another inside one object invites a
   * comparison that is not valid. The artifact each band names is identified so a
   * reader can find its row on #21 rather than trust the rounding.
   *
   * The write figure is `setCells` wall time; the entry figure is the platform's
   * first `App` invocation. They come from two different runs — the write path was
   * measured on hand-generated artifacts, the entry path on real compiled ones —
   * so `artifact` names which measurement the *pair* is quoted from, and the two
   * numbers are never subtracted from each other.
   */
  readonly measuredAtCeiling: {
    /** Designer `setCells` wall time, milliseconds. */
    readonly writeMs: number;
    /** Time from page load to the platform's first `App` invocation, milliseconds. */
    readonly browserEntryMs: number;
    /** The artifact size both figures above were observed at, characters. */
    readonly characters: number;
    /** What that artifact was, so the pair can be located on #21. */
    readonly artifact: string;
  };
  /** What a consumer is expected to do in this band. */
  readonly guidance: string;
}

/**
 * The bands, and the measured cost at each ceiling.
 *
 * Every band quotes **one** artifact for both figures — the hand-generated series,
 * which is the only one where `setCells` and the platform's entry were both measured
 * at each size. A pair drawn from two different artifacts would invite subtracting
 * one from the other, which is not valid across series (see
 * {@link CELL_CODE_BUDGET_MEASUREMENT}: the real compiled artifacts measured the
 * entry path at little more than half the per-character cost of the padded series).
 *
 * The ceilings are round numbers chosen for legibility, so each `artifact` names the
 * measured point the pair is quoted from rather than the ceiling itself — a ceiling
 * with no measurement behind it is the kind of invented number this module exists to
 * avoid.
 */
export const CELL_CODE_BUDGET_BAND_DEFINITIONS: readonly CellCodeBudgetBandDefinition[] = [
  {
    band: "inline",
    maxCharacters: 512 * 1024,
    measuredAtCeiling: {
      writeMs: 1691,
      browserEntryMs: 2894,
      characters: 511_567,
      artifact: "the 500 KiB generated-toolkit artifact",
    },
    guidance:
      "At this size the designer write is under two seconds and the cell's first paint under three. No review beyond the ordinary one; this is the range `inline` is expected to serve.",
  },
  {
    band: "review",
    maxCharacters: 2 * 1024 * 1024,
    measuredAtCeiling: {
      writeMs: 9440,
      browserEntryMs: 14787,
      characters: 2_096_763,
      artifact: "the 2 MiB generated-toolkit artifact",
    },
    guidance:
      "The write blocks the designer for most of ten seconds and the cell's first paint is a visible pause. Not refused, but the size should be justified — check whether the dependency is really needed by this cell, whether a verified extension already provides it, and whether the artifact carries code the cell never calls. The real `three` addons+postprocessing build lands here too: 1,459,501 characters, 4.0 s to reach its entry.",
  },
  {
    band: "extension-recommended",
    maxCharacters: null,
    measuredAtCeiling: {
      writeMs: 20339,
      browserEntryMs: 28110,
      characters: 4_193_986,
      artifact: "the 4 MiB generated-toolkit artifact",
    },
    guidance:
      "Both costs are now tens of seconds and the browser's own Babel pass dominates. Prefer a verified `extension`, or split the cell. This is a recommendation, not a refusal: no platform limit was reached, a 4 MiB artifact still wrote and rendered correctly, and an 8.4 MiB one persisted intact.",
  },
];

/**
 * The artifact size, in characters, above which a Cell is no longer in the
 * ordinary `inline` band.
 *
 * Exported as a named constant because it is the one figure a compiler needs: the
 * point at which refusing to stay silent is correct. Taking this value as
 * `codeBudgetCharacters` does **not** make every artifact above it a failure — see
 * {@link classifyCellCodeSize}; the ceiling of the middle band is what a budget
 * should default to when a project has not measured its own.
 */
export const CELL_CODE_INLINE_CEILING_CHARACTERS = CELL_CODE_BUDGET_BAND_DEFINITIONS[0].maxCharacters!;

/**
 * The figure a project's code budget should start from: the top of the `review`
 * band, in characters.
 *
 * This is the number the compiler's diagnostic treats as the default once a caller
 * asks for a default. It is deliberately the *top of review* and not the top of
 * `inline`: a compiler that refused the review band on its own authority would be
 * making the policy decision that band exists to hand back to a human. Passing this
 * as a budget still permits the top band, which is why the compiler's diagnostic
 * reports a band rather than a boolean.
 */
export const CELL_CODE_REVIEW_CEILING_CHARACTERS = CELL_CODE_BUDGET_BAND_DEFINITIONS[1].maxCharacters!;

/** The measurement's shape, as a machine-readable summary a consumer can cite. */
export const CELL_CODE_BUDGET_MEASUREMENT = {
  /** Designer MCP identity the figures were taken against. */
  target: "Forguncy 12.0.100.0",
  /** The unit the product reports and these bands are expressed in. */
  unit: "characters of generated artifact source",
  /**
   * Least-squares slope of the designer write path, over the six points from
   * 101,919 to 4,193,986 characters. Per-point values span 3.4–6.3 ms/KB, and
   * repeating one 1 MiB write five times gave a 1.24x spread — so this is a
   * planning figure with a wide band, not a constant.
   */
  writeMsPerKilobyte: 5.02,
  /** The per-point range the slope above summarises. */
  writeMsPerKilobyteRange: [3.38, 6.28] as const,
  /**
   * Least-squares slope of the browser entry path, over the four real compiled
   * artifacts from 119,422 to 2,725,099 characters. The hand-generated series
   * measured the same path at a steeper 6.9 ms/KB, so the two series disagree and
   * the real-artifact one is quoted: same characters, much less code for the
   * browser to walk, which is the shape a real Cell has.
   */
  browserEntryMsPerKilobyte: 3.83,
  /** The other series' slope, recorded so the disagreement is not hidden. */
  browserEntryMsPerKilobyteHandGenerated: 6.93,
  /** Repeated-write spread on one 1 MiB artifact, as a ratio. */
  writeRepeatabilitySpread: 1.24,
  /** Both curves were linear over their measured ranges; no cliff was found. */
  curveShape: "linear",
  /** The largest artifact that completed a write, characters (exceeded the tool's 60 s cap). */
  largestWriteObservedCharacters: 8_388_166,
  /** The largest artifact whose browser entry was measured, characters. */
  largestEntryObservedCharacters: 4_193_986,
  /** Whether any hard product limit was encountered. */
  hardLimitFound: false,
  /** Why the observed ceiling is a harness limit rather than a product one. */
  ceilingExplanation:
    "The largest write exceeded the designer MCP tool's own 60-second execute_code timeout, not a product limit: the content persisted and read back intact at 8,388,166 characters.",
  evidence: ["designer-api", "generated-runtime-browser"],
} as const;

/**
 * The find that neither cost curve expresses: total project cell-code volume.
 *
 * Recorded as an observation rather than a threshold on purpose. One run at one
 * volume, with the volume reduced by deleting pages rather than by writing small
 * cells, cannot separate "total volume" from "number of pages" or "one very large
 * cell". A threshold derived from it would look measured and would not be. What it
 * does establish is that a per-artifact budget is not the whole story, which is
 * why it is stated here where a consumer reading only the bands will see it.
 */
export const CELL_CODE_PROJECT_VOLUME_OBSERVATION = {
  observation:
    "With ~31 MB of Cell code across 40 extra pages, every ReactCellType write timed out at the designer's 60 s cap — including a 526-character artifact and writes to pages holding no cell code — while plain-value writes (7 ms) and cell reads (215 ms for an 8.4 MB cell) remained fast. Deleting those pages restored a ReactCellType write of the same 526-character artifact to 41 ms.",
  conclusion:
    "Cell-code cost is aggregated per project as well as per artifact. A per-cell budget cannot bound this, and no project-level ceiling is proposed here because the observation is a single point.",
  evidence: ["designer-api"],
} as const;

// ---------------------------------------------------------------------------
// Reading a size
// ---------------------------------------------------------------------------

/** A size classified against the bands, with the reason. */
export interface CellCodeBudgetVerdict {
  readonly band: CellCodeBudgetBand;
  /** The size the verdict is about, characters. */
  readonly characters: number;
  /** The band definition that was selected. */
  readonly definition: CellCodeBudgetBandDefinition;
  /**
   * Whether the size is inside the band a compiler should treat as ordinary.
   *
   * Derived from the band rather than compared to a separate constant, so the two
   * cannot disagree. `false` is not a refusal: it means "not automatically fine",
   * which is exactly what the review band is.
   */
  readonly withinInlineBand: boolean;
}

/**
 * Classifies a generated artifact size against the measured bands.
 *
 * Takes characters, and the parameter name says so, because passing UTF-8 bytes
 * here would classify a CJK artifact as roughly three times its real cost — the
 * product prices characters, and a 100,095-character CJK artifact measured
 * identically to a 100,095-character ASCII one.
 */
export function classifyCellCodeSize(characters: number): CellCodeBudgetVerdict {
  if (!Number.isFinite(characters) || characters < 0) {
    throw new Error(
      `A cell code size must be a non-negative finite number of characters, received ${String(characters)}.`,
    );
  }

  const definition =
    CELL_CODE_BUDGET_BAND_DEFINITIONS.find(
      candidate => candidate.maxCharacters !== null && characters <= candidate.maxCharacters,
    ) ?? CELL_CODE_BUDGET_BAND_DEFINITIONS[CELL_CODE_BUDGET_BAND_DEFINITIONS.length - 1];

  return {
    band: definition.band,
    characters,
    definition,
    withinInlineBand: definition.band === "inline",
  };
}

/** The band definitions in order, lowest first — the shape a report table wants. */
export function cellCodeBudgetBands(): readonly CellCodeBudgetBandDefinition[] {
  return CELL_CODE_BUDGET_BAND_DEFINITIONS;
}

/** Looks up one band by id, refusing an unknown id rather than returning undefined. */
export function findCellCodeBudgetBand(band: CellCodeBudgetBand): CellCodeBudgetBandDefinition {
  const definition = CELL_CODE_BUDGET_BAND_DEFINITIONS.find(candidate => candidate.band === band);
  if (!definition) {
    throw new Error(`Unknown cell code budget band "${String(band)}".`);
  }
  return definition;
}
