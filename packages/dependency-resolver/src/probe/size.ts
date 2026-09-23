/**
 * The `size` step: the generated artifact's bytes against the cell code budget.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "the generated artifact size, to be
 * compared against the measured cell code budget", and is the only step that may
 * observe `cell-artifact-budget-exceeded`), #21 (the measured budget itself —
 * this module measures and compares; deciding what a cell's budget *is* belongs
 * to #21's config path and arrives here as a number), #8 (the fingerprint the
 * budget participates in, so changing the budget invalidates the evidence the
 * comparison produced).
 *
 * The budget is nullable and defaults to none. With no budget the step still
 * passes and still records the measured bytes — size is a fact an Agent weighs
 * whether or not a limit exists — but files no rejection, because
 * `cell-artifact-budget-exceeded` without a budget to exceed would be a claim
 * about a threshold nobody set. When a budget *is* given and the total is over
 * it, the step itself still **passes**: it succeeded at measuring, and the
 * rejection finding carries the disqualification. This is the report's central
 * separation — a failed step says "we could not find out", a successful step with
 * a rejection says "we found out, and it does not qualify" — and only the latter
 * maps to #8's `probeRequirement: "not-passed"` evidence profile for a `replace`
 * decision bound to `cell-code-budget-exceeded`.
 *
 * Byte counting is `Buffer.byteLength` on strings (UTF-8, the encoding the
 * artifact is served as) and `byteLength` on byte arrays — never `String.length`,
 * which counts UTF-16 code units and would under-count any non-ASCII content in a
 * minified bundle that still contains identifiers or string literals.
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";
import type { OutputAsset, OutputChunk } from "rolldown";

function byteSizeOf(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

export interface ArtifactSize {
  readonly codeBytes: number;
  readonly assetBytes: number;
  readonly totalBytes: number;
}

export function measureArtifactSize(output: readonly (OutputChunk | OutputAsset)[]): ArtifactSize {
  let codeBytes = 0;
  let assetBytes = 0;
  for (const item of output) {
    if (item.type === "chunk") {
      codeBytes += byteSizeOf(item.code);
    } else {
      // An asset's payload may be a string, a byte array, or absent when the
      // bundler emitted only a reference; each non-present form counts as zero
      // rather than throwing, because the other files still need measuring.
      const source: unknown = (item as { readonly source?: unknown }).source;
      if (typeof source === "string" || source instanceof Uint8Array) {
        assetBytes += byteSizeOf(source);
      }
    }
  }
  return { codeBytes, assetBytes, totalBytes: codeBytes + assetBytes };
}

export interface SizeObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

/**
 * Observes size against an optional budget.
 *
 * @param budgetBytes - The cell code budget in bytes, or null when none applies.
 */
export function observeSize(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  budgetBytes: number | null,
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
  const facts: ProbeFact[] = [
    { step: "size", name: "size.codeBytes", value: size.codeBytes },
    { step: "size", name: "size.assetBytes", value: size.assetBytes },
    { step: "size", name: "size.totalBytes", value: size.totalBytes },
  ];
  if (budgetBytes !== null) {
    facts.push({ step: "size", name: "artifact.budgetBytes", value: budgetBytes });
  }

  const rejectionFindings: ProbeRejectionFinding[] = [];
  if (budgetBytes !== null && size.totalBytes > budgetBytes) {
    rejectionFindings.push({
      signal: "cell-artifact-budget-exceeded",
      step: "size",
      summary: `The generated artifact is ${String(size.totalBytes)} bytes, over the cell budget of ${String(budgetBytes)} bytes.`,
      evidence: [`total:${String(size.totalBytes)}`, `budget:${String(budgetBytes)}`],
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
        budgetBytes === null
          ? `Measured ${String(size.totalBytes)} byte(s) of artifact (code ${String(size.codeBytes)}, assets ${String(size.assetBytes)}); no cell budget applies to this run.`
          : `Measured ${String(size.totalBytes)} byte(s) of artifact against a budget of ${String(budgetBytes)} byte(s).`,
      diagnostics: [],
    },
  };
}
