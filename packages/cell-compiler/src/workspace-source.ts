/**
 * #14's contract: a local workspace package is *source*, and source is flattened.
 *
 * Decision source: GitHub Issue #14 — "Spec: local workspace packages are source
 * dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14), which is itself
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 *
 * #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/5) is cited although
 * nothing below rests on a runtime observation — this is entirely a contract about
 * compilation. It is cited because it is the architecture decision that bounds what
 * a cell may assume about the page, and it is *why* the sharing invariant is safe to
 * state in this direction: a workspace package is inlined into one cell, so it can
 * never be one of the identities the page installs once — which is the distinction
 * `host` and `extension` exist to preserve, and the reason this contract's only
 * real-runtime guarantee is the anti-claim rather than the claim.
 *
 * #6 states guarantee 6 as one sentence — "Local workspace packages behave like
 * source dependencies and are eligible for inlining" — and records in its caveat
 * that it cannot check it: "a *named* workspace package (`@scope/ui`) is
 * indistinguishable at this layer from a published one, because the artifact
 * contract has no workspace manifest". #14 is the decision that supplies the
 * missing input. With a manifest, the three questions #6 could only answer for
 * relative paths become exact:
 *
 * 1. is this specifier workspace source, a file inside a package, or a published
 *    dependency?
 * 2. did workspace source leak into the artifact as something the page would have
 *    to load (a surviving import) or as a library the page would have to install
 *    (a `frontendLibraries` entry)?
 * 3. which published dependencies does workspace source bring with it, and does
 *    each of them have a decision?
 *
 * **What is deliberately not here.** No resolver and no filesystem access. #6
 * requires the toolchain to use Vite+/Rolldown rather than to invent a second
 * module resolver, and the workspace graph is exactly what the package manager
 * and the bundler already resolved — so it arrives as an argument, in the shape
 * #14 describes ("resolution follows the Vite+/pnpm workspace graph"), and nothing
 * in this file reads `node_modules`, `pnpm-workspace.yaml` or a `package.json`.
 * Supplying the graph from those sources is the project-configuration work (#26,
 * #28).
 *
 * Wiring this audit into `assembleCellArtifact` is also not here, for the reason
 * `host-bridge.ts` gives about its own diagnostics: the compiler MVP (#7) decides
 * how the two vocabularies compose in one report, and asserting a workspace
 * diagnostic through `CellArtifactDiagnostic` first would decide it by accident.
 *
 * ## Three kinds of module id, and why the walk must tell them apart
 *
 * A record's `imports` may be derived from source, so it contains file paths as well
 * as module ids. `./Button`, `../utils` and `./styles.css` are files inside some
 * package: they resolve to nothing the dependency pipeline could decide, and asking
 * for a decision about one would make a correct source-derived graph fail. So
 * {@link classifyWorkspaceModule} answers the question once, in three parts —
 * `workspace-package`, `source-file`, `external-package` — and every check that walks
 * imports branches on it instead of on "is this in the graph". The path test itself is
 * `artifact.isSourceSpecifier`, imported rather than restated, so the artifact layer
 * and this one cannot drift into two definitions of "this is a file".
 *
 * The limit that remains is the same one #6 records, one step further along: a
 * specifier a bundler resolves through an alias (`#internal`, a `resolve.alias`
 * target) is not a path and not in the graph, so it is classified
 * `external-package` and a decision is required for it. Carrying the id the bundler
 * resolves, rather than the alias, is what makes a graph accurate — and choosing
 * that id is the project-configuration work (#26, #28), not something a module-id
 * graph can recover on its own.
 *
 * ## What this contract cannot prove, and says so
 *
 * `moduleIdentity: { kind: "delegated", via }` is checkable only as far as *declared
 * and backed*: `via` is not workspace source, it is imported by the package, and it
 * is provided by the page (`host`) or an extension (`extension`). It is **not**
 * evidence that the package's state actually lives in `via`. A package can import
 * the host's React and still run `React.createContext(null)` itself, or keep its own
 * module-scope cache, and each inlined Cell then holds a private instance while every
 * check here passes. Nothing in a module-id graph distinguishes declaring a value
 * from importing one, so the audit reports each delegation with
 * {@link WorkspaceDelegationAssessment.stateSharingEstablished} — literally `false`,
 * as a type-level fact rather than a sentence in a comment — and the guarantee that
 * the sharing really happens is the real-runtime one, not this one. An "everything
 * passed" audit therefore never reads as "your state is shared".
 *
 * ## What the caller states, and what this audit therefore refuses to guess
 *
 * Every check below needs an input, and an input that is absent is *not* the same
 * as an input that is empty. The rule #9 had to be taught twice, and which
 * `decision-conformance.ts` states for its extension catalog, applies to all five:
 *
 * | absent | means | and therefore |
 * | --- | --- | --- |
 * | `workspace` | the caller did not state a workspace graph | every workspace check abstains, and `graphActivation` is `"unstated"` — which is the #6 behaviour, not a claim that no workspace package is involved |
 * | `dependencies` | the decision list is not available here | the decision-dependent checks abstain; an **empty** array means "there are no decisions", and every dependency reached through workspace source is then reported. A delegation that needs those checks is reported as `undetermined` with `decision-list-absent`, rather than dropped or called `backed` |
 * | `entryModuleIds` | the caller did not say what the cell imports | no closure is traced and `usage` is `"unstated"`; cycles and transitive dependencies are not claimed to be absent |
 * | a package's `imports` | that package's outgoing edges are unknown | the walk does not invent an edge, and a delegation on that package is `undetermined` with `package-imports-absent` — the reachability check never ran, so `backed` would claim something nobody verified |
 *
 * A guarantee that only exists in a comment cannot be asserted, so each of these
 * four rows has a regression test in `workspace-source.test.ts`.
 *
 * ## Determinism is a property of the answer, not of the walk
 *
 * Every input that can repeat itself is ordered before it is used: the graph by raw
 * content, so no two records a caller wrote differently can tie; the closure, its
 * modules and its cycles; and diagnostics by (code, subject) after collapsing. Ordering
 * is not resolution, though — where two inputs *disagree* rather than merely repeat, the
 * audit says so instead of picking one: a graph that declares one package twice is
 * `workspace-graph-conflict`, and a decision list with two records for the delegated
 * module is `conflicting-module-identity-decisions` rather than "the first record wins".
 * A reversal of any input array is a regression test.
 */

import type {
  DependencyCheckLevel,
  DependencyDecision,
  FrontendLibraryReference,
} from "@forguncy-react-workspace/core";

import { dependencyDecisionsFor, findDependencyDecision, isSourceSpecifier, packageNameOfSpecifier } from "./artifact";
import type { CellArtifactFixOwner } from "./diagnostics";

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

/**
 * #14's output semantics, in one sentence, for the place a person will read it
 * next: a cell imports a workspace package during development, and the artifact it
 * ships contains that source inlined. The package boundary exists while the code
 * is written and does not exist on the page.
 *
 * This is the sentence `AGENTS.md` carries and
 * `workspace-source.test.ts` asserts there, because the failure it prevents is a
 * *reading* failure: an Agent that assumes `@app/ui` is loaded once on the page
 * will reach for cross-cell state that no copy of the source can provide.
 */
export const WORKSPACE_SOURCE_SHARING_INVARIANT =
  "Development-stage source sharing does not imply deployed module sharing.";

/**
 * What #14 says about a React Context defined in a workspace package.
 *
 * Kept as a separate statement rather than folded into the invariant because it is
 * the one case where the invariant is *counter-intuitive*: two cells importing the
 * same `ThemeContext` are two declarations of it, so a provider in one cell is
 * invisible to the other.
 *
 * The second sentence is the sharp half, and it is the one a reader is most likely to
 * get wrong: bringing the host's React into the package is not enough. The declaration
 * still happens inside each inlined copy, so `React.createContext(null)` at module
 * scope in a workspace package produces one Context object *per cell* — the object
 * itself has to come from a module the page loads once.
 */
export const WORKSPACE_CONTEXT_SEMANTICS =
  "A React Context declared in a workspace package is local to the Cell's React tree: each cell that inlines the package evaluates that module separately, so a Context created there is a different object per cell, and a provider mounted in one cell is invisible to another. Sharing a Context across cells requires the Context object itself to come from a module the page loads once (a `host` module) or an extension loads once (an `extension` module). Importing React from the host does not do it: the declaration still runs inside each cell.";

export const WORKSPACE_SOURCE_REUSE_CLASS_IDS = [
  "types",
  "pure-functions-and-constants",
  "components-and-hooks",
  "react-context",
  "module-scope-mutable-state",
  "module-initialisation-side-effects",
] as const;

export type WorkspaceSourceReuseClassId = (typeof WORKSPACE_SOURCE_REUSE_CLASS_IDS)[number];

