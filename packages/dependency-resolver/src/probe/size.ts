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
 *   (`getCellCodeContext().length`), and the quantity `cell-code-budget.ts`'s bands are
 *   expressed in. This is what the band classifies and what the cap is compared against.
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
 * ## Whose characters these are: the candidate, not the composed Cell
 *
 * This is the one place the probe and the compiler measure **different documents**, and
 * saying so is load-bearing rather than pedantic:
 *
 * - **Here** — the character count of the *candidate artifact*: the probed package
 *   bundled through the compiler's bundler configuration with the probe's synthetic
 *   entry (`build.ts`). It contains the package and nothing else.
 * - **The compiler's cap** — applied by `auditCodeBudget` to the *composed Cell source*:
 *   `CELL_ARTIFACT_BANNER + "\n" + module.code + "\n" + entryWrapper + "\n"`, where
 *   `module.code` is the **Cell's own** entry bundled, not the probe's synthetic one.
 *
 * So the two numbers are not equal, and neither bounds the other in general: the
 * composed artifact adds a fixed banner, an entry wrapper and separators (measured at
 * 219 characters for the default entry shape), while the bundles themselves differ
 * because the entry differs. A candidate that fits a cap can still exceed it once
 * composed, and the compiler's check — not this one — is what decides that.
 * `budget-cross-path.test.ts` in `cell-compiler` asserts the composition overhead and
 * the distinction, so this cannot silently collapse back into a claim that the two
 * counts are one quantity.
 *
 * ## Why the cap verdict needs a declared import surface (#77 review, P1-c)
 *
 * Which *direction* the difference runs in depends on the probe's entry shape, and that is
 * what makes a cap verdict provable or not:
 *
 * - **A namespace probe** (`import * as candidate from "<pkg>"`, the default) keeps every
 *   export reachable. That makes its size an **upper** bound on what a Cell carries: a Cell
 *   that imports one small binding lets the bundler drop the rest, so the Cell can be far
 *   under a cap the namespace bundle exceeds. Measured on `es-toolkit`: the namespace bundles
 *   to **249,750** characters while the single named binding `debounce` bundles to **2,865** —
 *   an 87x gap. Rejecting on that measurement would be a false technical rejection, and it
 *   would hand the Agent a `replace` basis the artifact does not support. An earlier revision
 *   of this module claimed the opposite ("a cap rejection here is sound, the package by itself
 *   is over, so the composed artifact certainly is"); that claim was **false**, and this is the
 *   measurement that falsifies it.
 * - **A named-import probe** (`imports: ["debounce"]`) measures only what those bindings pull
 *   in, so its size is a **lower** bound: a Cell importing them carries at least that much. A
 *   cap rejection on a lower bound *is* sound, because the composed Cell cannot be smaller than
 *   the code it certainly includes.
 *
 * So the cap is compared on every run and reported as a fact on every run, but the
 * **rejection** is filed only when the measurement bounds the Cell from below — i.e. when the
 * build declared a non-empty import surface. Without one the run still records
 * `size.codeCharacters`, `size.band` and `artifact.budgetCharacters`, and states in its detail
 * that the comparison is an upper bound rather than a verdict; the band remains advisory either
 * way. `size.bound` is the fact that says which of the two a report is, so a consumer never has
 * to infer it from the entry shape.
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
 * A cap that is not `null` is validated by `core`'s `assertCellCodeBudget` before
 * anything compares or fingerprints it — the same guard the compiler applies to its
 * own. An unvalidated one is worse here than in the compiler: `NaN` silently never
 * rejects, `Infinity` never does either, and `JSON.stringify` canonicalizes every
 * non-finite number to `null` in the fingerprint — so `NaN`, `Infinity` and
 * `-Infinity` compose **one** fingerprint while `-Infinity` is the only one of the
 * three that rejects. Two runs under one declared input would then disagree about the
 * same artifact, which is the determinism #8 requires and the reason this is a throw
 * rather than a finding about the artifact.
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
import { CELL_CODE_BUDGET_DECISION, assertCellCodeBudget, classifyCellCodeSize } from "@forguncy-react-workspace/core";
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
 * Which way the measurement bounds the Cell.
 *
 * `lower-bound` — the build declared a named import surface, so the Cell certainly carries at
 * least this much and a cap rejection is sound. `upper-bound` — the build kept the whole
 * namespace, so the Cell may carry less and a cap rejection would be a claim the artifact does
 * not support. See the module header.
 */
export type SizeBound = "lower-bound" | "upper-bound";

/**
 * Observes size, classifies its band, and compares an optional cap.
 *
 * @param budgetCharacters - The project's cell code budget in **characters**, or
 *   `null` when none applies. Not bytes: see the module header. A non-null value is
 *   validated here, before it is compared or folded into a fingerprint.
 * @param bound - Which way the measurement bounds the Cell, from the build's declared import
 *   surface. Only `lower-bound` may file a rejection: see the module header.
 */
export function observeSize(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  budgetCharacters: number | null,
  bound: SizeBound = "upper-bound",
): SizeObservation {
  // Validated at this boundary rather than by the caller, because both the comparison
  // below and the fingerprint the caller composed are derived from the same number: a
  // cap that could reach one and not the other is the disagreement the guard exists to
  // prevent. See the module header for the non-finite case that motivated it.
  if (budgetCharacters !== null) {
    assertCellCodeBudget(budgetCharacters);
  }

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
    // Which way this measurement bounds the Cell. Recorded on every run rather than only on a
    // rejection, because it is what makes the other size facts interpretable: a reader that
    // sees a number over a cap needs to know whether that is a verdict or an upper bound.
    { step: "size", name: "size.bound", value: bound },
  ];
  if (budgetCharacters !== null) {
    facts.push({ step: "size", name: "artifact.budgetCharacters", value: budgetCharacters });
  }

  const overCap = budgetCharacters !== null && size.codeCharacters > budgetCharacters;
  // Only a lower bound may reject. An upper bound over the cap is reported (the facts above
  // carry it, and the detail says so) but files nothing: the Cell may import a fraction of
  // what the namespace bundle contains, so a rejection would be a technical refusal the
  // artifact does not support — and `replace` decisions bind to these findings. See the
  // module header for the measurement that settled this.
  const rejectionFindings: ProbeRejectionFinding[] = [];
  if (overCap && bound === "lower-bound") {
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
        `bound:${bound}`,
        `decision:${CELL_CODE_BUDGET_DECISION.url}`,
      ],
    });
  }

  // The three cases read differently on purpose. "No cap" is not "fits the cap", and an
  // upper bound over the cap is not a verdict — collapsing any of them into a bare
  // measurement would leave a reader to infer which one they are looking at from the
  // absence of a finding, which is exactly the inference the missing rejection used to be.
  const detail = (() => {
    const measured = `Measured ${String(size.codeCharacters)} character(s) of emitted code (band ${verdict.band}, #21)`;
    if (budgetCharacters === null) {
      return `${measured}, weighing ${String(size.totalBytes)} byte(s) as served (code ${String(size.codeBytes)}, assets ${String(size.assetBytes)}); no cell cap applies to this run.`;
    }
    const against = `${measured} against a configured cap of ${String(budgetCharacters)} character(s)`;
    if (!overCap) {
      return `${against}; the artifact is within it.`;
    }
    if (bound === "lower-bound") {
      return `${against}, which it exceeds. The build declared a named import surface, so the Cell certainly carries at least this much and the rejection is filed.`;
    }
    return `${against}, which it exceeds — but the build kept the whole package namespace, so this is an upper bound on what a Cell would carry rather than a verdict. No rejection is filed: a Cell importing a subset can tree-shake below the cap. Re-probe with a declared import surface to obtain a verdict.`;
  })();

  return {
    facts,
    risks: [],
    rejectionFindings,
    validation: {
      step: "size",
      outcome: "passed",
      detail,
      diagnostics: [],
    },
  };
}
