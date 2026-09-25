/**
 * The probe input fingerprint — the value `fgc.lock.json` stores and #8's
 * freshness rules compare.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #8 (rule 2's invalidation: `LockProbeEvidence.fingerprint`
 * must be "a deterministic function of the declared inputs" and "recomputable
 * without re-running the probe"; `LockEnvironment.probeFingerprints` compares it),
 * #16 (the probe protocol whose steps the fingerprint covers).
 *
 * The composition deliberately **excludes** three things the record models
 * separately: the resolved package version (`resolvedVersion` has its own
 * staleness reason — `package-version-changed`), the Forguncy target
 * (`target`/`forguncy-target-changed`) and the toolchain (`probedWith`/
 * `toolchain-changed`). Folding any of them in here would report one change twice
 * and silently defeat `LockProbeEvidence.versionIndependent`: an upgrade that flag
 * permits would still move a fingerprint containing the version, so the record
 * would go stale anyway. What remains is exactly what the lock's comment lists as
 * this fingerprint's job — the probe id, the entry, the probe configuration (with
 * the cap folded in as a declared input, since a cap change alters what the
 * `size` step concludes), the bundler input no other field captures, and
 * {@link PROBE_ANALYSIS_REVISION}, which the three excluded dimensions do not cover
 * and which a change to the scanners makes load-bearing.
 *
 * The format (`probe=…;entry=…;analysis=…;config=…;bundler=…`) is stable and
 * human-readable on purpose: a fingerprint appears in lock diffs and in
 * `probe-fingerprint-changed` diagnostics, and an opaque hash would make both
 * unreadable. Sorted JSON for the maps keeps the same inputs composing the same
 * bytes across machines and Node versions — recursively, so nested `probeConfig`
 * objects are canonical too. `probeId` and `entry` are JSON-encoded scalars so
 * caller strings containing `;`/`=` cannot forge or collide with the composed
 * segments.
 */

import { BUILD_CONFIGURATION_FINGERPRINT } from "./build.ts";

/**
 * Recursively canonicalize: object keys sorted at every depth, array order
 * preserved (arrays are ordered data; reordering them would change meaning).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Recursive sorted-key JSON: `JSON.stringify` preserves insertion order, which would differ per caller. */
function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(canonicalize(value));
}

/** JSON-encode a scalar segment so `;`/`=` in caller strings cannot break the composition. */
function stableScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * The revision of the probe's own analysis, as a declared fingerprint input.
 *
 * Why this exists, and why it is not the thing the module header says to exclude:
 * version, target and toolchain are excluded because each is *modeled separately* on
 * the lock record, and folding one in would report a single change twice. The
 * analysis itself is not modeled anywhere — nothing else on the record can express
 * "the scanner now reads what a browser build reaches instead of the whole directory
 * tree". So a change here is invisible to every staleness rule, and a report cached
 * under the old behaviour would keep being served forever: the three false
 * `platform-api-unavailable` rejections this revision accompanies would have survived
 * the fix on any machine with a warm `.fgc/probe-cache/`.
 *
 * Bump this whenever a step's *findings* could change for inputs that otherwise
 * compose the same fingerprint. It is not a code version and does not track refactors:
 * it marks a change in what a probe of the same declared inputs would observe.
 *
 * - `1` — initial. Whole-directory, raw-text scanning.
 * - `2` — scanners are bounded by browser-entry reachability and read comment-masked
 *   source (`module-source.ts`); `artifact-scan` matches masked chunk code. Changes
 *   findings for packages shipping a Node build beside a browser one (`three`,
 *   `@embedpdf/pdfium`) and for packages naming a builtin only in a comment
 *   (`es-toolkit`).
 * - `3` — manifest interpretation corrected against Node and the bundler: `exports`
 *   condition order is the manifest's own key order rather than a preference list,
 *   `browser` substitutions apply to resolved files (and to subpaths resolved through
 *   `exports`/`imports`), substitution chains, and `browser: { "<specifier>": false }`
 *   redirects a bare specifier. Changes findings for any package whose manifest
 *   exercises those rules — measured on shapes where the walk previously followed a
 *   file the artifact replaces.
 * - `4` — `runtime-pattern-scan` is bounded by the files the build actually included, so a
 *   risk is not reported from a module tree-shaking removed. Changes findings for any package
 *   with an unused module carrying a Worker/asset pattern — measured on `es-toolkit`, where
 *   ten reached files are not in the artifact.
 * - `5` — the bound reaches `node-builtin-scan` too, which required running the build before
 *   the source scans (execution order is free; the report sorts). Its native-indicator channel
 *   needed it most: a `process.dlopen` is reached through no import, so a build that merely
 *   *drops* the module stays green while the report refused the package. Native evidence also
 *   names the file now.
 * - `6` — the artifact bound's containment tests are `..`-as-a-segment rather than string
 *   prefixes, the `.fgc` name exclusion is gone (the scratch tree is never under the package),
 *   and the bound applies to **every** graph member. Each of those three was a false negative:
 *   a bundled `src/.fgc/x.js` or `..helper.js` lost its rejection, and a shaken-out dependency
 *   kept one.
 * - `7` — a build's own file list is the **positive** scan source per graph member, not only a
 *   filter on what the package's root entry reaches, and the walk follows a `browser` map's
 *   bare-specifier redirect. Changes findings for a dependency reached through an `exports`
 *   subpath and for a redirect target — measured, both lost a rejection the artifact justified.
 * - `8` — `graph.files-shaken-out` is a set difference rather than a cardinality subtraction, and
 *   a finding names only the packages that actually contributed it (deepest owning directory for
 *   files, hits rather than the probed root for contributors). Changes findings for a package
 *   whose nested dependency carries the hit, and the coverage count for any package whose
 *   reachable and scanned sets overlap only partly.
 * - `9` — a native indicator carries the **identity of the version** that produced it rather than
 *   a bare package name, so a finding no longer names the wrong one when the graph holds two
 *   versions of a name. Changes findings for that shape only; measured, the old evidence named
 *   the clean version.
 * - `10` — a native indicator accumulates **every** contributor identity rather than the last one
 *   written, so two versions of a name that produce the same indicator are both named. Changes
 *   findings for that shape only; measured, the earlier map kept a single version.
 * - `11` — the `size` step measures **characters of emitted code** and classifies #21's band,
 *   and its cap input is characters (`cellArtifactBudgetCharacters`) rather than bytes. Changes
 *   what the step reports for every artifact: the `size.band*` facts are new, `size.codeCharacters`
 *   is new, and a cap that was previously compared against `totalBytes` is now compared against
 *   the code's character count. It also changes what a cap *means* — a report cached under the
 *   byte rule recorded a rejection the character rule may not make, or missed one it does — so a
 *   cached report from revision 10 must not answer a probe run at 11.
 * - `12` — the synthetic entry can declare a **named import surface** (`imports`), and the
 *   `build` step records it as `build.import-surface`. The surface decides whether the
 *   measured artifact bounds the Cell from below or above, which is what the `size` step's
 *   cap verdict now turns on: a namespace bundle over a cap proves nothing about a Cell that
 *   imports one binding (measured on `es-toolkit`: 249,750 characters for the namespace
 *   against 2,865 for `debounce` alone). Changes what the step reports for every artifact —
 *   `build.import-surface` is a new fact — and changes what a cap rejection *means*, so a
 *   report cached at 11 must not answer a run at 12.
 */
