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
 * ## Why this module parses rather than scans
 *
 * It used to scan. The first version ran raw regular expressions over the artifact
 * and refused legal source, because text in a string or a comment is not a
 * construct. The second masked comments and literals with a hand-written lexer, and
 * then needed four rounds of patches — a template's `${...}`, a minified
 * `import{x}from"x"`, a `new` expression, a regular-expression literal, and finally
 * `n++ / 2`, where a `/` that is a division was read as a literal opener and
 * swallowed a real dynamic import. Each patch was right, and each was followed by
 * another shape it had not considered. That is the signature of approximating a
 * grammar with text, so this module stopped guessing: it parses the artifact and
 * walks nodes.
 *
 * Two facts make that the correct tool rather than a preference. The target's own
 * validation *is* a parse and a walk (`CELL_SOURCE_VALIDATION_MECHANISM`), so a
 * local parse is the same check rather than a lookalike; and the parser is pinned
 * to the 7.29 line the target ships (`RUNTIME_CONTRACT_TARGET.browserTranspiler`),
 * so both sides agree on what the language is.
 *
 * ## Scope of the dependency
 *
 * AGENTS.md's dependency-strategy table governs dependencies that reach *generated
 * cell code*. `@babel/parser` never does: it is a build-time dependency of the
 * compiler, and nothing it provides can end up inside a Cell artifact. It is
 * therefore not a `host` / `inline` / `extension` / `replace` decision, and it is
 * pinned rather than floated so a grammar change cannot arrive silently.
 *
 * ## What is and is not reproduced
 *
 * - The declaration check and the refused-callee check are reproduced node for
 *   node, including the skip list: the walk asks
 *   `cellSourceValidationVisitsAstKey` whether to descend, so "comments and tokens
 *   are not visited" is the recorded fact rather than a comment.
 * - The chunk rule is *not* the target's, and the module says so: the validator
 *   never refuses `import(...)`, so stopping a runtime chunk load is this
 *   contract's job alone — which is exactly why it is worth parsing for.
 * - A source that does not parse yields no findings. That is a deliberate deferral
 *   rather than a hole: the target parses the same source with the same Babel
 *   before it writes the cell, so an unparseable artifact is refused there, with
 *   its own `[babel]` message and a code frame. `CELL_SOURCE_SCAN_SKIPPED` lists
 *   the rejections that live on that side of the boundary.
 */

import { parse } from "@babel/parser";

import {
  CELL_SOURCE_VALIDATION_MECHANISM,
  cellSourceValidationVisitsAstKey,
  findCellSourceRejection,
} from "@forguncy-react-workspace/core";
import type { CellSourceRejectionId } from "@forguncy-react-workspace/core";

/**
 * The subset of a Babel node this module walks.
 *
 * Structural rather than `@babel/types`: that package would add a second
 * dependency for interfaces describing six fields, and the walk is written to
 * tolerate anything it does not understand.
 */
interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function childOf(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isAstNode(value) ? value : undefined;
}

function nameOf(node: AstNode | undefined): string {
  const name = node?.["name"];
  return node?.type === "Identifier" && typeof name === "string" ? name : "";
}

function startOf(node: AstNode): number | undefined {
  const start = node["start"];
  return typeof start === "number" ? start : undefined;
}

