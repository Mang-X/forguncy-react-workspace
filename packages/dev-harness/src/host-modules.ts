/**
 * The local host-module bridge: what a bridged import resolves to while a Cell is
 * being developed, derived from the compiler's own table rather than restated.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 4
 *   requires reusing "the host-module bridge mapping where possible so compiler/dev
 *   behavior does not drift", under
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which makes it an
 *   acceptance criterion ("Host dependency mapping is reusable between compiler and
 *   dev runtime instead of maintaining two unrelated maps"), and
 * - #9 — "host module bridge for React, ReactDOM, antd and built-in globals"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/9), which owns the table.
 *
 * ## One table, two answers
 *
 * `HOST_BRIDGE_MAPPINGS` answers "which module ids does the page provide?". The two
 * consumers answer it differently, on purpose:
 *
 * - the **compile** path generates a module that binds a page global
 *   (`cell-compiler`'s `planHostBridge`), because the artifact runs on a page;
 * - the **dev** path resolves the id to an installed npm package, because there is no
 *   page whose global could be bound.
 *
 * `runtime`'s `LOCAL_DEV_MODULE_RESOLUTIONS` already records the dev-side answer, one
 * row per bridge row, guarded in both directions against `HOST_BRIDGE_MAPPINGS` by
 * `assertLocalDevResolutionsCoverHostBridge`. This module is the part that *acts* on
 * that record: it derives the resolution the Vite server installs, and it refuses to
 * act on anything the record does not say. So there is no second table here and no
 * package name typed into a resolver — `host-modules.test.ts` asserts the mapping is
 * derived, by adding a bridge row and observing the resolution change.
 *
 * ## Why the harness supplies the packages rather than the example
 *
 * `examples/host-antd/package.json` records the rule this has to respect: an example
 * does **not** install `react`, because `react` is decided `host` and the bridge
 * intercepts the specifier before node resolution. Installing it would be "a silent
 * escape hatch for a broken interception". That is correct for the artifact — and it
 * means a dev process, which has no page global to bind, would have nothing to
 * resolve the import to.
 *
 * So the harness supplies the substitution itself, from its own dependencies, at the
 * version #5 recorded. This is not the escape hatch the example refuses: the example
 * is still untouched, the alias is installed by the same module that reads #9's
 * table, and the version is checked rather than trusted — see
 * {@link hostPackageVersionExpectations}. It is also the only arrangement that makes
 * `vp dev` exercise the *Cell's* code against the host's React version, which is what
 * #22's local loop is for.
 *
 * ## The generated bridge modules are not run
 *
 * `LOCAL_DEV_HOST_RESOLUTION_MODEL.runsGeneratedBridgeModules` is `false`, and that is
 * the decision this module implements. A generated bridge module exists to bind a page
 * global; locally there is none, so wiring the compiler's interpositions into Vite
 * would not be a resolution — it would be a failure deferred to the first import, under
 * a name implying the loop was already wired. What resolves here is the published
 * package, which is why the local loop is *more permissive* in one specific place
 * (`react-dom/client` is the whole published module locally, where the page narrows it
 * to the members #5 observed). That is `LOCAL_DEV_MODULE_RESOLUTIONS`' own note on the
 * row, and this module neither restates nor contradicts it.
 *
 * ## What is refused rather than approximated
 *
 * A bridged id the record marks `unsupported` throws when asked for, with the recorded
 * reason attached. Falling back to the ordinary npm path is the one option not
 * available: it would make a bridged import indistinguishable from an unbridged one,
 * which is the silent local-only pass the record exists to prevent.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { hostBridgeInterceptedModuleIds } from "@forguncy-react-workspace/core";
import {
  findLocalDevModuleIdResolution,
  localDevAlignmentChecks,
} from "@forguncy-react-workspace/runtime";
import type { LocalDevVersionField } from "@forguncy-react-workspace/runtime";

/**
 * Raised when the harness is asked to resolve a bridged module the contract says has
 * no local stand-in.
 *
 * Its own type rather than a bare `Error`, because a caller has to tell three
 * situations apart: "not bridged, use the normal path" (no throw, `undefined`), "bridged
 * and resolvable" (no throw, a target), and "bridged and not simulatable" (this throw,
 * with the contract's own reason attached).
 */
