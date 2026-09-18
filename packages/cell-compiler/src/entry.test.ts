import { describe, expect, it } from "vitest";

import { CELL_ENTRY_SHAPES, findCellEntryShape } from "@forguncy-react-workspace/core";

import {
  CELL_ARTIFACT_DEFAULT_ENTRY_KIND,
  CELL_ENTRY_COMPONENT_PLACEHOLDER,
  CELL_ENTRY_WRAPPER_HOST_NAMES,
  CELL_ENTRY_WRAPPER_SUPPORT,
  acceptedButNotEmittableCellEntryKinds,
  cellEntryWrapperHostNames,
  cellEntryWrapperNamesAreVerified,
  expressibleCellEntryKinds,
  findCellEntryWrapperSupport,
  renderCellEntryWrapper,
  runtimeContractEmittableCellEntryKinds,
} from "./entry";
import { scanCellArtifactSource } from "./source-guard";

const BINDING = "__forguncyCellEntry";

describe("entry wrapper support table", () => {
  // A new entry shape in the runtime contract must force an edit here rather than
  // defaulting to "not emitted because nobody thought about it".
  it("covers every entry shape the runtime contract records, exactly once", () => {
    const supported = CELL_ENTRY_WRAPPER_SUPPORT.map(support => support.kind);
    const recorded = CELL_ENTRY_SHAPES.map(shape => shape.id);

    expect([...supported].sort()).toEqual([...recorded].sort());
    expect(new Set(supported).size).toBe(supported.length);
  });

  it("has exactly one default, and it is expressible", () => {
    const defaults = CELL_ENTRY_WRAPPER_SUPPORT.filter(support => support.isDefault);
    expect(defaults.map(support => support.kind)).toEqual([CELL_ARTIFACT_DEFAULT_ENTRY_KIND]);
    expect(findCellEntryWrapperSupport(CELL_ARTIFACT_DEFAULT_ENTRY_KIND).expressible).toBe(true);
    expect(CELL_ARTIFACT_DEFAULT_ENTRY_KIND).toBe("app-function-declaration");
  });

  it("gives every row a reason, so an omission is a decision and not a gap", () => {
    for (const support of CELL_ENTRY_WRAPPER_SUPPORT) {
      expect(support.note.trim().length, support.kind).toBeGreaterThan(20);
      if (support.expressible) {
        expect(support.template, support.kind).toBeDefined();
        expect(support.template, support.kind).toContain(CELL_ENTRY_COMPONENT_PLACEHOLDER);
      } else {
        expect(support.template, support.kind).toBeUndefined();
      }
    }
  });

  // The asymmetry is the point: this contract may emit a subset of what the
  // runtime accepts, and never anything the runtime records as non-rendering.
  it("only emits shapes the runtime contract says both validate and render", () => {
    const runtimeEmittable = runtimeContractEmittableCellEntryKinds();
    for (const kind of expressibleCellEntryKinds()) {
      expect(runtimeEmittable, kind).toContain(kind);
    }

    // The shapes that validate and then fail are excluded either way.
    expect(expressibleCellEntryKinds()).not.toContain("app-async-function-declaration");
    expect(expressibleCellEntryKinds()).not.toContain("no-entry");
  });

  it("separates an accepted shape it cannot emit from one that breaks the target", () => {
    const accepted = acceptedButNotEmittableCellEntryKinds();
    expect(accepted).toContain("whole-source-expression");

    // Not the same failure: this one renders, it just cannot share a source with
    // a bundled body.
    expect(findCellEntryShape("whole-source-expression").renderedAtRuntime).toBe(true);
    expect(findCellEntryShape("app-async-function-declaration").renderedAtRuntime).toBe(false);
    expect(findCellEntryShape("no-entry").renderedAtRuntime).toBe(false);
  });

  it("rejects an unknown entry shape instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellEntryWrapperSupport("not-a-shape")).toThrow(/Unknown ReactCellType entry shape/);
  });
});

