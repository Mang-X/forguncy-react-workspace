/**
 * Decision provenance for the local development harness.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), and the Spec it
 *   implements,
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * both downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * and #22 additionally of:
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 * - #27 "typed Forguncy runtime facade for application-owned capabilities"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/27
 *
 * The upstream records are re-exported from `core` rather than re-typed here, for
 * the reason `runtime/provenance.ts` gives: a second copy of "#4" can drift from
 * the first. #22 and #27 are declared by `runtime` (they are that package's Specs);
 * this module names them by reference so the harness cites the same records the
 * contract it implements cites, and declares only #23, which is this package's own.
 *
 * Kept as its own list rather than folded into `LOCAL_DEV_GOVERNING_DECISIONS`:
 * that list is the local *runtime contract*'s answer to which Spec governs it, and
 * this package is the harness that *consumes* the contract. Adding #23 there would
 * relabel an implementation Issue as one of the contract's governing decisions.
 */

import {
  citationPatternsFor,
  decisionReference,
  formatGoverningSpecReferenceLine,
} from "@forguncy-react-workspace/core";
import type { ArchitectureDecisionSource } from "@forguncy-react-workspace/core";
import {
  LOCAL_DEV_GOVERNING_DECISIONS,
  LOCAL_DEV_RUNTIME_DECISION,
  RUNTIME_FACADE_DECISION,
} from "@forguncy-react-workspace/runtime";

/** The implementation Issue this package exists to deliver. */
export const DEV_HARNESS_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 23,
  title: "Implement: Vite+ local React Cell dev harness with HMR",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/23",
};

/** Short form, e.g. `#23`. */
export const DEV_HARNESS_DECISION_REFERENCE = decisionReference(DEV_HARNESS_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const DEV_HARNESS_DECISION_QUALIFIED_REFERENCE =
  `${DEV_HARNESS_DECISION.repository}${DEV_HARNESS_DECISION_REFERENCE}`;

/**
 * Every Spec a change to this package has to cite.
 *
 * Composed from `runtime`'s list rather than from a fresh enumeration, so the
 * harness cannot claim a governing Spec the contract it implements does not: the
 * local loop's boundaries are #22's, the façade it installs is #27's, and the host
 * mapping table it reuses is #9's. Composing is also what keeps this list honest in
 * the other direction — a Spec added to `LOCAL_DEV_GOVERNING_DECISIONS` reaches the
 * harness's citation line without anyone remembering to add it here.
 */
export const DEV_HARNESS_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...LOCAL_DEV_GOVERNING_DECISIONS,
  DEV_HARNESS_DECISION,
];

/** The line a PR body, plan or report describing this package carries. */
export const DEV_HARNESS_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  DEV_HARNESS_GOVERNING_DECISIONS,
);

/** Patterns a document must match to count as citing this implementation. */
export const DEV_HARNESS_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(DEV_HARNESS_DECISION);

// Re-exported so a consumer of this package has one place to reach the two Specs the
// harness is defined against, with no second import of `runtime` needed.
export { LOCAL_DEV_RUNTIME_DECISION, RUNTIME_FACADE_DECISION };
