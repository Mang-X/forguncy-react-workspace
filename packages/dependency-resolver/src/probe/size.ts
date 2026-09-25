/**
 * The `size` step: the generated artifact's size, its measured band, and the
 * project's optional hard cap.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "the generated artifact size, to be
 * compared against the measured cell code budget", and is the only step that may
 * observe `cell-artifact-budget-exceeded`), #21 (the measurement — this module
 * classifies against its bands and never restates them), #8 (the fingerprint the
 * budget participates in, so changing the unit or the comparison invalidates the
 * evidence the comparison produced), #77 (which settled the unit below).
 *
 * ## The unit contract (#77)
 *
 * Two quantities are measured here, and they are deliberately not the same one:
 *
 * - **Bytes** — `size.codeBytes`, `size.assetBytes`, `size.totalBytes`. The weight
 *   of the artifact *as served*, over code **and** assets. Counted with
 *   `Buffer.byteLength` (UTF-8, the encoding the artifact is served as) and
 *   `byteLength` on byte arrays — never `String.length`, which counts UTF-16 code
 *   units and would under-count any non-ASCII content in a minified bundle that
 *   still contains identifiers or string literals. These are facts; nothing here
 *   compares them to a budget any more.
 * - **Characters** — `size.codeCharacters`. The character count of the emitted
 *   **code**, which is the quantity #21 measured, the quantity the product reports
 *   (`getCellCodeContext().length`), the quantity `cell-code-budget.ts`'s bands are
 *   expressed in, and the quantity `compileCell`'s `codeBudgetCharacters` caps. This
 *   is what the band classifies and what the cap is compared against.
 *
 * The split is the whole point of #77 and not a cosmetic rename. Before it, this step
 * compared `size.totalBytes` against a byte budget while the compiler compared
 * `code.length` against a character budget, so one artifact could be `inline` to the
 * compiler and over budget to the probe. The gap is not small: 100,095 characters of
 * CJK source is 300,095 bytes, so a byte comparison misclassifies a Chinese-language
 * Cell by roughly a band. Assets are excluded from the character count for the same
 * reason the compiler's budget excludes them — a band is a statement about generated
 * *source*, and an asset is neither source nor text (a `Uint8Array` has no character
 * count). Their weight is not lost: it stays in the byte facts.
 *
 * ## Band versus cap
 *
 * The two are separate inputs and separate outputs, mirroring what `core` already
 * did for the compiler (#21's `cell-code-budget.ts`):
 *
 * - The **band** is measured evidence — `classifyCellCodeSize` on
 *   `size.codeCharacters`. It is advisory and **never** a rejection by itself: #21
 *   found no hard product limit (both cost curves are straight; a 4 MiB artifact
 *   wrote and rendered), so the bands are selected tolerances, not a cliff. A
 *   consumer weighs the band; nothing here refuses on it.
 * - The **cap** is `cellArtifactBudgetCharacters`, the project's own decision about
 *   how much it will refuse, and it is the **only** thing that may file
 *   `cell-artifact-budget-exceeded`. It is nullable and defaults to none: with no cap
 *   the step still passes and still records the measured facts and band, because a
 *   rejection naming a threshold nobody set would be a claim about a rule that does
 *   not exist.
 *
 * When a cap *is* given and the character count is over it, the step itself still
 * **passes**: it succeeded at measuring, and the rejection finding carries the
 * disqualification. This is the report's central separation — a failed step says "we
 * could not find out", a successful step with a rejection says "we found out, and it
 * does not qualify" — and only the latter maps to #8's `probeRequirement:
 * "not-passed"` evidence profile for a `replace` decision bound to
 * `cell-code-budget-exceeded`.
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";
import { CELL_CODE_BUDGET_DECISION, classifyCellCodeSize } from "@forguncy-react-workspace/core";
import type { OutputAsset, OutputChunk } from "rolldown";

function byteSizeOf(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

export interface ArtifactSize {
  readonly codeBytes: number;
  readonly assetBytes: number;
  readonly totalBytes: number;
  /**
   * Characters of emitted code — the quantity the #21 bands classify and the cap
   * compares against. See the module header's unit contract.
   */
  readonly codeCharacters: number;
}

