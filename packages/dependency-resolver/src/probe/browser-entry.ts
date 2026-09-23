/**
 * Which **files** a browser build would consume — the entry points, resolved from
 * the manifest alone.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine" — the defect this module closes was found by running the probe engine
 * against real npm packages for #16's end-to-end acceptance criterion.
 *
 * Governing Specs: #16 (the probe protocol — "never declare compatibility from
 * README inspection alone" applies to *in*compatibility too: a rejection has to be
 * a statement about the artifact the cell would ship, not about some sibling file
 * the browser build never opens), #5 (the browser-first artifact the entry
 * question is about).
 *
 * Why this module exists separately from `export-metadata`: that step asks the
 * *looser* question "does a browser-executable entry exist at all", and answers it
 * with a boolean (plus one deliberate looseness — the presence of a `browser` field
 * counts on its own). The scanners need the *narrower* question answered: "which
 * files are reachable from that entry", because a package's tree routinely contains
 * files no browser build will ever open:
 *
 * - `@embedpdf/pdfium` publishes `dist/index.browser.js` for browsers next to
 *   `dist/index.js` and `dist/index.cjs` for Node. Only the first has any `fs`
 *   reference; the Node builds are unreachable from a browser entry.
 * - `three` publishes optional loaders under `examples/jsm/libs/` (draco, basis,
 *   ammo) that carry `require('fs')`; none of them is reachable from
 *   `build/three.module.js`.
 * - `es-toolkit` exposes `dist/server/*` behind a `./server` subpath; the root
 *   entry never imports it.
 *
 * Scanning the whole tree and then reporting a Node builtin found in one of those
 * files produced `platform-api-unavailable` — "the browser platform cannot provide
 * this" — for packages whose browser artifact contains **zero** Node builtins. That
 * is the mirror image of the mistake #16 warns about: a verdict about an artifact,
 * reached without looking at the artifact.
 *
 * The condition order is the one `export-metadata` already documents, and it is
 * restated here as the same literal so the two steps cannot disagree about which
 * entry a browser resolver stops at. That agreement is asserted rather than assumed:
 * `module-source.test.ts` runs both steps over a table of manifest shapes and refuses
 * any input where one says "browser-resolvable" and the other names no file. The two
 * *did* disagree before that test existed — `export-metadata` accepted a bare `browser`
 * field even when `exports` hid every browser entry — and the consequence was a package
 * the scanners reached zero files in while the step that could have rejected it stayed
 * silent.
 */

import type { SelfReferenceResolver } from "./module-source";

/** Entry fields a browser resolver would consult, in precedence order when `exports` is absent. */
export const FALLBACK_BROWSER_FIELDS = ["browser", "module", "main"] as const;

/**
 * Conditions this resolver treats as active, as a *set* rather than an order.
 *
 * The conditions a browser build satisfies. `default` is here because every resolver activates
 * it; `node` is deliberately absent so a `{ node: …, default: … }` map skips the Node branch
 * and takes `default`, which is what a browser resolver does.
 *
 * Exported for tests and for `export-metadata`, which must consider the same set or the two
 * steps disagree about a manifest. There is deliberately no *order* here: order comes from the
 * manifest's own key order, which is the rule Node and rolldown both implement.
 */
export const ACTIVE_EXPORT_CONDITIONS: ReadonlySet<string> = new Set([
  "browser",
  "import",
  "module",
  "default",
]);

/** Query suffixes a bundler strips before touching the filesystem (`?raw`, `?url`, `?worker`). */
const QUERY_SUFFIX_PATTERN = /\?.*$/;

/**
 * A target that cannot be a package-relative path.
 *
 * A sentinel object rather than a placeholder *string*, and that is the whole point: a
 * string survives `looksExecutable` (it is non-empty and does not end in `.node`), so an
 * earlier version of this let `exports: { ".": "" }` produce a bogus entry — the walk
 * then tried to read a file literally named `<unusable-manifest-path>` and reported a
 * *missing entry*, asserting the package forgot a file when the truth was that its
 * manifest named an unusable path. Not a string means it cannot be mistaken for a file
 * anywhere downstream, and the three questions stay distinct: a usable entry, an explicit
 * exclusion (`null`), and a target that existed but could not be used.
 */
