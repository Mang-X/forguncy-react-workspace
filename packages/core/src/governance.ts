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
 * Repo-qualified short form, e.g. `Mang-X/forguncy-react-workspace#4`. Use it
 * when a reference travels outside this repository.
 */
export const OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE = `${OWNERSHIP_AND_DEPENDENCY_DECISION.repository}${OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE}`;

/**
 * The line every ownership/dependency Spec, plan and PR is expected to carry.
 * Used by repository templates and by the governance test.
 */
export const GOVERNING_SPEC_REFERENCE_LINE = `Governing architecture Spec Issue(s): ${OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE}`;

export function formatDecisionReference(source: ArchitectureDecisionSource = OWNERSHIP_AND_DEPENDENCY_DECISION): string {
  return `${source.repository}#${source.issue} — ${source.title} (${source.url})`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const decisionIssue = String(OWNERSHIP_AND_DEPENDENCY_DECISION.issue);
const decisionRepositoryPattern = escapeForRegExp(OWNERSHIP_AND_DEPENDENCY_DECISION.repository);

/**
 * Patterns a governance document must match to count as citing the decision.
 *
 * Deliberately boundary-aware rather than substring-based: `#4` is a prefix of
 * `#40`, `#42` and so on, so `text.includes("#4")` would report a citation of a
 * completely different Issue as a citation of this one. Every accepted form is
 * anchored on this decision — a bare `#4`, or an `/issues/4` URL, belonging to
 * some other repository must not satisfy this decision's check.
 *
 * Three accepted forms:
 *
 * 1. the repo-qualified short form `owner/repo#4`, which is what
 *    `formatDecisionReference` emits. The character before `#` here is
 *    alphanumeric, so the bare `#4` pattern below cannot cover it. The form must
 *    stand alone, so a longer path merely ending in the repository name does not
 *    count either;
 * 2. a bare `#4` reference;
 * 3. `owner/repo/issues/4`.
 *
 * Exported as data so the governance test and any future lint share one
 * definition.
 */
export const DECISION_CITATION_PATTERNS: readonly RegExp[] = [
  // 1. owner/repo#4
  new RegExp(`(?:^|[^0-9A-Za-z_./-])${decisionRepositoryPattern}#${decisionIssue}(?![0-9A-Za-z_])`),
  // 2. `#4` as a whole reference, not the head of a longer number or identifier.
  new RegExp(`(?:^|[^0-9A-Za-z_#])#${decisionIssue}(?![0-9A-Za-z_])`),
  // 3. <repository>/issues/4, anchored on the exact repository path and not the
  //    head of `/issues/40`.
  new RegExp(`${decisionRepositoryPattern}/issues/${decisionIssue}(?![0-9])`),
];

export function citesDecision(text: string): boolean {
  return DECISION_CITATION_PATTERNS.some(pattern => pattern.test(text));
}
