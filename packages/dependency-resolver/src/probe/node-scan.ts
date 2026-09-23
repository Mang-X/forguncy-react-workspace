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
 * files in the same order. Detection is textual on purpose — parsing every module
 * system the ecosystem ships would be a second resolver — and conservative in both
 * directions: only call-site shapes that *name* a builtin count (an `import`
 * binding called `fs` means nothing), and the Node-only set excludes universal
 * builtins (`path`, `os`, `crypto`, streams, `buffer`, `url`, `util`, `assert`)
 * whose browser polyfills are ordinary bundler behaviour rather than a platform
 * requirement. Native-addon indicators come from the manifest (`gypfile`, known
 * native tooling packages), from `.node` files on disk, and from `dlopen` /
 * `require("*.node")` in source.
 *
 * When nothing is found the step records the positive signal `no-node-builtins`
 * as a **fact**, never as a finding: a preference cannot accept a candidate, and
 * the fact is what an Agent weighs when shortlisting. When something is found the
 * step still passes — it succeeded at observing — and files the replacement-family
 * rejection; a failed step and a rejection are different claims, and only the
 * latter maps to a `replace` decision's code.
 */

import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";

import type { ResolvedPackageIdentity } from "./identity";
import { locateManifest } from "./identity";
import { compareStrings, walkPackageSourceFiles } from "./scan-utils";

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

/** Every Node-only specifier named in `source`, in first-seen order, deduplicated. */
export function findNodeOnlySpecifiers(source: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of BUILTIN_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
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

export async function observeNodeBuiltins(
  projectRoot: string,
  identity: ResolvedPackageIdentity,
): Promise<NodeScanObservation> {
  const facts: ProbeFact[] = [];
  const rejectionFindings: ProbeRejectionFinding[] = [];
  const graph = await collectGraph(identity);

  const builtinHits = new Map<string, Set<string>>(); // specifier -> package evidence set
  const nativeHits = new Set<string>();
  const scannedPackages: string[] = [];

  for (const package_ of graph) {
    scannedPackages.push(`${package_.name}@${package_.version ?? "?"}`);
    for (const indicator of nativeIndicatorsFromManifest(package_.manifest)) {
      nativeHits.add(`${indicator} [${package_.name}]`);
    }
    if (await hasNodeFile(package_.directory)) {
      nativeHits.add(`filesystem:*.node [${package_.name}]`);
    }

    const files = await walkPackageSourceFiles(package_.directory);
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const specifier of findNodeOnlySpecifiers(source)) {
        let set = builtinHits.get(specifier);
        if (set === undefined) {
          set = new Set();
          builtinHits.set(specifier, set);
        }
        set.add(`package:${package_.name}@${package_.version ?? "?"}`);
      }
      for (const indicator of findNativeIndicatorsInSource(source)) {
        nativeHits.add(`${indicator} [${package_.name}]`);
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

  if (builtinSpecifiers.length === 0 && nativeIndicators.length === 0) {
    // The positive signal, as a fact: `no-node-builtins` can never be a finding
    // that accepts the candidate, and recording it as one would put a preference
    // in a bucket the validator treats as observation-backed findings.
    facts.push({
      step: "node-builtin-scan",
      name: "signal.no-node-builtins",
      value: true,
    });
  }

  if (builtinSpecifiers.length > 0 || nativeIndicators.length > 0) {
    // Name every package that contributed a hit, not just the probed root:
    // the review regression is a *nested* dependency reaching a builtin, and
    // evidence that only says the root's name hides which graph member did it.
    const contributingPackages = new Set<string>([
      `package:${identity.packageName}@${identity.packageVersion}`,
    ]);
    for (const packagesForSpecifier of builtinHits.values()) {
      for (const packageEvidence of packagesForSpecifier) {
        contributingPackages.add(packageEvidence);
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
