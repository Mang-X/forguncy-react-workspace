/**
 * The last gate between a bundler's output and the platform's validator.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6), which promises
 * that "Generated code is accepted by ReactCellType".
 *
 * That promise cannot be fully checked locally, and this module does not pretend
 * otherwise. What it can do is refuse to emit the constructs the runtime contract
 * records as refused, so the artifact fails here — where the report names the
 * construct and the fix — instead of failing later inside the designer with a
 * message the caller has to reverse-engineer.
 *
 * The split that makes this honest is between what a lexical scan can decide and
 * what only a parser can. `CELL_SOURCE_SCAN_RULES` holds the first group;
 * `CELL_SOURCE_SCAN_SKIPPED` holds the second, with the reason written down. A
 * scan that claimed the second group too would produce false refusals, and a gate
 * that refuses valid artifacts gets switched off.
 *
 * One consequence is worth stating because it looks like a bug and is not: the
 * platform rejects these names, so it cannot tell a library that *implements*
 * `useFormStatus` from cell code that calls it. Inlining such a library therefore
 * fails rather than warns, and a finding against a bundled dependency is a real
 * finding, not a false positive.
 */

import { findCellSourceRejection } from "@forguncy-react-workspace/core";
import type { CellSourceRejectionId } from "@forguncy-react-workspace/core";

export interface CellSourceScanRule {
  readonly id: CellSourceRejectionId;
  /** Compiled with the `m` and `g` flags. */
  readonly pattern: string;
  /** Capture group holding the offending specifier, when the construct names one. */
  readonly specifierGroup?: number;
  /** Why a lexical scan is sufficient for this construct. */
  readonly whyLexicallyDecidable: string;
}

/**
 * Constructs a lexical scan can decide.
 *
 * Every pattern is anchored so that it matches source position rather than any
 * occurrence of a word: an `import` or `export` declaration only counts at the
 * start of a line, and `import(` is deliberately excluded from the import rule so
 * that a dynamic import is reported once, as a chunk-loading problem, rather than
 * twice.
 */
export const CELL_SOURCE_SCAN_RULES: readonly CellSourceScanRule[] = [
  {
    id: "import-declaration",
    pattern: "^\\s*import\\s+[^\"']*?[\"']([^\"']+)[\"']",
    specifierGroup: 1,
    whyLexicallyDecidable:
      "A static import declaration is line-initial and always names its module in a string literal. Anchoring on the whitespace after `import` also keeps `import(` out of this rule.",
  },
  {
    id: "export-declaration",
    pattern: "^\\s*export\\s+(?:default\\b|const\\b|let\\b|var\\b|function\\b|class\\b|async\\b|\\*|\\{|\\[)",
    whyLexicallyDecidable:
      "An export declaration is line-initial and begins with one of a closed set of keywords, so a line starting with `export` followed by any other word is not reported.",
  },
  {
    id: "react-use",
    pattern: "\\bReact\\s*\\.\\s*use\\s*\\(",
    whyLexicallyDecidable:
      "The runtime rejects `React.use` by name, and the call form is unambiguous; there is no legitimate artifact in which this expression means something else.",
  },
  {
    id: "use-action-state",
    pattern: "\\buseActionState\\s*\\(",
    whyLexicallyDecidable: "Rejected by bare name, so the call form is the whole signal.",
  },
  {
    id: "use-optimistic",
    pattern: "\\buseOptimistic\\s*\\(",
    whyLexicallyDecidable: "Rejected by bare name, so the call form is the whole signal.",
  },
  {
    id: "use-form-status",
    pattern: "\\buseFormStatus\\s*\\(",
    whyLexicallyDecidable: "Rejected by bare name, so the call form is the whole signal.",
  },
];

/**
 * Constructs the runtime contract records that this scan must *not* decide.
 *
 * Kept as data next to the rules so the omission is a decision with a reason
 * rather than a gap someone later fills in with a hopeful regex.
 */
export interface CellSourceScanOmission {
  readonly id: CellSourceRejectionId;
  readonly whyNotLexical: string;
}

