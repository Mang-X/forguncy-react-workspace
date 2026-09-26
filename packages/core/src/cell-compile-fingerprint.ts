/**
 * The identity of one Cell compile, as a deterministic string.
 *
 * Decision source: GitHub Issue #77 — the review that made `cell-code-budget-exceeded` a
 * compile-observed rejection (revision 14), then required its evidence to originate from a
 * compile (revision 15), then found that the identity still did not describe the compile it
 * claimed (revision 16).
 *
 * ## What it covers
 *
 * The **composed artifact's own bytes**, and the cap the verdict was made against:
 *
 * ```
 * cell="<sha256 of the composed source>";budget=100000
 * ```
 *
 * Nothing else, and that is the point. Every input that changed the artifact — a module the entry
 * imports transitively, a dependency's resolved version, a decision moving from `inline` to `host`,
 * a bundler configuration — is *already reflected* in the bytes, so hashing the bytes covers them
 * without enumerating them. Earlier revisions hashed the entry file's own source plus the decision
 * shapes, which missed exactly the cases the review found: editing an imported module left the
 * identity unchanged, and so did upgrading a package whose strategy stayed `inline`.
 *
 * The cap is folded in beside the digest even though it is not an input to the bytes, because the
 * *verdict* is relative to it: the same artifact under a raised cap is not the same finding, and a
 * record must not stay fresh when the ceiling it was measured against moves.
 *
 * ## What it deliberately does not cover
 *
 * The rejected package's own version, which is a sealed record field with its own staleness reason
 * (`rejected-candidate-version-changed`) — folding it in here would report one change twice.
 *
 * ## Why this is computed by compiling, not by reading
 *
 * A cheaper identity could be recomposed from an entry file and a lock. It was tried and is
 * *incomplete*: the compiled artifact depends on everything the entry reaches, which cannot be
 * enumerated without bundling. Since the consumer of this identity is a verdict whose authority is
 * explicitly the compiler, the identity has to come from the compiler too — so both the recorder
 * and the freshness pass run the real compile over the same inputs and hash what it produced.
 * `status` pays that cost only for Cells that actually hold a compile-observed rejection.
 */

import { createHash } from "node:crypto";

export interface ComposeCellCompileFingerprintInput {
  /** The composed Cell source, exactly as `compileCell` assembled it. */
  readonly artifactSource: string;
  /** The cap the verdict was made against. */
  readonly codeBudgetCharacters: number;
}

/**
 * The deterministic identity of one Cell compile.
 *
 * Pure: it reads nothing, so any caller holding the artifact composes the same string the recorder
 * wrote, which is what makes a recorded value verifiable rather than trusted.
 */
export function composeCellCompileFingerprint(input: ComposeCellCompileFingerprintInput): string {
  const artifactDigest = createHash("sha256").update(input.artifactSource, "utf8").digest("hex");
  return `cell=${JSON.stringify(artifactDigest)};budget=${String(input.codeBudgetCharacters)}`;
}