const UNUSABLE_TARGET = Symbol("unusable-manifest-path");

type ExportTarget = string | typeof UNUSABLE_TARGET;

/** What an unusable target is called in report evidence. Portable by construction. */
export const UNUSABLE_TARGET_EVIDENCE = "<unusable-manifest-path>";

/**
 * Turns a manifest target into a package-relative path, or `UNUSABLE_TARGET`.
 *
 * A `.` or `..` path *segment* is left alone: `../shared/index.js` inside a published
 * package is legitimate (monorepo layout), and the reachability walk already refuses
 * anything that actually escapes the package root. An absolute, escaping or
 * scheme-prefixed target is not, because it cannot name a file inside this package.
 */
function normalizeTarget(target: string): ExportTarget {
  const withoutQuery = target.replace(QUERY_SUFFIX_PATTERN, "").trim();
  if (!isPortablePackagePath(withoutQuery)) {
    return UNUSABLE_TARGET;
  }
  return withoutQuery.startsWith("./") ? withoutQuery.slice(2) : withoutQuery;
}

/**
 * Whether the manifest's `browser` map resolves a **bare specifier** to something else.
 *
 * The `browser` field accepts bare package names as keys, not only paths: `{ "fs": false }`
 * and `{ "stream": "stream-browserify" }` are the documented browserify/webpack convention for
 * replacing a module wholesale. Both mean the specifier does **not** reach its original target
 * in a browser build — `false` excludes it, a string redirects it — so a Node builtin named
 * only in such a key is not a builtin the artifact contains.
 *
 * Measured on `{"main":"./index.js","browser":{"fs":false}}` with `import fs from "fs"`:
 * rolldown built cleanly (it honoured the map) while the engine refused the package for `fs`.
 * That is a false rejection, so this is consulted before a specifier is classified as a
 * builtin.
 */
export function browserFieldRedirectsSpecifier(
  manifest: Readonly<Record<string, unknown>>,
  specifier: string,
): boolean {
  const browser = manifest["browser"];
  if (browser === null || typeof browser !== "object" || Array.isArray(browser)) {
    return false;
  }
  const record = browser as Record<string, unknown>;
  const replacement = record[specifier];
  // `false` is an explicit exclusion; a string is a redirect to another module. Either way the
  // original target is not what a browser build resolves.
  return replacement === false || typeof replacement === "string";
}

/**
 * A path a package could actually resolve: relative, and inside the package.
 *
 * Exported because `export-metadata` asks the same question about an `exports` target and must
 * answer it the same way: two implementations would drift, and the drift would show up as
 * `export-metadata` reporting a browser-resolvable entry that the reachability walk cannot name
 * a single file for.
 */
export function isPortablePackagePath(target: string): boolean {
  if (target.length === 0) {
    return false;
  }
  // POSIX or Windows absolute, and the `file:`/`node:` scheme forms.
  if (target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(target) || /^[a-z]+:/i.test(target)) {
    return false;
  }
  // Escapes the package root.
  return !target.split(/[\\/]/).includes("..");
}

/**
 * Collects the browser-resolvable file targets a manifest value names.
 *
 * `skip` is applied to the **raw** string before normalization, and exists for one
 * caller: `imports`, where a target spelled `some-pkg` names an external dependency
 * rather than a file in this package. The raw string is the only place that distinction
 * survives, because `normalizeTarget` strips the `./` that separates `./index.js` from a
 * package literally named `index.js`.
 */