/**
 * Whether reusing a kind of workspace source as source is enough on its own.
 *
 * - `always-safe` — #14's own wording: "Shared TypeScript types and pure functions
 *   are always safe candidates for source reuse." Nothing exists at runtime that
 *   two copies could disagree about.
 * - `cell-local` — safe to reuse, and nothing is shared. A component's props and
 *   state are per mount, and a Context object is per declaration; this is what
 *   those things already mean, so it is a statement about the *page*, not a
 *   restriction on the source.
 * - `delegated-required` — the source relies on state that is only correct if it
 *   is one instance for the whole page, so #14 requires that state to be
 *   "intentionally delegated to a host/extension strategy". This is the class the
 *   `moduleIdentity` guard below enforces.
 */
export type WorkspaceSourceReuseSafety = "always-safe" | "cell-local" | "delegated-required";

export interface WorkspaceSourceReuseClass {
  readonly id: WorkspaceSourceReuseClassId;
  readonly label: string;
  readonly safety: WorkspaceSourceReuseSafety;
  /** Why, in one sentence, in the Spec's terms. */
  readonly statement: string;
}

/**
 * The classification #14 makes, as data.
 *
 * Data rather than prose because it is the thing a selection step (#16) or an
 * Agent Skill (#18) has to consult before moving code into a shared package, and
 * because two classes of it are enforceable: everything marked
 * `delegated-required` is the set the `moduleIdentity` guard exists to check.
 */
export const WORKSPACE_SOURCE_REUSE_CLASSES: readonly WorkspaceSourceReuseClass[] = [
  {
    id: "types",
    label: "Shared TypeScript types and type-only imports",
    safety: "always-safe",
    statement:
      "Erased before the artifact runs, so there is no module, no instance and nothing that two cells could share or fail to share.",
  },
  {
    id: "pure-functions-and-constants",
    label: "Pure functions and constants",
    safety: "always-safe",
    statement:
      "A second copy computes the same answer from the same arguments, which is #14's reason for calling this class an always-safe reuse candidate.",
  },
  {
    id: "components-and-hooks",
    label: "React components and hooks",
    safety: "cell-local",
    statement:
      "Safe to reuse as source: the component function is inlined per cell, and its props, state, effects and refs belong to each mount rather than to the package.",
  },
  {
    id: "react-context",
    label: "A React Context declared in the package",
    safety: "cell-local",
    statement: WORKSPACE_CONTEXT_SEMANTICS,
  },
  {
    id: "module-scope-mutable-state",
    label: "Module-scope mutable state (caches, registries, counters, subscriptions)",
    safety: "delegated-required",
    statement:
      "Each cell that inlines the package evaluates the module separately, so the state is per cell — #14's 'must not rely on cross-Cell module singleton identity unless that state is intentionally delegated to a host/extension strategy'. Delegating means the state itself lives in a module the page or an extension loads once, and the package says so with `moduleIdentity: { kind: \"delegated\", via }`; importing that module and then keeping your own copy is not a delegation, and nothing local can tell the two apart.",
  },
  {
    id: "module-initialisation-side-effects",
    label: "Module-initialisation side effects (global registration, patches, listeners)",
    safety: "delegated-required",
    statement:
      "Inlining runs the initialisation once per cell that inlines it, so a page-level side effect happens once per cell instead of once per page; the same delegation rule applies.",
  },
];

const REUSE_CLASS_BY_ID: ReadonlyMap<WorkspaceSourceReuseClassId, WorkspaceSourceReuseClass> = new Map(
  WORKSPACE_SOURCE_REUSE_CLASSES.map(entry => [entry.id, entry]),
);

export function findWorkspaceSourceReuseClass(id: WorkspaceSourceReuseClassId): WorkspaceSourceReuseClass {
  const entry = REUSE_CLASS_BY_ID.get(id);
  if (entry === undefined) {
    throw new Error(`Unknown workspace source reuse class "${id}".`);
  }
  return entry;
}

/**
 * The reuse classes that the `moduleIdentity` guard is responsible for.
 *
 * Exported so a test can assert the two stay in step: a class that requires
 * delegation and no check that enforces it would be a rule in a table, which is
 * the failure mode this repository's reviews keep naming.
 */
export function workspaceReuseClassesRequiringDelegation(): readonly WorkspaceSourceReuseClass[] {
  return WORKSPACE_SOURCE_REUSE_CLASSES.filter(entry => entry.safety === "delegated-required");
}

// ---------------------------------------------------------------------------
// The workspace graph
// ---------------------------------------------------------------------------

/**
 * Whether a workspace package's state is shared across cells, and what makes it so.
 *
 * - `cell-local` — the default, and the meaning of an absent `moduleIdentity`.
 *   Each cell inlines its own copy, so module-scope state, a Context object and a
 *   cache are per cell. This is not a guess about an unstated input: it is #14's
 *   output semantics, which say a consumed workspace package "should not attempt to
 *   load another workspace package at runtime".
 * - `delegated` — the package relies on cross-cell module identity and #14 permits
 *   that only when the state is "intentionally delegated to a host/extension
 *   strategy". `via` names the module whose identity is delegated, which is the
 *   part that makes the claim checkable: the package has to import it, and it has
 *   to be a module the page or an extension actually provides.
 *
 * Absence means `cell-local`, so a package that relies on shared state without
 * declaring it is invisible to this contract — see the caveat on
 * `workspace-module-identity-is-delegated`.
 */
export type WorkspaceModuleIdentity =
  | { readonly kind: "cell-local" }
  | { readonly kind: "delegated"; readonly via: string };

/**
 * How far the local checks got with one declared delegation.
 *
 * - `backed` — every check ran and passed. Still says nothing about where the state
 *   lives; see {@link WorkspaceDelegationAssessment}.
 * - `unbacked` — a check ran and refused the declaration;
 *   `undelegated-workspace-module-identity` says which.
 * - `undetermined` — not every check ran, or the input contradicts itself, so nothing
 *   was refused and nothing was confirmed. Carries the {@link WorkspaceDelegationGap}s
 *   behind it, because "undetermined" without a reason is as unhelpful as "backed"
 *   without a check.
 */
export type WorkspaceDelegationStatus = "backed" | "unbacked" | "undetermined";

/**
 * Why a delegation's checks could not reach a verdict.
 *
 * Two of these are abstentions — the caller did not state an input — and the third is
 * the input contradicting itself. All three are the audit refusing to guess; none of
 * them is a finding about the declaration, which is why they travel as gaps in an
 * `undetermined` assessment rather than as diagnostics.
 */
export type WorkspaceDelegationGap =
  /** No decision list was supplied, so nothing could say whether the page provides `via`. */
  | "decision-list-absent"
  /** The package's `imports` were not stated, so reachability was never checked. */
  | "package-imports-absent"
  /**
   * More than one decision governs `via`, so there is no single provider.
   *
   * The decision list contradicts itself, which is not this declaration's fault: #6's
   * artifact audit calls the same list `unresolved-dependency-decision` ("so there is
   * no single strategy to compile against"). Reporting the delegation as `backed` on
   * the strength of one arbitrarily chosen record would have this audit announcing a
   * provider for an artifact that cannot be compiled.
   */
  | "decision-list-conflicted";

/**
 * Whether this audit established that the package's shared state actually lives in
 * `via`. Always `false`, and the literal type is the point — it cannot become `true`
 * without a type change.
 *
 * A module-id graph records which modules a package imports, never where a value is
 * declared, so `import React from "react"` beside a package-local
 * `React.createContext(null)` or `new Map()` satisfies every check this contract can
 * make while each inlined Cell keeps its own copy. Anything stronger would be a
 * declaration with no guard behind it, which is the shape this repository's reviews
 * keep rejecting; the sharing half is
 * `cells-do-not-share-workspace-module-state`, which only a real page with two cells
 * can establish.
 */
export type WorkspaceStateSharingEstablished = false;

/**
 * What the audit established about one declared delegation.
 *
 * `status` is everything the local checks can decide, and
 * {@link WorkspaceStateSharingEstablished} is the part they cannot. Reported on every
 * delegation the audit examined — including the ones with nothing wrong — so a report
 * with no diagnostics cannot be read as "your state is shared".
 */
export type WorkspaceDelegationAssessment =
  | {
      readonly package: string;
      /** The module the package says its shared identity comes from, as declared. */
      readonly via: string;
      readonly status: "backed";
      readonly stateSharingEstablished: WorkspaceStateSharingEstablished;
    }
  | {
      readonly package: string;
      readonly via: string;
      readonly status: "unbacked";
      readonly stateSharingEstablished: WorkspaceStateSharingEstablished;
    }
  | {
      readonly package: string;
      readonly via: string;
      readonly status: "undetermined";
      /** Present and non-empty by construction: an undetermined verdict owes a reason. */
      readonly gaps: readonly WorkspaceDelegationGap[];
      readonly stateSharingEstablished: WorkspaceStateSharingEstablished;
    };

