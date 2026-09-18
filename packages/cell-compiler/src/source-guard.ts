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
 * - A regular-expression literal is recognised by looking backwards at the last
 *   significant character — a `/` after a value is a division, after anything that
 *   cannot end an expression it starts a literal. That rule is what keeps
 *   `const re = /'/;` from swallowing the rest of its line and `const re =
 *   /import()/;` from reading as a call. It is still a rule of thumb in one
 *   corner: `)` and `}` are treated as ending an expression, so a regex used
 *   immediately after a block (`if (x) {} /re/.test(y)`) reads as division, and
 *   its contents are then scanned as code. Unlike the text-versus-syntax cases,
 *   this one can go wrong in *both* directions, which is why it is stated here
 *   rather than waved through.
 * - A line is the only window used to recover an import specifier, because the
 *   specifier is a string literal and strings are blanked by design. Minified
 *   output can put a whole module on one line, in which case the specifier read is
 *   the first literal after the keyword — which is the specifier, since no other
 *   literal can precede it in an import declaration.
 *
 * ## Why the asymmetry between the two kinds of finding matters
 *
 * Losing a finding is not always equally bad, and the difference decides how much
 * machinery this module needs:
 *
 * - For a construct the *platform* refuses, a miss is merely deferred: the
 *   platform's own validator rejects the artifact at write time, with its own
 *   message. A local miss costs a report, not an artifact.
 * - For the chunk-loading rule it is **not** deferred: the platform's validator
 *   does not refuse `import(...)`, so this module is the only thing standing
 *   between a runtime chunk load and production. That is why a template
 *   literal's `${...}` expressions are scanned as code rather than blanked with
 *   the surrounding text, and why a regular expression has to be recognised rather
 *   than guessed at — the two places where a "safe" approximation would not have
 *   been safe.
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
 * A template literal is the reason this is a loop with a mode rather than a loop
 * with a few skips: it is the only construct where text and code alternate inside
 * one literal. Its raw text is blanked, but each `${…}` is real syntax the
 * platform's AST visits, so the interpolation is scanned as code — including the
 * strings, comments and nested templates inside it, which the code path handles
 * recursively through the same mode switch.
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
  const blankAt = (index: number): void => blank(index, index + 1);

  /** Which kind of text the scanner is inside. Only a template literal alternates. */
  let mode: "code" | "literal" = "code";
  /**
   * Brace depth of each open `${…}`, innermost last, so an interpolation ends at
   * the `}` that closes it and not at a `}` inside an object literal within it.
   */
  const interpolationDepths: number[] = [];

  let position = 0;
  while (position < length) {
    const current = source[position];
    const next = source[position + 1] ?? "";

    if (mode === "literal") {
      if (current === "\\") {
        blankAt(position);
        blankAt(position + 1);
        position += 2;
        continue;
      }
      if (current === "`") {
        mode = "code";
        position += 1;
        continue;
      }
      if (current === "$" && next === "{") {
        interpolationDepths.push(0);
        mode = "code";
        position += 2;
        continue;
      }
      blankAt(position);
      position += 1;
      continue;
    }

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

    // After comments, so `//` and `/*` are already handled: a lone `/` is either a
    // division or the start of a regular expression, and getting that wrong is the
    // one approximation this module cannot afford — a regex holding `'` would hide
    // the rest of its line from the chunk check.
    if (current === "/" && startsRegularExpression(source, position)) {
      const end = endOfRegularExpression(source, position);
      if (end !== undefined) {
        blank(position + 1, end - 1);
        position = end;
        continue;
      }
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
      mode = "literal";
      position += 1;
      continue;
    }

    if (interpolationDepths.length > 0) {
      const lastIndex = interpolationDepths.length - 1;
      if (current === "{") {
        interpolationDepths[lastIndex] = (interpolationDepths[lastIndex] ?? 0) + 1;
        position += 1;
        continue;
      }
      if (current === "}") {
        const depth = interpolationDepths[lastIndex] ?? 0;
        if (depth === 0) {
          interpolationDepths.pop();
          mode = "literal";
        } else {
          interpolationDepths[lastIndex] = depth - 1;
        }
        position += 1;
        continue;
      }
    }

    position += 1;
  }

  return characters.join("");
}

/**
 * Keywords after which a `/` begins a regular expression rather than a division.
 *
 * Deliberately short: a word that is *not* listed is treated as a value, which is
 * the common case (`x / y`), and listing fewer words can only turn a regex into a
 * division, never the other way round.
 */
const EXPRESSION_POSITION_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Identifier characters, including the non-ASCII range a Chinese-language codebase actually uses. */
function isIdentifierCharacter(character: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(character);
}

/**
 * Whether the `/` at `index` opens a regular expression.
 *
 * The rule is the grammatical one: a `/` after a value is a division, and after
 * anything that cannot end an expression it begins a literal. It is decided by
 * looking *backwards* from the one ambiguous character rather than by threading
 * token state forwards, which keeps the decision local to the place it matters.
 *
 * `)` and `]` end a value; `}` is treated the same way, which is the single place
 * this can be wrong — a regex straight after a block (`if (x) {} /re/.test(y)`)
 * reads as a division. That is documented at the top of the module rather than
 * hidden, because unlike the text-versus-syntax cases it can err in both
 * directions.
 */