function collectExportTargets(
  target: unknown,
  out: ExportTarget[],
  skip: (raw: string) => boolean = () => false,
): void {
  if (typeof target === "string") {
    if (!skip(target)) {
      out.push(normalizeTarget(target));
    }
    return;
  }
  // An explicit exclusion (`null`) resolves to nothing.
  if (target === null || target === undefined) {
    return;
  }
  if (Array.isArray(target)) {
    // An **array is an ordered fallback list, not a union**: a resolver tries the
    // alternatives in order and stops at the first that resolves, so the later ones are
    // not part of the build. Collecting all of them *as entries* made the walk scan a file
    // the bundler never bundles — measured on `{".": ["./browser.js", "./node.js"]}`,
    // where rolldown bundled only `browser.js` and built cleanly while the scan reported
    // the `node:fs` in `node.js`. A false rejection caused by over-following, which the
    // "over-following is the safe direction" reasoning got wrong: an extra file is not
    // merely visited, it is *reported*.
    //
    // All usable alternatives are still emitted, **in order**, because which one resolves
    // is a filesystem question this manifest-only function cannot answer. The two callers
    // apply the "stop at the first" rule at the point where they can: the entry resolution
    // takes the first, and the walk tries each until one exists on disk. Dropping the
    // later alternatives here instead would lose the
    // `["./missing.js", "./real.js"]` case, where the first is the one that does not
    // exist.
    for (const entry of target) {
      const collected: ExportTarget[] = [];
      collectExportTargets(entry, collected, skip);
      // A `.node` alternative is a target but not a file a browser can load, so it is
      // skipped rather than treated as the match.
      out.push(...collected.filter(looksExecutable));
    }
    return;
  }
  if (typeof target !== "object") {
    return;
  }

  const record = target as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.some(key => key.startsWith("."))) {
    // A subpath map. Only `.` is a resolvable *file*; a `*` pattern needs a
    // request to expand, so it is not an entry this module can name.
    if (record["."] !== undefined) {
      collectExportTargets(record["."], out, skip);
    }
    return;
  }

  // A conditions map is resolved in the **order its keys are written**, not by a preference
  // ranking. Measured against Node's own resolver and against rolldown, which agree:
  // `{ default: "./n.js", browser: "./b.js" }` resolves to `./n.js` because `default` is
  // listed first, so a package that writes the conditions in that order is NOT
  // browser-substituted even though `browser` is present. Node's algorithm stops at the first
  // key whose condition is active, and both sides treat `default` as always active — so key
  // order is the whole rule.
  //
  // An earlier version iterated a fixed preference list (`browser`, `import`, `default`,
  // `require`) and picked the first *present* key. That silently reordered the manifest, and
  // the disagreement was invisible to every test because the two steps that consult this list
  // shared it: they agreed with each other while both disagreed with Node and rolldown.
  //
  // The active-condition filter is what makes this a *resolver* rather than a key walk: a key
  // naming a condition this resolver does not have (`node`, `development`) is skipped exactly
  // as a resolver skips it, and processing continues to the next key.
  for (const [condition, value] of Object.entries(record)) {
    if (ACTIVE_EXPORT_CONDITIONS.has(condition)) {
      // First active key wins outright, as a resolver stops rather than falling through.
      collectExportTargets(value, out, skip);
      return;
    }
  }
}

/**
 * True when the target names a file a browser could execute.
 *
 * The query is stripped **before** the extension is tested, because these two checks
 * have to agree with each other and with `module-source.ts`: `normalizeTarget` strips
 * `?x` from `"./a.node?x"`, so a `.node` test on the raw string would call it executable
 * and the two steps would disagree about the same manifest. That disagreement is not
 * cosmetic — it is the shape that let a package be reported browser-resolvable while the
 * scanner reached zero files.
 *
 * `UNUSABLE_TARGET` is not a string, so it is filtered out here rather than needing a
 * special case: an unusable target is not an entry, and treating it as one made the walk
 * report a *missing file* for a manifest that named an absolute path.
 */
function looksExecutable(target: ExportTarget): target is string {
  if (typeof target !== "string") {
    return false;
  }
  const trimmed = target.replace(QUERY_SUFFIX_PATTERN, "").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith(".node")) return false;
  return true;
}

export interface BrowserEntryResolution {
  /**
   * Package-relative paths a browser build would consume, sorted and deduplicated.
   *
   * Empty when the manifest publishes no browser-resolvable entry — the absence
   * `export-metadata` records as `ssr-or-server-only-without-browser-build` for a
   * probed root. A scanner must treat an empty list as "no reachable source", not
   * as "scan everything": the two are opposite answers and conflating them is the
   * bug this module exists to prevent.
   *
   * A path already has the manifest's `browser` substitution applied, so the walk
   * follows the file a browser build loads rather than the one it replaces — see
   * {@link applyBrowserField}.
   */
  readonly entries: readonly string[];
}

