/**
 * Shared scan utilities for the probe engine's steps (#17).
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (the probe protocol this engine executes — every helper
 * here exists to make one of its machine-readability properties hold) and #8
 * (the lock the fingerprint feeds).
 *
 * Two properties drive the design of everything in this module:
 *
 * - **Determinism.** Identical inputs must produce identical bytes
 *   (`PROBE_REPORT_MACHINE_READABILITY`'s last item), so directory walks are
 *   sorted before they are read, comparisons use code units rather than the
 *   locale, and bundler output is stripped of ANSI paint and machine-specific
 *   absolute paths *before* it reaches a `diagnostics` array. A failure message
 *   that embeds one machine's home directory on one machine and another's on a
 *   second would make the same broken candidate serialize differently in CI
 *   than on a developer's laptop.
 * - **Portability.** A probe report must survive being read on another machine.
 *   Every path that leaves this module as report content is either relative to
 *   the package being probed or relativized against the project root — the same
 *   rule `fgc.lock.json` enforces document-wide, applied at the point of escape
 *   rather than audited after the fact.
 */

import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

/** Code-unit comparison — never `localeCompare`, which would sort differently per machine. */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Removes colour and cursor codes.
 *
 * Rolldown frames every message with ANSI styling; two identical failures must
 * compare equal in a diffed CI log, and an escape sequence inside a message
 * makes them unequal. Mirrors `cell-compiler`'s stripping so both consumers of
 * the same bundler's output read it the same way.
 *
 * The escape byte is built from its code point rather than written as a control
 * character in source, and the remainder (`ESC [ params letter`) is matched
 * without it — an ANSI sequence whose byte got lost still leaves the bracket
 * form behind for this second pass.
 */
export function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b);
  return text.split(esc).join("").replace(/\[[0-9;]*[A-Za-z]/g, "");
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * Makes a bundler message portable: ANSI stripped, every occurrence of the
 * project root removed, remaining backslashes normalized to `/`.
 *
 * Relativized at the point of escape because the alternative — scanning the
 * finished report for absolute paths — only finds the ones the writer happened
 * to think about, while this makes a leak require bypassing the only function
 * that formats diagnostics.
 */
export function portableText(text: string, projectRoot: string): string {
  const roots = new Set([projectRoot, projectRoot.split(sep).join("/"), projectRoot.split("/").join(sep)]);
  let out = stripAnsi(text);
  for (const root of roots) {
    if (root.length > 0) {
      out = out.split(root).join("");
    }
  }
  return out.replace(/\\/g, "/");
}

interface ReportedBuildError {
  readonly message?: unknown;
  readonly id?: unknown;
  readonly loc?: Readonly<{ file?: unknown; line?: unknown; column?: unknown }> | null;
}

function hasReportedErrors(value: unknown): value is { readonly errors: readonly unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "errors" in value &&
    Array.isArray((value as { readonly errors?: unknown }).errors)
  );
}

/**
 * One reported bundler error as one diagnostic line: message first, location
 * pulled out of the structured `loc` rather than scraped from a painted frame.
 *
 * The frame's source excerpt is dropped for the reason `cell-compiler` drops
 * it: the excerpt would carry an absolute path into a report that has to stay
 * portable, and the message plus `file:line:column` is what a reader acts on.
 */
function describeReportedError(value: unknown, projectRoot: string): string {
  if (typeof value !== "object" || value === null) {
    return portableText(String(value), projectRoot);
  }
  const error = value as ReportedBuildError;
  const message =
    typeof error.message === "string"
      ? portableText(firstLine(stripAnsi(error.message)), projectRoot)
      : portableText(String(error.message ?? ""), projectRoot);
  const loc = error.loc ?? undefined;
  const file = typeof loc?.file === "string" ? loc.file : typeof error.id === "string" ? error.id : undefined;
  const line = typeof loc?.line === "number" ? loc.line : undefined;
  const column = typeof loc?.column === "number" ? loc.column : undefined;
  if (file === undefined) return message;
  const portableFile = portableText(file, projectRoot).replace(/^[/\\]+/, "");
  if (line === undefined) return `${message} (${portableFile})`;
  if (column === undefined) return `${message} (${portableFile}:${line})`;
  return `${message} (${portableFile}:${line}:${column})`;
}

/**
 * Turns an escaped bundler failure into the non-empty `diagnostics` array a
 * `failed` probe step owes (`validateProbeReport` refuses a failure without
 * one — "a failure is evidence, not a boolean").
 *
 * Empty lines are dropped and duplicates collapsed so the same failure always
 * yields the same list, whatever combination of frames the bundler chose to
 * print this time.
 */
export function describeBuildFailureLines(error: unknown, projectRoot: string): readonly string[] {
  const raw: string[] = [];
  if (hasReportedErrors(error) && error.errors.length > 0) {
    raw.push(...error.errors.map(entry => describeReportedError(entry, projectRoot)));
  } else if (error instanceof Error) {
    raw.push(...portableText(error.message, projectRoot).split("\n"));
  } else if (error !== undefined && error !== null) {
    // Only a non-empty stringified value is evidence; `String(undefined)` is
    // the literal "undefined", which is noise rather than a diagnostic.
    const text = portableText(String(error), projectRoot);
    if (text.trim().length > 0) {
      raw.push(...text.split("\n"));
    }
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of raw) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    lines.push(trimmed);
  }
  // A failure with no readable text still has to produce a diagnostic line:
  // `validateProbeReport` treats empty diagnostics as "failed without evidence".
  return lines.length > 0 ? lines : ["The bundler failed without a readable message."];
}

/** Source file extensions the graph scanners read. Type declarations end in `.ts` and are not shipped code. */
const SOURCE_EXTENSIONS: readonly string[] = [".js", ".mjs", ".cjs", ".jsx"];

/**
 * Every source file under `root`, in sorted order, excluding `node_modules`
 * (a package's installed dependencies are scanned as their own graph nodes, so
 * descending here would double-count them under whichever package hoisted them)
 * and hidden directories (`.git`, and the probe's own `.fgc` output).
 *
 * Sorted during the walk rather than at the end so the read order is the same
 * order the report records — a scanner that read files in readdir order could
 * produce the same set in a different sequence on two filesystems.
 */
export async function walkPackageSourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
        files.push(absolute);
      }
    }
  }

  await visit(root);
  return files;
}

/** A path as it appears in report evidence: forward slashes, relative to `base`. */
export function relativePortablePath(base: string, absolute: string): string {
  const from = base.split(sep).join("/");
  const to = absolute.split(sep).join("/");
  if (to.startsWith(`${from}/`)) {
    return to.slice(from.length + 1);
  }
  // An unexpected layout (the file escaped `base` somehow) still yields
  // something portable rather than letting an absolute path into the report.
  const segments = to.split("/");
  return segments[segments.length - 1] ?? to;
}

/** A path usable as a directory-name component of the probe's scratch space. */
export function safePathSegment(name: string): string {
  return name.replace(/[@/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "-");
}