/**
 * One package in the pnpm/Vite+ workspace graph.
 *
 * `directory` is used in diagnostics and is required to be workspace-relative:
 * this repository's portability rule is that a machine-specific path must not
 * travel, and a graph is the natural place one would leak from.
 */
export interface WorkspacePackageRecord {
  /** The name source imports, e.g. `@app/ui`. */
  readonly name: string;
  /** Where the package lives, workspace-relative, for diagnostics only. Never resolved. */
  readonly directory: string;
  /**
   * The module ids this package imports, however the caller derived them — a
   * manifest's dependencies or its source imports.
   *
   * Absent means the caller did not state them, and the walk then treats the
   * package as having no known outgoing edges rather than as having none. A
   * manifest-derived graph is coarser than a source-derived one and can therefore
   * miss a cycle that only exists between files; the contract records the edges it
   * is given and does not claim to have discovered them itself.
   */
  readonly imports?: readonly string[];
  /** Whether the package relies on cross-cell module identity. Absent means `cell-local`. */
  readonly moduleIdentity?: WorkspaceModuleIdentity;
}

export interface WorkspaceGraph {
  readonly packages: readonly WorkspacePackageRecord[];
}

/**
 * The graph, indexed for lookup, in a canonical order.
 *
 * A plain record plus free functions rather than methods, matching
 * `core`'s ownership table: the index is data a report can print, and the lookup
 * rules stay in one place per question.
 */
export interface WorkspaceGraphIndex {
  /**
   * The records the index resolves to, canonically ordered by (name, directory) so
   * two indexes of one graph are identical.
   *
   * One record per name: a duplicated declaration is reported and the extra record is
   * not here, so every entry in this list is reachable by lookup and no entry is a
   * record nothing can resolve to.
   */
  readonly packages: readonly WorkspacePackageRecord[];
  readonly byName: ReadonlyMap<string, WorkspacePackageRecord>;
}

/** The workspace-relative form `directory` is required to take. */
function isWorkspaceRelativeDirectory(directory: string): boolean {
  const normalized = directory.replace(/\\/g, "/").trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/")) return false;
  // A Windows drive-absolute path, which is machine-specific in the same way.
  if (/^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/** A name source can import. Deliberately not npm's registry policy, only what changes resolution here. */
function isImportablePackageName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith(".") || trimmed.startsWith("/")) return false;
  return !/\s/.test(trimmed);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export interface WorkspaceGraphIndexResult {
  readonly index: WorkspaceGraphIndex;
  /** What is wrong with the graph itself, in a fixed order. */
  readonly diagnostics: readonly WorkspaceSourceDiagnostic[];
}

/**
 * Indexes a workspace graph, reporting the records it cannot use.
 *
 * Never throws, and never drops a record silently. An unnameable record is skipped
 * because there is no way to look it up, and that is reported; a record whose
 * `directory` is absolute is kept because it still answers the resolution
 * question, and the portability problem is reported separately.
 *
 * A duplicated name keeps the canonical-first record and reports both directories:
 * the ambiguity is in the project's declarations, and picking whichever the
 * caller happened to list first would make the answer depend on array order.
 */
export function indexWorkspaceGraph(graph: WorkspaceGraph): WorkspaceGraphIndexResult {
  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  const candidates: WorkspacePackageRecord[] = [];

  for (const record of graph.packages) {
    const subject = record.name.trim().length > 0 ? record.name : record.directory;

    if (!isImportablePackageName(record.name)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", subject, {
          detail: `"${record.name}" cannot be a workspace package name: source cannot import it, so no decision about it would ever be reached. A workspace package is named, not pathed.`,
        }),
      );
      continue;
    }

    if (!isWorkspaceRelativeDirectory(record.directory)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", subject, {
          detail: `The record's directory "${record.directory}" is not workspace-relative. It is carried into diagnostics, and this repository's portability rule is that a machine-specific path must not travel.`,
        }),
      );
    }

    if (record.moduleIdentity?.kind === "delegated" && !isImportablePackageName(record.moduleIdentity.via)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("undelegated-workspace-module-identity", subject, {
          detail: `The delegation names "${record.moduleIdentity.via}", which is not an importable module id, so nothing can provide the identity it claims to delegate to.`,
        }),
      );
    }

    candidates.push(record);
  }

  // Canonical order over the record's *raw* content, because two records can share a
  // name and a directory and still disagree about `imports` or `moduleIdentity`. A
  // comparator that returned 0 for them would leave the winner to JavaScript's stable
  // sort — that is, to the caller's array order — and the index would then retain a
  // different record depending on it. Normalising the imports would be the other way to
  // avoid the tie, and it is the wrong one here: it would make `["react", "react"]` and
  // `["react"]` the same key, so the retained record would again depend on which came
  // first, while the diagnostic below still has to tell them apart.
  const ordered = [...candidates].sort((a, b) => compareStrings(recordSelectionKey(a), recordSelectionKey(b)));

  const byName = new Map<string, WorkspacePackageRecord>();
  for (const record of ordered) {
    const existing = byName.get(record.name);
    if (existing !== undefined) {
      const equivalent = recordsAreEquivalent(existing, record);
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", record.name, {
          detail: equivalent
            ? `Two records declare this package equivalently ("${existing.directory}" and "${record.directory}"), so the graph is resolved to one of them by content order and nothing downstream changes. The duplicate declaration is still a project declaration problem.`
            : `Two records declare this package differently ("${existing.directory}" and "${record.directory}"), so which one an import of "${record.name}" reaches changes the answer: a name is resolved by content order, but the collision means the graph does not describe one package.`,
        }),
      );
      continue;
    }
    byName.set(record.name, record);
  }

  return {
    // The index's own list rather than every candidate: a record nothing can resolve
    // to is not part of the index, and it is reported instead of silently dropped.
    // `Map` preserves insertion order and the candidates are sorted, so this stays
    // canonical.
    index: { packages: [...byName.values()], byName },
    diagnostics: orderWorkspaceSourceDiagnostics(diagnostics),
  };
}

/**
 * The whole of a record, raw, as a sort key.
 *
 * Raw rather than normalised, so that two records a caller wrote differently are
 * ordered by what they wrote and never tie. A tie then means the two records are the
 * same text, which is the only case where keeping either can change nothing: see
 * {@link recordsAreEquivalent} for the weaker question the diagnostic asks.
 *
 * `undefined` and `[]` are distinguished on purpose. They are not the same declaration —
 * one says "these are the imports", the other says "nobody said" — and the delegation
 * check answers differently for them, so they must not compare equal.
 */
function recordSelectionKey(record: WorkspacePackageRecord): string {
  const imports = record.imports === undefined ? "\u0002unstated" : record.imports.join("\u0001");
  return [record.name, record.directory, imports, identityKey(record)].join("\u0000");
}

/**
 * A record's identity declaration, with `cell-local` and an absent field folded together.
 *
 * They are the same declaration by the type's own definition, so nothing may distinguish
 * them — not the sort key, and not the equivalence the duplicate diagnostic reports.
 */
function identityKey(record: WorkspacePackageRecord): string {
  return record.moduleIdentity === undefined || record.moduleIdentity.kind === "cell-local"
    ? "cell-local"
    : `delegated\u0001${record.moduleIdentity.via}`;
}

/**
 * Whether two records say the same thing about a package, once spelling differences are
 * set aside.
 *
 * The question the duplicate diagnostic asks, and a deliberately weaker one than the
 * sort key: two records that list the same imports in a different order, or list one
 * twice, are equivalent — the graph computes edges through a set and the reachability
 * check is a membership test, so every answer this contract gives is the same. The
 * distinction matters for the report, not for the resolution: a reader of "two records
 * declare this package" needs to know whether the duplicate changed anything.
 *
 * `undefined` and `[]` are still different, for the reason {@link recordSelectionKey}
 * gives.
 */
function recordsAreEquivalent(a: WorkspacePackageRecord, b: WorkspacePackageRecord): boolean {
  if (a.directory !== b.directory) return false;
  if ((a.imports === undefined) !== (b.imports === undefined)) return false;

  const normalized = (imports: readonly string[]): string =>
    [...new Set(imports)].sort(compareStrings).join("\u0001");
  return normalized(a.imports ?? []) === normalized(b.imports ?? []) && identityKey(a) === identityKey(b);
}

/**
 * The workspace package a specifier resolves to, or `undefined` for a published
 * dependency or a file path.
 *
 * Exact first, then the specifier's package: `@app/ui/theme.css` is workspace
 * source because `@app/ui` is. The precedence is the same question
 * `artifact.findDependencyDecision` answers for decisions, and it is asked here
 * through {@link packageNameOfSpecifier} rather than through a second
 * implementation of "what package is this".
 */