/**
 * Applies the manifest's `browser` field to a package-relative path.
 *
 * The object form of `browser` is a request→replacement table, and it is a *substitution*,
 * not an entry: it rewrites a request that resolution already found. Ignoring it made the
 * walk follow the original request and report the Node builtins in the file the browser
 * build replaces — measured on `{"main":"./dist/index.js","browser":{"./dist/index.js":
 * "./dist/index.browser.js"}}`, where rolldown bundled only `index.browser.js` and built
 * cleanly while the scan refused the package for `fs` in `index.js`. That is the
 * `@embedpdf/pdfium` shape one level of indirection out, and a direct walk-vs-bundler
 * disagreement.
 *
 * **The substitution is applied repeatedly, not once.** A resolver substitutes until it
 * reaches a path with no replacement, so a chain
 * (`{"./index.js":"./a.js","./a.js":"./b.js"}`) resolves `index.js` to `b.js`. Applying it
 * once returned `a.js`, and rolldown bundled `b.js` — measured on a three-file package
 * where `index.js` and `a.js` both need `node:fs` and `b.js` is clean: the scan refused
 * the package while the bundler built it. The hop limit is a cycle guard, not a policy:
 * a table that maps `a`→`b` and `b`→`a` has no fixed point, and a resolver would recurse
 * forever, so the walk stops and reports the last path it reached.
 *
 * `false` is an explicit exclusion: the file is replaced by nothing, so it is not a file
 * the browser build contains and the walk must not follow it. Returning `null` for that
 * case lets the caller drop it rather than scanning a file the artifact excludes.
 */
export function applyBrowserField(
  manifest: Readonly<Record<string, unknown>>,
  packageRelativePath: string,
): string | null {
  const browser = manifest["browser"];
  if (browser === null || typeof browser !== "object" || Array.isArray(browser)) {
    // The string form is an entry, which `resolveBrowserEntryPaths` handles separately.
    return packageRelativePath;
  }
  const record = browser as Record<string, unknown>;

  let current = packageRelativePath;
  const seen = new Set<string>([current]);
  // Bounded because the table may cycle. Longer than any real chain, short enough that a
  // pathological manifest cannot spin.
  for (let hop = 0; hop <= MAX_BROWSER_SUBSTITUTION_HOPS; hop += 1) {
    // A bundler matches the request it was given, which the manifest writes with a `./`.
    const replacement = record[current] ?? record[`./${current}`];
    if (replacement === false) {
      // Explicitly excluded: replaced by nothing.
      return null;
    }
    if (typeof replacement !== "string") {
      // No further substitution: this is the file the browser build loads.
      return current;
    }
    const normalized = normalizeTarget(replacement);
    if (normalized === UNUSABLE_TARGET) {
      return null;
    }
    if (seen.has(normalized)) {
      // A cycle. Reporting the path already reached is more useful than either looping or
      // dropping the entry, and the build step will report the manifest fault.
      return current;
    }
    seen.add(normalized);
    current = normalized;
  }
  return current;
}

/** Hop limit for {@link applyBrowserField}'s substitution chain. */
const MAX_BROWSER_SUBSTITUTION_HOPS = 16;

/**
 * The package-relative file a **self-referencing** subpath names, or null.
 *
 * A package may import itself by name — `import { exec } from "my-pkg/server"` — and
 * bundlers resolve that through the package's own `exports` map exactly as they
 * resolve a consumer's import. A reachability walk that only followed `./` and `../`
 * would therefore disagree with the bundler about what the entry reaches, and it
 * would disagree in the dangerous direction: measured on a package whose root entry
 * re-exports from `my-pkg/server`, whose `./server` entry imports
 * `node:child_process` — the bundler followed it and failed on the builtin, while the
 * walk reported one reachable file and the scan filed no finding at all. The result
 * was a report that neither supported deployment nor justified a rejection.
 *
 * `subpath` is the part after the package name: `""` for the bare self-reference
 * (which the root entry already covers), `"./server"` for the example above, and
 * `"/server"` when it was written as `my-pkg/server`.
 *
 * `exports` is required to answer this. A package with no `exports` map has no
 * self-referencing resolution in Node at all — a bare `my-pkg/server` resolves only
 * through `node_modules`, which for the package's own name means the copy on disk,
 * and following that would leave the package and re-read itself under another path.
 * Returning null is the honest answer there.
 *
 * Every browser-resolvable target is returned rather than the first. An `exports`
 * value may be an array of alternatives, and Node tries them in order — so picking
 * `[0]` would silently drop a subpath whose first alternative is absent but whose
 * second exists, which is a false negative in exactly the direction this walk must
 * not fail in. Returning the whole list keeps the walk conservative: it may follow a
 * file a bundler would not reach, but it cannot miss one a bundler does.
 */
