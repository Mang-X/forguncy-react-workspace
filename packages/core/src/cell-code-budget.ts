/**
 * The measured cell-code budget: what a generated Cell artifact may weigh, in
 * characters, and what a consumer is expected to do at each band.
 *
 * Decision source: GitHub Issue #21 — "Research: measure ReactCellType
 * generated-code budget and performance envelope"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/21), downstream of
 * #3 (the v0.1 epic). The target itself is #5's verified contract.
 *
 * ## Both halves of #21's acceptance are wired
 *
 * #21's result is required to "feed #8/#16 decision policy and compiler
 * diagnostics", and both consumers now read these bands in this unit:
 *
 * - **Compiler** — `cell-compiler`'s `auditCodeBudget` classifies a composed
 *   artifact through `classifyCellCodeSize` and reports the band.
 * - **Selection policy** — #16's `size` probe
 *   (`packages/dependency-resolver/src/probe/size.ts`) classifies the artifact
 *   through `classifyCellCodeSize` too, records the band and its provenance as the
 *   probe facts `size.band`, `size.band.decision` and `size.band.basis`, and compares
 *   the project's own cap (`cellArtifactBudgetCharacters`) in **characters** — the same
 *   quantity the compiler caps. The config field is `codeBudgetCharacters`.
 *
 * Issue #77 did that wiring. Before it the probe compared UTF-8 **bytes** against a
 * hard cap, so the two paths could disagree about one artifact — the compiler calling
 * it `inline` while the probe rejected it as over budget. The unit is the whole reason
 * it could not be a rename: 100,095 characters of CJK source is 300,095 bytes, so a
 * byte comparison misclassifies a Chinese-language Cell by roughly a band.
 *
 * The bands are still **advisory** on both paths. What a rejection turns on is a
 * project's configured cap, never a band: #21 measured cost, it did not decide policy,
 * and the two concepts are kept separate here (`CELL_CODE_INLINE_CEILING_CHARACTERS`
 * and `CELL_CODE_REVIEW_CEILING_CHARACTERS` are not recommended caps) and in the probe
 * (`observeSize`'s cap is the only rejection input).
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
 * "feeds #8/#16 decision policy and compiler diagnostics". Composed from the
 * records `core` owns rather than restated, so the lists cannot drift.
 *
 * **Citing a Spec is not the same as being consumed by it**, and the list is not
 * offered as evidence that either is. #8 and #16 appear because a change to these
 * bands invalidates decisions they own — a lock fingerprint, a selection verdict —
 * so the change has to answer to them. Whether a given consumer actually reads the
 * bands is a separate question, answered by that consumer's own tests: #77's wiring
 * is asserted in `dependency-resolver`'s `size` step, and the compiler's in
 * `cell-compiler`'s budget diagnostic. A reader who wants to know whether the bands
 * are consumed should read those, not this array.
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

/** One measured figure, with the artifact it came from so it can be located on #21. */
export interface CellCodeMeasurementPoint {
  /** The measured cost, milliseconds. */
  readonly ms: number;
  /** The size of *this figure's own* artifact, characters. */
  readonly characters: number;
  /** Which artifact, named so a reader can find its row on #21. */
  readonly artifact: string;
}

/** One band: the ceiling, the measured costs that represent it, and what to do. */
export interface CellCodeBudgetBandDefinition {
  readonly band: CellCodeBudgetBand;
  /**
   * Inclusive upper bound in **characters** of generated artifact source, or
   * `null` for the open-ended top band. `null` rather than `Infinity` so a
   * consumer that serializes this record cannot mistake it for a number.
   */
  readonly maxCharacters: number | null;
  /**
   * The measured costs that represent this band, each with its own provenance.
   *
   * **These are real measured points inside the band, not costs measured *at* the
   * ceiling.** The field is named for what it holds rather than for the ceiling
   * because the two are deliberately different: the ceilings are round numbers
   * chosen for legibility, and the top band has no ceiling at all
   * (`maxCharacters: null`), so a name like `measuredAtCeiling` would describe a
   * measurement that does not exist — the very defect this table was corrected for.
   * Each point names the size it was actually taken at, so the gap between it and
   * the ceiling is visible rather than implied away.
   *
   * Two separate fields rather than one `characters` + `artifact`, because the two
   * figures come from **different measured series** and presenting them as one pair
   * implied a single artifact that does not exist. The write path was measured on
   * generated-toolkit artifacts; the browser entry path on real compiled ones. Both
   * series are on #21; neither covers every band at the same size.
   *
   * Every figure here is required to be traceable: it must be a point #21 publishes.
   * Two earlier drafts of this table broke that rule — one quoted entry times from a
   * hand-generated entry series that had not been published at the time, and the
   * table presented each band's two figures as one artifact when they came from two
   * different series. Both are fixed here, and the series that was missing was
   * published to #21 rather than dropped, so the figures stay honest either way.
   *
   * The entry half is deliberately drawn from the **real compiled** series rather
   * than the generated-toolkit one, even though the write half comes from the latter.
   * Same character count is much less code for the browser to walk when it is real
   * bundled code (about 3.8 ms/KB against 6.9 ms/KB), and real compiled code is what
   * a Cell actually is. Quoting the padded series' entry cost would overstate it.
   */
  readonly representativeMeasurements: {
    readonly write: CellCodeMeasurementPoint;
    readonly browserEntry: CellCodeMeasurementPoint;
  };
  /** What a consumer is expected to do in this band. */
  readonly guidance: string;
}

