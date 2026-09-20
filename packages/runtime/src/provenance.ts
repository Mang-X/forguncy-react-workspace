/**
 * Decision provenance for the runtime façade contract.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * this package has no document to cite. It does not therefore get to *not* cite
 * anything: #27's own Decision section says the façade "exists to express the
 * ownership rule from #4 in normal TypeScript source", and its Dependencies
 * section names #4 and #5. A façade change that cannot say which decision it is
 * downstream of is the failure mode this module prevents.
 *
 * The upstream records are re-exported from `core` rather than re-typed here, so
 * a second copy of "#4" cannot drift away from the first. Only #27 is declared in
 * this file, and it is declared here rather than added to `core` on purpose:
 * `core` holds the architecture decisions *every* package must obey and keeps
 * `GOVERNING_ARCHITECTURE_DECISIONS` to the architecture Specs. #27 is a
 * downstream façade Spec built on #4 and #5, so adding it to that list would
 * relabel it as an architecture decision and silently change what the list
 * means.
 */

import {
  citationPatternsFor,
  decisionReference,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "@forguncy-react-workspace/core";
import type { ArchitectureDecisionSource } from "@forguncy-react-workspace/core";

/** The façade Spec this package is the executable projection of. */
export const RUNTIME_FACADE_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 27,
  title: "Spec: typed Forguncy runtime facade for application-owned capabilities",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/27",
};

/** Short form, e.g. `#27`. */
export const RUNTIME_FACADE_DECISION_REFERENCE = decisionReference(RUNTIME_FACADE_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const RUNTIME_FACADE_DECISION_QUALIFIED_REFERENCE =
  `${RUNTIME_FACADE_DECISION.repository}${RUNTIME_FACADE_DECISION_REFERENCE}`;

/**
 * Every Spec a change to this package has to cite: the architecture decisions
 * first, then the façade Spec built on them.
 *
 * This list is the package's answer to "which architecture Spec governs #27", so
 * it names #4 and #5 through the records `core` owns rather than through a second
 * copy of them, and it is the only place a consumer has to look.
 */
export const RUNTIME_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  RUNTIME_FACADE_DECISION,
];

/**
 * The line a PR body, plan or report describing this package's contract carries.
 *
 * Built with `core`'s formatter so the wording cannot drift from the other Spec
 * citations in the repository. The formatter's "architecture Spec" label is
 * `core`'s established wording; #27 is included because a change to the façade
 * contract is bound by it as much as by #4 and #5.
 */
export const RUNTIME_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(RUNTIME_GOVERNING_DECISIONS);

/** Patterns a document must match to count as citing the façade contract. */
export const RUNTIME_FACADE_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(RUNTIME_FACADE_DECISION);
