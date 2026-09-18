/**
 * The entry the generated artifact exposes.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * #6 leaves the exact generated source wrapper to be derived from the runtime
 * contract, and makes one promise about it: "Generated code is accepted by
 * ReactCellType and exposes the required `App` entry." So the wrapper is not a
 * free choice. It has to satisfy two independent facts from #5 at once, and the
 * shapes that satisfy only one are the interesting part of this module:
 *
 * - The platform's write-time validator accepts nine source shapes, but two of
 *   them do not render. `app-async-function-declaration` is accepted and then
 *   refused by React 19 with minified error #482, and `no-entry` is accepted and
 *   silently renders nothing. A generator that trusts the validator ships a
 *   blank cell with no error, which is the worst failure mode this module exists
 *   to prevent.
 * - A bundled module cannot *be* one of the shapes that are pure expressions. The
 *   `whole-source-expression` shape works only because the platform recompiles
 *   the trimmed source as a single expression when it starts with `<` or `(`,
 *   and an artifact that also has to carry a bundled body never does.
 *
 * The wrapper therefore always declares a binding and returns an element, which
 * is what #5's resolution order looks for: a `render(value)` call wins, then an
 * `App` binding, then a top-level element binding. Nothing here re-states that
 * order — the table below is checked against `core`'s records in the tests.
 */

import { CELL_USER_SCOPE_BINDINGS, emitCellEntryShapes, findCellEntryShape } from "@forguncy-react-workspace/core";
import type { CellEntryKind } from "@forguncy-react-workspace/core";

import type { CellArtifactDiagnostic } from "./diagnostics";
import { createCellArtifactDiagnostic } from "./diagnostics";

/**
 * Stands for the identifier the bundled component is bound to.
 *
 * A placeholder rather than string interpolation, because the template has to be
 * inspectable as data: the tests assert that no emitted template contains a
 * construct the target refuses, and that is only possible if the templates exist
 * independently of any particular binding name.
 */
export const CELL_ENTRY_COMPONENT_PLACEHOLDER = "{{component}}";

/**
 * The identifier the generated wrapper references, and therefore the identifier
 * the bundle has to declare.
 *
 * Fixed rather than configurable, and owned here rather than by the caller. An
 * earlier version exposed it as a compiler option, which could not work: the
 * bundler never learned the name, so a caller passing anything other than the
 * default produced a wrapper referencing an identifier nothing declared — an
 * artifact that assembled cleanly and failed only inside ReactCellType. A knob
 * whose wrong settings are invisible is worse than no knob, and there is nothing
 * to configure: each cell compiles in its own function scope, so one binding name
 * cannot collide with another cell.
 *
 * The bundler is told the name rather than left to guess: `CellBundlingRequest`
 * carries it, so `#7`'s implementation has it in hand (an IIFE `output.name` is
 * the direct expression of "bind the entry to this identifier").
 */
export const CELL_ENTRY_COMPONENT_BINDING = "__forguncyCellEntry";

export interface CellEntryWrapperSupport {
  readonly kind: CellEntryKind;
  /** Can the compiler emit this shape around a bundled module? */
  readonly expressible: boolean;
  /** The shape emitted when the caller does not choose one. Exactly one row sets this. */
  readonly isDefault: boolean;
  /** The source to emit. Present only when `expressible`. */
  readonly template?: string;
  /** Why this shape is or is not usable here. Always present, for every row. */
  readonly note: string;
}

/**
 * Every entry shape `core` records, and whether this contract can emit it.
 *
 * Exhaustive over `CellEntryKind` on purpose: a new shape in the runtime
 * contract must force an edit here rather than defaulting to "not emitted
 * because nobody thought about it".
 */
