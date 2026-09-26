/**
 * Where an installed package lives, asked of the host rather than of a private
 * exports walk.
 *
 * Decision source: GitHub Issue #89 — "修复 Probe：正确定位 import-only ESM 与隐藏
 * package.json 的包"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/89
 *
 * Governing Specs: #16 ("exact package/version/license/source", so the evidence is
 * about one artifact), #8 (`resolvedVersion` and `environment.source` are the same
 * identity), #4 (no second application-wide resolution system).
 *
 * **The defect this module closes.** Both consumers used to locate a package with
 * two `require.resolve` attempts — `<name>/package.json`, then bare `<name>` climbed
 * to its manifest. `require.resolve` answers under the **CommonJS `require`
 * condition**, so a package whose `exports` map publishes only an `import` branch
 * fails *both* attempts: measured on Node 24.21.0, `import-only-pkg`
 * (`exports: {".": {"import": "./lib/index.js"}}`) answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` twice while `import(...)` and rolldown both load it
 * happily. The consumer then reported the package as **not installed** — a statement
 * about the install graph that the install graph does not support. `subpath-only-pkg`
 * (`exports: {"./only": …}`, no `"."`) is the same shape one level out.
 *
 * **Identity is not the entry question, and this module only answers identity.** The
 * two were conflated by the two-attempt loop: it asked the resolver "which file does
 * this specifier name *for a require()*" when the question was "which artifact is
 * installed". They are separated here and stay separated:
 *
 * - *which artifact* — this module. Answered by `module.findPackageJSON`, the host's
 *   own package-directory lookup, which is **condition-independent**: it reports the
 *   package root regardless of which `exports` branch a resolver would pick.
 * - *which file a browser build enters through, and whether the specifier is exported
 *   at all* — the probe's `build` step, because only the bundler resolves under the
 *   conditions compilation uses (#16, #5). `build.ts` already reports a specifier the
 *   manifest does not publish as a `RESOLVE_ERROR`, so a non-exported name reaches a
 *   **failed build** rather than a fabricated browser entry. No second `exports`
 *   algorithm is maintained here — that is the whole point of the split.
 *
 * **Why the host primitive, and not `import.meta.resolve`.** `import.meta.resolve`
 * takes a parent URL, but measured on Node 24.21.0 it **ignores** it: resolving from a
 * temp project with the project's own URL as parent still resolved against the
 * *calling module*, so it cannot answer "what would *this project* import". It is also
 * `require`-shaped in the same way for the cases that matter here. `findPackageJSON`
 * takes the base as its first-class input and walks *that* location's ancestor
 * `node_modules` directories, which is the scope question being asked.
 *
 * **Two properties `findPackageJSON` has that the loop did not, both load-bearing:**
 *
 * - It never consults `NODE_PATH`. `require.resolve` appends every
 *   `Module.globalPaths` entry to each resolution, and the test runner injects
 *   `NODE_PATH` entries pointing into this workspace's pnpm store — measured, a probe
 *   of a fixture project answered `vitest@4.1.11` for a package the fixture does not
 *   install, describing *this* repository's install as the project's. `install-graph`
 *   had grown a `node_modules`-containment guard for exactly that leak; with this
 *   primitive the leak cannot happen at all, and the guard survives only for the case
 *   its own comment names — a `workspace:` link whose realpath lands outside the
 *   project.
 * - It returns the **root** manifest for a bare specifier even when the entry sits in
 *   a subdirectory carrying its own `{"type":"module"}` marker — measured on a package
 *   whose entry is `dist/esm/index.js` beside a nameless `dist/esm/package.json`. The
 *   climb-to-the-first-named-manifest that both consumers hand-rolled is therefore
 *   gone rather than duplicated.
 *
 * **The directory is realpath'd, and that is not cosmetic.** `findPackageJSON`
 * reports the path *through the symlink* (`<root>/node_modules/<name>`), while
 * `require.resolve` — and therefore the old code — reported the realpath. The probe's
 * scanners bound their work by `isInside(identity.directory, absolutePath)` against
 * module ids that come from **rolldown**, and rolldown reports realpaths: measured on
 * a pnpm-style link, rolldown's id was the store path while `findPackageJSON` named
 * the link. Without the realpath every `isInside` test would fail on a pnpm install
 * and the scan would silently reach zero files — a green report drawn from an empty
 * set, which is the failure class #16 exists to remove.
 */