export function measureArtifactSize(output: readonly (OutputChunk | OutputAsset)[]): ArtifactSize {
  let codeBytes = 0;
  let assetBytes = 0;
  let codeCharacters = 0;
  for (const item of output) {
    if (item.type === "chunk") {
      codeBytes += byteSizeOf(item.code);
      // `String.length` here, deliberately, and only here: this is the character
      // count the product reports and #21 measured, so it is the one place the
      // UTF-16 code-unit count is the right answer rather than the under-count the
      // byte path exists to avoid.
      codeCharacters += item.code.length;
    } else {
      // An asset's payload may be a string, a byte array, or absent when the
      // bundler emitted only a reference; each non-present form counts as zero
      // rather than throwing, because the other files still need measuring.
      //
      // Assets contribute bytes only. A band is about generated source, so a
      // string asset (a stylesheet, say) is not part of the character count — the
      // same exclusion `compileCell`'s budget makes, which is what keeps the two
      // paths' numbers the same quantity.
      const source: unknown = (item as { readonly source?: unknown }).source;
      if (typeof source === "string" || source instanceof Uint8Array) {
        assetBytes += byteSizeOf(source);
      }
    }
  }
  return { codeBytes, assetBytes, totalBytes: codeBytes + assetBytes, codeCharacters };
}

export interface SizeObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

/**
 * Observes size, classifies its band, and compares an optional cap.
 *
 * @param budgetCharacters - The project's cell code budget in **characters**, or
 *   `null` when none applies. Not bytes: see the module header.
 */
export function observeSize(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  budgetCharacters: number | null,
): SizeObservation {
  if (output === undefined) {
    return {
      facts: [],
      risks: [],
      rejectionFindings: [],
      validation: {
        step: "size",
        outcome: "skipped",
        detail: "The build did not produce an artifact to measure; see the `build` step's diagnostics.",
        diagnostics: [],
      },
    };
  }

  const size = measureArtifactSize(output);
  const verdict = classifyCellCodeSize(size.codeCharacters);

  const facts: ProbeFact[] = [
    { step: "size", name: "size.codeBytes", value: size.codeBytes },
    { step: "size", name: "size.assetBytes", value: size.assetBytes },
    { step: "size", name: "size.totalBytes", value: size.totalBytes },
    { step: "size", name: "size.codeCharacters", value: size.codeCharacters },
    // The measured band, as policy evidence an Agent weighs. The provenance travels
    // with it so a consumer reading the fact alone can find the measurement rather
    // than taking the band id on this report's authority (#21's own acceptance asks
    // the result to feed decision policy, which means being citable).
    { step: "size", name: "size.band", value: verdict.band },
    { step: "size", name: "size.band.decision", value: CELL_CODE_BUDGET_DECISION.url },
    // What the band was computed from, so the two facts cannot be read as describing
    // different artifacts.
    { step: "size", name: "size.band.basis", value: "characters of emitted code" },
  ];
  if (budgetCharacters !== null) {
    facts.push({ step: "size", name: "artifact.budgetCharacters", value: budgetCharacters });
  }

  const rejectionFindings: ProbeRejectionFinding[] = [];
  if (budgetCharacters !== null && size.codeCharacters > budgetCharacters) {
    // Two situations produce this and they need different wording, exactly as the
    // compiler's own diagnostic splits them. When the artifact is *large by
    // measurement*, the band is the story. When it is inside the measured ordinary
    // range, the **cap** is what is tight, and saying "over budget" without saying
    // that would send the reader looking for a cost problem #21 says is not there.
    const summary =
      verdict.band === "inline"
        ? `The generated artifact is ${String(size.codeCharacters)} characters, over this project's configured cap of ${String(budgetCharacters)} characters. The measured band is inline (#21), so this rejection is the cap's rather than a cost the measurement found.`
        : `The generated artifact is ${String(size.codeCharacters)} characters, over this project's configured cap of ${String(budgetCharacters)} characters. The measured band is ${verdict.band} (#21).`;

    rejectionFindings.push({
      signal: "cell-artifact-budget-exceeded",
      step: "size",
      summary,
      evidence: [
        `characters:${String(size.codeCharacters)}`,
        `band:${verdict.band}`,
        `budgetCharacters:${String(budgetCharacters)}`,
        `decision:${CELL_CODE_BUDGET_DECISION.url}`,
      ],
    });
  }

  return {
    facts,
    risks: [],
    rejectionFindings,
    validation: {
      step: "size",
      outcome: "passed",
      detail:
        budgetCharacters === null
          ? `Measured ${String(size.codeCharacters)} character(s) of emitted code (band ${verdict.band}, #21), weighing ${String(size.totalBytes)} byte(s) as served (code ${String(size.codeBytes)}, assets ${String(size.assetBytes)}); no cell cap applies to this run.`
          : `Measured ${String(size.codeCharacters)} character(s) of emitted code (band ${verdict.band}, #21) against a configured cap of ${String(budgetCharacters)} character(s).`,
      diagnostics: [],
    },
  };
}
