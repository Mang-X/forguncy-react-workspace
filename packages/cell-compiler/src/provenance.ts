/**
 * Decision provenance for the generated-artifact contract and for the
 * workspace-source contract built on it.
 *
 * Decision sources: GitHub Issues #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary" (https://github.com/Mang-X/forguncy-react-workspace/issues/6)
 * — and #14 — "Spec: local workspace packages are source dependencies and inline by
 * default" (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * this package has no document to cite. It does not therefore get to *not* cite
 * anything: AGENTS.md requires a Spec that decides ownership or dependency
 * strategy to name the architecture Spec that governs it, and #6's own
 * Dependencies section names #4 and #5. A compiler change that cannot say which
 * decision it is downstream of is the failure mode this module prevents.
 *
 * The upstream records are re-exported from `core` rather than re-typed here, so
 * a second copy of "#4" cannot drift away from the first. Only the Specs this
 * package is the executable projection of are declared in this file, and they are
 * declared here rather than added to `core` on purpose: `core` holds the
 * architecture decisions *every* package must obey and keeps
 * `GOVERNING_ARCHITECTURE_DECISIONS` to the architecture Specs. #6 and #14 are
 * downstream artifact Specs, so adding either to that list would relabel it as an
 * architecture decision and silently change what the list means.
 *
 * #14 is declared beside #6 rather than in a package of its own because it is a
 * refinement of the same artifact boundary: it exists to lift #6's own recorded
 * caveat ("the artifact contract has no workspace manifest"), and the only
 * consumer of the workspace graph is the compiler. #9 is the counter-example that
 * shows what would change this — it was declared in `core` because the resolver
 * and the compiler both had to agree on the mapping table. If a second package
 * ever needs the workspace decision, that is the move to make, not a second copy.
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

/** The workspace-source Spec: local workspace packages are source, and source is flattened. */
export const WORKSPACE_SOURCE_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 14,
  title: "Spec: local workspace packages are source dependencies and inline by default",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/14",
};

/** Short form, e.g. `#14`. */
export const WORKSPACE_SOURCE_DECISION_REFERENCE = decisionReference(WORKSPACE_SOURCE_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const WORKSPACE_SOURCE_DECISION_QUALIFIED_REFERENCE =
  `${WORKSPACE_SOURCE_DECISION.repository}${WORKSPACE_SOURCE_DECISION_REFERENCE}`;

/**
 * The workspace-graph implementation Issue: the PoC that supplies #14's argument.
 *
 * Separate from `WORKSPACE_SOURCE_DECISION` because it is a different kind of record:
 * #14 *decides* the contract, and #15 *executes* it. The distinction is why this
 * one is an implementation Issue rather than a Spec, and why the loader exists at
 * all — #14 recorded that "supplying the graph from those sources is the
 * project-configuration work (#26, #28)", and #15 is where that work has to land
 * once #28 enters `main` without it.
 */
export const WORKSPACE_GRAPH_IMPLEMENTATION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 15,
  title: "Implement: workspace package flattening PoC",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/15",
};

/** Short form, e.g. `#15`. */
export const WORKSPACE_GRAPH_IMPLEMENTATION_REFERENCE = decisionReference(WORKSPACE_GRAPH_IMPLEMENTATION);

/**
 * Every Spec a change to the workspace-source contract has to cite.
 *
 * The architecture decisions first, then the artifact Spec #14 refines, then #14
 * itself — so a report built from this list reads in the order the decisions were
 * taken — then #15, which owns the evidence for the two criteria #14 could not
 * produce. #5 is included even though #14's own Dependencies section names only #4
 * and #6, because the compiler is bound by the runtime contract either way and this
 * package's other reference lines already carry it; dropping it here would make one
 * list in one package quietly weaker than the rest.
 */
export const WORKSPACE_SOURCE_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  ARTIFACT_CONTRACT_DECISION,
  WORKSPACE_SOURCE_DECISION,
  WORKSPACE_GRAPH_IMPLEMENTATION,
];

/** The line a PR body, plan or report describing the workspace-source contract carries. */
export const WORKSPACE_SOURCE_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  WORKSPACE_SOURCE_GOVERNING_DECISIONS,
);

/** Patterns a document must match to count as citing the workspace-graph implementation Issue (#15). */
export const WORKSPACE_GRAPH_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(WORKSPACE_GRAPH_IMPLEMENTATION);

/** Patterns a document must match to count as citing the workspace-source contract. */
export const WORKSPACE_SOURCE_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(WORKSPACE_SOURCE_DECISION);
