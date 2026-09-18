/**
 * The public guarantees of a generated Cell artifact.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * #6 fixes the *shape* of the boundary (entry plus resolved dependency
 * decisions in, platform artifact out) and leaves the generated source wrapper
 * to be derived from the runtime contract. What it does not leave open is the
 * list of promises the compiler makes about its output. They are recorded here
 * as data, not as prose, for the same reason `core` records its decisions as
 * data: a guarantee that only exists in a comment cannot be asserted by a test,
 * a diagnostic or a downstream Issue.
 *
 * Every statement below is #6's own wording, kept as close to verbatim as a
 * module-level sentence allows, so that editing a promise is a deliberate edit
 * against the Spec rather than an incidental rewrite of a comment.
 *
 * `level` answers one question: could a local check establish this, or does only
 * a real Forguncy page produce the evidence? It is the same distinction
 * `core/strategy.ts` makes between `local` and `real-runtime` checks, and it
 * exists for the same reason — a green local build must never be reported as
 * Forguncy runtime compatibility (AGENTS.md rule 7).
 */

import type { DependencyCheckLevel } from "@forguncy-react-workspace/core";

export const CELL_ARTIFACT_GUARANTEE_IDS = [
  "accepted-by-react-cell-type",
  "no-unresolved-source-imports",
  "inline-dependencies-flattened",
  "host-dependencies-reference-host-identity",
  "extension-dependencies-reference-extension",
  "workspace-packages-inline-like-source",
  "deterministic-artifact",
] as const;

export type CellArtifactGuaranteeId = (typeof CELL_ARTIFACT_GUARANTEE_IDS)[number];

export interface CellArtifactGuarantee {
  readonly id: CellArtifactGuaranteeId;
  /** The promise, in the Spec's wording. */
  readonly statement: string;
  /** Whether a local check can establish the promise, or a real page must. */
  readonly level: DependencyCheckLevel;
  /** What an executed check for this guarantee actually does. */
  readonly howToCheck: string;
  /**
   * Set when the guarantee is deliberately weaker than it reads — a condition
   * the Spec attaches to it, or a case it does not cover.
   */
  readonly caveat?: string;
}

export const CELL_ARTIFACT_GUARANTEES: readonly CellArtifactGuarantee[] = [
  {
    id: "accepted-by-react-cell-type",
    statement: "Generated code is accepted by ReactCellType and exposes the required `App` entry.",
    // Acceptance is a property of the platform's validator and React's own
    // renderer, so no local check can establish it. The local half — that the
    // artifact carries no construct the platform refuses — is enforced by the
    // entry and source guards; the mounting half is not.
    level: "real-runtime",
    howToCheck:
      "Write the artifact through the designer API and load the page: the cell mounts and console error count stays at zero.",
    caveat:
      "Read the `App` half through #5's resolution order rather than literally: an `App` binding is one of three accepted entries, and this contract also emits `render(value)`, which is documented as needing no `App` at all. A source can additionally satisfy the write-time validator and still fail to mount — #5 records `app-async-function-declaration` as exactly that, so the local entry guard is necessary but not sufficient.",
  },
  {
    id: "no-unresolved-source-imports",
    statement:
      "No unresolved source-level npm imports remain in the Cell artifact, unless the runtime contract proves ReactCellType directly supports them and the project explicitly chooses to preserve them.",
    level: "local",
    howToCheck:
      "Compare the bundler's external-import report against the dependency decisions: every specifier must be accounted for by a strategy, and a relative path is workspace source that had to be flattened.",
    caveat:
      "#5's contract proves no such support: an `import` declaration is rejected by the platform's preview validator, so today the documented exception has no member.",
  },
  {
    id: "inline-dependencies-flattened",
    statement: "`inline` dependencies are flattened into Cell code.",
    level: "local",
    howToCheck:
      "Assert an `inline` package is absent from the bundler's external-import report, and that the artifact carries no sibling asset.",
    caveat:
      "Only the negative half is checkable here. The compiler is not told whether an `inline` dependency is actually imported, so it cannot require the package to appear in the bundler's inlined-package report — an unused dependency is a legitimate absence, and demanding it would refuse correct artifacts.",
  },
  {
    id: "host-dependencies-reference-host-identity",
    statement: "`host` dependencies reference host runtime identities without bundling duplicate copies.",
    level: "local",
    howToCheck:
      "Assert the decision's global is a name #5 verified as visible inside a cell *and* is an identity a dependency can be mapped onto (an injected parameter or a page global, not a wrapper-local), and that the package is neither inlined nor left external.",
    caveat:
      "A second bundled copy of a host-owned module identity is invisible locally; that half is a real-runtime check of module identity, not a local one.",
  },
  {
    id: "extension-dependencies-reference-extension",
    statement:
      "`extension` dependencies reference the corresponding extension global and add the stable `libraryId` to `frontendLibraries`.",
    level: "local",
    howToCheck:
      "Assert every extension decision contributes exactly one `libraryId` to the artifact metadata, and that the package is neither inlined as a copy nor left as a source import.",
    caveat:
      "The `libraryId` must be the stable id from `api.app.listFrontendLibraries`, not a display name; only a real project can confirm a given id resolves.",
  },
  {
    id: "workspace-packages-inline-like-source",
    statement: "Local workspace packages behave like source dependencies and are eligible for inlining.",
    level: "local",
    howToCheck:
      "Assert relative and absolute specifiers are absent from the bundler's external-import report, and that no workspace package ever reaches `frontendLibraries`.",
    caveat:
      "Exact only for file paths. A *named* workspace package (`@scope/ui`) is indistinguishable at this layer from a published one, because the artifact contract has no workspace manifest; left external it is reported as an unresolved dependency decision, which is the honest code for what the compiler can see.",
  },
  {
    id: "deterministic-artifact",
    statement: "The generated artifact is deterministic for identical inputs and configuration.",
    level: "local",
    howToCheck:
      "Assemble twice from the same input and compare the canonical serialization byte for byte; the serialization sorts collections and fixes key order rather than relying on object insertion order.",
    caveat:
      "The guarantee covers inputs and configuration, not the toolchain: a bundler whose output depends on its own version is outside this boundary. The documented exception in #6 is a non-deterministic banner, and this contract emits none.",
  },
];

export function findCellArtifactGuarantee(id: CellArtifactGuaranteeId): CellArtifactGuarantee {
  const guarantee = CELL_ARTIFACT_GUARANTEES.find(candidate => candidate.id === id);
  if (!guarantee) {
    throw new Error(`Unknown Cell artifact guarantee "${id}".`);
  }
  return guarantee;
}

/** The guarantees a local check can establish. */
export function locallyCheckableCellArtifactGuarantees(): readonly CellArtifactGuarantee[] {
  return CELL_ARTIFACT_GUARANTEES.filter(guarantee => guarantee.level === "local");
}

/**
 * The guarantees that only a real Forguncy page can establish.
 *
 * Read this list before reporting a build as compatible: every entry here is a
 * promise a green `pnpm test` says nothing about.
 */
export function realRuntimeCellArtifactGuarantees(): readonly CellArtifactGuarantee[] {
  return CELL_ARTIFACT_GUARANTEES.filter(guarantee => guarantee.level === "real-runtime");
}