export function resolveSelfReferenceSubpath(
  manifest: Readonly<Record<string, unknown>>,
  packageName: string,
  subpath: string,
): readonly string[] {
  const specifier = subpath.startsWith("/") ? `.${subpath}` : subpath;
  // The root entry needs no self-reference to be part of the graph: it is the walk's
  // seed. Answering nothing keeps one file from being reached by two spellings.
  if (specifier.length === 0 || specifier === ".") {
    return [];
  }
  if (!SPECIFIER_LOOKS_LIKE_SELF_REFERENCE.test(specifier)) {
    return [];
  }

  const exportsField = manifest["exports"];
  if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [];
  }
  const subpaths = exportsField as Record<string, unknown>;
  const target = subpaths[specifier] ?? matchSubpathPattern(subpaths, specifier);
  if (target === undefined) {
    return [];
  }

  const collected: ExportTarget[] = [];
  collectExportTargets(target, collected);
  // Self-references are followed for *reachability*, so the browser-first condition
  // order applies here for the same reason it does at the root: the files the walk
  // follows must include the file a browser build would load.
  return usableTargetsInOrder(collected);
}

/**
 * The usable, deduplicated targets, **in manifest order**.
 *
 * Order is load-bearing, not cosmetic: an array is a fallback list and a resolver stops at
 * the first alternative that resolves, so the caller has to see the alternatives in the
 * order the manifest listed them. Sorting them alphabetically made the walk follow a
 * different file from the bundler — measured on `{"imports":{"#a":["./b.js","./a.js"]}}`
 * where rolldown bundled `b.js` while the scan took the alphabetically-first `a.js` and
 * reported the `node:fs` in it. Two opposite manifests produced the identical verdict,
 * which is what gave the lost order away.
 *
 * Deduplication is also order-preserving: `Set` keeps insertion order, and dropping a
 * repeat must not move a later alternative ahead of the one that resolved first.
 *
 * An unusable target is dropped rather than surfaced here: the caller is resolving a
 * *specifier*, and a specifier whose manifest entry cannot name a file is not a file the
 * walk can enqueue. The `exports` root path reports unusable targets as their own fact,
 * because there the question "does this package publish an entry at all" is the one being
 * answered and "it published an unusable one" is the answer.
 */
function usableTargetsInOrder(targets: readonly ExportTarget[]): readonly string[] {
  return [...new Set(targets.filter(looksExecutable))];
}

/** An `exports` subpath key: `./x`, optionally with a `*` wildcard. */
const SPECIFIER_LOOKS_LIKE_SELF_REFERENCE = /^\.\/[^/]/;

/** The longest matching `./x/*` pattern's target, with `*` substituted, or undefined. */
function matchSubpathPattern(subpaths: Readonly<Record<string, unknown>>, specifier: string): unknown {
  let bestKey: string | undefined;
  for (const key of Object.keys(subpaths)) {
    const star = key.indexOf("*");
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      continue;
    }
    if (specifier.length < prefix.length + suffix.length) {
      continue;
    }
    // Longest prefix wins, which is how Node orders competing patterns.
    if (bestKey === undefined || prefix.length > bestKey.slice(0, bestKey.indexOf("*")).length) {
      bestKey = key;
    }
  }
  if (bestKey === undefined) {
    return undefined;
  }
  const star = bestKey.indexOf("*");
  const wildcard = specifier.slice(bestKey.slice(0, star).length, specifier.length - bestKey.slice(star + 1).length);
  return substituteTarget(subpaths[bestKey], wildcard);
}

