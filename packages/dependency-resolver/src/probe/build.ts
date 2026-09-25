/**
 * The `build` step: the candidate through the same Vite+/Rolldown stack the Cell
 * compiler uses.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "whether the package builds through the
 * same Vite+ stack the Cell compiler uses, and what the failure was when it does
 * not" — the failure text is the acceptance criterion, not a boolean), #7 (the
 * compiler whose options are mirrored here), #8 (the fingerprint this step's
 * configuration feeds must be recomputable without re-running).
 *
 * The build is a synthetic entry — `import * as candidate from "<pkg>"; export
 * default candidate;` — written into the project's `.fgc/probe/` scratch space
 * and bundled with `format: "iife"`, `codeSplitting: false`, `jsx: "react-jsx"`
 * and `attachDebugInfo: "none"`, i.e. exactly the shape `cell-compiler`'s
 * Rolldown bundler produces for a cell. `platform: "browser"` is pinned
 * explicitly rather than left to Rolldown's format-derived default: the probe's
 * entire question is "does this resolve for a browser", and a default that
 * re-evaluates under a different format would silently change the answer while
 * the fingerprint stayed the same. That pin is part of
 * {@link BUILD_CONFIGURATION_FINGERPRINT}, so changing it invalidates cached
 * evidence the same way any other declared input does.
 *
 * A failure is never a bare `false`. Escaped errors reduce to portable
 * `message (file:line:column)` lines through `describeBuildFailureLines`
 * (ANSI stripped, project root relativized), so the `failed` step carries
 * diagnostics a reader can act on six months later. Two conditions fail the step
 * even when the bundler exits cleanly: an `UNRESOLVED_IMPORT` warning (rolldown
 * reports an unresolvable module as a warning in some paths — a build that "succeeds"
 * while leaving an import unresolved has not produced an executable artifact), and
 * zero emitted entry chunks. Rolldown warnings that are neither are recorded as
 * facts, not failures: an advisory warning is not evidence the artifact cannot run.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProbeFact, ProbeValidationEntry } from "@forguncy-react-workspace/core";
import { rolldown, type OutputAsset, type OutputChunk } from "rolldown";

import { compareStrings, describeBuildFailureLines, portableText, safePathSegment } from "./scan-utils.ts";

/**
 * The declared inputs of the build half of a probe — what `LockProbeEvidence.fingerprint`
 * must cover so a change here invalidates recorded evidence.
 *
 * Kept as data (rather than only applied inside `runCandidateBuild`) because the
 * fingerprint composes it without running a build: #8 requires the fingerprint to
 * be recomputable from declared inputs alone, and a configuration that only
 * existed inside a function body would not be.
 */
export const BUILD_CONFIGURATION_FINGERPRINT: Readonly<Record<string, string>> = {
  format: "iife",
  codeSplitting: "false",
  jsx: "react-jsx",
  platform: "browser",
  attachDebugInfo: "none",
};

export interface CandidateBuildOptions {
  readonly projectRoot: string;
  readonly packageName: string;
  /** Specifier the synthetic entry imports; defaults to the package name. */
  readonly entry?: string;
  /**
   * Named bindings the synthetic entry imports, which is what makes the measured
   * artifact a **lower bound** rather than an upper one.
   *
   * Empty (the default) means `import * as candidate from "<entry>"`, which keeps the
   * whole module namespace observable. That is an **upper** bound on the code the Cell
   * will carry: a Cell importing one small binding can tree-shake the rest away, so a
   * namespace bundle over a cap does *not* show the Cell is over it. Measured on
   * `es-toolkit`: the namespace bundles to 249,750 characters while the single named
   * binding `debounce` bundles to 2,865 — an 87x gap, and the reason the cap verdict is
   * gated on this list being non-empty (see `size.ts`).
   *
   * Non-empty means `import { a, b } from "<entry>"`, which measures only what those
   * bindings pull in. A Cell that imports them carries at least that much, so the
   * measurement bounds the Cell from below and a cap rejection on it is sound.
   *
   * Sorted before use, so a caller's declaration order cannot compose a different
   * fingerprint or a different entry file for the same surface.
   */
  readonly imports?: readonly string[];
}

export interface CandidateBuildResult {
  readonly outcome: "passed" | "failed";
  readonly validation: ProbeValidationEntry;
  readonly facts: readonly ProbeFact[];
  /** Present only when the build produced chunks; the scan and size steps consume it. */
  readonly output?: readonly (OutputChunk | OutputAsset)[];
}

interface CapturedLog {
  readonly code: string;
  readonly id: string;
  readonly message: string;
}

/**
 * The synthetic entry's source for one import surface.
 *
 * The two shapes are not interchangeable and the difference is the whole of the
 * lower/upper bound distinction: a namespace import keeps every export reachable, while
 * named imports let the bundler drop what the Cell will never call. See
 * {@link CandidateBuildOptions.imports}.
 */
export function entrySource(specifier: string, imports: readonly string[] = []): string {
  if (imports.length === 0) {
    return [`import * as candidate from ${JSON.stringify(specifier)};`, `export default candidate;`, ``].join("\n");
  }
  const bindings = [...imports].sort(compareStrings);
  return [
    `import { ${bindings.join(", ")} } from ${JSON.stringify(specifier)};`,
    `export default { ${bindings.join(", ")} };`,
    ``,
  ].join("\n");
}

/** The surface as one stable string: the specifier, then the sorted bindings. */
function surfaceKey(specifier: string, imports: readonly string[]): string {
  return [specifier, ...[...imports].sort(compareStrings)].join("\u0000");
}