/**
 * The bands, and the measured points that represent each one.
 *
 * The ceilings are round numbers chosen for legibility, so every figure names the
 * published point it is quoted from rather than the ceiling itself — a ceiling with
 * no measurement behind it is the kind of invented number this module exists to
 * avoid, and the top band has no ceiling to measure at.
 */
export const CELL_CODE_BUDGET_BAND_DEFINITIONS: readonly CellCodeBudgetBandDefinition[] = [
  {
    band: "inline",
    maxCharacters: 512 * 1024,
    representativeMeasurements: {
      write: {
        ms: 1691,
        characters: 511_567,
        artifact: "the 500 KiB generated-toolkit artifact",
      },
      browserEntry: {
        ms: 1504,
        characters: 381_643,
        artifact: "the real `three` core build — the largest real compiled artifact inside this band",
      },
    },
    guidance:
      "The designer write is under two seconds and the cell's first paint under two. No review beyond the ordinary one; this is the range `inline` is expected to serve.",
  },
  {
    band: "review",
    maxCharacters: 2 * 1024 * 1024,
    representativeMeasurements: {
      write: {
        ms: 9440,
        characters: 2_096_763,
        artifact: "the 2 MiB generated-toolkit artifact",
      },
      browserEntry: {
        ms: 3986,
        characters: 1_459_501,
        artifact: "the real `three` addons+postprocessing build",
      },
    },
    guidance:
      "The write blocks the designer for most of ten seconds, and the cell's first paint is a visible pause: the real `three` addons+postprocessing build took 4.0 s to reach its entry. Not refused, but the size should be justified — check whether the dependency is really needed by this cell, whether a verified extension already provides it, and whether the artifact carries code the cell never calls.",
  },
  {
    band: "extension-recommended",
    maxCharacters: null,
    representativeMeasurements: {
      write: {
        ms: 20339,
        characters: 4_193_986,
        artifact: "the 4 MiB generated-toolkit artifact",
      },
      browserEntry: {
        ms: 10588,
        characters: 2_725_099,
        artifact: "the real `echarts` + `zrender` build",
      },
    },
    guidance:
      "Both costs are now tens of seconds and the browser's own Babel pass dominates. Prefer a verified `extension`, or split the cell. This is a recommendation, not a refusal: no platform limit was reached, a 4 MiB artifact still wrote and rendered correctly, and an 8.4 MiB one persisted intact.",
  },
];

/**
 * The artifact size, in characters, above which a Cell is no longer in the
 * ordinary `inline` band.
 *
 * An **advisory** boundary, and the name says band rather than budget for that
 * reason. It is not a hard cap and must not be passed to `codeBudgetCharacters`
 * expecting the review and top bands to still compile: `codeBudgetCharacters` is a
 * hard rejection cap, so using this ceiling as one refuses every artifact above it.
 * The two concepts are deliberately separate — see
 * {@link CELL_CODE_REVIEW_CEILING_CHARACTERS} for the same distinction stated
 * against the compiler's budget.
 */
export const CELL_CODE_INLINE_CEILING_CHARACTERS = CELL_CODE_BUDGET_BAND_DEFINITIONS[0].maxCharacters!;

