import { describe, expect, it } from "vitest";

import { CELL_SOURCE_VALIDATION_MECHANISM, findCellSourceRejection } from "@forguncy-react-workspace/core";

import {
  auditCellSource,
  CELL_SOURCE_SCAN_SKIPPED,
  findDynamicImportCall,
  refusedCalleeNames,
  rejectionForRefusedCalleeName,
  scanCellArtifactSource,
} from "./source-guard";
import type { CellSourceCallFinding } from "./source-guard";

/**
 * The rejections a source draws.
 *
 * Asserts the source parsed first: a source that does not parse yields no
 * findings, so without this every "nothing is reported" expectation below could
 * pass because the input was invalid rather than because the construct is legal.
 */
function findingsFor(source: string): readonly string[] {
  const audit = auditCellSource(source);
  expect(audit.parsed, `source must parse: ${source}`).toBe(true);
  return audit.findings.map(finding => finding.id);
}

/** The first dynamic import in a source, with the same parse guard. */
function dynamicImportOf(source: string): CellSourceCallFinding | undefined {
  expect(auditCellSource(source).parsed, `source must parse: ${source}`).toBe(true);
  return findDynamicImportCall(source);
}

// The target decides on parsed syntax nodes with comments and tokens skipped, so
// text that merely contains the same characters is not refused. Every case in this
// block is a construct the platform accepts, and a guard that reports one is
// refusing correct output.
describe("text that is not a construct", () => {
  it("ignores a refused name inside a string literal", () => {
    expect(findingsFor('const s = "useFormStatus(";')).toEqual([]);
    expect(findingsFor("const s = 'useActionState(';")).toEqual([]);
    expect(findingsFor('const s = "React.use(promise)";')).toEqual([]);
    expect(findingsFor('const s = "useOptimistic(";')).toEqual([]);
  });

  it("ignores a declaration inside a comment", () => {
    expect(findingsFor(["/*", 'import x from "pkg"', "export default function App() {}", "*/"].join("\n"))).toEqual(
      [],
    );
    expect(findingsFor('// import y from "pkg"\nconst a = 1;')).toEqual([]);
    expect(findingsFor("/* useFormStatus( */\nconst a = 1;")).toEqual([]);
  });

  it("ignores a refused name inside a template literal", () => {
    expect(findingsFor("const s = `useFormStatus(`;")).toEqual([]);
    expect(findingsFor("const s = `\nimport x from \"pkg\"\n`;")).toEqual([]);
  });

  // A template's `${…}` is real syntax the target's AST visits, so its contents
  // are scanned — including for the chunk rule, which has no platform backstop.
  it("scans template interpolations as code rather than blanking them", () => {
    expect(findingsFor("const s = `${useFormStatus()}`;")).toEqual(["use-form-status"]);
    expect(findingsFor("const s = `a${ `b${useFormStatus()}` }`;")).toEqual(["use-form-status"]);
    expect(findingsFor("const s = `${React.useOptimistic(state)}`;")).toEqual(["use-optimistic"]);

    expect(dynamicImportOf('const value = `${import("./heavy.js")}`;')?.occurrences).toBe(1);
  });

  it("keeps a literal inside an interpolation inert", () => {
    expect(findingsFor('const s = `${"useFormStatus("}`;')).toEqual([]);
    expect(dynamicImportOf('const s = `${"import(\\"./x.js\\")"}`;')).toBeUndefined();
  });

  it("ignores a `new` expression, which the target never sees", () => {
    expect(findingsFor("new useFormStatus();")).toEqual([]);
    expect(findingsFor("new React.useFormStatus();")).toEqual([]);
    expect(findingsFor("const x = new  useOptimistic(a, b);")).toEqual([]);
    // An identifier that merely contains `new` is not the keyword: the call inside
    // it is still refused.
    expect(findingsFor("renew(useFormStatus());")).toEqual(["use-form-status"]);
    expect(findingsFor("const renewal = useFormStatus();")).toEqual(["use-form-status"]);
  });

  it("ignores reserved words used as property names", () => {
    expect(findingsFor("const o = { import: 1 };")).toEqual([]);
    expect(findingsFor("const o = { export: 1 };")).toEqual([]);
    expect(findingsFor("obj.import = 1;")).toEqual([]);
    expect(findingsFor("module.exports = App;")).toEqual([]);
    expect(dynamicImportOf('obj.import("./x.js");')).toBeUndefined();
    expect(dynamicImportOf('module.import("./x.js");')).toBeUndefined();
  });
});