/** Replaces `*` in a target with the matched wildcard text, at any depth. */
function substituteTarget(target: unknown, wildcard: string): unknown {
  if (typeof target === "string") {
    return target.split("*").join(wildcard);
  }
  if (target === null || target === undefined) {
    return target;
  }
  if (Array.isArray(target)) {
    return target.map(entry => substituteTarget(entry, wildcard));
  }
  if (typeof target !== "object") {
    return target;
  }
  const record = target as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = substituteTarget(value, wildcard);
  }
  return out;
}

/**
 * The files a browser build would enter through, from the manifest alone.
 *
 * `exports` is authoritative when present (a strict map can hide every other
 * field), and the `browser` field is honoured as a bare-string entry. The object
 * form of `browser` — a path-remapping table — is deliberately not interpreted
 * here: turning it into a file list needs the *request* being remapped, which the
 * entry question does not have. `export-metadata` already answers whether such a
 * package is browser-resolvable at all.
 */
export function resolveBrowserEntryPaths(manifest: Readonly<Record<string, unknown>>): BrowserEntryResolution {
  const targets: ExportTarget[] = [];

  if ("exports" in manifest) {
    collectExportTargets(manifest["exports"], targets);
  } else {
    const browser = manifest["browser"];
    if (typeof browser === "string" && looksExecutable(browser)) {
      targets.push(normalizeTarget(browser));
    } else {
      for (const field of FALLBACK_BROWSER_FIELDS) {
        const value = manifest[field];
        if (typeof value === "string" && looksExecutable(value)) {
          targets.push(normalizeTarget(value));
          break;
        }
      }
    }
  }

  // The `browser` object form substitutes a request, so an entry that names a replaced
  // file resolves to its replacement instead. Applied to the fallback fields and to
  // `exports` alike, because a resolver applies it after resolution either way.
  //
  // Only the **first** alternative survives, because an array is a fallback list and a
  // resolver stops at the first entry that resolves — later ones are not in the build. The
  // walk keeps the full ordered list so it can probe each for existence; this function
  // answers "which single file is the entry", so it takes the first.
  const substituted = targets
    .filter(looksExecutable)
    .map(entry => applyBrowserField(manifest, entry))
    .filter((entry): entry is string => entry !== null && looksExecutable(entry));

  return { entries: substituted.slice(0, 1) };
}

/**
 * A resolver for specifiers that resolve through the package's own manifest, for the
 * reachability walk.
 *
 * Two mechanisms, one shape, and they are the same mechanism in Node: a specifier that
 * names something *inside this package* and is answered by the manifest rather than by
 * `node_modules`. Both were invisible to the walk before, and both are followed by a
 * bundler, so both hid files the build really compiles:
 *
 * - **self-reference** — `import { x } from "my-pkg/server"`, answered by `exports`.
 * - **`#imports`** — `import { x } from "#node-impl"`, answered by `imports`. Measured
 *   on a package whose root re-exports from `#node-impl`, which needs `node:fs`: the
 *   bundler followed it and failed on the builtin, while the walk reported
 *   `no-node-builtins: true` and named no drop — a report that neither supported
 *   deployment nor justified a rejection.
 *
 * Built here rather than in `module-source.ts` so subpath resolution has one
 * implementation: a caller that needed these resolved would otherwise re-derive them,
 * and the two answers would drift exactly as `export-metadata` and
 * `resolveBrowserEntryPaths` were written not to.
 */
