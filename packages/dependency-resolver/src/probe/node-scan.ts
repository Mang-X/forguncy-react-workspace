/**
 * The `node-builtin-scan` step: Node assumptions anywhere in the resolved graph.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "Node builtin imports and native-addon
 * indicators anywhere in the resolved dependency graph, not just in the package's
 * own source", and only this step may observe
 * `node-filesystem-process-or-native-addon`; the matching positive signal
 * `no-node-builtins` is observed here too), #4 (the rejection this can file maps
 * to `platform-api-unavailable`, a technical rejection whose remediation keeps the
 * capability question with the Agent).
 *
 * The scan walks the package and its dependency/optional/peer-resolvable graph
 * with a cycle guard, sorted at every level so two runs of the same install read
 * files in the same order.
 *
 * **What counts as evidence changed after the first real-package probe.** This step
 * used to read every source file in each graph member's directory with plain regular
 * expressions, and reported `platform-api-unavailable` for three real packages whose
 * browser artifacts contain no Node builtins at all: `@embedpdf/pdfium` (every
 * `fs`/`module` reference lives in the Node builds beside `index.browser.js`),
 * `three` (the references live in optional draco/basis/ammo loaders under
 * `examples/jsm/libs/`, unreachable from `build/three.module.js`) and `es-toolkit`
 * (the references live in `dist/server/*`, behind a `./server` subpath the root entry
 * never imports, *and* inside JSDoc `@example` blocks). Two ways to be about text
 * rather than code, one outcome: a package the platform can run perfectly well,
 * refused for a file the browser build never opens.
 *
 * So the step now scans what a browser build can actually reach, and reads each file
 * through the same parser the target uses, which is what makes "this is comment
 * text" a parse result rather than a guess. `module-source.ts` holds both mechanisms
 * and the reasoning; this module holds the Node-specific judgement about what the
 * reachable code means.
 *
 * The conservative direction is preserved, because it is not what was wrong: only
 * call-site shapes that *name* a builtin count (an `import` binding called `fs` means
 * nothing), the Node-only set still excludes universal builtins (`path`, `os`,
 * `crypto`, streams, `buffer`, `url`, `util`, `assert`) whose browser polyfills are
 * ordinary bundler behaviour, and native-addon indicators still come from the
 * manifest (`gypfile`, known native tooling packages), from `.node` files on disk,
 * and from `dlopen` / `require("*.node")` in source. Manifest- and disk-level
 * indicators are deliberately **not** filtered by reachability: `gypfile` and a
 * shipped `.node` file are properties of the published package, not of one file's
 * import graph, so they remain rejections wherever they are found.
 *
 * When nothing is found the step records the positive signal `no-node-builtins`
 * as a **fact**, never as a finding: a preference cannot accept a candidate, and
 * the fact is what an Agent weighs when shortlisting. When something is found the
 * step still passes — it succeeded at observing — and files the replacement-family
 * rejection; a failed step and a rejection are different claims, and only the
 * latter maps to a `replace` decision's code.
 */

import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";

import {
  applyBrowserField,
  browserFieldRedirectsSpecifier,
  resolveBrowserEntryPaths,
  selfReferenceResolver,
} from "./browser-entry";
import type { ResolvedPackageIdentity } from "./identity";
import { locateManifest } from "./identity";
import type { PackageSourceFile } from "./module-source";
import { collectReachableSourceFiles, isInside, readSourceFile, sourceWithoutCommentsLenient } from "./module-source";
import { compareStrings } from "./scan-utils";

/**
 * Builtins with no browser environment and no ordinary polyfill path.
 *
 * Deliberately excludes the universal set (`path`, `os`, `crypto`, `events`,
 * `buffer`, `stream`, `url`, `util`, `assert`, `timers`, `querystring`,
 * `string_decoder`, `punycode`): a browser bundle that shims those is
 * ordinary toolchain behaviour, while `fs` or `child_process` cannot be shimmed
 * into existence. `node:`-prefixed specifiers are always Node-targeted and are
 * matched by prefix regardless of this set.
 */