export const CELL_ENTRY_WRAPPER_SUPPORT: readonly CellEntryWrapperSupport[] = [
  {
    kind: "app-function-declaration",
    expressible: true,
    isDefault: true,
    template: "function App(props) {\n  return React.createElement({{component}}, props);\n}",
    note: "The default. A function declaration is a stable `App` binding for the platform's second resolution step, and it is the shape every other entry form can be reduced to.",
  },
  {
    kind: "app-arrow-assignment",
    expressible: true,
    isDefault: false,
    template: "const App = (props) => React.createElement({{component}}, props);",
    note: "Same binding, expression form. Useful when the surrounding artifact is itself an expression context.",
  },
  {
    kind: "app-variable-assignment",
    expressible: true,
    isDefault: false,
    template: "var App = function (props) {\n  return React.createElement({{component}}, props);\n};",
    note: "Same binding again; kept because #5 verified it separately, and a caller diffing generated output against the runtime contract will look for it by name.",
  },
  {
    kind: "app-class-component",
    expressible: true,
    isDefault: false,
    template:
      "class App extends React.Component {\n  render() {\n    return React.createElement({{component}}, this.props);\n  }\n}",
    note: "A class binding resolves through the same `App` step. Emitted only on request: a function component is what the bundled module actually is.",
  },
  {
    kind: "render-call",
    expressible: true,
    isDefault: false,
    template: "render(React.createElement({{component}}, props));",
    note: "The platform's first resolution step, and the only shape that needs no `App` binding at all. `render` is a wrapper-local of the generated function, so it is visible here but never on `window`.",
  },
  {
    kind: "top-level-element-variable",
    expressible: true,
    isDefault: false,
    template: "const element = React.createElement({{component}}, props);",
    note: "The platform's third resolution step. Emitted only on request: it is the only supported shape with no component boundary, so the bundled module cannot use hooks of its own through it.",
  },
  {
    kind: "whole-source-expression",
    expressible: false,
    isDefault: false,
    note: "Not emittable. The platform only recompiles the whole source as one expression when the trimmed source starts with `<` or `(`; an artifact that also carries a bundled body never does, so this shape cannot coexist with the thing this compiler produces.",
  },
  {
    kind: "app-async-function-declaration",
    expressible: false,
    isDefault: false,
    note: "Not emittable, and the reason the entry guard is not redundant with the platform's validator: the write-time validator accepts it and React 19 then refuses it. Emitting it would ship a cell that validates and never mounts.",
  },
  {
    kind: "no-entry",
    expressible: false,
    isDefault: false,
    note: "Not emittable. It describes the absence of an entry, and the platform accepts it in silence: the cell renders nothing and logs nothing, so a generator bug that produced it would be invisible in production.",
  },
];

export function findCellEntryWrapperSupport(kind: CellEntryKind): CellEntryWrapperSupport {
  const support = CELL_ENTRY_WRAPPER_SUPPORT.find(candidate => candidate.kind === kind);
  if (!support) {
    throw new Error(`Unknown ReactCellType entry shape "${kind}".`);
  }
  return support;
}

/** The entry shapes this contract can emit. */
export function expressibleCellEntryKinds(): readonly CellEntryKind[] {
  return CELL_ENTRY_WRAPPER_SUPPORT.filter(support => support.expressible).map(support => support.kind);
}

/**
 * The shape emitted when the caller does not choose one.
 *
 * Derived from the table rather than written down twice, so "the default" is a
 * property of the record that argues for it instead of a second constant that
 * can drift away from the first.
 */
export const CELL_ARTIFACT_DEFAULT_ENTRY_KIND: CellEntryKind = defaultEntryKind();

function defaultEntryKind(): CellEntryKind {
  const defaults = CELL_ENTRY_WRAPPER_SUPPORT.filter(support => support.isDefault);
  if (defaults.length !== 1) {
    throw new Error(
      `Exactly one Cell entry shape must be marked as the default; ${defaults.length} are marked.`,
    );
  }
  const [support] = defaults;
  if (!support || !support.expressible) {
    throw new Error("The default Cell entry shape must be expressible.");
  }
  return support.kind;
}

/** Identifiers a generated wrapper can reference. Deliberately ASCII-only, like the platform's own bindings. */
export const JAVASCRIPT_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface RenderCellEntryWrapperInput {
  /** Which entry shape to emit. Defaults to the documented default. */
  readonly entryKind?: CellEntryKind;
}

export type CellEntryWrapperRender =
  | { readonly status: "emitted"; readonly kind: CellEntryKind; readonly source: string }
  | { readonly status: "unsupported"; readonly diagnostics: readonly CellArtifactDiagnostic[] };

/**
 * Renders the entry the artifact exposes.
 *
 * Failure is a value, not a throw: the caller is assembling an artifact and has a
 * channel for diagnostics (`rejected-cell-entry-shape` is one of #6's own error
 * model entries), so throwing here would force the caller to catch a string and
 * re-invent the diagnostic it already knows how to carry.
 *
 * The component binding is not a parameter — see {@link CELL_ENTRY_COMPONENT_BINDING}.
 * The only input is the shape, which is the only part of this that is a choice.
 */
