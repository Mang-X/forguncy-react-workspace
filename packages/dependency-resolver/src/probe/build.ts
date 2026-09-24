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

import { describeBuildFailureLines, portableText, safePathSegment } from "./scan-utils.ts";

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

function entrySource(specifier: string): string {
  return [
    `import * as candidate from ${JSON.stringify(specifier)};`,
    `export default candidate;`,
    ``,
  ].join("\n");
}

/**
 * The synthetic entry's path, unique to (package, specifier).
 *
 * `entry` is an independent fingerprint input while the path used to be keyed
 * only by package name: two concurrent probes of one package with different
 * entries (`pkg/a` vs `pkg/b`) both wrote `.fgc/probe/<pkg>/entry.js`, and one
 * write could replace the file before the other Rolldown read — building the
 * wrong candidate under the wrong fingerprint. Hashing the specifier isolates
 * concurrent builds without giving up the human-readable package directory.
 */
export function probeEntryPath(projectRoot: string, packageName: string, specifier: string): string {
  const entryHash = createHash("sha256").update(specifier, "utf8").digest("hex").slice(0, 16);
  return join(projectRoot, ".fgc", "probe", safePathSegment(packageName), `${entryHash}.js`);
}

async function writeEntry(projectRoot: string, packageName: string, specifier: string): Promise<string> {
  const entryPath = probeEntryPath(projectRoot, packageName, specifier);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, entrySource(specifier), "utf8");
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
  const entryPath = await writeEntry(options.projectRoot, options.packageName, specifier);
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
