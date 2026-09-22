/**
 * Decision provenance for the one-way MCP sync contract.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), which is itself
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/12
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * this package has no document to cite. It does not therefore get to *not* cite
 * anything: AGENTS.md requires a Spec that decides ownership or dependency strategy
 * to name the architecture Spec that governs it, and #19's own Dependencies section
 * names #5, #6 and #12.
 *
 * The upstream records are re-exported from the packages that own them rather than
 * re-typed here, so a second copy of "#6" cannot drift away from the first. Only
 * #19 is declared in this file, and it is declared here rather than added to
 * `core` on purpose: `core` holds the architecture decisions *every* package must
 * obey and keeps `GOVERNING_ARCHITECTURE_DECISIONS` to the architecture Specs. #19
 * is a deployment Spec built on #4/#5/#6/#12, so adding it to that list would
 * relabel it as an architecture decision and silently change what the list means.
 *
 * #26 ("project configuration and React Cell target declarations") is deliberately
 * *not* in {@link MCP_SYNC_GOVERNING_DECISIONS} even though #19's first flow step
 * reads the target from project configuration. #19's Dependencies section does not
 * name it, and #26 is open and parallel rather than approved: citing it as governing
 * would make this package claim to implement a contract that does not exist yet.
 * The dependency is instead stated where it is real and checkable — `CellTarget` is
 * an *input* to sync, and `SYNC_TARGET_LOCATOR` records which half of the locator #5's
 * evidence pins and which half is still #26/#28's to settle.
 */

import {
  citationPatternsFor,
  decisionReference,
  EXTENSION_EXTERNALS_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "@forguncy-react-workspace/core";
import type { ArchitectureDecisionSource } from "@forguncy-react-workspace/core";
import { ARTIFACT_CONTRACT_DECISION } from "@forguncy-react-workspace/cell-compiler";

/** The deployment Spec this package is the executable projection of. */
export const MCP_SYNC_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 19,
  title: "Spec: one-way MCP sync from generated artifacts to Forguncy ReactCellType",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/19",
};

/** Short form, e.g. `#19`. */
export const MCP_SYNC_DECISION_REFERENCE = decisionReference(MCP_SYNC_DECISION);

/** Repo-qualified short form, for a reference that travels outside this repository. */
export const MCP_SYNC_DECISION_QUALIFIED_REFERENCE =
  `${MCP_SYNC_DECISION.repository}${MCP_SYNC_DECISION_REFERENCE}`;

/**
 * Every Spec a change to this package has to cite, in the order the decisions were
 * taken: the architecture decisions, then the artifact Spec sync deploys, then the
 * extension Spec whose `libraryId` metadata sync verifies, then #19 itself.
 *
 * The list is built from the records their owning packages export rather than from
 * copies, and it is the only place a consumer has to look to answer "which
 * architecture Spec governs #19".
 */
export const MCP_SYNC_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  ARTIFACT_CONTRACT_DECISION,
  EXTENSION_EXTERNALS_DECISION,
  MCP_SYNC_DECISION,
];

/**
 * The line a PR body, plan or report describing this package's contract carries.
 *
 * Built with `core`'s formatter so the wording cannot drift from the other Spec
 * citations in the repository. Its "architecture Spec" label is `core`'s
 * established wording; #6, #12 and #19 are included because a deployment change is
 * bound by them as much as by #4 and #5.
 */
export const MCP_SYNC_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  MCP_SYNC_GOVERNING_DECISIONS,
);

/** Patterns a document must match to count as citing the one-way sync contract. */
export const MCP_SYNC_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(MCP_SYNC_DECISION);