export function selfReferenceResolver(manifest: Readonly<Record<string, unknown>>): SelfReferenceResolver | null {
  const name = manifest["name"];
  const packageName = typeof name === "string" && name.trim().length > 0 ? name.trim() : null;

  const imports = manifest["imports"];
  const hasImportsMap = imports !== null && typeof imports === "object" && !Array.isArray(imports);

  // A `browser` map redirects bare specifiers to files in this package, which is a third
  // independent reason the walk needs a resolver — and one an earlier version missed: gating on
  // `exports`/`imports` alone returned `null` here, so a `{"browser":{"fs":"./fs-shim.js"}}`
  // package never had its redirect followed. Measured: the build failed on the `node:fs` the
  // shim imports while the report filed no rejection.
  const browser = manifest["browser"];
  const hasBrowserMap = browser !== null && typeof browser === "object" && !Array.isArray(browser);

  // Nothing to resolve: no `exports` to self-reference through, no `imports` map and no
  // `browser` map.
  const hasExports = "exports" in manifest;
  if (!hasExports && !hasImportsMap && !hasBrowserMap) {
    return null;
  }

  return {
    subpathOf(specifier: string): string | null {
      if (specifier.startsWith("#")) {
        // Only when the package actually declares an `imports` map: `#` is otherwise a
        // private name no resolver can answer, so it is a third-party-looking bare
        // specifier rather than something inside this package.
        return hasImportsMap ? specifier : null;
      }
      // A package with no `exports` map has no self-referencing resolution in Node: a
      // bare `pkg/sub` resolves through `node_modules`, which for the package's own name
      // means leaving and re-reading itself under another path.
      if (packageName === null || !hasExports) {
        return null;
      }
      if (specifier === packageName) {
        // The root entry: already the walk's seed, so it needs no self-reference.
        return null;
      }
      if (!specifier.startsWith(`${packageName}/`)) {
        return null;
      }
      return `./${specifier.slice(packageName.length + 1)}`;
    },
    resolveSubpath(subpath: string): readonly string[] {
      return subpath.startsWith("#")
        ? resolveImportsMapSubpath(manifest, subpath)
        : packageName === null
          ? []
          : resolveSelfReferenceSubpath(manifest, packageName, subpath);
    },
    redirectedSpecifier(specifier: string): string | null {
      const browser = manifest["browser"];
      if (browser === null || typeof browser !== "object" || Array.isArray(browser)) {
        return null;
      }
      const replacement = (browser as Record<string, unknown>)[specifier];
      // A string is a redirect to another module; `false` is an exclusion, which is not a file
      // to follow. Anything else (a nested map) is not a target this walk can name.
      if (typeof replacement !== "string") {
        return null;
      }
      const normalized = normalizeTarget(replacement);
      return normalized === UNUSABLE_TARGET ? null : normalized;
    },
  };
}

/**
 * The files an `imports` entry (`#name`) names, or none.
 *
 * Unlike `exports` — which has a browser-condition order this walk shares — an `imports`
 * entry is resolved with the *importing* context's conditions. Both `import` and
 * `default` are followed here rather than the first alone, because the two name the
 * same private module and this walk must not miss a file the bundler loads. Over-
 * following is the safe direction: the promise is that the walk cannot hide a Node
 * builtin the bundler reaches, not that it visits only one file per specifier.
 *
 * A target that is not a relative path is **not** a file in this package, and returning
 * it would be actively wrong rather than merely over-cautious. Node resolves
 * `"#dep": "some-pkg"` through `node_modules` — an external dependency, a separate node
 * in the probe's dependency graph, exactly as a bare specifier always is. Joining it as a
 * local path made the walk follow a coincidentally-named local file and attribute that
 * third-party package's builtins to this package's name: measured, a package with
 * `{"imports": {"#dep": "some-pkg"}}` and a local `some-pkg.js` produced a
 * `node-filesystem-process-or-native-addon` rejection naming the wrong package. That is
 * the false-rejection class this change exists to remove, so the target is dropped and
 * `node_modules` resolution stays where it belongs — with the graph walk.
 */
export function resolveImportsMapSubpath(
  manifest: Readonly<Record<string, unknown>>,
  specifier: string,
): readonly string[] {
  const imports = manifest["imports"];
  if (imports === null || typeof imports !== "object" || Array.isArray(imports)) {
    return [];
  }
  const entries = imports as Record<string, unknown>;
  const target = entries[specifier] ?? matchSubpathPattern(entries, specifier);
  if (target === undefined) {
    return [];
  }

  // Only paths the manifest spelled as relative are inside this package. The filter runs
  // on the raw string, because normalization strips the `./` and `./index.js` would then
  // be indistinguishable from the package name `index.js`.
  const collected: ExportTarget[] = [];
  collectExportTargets(target, collected, target => !isRelativeRawTarget(target));
  return usableTargetsInOrder(collected);
}

/** True when a manifest target is spelled as a package-relative path. */
function isRelativeRawTarget(target: string): boolean {
  const trimmed = target.trim();
  return trimmed === "." || trimmed === ".." || trimmed.startsWith("./") || trimmed.startsWith("../");
}