export const CELL_SOURCE_SCAN_SKIPPED: readonly CellSourceScanOmission[] = [
  {
    id: "typescript-annotation",
    whyNotLexical:
      "Deciding it needs a parse: `as`, `<T>` and `:` are all legal JavaScript in other positions, so a text match would refuse valid minified output.",
  },
  {
    id: "top-level-await",
    whyNotLexical:
      "Deciding it needs to know whether the `await` sits inside an async function. The artifact is a bundle of functions, so a text match would refuse essentially every artifact that awaits anything.",
  },
  {
    id: "top-level-return",
    whyNotLexical:
      "Same reason as `top-level-await`: a bare `return` is normal inside a bundled function body and only illegal at the top level of the cell source.",
  },
  {
    id: "duplicate-top-level-declaration",
    whyNotLexical:
      "Deciding it needs scope analysis. A bundle re-declares the same identifier in nested function scopes on purpose, so a name-counting scan would refuse correct output.",
  },
  {
    id: "runtime-import-call-not-rejected",
    whyNotLexical:
      "It is not a rejection: the record exists to say the validator does *not* catch a dynamic import. It is reported through the chunk-loading check instead, so a caller does not read a platform guarantee where there is none.",
  },
];

/**
 * Where a match was found, and how often.
 *
 * Shared by both finding types rather than copy-pasted into each: the fields are
 * a clump — a match is never useful without its position, and a position is never
 * useful without the text — so they travel together as one thing.
 */
export interface CellSourceFindingLocation {
  /** The first matching text, trimmed for a report line. */
  readonly match: string;
  /** 1-based line of the first match. */
  readonly line: number;
  /**
   * Offset of the first match.
   *
   * Kept alongside `line` because the caller composes an artifact out of parts,
   * and finding out which part a construct came from needs the offset; a line
   * number only works if the caller already knows how many lines each part has.
   */
  readonly index: number;
  /** How many times the construct occurs, so a report can say whether it is one spot or systemic. */
  readonly occurrences: number;
}

export interface CellSourceScanFinding extends CellSourceFindingLocation {
  readonly id: CellSourceRejectionId;
  /** The platform's own wording for this construct, quoted from the runtime contract. */
  readonly platformMessage: string;
  /** The offending module specifier, when the construct names one. */
  readonly specifier?: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (source.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

/**
 * Scans an assembled artifact for the constructs `#5` records as refused.
 *
 * One finding per rule, not per occurrence: the diagnostic is about the artifact,
 * and a 2 MB bundle that mentions `export` forty times is one problem. The
 * `occurrences` count keeps the difference visible.
 */
export function scanCellArtifactSource(source: string): readonly CellSourceScanFinding[] {
  const findings: CellSourceScanFinding[] = [];

  for (const rule of CELL_SOURCE_SCAN_RULES) {
    const pattern = new RegExp(rule.pattern, "gm");
    let match: RegExpExecArray | null;
    let occurrences = 0;
    let first: CellSourceScanFinding | undefined;

    while ((match = pattern.exec(source)) !== null) {
      occurrences += 1;
      if (first === undefined) {
        const specifier = rule.specifierGroup === undefined ? undefined : match[rule.specifierGroup];
        first = {
          id: rule.id,
          platformMessage: findCellSourceRejection(rule.id).message,
          match: match[0].trim().slice(0, 120),
          line: lineOf(source, match.index),
          index: match.index,
          occurrences: 0,
          ...(specifier === undefined ? {} : { specifier }),
        };
      }
      // A zero-length match would otherwise spin forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }

    if (first !== undefined) {
      findings.push({ ...first, occurrences });
    }
  }

  return findings;
}

/**
 * A dynamic `import()` call, which the platform validator accepts and the
 * artifact contract forbids.
 *
 * Reported against the chunk-loading rule (#6's "avoid runtime chunk loading")
 * rather than against a rejection record, because the runtime contract is
 * explicit that the validator does not refuse it. Conflating the two would have a
 * reader believe the platform will catch a surviving dynamic import.
 */
export const DYNAMIC_IMPORT_CALL_PATTERN = "(?:^|[^\\w$.])import\\s*\\(";

/** A dynamic `import()` call: a location like any other match, with nothing else to say about it. */
export type CellSourceCallFinding = CellSourceFindingLocation;

export function findDynamicImportCall(source: string): CellSourceCallFinding | undefined {
  const pattern = new RegExp(DYNAMIC_IMPORT_CALL_PATTERN, "gm");
  let match: RegExpExecArray | null;
  let occurrences = 0;
  let first: CellSourceCallFinding | undefined;

  while ((match = pattern.exec(source)) !== null) {
    occurrences += 1;
    if (first === undefined) {
      first = { match: match[0].trim(), line: lineOf(source, match.index), index: match.index, occurrences: 0 };
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }

  return first === undefined ? undefined : { ...first, occurrences };
}
