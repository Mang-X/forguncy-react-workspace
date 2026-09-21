/**
 * Decision provenance for the generated-artifact contract.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * this package has no document to cite. It does not therefore get to *not* cite
 * anything: AGENTS.md requires a Spec that decides ownership or dependency
 * strategy to name the architecture Spec that governs it, and #6's own
 * Dependencies section names #4 and #5. A compiler change that cannot say which
 * decision it is downstream of is the failure mode this module prevents.
 *
 * The upstream records are re-exported from `core` rather than re-typed here, so
 * a second copy of "#4" cannot drift away from the first. Only #6 is declared in
 * this file, and it is declared here rather than added to `core` on purpose:
 * `core` holds the architecture decisions *every* package must obey and keeps
 * `GOVERNING_ARCHITECTURE_DECISIONS` to the architecture Specs. #6 is a
 * downstream artifact Spec, so adding it to that list would relabel it as an
 * architecture decision and silently change what the list means.
 */

import {
  citationPatternsFor,
  decisionReference,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "@forguncy-react-workspace/core";
import type { ArchitectureDecisionSource } from "@forguncy-react-workspace/core";

/** The artifact Spec this package is the executable projection of. */
export const ARTIFACT_CONTRACT_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 6,
  title: "Spec: generated ReactCellType artifact and compiler boundary",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/6",
};

/** Short form, e.g. `#6`. */
export const ARTIFACT_CONTRACT_DECISION_REFERENCE = decisionReference(ARTIFACT_CONTRACT_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE =
  `${ARTIFACT_CONTRACT_DECISION.repository}${ARTIFACT_CONTRACT_DECISION_REFERENCE}`;

/**
 * Every Spec a change to this package has to cite: the architecture decisions
 * first, then the artifact Spec built on them.
 *
 * This list is the package's answer to "which architecture Spec governs #6", so
 * it names #4 and #5 through the records `core` owns rather than through a second
 * copy of them, and it is the only place a consumer has to look.
 */
export const COMPILER_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  ARTIFACT_CONTRACT_DECISION,
];

/**
 * The line a PR body, plan or report describing this package's contract carries.
 *
 * Built with `core`'s formatter so the wording cannot drift from the other Spec
 * citations in the repository. The formatter's "architecture Spec" label is
 * `core`'s established wording; #6 is included because a compiler change is
 * bound by it as much as by #4 and #5.
 */
export const COMPILER_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(COMPILER_GOVERNING_DECISIONS);

/** Patterns a document must match to count as citing the artifact contract. */
export const ARTIFACT_CONTRACT_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(ARTIFACT_CONTRACT_DECISION);