// A `/` is a division or the start of a literal depending on grammar, not on the
// character before it. Getting that wrong errs in both directions, and it matters
// most for the chunk rule — the one check the platform does not back up. The
// hand-written lexer needed four rounds of patches here; these are the cases that
// broke it, kept as regression tests now that the parse decides.
describe("regular expressions and division", () => {
  it("does not let a quote inside a regex hide a real call", () => {
    expect(dynamicImportOf("const re = /'/; import(\"./heavy.js\");")?.occurrences).toBe(1);
    expect(findingsFor("const re = /'/; useFormStatus();")).toEqual(["use-form-status"]);
  });

  it("does not read a regex whose text looks like a call as a call", () => {
    expect(dynamicImportOf("const re = /import()/;")).toBeUndefined();
    expect(findingsFor("const re = /useFormStatus(/;")).toEqual([]);
    expect(findingsFor('const re = /import{x}from"y"/;')).toEqual([]);
    expect(findingsFor("const re = /[useFormStatus(/]/;")).toEqual([]);
  });

  // The case that ended the lexer: `++` is read as an operator, so the `/` after
  // it was treated as a literal opener and swallowed the dynamic import behind it.
  it("keeps a division after a postfix operator a division", () => {
    expect(dynamicImportOf('n++ / 2; import("./heavy.js");')?.occurrences).toBe(1);
    expect(findingsFor("n++ / 2; useFormStatus();")).toEqual(["use-form-status"]);
    expect(dynamicImportOf('n-- / 2; import("./heavy.js");')?.occurrences).toBe(1);
  });

  it("keeps a division after a value a division, whatever the value is", () => {
    expect(dynamicImportOf('"x" / 2; import("./heavy.js");')?.occurrences).toBe(1);
    expect(dynamicImportOf("`x` / 2; import('./heavy.js');")?.occurrences).toBe(1);
    expect(dynamicImportOf('ratio() / 2; import("./heavy.js");')?.occurrences).toBe(1);
    expect(dynamicImportOf('total / 2; import("./heavy.js");')?.occurrences).toBe(1);
    expect(dynamicImportOf('list[0] / 2; import("./heavy.js");')?.occurrences).toBe(1);
    expect(findingsFor("total / 2; useOptimistic(a);")).toEqual(["use-optimistic"]);
  });

  // Previously a characterisation test asserting a known wrong answer. With a
  // parser it is simply correct, so it is asserted as the expected behaviour.
  it("reads a literal after a block as a literal", () => {
    expect(dynamicImportOf("if (x) {} /import()/;")).toBeUndefined();
    expect(findingsFor("function f() {} /useFormStatus(/;")).toEqual([]);
  });

  it("reads a keyword-position literal as a literal", () => {
    expect(dynamicImportOf("function f() { return /import()/; }")).toBeUndefined();
    expect(findingsFor("function f() { return /useFormStatus(/; }")).toEqual([]);
    expect(dynamicImportOf("const x = typeof /import()/;")).toBeUndefined();
  });

  it("handles an escaped slash and a character class", () => {
    expect(dynamicImportOf("const re = /x\\/y/; import('./x.js');")?.occurrences).toBe(1);
    expect(dynamicImportOf("const re = /[/]/; import('./x.js');")?.occurrences).toBe(1);
  });
});

