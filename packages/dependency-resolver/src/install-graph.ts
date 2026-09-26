/**
 * What is actually installed, by exact version.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" — https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * — plan item 3 of #24: "Resolve installed exact package versions from the
 * workspace lock/install graph."
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * Why this exists: `LockEnvironment.resolvedVersions` is what decides whether an
 * exact package version change has invalidated a recorded decision (#8, rule 2).
 * While that map was hand-written, the staleness rule was only ever as true as
 * whoever typed it — the one input the whole invalidation path depends on was the
 * one input nothing produced.
 *
 * **The install graph, not the lock *file*.** A package manager's own lock file
 * is one package manager's format, and reading it would mean one parser per
 * manager and a second implementation of resolution that can disagree with the
 * one that bundles the cell. The graph the bundler walks — `node_modules`, through
 * the manager's symlinks and nesting — is the same input in every one of those
 * formats, and it is the answer that matters: the version a cell would actually
 * bundle is the version resolution reaches, not the one a manifest asked for.
 *
 * **Identity, not entry resolution.** Which artifact a name names is asked of
 * `package-locator` (#89), whose host primitive is condition-independent; the
 * version recorded here is that artifact's, whatever `exports` branch a resolver
 * would pick. A request whose manifest is unreadable is reported as
 * `manifest-unreadable` rather than folded into `not-installed`, because blaming
 * the install graph for a corrupt file names the wrong fix.
 *
 * **Only versions cross this boundary.** No path this module discovers is ever
 * returned, so a machine-specific directory cannot leak from here into
 * `fgc.lock.json`, whose portability rule is enforced in `core`. What leaves is a
 * package name and a version string.
 *
 * **Unresolved is a result, not an exception.** A package the lock records and the
 * workspace no longer installs is a normal consequence of an edit in progress;
 * `LockEnvironment` reports the missing entry as `package-version-unknown`, which
 * is stale rather than verified. Throwing here would instead turn "you have not
 * run install yet" into a crash in the middle of an Agent flow.
 */

import { dirname, join } from "node:path";

import { locatePackage } from "./package-locator.ts";

/** Why a package the lock records could not be resolved to a version. */
export type UnresolvedInstalledPackageReason =
  /** Nothing in the install graph answers to that name, or nothing reached its manifest. */
  | "not-installed"
  /**
   * A manifest was found, but could not be read or parsed.
   *
   * Distinct from `not-installed` because the fixes differ: this one is already
   * present and broken, so "run install" is the wrong advice (#89).
   */
  | "manifest-unreadable"
  /**
   * The request is not a package name — a relative path, a `node:`-prefixed
   * specifier, a malformed scope.
   *
   * Reported rather than folded into `not-installed` so a caller can tell a bad
   * input from a missing dependency; a lock record naming such a string is a lock
   * defect, not an unrun install (#89).
   */
  | "invalid-specifier"
  /**
   * The project's own manifest cannot be read, so the install graph cannot be
   * walked at all.
   *
   * A property of the consuming project rather than of any one request. Every
   * request in the same call reports it, which is the honest signal: one broken
   * project file, not N missing dependencies (#89).
   */
  | "base-unreadable"
  /** A manifest was found, but declares no usable `version`. */
  | "manifest-without-version"
  /**
   * The nearest manifest is a different package.
   *
   * Reported rather than accepted because it is the shape an alias takes: with
   * `"react": "npm:preact@10"` installed, resolution succeeds and the version it
   * finds belongs to `preact`. Recording that as `react`'s version would make the
   * staleness rule compare a decision about React against a number that describes
   * something else, and report the decision as fresh.
   */
  | "manifest-name-mismatch";

export interface UnresolvedInstalledPackage {
  readonly packageName: string;
  readonly reason: UnresolvedInstalledPackageReason;
  /** What the nearest manifest called itself, when that is what disagreed. */
  readonly manifestName?: string;
}

export interface InstalledVersions {
  /** Exact installed version by package name. Every value is a version, never a path. */
  readonly versions: Readonly<Record<string, string>>;
  /**
   * The requests that produced no version, ordered by package name.
   *
   * Reported instead of dropped so a caller can distinguish "not installed yet"
   * from "the lock records nothing", which are different fixes.
   */
  readonly unresolved: readonly UnresolvedInstalledPackage[];
}

/** Module ids that resolve to a package whose manifest declares a different name. */
function isSamePackage(manifestName: string, request: string): boolean {
  return manifestName === request || request.startsWith(`${manifestName}/`);
}

/** The name and version a located manifest provides. Either may be absent. */
interface Manifest {
  readonly name: string | undefined;
  readonly version: string | undefined;
}

/**
 * What one request resolved to: a manifest, or the reason it did not.
 *
 * A discriminated result rather than `Manifest | null`, because "nothing answered"
 * and "a manifest answered but could not be read" are different fixes and
 * `LockEnvironment` reports them as different staleness reasons. Collapsing them
 * into `null` is what the old climb did, and it blamed the install graph for a
 * corrupt file.
 */