export class LocalHostResolutionError extends Error {
  /** The module id asked about. */
  readonly moduleId: string;
  /** The bridge row's specifier, when a row covers the id. */
  readonly specifier?: string;

  constructor(moduleId: string, message: string, specifier?: string) {
    super(message);
    this.name = "LocalHostResolutionError";
    this.moduleId = moduleId;
    if (specifier !== undefined) this.specifier = specifier;
  }
}

/** One bridged id, and the local package that stands in for it. */
export interface HostModuleStandIn {
  readonly moduleId: string;
  /** The bridge row this came from, so a report can name the decision not the symptom. */
  readonly specifier: string;
  /** The installed package the id resolves through locally. */
  readonly packageName: string;
}

/**
 * Resolve a module id to the package that stands in for it locally.
 *
 * Three outcomes, each deliberate: `undefined` for an id no bridge row names (the
 * ordinary npm path is already the same answer the compiler gives); a package for an id
 * a row covers; a throw for an id a row covers but the record declares unsupported.
 *
 * The lookup goes through `runtime`'s `findLocalDevModuleIdResolution` rather than over
 * `HOST_BRIDGE_MAPPINGS` here, and the reason is the subpath case: `react-dom/client`
 * and `react/jsx-dev-runtime` are module ids that are *not* row specifiers, so a
 * row-keyed lookup answers "no row" for two ids the bridge does intercept. Asking by
 * module id is what makes the projection usable per import, and it is why this harness
 * never enumerates the table itself.
 */
export function findHostModuleStandIn(moduleId: string): HostModuleStandIn | undefined {
  const found = findLocalDevModuleIdResolution(moduleId);
  if (found === undefined) {
    return undefined;
  }

  const { specifier, resolution } = found;
  const target = resolution.localPackage;

  if (resolution.resolution === "unsupported" || typeof target !== "string" || target.trim().length === 0) {
    throw new LocalHostResolutionError(
      moduleId,
      `The host bridge intercepts "${moduleId}" (row "${specifier}") and the local development contract declares no stand-in for it, so it cannot be resolved locally. ` +
        `Resolving it through the ordinary npm path instead would let a bridged import behave as an unbridged one — the local-only pass that record exists to prevent. ` +
        `What the contract records: ${resolution.alignmentUnchecked ?? resolution.note}`,
      specifier,
    );
  }

  return { moduleId, specifier, packageName: target };
}

/**
 * Every bridged id the local loop can stand in for, with its package.
 *
 * Derived in the bridge table's own order rather than from the resolution rows, so the
 * order is the table's — a report that listed ids in a different order from the table it
 * came from would make two descriptions of one decision look like two decisions.
 *
 * An id whose row has no local stand-in contributes nothing: the throw is what reports
 * it, and only when something resolves that id. Listing it among resolvable ids would be
 * a second, weaker statement about the same row.
 */
export function hostModuleStandIns(): readonly HostModuleStandIn[] {
  const standIns: HostModuleStandIn[] = [];

  for (const moduleId of hostBridgeInterceptedModuleIds()) {
    let standIn: HostModuleStandIn | undefined;
    try {
      standIn = findHostModuleStandIn(moduleId);
    } catch {
      continue;
    }
    if (standIn !== undefined) {
      standIns.push(standIn);
    }
  }

  return standIns;
}

/** A version the harness has to install, and the field #5 recorded it in. */
export interface HostPackageVersionExpectation {
  readonly packageName: string;
  readonly field: LocalDevVersionField;
  /** #5's recorded value, read through `runtime` and never stored here. */
  readonly expected: string;
  /** The bridge rows whose substitution this version belongs to, for a report. */
  readonly specifiers: readonly string[];
}

/**
 * The packages whose installed version #5 pinned, keyed by package.
 *
 * Derived from `runtime`'s `localDevAlignmentChecks`, which is itself derived from the
 * recorded version fields — so this harness cannot compare against a number it typed.
 * A package with no recorded version (`antd`) is absent, and the reason is recorded in
 * the resolution row rather than invented here; a package whose rows disagree would be a
 * contract error the coverage guard already refuses.
 *
 * Grouped by package because the rows are keyed by *specifier*: `react` and
 * `react/jsx-runtime` are two bridge rows and one installed package, and a harness that
 * demanded the version twice would make one package's version look like two facts.
 */
