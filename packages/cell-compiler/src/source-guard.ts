/**
 * The last gate between a bundler's output and the platform's validator.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6), which promises
 * that "Generated code is accepted by ReactCellType".
 *
 * That promise cannot be fully checked locally, and this module does not pretend
 * otherwise. What it can do is refuse to emit the constructs `core` records as
 * refused, so the artifact fails here — where the report names the construct and
 * the fix — instead of failing later inside the designer.
 *
 * ## Why this module blanks text before it looks
 *
 * The first version of this module ran raw regular expressions over the whole
 * artifact. That was wrong, and the reason is a fact about the target rather than
 * a matter of taste: the target refuses *syntax nodes*
 * (`CELL_SOURCE_VALIDATION_MECHANISM`), and its AST walk does not descend into
 * comments or tokens at all. `const s = "useFormStatus(";` is a string literal to
 * the platform, not a call, so a raw-text scan refusing it would reject an
 * artifact the platform accepts. A guard that refuses correct output is worse than
 * no guard: it blocks real work and teaches its caller to switch it off.
 *
 * So the scan runs against {@link blankNonSyntaxText}, which replaces comment
 * bodies and string/template contents with spaces while preserving every offset
 * and newline. Text inside a comment can then never match, and a match is a
 * *syntax position* — the same domain the target checks.
 *
 * ## What is still approximate
 *
 * This is a lexer, not a parser, and the limits are stated rather than left to be
 * discovered:
 *
 * - A regular-expression literal is not recognised, so a regex containing a quote
 *   or `//` can hide part of a line from the scan. The damage is bounded — a
 *   misread `'` or `"` cannot outlive its own line, because JavaScript forbids a
 *   raw newline in those literals — and it can only *lose* a finding, never invent
 *   one.
 * - A `${...}` expression inside a template literal is blanked with the literal,
 *   so a refused call inside one is not reported here.
 * - `new useFormStatus()` is a `NewExpression` to the platform and a match here.
 *
 * Every one of those shortfalls defers to the platform's own validator, which is
 * the authority and refuses the artifact at write time. None of them can let a
 * broken artifact through unnoticed; they only move where it gets reported.
 */

import {
  CELL_SOURCE_VALIDATION_MECHANISM,
  findCellSourceRejection,
} from "@forguncy-react-workspace/core";
import type { CellSourceRejectionId } from "@forguncy-react-workspace/core";

/**
 * Blanks everything that is not a syntax position.
 *
 * Preserves the length of the input and every newline, so offsets and line numbers
 * computed against the result are valid against the original — which is what lets
 * the scan match here and report from there.
 *
 * Three properties are deliberate:
 *
 * - A `'` or `"` literal cannot span a newline (JavaScript forbids it), so a
 *   misread quote is contained to one line rather than swallowing the artifact.
 * - An unterminated `/*` blanks to the end, which is what an unterminated comment
 *   means anyway.
 * - Quotes are kept while their contents are blanked, so a rule can still see that
 *   a literal is there even though it cannot see what is in it.
 */
