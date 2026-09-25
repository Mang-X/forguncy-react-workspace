/**
 * The identity of one Cell compile, as a deterministic string.
 *
 * Decision source: GitHub Issue #77 — the review that made `cell-code-budget-exceeded` a
 * compile-observed rejection (revision 14) and then asked what makes that evidence *about this
 * compile* rather than about a number someone typed (revision 15).
 *
 * ## Why this exists
 *
 * A size verdict is a fact about one composed Cell: one entry (and everything it imports), one
 * resolved dependency decision set, one configured cap. Without an identity for that compile, the
 * evidence was two self-attested numbers — any caller could claim a rejection by choosing
 * `codeCharacters > budgetCharacters` — and any later change to the Cell source or the dependency
 * decisions left the record reporting `fresh`. That is the same defect as the synthetic probe
 * rejection revision 13 removed, one layer down.
 *
 * ## The subject package is deliberately excluded
 *
 * This is the one non-obvious rule, and it is load-bearing. The subject is the package the record
 * rejects: the compile that justified the rejection ran with that package resolved (it is what made
 * the Cell big), and recording the rejection turns its decision into `replace`. So a fingerprint
 * that covered the subject would change **at the moment of writing** — every `artifact-rejection`
 * would be stale the instant it was recorded, and no correct record could ever be fresh.
 *
 * Excluding it is also what makes the identity answer the right question. The rejection claims
 * "this package is what puts the Cell over"; the claim stays true while the *other* inputs hold,
 * which is exactly what is fingerprinted. The subject's own movement is a sealed record field with
 * its own staleness reason (`rejected-candidate-version-changed`), so nothing is lost.
 *
 * ## The entry is fingerprinted by source, not by composed artifact
 *
 * Hashing the composed artifact would cover the subject too (it is bundled into it), which is the
 * self-invalidating problem above. Hashing the entry's source covers the entry and, because the
 * entry is a module graph, is the input a caller can re-read without building anything — which the
 * freshness axis needs, since it recomputes this identity for every record it assesses.
 *
 * The cost is stated rather than hidden: an edit to a module the entry *imports transitively*
 * changes what would be composed without changing the entry's own bytes, so this identity does not
 * catch it. That is a narrower net than "recompile and compare", and it is the net the workflow can
 * actually afford — a `status` run that had to compile every Cell to answer "is this record fresh"
 * would turn a lock read into a build.
 *
 * ## Format
 *
 * Segments following `composeProbeFingerprint` in `dependency-resolver`: quoted JSON scalars so `;`
 * or `=` inside a value cannot forge a segment, and sorted-key JSON for the decision set so a
 * caller's key order cannot compose a second fingerprint.
 */

import { createHash } from "node:crypto";

import type { DependencyDecision } from "./strategy.ts";

/** Recursively sorts object keys, so structurally equal input composes equal bytes. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = canonicalValue(source[key]);
      if (child !== undefined) {
        sorted[key] = child;
      }
    }
    return sorted;
  }
  return value;
}

/**
 * One dependency decision as fingerprint input.
 *
 * Only the fields that decide what a compile *does*: the package, the strategy, and the strategy's
 * own parameters. Lock metadata (`probe`, `target`, `evidence`, …) is deliberately absent — it
 * describes how the decision was reached, not what it resolves to, so folding it in would make an
 * unrelated re-probe read as a moved artifact.
 */
function decisionIdentity(decision: DependencyDecision): Record<string, unknown> {
  switch (decision.strategy) {
    case "inline":
      return { packageName: decision.packageName, strategy: decision.strategy };
    case "host":
      return { globalName: decision.globalName, packageName: decision.packageName, strategy: decision.strategy };
    case "extension":
      return {
        globalName: decision.globalName,
        libraryId: decision.libraryId,
        packageName: decision.packageName,
        strategy: decision.strategy,
      };
    case "replace":
      // A replacement keeps no dependency for the compiled Cell (rule 4 of #8), so what the compile
      // sees is the *absence* of this package plus the reason it is absent.
      return {
        packageName: decision.packageName,
        rejectionCode: decision.rejection.code,
        strategy: decision.strategy,
      };
  }
}

export interface ComposeCellCompileFingerprintInput {
  /** The Cell entry module's source, as the caller read it. */
  readonly entrySource: string;
  /**
   * The decisions that shape this Cell, **excluding the subject package** the record rejects — see
   * the module header for why including it would invalidate every record the moment it is written.
   */
  readonly dependencies: readonly DependencyDecision[];
  /** The cap the compile compared against. */
  readonly codeBudgetCharacters: number;
}

/**
 * The deterministic identity of one Cell compile's declared inputs.
 *
 * Pure and cheap: it reads nothing, so both the recorder and a later freshness pass compute the
 * same string from the same inputs, which is what makes a recorded value verifiable rather than
 * trusted.
 */
export function composeCellCompileFingerprint(input: ComposeCellCompileFingerprintInput): string {
  const entryDigest = createHash("sha256").update(input.entrySource, "utf8").digest("hex");
  // Sorted by package name so a caller's iteration order cannot compose a second fingerprint for
  // one decision set.
  const decisions = [...input.dependencies]
    .sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0))
    .map(decisionIdentity);

  return [
    `cell=${JSON.stringify(entryDigest)}`,
    `deps=${JSON.stringify(canonicalValue(decisions))}`,
    `budget=${String(input.codeBudgetCharacters)}`,
  ].join(";");
}
