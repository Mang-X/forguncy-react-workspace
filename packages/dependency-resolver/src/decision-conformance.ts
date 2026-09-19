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
 */

import type { DependencyStrategy, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import { CELL_PRESET_LIBRARIES, compareLockDecisions } from "@forguncy-react-workspace/core";

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
   * Omitting it is not the same as an empty one: absent means "this project has no
   * catalog to check against", which is reported as unverified, while an empty
   * catalog means "the catalog exists and holds nothing", which makes every
   * extension decision unverified *and* wrong. Only the absence is a warning.
   */
  readonly extensionCatalog?: ExtensionCatalog;
}

/**
 * #9's initial host mappings, pending #9's own implementation.
 *
 * The five entries below are the candidates #9 lists. `react-dom/client` and the
 * two JSX runtimes are subpath ids, so they ride on their package's mapping; the
 * JSX runtimes are deliberately *not* mapped to the React object, because #9 says
 * not to — see `host-jsx-runtime-mapped-to-react-object`, which enforces exactly
 * that.
 *
 * `antd` is here as a mapping and separately reported as preset-provided, which is
 * the honest combination: #9 says the import maps to the host `antd` global, and
 * #5 says that global exists only when the cell's preset chain loads it.
 */
export const DEFAULT_HOST_BRIDGE_MANIFEST: HostBridgeManifest = {
  mappings: [
    { packageName: "react", globalName: "React", identityField: "hostReactVersion" },
    { packageName: "react-dom", globalName: "ReactDOM", moduleIds: ["react-dom/client"] },
    { packageName: "antd", globalName: "antd" },
  ],
};

/**
 * The JSX runtime module ids, which #9 requires an explicit adapter for.
 *
 * Bridged by definition rather than by a mapping entry: #9 says these resolve to an
 * adapter that preserves `jsx(type, props, key)` semantics, so there is no page
 * global they name — the adapter is generated. That is why the audit's rule about
 * them is only the prohibition below, and why they are not listed in
 * `DEFAULT_HOST_BRIDGE_MANIFEST` with a global they do not have.
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
  "host-jsx-runtime-mapped-to-react-object",
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

/** `error` means the record cannot be right; `warning` means it needs a fact the lock does not hold. */
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

/** The page global #9 maps `react` to, read from the manifest rather than restated. */
function reactHostGlobal(manifest: HostBridgeManifest): string | undefined {
  return hostMappingFor(manifest, "react")?.globalName;
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

  // The JSX runtime ids count as bridged even though no entry maps them, because #9
  // bridges them with a generated adapter. Reporting them as unprovided would flag
  // the one mapping #9 explicitly specifies.
  const bridged = mapping !== undefined || JSX_RUNTIME_MODULE_IDS.includes(packageName);
  if (!bridged && preset === undefined) {
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

  const reactGlobal = reactHostGlobal(manifest);
  if (reactGlobal !== undefined && JSX_RUNTIME_MODULE_IDS.includes(packageName) && globalName === reactGlobal) {
    diagnostics.push(
      error(
        "host-jsx-runtime-mapped-to-react-object",
        packageName,
        `"${packageName}" is mapped to the React object, which does not preserve \`jsx(type, props, key)\` semantics — including \`props.children\` and \`key\`. #9 requires an explicit JSX-runtime adapter for this module id, not the React global.`,
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

function auditHostInlineConflict(
  strategyByPackage: ReadonlyMap<string, ReadonlySet<DependencyStrategy>>,
): readonly ConformanceDiagnostic[] {
  const diagnostics: ConformanceDiagnostic[] = [];

  for (const packageName of [...strategyByPackage.keys()].sort()) {
    const strategies = strategyByPackage.get(packageName);
    if (strategies === undefined || !strategies.has("host") || !strategies.has("inline")) {
      continue;
    }
    diagnostics.push(
      error(
        "host-inline-conflict",
        packageName,
        `"${packageName}" is decided as \`host\` somewhere in this lock and as \`inline\` somewhere else. A host global is page-wide, so the inlined copy is a second instance of a module the page already has — the duplicate-identity failure #9 forbids, whichever cell each decision was recorded for.`,
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

  if (catalog === undefined) {
    return [
      warning(
        "extension-catalog-missing",
        packageName,
        `"${libraryId}" was not checked against a verified catalog. #12 requires the id to come from \`api.app.listFrontendLibraries\` or a verified catalog artifact rather than a display name, so pass an extensionCatalog to check it.`,
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
  const strategyByPackage = new Map<string, Set<DependencyStrategy>>();
  const extensionRecords: (LockedDependencyDecision & {
    readonly libraryId: string;
    readonly globalName: string;
  })[] = [];

  for (const record of decisions) {
    const strategies = strategyByPackage.get(record.packageName) ?? new Set<DependencyStrategy>();
    strategies.add(record.strategy);
    strategyByPackage.set(record.packageName, strategies);

    if (record.strategy === "host") {
      diagnostics.push(...auditHostRecord(record, manifest));
    }
    if (record.strategy === "extension") {
      diagnostics.push(...auditExtensionRecord(record, options.extensionCatalog));
      extensionRecords.push(record);
    }
  }

  diagnostics.push(...auditHostInlineConflict(strategyByPackage));
  diagnostics.push(...auditExtensionMappingConflicts(extensionRecords));

  return diagnostics;
}

/** The findings that make a decision wrong rather than merely incomplete. */
export function conformanceErrors(diagnostics: readonly ConformanceDiagnostic[]): readonly ConformanceDiagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.severity === "error");
}

/**
 * The conformance audit as a count of problems, in the shape `core`'s validators
 * return.
 *
 * Offered so an imperative caller does not have to invent a stringification and
 * lose the code. Errors only: a warning is a fact the lock cannot hold, and
 * turning it into a failure would refuse a supported configuration.
 */
export function validateLockDecisionConformance(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  options: ConformanceOptions = {},
): readonly string[] {
  return conformanceErrors(auditLockDecisionConformance(lock, options)).map(
    diagnostic => `${diagnostic.subject}: [${diagnostic.code}] ${diagnostic.detail}`,
  );
}