/**
 * The synthetic entry's path, unique to (package, specifier, import surface).
 *
 * `entry` is an independent fingerprint input while the path used to be keyed
 * only by package name: two concurrent probes of one package with different
 * entries (`pkg/a` vs `pkg/b`) both wrote `.fgc/probe/<pkg>/entry.js`, and one
 * write could replace the file before the other Rolldown read — building the
 * wrong candidate under the wrong fingerprint. Hashing the specifier isolates
 * concurrent builds without giving up the human-readable package directory.
 *
 * The import surface is hashed too, and for the same reason one level down: a
 * namespace probe and a named-binding probe of one package are two different
 * measurements under two different fingerprints, so sharing one entry file would let
 * either overwrite the other's source and build the wrong candidate.
 */
export function probeEntryPath(
  projectRoot: string,
  packageName: string,
  specifier: string,
  imports: readonly string[] = [],
): string {
  const entryHash = createHash("sha256").update(surfaceKey(specifier, imports), "utf8").digest("hex").slice(0, 16);
  return join(projectRoot, ".fgc", "probe", safePathSegment(packageName), `${entryHash}.js`);
}

async function writeEntry(
  projectRoot: string,
  packageName: string,
  specifier: string,
  imports: readonly string[],
): Promise<string> {
  const entryPath = probeEntryPath(projectRoot, packageName, specifier, imports);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, entrySource(specifier, imports), "utf8");
  return entryPath;
}

/**
 * Runs the candidate build.
 *
 * Never throws for a bundling failure: a failed build is a first-class report
 * outcome with diagnostics, not an exception that erases the steps that already
 * ran. Only a failure *outside* the bundler (unwritable scratch space) escapes.
 */
export async function runCandidateBuild(options: CandidateBuildOptions): Promise<CandidateBuildResult> {
  const specifier = options.entry ?? options.packageName;
  const imports = options.imports ?? [];
  const entryPath = await writeEntry(options.projectRoot, options.packageName, specifier, imports);
  const logs: CapturedLog[] = [];

  let build: Awaited<ReturnType<typeof rolldown>> | undefined;
  let output: (OutputChunk | OutputAsset)[];
  try {
    build = await rolldown({
      input: entryPath,
      // Resolution-time pin: the probe's entire question is "does this resolve
      // for a browser", and leaving `platform` to Rolldown's format-derived
      // default would re-evaluate under a different format while the fingerprint
      // stayed the same.
      platform: "browser",
      onLog: (_level, log) => {
        logs.push({ code: log.code ?? "", id: log.id ?? "", message: log.message });
      },
      transform: { jsx: "react-jsx" },
      experimental: { attachDebugInfo: "none" },
    });
    ({ output } = await build.generate({
      format: "iife",
      name: "FgcProbeCandidate",
      codeSplitting: false,
    }));
  } catch (error) {
    const diagnostics = describeBuildFailureLines(error, options.projectRoot);
    return {
      outcome: "failed",
      facts: [],
      validation: {
        step: "build",
        outcome: "failed",
        detail: `The candidate "${specifier}" failed to build through the Vite+/Rolldown stack the Cell compiler uses.`,
        diagnostics,
      },
    };
  } finally {
    await build?.close();
  }

  const unresolved = logs.filter(log => log.code === "UNRESOLVED_IMPORT");
  const entryChunks = output.filter((item): item is OutputChunk => item.type === "chunk" && item.isEntry);

  if (unresolved.length > 0) {
    const diagnostics = unresolved
      .map(log => portableText(`${log.code}: ${log.message}`, options.projectRoot))
      .sort();
    return {
      outcome: "failed",
      facts: [],
      validation: {
        step: "build",
        outcome: "failed",
        detail: `The candidate "${specifier}" built with unresolved import(s), so the artifact would throw when it runs.`,
        diagnostics: [...new Set(diagnostics)],
      },
    };
  }

  if (entryChunks.length === 0) {
    return {
      outcome: "failed",
      facts: [],
      validation: {
        step: "build",
        outcome: "failed",
        detail: `The bundler reported success for "${specifier}" but emitted no entry chunk.`,
        diagnostics: ["The bundler produced no entry chunk for the probe entry."],
      },
    };
  }

  const otherWarnings = logs
    .filter(log => log.code !== "UNRESOLVED_IMPORT")
    .map(log => log.code)
    .filter((code, index, all) => code.length > 0 && all.indexOf(code) === index)
    .sort();

  const facts: ProbeFact[] = [
    {
      step: "build",
      name: "build.entry-specifier",
      value: specifier,
    },
    // The import surface the artifact was built from, so a reader can tell which bound the
    // measurement is: an empty list means the whole namespace was kept and the size is an
    // upper bound, a non-empty one means only those bindings were reachable and the size
    // bounds the Cell from below. `size.ts` reads this fact's meaning when it decides
    // whether a cap verdict is provable, so it is recorded rather than implied by the entry.
    {
      step: "build",
      name: "build.import-surface",
      value: [...imports].sort(compareStrings),
    },
    {
      step: "build",
      name: "build.warning-codes",
      value: otherWarnings,
    },
  ];

  return {
    outcome: "passed",
    facts,
    output,
    validation: {
      step: "build",
      outcome: "passed",
      detail: `The candidate "${specifier}" built through the Vite+/Rolldown stack; ${String(entryChunks.length)} entry chunk(s) emitted.`,
      diagnostics: [],
    },
  };
}