import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";

/** Why a request could not be located in the install graph. */
export type PackageLocationFailureReason =
  /**
   * Nothing in the resolution scope answers to that name, or a directory of that
   * name exists without being a package.
   *
   * The second half is deliberate rather than sloppy: Node itself refuses a manifestless
   * directory (`import("some-dir")` answers `ERR_MODULE_NOT_FOUND`), so "does not
   * resolve" is the host's own answer and inventing a distinct reason for it would
   * describe a package that does not exist.
   */
  | "not-installed"
  /**
   * The manifest is there but is not parseable JSON, so name, version and source
   * cannot be established.
   *
   * This is a *reachable* reason for the first time. The climb it replaces skipped
   * every unreadable manifest and kept walking, so an unreadable package root
   * reported as `not-installed` — the install graph blamed for a corrupt file.
   */
  | "manifest-unreadable";

/** One installed package, located. */
export interface LocatedPackage {
  /** The package root, realpath'd — see the module header. */
  readonly directory: string;
  readonly manifestPath: string;
  /** The manifest as parsed. */
  readonly raw: Record<string, unknown>;
  /** The declared name, when the manifest has a non-blank string one. */
  readonly name: string | undefined;
  /** The declared version, when the manifest has a non-blank string one. */
  readonly version: string | undefined;
}

export type PackageLocation =
  | { readonly outcome: "located"; readonly package: LocatedPackage }
  | { readonly outcome: "failed"; readonly reason: PackageLocationFailureReason };

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The package `request` names, resolved from `base`'s location.
 *
 * `base` is a **file path or `file:` URL** inside the consuming project — the
 * resolution scope is the ancestor `node_modules` walk from its directory, so
 * `<projectRoot>/package.json` is the usual value and a package's own manifest is the
 * value for the transitive walk. It need not exist as a file, but its *directory*
 * must, because the walk starts there; a directory path (rather than a file path)
 * makes the host throw, which is why every caller passes a joined filename.
 *
 * Never throws for a missing package: absence is a `failed` result with a reason,
 * because both consumers report it rather than crash on it.
 */
export async function locatePackage(base: string, request: string): Promise<PackageLocation> {
  let found: string | undefined;
  try {
    found = findPackageJSON(request, base);
  } catch {
    // `ERR_MODULE_NOT_FOUND` for a name nothing answers, `ERR_INVALID_MODULE_SPECIFIER`
    // for a malformed scope, `ERR_INVALID_URL_SCHEME` for a `node:`-prefixed request.
    // All three mean the same thing to a caller: this request has no artifact here.
    return { outcome: "failed", reason: "not-installed" };
  }
  if (found === undefined || found.length === 0) {
    return { outcome: "failed", reason: "not-installed" };
  }

  let directory: string;
  try {
    // The manifest *path* may not exist (the host reports the root of a directory that
    // has no `package.json`), so the realpath is taken on the directory, which does.
    directory = await realpath(dirname(found));
  } catch {
    return { outcome: "failed", reason: "not-installed" };
  }
  const resolvedManifestPath = join(directory, "package.json");

  let text: string;
  try {
    text = await readFile(resolvedManifestPath, "utf8");
  } catch {
    // A directory of that name that carries no manifest is not a package — the same
    // answer Node gives it.
    return { outcome: "failed", reason: "not-installed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outcome: "failed", reason: "manifest-unreadable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: "failed", reason: "manifest-unreadable" };
  }

  const raw = parsed as Record<string, unknown>;
  return {
    outcome: "located",
    package: {
      directory,
      manifestPath: resolvedManifestPath,
      raw,
      name: nonBlankString(raw["name"]),
      version: nonBlankString(raw["version"]),
    },
  };
}