export function workspacePackageFor(
  index: WorkspaceGraphIndex,
  specifier: string,
): WorkspacePackageRecord | undefined {
  const exact = index.byName.get(specifier);
  if (exact !== undefined) return exact;

  const packageName = packageNameOfSpecifier(specifier);
  // A file path or a bare name is its own package name, so there is no second
  // lookup left to do — and `packageNameOfSpecifier` returns the input for both.
  if (packageName === specifier) return undefined;
  return index.byName.get(packageName);
}

/** True when a specifier is workspace source rather than a published dependency. */
export function isWorkspaceSourceSpecifier(index: WorkspaceGraphIndex, specifier: string): boolean {
  return workspacePackageFor(index, specifier) !== undefined;
}

export const WORKSPACE_MODULE_KINDS = ["workspace-package", "source-file", "external-package"] as const;

export type WorkspaceModuleKind = (typeof WORKSPACE_MODULE_KINDS)[number];

/**
 * What a module id is, as far as a workspace graph can tell.
 *
 * Three answers rather than two, because the walk needs them: a
 * `workspace-package` is an edge to follow and gets inlined, a `source-file` is
 * neither an edge nor a dependency to decide (it is a file inside one of the
 * packages, and whether it is internal to *this* package or another one is not a
 * question the dependency pipeline can act on), and an `external-package` is a
 * published dependency that needs a decision.
 *
 * Two answers would make a source-derived graph unusable: `./Button` is not in the
 * graph, so "not a workspace package" would silently mean "a published dependency",
 * and the audit would demand a dependency decision for a component file next to it.
 *
 * The path test is `artifact.isSourceSpecifier`, the same function the artifact
 * boundary uses to tell a leftover import from an unresolved decision, so the two
 * layers cannot end up with two definitions of "this is a file".
 */
export function classifyWorkspaceModule(
  index: WorkspaceGraphIndex,
  specifier: string,
): WorkspaceModuleKind {
  if (workspacePackageFor(index, specifier) !== undefined) return "workspace-package";
  return isSourceSpecifier(specifier) ? "source-file" : "external-package";
}

// ---------------------------------------------------------------------------
// The source closure
// ---------------------------------------------------------------------------

/**
 * A published module id reached through workspace source, and who pulls it in.
 *
 * Published module ids only. A file inside a package (`./Button`, `../utils`,
 * `./styles.css`) is not one — it resolves to nothing the dependency pipeline could
 * decide — and neither is a workspace package, which is source rather than a
 * dependency. Collecting either would make the audit demand a decision for something
 * that must never have one.
 */
export interface WorkspaceExternalModule {
  readonly moduleId: string;
  /** The workspace packages importing it, canonical order. This is the import chain for a diagnostic. */
  readonly importedBy: readonly string[];
}

/**
 * One dependency cycle, as the chain that closes it.
 *
 * `chain` starts and ends with the same package (`["@app/a", "@app/b", "@app/a"]`)
 * so the reader sees the closure, and its first element is the lexicographically
 * smallest member of the cycle so two traversals of one graph cannot report the
 * same cycle as two different chains.
 */
export interface WorkspaceImportCycle {
  readonly chain: readonly string[];
}

export interface WorkspaceSourceClosure {
  /** Workspace packages reachable from the entry's workspace imports, canonical order. */
  readonly packages: readonly string[];
  /** Published module ids those packages import, with the workspace packages that import them. */
  readonly externalModules: readonly WorkspaceExternalModule[];
  readonly cycles: readonly WorkspaceImportCycle[];
}

/**
 * The workspace packages a package's stated imports reach, deduped and canonical.
 *
 * `workspacePackageFor` rather than `classifyWorkspaceModule`, because this asks the
 * narrower question: which of these imports is an edge to follow. The three-way
 * classification is for the walk, which has to decide about the other two kinds as
 * well — and for a file path both functions agree, since neither treats one as a
 * package.
 *
 * A name with no record has no known edges, rather than a fabricated empty package:
 * this only happens for a node the caller's edge list mentions and the graph does
 * not declare, and inventing a record for it would report a package that does not
 * exist.
 */
function workspaceEdgesOf(index: WorkspaceGraphIndex, name: string): readonly string[] {
  const record = index.byName.get(name);
  if (record === undefined) return [];

  const reached = new Set<string>();
  for (const moduleId of record.imports ?? []) {
    const target = workspacePackageFor(index, moduleId);
    if (target !== undefined) reached.add(target.name);
  }
  return [...reached].sort(compareStrings);
}

/**
 * Whether an import list names a module, exactly or by its package.
 *
 * A membership question over a plain list, not the precedence question
 * `artifact.findDependencyDecision` answers over decisions: there are no strategies
 * here, so "either form matches" is the whole rule and `some` cannot make the result
 * depend on the array's order.
 */
function declaresImport(imports: readonly string[], moduleId: string): boolean {
  return imports.some(
    candidate => candidate === moduleId || packageNameOfSpecifier(candidate) === moduleId,
  );
}

/**
 * Walks the workspace source reachable from the entry's imports.
 *
 * Three answers, and #14 asks for all three: which workspace packages a cell pulls
 * in, which published dependencies come with them (acceptance criterion 3), and
 * whether the import graph has a cycle (acceptance criterion 4).
 *
 * The walk branches on {@link classifyWorkspaceModule}, never on "is this in the
 * graph": a `source-file` import is neither an edge to follow nor a dependency to
 * decide, and treating "not a workspace package" as "a published dependency" would
 * demand a decision for `./Button` in any graph derived from source rather than from
 * a manifest.
 *
 * The walk is over the edges the caller stated. A package whose `imports` is
 * absent contributes no outgoing edges and is still reached, so an incomplete
 * graph produces a smaller answer rather than a wrong one, and the audit reports
 * the abstention through `usage`/`imports` rather than through an empty result.
 *
 * Cycles are found as back edges during one depth-first pass: every cycle in a
 * reachable strongly-connected component is *reported*, but elementary cycles are
 * not enumerated one by one, because the diagnostic's job is to name the chain a
 * reviewer has to break, not to list every way around it.
 *
 * Iterative rather than recursive on purpose. A deeply nested graph is exactly the
 * malformed input this function exists to report, and a `RangeError` escaping it
 * would turn a diagnostic into a crash.
 */
export function traceWorkspaceSourceClosure(
  index: WorkspaceGraphIndex,
  entryModuleIds: readonly string[],
): WorkspaceSourceClosure {
  const roots = [
    ...new Set(
      entryModuleIds
        .map(moduleId => workspacePackageFor(index, moduleId)?.name)
        .filter((name): name is string => name !== undefined),
    ),
  ].sort(compareStrings);

  // Reachability and the external-module map share one pass: both need every
  // package the entry reaches, and a second walk would be a second answer.
  const reached = new Set<string>(roots);
  const externalImports = new Map<string, Set<string>>();
  const pending = [...roots];

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) break;
    const record = index.byName.get(name);
    if (record === undefined) continue;

    for (const moduleId of record.imports ?? []) {
      switch (classifyWorkspaceModule(index, moduleId)) {
        case "workspace-package": {
          const target = workspacePackageFor(index, moduleId);
          if (target === undefined) break;
          if (!reached.has(target.name)) {
            reached.add(target.name);
            pending.push(target.name);
          }
          break;
        }
        case "source-file":
          // A file inside some package: not an edge to follow and not a dependency
          // to decide. The bundler flattens it as ordinary source.
          break;
        case "external-package": {
          const importers = externalImports.get(moduleId);
          if (importers === undefined) externalImports.set(moduleId, new Set([name]));
          else importers.add(name);
          break;
        }
      }
    }
  }

  return {
    packages: [...reached].sort(compareStrings),
    externalModules: [...externalImports.keys()].sort(compareStrings).map(moduleId => ({
      moduleId,
      importedBy: [...(externalImports.get(moduleId) ?? [])].sort(compareStrings),
    })),
    cycles: findWorkspaceCycles(index, roots, reached),
  };
}

const UNVISITED = 0;
const ON_PATH = 1;
const SETTLED = 2;

interface TraversalFrame {
  readonly name: string;
  edge: number;
  readonly edges: readonly string[];
}

/**
 * The chain rotated so it starts and ends at its smallest member.
 *
 * The canonical form, and the reason it has to be applied to the *reported* chain
 * and not only to the key: a cycle is entered at whichever of its members the walk
 * happens to reach first, so the raw traversal path is the same cycle written from a
 * different starting point. Rotating both makes one cycle one answer — a report that
 * changed when an unrelated package was added to the entry list would not be
 * diffable.
 */
function canonicalCycleChain(chain: readonly string[]): readonly string[] {
  const members = chain.slice(0, -1);
  let smallest = 0;
  for (let index = 1; index < members.length; index += 1) {
    if (compareStrings(members[index] ?? "", members[smallest] ?? "") < 0) smallest = index;
  }
  const rotated = [...members.slice(smallest), ...members.slice(0, smallest)];
  return [...rotated, ...rotated.slice(0, 1)];
}