export function hostPackageVersionExpectations(): readonly HostPackageVersionExpectation[] {
  const grouped = new Map<string, { field: LocalDevVersionField; expected: string; specifiers: string[] }>();

  for (const expectation of localDevAlignmentChecks()) {
    const existing = grouped.get(expectation.localPackage);
    if (existing === undefined) {
      grouped.set(expectation.localPackage, {
        field: expectation.field,
        expected: expectation.expected,
        specifiers: [expectation.specifier],
      });
      continue;
    }
    if (existing.expected !== expectation.expected) {
      // Two rows, one package, two recorded versions: the contract's own rows disagree,
      // and picking either would make the harness's answer depend on row order.
      throw new LocalHostResolutionError(
        expectation.localPackage,
        `The local resolution rows record two different expected versions for package "${expectation.localPackage}" (${existing.expected} and ${expectation.expected}), so which one the harness installs would depend on row order.`,
        expectation.specifier,
      );
    }
    existing.specifiers.push(expectation.specifier);
  }

  return [...grouped].map(([packageName, entry]) => ({ packageName, ...entry }));
}

/** The directory this package's own files live in, from the module URL. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The absolute directory a bridged module id resolves to locally.
 *
 * Absolute because the point is to bind *this* copy: examples deliberately do not install
 * `react` (see the module docstring), so a bare specifier would resolve from the importing
 * example's directory and simply not be found. Resolving from this package's own
 * dependencies is also what guarantees a single React instance for the whole dev loop —
 * the identity #11 measured on a page, reproduced locally by there being one copy rather
 * than by a dedupe setting that a second install could defeat.
 *
 * `createRequire` on this package's own `package.json` rather than a path join, so the answer
 * follows node's real resolution (pnpm's symlinks included) instead of assuming a layout.
 *
 * `undefined` rather than a throw when the package is absent, and the difference matters: #9's
 * table intercepts `antd`, `antd` is a legitimate `host` dependency, and this harness does not
 * install it — the page provides it. One Cell importing `antd` must not make a *project's* dev
 * server refuse to start, because every other Cell in that project would pay for it. What
 * happens instead is {@link unavailableHostModules}: the id is still aliased, to a module that
 * throws the explanation at the import site. The failure lands on the import that needs the
 * package, which is where the fix is.
 */
export function hostModuleResolutionPath(moduleId: string): string | undefined {
  const standIn = findHostModuleStandIn(moduleId);
  if (standIn === undefined) {
    return undefined;
  }

  const require = createRequire(`${packageRoot}/package.json`);
  try {
    // The package *directory*, not its entry file, and the choice is load-bearing twice over.
    //
    // First, alias targets are matched as prefixes by Vite, so binding the directory keeps the
    // package's own subpaths (`react-dom/client`, `react/jsx-runtime`) resolving inside the bound
    // copy instead of escaping to whichever copy the importer's directory would have found.
    //
    // Second, and this is the one that bit: binding a *file* bypasses Vite's dependency optimizer.
    // `react`'s `index.js` is CommonJS, so a browser importing it directly gets no named exports
    // and the first `import { createElement } from "react"` fails with "does not provide an export
    // named 'createElement'" — a message about React that is really about how the module was
    // reached. A directory target goes through the ordinary resolution path, so the optimizer
    // interops the CJS package exactly as it would with no alias at all.
    return dirname(require.resolve(`${standIn.packageName}/package.json`));
  } catch {
    return undefined;
  }
}

/**
 * The `resolve.alias` entries the dev server is built from: one per resolvable bridged id.
 *
 * The ids come from the bridge table, so a row added to #9's table reaches the dev server
 * without anyone editing a resolver here; the paths come from this package's install, so
 * the substitution is one copy at one version.
 *
 * `react/jsx-dev-runtime` needs no special case, and it is worth saying why, because it is
 * the id authored JSX actually compiles to during development and therefore the one a
 * hand-written entry would be most tempting for. #9 carries it as a `moduleId` on the
 * `react/jsx-runtime` adapter row, so it arrives through the same derivation as every
 * other id. A hand-written entry here could disagree with the table while still passing
 * `assertLocalDevResolutionsCoverHostBridge`, because the table already covers the id.
 * That this happens is asserted in `host-modules.test.ts` rather than assumed.
 */