export function renderCellEntryWrapper(input: RenderCellEntryWrapperInput = {}): CellEntryWrapperRender {
  const kind = input.entryKind ?? CELL_ARTIFACT_DEFAULT_ENTRY_KIND;
  const support = findCellEntryWrapperSupport(kind);

  if (!support.expressible || support.template === undefined) {
    return {
      status: "unsupported",
      diagnostics: [
        createCellArtifactDiagnostic("rejected-cell-entry-shape", kind, {
          detail: `Entry shape "${kind}" cannot be emitted. ${support.note}`,
        }),
      ],
    };
  }

  return {
    status: "emitted",
    kind,
    // `split`/`join` rather than `String.replace`, because a replacement string
    // treats `$` specially and `$` is a legal identifier character.
    source: support.template.split(CELL_ENTRY_COMPONENT_PLACEHOLDER).join(CELL_ENTRY_COMPONENT_BINDING),
  };
}

/**
 * The verified bindings each template references, keyed by entry shape.
 *
 * Declared rather than inferred, and then *checked* in two directions:
 *
 * - `cellEntryWrapperNamesAreVerified` requires every name here to be a name the
 *   runtime contract verified as visible inside cell source, so a template that
 *   reached for an invented global fails;
 * - the tests require every name declared for an expressible shape to actually
 *   occur in that shape's template text, so the declaration cannot drift away
 *   from the code it describes.
 *
 * Together those two are what makes "the wrappers only use verified names" an
 * assertion rather than a claim in a comment. A `Record` keyed by
 * `CellEntryKind` rather than a list, so a new entry shape cannot be added
 * without deciding what its wrapper is allowed to reference.
 */
const CELL_ENTRY_WRAPPER_HOST_NAMES_BY_KIND: Readonly<Record<CellEntryKind, readonly string[]>> = {
  "app-function-declaration": ["React", "props"],
  "app-arrow-assignment": ["React", "props"],
  "app-variable-assignment": ["React", "props"],
  "app-class-component": ["React", "props"],
  "render-call": ["React", "render", "props"],
  "top-level-element-variable": ["React", "props"],
  // Not expressible, so nothing is referenced and nothing may be declared.
  "whole-source-expression": [],
  "app-async-function-declaration": [],
  "no-entry": [],
};

/** The host names every generated wrapper may reference, in a stable order. */
export const CELL_ENTRY_WRAPPER_HOST_NAMES: readonly string[] = [
  ...new Set(Object.values(CELL_ENTRY_WRAPPER_HOST_NAMES_BY_KIND).flat()),
].sort();

/** The names one entry shape's wrapper references. Empty for a shape that cannot be emitted. */
export function cellEntryWrapperHostNames(kind: CellEntryKind): readonly string[] {
  return CELL_ENTRY_WRAPPER_HOST_NAMES_BY_KIND[kind];
}

/** True when every name is one the runtime contract verified inside cell source. */
export function cellEntryWrapperNamesAreVerified(
  names: readonly string[] = CELL_ENTRY_WRAPPER_HOST_NAMES,
): boolean {
  return names.every(name => CELL_USER_SCOPE_BINDINGS.some(binding => binding.name === name));
}

/**
 * The shapes #5 marks as accepted at write time but that this contract still
 * cannot emit, re-exported through the entry contract so a generator has one
 * place to look.
 *
 * Two different reasons land here and the distinction is worth keeping:
 * `app-async-function-declaration` and `no-entry` do not render at all, while
 * `whole-source-expression` renders but only as a whole-source expression, which
 * a bundled body cannot be.
 */
export function acceptedButNotEmittableCellEntryKinds(): readonly CellEntryKind[] {
  return CELL_ENTRY_WRAPPER_SUPPORT.filter(
    support => support.expressible === false && findCellEntryShape(support.kind).acceptedAtWriteTime,
  ).map(support => support.kind);
}

/** The shapes #5 records that a generator may emit, for comparison against this contract. */
export function runtimeContractEmittableCellEntryKinds(): readonly CellEntryKind[] {
  return emitCellEntryShapes().map(shape => shape.id);
}
