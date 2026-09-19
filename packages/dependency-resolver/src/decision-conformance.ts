/**
 * Does a recorded decision match what the target actually provides?
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" — https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * — plan item 7 of #24: "Validate extension records against the shape required by
 * #12 and host records against #9."
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * `core`'s lock validation answers "is this record well formed". It cannot answer
 * "is this record true", because the things that make it true live outside the
 * document: which globals the target's page installs, which extension library
 * actually owns `TanStackQuery`, whether the React a cell was developed against is
 * the React the host injects. Those are the questions here.
 *
 * Three sources, deliberately not one:
 *
 * - **#5's verified target facts** for which globals exist. The preset libraries
 *   are read from `core` rather than re-listed, so "AntDesign provides `antd` and
 *   `dayjs`" has one definition, and a preset that gains a global gains it here
 *   too.
 * - **A host bridge manifest** for which global a host-provided import maps to.
 *   That table is #9's decision, and #9 is not implemented yet, so
 *   {@link DEFAULT_HOST_BRIDGE_MANIFEST} carries #9's stated initial candidates
 *   with the attribution written down. A caller that has #9's real table passes it
 *   and this module stops guessing. Only the *mapping* is supplied this way; the
 *   question of whether the mapped global is on the page at all still comes from
 *   #5.
 * - **An extension catalog** for which `libraryId` is real. #12 is explicit that
 *   the id must come from `api.app.listFrontendLibraries` or a verified catalog
 *   artifact and must never be inferred from a display name — which is a
 *   statement about a source this repository does not own, so it is an input here
 *   rather than a table.
 *
 * **Findings are not the same as illegal records.** A `host` decision on a
 * preset-provided global is perfectly legal — it is conditional on the cell
 * declaring that preset, which is a fact about the cell and not about the lock.
 * Reporting it as an error would make a supported configuration unwritable, so
 * findings carry a severity and this module never throws. Deciding what to do with
 * a finding belongs to the caller that knows the cell.
 *
 * Severity turns on one question: is the missing fact about the *cell*, or about the
 * *verification*? A cell fact is a warning, because the lock is the wrong place
 * for it. A verification that was never performed is an error, because nothing
 * downstream can tell that decision apart from one that was checked and passed —
 * which is the reading the review of the first draft objected to, where an
 * `extension` record with no catalog produced no complaint at all.
 */