function findWorkspaceCycles(
  index: WorkspaceGraphIndex,
  roots: readonly string[],
  reached: ReadonlySet<string>,
): readonly WorkspaceImportCycle[] {
  const state = new Map<string, number>();
  const cycles = new Map<string, WorkspaceImportCycle>();

  for (const root of roots) {
    if (state.get(root) !== undefined) continue;

    state.set(root, ON_PATH);
    const path: string[] = [root];
    const stack: TraversalFrame[] = [{ name: root, edge: 0, edges: workspaceEdgesOf(index, root) }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.edge < frame.edges.length) {
        const next = frame.edges[frame.edge];
        frame.edge += 1;
        if (next === undefined) continue;

        const nextState = state.get(next) ?? UNVISITED;
        if (nextState === ON_PATH) {
          const chain = canonicalCycleChain([...path.slice(path.indexOf(next)), next]);
          cycles.set(chain.join("\u0000"), { chain });
          continue;
        }
        if (nextState === SETTLED) continue;

        state.set(next, ON_PATH);
        path.push(next);
        stack.push({ name: next, edge: 0, edges: workspaceEdgesOf(index, next) });
        continue;
      }

      state.set(frame.name, SETTLED);
      path.pop();
      stack.pop();
    }
  }

  // A package outside the closure cannot be part of a cycle the entry reaches, but
  // the traversal only ever follows reachable edges, so this filter is a statement
  // of that invariant rather than a second check.
  return [...cycles.values()]
    .filter(cycle => cycle.chain.every(name => reached.has(name)))
    .sort((a, b) => compareStrings(a.chain.join("\u0000"), b.chain.join("\u0000")));
}

// ---------------------------------------------------------------------------
// The public guarantees
// ---------------------------------------------------------------------------

export const WORKSPACE_SOURCE_GUARANTEE_IDS = [
  "workspace-source-flattened-into-the-cell",
  "no-runtime-module-link-between-packages",
  "transitive-third-party-dependencies-decided",
  "workspace-import-graph-is-acyclic",
  "workspace-module-identity-is-delegated",
  "tree-shaking-not-defeated-by-the-toolchain",
  "cells-do-not-share-workspace-module-state",
] as const;

export type WorkspaceSourceGuaranteeId = (typeof WORKSPACE_SOURCE_GUARANTEE_IDS)[number];

export interface WorkspaceSourceGuarantee {
  readonly id: WorkspaceSourceGuaranteeId;
  /** The promise, in the Spec's wording. */
  readonly statement: string;
  /** Whether a local check can establish the promise, or a real page must. */
  readonly level: DependencyCheckLevel;
  /** What an executed check for this guarantee actually does. */
  readonly howToCheck: string;
  /** Set when the guarantee is deliberately weaker than it reads. */
  readonly caveat?: string;
}

/**
 * The promises #14 makes, at the level #6's guarantees are recorded.
 *
 * The split between `local` and `real-runtime` is #4's, kept for the same reason:
 * a green local run must never be reported as Forguncy runtime compatibility. Here
 * it separates one *anti-claim* from the rest — that two cells do not share the
 * workspace module state they appear to share — which no local check can establish,
 * because the absence of sharing is a property of what the page runs.
 */
export const WORKSPACE_SOURCE_GUARANTEES: readonly WorkspaceSourceGuarantee[] = [
  {
    id: "workspace-source-flattened-into-the-cell",
    statement:
      "The compiled Cell contains the used workspace source, and does not attempt to load another workspace package at runtime.",
    level: "local",
    howToCheck:
      "Assert no workspace package name in the graph appears in the bundler's external-import report, and that every relative source path is flattened.",
    caveat:
      "The positive half is the bundler's report, not this contract's: the compiler is not told which workspace exports are used, so it cannot require the *used* source to be present — only that nothing workspace-shaped was left for the page to load.",
  },
  {
    id: "no-runtime-module-link-between-packages",
    statement:
      "Deployed Cells remain independent artifacts; no workspace package reaches the page as a module the platform would load.",
    level: "local",
    howToCheck:
      "Assert no workspace package name appears in the artifact's `frontendLibraries` metadata and no workspace package is left as an external import.",
    caveat:
      "A `frontendLibraries` id is a string, so a workspace package renamed to something the graph does not know would not be recognized. The check is exact for the declared graph and silent outside it.",
  },
  {
    id: "transitive-third-party-dependencies-decided",
    statement:
      "Workspace packages may import npm dependencies, and each of those transitive dependencies is fed into the normal dependency decision pipeline.",
    level: "local",
    howToCheck:
      "Trace the workspace source reachable from the entry, collect every published module id it imports, and assert each one has a decision covering it. A file inside a package (`./Button`, `../utils`, `./styles.css`) is collected by neither side: it is not an edge to follow and not a dependency to decide.",
    caveat:
      "Complete only as far as the graph is: a package whose `imports` the caller did not state contributes no edges, a manifest-derived graph can miss imports that only exist between files, and a specifier the bundler resolves through an alias (`#internal`, a `resolve.alias` target) is indistinguishable here from a published package — the graph has to carry the id the bundler resolves.",
  },
  {
    id: "workspace-import-graph-is-acyclic",
    statement: "Circular workspace dependencies fail early with a structured diagnostic that names the import chain.",
    level: "local",
    howToCheck:
      "Trace the closure and assert there are no cycles; each reported chain names the packages and closes on its first member.",
    caveat:
      "One chain per detected back edge. Cycles through files inside a package, or through edges the graph does not carry, are outside what a package-level graph can see.",
  },
  {
    id: "workspace-module-identity-is-delegated",
    statement:
      "Every workspace package that declares a cross-Cell module identity names one module the page or an extension provides, and reaches it.",
    level: "local",
    howToCheck:
      "For every package declaring `moduleIdentity: { kind: \"delegated\", via }`: assert `via` is not workspace source, that exactly one decision governs it and that decision is `host` or `extension`, and that the package's stated imports reach it. Any check whose input the caller did not state leaves the delegation `undetermined` with the reason rather than passing it.",
    caveat:
      "Deliberately narrower than #14's sentence, and the narrowing is the honest half: this establishes that the delegation is *declared and backed*, never that the package's state actually lives in `via`. A package can import the host's React and still create its own Context or module-scope cache, and each inlined Cell then keeps a private copy while every check here passes. `WorkspaceDelegationAssessment.stateSharingEstablished` is `false` for every delegation the audit returns, and an undeclared reliance is invisible to begin with — so the sharing itself is `cells-do-not-share-workspace-module-state`, which only a page with two cells can establish.",
  },
  {
    id: "tree-shaking-not-defeated-by-the-toolchain",
    statement:
      "Tree-shaking can remove unused workspace exports where supported by the bundler.",
    level: "local",
    howToCheck:
      "Import a subset of a workspace package's exports and assert an unused export's name does not appear in the composed artifact.",
    caveat:
      "The toolchain's half is the negative one: workspace source is handed to the bundler as ordinary source, with no re-export shim and no forced side-effect retention added by this contract. Whether a given bundler removes a given export is the bundler's property (#7's proof) and is not promised here.",
  },
  {
    id: "cells-do-not-share-workspace-module-state",
    statement:
      "Two cells importing the same workspace package share no module state unless the identity was delegated, so a provider in one cell is invisible to the other.",
    level: "real-runtime",
    howToCheck:
      "Mount two cells that both import the same workspace package on one page, write to a module-scope value from one, and assert the other does not observe it — including for a Context the package declares.",
    caveat:
      "Nothing local can establish this: it is a statement about what the page runs. It is the anti-claim #14's output semantics make, and the reason `WORKSPACE_CONTEXT_SEMANTICS` is worth stating next to the sharing it does allow.",
  },
];

export function findWorkspaceSourceGuarantee(id: WorkspaceSourceGuaranteeId): WorkspaceSourceGuarantee {
  const guarantee = WORKSPACE_SOURCE_GUARANTEES.find(candidate => candidate.id === id);
  if (guarantee === undefined) {
    throw new Error(`Unknown workspace source guarantee "${id}".`);
  }
  return guarantee;
}

/** The guarantees a local check can establish. */
export function locallyCheckableWorkspaceSourceGuarantees(): readonly WorkspaceSourceGuarantee[] {
  return WORKSPACE_SOURCE_GUARANTEES.filter(guarantee => guarantee.level === "local");
}