const NODE_ONLY_BUILTINS: ReadonlySet<string> = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "dns/promises",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "perf_hooks",
  "process",
  "repl",
  "tls",
  "v8",
  "vm",
  "worker_threads",
]);

/** Packages whose presence in the graph means native compilation is involved. */
const NATIVE_TOOLING_PACKAGES: ReadonlySet<string> = new Set([
  "bindings",
  "node-gyp",
  "node-gyp-build",
  "node-gyp-build-optional-packages",
  "prebuild-install",
  "node-addon-api",
  "nan",
  "@mapbox/node-pre-gyp",
]);

/** Matched against source text; each pattern names the import form it is for. */
const BUILTIN_SPECIFIER_PATTERNS: readonly RegExp[] = [
  // ESM: import … from "fs", import "fs", export … from "fs"
  /\bfrom\s*["']((?:node:)?[A-Za-z0-9_./-]+)["']/g,
  /\bimport\s*["']((?:node:)?[A-Za-z0-9_./-]+)["']/g,
  /\bexport\s*\{[^}]*\}\s*from\s*["']((?:node:)?[A-Za-z0-9_./-]+)["']/g,
  // Dynamic: import("fs")
  /\bimport\s*\(\s*["']((?:node:)?[A-Za-z0-9_./-]+)["']\s*\)/g,
  // CJS: require("fs")
  /\brequire\s*\(\s*["']((?:node:)?[A-Za-z0-9_./-]+)["']\s*\)/g,
];

function isNodeOnlySpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) {
    return true;
  }
  const bare = specifier.split("/")[0] ?? specifier;
  // Scoped packages have no builtin form.
  if (bare.startsWith("@")) {
    return false;
  }
  return NODE_ONLY_BUILTINS.has(specifier) || NODE_ONLY_BUILTINS.has(bare);
}

/**
 * Every Node-only specifier named in `source`, in first-seen order, deduplicated.
 *
 * Parses rather than scans, for the reason `module-source.ts` records at length:
 * `es-toolkit` names `node:fs` and `node:vm` only inside JSDoc `@example` blocks, and
 * a text match cannot tell that from a real import. Comments are blanked before the
 * patterns run, so a specifier in prose is documentation rather than a dependency.
 *
 * **The parse may fail open, but the masking may not.** An earlier version ran the patterns
 * over the raw text when the file would not parse, on the theory that a missed real import is
 * worse than a false positive. That was wrong twice over: it restored the exact defect this
 * function exists to remove — measured, a package whose entry used the `accessor` field had its
 * doc comment read as a `require("node:child_process")` and was refused while the bundler built
 * it cleanly — and the trade-off it named is not even the one being made, because the build step
 * independently catches a builtin that is really there. Comments are therefore stripped by a
 * text masker that needs no successful parse, so an unparseable file still yields its real
 * imports and only its real ones.
 */
export function findNodeOnlySpecifiers(source: string): readonly string[] {
  // Always masked, parse or no parse: skipping the mask on a parse failure restored the very
  // defect this function exists to remove.
  const searchable = sourceWithoutCommentsLenient(source);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of BUILTIN_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchable)) !== null) {
      const specifier = match[1];
      if (specifier === undefined || !isNodeOnlySpecifier(specifier) || seen.has(specifier)) {
        continue;
      }
      seen.add(specifier);
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Node-only specifiers named by a call site this step can attribute, in sorted order.
 *
 * Reads the parsed import list when the file parsed, and falls back to
 * {@link findNodeOnlySpecifiers} when it did not. Either way a comment is never a
 * call site: the parsed path has no comment nodes at all, and the fallback masks them.
 */
function nodeOnlySpecifiersOf(
  file: PackageSourceFile,
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  // A specifier the manifest's `browser` map excludes or redirects never reaches its original
  // target in a browser build, so it is not a builtin the artifact contains. Measured on
  // `{"browser":{"fs":false}}` with `import fs from "fs"`, where rolldown built cleanly while
  // the scan refused the package.
  const redirected = (specifier: string): boolean => browserFieldRedirectsSpecifier(manifest, specifier);

  if (file.analysis === undefined) {
    return findNodeOnlySpecifiers(file.source).filter(specifier => !redirected(specifier));
  }
  const found = new Set<string>();
  for (const reference of file.analysis.imports) {
    if (isNodeOnlySpecifier(reference.specifier) && !redirected(reference.specifier)) {
      found.add(reference.specifier);
    }
  }
  return [...found].sort(compareStrings);
}

/** Native-addon indicators visible in source text (paths are found separately, from disk). */
function findNativeIndicatorsInSource(source: string): readonly string[] {
  const found: string[] = [];
  if (/\bprocess\s*\.\s*dlopen\s*\(/.test(source)) {
    found.push("source:process.dlopen");
  }
  const requireNode = /\brequire\s*\(\s*["']([^"']+\.node)["']\s*\)/.exec(source);
  if (requireNode?.[1] !== undefined) {
    found.push("source:require-*.node");
  }
  return found;
}

/** The same indicators, read from the parse instead of from text. */
function nativeIndicatorsOf(file: PackageSourceFile): readonly string[] {
  const parsed = file.analysis?.nativeIndicators;
  if (parsed !== undefined) {
    return parsed;
  }
  return findNativeIndicatorsInSource(file.masked);
}

function nativeIndicatorsFromManifest(manifest: Readonly<Record<string, unknown>>): readonly string[] {
  const found: string[] = [];
  if (manifest["gypfile"] === true) {
    found.push("manifest:gypfile");
  }
  const names = new Set<string>();
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const deps = manifest[field];
    if (deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  if (typeof manifest["name"] === "string") {
    names.add(manifest["name"]);
  }
  for (const name of [...names].sort(compareStrings)) {
    if (NATIVE_TOOLING_PACKAGES.has(name)) {
      found.push(`manifest:native-tooling:${name}`);
    }
  }
  return found;
}

async function hasNodeFile(directory: string): Promise<boolean> {
  // A shallow, bounded look: native addons ship `.node` files at known depths
  // (root, `build/Release/`, `prebuilds/`), and a full recursive walk of every
  // dependency's tree would dominate the probe for a case that does not need it.
  const candidates = [
    join(directory),
    join(directory, "build", "Release"),
    join(directory, "prebuilds"),
    join(directory, "lib"),
    join(directory, "bin"),
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some(entry => entry.endsWith(".node"))) {
        return true;
      }
    } catch {
      // Directory does not exist: keep checking the others.
    }
  }
  return false;
}

interface GraphPackage {
  readonly name: string;
  readonly version: string | null;
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly depth: number;
}

/**
 * The package's dependency graph as installed: itself plus dependencies,
 * optionalDependencies and peerDependencies that actually resolve.
 *
 * Each edge resolves from the *requiring package's* directory — the same
 * anchors Node's algorithm uses — so a nested install under the candidate (or
 * under any intermediate package) is visible even when the project root cannot
 * see it, and a package only installed on one branch of the graph is not
 * skipped because another branch already asked for the same *name*. Packages
 * are keyed by their resolved directory (identity + path), so two installed
 * versions of one name are both scanned while a diamond dependency is scanned
 * once. The queue is sorted so the walk order is stable.
 */
async function collectGraph(identity: ResolvedPackageIdentity): Promise<readonly GraphPackage[]> {
  const byDirectory = new Map<string, GraphPackage>();
  const root: GraphPackage = {
    name: identity.packageName,
    version: identity.packageVersion,
    directory: identity.directory,
    manifest: identity.manifest,
    depth: 0,
  };
  byDirectory.set(root.directory, root);

  let frontier: GraphPackage[] = [root];

  while (frontier.length > 0) {
    const next: GraphPackage[] = [];
    for (const current of frontier) {
      // Node resolution for a package's own dependencies walks from that
      // package's location upward, not from the project root.
      const requireFromCurrent = createRequire(join(current.directory, "package.json"));
      const depNames: string[] = [];
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const deps = current.manifest[field];
        if (deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
          depNames.push(...Object.keys(deps as Record<string, unknown>));
        }
      }
      for (const depName of [...new Set(depNames)].sort(compareStrings)) {
        // Two-attempt + climb-to-named-manifest: a strict `exports` map that
        // does not export `./package.json` resolves the bare entry to a file,
        // and the owning manifest is found by walking up from that file rather
        // than appending `package.json` to the entry path.
        const located = await locateManifest(requireFromCurrent, depName);
        if (located === null) {
          // Not installed (optional peer, platform-skipped): absence is not
          // evidence either way, so it is simply not in the graph.
          continue;
        }
        if (byDirectory.has(located.directory)) {
          continue;
        }
        const package_: GraphPackage = {
          name: located.name,
          version: located.version ?? null,
          directory: located.directory,
          manifest: located.raw,
          depth: current.depth + 1,
        };
        byDirectory.set(located.directory, package_);
        next.push(package_);
      }
    }
    frontier = next;
  }

  return [...byDirectory.values()].sort(
    (a, b) => a.depth - b.depth || compareStrings(a.name, b.name) || compareStrings(a.version ?? "", b.version ?? ""),
  );
}

export interface NodeScanObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

/** Evidence tokens, portable by construction: builtin/native ids and `name@version`, never paths. */
function portableEvidence(specifier: string): string {
  return `builtin:${specifier}`;
}

/**
 * Scans the resolved graph for Node builtins and native indicators.
 *
 * `bundledFiles` is the probed package's files the build actually included, or `undefined` when
 * no build ran. It bounds the scan for the same reason `runtime-pattern-scan` is bounded:
 * reachability is not bundling. rolldown drops a module whose bindings are unused, and it can
 * drop it *before* resolving what that module imports or calls — so a scan over the full
 * reachable set reports a Node dependency from a file the artifact does not contain.
 *
 * The native-indicator channel is where that bites hardest, because a native indicator needs no
 * `import` at all: measured on an unused named import whose module called
 * `process.dlopen` — the build passed, the artifact contained no `dlopen`, and the report
 * refused the package. A builtin *import* in the same position usually escapes this because
 * rolldown descends into the module and fails on the builtin itself, which is why the
 * asymmetry is easy to miss.
 */
/**
 * The files of one graph member to scan for findings.
 *
 * With an artifact: the package's files that the build **actually included**, taken from the
 * bundler's own module list rather than from a walk. That is what makes a dependency's
 * `exports`-subpath file and a `browser`-redirect target visible to the scan — measured, both
 * were missed while the scan walked only from the package's root entry.
 *
 * Without an artifact (a failed build): the reachable set, which is the honest answer when
 * there is nothing to bound by.
 *
 * Either way the files are attributed to the package whose directory contains them, so a file
 * the bundler pulled in from somewhere else is not reported under this package's name.
 */
async function filesToScan(
  package_: GraphPackage,
  graph: readonly GraphPackage[],
  reachableFiles: readonly PackageSourceFile[],
  bundledFiles: ReadonlySet<string> | undefined,
): Promise<readonly PackageSourceFile[]> {
  if (bundledFiles === undefined) {
    return reachableFiles;
  }
  const fromArtifact: PackageSourceFile[] = [];
  for (const absolutePath of bundledFiles) {
    if (!isInside(package_.directory, absolutePath)) {
      continue;
    }
    // Attribution goes to the **deepest** graph package whose directory contains the file, not
    // to every package that does. A nested dependency's directory sits inside its parent's, so
    // an `isInside` test alone matched both: measured on `outer` depending on
    // `outer/node_modules/inner`, the `node:fs` in `inner/index.js` was filed once and reported
    // against **both** `inner@1.0.0` and `outer@1.0.0` — a package named in evidence it did not
    // contribute to, which is exactly what a reviewer checks first.
    if (deepestOwningPackage(graph, absolutePath) !== package_.directory) {
      continue;
    }
    const file = await readSourceFile(package_.directory, absolutePath);
    if (file !== undefined) {
      fromArtifact.push(file);
    }
  }
  return fromArtifact.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

/**
 * The graph package whose directory most specifically contains `absolutePath`.
 *
 * "Most specifically" means the longest matching directory: a file under
 * `outer/node_modules/inner/` belongs to `inner` even though it is also inside `outer`. Comparing
 * lengths is enough because a containing directory is a prefix of the path, so the longest
 * match is the deepest one.
 */
function deepestOwningPackage(graph: readonly GraphPackage[], absolutePath: string): string | null {
  let owner: string | null = null;
  for (const candidate of graph) {
    if (!isInside(candidate.directory, absolutePath)) {
      continue;
    }
    if (owner === null || candidate.directory.length > owner.length) {
      owner = candidate.directory;
    }
  }
  return owner;
}

export async function observeNodeBuiltins(
  projectRoot: string,
  identity: ResolvedPackageIdentity,
  bundledFiles?: ReadonlySet<string>,
): Promise<NodeScanObservation> {
  const facts: ProbeFact[] = [];
  const rejectionFindings: ProbeRejectionFinding[] = [];
  const graph = await collectGraph(identity);

  const builtinHits = new Map<string, Set<string>>(); // specifier -> package evidence set
  const nativeHits = new Set<string>();
  const scannedPackages: string[] = [];
  const unreachableEntryHits: string[] = [];
  let reachableFileCount = 0;
  let skippedShakenOut = 0;

  for (const package_ of graph) {
    scannedPackages.push(`${package_.name}@${package_.version ?? "?"}`);
    for (const indicator of nativeIndicatorsFromManifest(package_.manifest)) {
      nativeHits.add(`${indicator} [${package_.name}]`);
    }
    if (await hasNodeFile(package_.directory)) {
      nativeHits.add(`filesystem:*.node [${package_.name}]`);
    }

    // Only what a browser build can reach from this package's published entries.
    // A file outside that set cannot disqualify the artifact, because the artifact
    // does not contain it — see the module header for the three packages that made
    // this a defect rather than a preference.
    const { entries } = resolveBrowserEntryPaths(package_.manifest);
    const reachable = await collectReachableSourceFiles(
      package_.directory,
      entries,
      selfReferenceResolver(package_.manifest),
      request => applyBrowserField(package_.manifest, request),
    );
    // Every way the walk could fail to reach a file is recorded, because a smaller file count
    // is otherwise the only trace and it reads the same as a healthy package.
    for (const reason of [
      ["missing", reachable.missingEntries],
      ["escaped", reachable.escapedSpecifiers],
      ["unresolved", reachable.unresolvedSpecifiers],
      ["unparseable", reachable.unparseableFiles],
    ] as const) {
      const [label, values] = reason;
      if (values.length > 0) {
        unreachableEntryHits.push(`${package_.name}:${label}:${values.join(",")}`);
      }
    }

    reachableFileCount += reachable.files.length;

    // The files this package actually contributes to the artifact.
    //
    // Reachability from the package's **own root entry** is not the same set, and using it as
    // the scan source loses a file the build genuinely loaded. Two measured shapes:
    //
    // - a dependency's `exports` subpath (`import "dep/sub"` where `.` resolves to a clean file
    //   and `./sub` to a native one) — rolldown bundles `dep/native.js`, but a walk from `dep`'s
    //   root entry only ever sees `clean.js`, so the `dlopen` in `native.js` was never scanned
    //   and the package reported `supports-deployment`;
    // - a `browser` field redirecting a bare specifier to a module that itself needs `node:fs`
    //   — the redirect target is loaded by the build but is not reachable from the root entry
    //   either, so the report said `supports-rejection-only` with **no** rejection finding.
    //
    // So when a build ran, the artifact's own file list is the **positive** source for this
    // package: those files exist in the artifact by definition, so a finding drawn from one is
    // a statement about the artifact. Reachability still supplies the files for the
    // no-artifact case, and still bounds *which* of a package's files can be attributed to it.
    const scanned = await filesToScan(package_, graph, reachable.files, bundledFiles);
    // Counted as a **set difference**, not by subtracting cardinalities. `scanned` is no longer a
    // subset of `reachable` — when a build ran it is taken from the artifact's own module list,
    // which can contain a file the walk never reached (a dependency's `exports` subpath) — so
    // the two lengths no longer describe one set against another. Measured on the
    // `dependency-subpath-native` fixture, where the two sets are `{clean.js}` and
    // `{native.js}`: both length 1, so a subtraction reported 0 while `clean.js` genuinely is
    // reached-but-not-in-the-artifact.
    if (bundledFiles !== undefined) {
      skippedShakenOut += reachable.files.filter(file => !bundledFiles.has(file.absolutePath)).length;
    }

    for (const file of scanned) {
      for (const specifier of nodeOnlySpecifiersOf(file, package_.manifest)) {
        let set = builtinHits.get(specifier);
        if (set === undefined) {
          set = new Set();
          builtinHits.set(specifier, set);
        }
        set.add(`package:${package_.name}@${package_.version ?? "?"}`);
      }
      for (const indicator of nativeIndicatorsOf(file)) {
        // The **file** is part of the evidence, not just the package. A native indicator is
        // reached through no import — `process.dlopen` is a call — so when one is reported from
        // a module that was shaken out, "which file" is the only thing that makes the claim
        // falsifiable. Measured: without the path, the evidence read
        // `native:source:process.dlopen [oracle]`, which names neither the file the indicator
        // came from nor, for an oracle or a reviewer, which file to check.
        nativeHits.add(`${indicator} [${package_.name}] ${file.relativePath}`);
      }
    }
  }

  const builtinSpecifiers = [...builtinHits.keys()].sort(compareStrings);
  const nativeIndicators = [...nativeHits].sort(compareStrings);

  facts.push({
    step: "node-builtin-scan",
    name: "graph.packages-scanned",
    value: scannedPackages.sort(compareStrings),
  });
  facts.push({
    step: "node-builtin-scan",
    name: "graph.node-only-specifiers",
    value: builtinSpecifiers,
  });
  facts.push({
    step: "node-builtin-scan",
    name: "graph.native-indicators",
    value: nativeIndicators,
  });
  // Coverage, recorded so a reader can tell "nothing was found" apart from "nothing
  // was looked at" — the distinction the reachability rule makes load-bearing, and
  // the one that was invisible while the step scanned whole directories.
  facts.push({
    step: "node-builtin-scan",
    name: "graph.entry-resolutions",
    value: [...new Set(unreachableEntryHits)].sort(compareStrings),
  });
  facts.push({
    step: "node-builtin-scan",
    name: "graph.reachable-file-count",
    value: reachableFileCount,
  });
  // Coverage: reached but not in the artifact, and therefore not scanned for findings. Recorded
  // so the bound is visible rather than an unexplained absence of findings.
  facts.push({
    step: "node-builtin-scan",
    name: "graph.files-shaken-out",
    value: skippedShakenOut,
  });

  /**
   * Whether the scan actually read any source.
   *
   * Reachability made this a question with two answers rather than one. The scan reads what a
   * browser build reaches, so a package whose tree it could reach nothing in produces *no*
   * specifiers — and "no builtins" is exactly the wrong conclusion to draw from that, because
   * the two situations are:
   *
   * - nothing reachable was published (the package is browser-unresolvable, which
   *   `export-metadata` reports as `ssr-or-server-only-without-browser-build`), or
   * - the manifest names an entry this walk cannot follow, so the question was never asked.
   *
   * Measured: `{ exports: { ".": { node: "./index.js" } }, browser: { "./lib/x.js":
   * "./x.browser.js" } }` with `node:fs` in `index.js` — `export-metadata` counted the bare
   * `browser` field as browser-resolvable, so it filed no rejection, while this step's entry
   * resolution (correctly) found no browser-resolvable root and reached zero files. Reporting
   * `no-node-builtins: true` there would have been a blanket amnesty: any server-only package
   * laundered into a clean bill of health by attaching a `browser` field.
   */
  const reachedAnySource = reachableFileCount > 0;

  if (builtinSpecifiers.length === 0 && nativeIndicators.length === 0 && reachedAnySource) {
    // The positive signal, as a fact: `no-node-builtins` can never be a finding
    // that accepts the candidate, and recording it as one would put a preference
    // in a bucket the validator treats as observation-backed findings.
    facts.push({
      step: "node-builtin-scan",
      name: "signal.no-node-builtins",
      value: true,
    });
  }

  if (!reachedAnySource) {
    // Not a rejection — this step does not decide that — but not a clean result either.
    // `graph.reachable-file-count: 0` plus this fact is what lets a reader tell "the package
    // is fine" from "no browser entry could be followed".
    facts.push({
      step: "node-builtin-scan",
      name: "signal.no-node-builtins",
      value: false,
    });
    facts.push({
      step: "node-builtin-scan",
      name: "scan.no-reachable-source",
      value: true,
    });
  }

  if (builtinSpecifiers.length > 0 || nativeIndicators.length > 0) {
    // Name every package that **contributed** a hit — derived from the hits, not seeded with the
    // probed root.
    //
    // Seeding the root unconditionally was wrong in the same way the file attribution was: it
    // named a package in the evidence whatever that package's files actually said. Measured on
    // `outer` depending on `outer/node_modules/inner`, where only `inner/index.js` imports
    // `node:fs`: the evidence listed `package:outer@1.0.0` as well, so a reviewer checking the
    // claim against `outer`'s own source would find nothing. A root that genuinely contributes
    // its own hit is still named — by this same loop.
    const contributingPackages = new Set<string>();
    for (const packagesForSpecifier of builtinHits.values()) {
      for (const packageEvidence of packagesForSpecifier) {
        contributingPackages.add(packageEvidence);
      }
    }
    // Native indicators are keyed by `"<indicator> [<name>] <file>"`, so the package is read off
    // the token rather than re-derived; an indicator with no package token (a manifest- or
    // filesystem-level one) is still evidence about the root it was found under.
    for (const indicator of nativeIndicators) {
      const named = /^[^\[]*\[([^\]]+)\]/.exec(indicator)?.[1];
      const owner = named === undefined ? undefined : graph.find(entry => entry.name === named);
      if (owner !== undefined) {
        contributingPackages.add(`package:${owner.name}@${owner.version ?? "?"}`);
      }
    }
    const evidence: string[] = [
      ...builtinSpecifiers.map(portableEvidence),
      ...nativeIndicators.map(indicator => `native:${indicator}`),
      ...[...contributingPackages].sort(compareStrings),
    ];
    rejectionFindings.push({
      signal: "node-filesystem-process-or-native-addon",
      step: "node-builtin-scan",
      summary:
        builtinSpecifiers.length > 0
          ? `"${identity.packageName}@${identity.packageVersion}" reaches Node-only builtins (${builtinSpecifiers.join(", ")}) in its resolved graph, which no bundling configuration can provide in a browser.`
          : `"${identity.packageName}@${identity.packageVersion}" carries native-addon indicators in its resolved graph, which cannot ship inside a browser artifact.`,
      evidence,
    });
  }

  const validation: ProbeValidationEntry = {
    step: "node-builtin-scan",
    outcome: "passed",
    detail:
      builtinSpecifiers.length === 0 && nativeIndicators.length === 0
        ? `Scanned ${String(scannedPackages.length)} package(s) in the resolved graph; no Node-only builtin or native-addon indicator was found.`
        : `Scanned ${String(scannedPackages.length)} package(s) in the resolved graph; found ${String(builtinSpecifiers.length)} Node-only specifier(s) and ${String(nativeIndicators.length)} native indicator(s).`,
    diagnostics: [],
  };

  return { facts, risks: [], rejectionFindings, validation };
}