// The other half of the same contract: the constructs the target really does
// refuse must be found, including the minified module syntax that a rule keyed on
// line shape used to miss.
describe("constructs the target refuses are found", () => {
  it("finds a real import declaration and reads its specifier from the node", () => {
    const findings = scanCellArtifactSource('import x from "es-toolkit";');
    expect(findings.map(finding => finding.id)).toEqual(["import-declaration"]);
    expect(findings[0]?.specifier).toBe("es-toolkit");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.match).toBe('import x from "es-toolkit";');
  });

  it("finds a side-effect import and a brace import", () => {
    expect(scanCellArtifactSource('import "antd/reset.css";')[0]?.specifier).toBe("antd/reset.css");
    expect(scanCellArtifactSource('import { a } from "pkg";')[0]?.specifier).toBe("pkg");
    expect(scanCellArtifactSource('import * as ns from "pkg";')[0]?.specifier).toBe("pkg");
  });

  it("finds the minified module syntax a line-shaped rule would miss", () => {
    expect(scanCellArtifactSource('import{x}from"x";')[0]?.specifier).toBe("x");
    expect(scanCellArtifactSource('import"x";')[0]?.specifier).toBe("x");
    expect(scanCellArtifactSource('import*as n from"x";')[0]?.specifier).toBe("x");

    const sameLine = scanCellArtifactSource("const x=1;export{x};");
    expect(sameLine.map(finding => finding.id)).toEqual(["export-declaration"]);
    expect(sameLine[0]?.index).toBe(10);
  });

  it("finds an export declaration in every form", () => {
    expect(findingsFor("export default function App() {}")).toEqual(["export-declaration"]);
    expect(findingsFor("export const a = 1;")).toEqual(["export-declaration"]);
    // Declared first, because `export { a }` with no binding is a syntax error
    // rather than an export the target would see.
    expect(findingsFor("const a = 1; export { a };")).toEqual(["export-declaration"]);
    expect(findingsFor('export * from "pkg";')).toEqual(["export-declaration"]);
    expect(findingsFor("export default class App {}")).toEqual(["export-declaration"]);
    expect(findingsFor("export function App() {}")).toEqual(["export-declaration"]);
  });

  it("finds the bare refused hooks", () => {
    expect(findingsFor("useFormStatus();")).toEqual(["use-form-status"]);
    expect(findingsFor("const [a] = useActionState(fn, 0);")).toEqual(["use-action-state"]);
    expect(findingsFor("useOptimistic(state);")).toEqual(["use-optimistic"]);
  });

  it("finds the member forms the target also refuses, under the target's own code", () => {
    expect(findingsFor("React.useFormStatus();")).toEqual(["use-form-status"]);
    expect(findingsFor("React.use(promise);")).toEqual(["react-use"]);
    expect(findingsFor("ReactDOM.useActionState(fn, 0);")).toEqual(["use-action-state"]);
    expect(findingsFor("React . useOptimistic (state);")).toEqual(["use-optimistic"]);
  });

  it("does not report a member the target does not refuse", () => {
    expect(findingsFor("obj.useFormStatus();")).toEqual([]);
    expect(findingsFor("foo . useActionState();")).toEqual([]);
    expect(findingsFor("ReactDOM.use(promise);")).toEqual([]);
    expect(findingsFor('React["use"](promise);')).toEqual([]);
  });

  it("finds a dynamic import call, which the platform validator does not", () => {
    const finding = dynamicImportOf('var later = () => import("./heavy.js");');
    expect(finding).toBeDefined();
    expect(finding?.occurrences).toBe(1);
    expect(finding?.line).toBe(1);
    expect(finding?.match).toBe('import("./heavy.js")');
  });

  it("treats a parenthesised import argument as a dynamic import, not a declaration", () => {
    expect(findingsFor("import (x);")).toEqual([]);
    expect(dynamicImportOf("import (x);")?.occurrences).toBe(1);
    expect(dynamicImportOf("import.meta.url;")).toBeUndefined();
  });

  it("counts repeated occurrences rather than reporting each one", () => {
    const findings = scanCellArtifactSource("useFormStatus();\nuseFormStatus();\nuseFormStatus();");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences).toBe(3);
  });

  it("reports one finding per rejection, in first-seen order", () => {
    const findings = scanCellArtifactSource('import a from "x";\nuseFormStatus();\nexport {};');
    expect(findings.map(finding => finding.id)).toEqual([
      "import-declaration",
      "use-form-status",
      "export-declaration",
    ]);
  });

  it("reports the line and the platform's own wording", () => {
    const finding = scanCellArtifactSource("const a = 1;\nconst b = 2;\nuseFormStatus();").find(
      candidate => candidate.id === "use-form-status",
    );
    expect(finding?.line).toBe(3);
    expect(finding?.platformMessage).toBe(findCellSourceRejection("use-form-status").message);
    expect(finding?.platformMessage).toContain("useFormStatus is not supported");
  });

  // Indentation is not part of the rule, so a declaration after a comment belongs
  // to its own line — a hand-written pattern once reported it at the comment.
  it("reports a declaration at its own line, even directly after a comment", () => {
    const findings = scanCellArtifactSource('// import x from "pkg"\nexport {}');
    expect(findings.map(finding => finding.id)).toEqual(["export-declaration"]);
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.match).toBe("export {}");
  });
});