type ManifestResolution =
  | { readonly outcome: "resolved"; readonly manifest: Manifest }
  | { readonly outcome: "unresolved"; readonly reason: UnresolvedInstalledPackageReason };

/**
 * The `node_modules` directories a resolution from `projectRoot` is allowed to
 * answer out of — one per ancestor, the same walk Node performs.
 */
function projectResolutionRoots(projectRoot: string): string[] {
  const roots: string[] = [];
  let directory = projectRoot;
  for (;;) {
    roots.push(join(directory, "node_modules"));
    const parent = dirname(directory);
    if (parent === directory) {
      return roots;
    }
    directory = parent;
  }
}

/**
 * Whether a located package directory belongs to the project's own install graph.
 *
 * Two allowances, both answers to "could this project actually bundle it": a path
 * under an ancestor's `node_modules` — the graph Node walked — or a path under
 * `projectRoot` itself, which is where a `workspace:` link's realpath lands after
 * Node resolves the symlink. Case is ignored on Windows because the located
 * directory and the walk can disagree about drive-letter case while pointing at
 * the same file.
 *
 * This guard used to be what kept `NODE_PATH` out, because `require.resolve`
 * appends every `Module.globalPaths` entry and the test runner injects
 * `NODE_PATH` entries pointing into this workspace's pnpm store — measured, a
 * temp project was told it installs `vitest@4.1.11`. `package-locator` asks a host
 * primitive that never consults `NODE_PATH`, so that leak is now structurally
 * impossible and this is left with the case its own comment names: a `workspace:`
 * link whose realpath is outside `projectRoot` and outside every ancestor's
 * `node_modules`.
 */
function isInProjectGraph(directory: string, projectRoot: string, roots: readonly string[]): boolean {
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const comparable = fold(directory);
  const hasPrefix = (prefix: string): boolean =>
    comparable === prefix || comparable.startsWith(`${prefix}/`) || comparable.startsWith(`${prefix}\\`);
  return hasPrefix(fold(projectRoot)) || roots.some(root => hasPrefix(fold(root)));
}

/**
 * Locates one requested id, filtered to this project's install graph.
 *
 * One attempt, not two. The `<name>/package.json`-then-bare-`<name>` pair existed
 * because `require.resolve` answers under the CommonJS condition and can fail for
 * both spellings of a package that is installed — measured on an `import`-only
 * `exports` map, where both answered `ERR_PACKAGE_PATH_NOT_EXPORTED` and the
 * package was reported as not installed (#89). `locatePackage` asks the host's
 * package-directory lookup, which is condition-independent, so the second attempt
 * has nothing left to cover: there is no exports map under which the *identity*
 * question goes unanswered.
 *
 * A subpath id such as `react/jsx-runtime` still resolves to React's manifest, and
 * that is now the locator's own behaviour rather than a climb this module performs
 * — which is why the walk-up is gone rather than shared.
 */
async function resolveManifest(
  request: string,
  projectRoot: string,
  roots: readonly string[],
): Promise<ManifestResolution> {
  const location = await locatePackage(join(projectRoot, "package.json"), request);
  if (location.outcome === "failed") {
    return { outcome: "unresolved", reason: location.reason };
  }
  const found = location.package;
  if (!isInProjectGraph(found.directory, projectRoot, roots)) {
    return { outcome: "unresolved", reason: "not-installed" };
  }
  return { outcome: "resolved", manifest: { name: found.name, version: found.version } };
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * The exact installed version of every requested package.
 *
 * `projectRoot` is the workspace whose install graph is read, and resolution
 * starts there — not from this package, whose own `node_modules` is a different
 * graph and would answer for a different install. Requests are deduplicated, and
 * both halves of the result are ordered, so the same install always produces the
 * same answer.
 */
export async function resolveInstalledVersions(
  projectRoot: string,
  packageNames: readonly string[],
): Promise<InstalledVersions> {
  // A filename, not a directory: the locator takes the location whose resolution
  // scope is wanted, and it does not have to exist for the scope to be correct —
  // the ancestor `node_modules` walk from its directory is what answers.
  const roots = projectResolutionRoots(projectRoot);
  const requested = [...new Set(packageNames)].sort(compareStrings);

  const versions: Record<string, string> = {};
  const unresolved: UnresolvedInstalledPackage[] = [];

  for (const packageName of requested) {
    const resolution = await resolveManifest(packageName, projectRoot, roots);

    if (resolution.outcome === "unresolved") {
      unresolved.push({ packageName, reason: resolution.reason });
      continue;
    }
    const manifest = resolution.manifest;
    if (manifest.name === undefined || !isSamePackage(manifest.name, packageName)) {
      // An unnamed manifest is reported as a mismatch for the same reason a
      // differently-named one is: the nearest manifest does not call itself what
      // was asked for, so recording its version would tie the evidence to an
      // artifact the request does not name.
      unresolved.push({ packageName, reason: "manifest-name-mismatch", manifestName: manifest.name });
      continue;
    }
    if (manifest.version === undefined) {
      unresolved.push({ packageName, reason: "manifest-without-version" });
      continue;
    }

    versions[packageName] = manifest.version;
  }

  return { versions, unresolved };
}