/** The guarantees only a real Forguncy page can establish. */
export function realRuntimeWorkspaceSourceGuarantees(): readonly WorkspaceSourceGuarantee[] {
  return WORKSPACE_SOURCE_GUARANTEES.filter(guarantee => guarantee.level === "real-runtime");
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The codes, in the order a report prints them: the graph's own coherence first,
 * then how resolution went, then the structure of the import chain.
 *
 * The order is part of the contract rather than an accident of the array, because
 * `orderWorkspaceSourceDiagnostics` sorts by it and a report that reordered itself
 * between runs would not be diffable.
 */
export const WORKSPACE_SOURCE_DIAGNOSTIC_CODES = [
  "workspace-graph-conflict",
  "workspace-package-decided-as-dependency",
  "workspace-source-left-external",
  "workspace-package-in-frontend-libraries",
  "unresolved-workspace-transitive-dependency",
  "conflicting-module-identity-decisions",
  "undelegated-workspace-module-identity",
  "circular-workspace-dependency",
] as const;

export type WorkspaceSourceDiagnosticCode = (typeof WORKSPACE_SOURCE_DIAGNOSTIC_CODES)[number];

/**
 * Who has to act on a diagnostic.
 *
 * #6's owners, plus one. The three shared names mean the same thing here as there —
 * the fix is in the decision list, in what the bundler was configured to do, or in
 * the cell's own source — and reusing them keeps a report from using two words for
 * one place. `workspace-graph` is new because the four remaining findings are
 * neither: a cycle, a name collision or an unbacked delegation is fixed in the
 * project's workspace declarations, and sending the reader to the decision list
 * would point at somewhere the answer is not.
 */
export type WorkspaceSourceFixOwner = CellArtifactFixOwner | "workspace-graph";

export interface WorkspaceSourceDiagnosticRule {
  readonly code: WorkspaceSourceDiagnosticCode;
  readonly label: string;
  /** One sentence stating what went wrong, without the offending value. */
  readonly states: string;
  /** What to do about it. Never empty: a diagnostic is not a dead end. */
  readonly remediation: string;
  readonly fixOwner: WorkspaceSourceFixOwner;
  /** The #14 guarantees a violation of this code breaks. */
  readonly breaksGuarantees: readonly WorkspaceSourceGuaranteeId[];
}

export const WORKSPACE_SOURCE_DIAGNOSTIC_RULES: Readonly<
  Record<WorkspaceSourceDiagnosticCode, WorkspaceSourceDiagnosticRule>
> = {
  "workspace-graph-conflict": {
    code: "workspace-graph-conflict",
    label: "Workspace graph is not usable as declared",
    states: "A workspace package record cannot be used as the graph declares it.",
    remediation:
      "Fix the declaration: a package needs an importable name, a workspace-relative directory, and a name no other workspace package already claims. This is a project-declaration problem, and no code under `packages/` can resolve it.",
    fixOwner: "workspace-graph",
    breaksGuarantees: ["transitive-third-party-dependencies-decided"],
  },
  "workspace-package-decided-as-dependency": {
    code: "workspace-package-decided-as-dependency",
    label: "Workspace package given a dependency decision",
    states:
      "A dependency decision names a local workspace package, which is source rather than a Forguncy runtime module.",
    remediation:
      "Remove the decision. Workspace packages are flattened into each consuming Cell and never resolve to a strategy; if the boundary genuinely has to exist at runtime, that needs a frontend extension built around the capability, with its own library id — not a decision about a workspace package name.",
    fixOwner: "dependency-decision",
    breaksGuarantees: [
      "no-runtime-module-link-between-packages",
      "workspace-source-flattened-into-the-cell",
    ],
  },
  "workspace-source-left-external": {
    code: "workspace-source-left-external",
    label: "Workspace source left external",
    states: "A workspace package was left as an external import, so the Cell would look for it at runtime.",
    remediation:
      "Flatten the workspace package like any other source file. The platform refuses an `import` declaration outright, so a surviving one fails the write-time validator as well as this contract.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: [
      "workspace-source-flattened-into-the-cell",
      "no-runtime-module-link-between-packages",
    ],
  },
  "workspace-package-in-frontend-libraries": {
    code: "workspace-package-in-frontend-libraries",
    label: "Workspace package in frontendLibraries",
    states:
      "A workspace package name reached the artifact's `frontendLibraries` metadata, which tells the page to load a library nothing installs.",
    remediation:
      "Remove the entry and inline the source instead. `frontendLibraries` references a Forguncy frontend extension by its stable library id; a workspace package is not one, so the page would be told to resolve a library that does not exist.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["no-runtime-module-link-between-packages"],
  },
  "unresolved-workspace-transitive-dependency": {
    code: "unresolved-workspace-transitive-dependency",
    label: "Undecided dependency reached through workspace source",
    states:
      "A published dependency imported by workspace source has no decision, so the compiler cannot know whether to inline it, map it to a host global or reference an extension.",
    remediation:
      "Resolve the dependency before compiling: add exactly one decision for it, or remove the import from the workspace package. That a workspace package imports it changes nothing about the pipeline — it is still a non-workspace dependency (#4).",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["transitive-third-party-dependencies-decided"],
  },
  "conflicting-module-identity-decisions": {
    code: "conflicting-module-identity-decisions",
    label: "Conflicting decisions for a delegated module identity",
    states:
      "More than one decision covers the module a workspace package delegates its shared identity to, so there is no single provider for it.",
    remediation:
      "Resolve the conflict in the decision list: leave exactly one decision for the module, or split it so the record the package delegates to is the only one that covers it. This is the same list the artifact audit refuses as an unresolved dependency decision, and until it is resolved nothing can say which module provides the identity — so the delegation is neither backed nor refused.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["workspace-module-identity-is-delegated"],
  },
  "undelegated-workspace-module-identity": {
    code: "undelegated-workspace-module-identity",
    label: "Undelegated cross-cell module identity",
    states:
      "A workspace package declares that it relies on cross-cell module identity, and the module it names cannot provide that identity.",
    remediation:
      "Delegate the state: declare `moduleIdentity: { kind: \"delegated\", via: \"<module id>\" }`, import that module from the package, and give it a `host` or `extension` decision. An `inline` decision cannot back it — an inlined copy is exactly the second instance the declaration assumes does not exist. The state itself has to live in that module: importing it and then creating your own Context or cache inside the package is not a delegation, and that half is a review or runtime question rather than something a module-id graph can see.",
    fixOwner: "workspace-graph",
    breaksGuarantees: ["workspace-module-identity-is-delegated"],
  },
  "circular-workspace-dependency": {
    code: "circular-workspace-dependency",
    label: "Circular workspace dependency",
    states: "The workspace import graph contains a cycle, so the packages involved cannot be flattened in a defined order.",
    remediation:
      "Break the cycle: extract the shared part into a third package both can import, or invert one of the imports. #14 requires this to fail before bundling rather than to be resolved by whichever traversal happens to run first.",
    fixOwner: "workspace-graph",
    breaksGuarantees: ["workspace-import-graph-is-acyclic"],
  },
};

export interface WorkspaceSourceDiagnostic {
  readonly code: WorkspaceSourceDiagnosticCode;
  /** What the diagnostic is about: a package name, a module id, a directory. */
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixOwner: WorkspaceSourceFixOwner;
  readonly breaksGuarantees: readonly WorkspaceSourceGuaranteeId[];
}

