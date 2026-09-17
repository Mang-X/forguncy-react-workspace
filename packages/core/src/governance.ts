/**
 * Decision provenance.
 *
 * Decision source: GitHub Issue #4, acceptance criterion "Later Specs reference
 * this Issue when deciding ownership".
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree.
 * That removes the usual place to cite a design decision, so ownership and
 * dependency decisions need a canonical, machine-readable back-reference. It is
 * exported from `core` rather than written into a document so a later Spec,
 * Agent flow or test can assert it instead of remembering it.
 */

export interface ArchitectureDecisionSource {
  readonly repository: string;
  readonly issue: number;
  readonly title: string;
  readonly url: string;
}

export const OWNERSHIP_AND_DEPENDENCY_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 4,
  title: "Spec: application ownership boundaries and dependency strategy semantics",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/4",
};

/** Short form, e.g. `#4`. For checklists and report headers. */
export const OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE = `#${OWNERSHIP_AND_DEPENDENCY_DECISION.issue}`;

/**
 * The line every ownership/dependency Spec, plan and PR is expected to carry.
 * Used by repository templates and by the governance test.
 */
export const GOVERNING_SPEC_REFERENCE_LINE = `Governing architecture Spec Issue(s): ${OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE}`;

export function formatDecisionReference(source: ArchitectureDecisionSource = OWNERSHIP_AND_DEPENDENCY_DECISION): string {
  return `${source.repository}#${source.issue} — ${source.title} (${source.url})`;
}

/**
 * Patterns a governance document must match to count as citing the decision.
 *
 * Deliberately boundary-aware rather than substring-based: `#4` is a prefix of
 * `#40`, `#42` and so on, so `text.includes("#4")` would report a citation of a
 * completely different Issue as a citation of this one. Exported as data so the
 * governance test and any future lint share one definition.
 */
export const DECISION_CITATION_PATTERNS: readonly RegExp[] = [
  // `#4` as a whole reference, not the head of a longer number or identifier.
  new RegExp(`(?:^|[^0-9A-Za-z_#])#${OWNERSHIP_AND_DEPENDENCY_DECISION.issue}(?![0-9A-Za-z_])`),
  // `.../issues/4`, again not the head of `/issues/40`.
  new RegExp(`/issues/${OWNERSHIP_AND_DEPENDENCY_DECISION.issue}(?![0-9])`),
];

export function citesDecision(text: string): boolean {
  return DECISION_CITATION_PATTERNS.some(pattern => pattern.test(text));
}
