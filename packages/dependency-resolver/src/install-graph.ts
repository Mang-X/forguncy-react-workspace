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

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse as parsePath } from "node:path";

/** Why a package the lock records could not be resolved to a version. */
export type UnresolvedInstalledPackageReason =
  /** Nothing in the install graph answers to that name, or nothing reached its manifest. */
  | "not-installed"
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

interface Manifest {
  readonly name: string;
  readonly version: string | undefined;
}

/**
 * The manifest of the package the resolved entry belongs to.
 *
 * The walk climbs from the entry's directory and stops at the first manifest that
 * declares a `name`, because that is what distinguishes a package's own manifest
 * from the ones that are not: the `package.json` files inside a package's tree
 * carry no `name` — an `{"type":"module"}` marker in `dist/esm/` is the common one
 * — and stopping at the first manifest *found* would read one of those and
 * conclude the package has no version.
 *
 * Two boundaries keep the walk inside the package. A directory named
 * `node_modules` is where a package tree ends, so passing one means the id was
 * never installed and the answer is "nothing", not "the project's own manifest" —
 * which is exactly what an unguarded walk would return, and would report as a name
 * mismatch against the project rather than as a missing package.
 */
async function nearestNamedManifest(startDirectory: string): Promise<Manifest | null> {
  let directory = startDirectory;
  for (;;) {
    if (parsePath(directory).base === "node_modules") {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (typeof record.name === "string") {
          return {
            name: record.name,
            version: typeof record.version === "string" && record.version.trim().length > 0 ? record.version : undefined,
          };
        }
      }
    } catch {
      // No manifest here, or one that is not readable JSON. Either way this
      // directory has nothing to contribute and the walk continues.
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * The `node_modules` directories a resolve from `projectRoot` is allowed to
 * answer out of — one per ancestor, the same walk Node performs.
 *
 * `require.resolve` cannot be trusted to keep that walk alone: `NODE_PATH` and
 * the other `Module.globalPaths` entries are appended to every resolution, and
 * the test runner injects `NODE_PATH` entries pointing into this workspace's
 * pnpm store. A package installed *here* would then be reported as installed in
 * the project that was asked about — which is the one answer this module must
 * never give, since it is the input to the lock's staleness rule.
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
 * Whether a resolved entry belongs to the project's own install graph.
 *
 * Two allowances, both answers to "could this project actually bundle it": a
 * path under an ancestor's `node_modules` — the graph Node walked — or a path
 * under `projectRoot` itself, which is where a `workspace:` link's realpath
 * lands after Node resolves the symlink. Anything else (an entry reached through
 * `NODE_PATH`, which lands in some other tree entirely) fails, and case is
 * ignored on Windows because the entry and the walk can disagree about drive
 * letter case while pointing at the same file.
 */
function isInProjectGraph(entry: string, projectRoot: string, roots: readonly string[]): boolean {
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const comparable = fold(entry);
  const hasPrefix = (prefix: string): boolean =>
    comparable === prefix || comparable.startsWith(`${prefix}/`) || comparable.startsWith(`${prefix}\\`);
  return hasPrefix(fold(projectRoot)) || roots.some(root => hasPrefix(fold(root)));
}

/**
 * Resolves one requested id to the manifest that provides it.
 *
 * Two attempts, in this order, because they fail in opposite cases. The
 * `<name>/package.json` form names the package root exactly and is unaffected by
 * which entry-point condition the resolver picks, but a package with a strict
 * `exports` map may not expose `./package.json` at all. The bare `<name>` form
 * always resolves *something*, and its entry point is then walked up to the
 * manifest — which is the only route for a subpath id such as
 * `react/jsx-runtime`.
 *
 * Every attempt is filtered through `isInProjectGraph`, because resolving
 * is not the same as scoping: a resolve that succeeds through a global path has
 * found *a* copy of the package, not this project's copy, and only the latter is
 * an answer to the question that was asked.
 */
async function resolveManifest(
  require: NodeJS.Require,
  request: string,
  projectRoot: string,
  roots: readonly string[],
): Promise<Manifest | null> {
  for (const candidate of [`${request}/package.json`, request]) {
    let entry: string;
    try {
      entry = require.resolve(candidate);
    } catch {
      continue;
    }
    // A builtin resolves to its own name rather than to a path, and has no manifest.
    if (!isAbsolute(entry)) {
      continue;
    }
    if (!isInProjectGraph(entry, projectRoot, roots)) {
      continue;
    }
    const manifest = await nearestNamedManifest(dirname(entry));
    if (manifest !== null) {
      return manifest;
    }
  }
  return null;
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
  // A filename, not a directory: `createRequire` takes the module whose
  // resolution scope is wanted, and it does not have to exist for the scope to be
  // correct. The manifest is what the walk up from here finds that matters.
  const require = createRequire(join(projectRoot, "package.json"));
  const roots = projectResolutionRoots(projectRoot);
  const requested = [...new Set(packageNames)].sort(compareStrings);

  const versions: Record<string, string> = {};
  const unresolved: UnresolvedInstalledPackage[] = [];

  for (const packageName of requested) {
    const manifest = await resolveManifest(require, packageName, projectRoot, roots);

    if (manifest === null) {
      unresolved.push({ packageName, reason: "not-installed" });
      continue;
    }
    if (!isSamePackage(manifest.name, packageName)) {
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
