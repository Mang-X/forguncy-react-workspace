/**
 * Decision provenance.
 *
 * Decision sources: GitHub Issues #4 and #5, which are the architecture Specs
 * this repository's code has to obey.
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree.
 * That removes the usual place to cite a design decision, so decisions need a
 * canonical, machine-readable back-reference. They are exported from `core`
 * rather than written into a document so a later Spec, Agent flow or test can
 * assert them instead of remembering them.
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

/**
 * The verified target contract. Specs and implementations that make a claim
 * about Forguncy runtime behaviour are governed by this Issue, because it is
 * where those claims were converted into observed facts.
 */
export const RUNTIME_CONTRACT_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 5,
  title: "Research: establish the ReactCellType target/runtime contract on Forguncy 12.0.100",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/5",
};

/**
 * The dependency-decision lock Spec.
 *
 * Declared here, beside #4 and #5, because the lock is the persisted form of #4's
 * dependency strategies: every package that reads or writes a decision obeys it,
 * and `core` is where a record a second package has to reference belongs.
 *
 * Deliberately **not** added to {@link GOVERNING_ARCHITECTURE_DECISIONS}. That
 * list is the architecture Specs — the decisions that say who owns what — and #8
 * is a dependency Spec built on #4, so listing it there would relabel it as an
 * architecture decision and silently change what the list means. A module that
 * also answers to #8 composes its own list from this record; see
 * `LOCK_GOVERNING_DECISIONS`.
 */
export const DEPENDENCY_LOCK_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 8,
  title: "Spec: reproducible dependency decisions and `fgc.lock.json`",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
};

/**
 * The dependency-selection and probe-protocol Spec.
 *
 * Declared here beside #4, #5 and #8, for the same reason #8 is: it is a
 * dependency Spec built on #4 rather than an architecture decision, so adding it
 * to {@link GOVERNING_ARCHITECTURE_DECISIONS} would relabel it and silently
 * change what that list means (it would start claiming that an architecture
 * decision had been made about library selection). A module that also answers to
 * it composes its own list; see `SELECTION_GOVERNING_DECISIONS`.
 *
 * It is separate from {@link DEPENDENCY_LOCK_DECISION} because the two answer
 * different questions: #8 says how a decision is *persisted and invalidated*,
 * while #16 says how a decision is *reached and evidenced*. A selection can be
 * perfectly reproducible and still be unsupported — which is exactly the failure
 * mode that a probe protocol exists to prevent.
 */
export const DEPENDENCY_SELECTION_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 16,
  title: "Spec: Agent-driven dependency selection and empirical compatibility probe",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/16",
};

/**
 * The host module bridge Spec.
 *
 * Declared here beside #4, #5, #8 and #16, for the same reason those two are: it
 * is a dependency Spec built on #4 rather than an architecture decision, so adding
 * it to {@link GOVERNING_ARCHITECTURE_DECISIONS} would relabel it and silently
 * change what that list means.
 *
 * It is declared in `core` rather than in the package that generates bridge code
 * because two packages have to agree on it and only one of them can own it. The
 * compiler renders the bridge; the dependency resolver audits a lock's `host`
 * records against the same mapping table, and the resolver may not depend on the
 * compiler — the compiler's input is the resolver's output. `core` is the package
 * both already depend on, and it already holds the facts the table is checked
 * against (#5's user-scope bindings and preset chains). The
 * `@forguncy-react-workspace/dependency-resolver` package shipped a placeholder
 * table whose own comment says exactly this ("the real host-bridge table replaces
 * `DEFAULT_HOST_BRIDGE_MANIFEST` once #9 lands"); #9 lands it here.
 */
export const HOST_BRIDGE_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 9,
  title: "Spec: host module bridge for React, ReactDOM, antd and built-in globals",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/9",
};

/**
 * The `extension` externals Spec.
 *
 * Declared here beside #4, #5, #8, #16 and #9, for the same reason those are: it is
 * a dependency Spec built on #4 rather than an architecture decision, so adding it
 * to {@link GOVERNING_ARCHITECTURE_DECISIONS} would relabel it and silently change
 * what that list means.
 *
 * It is declared in `core` rather than in the package that generates the interposed
 * modules because the mapping table is read by more than that package — the
 * `extension` decision's own shape lives in `core` (#8), the `frontendLibraries`
 * metadata shape lives in `core` (#5), and #24's conformance audit answers to the
 * same three fields while being unable to depend on the compiler. `core` is the
 * package they all already depend on and the place the facts the table is checked
 * against (#5's user-scope bindings and preset chains, #9's host globals) already
 * live.
 */
export const EXTENSION_EXTERNALS_DECISION: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 12,
  title: "Spec: `extension` dependencies as external modules + `frontendLibraries` metadata",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/12",
};

/** Every governing architecture Spec, in the order a document should cite them. */
export const GOVERNING_ARCHITECTURE_DECISIONS: readonly ArchitectureDecisionSource[] = [
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  RUNTIME_CONTRACT_DECISION,
];

/** Short form, e.g. `#4`. For checklists and report headers. */
export function decisionReference(source: ArchitectureDecisionSource): string {
  return `#${source.issue}`;
}

/**
 * Repo-qualified short form, e.g. `Mang-X/forguncy-react-workspace#5`. Use it
 * when a reference travels outside this repository.
 */
export function qualifiedDecisionReference(source: ArchitectureDecisionSource): string {
  return `${source.repository}${decisionReference(source)}`;
}