import type { DependencyStrategy, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import { CELL_PRESET_LIBRARIES, compareLockDecisions, DEPENDENCY_STRATEGIES } from "@forguncy-react-workspace/core";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One host-provided import and the global it is bound to.
 *
 * `moduleIds` is what makes subpath imports expressible: `react/jsx-runtime`
 * is not a package of its own, and a lock that records it as one still has to be
 * checkable against the mapping that covers it.
 */
export interface HostBridgeMapping {
  readonly packageName: string;
  /** The page global the import is rewritten to, e.g. `React`. */
  readonly globalName: string;
  /** Subpath module ids this mapping also covers. */
  readonly moduleIds?: readonly string[];
  /**
   * The `ForguncyTargetIdentity` field the recorded version must equal, for a
   * mapping whose whole point is module identity.
   *
   * Only `hostReactVersion` is offerable: it is the one host version the lock
   * records (`ForguncyTargetIdentity` carries no ReactDOM version), so ReactDOM's
   * identity cannot be checked against a number the document does not hold — and
   * claiming to check it would be worse than saying so.
   */
  readonly identityField?: "hostReactVersion";
  /**
   * Whether a *second* copy of this module on the page breaks something the first
   * copy owns.
   *
   * Not every host global has this property, and treating them as though they all
   * did would refuse a supported configuration. `dayjs` is a pure function library:
   * one cell reading the preset global while another bundles its own copy is a
   * per-cell choice with nothing shared to break. React is the opposite — #5
   * verified `single-react-instance-per-page` and `shared-global-this`, and #9 says
   * a bundled duplicate "is known to break Hook/Context identity" — so a second copy
   * anywhere on the page is observable from every cell.
   *
   * The flag exists so the rule is a property of the module rather than an
   * inference over all `host` records. Absent means false: a mapping has to say that
   * identity is load-bearing.
   */
  readonly identitySensitive?: boolean;
}

export interface HostBridgeManifest {
  readonly mappings: readonly HostBridgeMapping[];
}

/**
 * One verified mapping: this npm package is provided by this extension.
 *
 * Keyed by package rather than by extension, because that is the direction the
 * question is asked in — a cell imports a package, and the lock has to say which
 * verified extension answers for it. It is also what makes sharing expressible:
 * #12 allows one extension to stand in for more than one package, and
 * `cell-compiler`'s `collectFrontendLibraries` collapses the two back into one
 * `frontendLibraries` reference. An extension-keyed catalog could not record that
 * without a second entry for the same `libraryId`, which is exactly the
 * "conflicting package mappings" shape #12 asks the compiler to detect.
 */
export interface VerifiedExtensionMapping {
  /** The npm package being mapped. */
  readonly packageName: string;
  /** The stable id from `api.app.listFrontendLibraries`, never a display name. */
  readonly libraryId: string;
  /** The page global the extension publishes. */
  readonly globalName: string;
}

export interface ExtensionCatalog {
  readonly mappings: readonly VerifiedExtensionMapping[];
}

export interface ConformanceOptions {
  /** #9's mapping table. Defaults to {@link DEFAULT_HOST_BRIDGE_MANIFEST}. */
  readonly hostBridge?: HostBridgeManifest;
  /**
   * The verified extension catalog.
   *
   * Omitting it is not the same as an empty one, and both block acceptance, by
   * different routes: absent means the verification step did not happen
   * (`extension-catalog-missing`), while an empty catalog means it happened and
   * verified nothing, which fails per package (`extension-library-not-verified`).
   * The codes differ so a caller can tell "not checked yet" from "checked, and this
   * id is not real" — but neither is something a validator may pass.
   */
  readonly extensionCatalog?: ExtensionCatalog;
}

/**
 * #9's initial host mappings, pending #9's own implementation.
 *
 * The entries below are the candidates #9 lists. `react-dom/client` is a subpath id,
 * so it rides on its package's mapping; the two JSX runtime ids are *not* listed at
 * all, because #9 bridges them with an adapter the compiler generates rather than
 * with a page global — see `jsx-runtime-requires-adapter`, which refuses them under
 * every strategy that would claim they are provided.
 *
 * `antd` is here as a mapping and separately reported as preset-provided, which is
 * the honest combination: #9 says the import maps to the host `antd` global, and
 * #5 says that global exists only when the cell's preset chain loads it.
 *
 * `identitySensitive` is set from #5 and #9 rather than guessed: React and ReactDOM
 * are the two modules those Specs say must not be duplicated. `antd` deliberately
 * does not carry it — its own context does not cross cells
 * (`context-does-not-cross-cells`), so a cell with its own copy shares nothing that
 * a second copy could split.
 */
export const DEFAULT_HOST_BRIDGE_MANIFEST: HostBridgeManifest = {
  mappings: [
    { packageName: "react", globalName: "React", identityField: "hostReactVersion", identitySensitive: true },
    { packageName: "react-dom", globalName: "ReactDOM", moduleIds: ["react-dom/client"], identitySensitive: true },
    { packageName: "antd", globalName: "antd" },
  ],
};

/**
 * The JSX runtime module ids, which #9 bridges with a generated adapter.
 *
 * No decision strategy can express one, which is why they appear in no mapping. #9
 * says these resolve to "an explicit adapter preserving JSX runtime semantics", and
 * that adapter is produced by the compiler — so it is not a page global (`host`), not
 * the published implementation (`inline`), and not a library global (`extension`).
 * Any of those three claims the module is provided; the audit refuses all three and
 * leaves `replace`, which claims the opposite.
 */
export const JSX_RUNTIME_MODULE_IDS: readonly string[] = ["react/jsx-runtime", "react/jsx-dev-runtime"];

/** A page global provided by a preset library chain, and the preset that loads it. */
export interface PresetProvidedGlobal {
  readonly globalName: string;
  readonly preset: string;
}

/**
 * Every global the target's preset chains install, derived from #5.
 *
 * Derived rather than listed, so a preset that gains a global gains it here.
 */
export const PRESET_PROVIDED_HOST_GLOBALS: readonly PresetProvidedGlobal[] = CELL_PRESET_LIBRARIES.flatMap(preset =>
  preset.providesGlobals.map(globalName => ({ globalName, preset: preset.name })),
);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const CONFORMANCE_PROBLEM_CODES = [
  "host-global-not-provided",
  "host-mapping-mismatch",
  "jsx-runtime-requires-adapter",
  "host-react-version-is-not-host-identity",
  "host-inline-conflict",
  "host-global-is-preset-provided",
  "extension-library-not-verified",
  "extension-catalog-missing",
  "extension-library-mismatch",
  "extension-global-mismatch",
  "extension-library-global-conflict",
  "extension-global-library-conflict",
] as const;
export type ConformanceProblemCode = (typeof CONFORMANCE_PROBLEM_CODES)[number];

/**
 * Whether a finding blocks the lock from being accepted.
 *
 * - `error` — the lock must not be accepted as it stands. Either the record cannot
 *   be right, or the verification its own strategy requires has not happened:
 *   #4 marks which strategies owe a verified backing capability
 *   (`requiresVerifiedHostCapability`, which only `extension` sets), and #12 makes a
 *   catalog lookup the thing that discharges it. "Nothing checked this" is not a
 *   milder version of "this is wrong" for such a decision — it is the same answer to
 *   the question "may I accept it", which is the question a validator is asked.
 * - `warning` — the record is legal and the lock is acceptable; what is missing is a
 *   fact about the *cell*, which a lock file cannot hold. A `host` decision on a
 *   preset-provided global is the case: whether that global is on the page depends on
 *   the cell's preset chain, so the caller confirms it rather than being told it is
 *   wrong.
 */
export type ConformanceSeverity = "error" | "warning";

export interface ConformanceDiagnostic {
  readonly code: ConformanceProblemCode;
  readonly severity: ConformanceSeverity;
  /**
   * What the finding is about.
   *
   * A package name for a per-record finding, and the library id or global name
   * for a mapping conflict — which is a fact about a *pair* of records and belongs
   * to neither of them on its own. Named for the role rather than for the common
   * case, so a conflict is not reported as a defect in whichever package happened
   * to be sorted first.
   */
  readonly subject: string;
  readonly detail: string;
}

function error(code: ConformanceProblemCode, subject: string, detail: string): ConformanceDiagnostic {
  return { code, severity: "error", subject, detail };
}

function warning(code: ConformanceProblemCode, subject: string, detail: string): ConformanceDiagnostic {
  return { code, severity: "warning", subject, detail };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function hostMappingFor(manifest: HostBridgeManifest, packageName: string): HostBridgeMapping | undefined {
  return manifest.mappings.find(
    mapping => mapping.packageName === packageName || (mapping.moduleIds ?? []).includes(packageName),
  );
}

function presetProvidingGlobal(globalName: string): PresetProvidedGlobal | undefined {
  return PRESET_PROVIDED_HOST_GLOBALS.find(provided => provided.globalName === globalName);
}

// ---------------------------------------------------------------------------
// JSX runtimes (#9)
// ---------------------------------------------------------------------------

/**
 * The strategies that claim a module is *provided*.
 *
 * Derived from #4's list rather than written out, and defined by what is left out:
 * `replace` is the one strategy whose content is that the candidate is *refused*, so
 * it is the one that can coexist with "no strategy provides this".
 */
const PROVIDING_STRATEGIES: readonly DependencyStrategy[] = DEPENDENCY_STRATEGIES.filter(
  strategy => strategy !== "replace",
);

/** Why the given strategy cannot be the thing that supplies a JSX runtime. */
function whyStrategyCannotSupplyJsxRuntime(strategy: DependencyStrategy): string {
  switch (strategy) {
    case "host":
      return "`host` can only name a page global, and no page global is the adapter — the React object is the substitution #9 names explicitly, because it has no `jsx`";
    case "inline":
      return "`inline` would ship a second real JSX runtime into the cell, which is the implementation the adapter exists to replace";
    case "extension":
      return "`extension` resolves the module to a global published by a frontend library, which is a different contract from an adapter";
    case "replace":
      return "`replace` records a refusal rather than a provider";
  }
}

/**
 * The JSX runtime ids are bridged by an adapter, and no decision can record one.
 *
 * Checked before the strategy-specific audits and for every providing strategy, which
 * is what the review of the second draft caught: refusing only `host` left
 * `react/jsx-runtime` reachable as `inline`, and an `inline` decision ships the real
 * JSX runtime implementation into the cell — the same violation of #9 by a different
 * route. The repository's own frontend-library build tooling states the requirement
 * the same way: `react/jsx-runtime` is mapped to a generated `jsxRuntimeAdapter`, and
 * `build-strategies.md` says it may not simply be pointed at React.
 *
 * `replace` is deliberately not refused. It is the strategy #4 provides for recording
 * that a candidate is not usable, `host-module-identity-mismatch` is the rejection code
 * that already exists for exactly this reason, and refusing it too would leave an Agent
 * no way to record the refusal at all — so the same question would be re-decided on
 * every run, which is the outcome #8's lock exists to prevent.
 */
function auditJsxRuntimeRecord(record: LockedDependencyDecision): readonly ConformanceDiagnostic[] {
  if (!JSX_RUNTIME_MODULE_IDS.includes(record.packageName) || !PROVIDING_STRATEGIES.includes(record.strategy)) {
    return [];
  }

  return [
    error(
      "jsx-runtime-requires-adapter",
      record.packageName,
      `"${record.packageName}" cannot be provided by a \`${record.strategy}\` decision: #9 bridges it with an adapter the compiler generates to preserve \`jsx(type, props, key)\`, and ${whyStrategyCannotSupplyJsxRuntime(record.strategy)}. Record the adapter contract (#9), or decide it \`replace\` if what needs recording is that the specifier is not usable as an ordinary dependency.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Host (#9)
// ---------------------------------------------------------------------------

function auditHostRecord(
  record: LockedDependencyDecision & { readonly globalName: string },
  manifest: HostBridgeManifest,
): readonly ConformanceDiagnostic[] {
  const diagnostics: ConformanceDiagnostic[] = [];
  const { packageName, globalName } = record;
  const mapping = hostMappingFor(manifest, packageName);
  const preset = presetProvidingGlobal(globalName);

  if (mapping !== undefined && mapping.globalName !== globalName) {
    diagnostics.push(
      error(
        "host-mapping-mismatch",
        packageName,
        `"${packageName}" is bound to the host global "${mapping.globalName}", but the decision names "${globalName}". Rewriting the import to a different global does not fail at build time; it fails at runtime, as a missing or wrong object.`,
      ),
    );
  }

  if (mapping === undefined && preset === undefined) {
    diagnostics.push(
      error(
        "host-global-not-provided",
        packageName,
        `Nothing in the target provides the global "${globalName}" for "${packageName}": it is not a host-bridge mapping and no preset library chain installs it. A \`host\` decision here compiles to a reference to a global that is not on the page.`,
      ),
    );
  }

  // Applies with or without a mapping: a preset global is conditional, and saying
  // so is the whole content of the warning.
  if (preset !== undefined) {
    diagnostics.push(
      warning(
        "host-global-is-preset-provided",
        packageName,
        `"${globalName}" is installed by the "${preset.preset}" preset library chain, so this decision holds only for a cell whose preset declares it. Confirm the cell's preset rather than assuming the global is unconditional.`,
      ),
    );
  }

  if (mapping?.identityField !== undefined && record.target !== null) {
    const hostVersion = record.target[mapping.identityField];
    if (record.resolvedVersion !== null && record.resolvedVersion !== hostVersion) {
      diagnostics.push(
        error(
          "host-react-version-is-not-host-identity",
          packageName,
          `The decision records "${packageName}" at ${record.resolvedVersion} while its target provides ${mapping.identityField} ${hostVersion}. A \`host\` decision claims the module *is* the host's, so the versions have to be the same one; otherwise the cell is built against a React the page does not have.`,
        ),
      );
    }
  }

  return diagnostics;
}

/**
 * A second copy of a module whose identity the page shares.
 *
 * Scoped by two things, and the review of the first draft is why both exist.
 *
 * **The module, not every `host` decision.** Duplicating a module matters only when
 * the first copy owns something the second one would split; the manifest says which
 * mappings those are (`identitySensitive`). Applying the rule to `dayjs` would refuse
 * a configuration #4 explicitly allows — the lock is keyed per (package, cell
 * target), and a preset-provided global is captured per cell render instant (#5), so
 * one cell reading the shared `dayjs` while another bundles its own copy breaks
 * nothing.
 *
 * **Still the whole lock, not one cell target.** Where the module *is*
 * identity-sensitive, scoping by cell target would be the wrong exemption: the
 * conflict is that the page then holds two instances, and a cell that bundles its own
 * copy is not made safe by another cell's decision living under a different key.
 * `react-dom` and `react-dom/client` fold to one key for the same reason — they are
 * two entry points into one module, not two modules.
 */
function auditHostInlineConflict(
  strategiesByModule: ReadonlyMap<string, { readonly strategies: ReadonlySet<DependencyStrategy>; readonly specifiers: ReadonlySet<string> }>,
  manifest: HostBridgeManifest,
): readonly ConformanceDiagnostic[] {
  const diagnostics: ConformanceDiagnostic[] = [];

  for (const moduleId of [...strategiesByModule.keys()].sort()) {
    const entry = strategiesByModule.get(moduleId);
    if (entry === undefined || !entry.strategies.has("host") || !entry.strategies.has("inline")) {
      continue;
    }
    if (hostMappingFor(manifest, moduleId)?.identitySensitive !== true) {
      continue;
    }

    diagnostics.push(
      error(
        "host-inline-conflict",
        moduleId,
        `"${moduleId}" is decided \`host\` for ${[...entry.specifiers].sort().join(", ")} and \`inline\` for the same module elsewhere in this lock. The host global is page-wide, so the bundled copy is a second instance of a module whose identity the page shares — the duplicate-identity failure #9 forbids (hooks, Context and instanceof stop matching). Recording the two decisions under different cell targets does not scope that away.`,
      ),
    );
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Extension (#12)
// ---------------------------------------------------------------------------

function auditExtensionRecord(
  record: LockedDependencyDecision & { readonly libraryId: string; readonly globalName: string },
  catalog: ExtensionCatalog | undefined,
): readonly ConformanceDiagnostic[] {
  const { packageName, libraryId, globalName } = record;

  // An `error`, not a warning, and the difference is the whole finding. #12 makes the
  // catalog a *precondition* for accepting an `extension` decision ("must come from
  // listFrontendLibraries or a verified catalog artifact"), and #4 already marks the
  // strategies that owe a verified backing capability. So "no catalog was supplied" is
  // not a fact the cell might resolve — it is the verification step of this decision
  // not having happened, and a validator that returned no problem here would let a
  // guessed `libraryId` through as though it had been checked.
  if (catalog === undefined) {
    return [
      error(
        "extension-catalog-missing",
        packageName,
        `"${libraryId}" cannot be accepted: the strategy declares that its backing capability must be verified, and no verified catalog was supplied to check the id against. #12 requires the id to come from \`api.app.listFrontendLibraries\` or a verified catalog artifact rather than a display name, so pass an extensionCatalog before accepting this record.`,
      ),
    ];
  }

  // A package can have more than one verified mapping — one extension may stand in
  // for several packages — so the record has to match one of them rather than "the"
  // entry, and the detail names what the catalog does verify so the fix is visible.
  const verified = catalog.mappings.filter(mapping => mapping.packageName === packageName);
  const describeVerified = verified.map(mapping => `${mapping.libraryId}/${mapping.globalName}`).join(", ");

  if (verified.length === 0) {
    return [
      error(
        "extension-library-not-verified",
        packageName,
        `No verified mapping provides "${packageName}", so the artifact would reference a library nothing installs under this import. #12: take the id from \`api.app.listFrontendLibraries\` or a verified catalog artifact, never from a display name.`,
      ),
    ];
  }

  if (!verified.some(mapping => mapping.libraryId === libraryId)) {
    return [
      error(
        "extension-library-mismatch",
        packageName,
        `The verified mapping for "${packageName}" is ${describeVerified}, but the decision names library "${libraryId}". A library id that does not come from the catalog is one the page will not load.`,
      ),
    ];
  }

  if (!verified.some(mapping => mapping.libraryId === libraryId && mapping.globalName === globalName)) {
    return [
      error(
        "extension-global-mismatch",
        packageName,
        `Library "${libraryId}" publishes "${verified[0]?.globalName}", but the decision expects "${globalName}". The compiled cell would read a global the extension never creates.`,
      ),
    ];
  }

  return [];
}

function auditExtensionMappingConflicts(
  records: readonly (LockedDependencyDecision & { readonly libraryId: string; readonly globalName: string })[],
): readonly ConformanceDiagnostic[] {
  const globalsByLibrary = new Map<string, Set<string>>();
  const librariesByGlobal = new Map<string, Set<string>>();

  for (const record of records) {
    const libraryId = record.libraryId;
    const globalName = record.globalName;
    if (libraryId.trim().length === 0 || globalName.trim().length === 0) {
      continue;
    }

    const globals = globalsByLibrary.get(libraryId) ?? new Set<string>();
    globals.add(globalName);
    globalsByLibrary.set(libraryId, globals);

    const libraries = librariesByGlobal.get(globalName) ?? new Set<string>();
    libraries.add(libraryId);
    librariesByGlobal.set(globalName, libraries);
  }

  const diagnostics: ConformanceDiagnostic[] = [];

  for (const libraryId of [...globalsByLibrary.keys()].sort()) {
    const globals = [...(globalsByLibrary.get(libraryId) ?? [])].sort();
    if (globals.length > 1) {
      diagnostics.push(
        error(
          "extension-library-global-conflict",
          libraryId,
          `Extension "${libraryId}" is recorded against ${globals.length} different globals (${globals.join(", ")}), so which global the cell should read is ambiguous. One library publishes one global name.`,
        ),
      );
    }
  }

  for (const globalName of [...librariesByGlobal.keys()].sort()) {
    const libraries = [...(librariesByGlobal.get(globalName) ?? [])].sort();
    if (libraries.length > 1) {
      diagnostics.push(
        error(
          "extension-global-library-conflict",
          globalName,
          `The global "${globalName}" is claimed by ${libraries.length} different extensions (${libraries.join(", ")}). A global holds one object, so at most one of these decisions can be the one the page actually publishes.`,
        ),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Every way the lock's decisions disagree with the target they claim to target.
 *
 * Decisions are sorted into canonical order first, so an audit of the same
 * decisions always reports the same findings in the same order — a caller
 * comparing two audits, or snapshotting one, does not need to canonicalize the
 * lock itself to get a stable answer.
 */
export function auditLockDecisionConformance(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  options: ConformanceOptions = {},
): readonly ConformanceDiagnostic[] {
  const manifest = options.hostBridge ?? DEFAULT_HOST_BRIDGE_MANIFEST;
  const decisions = [...lock.decisions].sort(compareLockDecisions);

  const diagnostics: ConformanceDiagnostic[] = [];
  const strategiesByModule = new Map<
    string,
    { strategies: Set<DependencyStrategy>; specifiers: Set<string> }
  >();
  const extensionRecords: (LockedDependencyDecision & {
    readonly libraryId: string;
    readonly globalName: string;
  })[] = [];

  for (const record of decisions) {
    // Before the strategy-specific audits, because the rule is about the module id
    // rather than about how it was decided: any of the three providing strategies is
    // wrong here, and reporting the adapter requirement once is clearer than three
    // strategy-shaped ways of saying the same thing.
    const jsxRuntime = auditJsxRuntimeRecord(record);
    if (jsxRuntime.length > 0) {
      diagnostics.push(...jsxRuntime);
      continue;
    }

    // Folded through the manifest so a subpath id and its package are one module:
    // `react-dom/client` decided `inline` is a second copy of the same ReactDOM that
    // `react-dom` decided `host`, and keying on the specifier would hide it.
    const moduleId = hostMappingFor(manifest, record.packageName)?.packageName ?? record.packageName;
    const entry = strategiesByModule.get(moduleId) ?? { strategies: new Set<DependencyStrategy>(), specifiers: new Set<string>() };
    entry.strategies.add(record.strategy);
    entry.specifiers.add(record.packageName);
    strategiesByModule.set(moduleId, entry);

    if (record.strategy === "host") {
      diagnostics.push(...auditHostRecord(record, manifest));
    }
    if (record.strategy === "extension") {
      diagnostics.push(...auditExtensionRecord(record, options.extensionCatalog));
      extensionRecords.push(record);
    }
  }

  diagnostics.push(...auditHostInlineConflict(strategiesByModule, manifest));
  diagnostics.push(...auditExtensionMappingConflicts(extensionRecords));

  return diagnostics;
}

/**
 * The findings that block a lock from being accepted.
 *
 * Not only the ones that make a decision *wrong*: a decision whose required
 * verification never ran blocks acceptance too, because the caller cannot tell it
 * apart from one that was checked and passed. See {@link ConformanceSeverity}.
 */
export function conformanceErrors(diagnostics: readonly ConformanceDiagnostic[]): readonly ConformanceDiagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.severity === "error");
}

/**
 * The conformance audit as a count of problems, in the shape `core`'s validators
 * return.
 *
 * Offered so an imperative caller does not have to invent a stringification and
 * lose the code.
 *
 * Errors only, which is the same set `conformanceErrors` returns, and deliberately
 * *not* "everything except a note". A warning is a fact about the cell that the lock
 * cannot hold — a preset-provided global is conditional, not wrong — so failing on it
 * would refuse a supported configuration. A decision that could not be checked is the
 * opposite case and is an `error` rather than a warning, which is what keeps this
 * function from answering "no problems" to a lock nobody verified.
 */
export function validateLockDecisionConformance(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  options: ConformanceOptions = {},
): readonly string[] {
  return conformanceErrors(auditLockDecisionConformance(lock, options)).map(
    diagnostic => `${diagnostic.subject}: [${diagnostic.code}] ${diagnostic.detail}`,
  );
}