describe("rendered entry wrapper", () => {
  it("emits a function App binding by default", () => {
    const rendered = renderCellEntryWrapper({ componentBinding: BINDING });
    expect(rendered.status).toBe("emitted");
    if (rendered.status !== "emitted") return;

    expect(rendered.kind).toBe("app-function-declaration");
    expect(rendered.source).toBe(
      `function App(props) {\n  return React.createElement(${BINDING}, props);\n}`,
    );
  });

  // The whole reason this module exists: a wrapper that carries a construct the
  // platform refuses would be rejected at write time, and one that declares no
  // entry would be accepted and render nothing.
  it("emits a wrapper the source guard accepts, for every expressible shape", () => {
    for (const kind of expressibleCellEntryKinds()) {
      const rendered = renderCellEntryWrapper({ componentBinding: BINDING, entryKind: kind });
      expect(rendered.status, kind).toBe("emitted");
      if (rendered.status !== "emitted") continue;

      expect(scanCellArtifactSource(rendered.source), kind).toEqual([]);

      // The platform resolves an entry from a `render(value)` call, an `App`
      // binding, or a top-level element binding, in that order — so the emitted
      // source has to start with one of those at top level, never nested.
      const [firstLine = ""] = rendered.source.split("\n");
      expect(
        /^(function App|var App|const App|class App|const element|render\()/.test(firstLine),
        `${kind}: ${firstLine}`,
      ).toBe(true);

      expect(rendered.source).not.toContain(CELL_ENTRY_COMPONENT_PLACEHOLDER);
    }
  });

  it("uses only names the runtime contract verified inside cell source", () => {
    expect(cellEntryWrapperNamesAreVerified()).toBe(true);
    // An invented global is exactly the mistake the guard has to catch, so the
    // check has to be able to fail as well as pass.
    expect(cellEntryWrapperNamesAreVerified(["React", "ReactDOMServer"])).toBe(false);
    expect(cellEntryWrapperNamesAreVerified(["props", "useState"])).toBe(true);
  });

  // The guard above is only meaningful if the declaration it reads is honest, so
  // the declared names are checked against the template text they describe. A
  // declaration is what makes the union derivable; this is what stops it drifting
  // away from the code.
  it("declares exactly the verified names its templates actually reference", () => {
    for (const support of CELL_ENTRY_WRAPPER_SUPPORT) {
      const declared = cellEntryWrapperHostNames(support.kind);

      if (!support.expressible) {
        expect(declared, support.kind).toEqual([]);
        continue;
      }

      expect(declared.length, support.kind).toBeGreaterThan(0);
      for (const name of declared) {
        expect(support.template, `${support.kind} must reference ${name}`).toContain(name);
      }

      // The union is derived from these per-kind declarations, so it must equal
      // the set of everything declared.
      expect(CELL_ENTRY_WRAPPER_HOST_NAMES).toEqual(expect.arrayContaining([...declared]));
    }

    // `render` is the one name only a single shape needs, which is what makes it
    // worth checking that the union is a real union rather than one row's list.
    expect(cellEntryWrapperHostNames("render-call")).toContain("render");
    expect(cellEntryWrapperHostNames("app-function-declaration")).not.toContain("render");
  });

  it("honours an explicitly requested shape", () => {
    const rendered = renderCellEntryWrapper({ componentBinding: BINDING, entryKind: "render-call" });
    expect(rendered.status).toBe("emitted");
    if (rendered.status !== "emitted") return;
    expect(rendered.kind).toBe("render-call");
    expect(rendered.source).toBe(`render(React.createElement(${BINDING}, props));`);
  });

  it("refuses a shape it cannot emit instead of silently substituting one", () => {
    for (const kind of ["app-async-function-declaration", "no-entry", "whole-source-expression"] as const) {
      const rendered = renderCellEntryWrapper({ componentBinding: BINDING, entryKind: kind });
      expect(rendered.status, kind).toBe("unsupported");
      if (rendered.status !== "unsupported") continue;
      expect(rendered.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["rejected-cell-entry-shape"]);
    }
  });

  it("refuses a binding the wrapper cannot reference", () => {
    for (const binding of ["", "has space", "1leading-digit", "has-dash", "a.b"]) {
      const rendered = renderCellEntryWrapper({ componentBinding: binding });
      expect(rendered.status, binding).toBe("unsupported");
    }
    // `$` and `_` are legal identifier characters, so they must still be accepted.
    expect(renderCellEntryWrapper({ componentBinding: "$_ok" }).status).toBe("emitted");
  });
});