// Unparseable source is not this module's verdict to give, and it says so rather
// than reporting a guess.
describe("a source that does not parse", () => {
  it("yields no findings and reports that it did not parse", () => {
    const audit = auditCellSource("const x: number = 1;");
    expect(audit).toEqual({ findings: [], dynamicImports: [], parsed: false });
    // The raw entry points are silent too — the target's own parse is what refuses
    // this source, and it says so with a code frame.
    expect(findDynamicImportCall("const x: number = 1;")).toBeUndefined();
    expect(scanCellArtifactSource("const x: number = 1;")).toEqual([]);
  });

  it("still parses the JSX the target's react preset accepts", () => {
    const audit = auditCellSource('const element = <div className="x" />;');
    expect(audit.parsed).toBe(true);
    expect(audit.findings).toEqual([]);
  });

  it("audits both checks from one parse", () => {
    const audit = auditCellSource('import a from "x";\nconst later = () => import("./y");');
    expect(audit.parsed).toBe(true);
    expect(audit.findings.map(finding => finding.id)).toEqual(["import-declaration"]);
    expect(audit.dynamicImports).toHaveLength(1);
  });
});

// The guard is a reproduction of a recorded mechanism, so the two can be checked
// against each other instead of drifting apart one edit at a time.
describe("faithfulness to the recorded mechanism", () => {
  it("names the parser the target uses, and the scope it parses in", () => {
    expect(CELL_SOURCE_VALIDATION_MECHANISM.parseCall).toContain("Babel.transform");
    expect(CELL_SOURCE_VALIDATION_MECHANISM.declarationSourceType).toBe("module");
    expect(CELL_SOURCE_VALIDATION_MECHANISM.refusedCalleeNodeType).toBe("CallExpression");
    // The walk consults this list, so the module's own comment about comments can
    // be checked rather than trusted.
    for (const key of ["leadingComments", "trailingComments", "innerComments", "tokens"]) {
      expect(CELL_SOURCE_VALIDATION_MECHANISM.skippedAstKeys).toContain(key);
    }
  });

  it("has a rejection for every callee the target refuses", () => {
    // Every name refused as a *bare* call has a rejection of its own.
    for (const name of CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames) {
      const rejection = rejectionForRefusedCalleeName(name);
      expect(rejection, name).toBeDefined();
      expect(findCellSourceRejection(rejection ?? "react-use")).toBeDefined();
    }
    // The remaining name is member-only, so it is checked by behaviour: `use` on
    // `React` is refused as `react-use`, and there is no bare `use()` rule.
    for (const name of CELL_SOURCE_VALIDATION_MECHANISM.refusedReactOnlyMemberNames) {
      expect(findingsFor(`React.${name}(promise);`), name).toEqual(["react-use"]);
      expect(findingsFor(`${name}(promise);`), name).toEqual([]);
    }
    expect(refusedCalleeNames()).toEqual([
      ...CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames,
      ...CELL_SOURCE_VALIDATION_MECHANISM.refusedReactOnlyMemberNames,
    ]);
  });

  // Per recorded name rather than by example: the mechanism visits `CallExpression`
  // nodes, so a `new` expression must be silent for every name.
  it("refuses a call and never a `new` expression, for every recorded name", () => {
    for (const name of CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames) {
      expect(findingsFor(`${name}();`), name).toHaveLength(1);
      expect(findingsFor(`new ${name}();`), name).toEqual([]);
    }
    for (const object of CELL_SOURCE_VALIDATION_MECHANISM.refusedMemberCalleeObjects) {
      const member = `${object}.useActionState(fn, 0)`;
      expect(findingsFor(member), member).toHaveLength(1);
      expect(findingsFor(`new ${member}`), member).toEqual([]);
    }
  });

  it("does not refuse the forms the mechanism excludes", () => {
    // A computed member is excluded by the target's `callee.computed === true`.
    for (const name of CELL_SOURCE_VALIDATION_MECHANISM.refusedBareCalleeNames) {
      expect(findingsFor(`React["${name}"]();`), name).toEqual([]);
    }
  });

  it("skips exactly the constructs that belong to the target's own parse, and says why", () => {
    const skipped = CELL_SOURCE_SCAN_SKIPPED.map(omission => omission.id);
    expect(skipped).toEqual([
      "typescript-annotation",
      "top-level-return",
      "duplicate-top-level-declaration",
      "top-level-await",
      "runtime-import-call-not-rejected",
    ]);
    for (const omission of CELL_SOURCE_SCAN_SKIPPED) {
      expect(omission.whyNotDecided.trim().length, omission.id).toBeGreaterThan(20);
    }
    // The last one is not a rejection at all, which is why the chunk rule exists.
    expect(findCellSourceRejection("runtime-import-call-not-rejected").rejected).toBe(false);
  });
});
