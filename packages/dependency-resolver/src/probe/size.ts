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
 * ## Why this step cannot file the cap verdict at all (#77 revision 13)
 *
 * The two counts above are *different documents measured from different graphs*, and the second
 * half of that is what settles the question. An earlier revision filed
 * `cell-artifact-budget-exceeded` here, first on any over-cap measurement, then only when the
 * build declared a named import surface (on the theory that named imports make the measurement a
 * lower bound). The second form is **also unsound**, and the counterexample is in this repository:
 *
 * - The probe's build is a **raw Rolldown build** (`build.ts`). The compiler's build installs
 *   `createInterceptionResolver(request.dependencies)`, which replaces `host` and `extension`
 *   dependencies with generated virtual modules / page globals. So the two builds do not share a
 *   resolution graph. `react-library`'s `DatePicker` imports `createElement` from `react`: a
 *   **named** probe of `DatePicker` measures **279** characters and its artifact contains the npm
 *   `react` implementation inlined, while the real Cell's compile resolves `react` to the host
 *   React and is *smaller*. A named-surface probe is therefore not a lower bound either — it can
 *   be strictly larger than the Cell, which is the same false-rejection failure one entry shape
 *   narrower.
 * - The surface is also a **caller declaration**, not a fact read from the Cell. A Cell may import
 *   a binding and tree-shake it because it is unused, or the declaration may simply differ from
 *   the source; the synthetic entry keeps every declared binding observable by construction
 *   (`export default { ... }`), so the probe can retain code the Cell never carries.
 *
 * So this step reports a **measurement of a synthetic candidate** and nothing more. It records
 * `size.codeCharacters`, `size.band`, `artifact.budgetCharacters` and whether the candidate is
 * over that cap, as facts an Agent weighs. It files **no** `cell-artifact-budget-exceeded` finding
 * under any input, because no shape of this probe can prove the verdict — and a `replace` decision
 * binds to those findings, so an unprovable one is a technical refusal the artifact does not
 * support.
 *
 * The authority for the hard cap verdict is the compiler: `auditCodeBudget` applies
 * `codeBudgetCharacters` to the **composed Cell source**, where the entry is the Cell's own and
 * the resolution graph is the real one. That is the exact quantity the cap is about, and
 * `cell-compiler`'s diagnostic is where it is decided. `PROBE_STEPS_OBSERVING_SIGNAL` records this
 * by giving `cell-artifact-budget-exceeded` **no** observing step, so a report that attributes the
 * finding to any probe step is refused by `validateProbeReport` rather than merely discouraged.
 *
 * `size.bound` still records which way this *estimate* leans (a namespace probe leans over, a
 * named one leans under), because that is what makes the number interpretable — but it selects
 * between two estimates, not between an estimate and a verdict.
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
 *   how much it will refuse. This step **compares against it and reports the
 *   comparison**, but the verdict is the compiler's (above). It is nullable and
 *   defaults to none: with no cap the step still records the measured facts and band,
 *   because a comparison against a threshold nobody set would be a claim about a rule
 *   that does not exist.
 *
 * A cap that is not `null` is validated by `core`'s `assertCellCodeBudget` before
 * anything compares or fingerprints it — the same guard the compiler applies to its
 * own. An unvalidated one is worse here than in the compiler: `NaN` silently never
 * compares over, `Infinity` never does either, and `JSON.stringify` canonicalizes every
 * non-finite number to `null` in the fingerprint — so `NaN`, `Infinity` and
 * `-Infinity` compose **one** fingerprint while `-Infinity` is the only one of the
 * three that compares over. Two runs under one declared input would then disagree about
 * the same artifact, which is the determinism #8 requires and the reason this is a
 * throw rather than a finding about the artifact.
 *
 * The step **passes** in every case, including one over the cap: it succeeded at
 * measuring a candidate. That is the report's central separation — a failed step says
 * "we could not find out", a successful step says "we found out" — and nothing this
 * step finds disqualifies the candidate, because the disqualifying verdict belongs to
 * the compile.
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
 * Which way this *estimate* leans, never which way a verdict runs.
 *
 * `upper-bound` — the build kept the whole namespace, so the Cell very likely carries less.
 * `lower-bound` — the build named bindings, so the Cell very likely carries at least these.
 * Neither is a bound on the compiled Cell: the probe's build and the compiler's do not share a
 * resolution graph (see the module header), so both are estimates and **neither may file a
 * rejection**. The value is recorded because it makes the number interpretable, not because it
 * authorizes anything.
 */
export type SizeBound = "lower-bound" | "upper-bound";

/**
 * Observes size, classifies its band, and reports an optional cap comparison.
 *
 * Files **no** rejection findings, under any input: see the module header for why no probe
 * shape can prove the cap verdict. The returned `rejectionFindings` is always empty and is kept
 * in the shape so the caller does not branch on which step it is handling.
 *
 * @param budgetCharacters - The project's cell code budget in **characters**, or
 *   `null` when none applies. Not bytes: see the module header. A non-null value is
 *   validated here, before it is compared or folded into a fingerprint.
 * @param bound - Which way this estimate leans, from the build's declared import surface.
 *   Reported as a fact; it does not authorize a rejection. See `SizeBound`.
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
  // Deliberately const-empty, and deliberately not a branch. Every input reachable at this step
  // was tried over revisions 11-12 and none can prove the verdict, because the probe's build and
  // the compiler's do not share a resolution graph and the import surface is a caller's
  // declaration rather than a fact about the Cell. A `replace` decision binds to these findings,
  // so filing an unprovable one is a technical refusal the artifact does not support. The
  // authority is the compiler's `auditCodeBudget` on the composed source — see the module header,
  // and `PROBE_STEPS_OBSERVING_SIGNAL`, which gives this signal no observing step at all.
  const rejectionFindings: ProbeRejectionFinding[] = [];

  // The cases read differently on purpose. "No cap" is not "fits the cap", and an over-cap
  // *estimate* is not a verdict — collapsing any of them into a bare measurement would leave a
  // reader to infer which one they are looking at from the absence of a finding. Every branch
  // that mentions the cap also says where the verdict actually comes from, so the fact is never
  // read as a refusal.
  const detail = (() => {
    const measured = `Measured ${String(size.codeCharacters)} character(s) of emitted code (band ${verdict.band}, #21) from the synthetic candidate build`;
    if (budgetCharacters === null) {
      return `${measured}, weighing ${String(size.totalBytes)} byte(s) as served (code ${String(size.codeBytes)}, assets ${String(size.assetBytes)}); no cell cap applies to this run.`;
    }
    const against = `${measured}, ${overCap ? "over" : "within"} this project's configured cap of ${String(budgetCharacters)} character(s)`;
    // The estimate's leaning is named so the number is interpretable, and the authority is named
    // so it is not acted on: the probe measures a candidate the compiler will not build, so only
    // the compile can exceed a cap.
    const leaning =
      bound === "upper-bound"
        ? "the build kept the whole package namespace, so the Cell may carry less"
        : "the build declared named imports, so the Cell may still carry more once React, host and extension dependencies resolve differently";
    return `${against}. This is an estimate of a candidate, not a cap verdict: ${leaning}, and the compile resolves host/extension dependencies the probe build does not. The compiler's own \`cell-code-budget-exceeded\` diagnostic on the composed Cell is what decides it.`;
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