/**
 * The top of the `review` band, in characters: the last size at which the measured
 * cost is "seconds, and worth justifying".
 *
 * Also **advisory**, and this is the constant most likely to be misused, so the
 * distinction is spelled out. This is *not* a recommended default for
 * `codeBudgetCharacters`. The compiler's `codeBudgetCharacters` is a hard cap: an
 * artifact longer than it is rejected, whatever band it falls in. Passing this value
 * there therefore refuses every artifact in the top band — the opposite of what the
 * open-ended band's own guidance says, which is that the top band is a
 * recommendation and not a refusal.
 *
 * There is deliberately no constant here that is a recommended hard cap. Choosing
 * one is a project's decision about how much it will refuse, and #21 measured cost
 * rather than deciding a policy limit; a number invented here would look measured
 * and would not be.
 */
export const CELL_CODE_REVIEW_CEILING_CHARACTERS = CELL_CODE_BUDGET_BAND_DEFINITIONS[1].maxCharacters!;

/** The measurement's shape, as a machine-readable summary a consumer can cite. */
export const CELL_CODE_BUDGET_MEASUREMENT = {
  /** Designer MCP identity the figures were taken against. */
  target: "Forguncy 12.0.100.0",
  /** The unit the product reports and these bands are expressed in. */
  unit: "characters of generated artifact source",
  /**
   * Least-squares slope of the designer write path, over the six **timed** points
   * from 101,919 to 4,193,986 characters (see `largestTimedWriteCharacters` — the
   * basis is the timed series, not the largest artifact that persisted). Per-point
   * values span 3.4–6.3 ms/KB, and repeating one 1 MiB write five times gave a 1.24x
   * spread — so this is a planning figure with a wide band, not a constant.
   */
  writeMsPerKilobyte: 5.02,
  /** The per-point range the slope above summarises. */
  writeMsPerKilobyteRange: [3.38, 6.28] as const,
  /**
   * Least-squares slope of the browser entry path, over the four real compiled
   * artifacts from 119,422 to 2,725,099 characters — the series #21 publishes.
   */
  browserEntryMsPerKilobyte: 3.83,
  /** The per-point range the slope above summarises: 2.80 ms/KB to 4.78 ms/KB. */
  browserEntryMsPerKilobyteRange: [2.8, 4.78] as const,
  /** Repeated-write spread on one 1 MiB artifact, as a ratio. */
  writeRepeatabilitySpread: 1.24,
  /** Both curves were linear over their measured ranges; no cliff was found. */
  curveShape: "linear",
  /**
   * Coverage, per series and per question, because the two series do not reach
   * equally far and "how far the slope was measured" is not the same question as
   * "how large an artifact was observed to persist".
   *
   * **Write coverage is split for exactly that reason.** The 5.02 ms/KB slope is
   * computed over six *timed* points reaching `largestTimedWriteCharacters`; the
   * 8,388,166-character write exceeded the tool's 60 s timeout, so it produced no
   * duration usable in a slope or a cost curve. Recording only the larger figure
   * under a name like "largest observed write" would tell a machine reader the slope
   * had been measured to 8.4 MiB. It had not, and the difference matters: a consumer
   * extrapolating 5.02 ms/KB to that size is extrapolating 2x beyond its basis.
   *
   * The persistence fact is still recorded — under a name that says persistence
   * rather than measurement, so neither fact is lost and neither is mistaken for the
   * other.
   *
   * **Entry coverage** is likewise stated for the series the slope actually uses
   * (the real compiled artifacts) *and* for the generated-toolkit one it does not, so
   * a reader cannot read 4,193,986 as the slope's reach.
   */
  /** Largest write with a usable duration — the write slope's basis. */
  largestTimedWriteCharacters: 4_193_986,
  /** Largest write known to persist intact, though its duration was not measured. */
  largestPersistedWriteCharacters: 8_388_166,
  /** Largest entry measured on a real compiled artifact — the series the slope uses. */
  largestRealArtifactEntryCharacters: 2_725_099,
  /** Largest entry measured on the generated-toolkit series (published on #21). */
  largestGeneratedToolkitEntryCharacters: 4_193_986,
  /** Whether any hard product limit was encountered. */
  hardLimitFound: false,
  /** Why the observed ceiling is a harness limit rather than a product one. */
  ceilingExplanation:
    "The largest write attempted exceeded the designer MCP tool's own 60-second execute_code timeout, not a product limit: at 8,388,166 characters the content still persisted and read back intact, but its duration was not measured, so it contributes no point to the write slope.",
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