export function blankNonSyntaxText(source: string): string {
  const characters = source.split("");
  const length = source.length;

  const blank = (from: number, to: number): void => {
    for (let index = from; index < Math.min(to, length); index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  };

  let position = 0;
  while (position < length) {
    const current = source[position];
    const next = source[position + 1] ?? "";

    if (current === "/" && next === "/") {
      const newline = source.indexOf("\n", position);
      const end = newline === -1 ? length : newline;
      blank(position, end);
      position = end;
      continue;
    }

    if (current === "/" && next === "*") {
      const close = source.indexOf("*/", position + 2);
      const end = close === -1 ? length : close + 2;
      blank(position, end);
      position = end;
      continue;
    }

    if (current === '"' || current === "'") {
      let cursor = position + 1;
      while (cursor < length) {
        const character = source[cursor];
        if (character === "\\") {
          cursor += 2;
          continue;
        }
        if (character === current || character === "\n") break;
        cursor += 1;
      }
      const closed = cursor < length && source[cursor] === current;
      blank(position + 1, cursor);
      position = closed ? cursor + 1 : cursor;
      continue;
    }

    if (current === "`") {
      let cursor = position + 1;
      while (cursor < length) {
        const character = source[cursor];
        if (character === "\\") {
          cursor += 2;
          continue;
        }
        if (character === "`") break;
        cursor += 1;
      }
      const closed = cursor < length && source[cursor] === "`";
      blank(position + 1, cursor);
      position = closed ? cursor + 1 : cursor;
      continue;
    }

    position += 1;
  }

  return characters.join("");
}

export interface CellSourceScanRule {
  readonly id: CellSourceRejectionId;
  /**
   * Compiled with the `m` and `g` flags and matched against
   * {@link blankNonSyntaxText} output, so it can only match a syntax position.
   */
  readonly pattern: string;
  /**
   * Applied to the original source from the match to the end of its line, to
   * recover a detail the blanked text no longer carries — an import specifier is a
   * string literal, and string contents are blanked by design.
   */
  readonly specifierPattern?: string;
  /** Why this is the target's own rule rather than a guess. */
  readonly whyFaithfulToTarget: string;
}

/**
 * The constructs this scan reproduces, expressed as the target's rule.
 *
 * The mapping is not "these words look suspicious"; it is
 * `CELL_SOURCE_VALIDATION_MECHANISM` written as patterns:
 *
 * - a line-initial `import` is how an `ImportDeclaration` starts, and `import(`
 *   is deliberately excluded because the target refuses the declaration node, not
 *   the call;
 * - `export` followed by a declaration keyword or a brace is how every node type
 *   beginning with `Export` starts;
 * - a refused call is either the bare callee or a non-computed member of `React`
 *   or `ReactDOM`, which is why each name has exactly one rule covering both
 *   forms. One rule per name, not one per form, so a `React . useOptimistic()`
 *   call cannot be reported twice.
 *
 * Two details are load-bearing rather than stylistic:
 *
 * - Indentation is `[ \t]`, never `\s`. `\s` matches a newline, so `^\s*export`
 *   would happily start matching on the blanked line above and report the
 *   construct at the wrong line — and, worse, at a comment.
 * - The bare form carries `(?<!\.\s*)` as well as `(?<![\w$])`, because a
 *   *spaced* member access (`foo . useFormStatus()`) is still a member access the
 *   target accepts, and a single-character lookbehind would miss it.
 */
export const CELL_SOURCE_SCAN_RULES: readonly CellSourceScanRule[] = [
  {
    id: "import-declaration",
    pattern: "^[ \\t]*import[ \\t]+",
    specifierPattern: "[\"']([^\"']+)[\"']",
    whyFaithfulToTarget:
      "An `ImportDeclaration` cannot begin anywhere but a statement start, and it is the declaration the target refuses — not the `import(...)` call, which the target does not.",
  },
  {
    id: "export-declaration",
    pattern: "^[ \\t]*export[ \\t]+(?:default\\b|const\\b|let\\b|var\\b|function\\b|class\\b|async\\b|\\*|\\{|\\[)",
    whyFaithfulToTarget:
      "Any node type beginning with `Export` is refused, and every one of them starts with the `export` keyword followed by a declaration or a brace.",
  },
  {
    id: "react-use",
    pattern: "(?<![\\w$])(?<!\\.\\s*)React\\s*\\.\\s*use\\s*\\(",
    whyFaithfulToTarget:
      "`React.use(...)` is refused as a non-computed member call. A spaced dot and a `React` that is itself somebody's member are both excluded, because neither is the node the target refuses.",
  },
  {
    id: "use-action-state",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?:useActionState|(?:React|ReactDOM)\\s*\\.\\s*useActionState)\\s*\\(",
    whyFaithfulToTarget:
      "Refused as a bare callee identifier, and refused again as a non-computed member of `React` or `ReactDOM` under the same message — one rule, because both produce the same report.",
  },
  {
    id: "use-optimistic",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?:useOptimistic|(?:React|ReactDOM)\\s*\\.\\s*useOptimistic)\\s*\\(",
    whyFaithfulToTarget: "The same bare-or-member rule as the other refused hook names.",
  },
  {
    id: "use-form-status",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?:useFormStatus|(?:React|ReactDOM)\\s*\\.\\s*useFormStatus)\\s*\\(",
    whyFaithfulToTarget:
      "The same bare-or-member rule. `ReactDOM.use` is absent from the message table, so no rule refuses it — only the three listed names have a member form.",
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
 * Shared by both finding types rather than copy-pasted into each: the fields are a
 * clump — a match is never useful without its position, and a position is never
 * useful without the text — so they travel together as one thing.
 */
export interface CellSourceFindingLocation {
  /** The matching text, taken from the original source and trimmed for a report line. */
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

/** The original line a match starts on, which is where a blanked specifier still exists. */
function originalLineOf(source: string, index: number): string {
  const newline = source.indexOf("\n", index);
  return source.slice(index, newline === -1 ? source.length : newline);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (source.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

/** The original text of a match, cut at its line end so a minified line cannot dominate a report. */
function reportTextOf(source: string, index: number, matched: string): string {
  const line = originalLineOf(source, index).trim();
  return (line.length > 0 ? line : matched.trim()).slice(0, 120);
}

/**
 * Scans an assembled artifact for the constructs the target refuses.
 *
 * One finding per rule, not per occurrence: the diagnostic is about the artifact,
 * and a 2 MB bundle that mentions `export` forty times is one problem. The
 * `occurrences` count keeps the difference visible.
 */
export function scanCellArtifactSource(source: string): readonly CellSourceScanFinding[] {
  const blanked = blankNonSyntaxText(source);
  const findings: CellSourceScanFinding[] = [];

  for (const rule of CELL_SOURCE_SCAN_RULES) {
    const pattern = new RegExp(rule.pattern, "gm");
    let match: RegExpExecArray | null;
    let occurrences = 0;
    let first: CellSourceScanFinding | undefined;

    while ((match = pattern.exec(blanked)) !== null) {
      occurrences += 1;
      if (first === undefined) {
        const specifier =
          rule.specifierPattern === undefined
            ? undefined
            : new RegExp(rule.specifierPattern).exec(originalLineOf(source, match.index))?.[1];
        first = {
          id: rule.id,
          platformMessage: findCellSourceRejection(rule.id).message,
          match: reportTextOf(source, match.index, match[0]),
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
 * A dynamic `import()` call, which the platform validator accepts and the artifact
 * contract forbids.
 *
 * Reported against the chunk-loading rule (#6's "avoid runtime chunk loading")
 * rather than against a rejection record, because the runtime contract is explicit
 * that the validator does not refuse it — it is a call, not a declaration.
 * Conflating the two would have a reader believe the platform will catch a
 * surviving dynamic import.
 */
export const DYNAMIC_IMPORT_CALL_PATTERN = "(?:^|[^\\w$.])import\\s*\\(";

/** A dynamic `import()` call: a location like any other match, with nothing else to say about it. */
export type CellSourceCallFinding = CellSourceFindingLocation;

export function findDynamicImportCall(source: string): CellSourceCallFinding | undefined {
  const blanked = blankNonSyntaxText(source);
  const pattern = new RegExp(DYNAMIC_IMPORT_CALL_PATTERN, "gm");
  let match: RegExpExecArray | null;
  let occurrences = 0;
  let first: CellSourceCallFinding | undefined;

  while ((match = pattern.exec(blanked)) !== null) {
    occurrences += 1;
    if (first === undefined) {
      first = {
        match: reportTextOf(source, match.index, match[0]),
        line: lineOf(source, match.index),
        index: match.index,
        occurrences: 0,
      };
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }

  return first === undefined ? undefined : { ...first, occurrences };
}

/**
 * The names the target refuses as a call, so the tests can prove this module's
 * rule table still covers the recorded mechanism after either one changes.
 */
export function refusedCalleeNames(): readonly string[] {
  return [
    ...CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames,
    ...CELL_SOURCE_VALIDATION_MECHANISM.refusedReactOnlyMemberNames,
  ];
}
