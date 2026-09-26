/**
 * The verified ReactCellType target/runtime contract.
 *
 * Decision source: GitHub Issue #5 — "Research: establish the ReactCellType
 * target/runtime contract on Forguncy 12.0.100"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/5).
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * the evidence lives in that Issue. This module exists because a prose comment is
 * not reproducible project state: the artifact Spec (#6), the compiler (#7) and
 * the Agent dependency-selection flow (#18) need to *assert* these facts rather
 * than remember them.
 *
 * Every fact names the channel it was observed through. `RuntimeEvidenceChannel`
 * deliberately has no "assumption" / "expected" / "likely" member, so a claim that
 * was never observed cannot be recorded here without inventing an evidence
 * channel. Questions that are genuinely still open live in
 * `RUNTIME_CONTRACT_UNKNOWNS` instead of being guessed into the contract.
 *
 * Read the evidence channels as follows:
 *
 * - `product-runtime-source` — read from the shipped runtime script of the
 *   product, not from a summary of it.
 * - `product-documentation` — read from the API documentation the product itself
 *   serves to its AI surface.
 * - `designer-api` — produced by executing a designer operation against a real
 *   project.
 * - `generated-runtime-browser` — observed in a real browser against the
 *   generated dev site.
 *
 * Scope note: this module states the *target's* behaviour. It deliberately does
 * not decide the generated artifact's shape (#6), measure the code budget (#21),
 * or describe local development (#22).
 */

import type { ArchitectureDecisionSource } from "./governance.ts";
import { RUNTIME_CONTRACT_DECISION } from "./governance.ts";

export type RuntimeEvidenceChannel = (typeof RUNTIME_EVIDENCE_CHANNELS)[number];

/**
 * The evidence vocabulary.
 *
 * Exported as data rather than only as a type so the invariant guard and any
 * future lint share one definition, the same way `DEPENDENCY_STRATEGIES` is
 * shared in `strategy.ts`. There is deliberately no "assumption" / "expected" /
 * "likely" member: a claim that was never observed cannot be recorded without
 * inventing a channel, and the guard rejects a channel outside this list.
 */
export const RUNTIME_EVIDENCE_CHANNELS = [
  "product-runtime-source",
  "product-documentation",
  "designer-api",
  "generated-runtime-browser",
] as const;

// ---------------------------------------------------------------------------
// Pinned target
// ---------------------------------------------------------------------------

/**
 * The exact target the contract was established against.
 *
 * Pinned rather than described, because a contract without a version is a
 * claim about "Forguncy" in the abstract, and Forguncy ships its own React and
 * transpiler per version.
 */
