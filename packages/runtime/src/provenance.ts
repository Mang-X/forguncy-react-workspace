/**
 * Decision provenance for the runtime package's Specs.
 *
 * Decision sources, one per Spec this package is the executable projection of:
 * - GitHub Issue #27 — "Spec: typed Forguncy runtime facade for application-owned
 *   capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27)
 * - GitHub Issue #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * this package has no document to cite. It does not therefore get to *not* cite
 * anything: #27's own Decision section says the façade "exists to express the
 * ownership rule from #4 in normal TypeScript source", and its Dependencies
 * section names #4 and #5. A façade change that cannot say which decision it is
 * downstream of is the failure mode this module prevents.
 *
 * The upstream records are re-exported from `core` rather than re-typed here, so
 * a second copy of "#4" cannot drift away from the first. #27 and #22 are declared
 * here rather than added to `core` on purpose: `core` holds the architecture
 * decisions *every* package must obey and keeps `GOVERNING_ARCHITECTURE_DECISIONS`
 * to the architecture Specs. Both of these are downstream Specs — #27 on #4/#5,
 * #22 on #4/#5/#9/#27 — so adding either to that list would relabel it as an
 * architecture decision and silently change what the list means.
 *
 * Two records, two governing lists, because the two Specs govern different
 * modules: `RUNTIME_GOVERNING_DECISIONS` is the façade contract's answer, and
 * `local-dev.ts` composes its own from {@link LOCAL_DEV_RUNTIME_DECISION}. Keeping
 * them apart is what stops `#22` from being read as part of the façade's contract.
 */

import {
  citationPatternsFor,
  decisionReference,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "@forguncy-react-workspace/core/browser";
import type { ArchitectureDecisionSource } from "@forguncy-react-workspace/core/browser";

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

/**
 * The local development runtime Spec this package projects.
 *
 * Separate from {@link RUNTIME_FACADE_DECISION} because the two answer different
 * questions and are consumed by different modules: #27 says which capabilities a
 * Cell may reach through an accessor and what the façade must not become, while #22
 * says what a local process may stand in for and what it may then claim. A change
 * to `local-dev.ts` that cited #27 alone would be attributing the local loop's
 * boundary decisions to a Spec that does not make them.
 */
export const LOCAL_DEV_RUNTIME_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 22,
  title: "Spec: local Vite+ development runtime for React Cells",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/22",
};

/** Short form, e.g. `#22`. */
export const LOCAL_DEV_RUNTIME_DECISION_REFERENCE = decisionReference(LOCAL_DEV_RUNTIME_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const LOCAL_DEV_RUNTIME_DECISION_QUALIFIED_REFERENCE =
  `${LOCAL_DEV_RUNTIME_DECISION.repository}${LOCAL_DEV_RUNTIME_DECISION_REFERENCE}`;

/** Patterns a document must match to count as citing the local dev runtime Spec. */
export const LOCAL_DEV_RUNTIME_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(LOCAL_DEV_RUNTIME_DECISION);