/** A bridged module id this harness cannot serve, with the reason and the fix. */
export interface UnavailableHostModule {
  readonly moduleId: string;
  /** The bridge row the id belongs to. */
  readonly specifier: string;
  /** The package the row resolves to, which this harness has not installed. */
  readonly packageName: string;
  /** Why the dev loop cannot stand in for it, in one sentence. */
  readonly reason: string;
}

/**
 * The bridged ids this harness has no copy of.
 *
 * A state the harness *reports* rather than an error it raises, and the distinction is #22's:
 * `LOCAL_DEV_STRATEGY_HANDLINGS` records that a `host` dependency's local handling is
 * `host-substitution`, and this is the case where the substitution is missing from the dev
 * process. Refusing to start would be wrong — `antd` is legitimately absent from an example
 * that does not use it, and the page still provides it — and letting the import take the
 * ordinary npm path would be worse, because it would either fail with Vite's generic message
 * or, if another install happened to be reachable, bind a copy the artifact will never carry.
 *
 * So these ids are aliased to a generated module that throws the explanation, which puts the
 * failure on the import that needs the package and leaves every other Cell in the project
 * running.
 */
export function unavailableHostModules(): readonly UnavailableHostModule[] {
  const unavailable: UnavailableHostModule[] = [];

  for (const standIn of hostModuleStandIns()) {
    if (hostModuleResolutionPath(standIn.moduleId) !== undefined) {
      continue;
    }
    unavailable.push({
      moduleId: standIn.moduleId,
      specifier: standIn.specifier,
      packageName: standIn.packageName,
      reason: `The host bridge resolves "${standIn.moduleId}" to the package "${standIn.packageName}", which the dev harness has not installed.`,
    });
  }

  return unavailable;
}

/**
 * The prefix marking a module id as an *unserved* host substitution.
 *
 * Its own prefix rather than a marker inside the alias target, because Vite dispatches on the
 * id: `load` has to recognise these without re-deriving which package was missing, so a prefix
 * makes that a string test instead of a second lookup that could disagree with the first.
 */
export const UNAVAILABLE_HOST_MODULE_PREFIX = "virtual:forguncy-dev-harness/host-unavailable/";

/** The virtual module id an unserved host substitution is aliased to. */
export function unavailableHostModuleId(moduleId: string): string {
  return `${UNAVAILABLE_HOST_MODULE_PREFIX}${moduleId}`;
}

/** The module id an unserved alias points at, or `undefined` when it is not one. */
export function unavailableHostModuleOf(id: string): string | undefined {
  return id.startsWith(UNAVAILABLE_HOST_MODULE_PREFIX)
    ? id.slice(UNAVAILABLE_HOST_MODULE_PREFIX.length)
    : undefined;
}

/**
 * The source of the module an unserved host substitution resolves to.
 *
 * It throws rather than exporting a value, and that is the point: the developer's stack trace
 * then ends at the authored `import` that needs the package, which is where the decision has
 * to be made — install it, or keep the import and validate on a real page, where the page's own
 * global is what binds.
 */