export interface RuntimeContractTarget {
  readonly product: string;
  readonly productVersion: string;
  readonly productBuild: string;
  readonly hostReactVersion: string;
  readonly hostReactDomVersion: string;
  readonly browserTranspiler: string;
  readonly browserTranspilerVersion: string;
  readonly reactCellTypePluginGuid: string;
  readonly decision: ArchitectureDecisionSource;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const RUNTIME_CONTRACT_TARGET: RuntimeContractTarget = {
  product: "Forguncy",
  productVersion: "12.0.100.0",
  productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
  hostReactVersion: "19.2.7",
  hostReactDomVersion: "19.2.7",
  browserTranspiler: "Babel standalone",
  browserTranspilerVersion: "7.29.4",
  reactCellTypePluginGuid: "96205a31-0c2e-4b98-9ce5-6555088e6cbd",
  decision: RUNTIME_CONTRACT_DECISION,
  evidence: ["product-runtime-source", "generated-runtime-browser"],
};

/** Short header for reports, PR bodies and diagnostics. */
export function describeRuntimeContractTarget(target: RuntimeContractTarget = RUNTIME_CONTRACT_TARGET): string {
  return `${target.product} ${target.productVersion} (${target.productBuild}) — host React ${target.hostReactVersion}, browser ${target.browserTranspiler} ${target.browserTranspilerVersion}`;
}

// ---------------------------------------------------------------------------
// Execution model
// ---------------------------------------------------------------------------

export interface CellSourceExecutionModel {
  /** How the cell source is transformed before it runs. */
  readonly transformCall: string;
  readonly transformPresets: readonly string[];
  /**
   * Transforms that are *not* applied. Their absence is the reason TypeScript
   * annotations, module syntax and un-transpiled language features cannot rely
   * on the platform to be lowered.
   */
  readonly missingTransforms: readonly string[];
  /** How the transformed source is bound to the host. */
  readonly hostBindingCall: string;
  /** The `new Function` parameters, in the order the runtime passes them. */
  readonly injectedParameters: readonly string[];
  /** How user source is additionally nested inside the function body. */
  readonly userCodeNesting: string;
  /** `new Function` gives each cell its own function scope. */
  readonly perCellCompilationScope: boolean;
  /** Declarations at the top level of a cell do not become page globals. */
  readonly topLevelDeclarationsReachGlobalThis: boolean;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const CELL_SOURCE_EXECUTION_MODEL: CellSourceExecutionModel = {
  transformCall: 'Babel.transform(source, { presets: ["react"] })',
  transformPresets: ["react"],
  missingTransforms: ["typescript", "preset-env", "module (import/export lowering)"],
  hostBindingCall:
    'new Function("React", "antd", "echarts", "dayjs", "ForguncyReactHelper", "__useDataSource", "__props", compiled + returnExpression)',
  injectedParameters: ["React", "antd", "echarts", "dayjs", "ForguncyReactHelper", "__useDataSource", "__props"],
  userCodeNesting:
    "an arrow IIFE inside the function body, which also declares props, useState, useEffect, useMemo, useRef, useCallback, useDataSource, DataSourceCompareType, DataSourceRelationType, __renderResult and render",
  perCellCompilationScope: true,
  topLevelDeclarationsReachGlobalThis: false,
  evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
};

// ---------------------------------------------------------------------------
// Host runtime across cells
// ---------------------------------------------------------------------------

export type CellHostRuntimeFactId =
  | "single-react-instance-per-page"
  | "shared-global-this"
  | "one-react-root-per-cell"
  | "context-does-not-cross-cells"
  | "initialisation-order-is-not-layout-order"
  | "unmount-clears-the-cell-root";

/**
 * A fact about the page the cells live in, rather than about one cell's source.
 *
 * These are the facts a downstream consumer needs in order to reason about *more
 * than one* cell at once.
 *
 * Two different kinds of locality are easy to conflate here, and this module keeps
 * them apart on purpose. Component state, hooks and React Context are local to a
 * cell *because* every cell is its own React root (`one-react-root-per-cell`,
 * `context-does-not-cross-cells`). JavaScript module identity is **not** covered by
 * that: page-global identity stays page-global, which is why
 * `FRONTEND_LIBRARY_RUNTIME_SEMANTICS.globalsArePageWide` is true and why
 * `strategy.ts` selects `extension` whenever shared module identity or a cross-cell
 * singleton is required. What is local to a cell is an *inlined copy* of a
 * dependency, and that locality comes from the per-cell `new Function` scope
 * (`CELL_SOURCE_EXECUTION_MODEL.perCellCompilationScope`), not from the React root.
 */
export interface CellHostRuntimeFact {
  readonly id: CellHostRuntimeFactId;
  readonly statement: string;
  /**
   * How to re-run the observation. Kept because these facts are the kind that a
   * later Forguncy version can silently change.
   */
  readonly howToObserve: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The verified multi-cell host runtime behaviour.
 *
 * `generated-runtime-browser` here means the fact was produced by executing
 * probes on a page holding two or three React cells and reading the result back
 * out of the live document — not by reading the product source and reasoning
 * about it.
 */
export const CELL_HOST_RUNTIME_SEMANTICS: readonly CellHostRuntimeFact[] = [
  {
    id: "single-react-instance-per-page",
    statement:
      "Every cell receives the same host React object: there is one React instance for the whole page, not one per cell.",
    howToObserve:
      "Stamp a property on React from one cell and read it back from a second cell's entry; the second cell observes the first cell's stamp.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "shared-global-this",
    statement:
      "All cells on a page share one globalThis, so state published on a page global is visible to every cell.",
    howToObserve:
      "Have each cell append to a page-level array on globalThis and compare the accumulated length at each entry execution.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "one-react-root-per-cell",
    statement:
      "Each cell owns its own container element and its own ReactDOM root; cells are sibling roots rather than branches of one page-wide root.",
    howToObserve:
      "After the page settles, count the distinct elements carrying a __reactContainer$ property: one per React cell.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "context-does-not-cross-cells",
    statement:
      "A React context provided inside one cell is not visible to another cell, even though both cells share the same React object and can reference the same context object.",
    howToObserve:
      "Publish a context on globalThis from cell A, provide a non-default value inside cell A, and read that same context object from cell B: cell B sees the default value.",
    evidence: ["generated-runtime-browser"],
  },
  {
    id: "initialisation-order-is-not-layout-order",
    statement: "Cell entry execution order is not the layout order of the cells on the page.",
    howToObserve:
      "Record an execution marker from every cell and compare the recorded order with the cell addresses; on the probe page the order was A, C, B for cells laid out at columns 1, 25 and 13.",
    evidence: ["generated-runtime-browser"],
  },
  {
    id: "unmount-clears-the-cell-root",
    statement: "Teardown renders null into the cell's own root instead of unmounting a shared page root.",
    howToObserve:
      "Not executed: read from the runtime teardown path. Observing it needs a live page navigation while watching a cell root.",
    evidence: ["product-runtime-source"],
  },
];

export function findCellHostRuntimeFact(id: CellHostRuntimeFactId): CellHostRuntimeFact {
  const fact = CELL_HOST_RUNTIME_SEMANTICS.find(candidate => candidate.id === id);
  if (!fact) {
    throw new Error(`Unknown ReactCellType host runtime fact "${id}".`);
  }
  return fact;
}

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

export type CellEntryKind =
  | "app-function-declaration"
  | "app-async-function-declaration"
  | "app-variable-assignment"
  | "app-arrow-assignment"
  | "app-class-component"
  | "render-call"
  | "top-level-element-variable"
  | "whole-source-expression"
  | "no-entry";

export interface CellEntryShape {
  readonly id: CellEntryKind;
  /** The source shape, described the way a generator would emit it. */
  readonly shape: string;
  /** Accepted by `api.page.setCells` against a real project. */
  readonly acceptedAtWriteTime: boolean;
  /** An element actually mounted in the generated runtime page. */
  readonly renderedAtRuntime: boolean;
  /** Set when the shape is accepted but does not work, or works but is not an entry. */
  readonly note?: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The entry shapes a generator may emit, and the two it may not.
 *
 * `app-async-function-declaration` is the trap: the platform's write-time
 * validator accepts it, and React 19 then refuses it at runtime. A generator
 * that only validates against the designer API will ship a blank cell.
 */
export const CELL_ENTRY_SHAPES: readonly CellEntryShape[] = [
  {
    id: "app-function-declaration",
    shape: "function App(props) { ... }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-variable-assignment",
    shape: "var App = function (props) { ... };",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-arrow-assignment",
    shape: "const App = (props) => <div />;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-class-component",
    shape: "class App extends React.Component { render() { ... } }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-async-function-declaration",
    shape: "async function App(props) { ... }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: false,
    note: "Accepted by the write-time validator, then rejected by React 19 at runtime with minified error #482 (\"an async Client Component\"). Do not emit.",
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "render-call",
    shape: "render(<div />);",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    note: "Requires no App binding at all; this is the documented alternative entry.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "top-level-element-variable",
    shape: "const element = <div />;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "whole-source-expression",
    shape: "<div />",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    note: "Only when the trimmed source starts with `<` or `(`; the platform re-compiles the whole source as one expression.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "no-entry",
    shape: "const x = 1;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: false,
    note: "Accepted and silently renders nothing, with no console error. A generator bug that drops the entry therefore fails silently in production.",
    evidence: ["designer-api", "generated-runtime-browser"],
  },
];

export interface CellEntryResolutionStep {
  readonly order: number;
  readonly mechanism: string;
  /** The ordering itself is read from the runtime source; each mechanism was executed separately. */
  readonly orderingEvidence: RuntimeEvidenceChannel;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * Which mechanism wins when a source satisfies more than one of them.
 *
 * Ordering is a property of the runtime implementation, so it is recorded from
 * the source rather than inferred from which shapes happened to render.
 */
export const CELL_ENTRY_RESOLUTION_ORDER: readonly CellEntryResolutionStep[] = [
  {
    order: 1,
    mechanism: "A render(value) call wins: the recorded render result is returned as the element.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 2,
    mechanism: "Otherwise an App binding is wrapped as React.createElement(App, props).",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 3,
    mechanism: "Otherwise a top-level element binding is used as the element.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 4,
    mechanism:
      "Otherwise, when the trimmed source starts with `<` or `(`, the whole source is compiled again as a single expression.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 5,
    mechanism: "Otherwise the cell stays empty and no error is logged.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
];

export function findCellEntryShape(id: CellEntryKind): CellEntryShape {
  const shape = CELL_ENTRY_SHAPES.find(candidate => candidate.id === id);
  if (!shape) {
    throw new Error(`Unknown ReactCellType entry shape "${id}".`);
  }
  return shape;
}

/** Entry shapes that validate but do not work. A generator must never emit these. */
export function nonWorkingCellEntryShapes(): readonly CellEntryShape[] {
  return CELL_ENTRY_SHAPES.filter(shape => !shape.renderedAtRuntime);
}

/**
 * The entry shapes a generator may emit: they satisfy the platform's write-time
 * validator *and* actually mount. `no-entry` is excluded even though it is
 * accepted, because it describes the absence of a shape rather than one.
 */
export function emitCellEntryShapes(): readonly CellEntryShape[] {
  return CELL_ENTRY_SHAPES.filter(shape => shape.acceptedAtWriteTime && shape.renderedAtRuntime);
}

// ---------------------------------------------------------------------------
// Rejected source
// ---------------------------------------------------------------------------

export type CellSourceRejectionId =
  | "import-declaration"
  | "export-declaration"
  | "react-use"
  | "use-action-state"
  | "use-optimistic"
  | "use-form-status"
  | "typescript-annotation"
  | "top-level-await"
  | "top-level-return"
  | "duplicate-top-level-declaration"
  | "runtime-import-call-not-rejected";

export interface CellSourceRejection {
  readonly id: CellSourceRejectionId;
  /**
   * Which validation pass rejects it. `preview` compiles the wrapped source;
   * `babel` parses the raw source. Both surface through the same designer error.
   */
  readonly stage: "preview" | "babel" | "none";
  /** The platform's own wording, verbatim where it is a fixed message. */
  readonly message: string;
  /**
   * True when the platform caps or repeats the message, so the recorded string is
   * one observed sample rather than a constant.
   */
  readonly messageVaries: boolean;
  /** Whether this construct is refused, rather than merely unstyled. */
  readonly rejected: boolean;
  readonly note: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The source restrictions the target enforces itself, with its own wording.
 *
 * A compiler should reproduce these messages rather than invent its own, because
 * the same code is rejected again when it reaches the platform.
 *
 * `runtime-import-call-not-rejected` is recorded as a *rejection record* because
 * it belongs in the same decision table, but its `rejected` flag is false: the
 * platform validator does not reject `import()`. The "no runtime chunk loading"
 * rule is a bundler/artifact requirement (#6, #7), not a platform prohibition,
 * and conflating the two would make a later reader believe the platform will
 * catch it.
 */
export const CELL_SOURCE_REJECTIONS: readonly CellSourceRejection[] = [
  {
    id: "import-declaration",
    stage: "preview",
    message: "ReactCellType does not support import statements. Use the provided global variables instead.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant in the runtime. Design-time rejection; the cell is never written.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "export-declaration",
    stage: "preview",
    message:
      "ReactCellType does not support export statements. Define App, element, or call render(value) instead.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant; also the shortest statement of the accepted entry shapes.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "react-use",
    stage: "preview",
    message:
      "React.use is not supported in ReactCellType user code. Use stable client-side hooks such as React.useState and React.useEffect.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant. Rejected by name, so it cannot be worked around with an alias.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "use-action-state",
    stage: "preview",
    message: "useActionState is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table; not separately executed.",
    evidence: ["product-runtime-source"],
  },
  {
    id: "use-optimistic",
    stage: "preview",
    message: "useOptimistic is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table; not separately executed.",
    evidence: ["product-runtime-source"],
  },
  {
    id: "use-form-status",
    stage: "preview",
    message: "useFormStatus is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table; not separately executed.",
    evidence: ["product-runtime-source"],
  },
  {
    id: "typescript-annotation",
    stage: "babel",
    message: 'unknown: Unexpected token, expected "," (1:18)',
    messageVaries: true,
    rejected: true,
    note: "Babel parse error with the offending position and a code frame; the position varies with the source.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "top-level-await",
    stage: "preview",
    message: "unknown: Unexpected reserved word 'await'. (2:10)",
    messageVaries: true,
    rejected: true,
    note: "Reported against the wrapped source, so the frame exposes the IIFE nesting.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "top-level-return",
    stage: "babel",
    message: "unknown: 'return' outside of function. (1:0)",
    messageVaries: true,
    rejected: true,
    note: "The raw source is parsed as a program, so a top-level return is not a legal way to return an element.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "duplicate-top-level-declaration",
    stage: "babel",
    message: "unknown: Identifier 'App' has already been declared. (2:9)",
    messageVaries: true,
    rejected: true,
    note: "Any duplicate top-level declaration is refused, not only App.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "runtime-import-call-not-rejected",
    stage: "none",
    message: "none — the validator does not reject a dynamic import() call expression",
    messageVaries: false,
    rejected: false,
    note: "Accepted at write time and the element still renders; the call simply fails if it is ever executed. Treat as a bundler requirement, not a platform guarantee.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
];

/** How the platform reports a rejected source, so a compiler can match the wording. */
export const CELL_SOURCE_REJECTION_ENVELOPE = {
  template: "Invalid AI-generated object 'ReactCellTypeCellType': ReactCellType 代码验证失败 [<stage>]：<message>",
  stageTags: ["preview", "babel"],
  evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
};

/**
 * What happens when a rejected source reaches the runtime anyway.
 *
 * Recorded from the runtime source, not executed: the designer refused every
 * rejected sample, so no rejected source could be mounted to observe.
 */
export const CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR = {
  behavior: "the cell's root is rendered with null and the error is written to console.error",
  rendersErrorTextInCell: false,
  note: "Unrelated to frontend-library failures, which do render their message in the cell.",
  evidence: ["product-runtime-source"] as readonly RuntimeEvidenceChannel[],
};

export function findCellSourceRejection(id: CellSourceRejectionId): CellSourceRejection {
  const rejection = CELL_SOURCE_REJECTIONS.find(candidate => candidate.id === id);
  if (!rejection) {
    throw new Error(`Unknown ReactCellType source rejection "${id}".`);
  }
  return rejection;
}

/** Only the constructs the target actually refuses. */
export function rejectedCellSourceConstructs(): readonly CellSourceRejection[] {
  return CELL_SOURCE_REJECTIONS.filter(rejection => rejection.rejected);
}

// ---------------------------------------------------------------------------
// How the target decides what to refuse
// ---------------------------------------------------------------------------

/**
 * The mechanism behind `CELL_SOURCE_REJECTIONS`, as opposed to its messages.
 *
 * Decision source: GitHub Issue #5 — see `CELL_SOURCE_REJECTIONS` above for the
 * messages. This record exists because the messages cannot answer a question a
 * consumer has to answer: *may I look for these constructs in raw source text?*
 *
 * A message like "React.use is not supported" is equally consistent with a name
 * match over the whole file and with a syntax-node check, and the two disagree
 * exactly where it matters — a string, template literal or comment that contains
 * the same characters. A consumer that guesses "textual" refuses artifacts the
 * platform accepts, which is worse than not checking locally at all: it blocks
 * correct output and teaches the caller to disable the check.
 *
 * Read from the shipped plugin resource of the ReactCellType cell type
 * (`Resources/ReactCellTypeCellType.js` under plugin
 * `96205a31-0c2e-4b98-9ce5-6555088e6cbd`), so the answer is observed rather than
 * inferred. The answer is: syntax nodes, never text. `AST_TRAVERSAL_SKIPPED_KEYS`
 * is the load-bearing detail — the walk does not descend into comment or token
 * properties at all, so a construct that exists only inside a comment cannot be
 * refused by it.
 */
export interface CellSourceValidationMechanism {
  /** The parse the checks run through. */
  readonly parseCall: string;
  /** The scope the declaration check parses in. */
  readonly declarationSourceType: string;
  /** Declaration node types refused outright. */
  readonly refusedDeclarationNodeTypes: readonly string[];
  /** Any node type starting with this prefix is refused as an export declaration. */
  readonly refusedDeclarationNodeTypePrefix: string;
  /** How the call check wraps the source before parsing it. */
  readonly reactCallCheckWrap: string;
  /**
   * The node type the callee check visits.
   *
   * Recorded because it is a boundary a consumer gets wrong by assuming "a call":
   * `new useFormStatus()` is a `NewExpression`, which this check never sees, so
   * refusing it locally would refuse something the platform accepts.
   */
  readonly refusedCalleeNodeType: string;
  /** Bare callee identifiers refused when called. */
  readonly refusedBareCalleeNames: readonly string[];
  /** Objects whose non-computed members are refused when called. */
  readonly refusedMemberCalleeObjects: readonly string[];
  /** Member names refused on every object in {@link refusedMemberCalleeObjects}. */
  readonly refusedMemberNames: readonly string[];
  /** The member name refused on `React` alone. */
  readonly refusedReactOnlyMemberNames: readonly string[];
  /**
   * AST keys the walk does not descend into. Comments and tokens are here, which
   * is the whole reason text inside a comment can never be refused.
   */
  readonly skippedAstKeys: readonly string[];
  /**
   * A parse failure is swallowed by the declaration check rather than reported,
   * because the same failure is reported later, from the transform step.
   */
  readonly ignoresParseFailure: boolean;
  readonly note: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const CELL_SOURCE_VALIDATION_MECHANISM: CellSourceValidationMechanism = {
  parseCall: 'Babel.transform(source, { presets: ["react"], ast: true, code: false, sourceType })',
  declarationSourceType: "module",
  refusedDeclarationNodeTypes: ["ImportDeclaration"],
  refusedDeclarationNodeTypePrefix: "Export",
  reactCallCheckWrap: "(() => {\n<source>\n})();",
  refusedCalleeNodeType: "CallExpression",
  refusedBareCalleeNames: ["useActionState", "useOptimistic", "useFormStatus"],
  refusedMemberCalleeObjects: ["React", "ReactDOM"],
  refusedMemberNames: ["useActionState", "useOptimistic", "useFormStatus"],
  refusedReactOnlyMemberNames: ["use"],
  // Comments and tokens are skipped, so nothing inside them is ever visited.
  skippedAstKeys: ["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "tokens"],
  ignoresParseFailure: true,
  note: "Both checks walk parsed syntax nodes, so a string, template literal or comment that merely contains the same characters is not refused. Three boundaries follow from the node types and are easy to get wrong: the callee check visits `CallExpression` only, so `new useFormStatus()` is not refused; a computed member (`React[\"use\"]()`) is not refused; and `import(...)` is a call rather than a declaration, which is why the validator does not reject it.",
  evidence: ["product-runtime-source"],
};

/**
 * AST keys the target's own walk never descends into.
 *
 * Exported as a predicate rather than left to a consumer to re-derive from the
 * array, so "the target does not see comments" is asserted in one place.
 */
export function cellSourceValidationVisitsAstKey(key: string): boolean {
  return !CELL_SOURCE_VALIDATION_MECHANISM.skippedAstKeys.includes(key);
}

// ---------------------------------------------------------------------------
// Names visible inside user code
// ---------------------------------------------------------------------------

/** Where a name comes from, and therefore what it can be assumed to be. */
export type CellBindingAvailability =
  | "always"
  | "after-the-declared-preset-resolves"
  | "only-on-window";

export interface CellUserScopeBinding {
  readonly name: string;
  readonly kind: "injected-parameter" | "wrapper-local" | "extension-global" | "page-global";
  readonly availableInCellSource: CellBindingAvailability;
  /** Is the name also a property of the page's `window`? */
  readonly onWindow: CellBindingAvailability | "never";
  readonly note?: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The names a cell source may reference without importing them.
 *
 * This is the whole `host` mapping surface: anything not listed here has to be
 * `inline`d or supplied by an `extension`. The distinction between
 * `injected-parameter` and `wrapper-local` is not cosmetic — the runtime passes
 * the first set as `new Function` arguments, so their values are captured at the
 * moment the cell renders, while the second set is created per render.
 */
export const CELL_USER_SCOPE_BINDINGS: readonly CellUserScopeBinding[] = [
  {
    name: "React",
    kind: "injected-parameter",
    availableInCellSource: "always",
    onWindow: "always",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "antd",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "The AntDesign preset is the persisted default when `libraries` is omitted, so this is usually available — but see the per-render-instant caveat.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    name: "dayjs",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "Loaded as a dependency of the AntDesign preset, not as a preset of its own.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "echarts",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "Only loaded when the cell declares the ECharts preset; the runtime asserts the global exists before rendering.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "ForguncyReactHelper",
    kind: "injected-parameter",
    availableInCellSource: "always",
    onWindow: "never",
    note: "Available as a parameter but is NOT a window property; reading it through `window` fails.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "props",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useDataSource",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "DataSourceCompareType",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "DataSourceRelationType",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "render",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useState",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useEffect",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useMemo",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useRef",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useCallback",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "ReactDOM",
    kind: "page-global",
    availableInCellSource: "always",
    onWindow: "always",
    note: "Not injected as a parameter, but present as a page global; the runtime itself mounts cells with it.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
];

export function cellUserScopeBinding(name: string): CellUserScopeBinding | undefined {
  return CELL_USER_SCOPE_BINDINGS.find(binding => binding.name === name);
}

// ---------------------------------------------------------------------------
// Preset libraries
// ---------------------------------------------------------------------------

export interface CellPresetLibrary {
  readonly name: "None" | "AntDesign" | "ECharts";
  /** Host globals this preset makes available to the whole page. */
  readonly providesGlobals: readonly string[];
  /** Scripts loaded before those globals exist, in load order. */
  readonly scriptChain: readonly string[];
  /** Submitted to `Forguncy.LoadModule` instead of a script URL, when applicable. */
  readonly runtimeModule?: string;
  /** Persisted when the cell does not specify `libraries`. */
  readonly isPersistedDefault: boolean;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * Preset library chains.
 *
 * `None` is the important one: it is the only way to get a cell that does not
 * pull antd, and the only reliable way to prove a cell has no host library
 * dependency.
 */
export const CELL_PRESET_LIBRARIES: readonly CellPresetLibrary[] = [
  {
    name: "None",
    providesGlobals: [],
    scriptChain: [],
    isPersistedDefault: false,
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "AntDesign",
    providesGlobals: ["dayjs", "antd"],
    scriptChain: [
      "Resources/dayjs/dayjs.min.js",
      "Resources/antd/antd.zh-cn.js",
      "Resources/antd/antd.min.js",
      "Resources/antd/reset.css",
    ],
    isPersistedDefault: true,
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    name: "ECharts",
    providesGlobals: ["echarts"],
    scriptChain: [],
    runtimeModule: "chart",
    isPersistedDefault: false,
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
];

/**
 * The preset the platform persists when a cell omits `libraries`.
 *
 * Derived rather than restated: "the default is AntDesign" is a property of the
 * preset record above, so writing the name a second time would create a value
 * that can drift away from its own evidence.
 */
export function persistedDefaultCellPreset(): CellPresetLibrary {
  const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.isPersistedDefault);
  if (!preset) {
    throw new Error("No ReactCellType preset library is marked as the persisted default.");
  }
  return preset;
}

export const CELL_PRESET_LIBRARY_DEFAULT = persistedDefaultCellPreset().name;

export function findCellPresetLibrary(name: CellPresetLibrary["name"]): CellPresetLibrary {
  const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.name === name);
  if (!preset) {
    throw new Error(`Unknown ReactCellType preset library "${name}".`);
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Props and platform bridge
// ---------------------------------------------------------------------------

/**
 * The base `props` contract: the keys the runtime always injects, in the order it
 * injects them.
 *
 * The order is observable and therefore worth pinning: a generator that snapshots
 * `Object.keys(props)` in a fixture sees the base keys first, then configured
 * properties, then `ImageContext`. The key list lives on the record itself so it
 * cannot drift away from its evidence.
 */
export const CELL_PROPS_KEY_ORDER = {
  /** Always present, in this order, before any configured property. */
  baseKeys: ["Forguncy", "Permissions", "ServerCommands", "ImageContext"] as const,
  description:
    "Forguncy, then Permissions, then configured properties[].propertyName, then ImageContext; event handlers and configured permissions are injected before properties",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_PROPS_KEY_ORDER}. */
export const CELL_PROPS_BASE_KEYS = CELL_PROPS_KEY_ORDER.baseKeys;

export const CELL_FORGUNCY_FACADE = {
  /** The runtime API surface exposed to a cell as `props.Forguncy`. */
  keys: [
    "ConvertDateToOADate",
    "ConvertOADateToDate",
    "ConvertToCssColor",
    "DataSourceCompareType",
    "DataSourceRelationType",
    "Permissions",
    "exposeMethod",
    "getCurrentUser",
    "getPermissions",
    "getUploadLimit",
    "hasPermission",
    "logIn",
    "logOut",
    "uploadFiles",
  ] as const,
  description: "the cell's handle on Forguncy-owned capabilities, injected as props.Forguncy",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_FORGUNCY_FACADE}. */
export const CELL_FORGUNCY_PROP_KEYS = CELL_FORGUNCY_FACADE.keys;

export const CELL_SERVER_COMMANDS_CONTRACT = {
  /** Only the names listed in `availableServerCommands` are present. */
  shape: "a record of command name to async function",
  /**
   * The reserved result keys. Every other key on a result is one of the
   * command's own named returns.
   */
  resultKeys: ["errorCode", "errorMessage"] as const,
  /** Calling a name that was not configured is a plain TypeError, not a platform error. */
  unconfiguredNameType: "undefined",
  unconfiguredCallOutcome: "TypeError: <name> is not a function",
  namedReturnsAreExtraKeys: true,
  evidence: ["product-runtime-source", "product-documentation", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_SERVER_COMMANDS_CONTRACT}. */
export const CELL_SERVER_COMMAND_RESULT_KEYS = CELL_SERVER_COMMANDS_CONTRACT.resultKeys;

export const CELL_DATA_SOURCE_CONTRACT = {
  resultFieldsExecuted: ["data", "totalCount", "loading", "error"],
  resultFieldsDocumented: ["data", "totalCount", "loading", "error", "reload"],
  /** A name that was never declared is an error state, not a thrown exception. */
  unknownSourceOutcome: "the hook returns an error state whose message contains the data source name",
  pageSizeCountsAreServerSide: true,
  evidence: ["product-documentation", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// Frontend libraries
// ---------------------------------------------------------------------------

/** The persisted shape of one `cellTypeProps.frontendLibraries` entry. */
export interface FrontendLibraryReference {
  /** The stable `id` returned by `api.app.listFrontendLibraries`, not a display name or file name. */
  readonly libraryId: string;
}

export const FRONTEND_LIBRARY_REFERENCE_CONTRACT = {
  /** The only field a reference carries. */
  fieldName: "libraryId",
  /** Where the value has to come from. */
  fieldSource: "api.app.listFrontendLibraries[].id",
  example: { libraryId: "<api.app.listFrontendLibraries[].id>" },
  evidence: ["product-documentation", "designer-api", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link FRONTEND_LIBRARY_REFERENCE_CONTRACT}. */
export const FRONTEND_LIBRARY_REFERENCE_EXAMPLE: FrontendLibraryReference =
  FRONTEND_LIBRARY_REFERENCE_CONTRACT.example;

export const FRONTEND_LIBRARY_RUNTIME_SEMANTICS = {
  loadedThrough: "Forguncy.ensureFrontendLibrariesLoaded(libraryIds)",
  /**
   * A cell's own entry runs only after that cell's declared libraries resolve.
   * This is the guarantee a generator may rely on.
   */
  perCellReadinessAwaited: true,
  /**
   * Once loaded, an extension global is a page-level `window` property, so other
   * cells can observe it even though they never declared it.
   */
  globalsArePageWide: true,
  /**
   * Not guaranteed. Two cells declaring the same libraries in opposite order
   * produced one page-level load order, and the second cell observed that order
   * rather than its own.
   */
  loadOrderGuaranteed: false,
  /**
   * Not guaranteed. A cell can render while another cell's declared libraries are
   * still in flight, so a cell must not assume a library it did not declare is
   * present.
   */
  crossCellReadinessGuaranteed: false,
  /**
   * Host globals are bound as `new Function` parameters at the moment the cell
   * renders, so two cells on one page can legitimately observe different
   * snapshots of the same global.
   */
  presetGlobalsBoundPerRenderInstant: true,
  /** A library that fails to load renders its error message inside the cell. */
  failedLoadRendersMessageInCell: true,
  evidence: [
    "product-runtime-source",
    "product-documentation",
    "designer-api",
    "generated-runtime-browser",
  ] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// The generated runtime binding
// ---------------------------------------------------------------------------

/**
 * What a generated artifact must do so that a Cell calling the runtime façade works.
 *
 * Decision source: GitHub Issue #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host
 * Provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/82), which is where the
 * requirement's two halves meet: `#27/#29`'s façade states the *shape* a generated
 * binding has to satisfy (`host-provider.ts`), and
 * `RUNTIME_FACADE_PACKAGING_POLICY.compilerOwnsImportLowering` leaves emitting it to the
 * artifact/compiler boundary.
 *
 * ## Why the contract is here rather than in the compiler
 *
 * Every field below is a *name* that two independently-written modules have to agree on:
 * the package specifier an authored `import` uses, and the two members the generated
 * binding calls on it. That is the same kind of fact `HOST_BRIDGE_MAPPINGS` carries —
 * "which import is bound to which identity" — and this module is where that kind of fact
 * lives. Hard-coding them in `cell-compiler` would work until the façade renamed a
 * member, at which point the binding would silently stop installing and the Cell would
 * fail at its first façade call with the very error #82 exists to remove.
 *
 * ## What each name is, and what makes it the right one
 *
 * - `facadeSpecifier` is the specifier authored source writes. It is a *workspace* source
 *   dependency (#14), not a published one: the compiler flattens it into each Cell like
 *   any other source file, which is what makes the façade's single per-Cell provider slot
 *   correct (`RUNTIME_FACADE_PACKAGING_POLICY.perCellDuplicateAllowed`).
 * - `installMember` and `createProviderMember` are the two members the binding calls.
 *   Both are exported from the façade's public barrel — the binding re-exports that barrel
 *   wholesale, so a name the barrel does not carry would break authored source that
 *   imports it.
 * - `hostNames` are the *free identifiers* the binding's source references. They are not
 *   imports: `props` and `useDataSource` are wrapper-locals the platform's own arrow IIFE
 *   declares before placing the cell source
 *   ({@link CELL_SOURCE_EXECUTION_MODEL}`.userCodeNesting`), so they are in scope where
 *   the binding module's body runs and are unreachable from anywhere else — which is
 *   precisely why the binding has to be generated inside the Cell rather than shipped in
 *   the package (`host-provider.ts`'s argument).
 *
 * ## The timing, and what it does not decide
 *
 * `installTiming` states the one ordering requirement the artifact can satisfy: the
 * binding module's body runs when the artifact is evaluated, which is before the
 * platform's `App` binding is ever called and therefore before any façade call. Whether
 * the platform *re-evaluates* the artifact when a property changes — and so whether a
 * re-render reads fresh `props` — is not decidable from this repository; it is recorded
 * as an open question below and belongs to #83/#84.
 */
export const CELL_RUNTIME_BINDING_CONTRACT = {
  /**
   * The specifier authored source imports the façade by.
   *
   * The *only* specifier the compiler may intercept for this purpose, and the same one
   * `RUNTIME_FACADE_DECISION` documents: one package, one address.
   */
  facadeSpecifier: "@forguncy-react-workspace/runtime",
  /** The member the binding calls to install the provider. */
  installMember: "installRuntimeFacadeProvider",
  /** The member the binding calls to build a provider from the Cell's own values. */
  createProviderMember: "createHostRuntimeFacadeProvider",
  /**
   * The `createHostRuntimeFacadeProvider` input fields, as the binding fills them.
   *
   * `cellProps` and `useDataSource` under the port's own member names
   * (`RUNTIME_FACADE_PORT_CHANNEL_MEMBERS`), so a channel the port renames cannot leave
   * the generated binding addressing the old one.
   */
  providerInput: { cellProps: "cellProps", useDataSource: "useDataSource" },
  /**
   * The free identifiers the binding's generated source references.
   *
   * Both are `wrapper-local` names `CELL_USER_SCOPE_BINDINGS` verifies as available in
   * cell source (`props` and `useDataSource`), which is what makes it legal for generated
   * code to name them without importing anything. A generator that emitted a third name
   * would be inventing an address — `RUNTIME_FACADE_FORBIDDEN_PATTERNS`'
   * `second-address-for-a-cell-binding`.
   */
  hostNames: ["props", "useDataSource"] as const,
  /**
   * When the binding installs, stated as the ordering guarantee a generator can meet.
   *
   * "The artifact's own module evaluation" rather than "per render": the binding is a
   * module in the artifact's graph, so its body runs once when the artifact is evaluated,
   * and the platform calls the `App` binding afterwards. Installing later would leave the
   * first façade call unserved, which is the defect.
   */
  installTiming: "when the generated artifact is evaluated, before the platform calls its App binding",
  note: "The provider is built from the Cell's own `props` and `useDataSource` and is never read from a page global: #5 records both as values the runtime injects, and `props` is not a window property at all.",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_RUNTIME_BINDING_CONTRACT}. */
export const CELL_RUNTIME_BINDING_HOST_NAMES = CELL_RUNTIME_BINDING_CONTRACT.hostNames;

// ---------------------------------------------------------------------------
// Cell code budget
// ---------------------------------------------------------------------------

/**
 * What was measured about cell source size.
 *
 * No hard limit was found, so no limit is claimed. The transpiler notice is the
 * one real cost: it is emitted at `console.error` level, which is why the
 * project's "console Error count === 0" gate is a *budget* gate and not just a
 * correctness gate. Turning this into a policy number is #21's decision, not
 * this module's.
 */
export const CELL_SOURCE_SIZE_OBSERVATIONS = {
  hardCharacterLimit: null,
  largestAcceptedSourceCharacters: 2097214,
  transpilerNoticeObservedAtCharacters: 2097214,
  transpilerNoticeNotObservedAtCharacters: 524350,
  transpilerNoticeConsoleLevel: "error",
  transpilerNoticeMessage:
    "[BABEL] Note: The code generator has deoptimised the styling of undefined as it exceeds the max of 500KB.",
  note: "The threshold is the browser transpiler's, reported as 500KB; the platform itself accepted a source roughly four times that.",
  evidence: ["designer-api", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// Open questions
// ---------------------------------------------------------------------------

export interface RuntimeContractUnknown {
  readonly id: string;
  readonly question: string;
  readonly whyOpen: string;
  /** The Issue expected to settle it, when one owns the question. */
  readonly ownedBy?: string;
}

/**
 * Questions the contract probe could not settle.
 *
 * Recorded in code rather than only in the Issue so that a consumer of this
 * module cannot mistake an open question for a decided one.
 */
export const RUNTIME_CONTRACT_UNKNOWNS: readonly RuntimeContractUnknown[] = [
  {
    id: "shared-top-level-identifier",
    question: "May two cells declare the same top-level identifier?",
    whyOpen: "Each probe cell used a distinct name. The per-cell compilation scope implies yes, but this was not executed.",
  },
  {
    id: "property-change-re-render",
    question: "Does a property change re-execute the cell entry, or re-render the existing tree?",
    whyOpen: "The runtime re-creates the element factory when a property value changes; not exercised with state to observe whether component state survives.",
    ownedBy: "#6",
  },
  {
    id: "artifact-re-evaluated-per-render",
    question:
      "Does the platform re-evaluate a Cell artifact's modules when a property changes, or evaluate them once and re-render the existing tree?",
    whyOpen:
      "The generated runtime binding installs the host provider from the Cell's `props` when the artifact is evaluated (#82). If the platform evaluates the artifact once and then re-invokes the `App` binding with new props, the installed provider holds the first render's props and a re-render reads stale values — silently, with every check in the façade passing. The recorded execution model gives the nesting but not the invocation count, so this is not decidable from the repository.",
    ownedBy: "#83",
  },
  {
    id: "absolute-source-ceiling",
    question: "Is there any absolute ceiling on cell source size?",
    whyOpen: "None found up to 2,097,214 characters; larger sources were not attempted and designer memory pressure was out of scope.",
    ownedBy: "#21",
  },
  {
    id: "permission-snapshot-empty",
    question: "Can props.Permissions come back empty for a configured permission?",
    whyOpen: "One early run reported an empty snapshot; a dedicated isolation run with the same configuration returned the expected value in three of three cells, so the observation is unreproduced.",
  },
  {
    id: "load-order-stability",
    question: "Is page-level frontend library load order stable across cells in general?",
    whyOpen: "One conflicting-order sample. The safe reading is already recorded as loadOrderGuaranteed: false.",
  },
  {
    id: "permission-refresh-without-reload",
    question: "Does the permission snapshot refresh when the signed-in user's roles change?",
    whyOpen: "Not exercised.",
  },
];

export function openRuntimeContractQuestions(ownedBy?: string): readonly RuntimeContractUnknown[] {
  return ownedBy === undefined
    ? RUNTIME_CONTRACT_UNKNOWNS
    : RUNTIME_CONTRACT_UNKNOWNS.filter(unknown => unknown.ownedBy === ownedBy);
}