function stringValueOf(node: AstNode | undefined): string | undefined {
  const value = node?.["value"];
  return typeof value === "string" ? value : undefined;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (source.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

/** The construct's own text, flattened to one line and capped so a minified file cannot dominate a report. */
function textOf(source: string, node: AstNode): string {
  const start = startOf(node);
  const end = node["end"];
  if (start === undefined || typeof end !== "number") return node.type;
  return source
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Walks the tree the way the target walks it.
 *
 * The skip list comes from the runtime contract, so this is not "a walk that
 * happens to agree with the target" — it is the target's own rule, read from the
 * record. That is what makes "a string containing `useFormStatus(` is not refused"
 * a property of the design instead of a claim.
 */
function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);

  for (const key of Object.keys(node)) {
    if (!cellSourceValidationVisitsAstKey(key)) continue;

    const value = node[key];
    if (Array.isArray(value)) {
      for (const element of value) {
        if (isAstNode(element)) walkAst(element, visit);
      }
      continue;
    }
    if (isAstNode(value)) walkAst(value, visit);
  }
}

/**
 * Parses the artifact the way the target parses it.
 *
 * Module scope and JSX, matching the target's declaration check and the `react`
 * preset's parser plugins. Deliberately *not* more permissive than the target: no
 * TypeScript plugin, because the target's own parse has none and a source using TS
 * syntax is refused by it rather than accepted here.
 */
function parseCellSource(source: string): AstNode | undefined {
  try {
    const result = parse(source, {
      sourceType: "module",
      plugins: ["jsx"],
    });
    return result.program as unknown as AstNode;
  } catch {
    return undefined;
  }
}

/** The rejection each refused callee name draws. Checked against the contract by the tests. */
const REJECTION_BY_REFUSED_CALLEE: Readonly<Record<string, CellSourceRejectionId>> = {
  useActionState: "use-action-state",
  useOptimistic: "use-optimistic",
  useFormStatus: "use-form-status",
};

/**
 * The rejection a call draws, or `undefined` when the call is not refused.
 *
 * Mirrors `getUnsupportedReactCallMessage`: the node has to be the recorded callee
 * node type, a bare identifier is matched against the recorded names, and a member
 * has to be non-computed and on one of the recorded objects.
 */
function rejectionForCallee(callee: AstNode | undefined): CellSourceRejectionId | undefined {
  const mechanism = CELL_SOURCE_VALIDATION_MECHANISM;
  if (callee === undefined) return undefined;

  if (callee.type === "Identifier") {
    const name = nameOf(callee);
    return mechanism.refusedBareCalleeNames.includes(name) ? REJECTION_BY_REFUSED_CALLEE[name] : undefined;
  }

  if (callee.type !== "MemberExpression" || callee["computed"] === true) return undefined;

  const objectName = nameOf(childOf(callee, "object"));
  const propertyName = nameOf(childOf(callee, "property"));
  if (!mechanism.refusedMemberCalleeObjects.includes(objectName)) return undefined;
  if (objectName === "React" && mechanism.refusedReactOnlyMemberNames.includes(propertyName)) return "react-use";
  return mechanism.refusedMemberNames.includes(propertyName) ? REJECTION_BY_REFUSED_CALLEE[propertyName] : undefined;
}

/** True when the callee is the `import` keyword, which makes the call a dynamic import. */
function isDynamicImport(callee: AstNode | undefined): boolean {
  return callee?.type === "Import";
}

/**
 * Where a match was found, and how often.
 *
 * Shared by both finding types rather than copy-pasted into each: the fields are a
 * clump — a match is never useful without its position, and a position is never
 * useful without the text — so they travel together as one thing.
 */
export interface CellSourceFindingLocation {
  /** The construct's own text, flattened and trimmed for a report line. */
  readonly match: string;
  /** 1-based line of the construct. */
  readonly line: number;
  /**
   * Offset of the construct.
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
  /** The offending module specifier, read from the declaration's own node. */
  readonly specifier?: string;
}

/** A dynamic `import()` call: a location like any other match, with nothing else to say about it. */
export type CellSourceCallFinding = CellSourceFindingLocation;

export interface CellSourceAudit {
  /** Constructs the target refuses, one finding per rejection, in first-seen order. */
  readonly findings: readonly CellSourceScanFinding[];
  /** Dynamic import calls, which the target does not refuse and this contract does. */
  readonly dynamicImports: readonly CellSourceCallFinding[];
  /**
   * False when the artifact does not parse, in which case there is nothing to
   * report from it and the target's own parse is what refuses it.
   */
  readonly parsed: boolean;
}

/**
 * Audits an artifact in one pass.
 *
 * Exported as the single entry point so the two questions above cost one parse
 * rather than two: the artifact can be megabytes of minified bundle, and both
 * checks want the same tree.
 */
export function auditCellSource(source: string): CellSourceAudit {
  const program = parseCellSource(source);
  if (program === undefined) {
    return { findings: [], dynamicImports: [], parsed: false };
  }

  const mechanism = CELL_SOURCE_VALIDATION_MECHANISM;
  const found = new Map<CellSourceRejectionId, CellSourceScanFinding>();
  let dynamicImport: CellSourceCallFinding | undefined;

  const record = (id: CellSourceRejectionId, node: AstNode, specifier?: string): void => {
    const existing = found.get(id);
    if (existing !== undefined) {
      found.set(id, { ...existing, occurrences: existing.occurrences + 1 });
      return;
    }

    const start = startOf(node);
    found.set(id, {
      id,
      platformMessage: findCellSourceRejection(id).message,
      match: textOf(source, node),
      line: start === undefined ? 1 : lineOf(source, start),
      index: start ?? 0,
      occurrences: 1,
      ...(specifier === undefined ? {} : { specifier }),
    });
  };

  walkAst(program, node => {
    if (node.type === "ImportDeclaration") {
      record("import-declaration", node, stringValueOf(childOf(node, "source")));
      return;
    }

    if (node.type.startsWith(mechanism.refusedDeclarationNodeTypePrefix)) {
      record("export-declaration", node);
      return;
    }

    if (node.type !== mechanism.refusedCalleeNodeType) return;

    const callee = childOf(node, "callee");
    const code = rejectionForCallee(callee);
    if (code !== undefined) {
      record(code, node);
      return;
    }

    if (isDynamicImport(callee)) {
      const start = startOf(node);
      const occurrence: CellSourceCallFinding = {
        match: textOf(source, node),
        line: start === undefined ? 1 : lineOf(source, start),
        index: start ?? 0,
        occurrences: 1,
      };
      dynamicImport =
        dynamicImport === undefined
          ? occurrence
          : { ...dynamicImport, occurrences: dynamicImport.occurrences + 1 };
    }
  });

  return {
    findings: [...found.values()],
    dynamicImports: dynamicImport === undefined ? [] : [dynamicImport],
    parsed: true,
  };
}

/** The constructs the target refuses. See {@link auditCellSource} for the whole audit. */
export function scanCellArtifactSource(source: string): readonly CellSourceScanFinding[] {
  return auditCellSource(source).findings;
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
export function findDynamicImportCall(source: string): CellSourceCallFinding | undefined {
  return auditCellSource(source).dynamicImports[0];
}

/**
 * Constructs the runtime contract records that this module must *not* decide.
 *
 * Kept as data so the omission is a decision with a reason rather than a gap
 * someone later fills in with a hopeful rule. Every entry is a construct the target
 * refuses *from its own parse*, which is the boundary that makes a local miss
 * merely a deferred report.
 */
export interface CellSourceScanOmission {
  readonly id: CellSourceRejectionId;
  readonly whyNotDecided: string;
}

export const CELL_SOURCE_SCAN_SKIPPED: readonly CellSourceScanOmission[] = [
  {
    id: "typescript-annotation",
    whyNotDecided:
      "The target's parse has no TypeScript plugin, so such a source does not parse here either — the target reports it with a code frame, which a local rule would only pre-empt by second-guessing its wording.",
  },
  {
    id: "top-level-return",
    whyNotDecided:
      "A top-level `return` does not parse in the module scope the target's declaration check uses, so it is refused by the target's own parse with the recorded `'return' outside of function` message.",
  },
  {
    id: "duplicate-top-level-declaration",
    whyNotDecided:
      "Scope analysis belongs to the parse: the target's Babel refuses a duplicate declaration with `Identifier 'X' has already been declared`, and reproducing that verdict locally would mean duplicating a parser's scope rules.",
  },
  {
    id: "top-level-await",
    whyNotDecided:
      "The target refuses it from its preview pass rather than from the parse, with a message about the wrapped source. A local rule could only approximate which `await` is top-level in an artifact whose statements are already inside a bundle.",
  },
  {
    id: "runtime-import-call-not-rejected",
    whyNotDecided:
      "It is not a rejection: the record exists to say the validator does *not* catch a dynamic import. It is reported through the chunk-loading check instead, so a caller does not read a platform guarantee where there is none.",
  },
];

/**
 * The names the target refuses as a call, so the tests can prove this module's
 * mapping still covers the recorded mechanism after either one changes.
 */
export function refusedCalleeNames(): readonly string[] {
  return [
    ...CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames,
    ...CELL_SOURCE_VALIDATION_MECHANISM.refusedReactOnlyMemberNames,
  ];
}

/** The rejection a refused callee name maps to. Exported so a drift test can walk it. */
export function rejectionForRefusedCalleeName(name: string): CellSourceRejectionId | undefined {
  return REJECTION_BY_REFUSED_CALLEE[name];
}