function startsRegularExpression(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] ?? "")) cursor -= 1;
  if (cursor < 0) return true;

  const character = source[cursor] ?? "";
  if (character === ")" || character === "]" || character === "}") return false;
  if (!isIdentifierCharacter(character)) return true;

  let start = cursor;
  while (start > 0 && isIdentifierCharacter(source[start - 1] ?? "")) start -= 1;
  return EXPRESSION_POSITION_KEYWORDS.has(source.slice(start, cursor + 1));
}

/**
 * The index just past the closing `/` of the regular expression beginning at
 * `start`, or `undefined` when this is not one after all.
 *
 * `undefined` is the safe answer: the caller then treats the `/` as an ordinary
 * character, so the text stays visible to the rules rather than being skipped. A
 * literal cannot span a line, so running out of line ends the attempt — which is
 * what keeps a division being guessed at as a regex from swallowing the file.
 *
 * Character classes are tracked because `/` is legal inside one: `/[/]/` has to
 * end at its final slash, not at the one inside the brackets.
 */
function endOfRegularExpression(source: string, start: number): number | undefined {
  let cursor = start + 1;
  let inClass = false;

  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "\n") return undefined;
    if (inClass) {
      if (character === "]") inClass = false;
      cursor += 1;
      continue;
    }
    if (character === "[") {
      inClass = true;
      cursor += 1;
      continue;
    }
    if (character === "/") return cursor + 1;
    cursor += 1;
  }

  return undefined;
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
 * `CELL_SOURCE_VALIDATION_MECHANISM` written as patterns. Nothing here is anchored
 * to a line or to whitespace, because the target's checks are not: minified output
 * legally contains `import{x}from"x"`, `import"x"` and `const x=1;export{x}`, and
 * all three are `ImportDeclaration` / `Export…` nodes the platform refuses.
 *
 * Four details are load-bearing rather than stylistic:
 *
 * - A refused *call* is a `CallExpression`, so the callee shape is what matters:
 *   bare, or a non-computed member of `React`/`ReactDOM`. One rule per name covers
 *   both, so a construct cannot be reported twice.
 * - `(?<!\bnew\s+)` is required, not defensive: `new X()` is a `NewExpression`,
 *   which the mechanism's `CallExpression` check never sees, so reporting it would
 *   be this module refusing something the platform accepts.
 * - `(?<!\.\s*)` catches a *spaced* member access (`foo . useFormStatus()`), which
 *   a single-character lookbehind would report as a bare call.
 * - `import` is excluded when followed by `(` or `.`, because those are the call
 *   and the `import.meta` meta-property, neither of which is a declaration.
 */
export const CELL_SOURCE_SCAN_RULES: readonly CellSourceScanRule[] = [
  {
    id: "import-declaration",
    pattern: "(?<![\\w$.])import\\b\\s*(?![.(])(?=[{*\"'\\w$])",
    specifierPattern: "[\"']([^\"']+)[\"']",
    whyFaithfulToTarget:
      "An `ImportDeclaration` starts with the `import` keyword, and the lookaheads exclude exactly the two other meanings of that keyword — the `import(...)` call, which the target does not refuse, and `import.meta`. The brace/star/quote/identifier lookahead is what keeps a property named `import` out.",
  },
  {
    id: "export-declaration",
    pattern: "(?<![\\w$.])export\\b\\s*(?:default\\b|const\\b|let\\b|var\\b|function\\b|class\\b|async\\b|\\*|\\{|\\[)",
    whyFaithfulToTarget:
      "Any node type beginning with `Export` is refused, and each of them continues with one of these tokens — with or without whitespace, which is why the separator is optional.",
  },
  {
    id: "react-use",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?<!\\bnew\\s+)React\\s*\\.\\s*use\\s*\\(",
    whyFaithfulToTarget:
      "`React.use(...)` is refused as a non-computed member call. A spaced dot, a `React` that is itself somebody's member, and a `new React.use(...)` are all excluded, because none of them is the node the target refuses.",
  },
  {
    id: "use-action-state",
    pattern:
      "(?<![\\w$])(?<!\\.\\s*)(?<!\\bnew\\s+)(?:useActionState|(?:React|ReactDOM)\\s*\\.\\s*useActionState)\\s*\\(",
    whyFaithfulToTarget:
      "Refused as a bare callee identifier, and refused again as a non-computed member of `React` or `ReactDOM` under the same message — one rule, because both produce the same report.",
  },
  {
    id: "use-optimistic",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?<!\\bnew\\s+)(?:useOptimistic|(?:React|ReactDOM)\\s*\\.\\s*useOptimistic)\\s*\\(",
    whyFaithfulToTarget: "The same bare-or-member rule as the other refused hook names.",
  },
  {
    id: "use-form-status",
    pattern: "(?<![\\w$])(?<!\\.\\s*)(?<!\\bnew\\s+)(?:useFormStatus|(?:React|ReactDOM)\\s*\\.\\s*useFormStatus)\\s*\\(",
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
 *
 * The lookbehinds mirror the hook rules: `import` may not follow an identifier
 * character or a dot, and `obj . import(...)` is a member call on a property named
 * `import`, which is legal JavaScript and not a dynamic import — so a spaced dot
 * has to be excluded too, not just an adjacent one.
 */
export const DYNAMIC_IMPORT_CALL_PATTERN = "(?<![\\w$.])(?<!\\.\\s*)import\\s*\\(";

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