export const OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE = decisionReference(OWNERSHIP_AND_DEPENDENCY_DECISION);

export const OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE = qualifiedDecisionReference(
  OWNERSHIP_AND_DEPENDENCY_DECISION,
);

export const RUNTIME_CONTRACT_DECISION_REFERENCE = decisionReference(RUNTIME_CONTRACT_DECISION);

export const RUNTIME_CONTRACT_DECISION_QUALIFIED_REFERENCE = qualifiedDecisionReference(RUNTIME_CONTRACT_DECISION);

export const DEPENDENCY_LOCK_DECISION_REFERENCE = decisionReference(DEPENDENCY_LOCK_DECISION);

export const DEPENDENCY_LOCK_DECISION_QUALIFIED_REFERENCE = qualifiedDecisionReference(DEPENDENCY_LOCK_DECISION);

export const DEPENDENCY_SELECTION_DECISION_REFERENCE = decisionReference(DEPENDENCY_SELECTION_DECISION);

export const DEPENDENCY_SELECTION_DECISION_QUALIFIED_REFERENCE = qualifiedDecisionReference(
  DEPENDENCY_SELECTION_DECISION,
);

export const HOST_BRIDGE_DECISION_REFERENCE = decisionReference(HOST_BRIDGE_DECISION);

export const HOST_BRIDGE_DECISION_QUALIFIED_REFERENCE = qualifiedDecisionReference(HOST_BRIDGE_DECISION);

export const EXTENSION_EXTERNALS_DECISION_REFERENCE = decisionReference(EXTENSION_EXTERNALS_DECISION);

export const EXTENSION_EXTERNALS_DECISION_QUALIFIED_REFERENCE =
  qualifiedDecisionReference(EXTENSION_EXTERNALS_DECISION);

/**
 * The line every ownership/dependency Spec, plan and PR is expected to carry.
 *
 * Deliberately still single-Spec: it is the reference line for the ownership and
 * dependency decision specifically, and documents that also answer to the
 * runtime contract decision should use {@link GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE}.
 */
export const GOVERNING_SPEC_REFERENCE_LINE = `Governing architecture Spec Issue(s): ${OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE}`;

/** The full reference line for a document governed by every architecture Spec. */
export const GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine();

export function formatGoverningSpecReferenceLine(
  sources: readonly ArchitectureDecisionSource[] = GOVERNING_ARCHITECTURE_DECISIONS,
): string {
  return `Governing architecture Spec Issue(s): ${sources.map(decisionReference).join(", ")}`;
}

export function formatDecisionReference(source: ArchitectureDecisionSource = OWNERSHIP_AND_DEPENDENCY_DECISION): string {
  return `${source.repository}#${source.issue} — ${source.title} (${source.url})`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patterns a governance document must match to count as citing `source`.
 *
 * Deliberately boundary-aware rather than substring-based: `#4` is a prefix of
 * `#40`, `#42` and so on, so `text.includes("#4")` would report a citation of a
 * completely different Issue as a citation of this one. Every accepted form is
 * anchored on the decision — a bare `#4`, or an `/issues/4` URL, belonging to
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
 * Generalised to any decision so that a second governing Spec does not have to
 * duplicate the boundary reasoning above and get it subtly wrong.
 */
export function citationPatternsFor(source: ArchitectureDecisionSource): readonly RegExp[] {
  const issue = String(source.issue);
  const repositoryPattern = escapeForRegExp(source.repository);
  return [
    // 1. owner/repo#4
    new RegExp(`(?:^|[^0-9A-Za-z_./-])${repositoryPattern}#${issue}(?![0-9A-Za-z_])`),
    // 2. `#4` as a whole reference, not the head of a longer number or identifier.
    new RegExp(`(?:^|[^0-9A-Za-z_#])#${issue}(?![0-9A-Za-z_])`),
    // 3. <repository>/issues/4, anchored on the exact repository path and not the
    //    head of `/issues/40`.
    new RegExp(`${repositoryPattern}/issues/${issue}(?![0-9])`),
  ];
}

/**
 * Patterns a governance document must match to count as citing the ownership and
 * dependency decision. Exported as data so the governance test and any future
 * lint share one definition.
 */
export const DECISION_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(OWNERSHIP_AND_DEPENDENCY_DECISION);

export const RUNTIME_CONTRACT_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(RUNTIME_CONTRACT_DECISION);

export const DEPENDENCY_LOCK_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(DEPENDENCY_LOCK_DECISION);

export const DEPENDENCY_SELECTION_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(DEPENDENCY_SELECTION_DECISION);

export const HOST_BRIDGE_CITATION_PATTERNS: readonly RegExp[] = citationPatternsFor(HOST_BRIDGE_DECISION);

export const EXTENSION_EXTERNALS_CITATION_PATTERNS: readonly RegExp[] =
  citationPatternsFor(EXTENSION_EXTERNALS_DECISION);

export function citesDecision(
  text: string,
  source: ArchitectureDecisionSource = OWNERSHIP_AND_DEPENDENCY_DECISION,
): boolean {
  return citationPatternsFor(source).some(pattern => pattern.test(text));
}

/** True when a document cites every governing architecture Spec. */
export function citesEveryArchitectureDecision(
  text: string,
  sources: readonly ArchitectureDecisionSource[] = GOVERNING_ARCHITECTURE_DECISIONS,
): boolean {
  return sources.every(source => citesDecision(text, source));
}