export function unavailableHostModuleSource(moduleId: string): string {
  const unavailable = unavailableHostModules().find(candidate => candidate.moduleId === moduleId);
  if (unavailable === undefined) {
    // Reached only by a caller asking for a source for an id that *is* served, which is a
    // programming error here rather than a configuration one — the alias table and this
    // function are derived from one list, so a mismatch means one of them was edited alone.
    throw new LocalHostResolutionError(
      moduleId,
      `No unserved host substitution is recorded for "${moduleId}", so there is no explanation to generate. The alias table and this function are derived from one list; a mismatch means one of them was edited alone.`,
    );
  }

  const explanation =
    `${unavailable.reason} Add "${unavailable.packageName}" to packages/dev-harness/package.json to develop this Cell against it locally — or keep the import and validate it on a real page, where ` +
    `"${unavailable.specifier}" is the page's own global and the artifact is correct either way.`;

  const lines = [
    `// Generated by @forguncy-react-workspace/dev-harness. The host bridge intercepts this module`,
    `// id, and the dev harness has no copy of the package it resolves to.`,
    `throw new Error(${JSON.stringify(explanation)});`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * The `resolve.alias` entries the dev server is built from: one per bridged id.
 *
 * **Every** bridged id is aliased, and that is the property this function exists for: an id the
 * bridge intercepts can never silently take the ordinary npm path, whether or not this harness
 * can serve it. An installed package binds this package's copy at one version; an uninstalled
 * one binds a module that throws, so the failure lands on the import rather than in Vite's
 * resolver with a message about a missing dependency.
 *
 * The ids come from the bridge table, so a row added to #9's table reaches the dev server
 * without anyone editing a resolver here.
 *
 * `react/jsx-dev-runtime` needs no special case, and it is worth saying why, because it is the
 * id authored JSX actually compiles to during development and therefore the one a hand-written
 * entry would be most tempting for. #9 carries it as a `moduleId` on the `react/jsx-runtime`
 * adapter row, so it arrives through the same derivation as every other id. A hand-written entry
 * here could disagree with the table while still passing
 * `assertLocalDevResolutionsCoverHostBridge`, because the table already covers the id. That this
 * happens is asserted in `host-modules.test.ts` rather than assumed.
 */
export function hostModuleAliases(): Readonly<Record<string, string>> {
  const aliases: Record<string, string> = {};

  for (const standIn of hostModuleStandIns()) {
    const target = hostModuleResolutionPath(standIn.moduleId);
    aliases[standIn.moduleId] = target ?? unavailableHostModuleId(standIn.moduleId);
  }

  return aliases;
}

/**
 * The setting that makes a second copy of a host-decided package impossible.
 *
 * `resolve.alias` alone binds the specifiers the bridge intercepts, and `react-dom/client`
 * is exactly such a specifier — but `react-dom/server` deliberately is *not* bridged
 * (there is no page global for it), so a Cell that imported it would resolve from the
 * importer's directory and could reach a different copy than the aliased one. Deduping the
 * packages covers that gap, and it costs nothing where the alias already applies.
 *
 * Derived from the stand-ins rather than listed, so the two mechanisms cannot disagree
 * about which packages the page owns.
 */
export function hostModuleDedupePackages(): readonly string[] {
  // Only the packages this harness actually installed: `dedupe` tells Vite to collapse a
  // package to one copy, and naming one that is absent would make Vite look for a copy to
  // keep. An unserved substitution is already covered by its alias to a throwing module.
  const installed = hostModuleStandIns().filter(standIn => hostModuleResolutionPath(standIn.moduleId) !== undefined);
  return [...new Set(installed.map(standIn => standIn.packageName))].sort();
}

/**
 * The version of a package as this harness installed it, or `undefined` when absent.
 *
 * Read through the same resolution the aliases use, so the version a report compares is
 * the version the dev server will actually load — not a manifest read from anywhere that
 * happens to have one.
 */
export function installedHostPackageVersion(packageName: string): string | undefined {
  const require = createRequire(`${packageRoot}/package.json`);
  try {
    const manifest = require(`${packageName}/package.json`) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

/** A package whose installed version is not the one #5 recorded. */
export interface HostPackageVersionMismatch {
  readonly packageName: string;
  readonly expected: string;
  readonly installed: string | undefined;
  readonly field: LocalDevVersionField;
}

/**
 * The harness's own install checked against #5's recorded versions.
 *
 * Not a gate on the loop: #22 records that a version mismatch does not stop a render
 * (`LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-host-version-mismatch"].blocksLocalDevelopment`
 * is `false`), and refusing to start would be the harness deciding that a difference it
 * cannot weigh matters more than the developer's time. It is reported instead, because a
 * Cell developed against a different React version is not evidence about this target, and
 * the two failures — a stale install and a newer host — have different fixes.
 *
 * An absent package is a mismatch rather than a skip: the loop cannot run without the
 * substitution at all, and `hostModuleAliases` would already have thrown naming it.
 */
export function hostPackageVersionMismatches(): readonly HostPackageVersionMismatch[] {
  const mismatches: HostPackageVersionMismatch[] = [];

  for (const expectation of hostPackageVersionExpectations()) {
    const installed = installedHostPackageVersion(expectation.packageName);
    if (installed === expectation.expected) {
      continue;
    }
    mismatches.push({
      packageName: expectation.packageName,
      expected: expectation.expected,
      installed,
      field: expectation.field,
    });
  }

  return mismatches;
}