export const PROBE_ANALYSIS_REVISION = 12;

export interface ComposeProbeFingerprintInput {
  /** Which probe ran, e.g. `inline-bundle`. */
  readonly probeId: string;
  /** The entry the synthetic build imports. */
  readonly entry: string;
  /**
   * Named bindings the synthetic build imports, sorted; empty means the whole namespace.
   *
   * A declared input rather than a detail of the build, because it decides *which document*
   * the size step measured — the namespace bundle or a tree-shaken named-binding bundle —
   * and therefore whether a cap verdict is provable at all (see `size.ts` and
   * `build.ts`). Two runs of one package with different surfaces measure different
   * artifacts, so they must not share a fingerprint.
   */
  readonly imports?: readonly string[];
  /** Probe configuration; the cell cap is folded in as `budgetCharacters` when present. */
  readonly probeConfig?: Readonly<Record<string, unknown>>;
  /** Bundler input; defaults to the build module's declared configuration. */
  readonly bundlerInput?: Readonly<Record<string, string>>;
  /**
   * Cell artifact cap in **characters**, when one applies to this run.
   *
   * The key it composes into is `budgetCharacters`, not `budget`, because the unit is
   * now load-bearing for the fingerprint: the same number meant bytes before #77 and
   * characters after it, so reusing the key would let a byte-era fingerprint collide
   * with a character-era one holding the same integer.
   */
  readonly budgetCharacters?: number | null;
}

export interface ComposedProbeFingerprint {
  readonly fingerprint: string;
  /** The exact maps that composed it — the cache key and the diagnostics quote this. */
  readonly probeConfig: Readonly<Record<string, unknown>>;
  readonly bundlerInput: Readonly<Record<string, string>>;
}

/**
 * Composes the fingerprint from the declared inputs, with no package version,
 * target or toolchain in it (see the module header for why each is excluded) and one
 * addition it does not cover: {@link PROBE_ANALYSIS_REVISION}, whose own doc comment
 * explains why the analysis is a declared input rather than a separately-modeled
 * dimension.
 */
export function composeProbeFingerprint(input: ComposeProbeFingerprintInput): ComposedProbeFingerprint {
  const probeConfig: Record<string, unknown> = { ...input.probeConfig };
  if (input.budgetCharacters !== undefined && input.budgetCharacters !== null) {
    probeConfig["budgetCharacters"] = input.budgetCharacters;
  }
  const bundlerInput = { ...(input.bundlerInput ?? BUILD_CONFIGURATION_FINGERPRINT) };
  // Folded into `probeConfig` rather than given its own segment: the format is quoted in lock
  // diffs and in `probe-fingerprint-changed` diagnostics, and a new segment would have to be
  // read by every consumer of that format. `imports` is omitted entirely when the surface is
  // the whole namespace, so a pre-surface record composes the same bytes it always did under a
  // surface that has not changed — the same reason `budgetCharacters` is omitted when null.
  const imports = [...(input.imports ?? [])].sort();
  if (imports.length > 0) {
    probeConfig["imports"] = imports;
  }

  const fingerprint = [
    `probe=${stableScalar(input.probeId)}`,
    `entry=${stableScalar(input.entry)}`,
    `analysis=${String(PROBE_ANALYSIS_REVISION)}`,
    `config=${stableJson(probeConfig)}`,
    `bundler=${stableJson(bundlerInput)}`,
  ].join(";");

  return { fingerprint, probeConfig, bundlerInput };
}