export function isWorkspaceSourceDiagnosticCode(value: unknown): value is WorkspaceSourceDiagnosticCode {
  return typeof value === "string" && (WORKSPACE_SOURCE_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/**
 * Builds a diagnostic from the rule table, so a code cannot reach a caller without
 * a remediation and a fix owner.
 *
 * `detail` is appended to the rule's sentence rather than replacing it, the same
 * way #6's diagnostics work: the generic statement stays reviewable in one place
 * and the per-occurrence facts stay in the diagnostic.
 */
export function createWorkspaceSourceDiagnostic(
  code: WorkspaceSourceDiagnosticCode,
  subject: string,
  options: { readonly detail?: string } = {},
): WorkspaceSourceDiagnostic {
  const rule = WORKSPACE_SOURCE_DIAGNOSTIC_RULES[code];
  return {
    code,
    subject,
    message: options.detail === undefined ? rule.states : `${rule.states} ${options.detail}`,
    remediation: rule.remediation,
    fixOwner: rule.fixOwner,
    breaksGuarantees: rule.breaksGuarantees,
  };
}

/**
 * Sorts and collapses diagnostics.
 *
 * Sorted by (code order, subject) so two audits of one input cannot report the same
 * findings in a different order — the list ends up in CI logs that get diffed — and
 * collapsed by (code, subject) because two checks can reach the same conclusion about
 * the same thing. Two external imports of one workspace package are one problem, not
 * two, which is why the key includes the subject and not the offending specifier.
 */
export function orderWorkspaceSourceDiagnostics(
  diagnostics: readonly WorkspaceSourceDiagnostic[],
): readonly WorkspaceSourceDiagnostic[] {
  const rank = new Map(WORKSPACE_SOURCE_DIAGNOSTIC_CODES.map((code, index) => [code, index]));
  const seen = new Set<string>();
  const result: WorkspaceSourceDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }

  return result.sort(
    (a, b) =>
      (rank.get(a.code) ?? 0) - (rank.get(b.code) ?? 0) || compareStrings(a.subject, b.subject),
  );
}

/** One line, for a PR body, a CLI summary or a test failure message. */
export function formatWorkspaceSourceDiagnostic(diagnostic: WorkspaceSourceDiagnostic): string {
  return `[${diagnostic.code}] ${diagnostic.subject}: ${diagnostic.message} Fix (${diagnostic.fixOwner}): ${diagnostic.remediation}`;
}

/** A block a report or a test failure can carry verbatim. */
export function formatWorkspaceSourceDiagnostics(
  diagnostics: readonly WorkspaceSourceDiagnostic[],
): string {
  if (diagnostics.length === 0) return "No workspace source diagnostics.";
  return diagnostics.map(diagnostic => `- ${formatWorkspaceSourceDiagnostic(diagnostic)}`).join("\n");
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Whether the caller stated a workspace graph at all.
 *
 * `unstated` is not "there are no workspace packages": it means the audit cannot
 * tell a workspace package from a published one, so it reports nothing and says so
 * — which is exactly the state `#6`'s guarantee caveat describes.
 */
export type WorkspaceGraphState = "stated" | "unstated";

/**
 * Whether the caller said what the cell imports.
 *
 * Separate from {@link WorkspaceGraphState} because the two abstentions cover
 * different checks, and collapsing them would make "no cycles were found" the same
 * answer as "cycles were not looked for".
 */
export type WorkspaceUsageState = "stated" | "unstated";

export interface WorkspaceSourceAuditInput {
  /** The declared workspace graph. See the module's table for what its absence means. */
  readonly workspace?: WorkspaceGraph;
  /** The decisions the artifact is compiled against. See the module's table. */
  readonly dependencies?: readonly DependencyDecision[];
  /** The module ids the cell's own source imports. */
  readonly entryModuleIds?: readonly string[];
  /** The bundler's external-import report. */
  readonly externalImports?: readonly string[];
  /** The artifact's metadata, when the caller has assembled one already. */
  readonly frontendLibraries?: readonly FrontendLibraryReference[];
}

export interface WorkspaceSourceAudit {
  readonly graphActivation: WorkspaceGraphState;
  readonly usage: WorkspaceUsageState;
  /** The graph's package names, canonical order. Empty when the graph is unstated. */
  readonly packages: readonly string[];
  /**
   * The trace of the entry's workspace imports.
   *
   * Present only when `usage` is `"stated"`: a closure over an unknown entry would
   * be an empty answer that reads like "this cell pulls in nothing".
   */
  readonly closure?: WorkspaceSourceClosure;
  /**
   * Every declared delegation the graph contains, with what this audit did and did
   * not establish about it.
   *
   * Its own section rather than a diagnostic, because the interesting half is not a
   * failure: a delegation can pass every check here and still not be one, and that
   * has to be visible in an audit that reports nothing rather than inferred from the
   * absence of findings.
   */
  readonly delegations: readonly WorkspaceDelegationAssessment[];
  readonly diagnostics: readonly WorkspaceSourceDiagnostic[];
}

/**
 * Everything #14 says about one cell's workspace source, and nothing it cannot know.
 *
 * The checks run in a fixed order and the result is ordered by the code table, so the
 * same input always produces the same report regardless of the order the caller's
 * arrays happen to be in. Where two records could disagree — a graph that declares one
 * package twice, a decision list with two records for one module — the answer is not
 * "the first one wins": the graph is ordered by raw content, and the decision list is
 * refused rather than read past.
 */
export function auditWorkspaceSource(input: WorkspaceSourceAuditInput): WorkspaceSourceAudit {
  if (input.workspace === undefined) {
    return {
      graphActivation: "unstated",
      usage: "unstated",
      packages: [],
      delegations: [],
      diagnostics: [],
    };
  }

  const { index, diagnostics: graphDiagnostics } = indexWorkspaceGraph(input.workspace);
  const diagnostics: WorkspaceSourceDiagnostic[] = [...graphDiagnostics];
  const decisions = input.dependencies;

  diagnostics.push(...auditDecisions(index, decisions));
  diagnostics.push(...auditFrontendLibraries(index, input.frontendLibraries));
  diagnostics.push(...auditExternalImports(index, input.externalImports));

  const usage: WorkspaceUsageState = input.entryModuleIds === undefined ? "unstated" : "stated";
  const closure =
    input.entryModuleIds === undefined
      ? undefined
      : traceWorkspaceSourceClosure(index, input.entryModuleIds);

  if (closure !== undefined) {
    diagnostics.push(...auditTransitiveDependencies(closure, decisions));
    diagnostics.push(...auditCycles(closure));
  }

  const delegation = assessDelegations(index, decisions);
  diagnostics.push(...delegation.diagnostics);

  return {
    graphActivation: "stated",
    usage,
    packages: index.packages.map(entry => entry.name),
    ...(closure === undefined ? {} : { closure }),
    delegations: delegation.delegations,
    diagnostics: orderWorkspaceSourceDiagnostics(diagnostics),
  };
}

/**
 * Decisions that name workspace source.
 *
 * Every strategy is refused, including `replace`: the problem is not which strategy
 * was chosen but that a workspace package was treated as a dependency at all. #4's
 * rule is about "every *non-workspace* dependency", so a decision record for one is
 * outside its scope by construction.
 *
 * Grouped by the package the decision resolves to rather than reported per record, so
 * two records naming one workspace package produce one diagnostic whose message names
 * every strategy involved — the same shape #6's decision audit uses, and the reason
 * the message does not depend on which record was read first.
 */
function auditDecisions(
  index: WorkspaceGraphIndex,
  dependencies: readonly DependencyDecision[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (dependencies === undefined) return [];

  const strategiesByName = new Map<string, { record: WorkspacePackageRecord; strategies: Set<string> }>();
  for (const decision of dependencies) {
    const record = workspacePackageFor(index, decision.packageName);
    if (record === undefined) continue;
    const entry = strategiesByName.get(record.name);
    if (entry === undefined) strategiesByName.set(record.name, { record, strategies: new Set([decision.strategy]) });
    else entry.strategies.add(decision.strategy);
  }

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const name of [...strategiesByName.keys()].sort(compareStrings)) {
    const entry = strategiesByName.get(name);
    if (entry === undefined) continue;
    const strategies = [...entry.strategies].sort(compareStrings);
    const lead =
      strategies.length === 1
        ? `The decision is \`${strategies[0] ?? ""}\``
        : `${strategies.length} decisions name it (${strategies.map(strategy => `\`${strategy}\``).join(", ")})`;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-package-decided-as-dependency", name, {
        detail: `${lead}, but "${entry.record.name}" (${entry.record.directory}) is workspace source: it is flattened into every cell that imports it, so there is no runtime module for a strategy to describe.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * A workspace package name in `frontendLibraries`.
 *
 * The one place a workspace package could still acquire a runtime identity: the
 * metadata tells ReactCellType to resolve a frontend library before the cell runs,
 * and no such library exists for a package that only ever lived in the monorepo.
 */
function auditFrontendLibraries(
  index: WorkspaceGraphIndex,
  frontendLibraries: readonly FrontendLibraryReference[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (frontendLibraries === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const reference of frontendLibraries) {
    const record = workspacePackageFor(index, reference.libraryId);
    if (record === undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-package-in-frontend-libraries", reference.libraryId, {
        detail: `"${record.name}" (${record.directory}) is workspace source and is not published as a frontend extension, so no library answers to this id.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Workspace source the bundler left for the page to load.
 *
 * Only named workspace packages. A relative path left external is #6's
 * `source-level-import-remains`, and duplicating it here would report one problem
 * under two codes; the manifest changes nothing about that case, because a path was
 * never ambiguous.
 */
function auditExternalImports(
  index: WorkspaceGraphIndex,
  externalImports: readonly string[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (externalImports === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const specifier of externalImports) {
    const record = workspacePackageFor(index, specifier);
    if (record === undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-source-left-external", specifier, {
        detail: `"${record.name}" (${record.directory}) is workspace source, which is inlined like any other source file, but the bundler left it external — so the Cell would try to load another workspace package at runtime.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Published dependencies reached through workspace source, against the decisions.
 *
 * Acceptance criterion 3 of #14, and the check that exists because the alternative
 * is silent: a dependency pulled in only by workspace source is exactly the one that
 * gets bundled without ever passing the decision pipeline, and nothing about the
 * resulting artifact shows it.
 *
 * `dependencies` absent abstains; an empty array does not, because "there are no
 * decisions" is a stated position and every transitive dependency is then
 * undecided.
 */
function auditTransitiveDependencies(
  closure: WorkspaceSourceClosure,
  dependencies: readonly DependencyDecision[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (dependencies === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const external of closure.externalModules) {
    if (findDependencyDecision(dependencies, external.moduleId) !== undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("unresolved-workspace-transitive-dependency", external.moduleId, {
        detail: `No decision covers it, and it is reached through workspace source: imported by ${external.importedBy.join(", ")}.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Why a strategy that is not `host` or `extension` cannot back a delegation.
 *
 * Exhaustive over the remaining strategies rather than a default sentence, because
 * "a private copy" and "a recorded refusal" are different problems and a reader has
 * to be able to tell which one they have.
 */
function whyStrategyCannotProvideSharedIdentity(strategy: "inline" | "replace"): string {
  return strategy === "inline"
    ? "an inlined copy is a private instance per cell, which is the duplicate the delegation assumes cannot exist."
    : "a recorded refusal is not a provider.";
}

 /** The package a cycle is reported against: its first member, which is the canonical one. */
function cycleSubject(cycle: WorkspaceImportCycle): string {
  return cycle.chain.slice(0, 1).join(" → ");
}

/**
 * The cycles the closure found, as diagnostics.
 *
 * Reported only from a traced closure, because a cycle is a property of the import
 * chain this cell reaches and a graph-wide sweep would report chains the cell never
 * enters — a diagnostic about something the artifact does not contain.
 */
function auditCycles(closure: WorkspaceSourceClosure): readonly WorkspaceSourceDiagnostic[] {
  return closure.cycles.map(cycle =>
    createWorkspaceSourceDiagnostic("circular-workspace-dependency", cycleSubject(cycle), {
      detail: `The chain is ${cycle.chain.join(" → ")}.`,
    }),
  );
}

interface DelegationAssessment {
  readonly diagnostics: readonly WorkspaceSourceDiagnostic[];
  readonly delegations: readonly WorkspaceDelegationAssessment[];
}

/**
 * What a delegation to a module the page shares, or does not.
 *
 * Four ways a declaration can be refused, and each is a different fix:
 *
 * - the module it delegates to is workspace source, which cannot provide an identity —
 *   the cell would inline a second definition of the very thing;
 * - no decision covers it, so nothing says the page provides it;
 * - several decisions cover it, so *which* provides it is unresolved — #6's artifact
 *   audit refuses the same list as `unresolved-dependency-decision`, and a delegation
 *   may not be called backed on the strength of one arbitrarily chosen record;
 * - the decision is `inline` (a private copy) or `replace` (a refusal), neither of which
 *   is a shared identity.
 *
 * The reachability check is separate because it depends on the graph stating the
 * package's imports, and it is the one that catches a *decorative* declaration: a
 * delegation to a module the package never imports shares nothing. It is a necessary
 * condition and not a sufficient one, and the wording says so — see the module note on
 * what this contract cannot prove.
 *
 * Only the first check needs no decision list, and only the first two and the last need
 * no `imports`; the rest are skipped when their input is absent and recorded as
 * {@link WorkspaceDelegationGap}s. That is why this walks every check it *can* run
 * instead of returning at the first missing input: a decorative declaration whose
 * decision list was not supplied is still decorative, and an early return would have
 * called it undetermined instead.
 *
 * Checked for every package in the graph rather than only for the ones the entry
 * reaches, unlike the closure checks. A delegation is a property of the declaration,
 * not of one cell's imports: a workspace package whose delegation is unbacked is wrong
 * for whichever cell reaches it first, and reporting it only once some cell imports it
 * would report it at the least useful moment.
 *
 * Every delegation it examines produces an assessment, including the ones with nothing
 * wrong — a report that lists only the failures would read as "the others are fine",
 * which is exactly the reading the module note forbids.
 */
function assessDelegations(
  index: WorkspaceGraphIndex,
  dependencies: readonly DependencyDecision[] | undefined,
): DelegationAssessment {
  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  const delegations: WorkspaceDelegationAssessment[] = [];

  for (const record of index.packages) {
    const identity = record.moduleIdentity;
    if (identity === undefined || identity.kind !== "delegated") continue;
    const via = identity.via;

    const gaps: WorkspaceDelegationGap[] = [];
    const failed = (detail: string): void => {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("undelegated-workspace-module-identity", record.name, { detail }),
      );
    };

    const delegate = workspacePackageFor(index, via);
    if (delegate !== undefined) {
      // Workspace source cannot provide an identity, so nothing else is worth asking:
      // decisions *about* a workspace package are themselves an error, and the fix is a
      // different module rather than a better decision.
      failed(
        `It delegates to "${via}", which is workspace source (${delegate.directory}) as well — each cell inlines its own copy, so the identity it claims to share is the one thing inlining cannot provide. Delegate to a module the page provides (\`host\`) or an extension provides (\`extension\`).`,
      );
      delegations.push({ package: record.name, via, status: "unbacked", stateSharingEstablished: false });
      continue;
    }

    let refused = false;

    if (dependencies === undefined) {
      gaps.push("decision-list-absent");
    } else {
      const governing = dependencyDecisionsFor(dependencies, via);
      if (governing.length === 0) {
        refused = true;
        failed(`It delegates to "${via}", and no decision covers that module, so nothing says the page provides it.`);
      } else if (governing.length > 1) {
        // Not "the first one wins": the list has no single answer, and #6 refuses it for
        // the same reason. Recorded as a gap *and* reported, because a caller reading
        // only diagnostics must not go silent about a declaration that cannot be backed.
        gaps.push("decision-list-conflicted");
        diagnostics.push(
          createWorkspaceSourceDiagnostic("conflicting-module-identity-decisions", via, {
            detail: `${governing.length} decisions cover it (${[...new Set(governing.map(entry => entry.strategy))]
              .sort(compareStrings)
              .map(strategy => `\`${strategy}\``)
              .join(", ")}), so which one provides the identity "${record.name}" delegates to is unresolved. The artifact audit (#6) refuses the same list as an unresolved dependency decision.`,
          }),
        );
      } else {
        const decision = governing[0];
        if (decision !== undefined && decision.strategy !== "host" && decision.strategy !== "extension") {
          refused = true;
          failed(
            `It delegates to "${via}", which is decided \`${decision.strategy}\`: ${whyStrategyCannotProvideSharedIdentity(decision.strategy)} Only \`host\` and \`extension\` carry a module identity the page shares.`,
          );
        }
      }
    }

    const imports = record.imports;
    if (imports === undefined) {
      gaps.push("package-imports-absent");
    } else if (!declaresImport(imports, via)) {
      refused = true;
      failed(
        `It declares that its state is delegated to "${via}", but its stated imports do not reach that module, so the declaration delegates nothing.`,
      );
    }

    if (refused) {
      delegations.push({ package: record.name, via, status: "unbacked", stateSharingEstablished: false });
      continue;
    }

    delegations.push(
      gaps.length > 0
        ? { package: record.name, via, status: "undetermined", gaps, stateSharingEstablished: false }
        : // Backed, and that is all that can be said: the module is provided by the page,
          // the package reaches it, and there is one decision rather than several. Whether
          // the package's state is *in* it is not a question a module-id graph answers,
          // which is what the assessment carries.
          { package: record.name, via, status: "backed", stateSharingEstablished: false },
    );
  }

  return { diagnostics, delegations };
}

/** A report block for a CI log or a PR body. */
export function formatWorkspaceSourceAudit(audit: WorkspaceSourceAudit): string {
  const lines = [
    `Workspace graph: ${audit.graphActivation}${audit.graphActivation === "unstated" ? " (the caller did not supply one, so every workspace check abstains and no claim is made about workspace packages)" : ` — ${audit.packages.length} package(s): ${audit.packages.join(", ") || "(none)"}`}`,
    `Cell imports: ${audit.usage}${audit.usage === "unstated" ? " (not supplied, so no closure was traced and cycles were not looked for)" : ""}`,
  ];

  if (audit.closure !== undefined) {
    lines.push(
      `Workspace source in the closure: ${audit.closure.packages.join(", ") || "(none)"}`,
      `Published dependencies reached through it: ${audit.closure.externalModules.map(entry => entry.moduleId).join(", ") || "(none)"}`,
      `Cycles: ${audit.closure.cycles.map(cycle => cycle.chain.join(" → ")).join("; ") || "(none)"}`,
    );
  }

  if (audit.delegations.length > 0) {
    // Printed even when it is empty of findings, so "no diagnostics" cannot be read as
    // "the declared sharing was verified".
    lines.push(
      `Delegated identity: ${audit.delegations
        .map(delegation => {
          const qualifier =
            delegation.status === "undetermined" ? ` (undetermined: ${delegation.gaps.join(", ")})` : ` (${delegation.status})`;
          return `${delegation.package} → ${delegation.via}${qualifier}; state sharing ${delegation.stateSharingEstablished ? "established" : "NOT established by this audit and not locally checkable"}`;
        })
        .join("; ")}`,
    );
  }

  lines.push(
    audit.diagnostics.length === 0
      ? "No workspace source diagnostics."
      : `${audit.diagnostics.length} workspace source diagnostic(s):\n${formatWorkspaceSourceDiagnostics(audit.diagnostics)}`,
  );

  return lines.join("\n");
}
