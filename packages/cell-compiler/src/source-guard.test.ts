import { describe, expect, it } from "vitest";

import { CELL_SOURCE_VALIDATION_MECHANISM, findCellSourceRejection } from "@forguncy-react-workspace/core";

import {
  blankNonSyntaxText,
  CELL_SOURCE_SCAN_RULES,
  CELL_SOURCE_SCAN_SKIPPED,
  findDynamicImportCall,
  refusedCalleeNames,
  scanCellArtifactSource,
} from "./source-guard";

function findingsFor(source: string): readonly string[] {
  return scanCellArtifactSource(source).map(finding => finding.id);
}

// The target decides on parsed syntax nodes with comments and tokens skipped, so
// text that merely contains the same characters is not refused. Every case in
// this block is a construct the platform accepts, and a scan that reports one is
// refusing correct output.
describe("false positives the raw-text scan used to produce", () => {
  it("ignores a refused name inside a string literal", () => {
    expect(findingsFor('const s = "useFormStatus(";')).toEqual([]);
    expect(findingsFor("const s = 'useActionState(';")).toEqual([]);
    expect(findingsFor('const s = "React.use(promise)";')).toEqual([]);
    expect(findingsFor('const s = "useOptimistic(";')).toEqual([]);
  });

  it("ignores a declaration inside a comment", () => {
    expect(
      findingsFor(["/*", 'import x from "pkg"', "export default function App() {}", "*/"].join("\n")),
    ).toEqual([]);
    expect(findingsFor('// import y from "pkg"\nconst a = 1;')).toEqual([]);
    expect(findingsFor("/* useFormStatus( */\nconst a = 1;")).toEqual([]);
  });

  it("ignores a refused name inside a template literal", () => {
    expect(findingsFor("const s = `useFormStatus(`;")).toEqual([]);
    expect(findingsFor("const s = `\nimport x from \"pkg\"\n`;")).toEqual([]);
  });

  it("ignores a dynamic import inside a string", () => {
    expect(findDynamicImportCall('const s = "import(\\"./heavy.js\\")";')).toBeUndefined();
    expect(findDynamicImportCall("// import('./x.js')")).toBeUndefined();
  });

  // The lookbehind matters: the target refuses a *bare* identifier and refuses
  // members only on React/ReactDOM, so a member call on anything else is legal.
  it("ignores a refused name used as someone else's member", () => {
    expect(findingsFor("obj.useFormStatus();")).toEqual([]);
    expect(findingsFor("foo.useActionState();")).toEqual([]);
    // A spaced dot is still a member access, which a single-character lookbehind
    // would have missed.
    expect(findingsFor("foo . useFormStatus();")).toEqual([]);
    // A `React` that is itself somebody's member is not the object the target
    // refuses either.
    expect(findingsFor("foo.React.use(promise);")).toEqual([]);
    expect(findingsFor("ReactDOM.use(promise);")).toEqual([]);
    expect(findingsFor('React["use"](promise);')).toEqual([]);
  });

  it("does not report a specifier that only appears in a comment", () => {
    expect(findingsFor('// import x from "pkg"\nconst a = 1;')).toEqual([]);
    expect(findingsFor('/*\nimport x from "pkg"\n*/\nconst a = 1;')).toEqual([]);
  });

  // Indentation is `[ \t]`, never `\s`: `\s` matches a newline, so `^\s*export`
  // would start matching on the blanked line above and report a real declaration
  // at a comment's line — or, with a comment in between, at the wrong line.
  it("reports a declaration at its own line, even directly after a comment", () => {
    const findings = scanCellArtifactSource('// import x from "pkg"\nexport {}');
    expect(findings.map(finding => finding.id)).toEqual(["export-declaration"]);
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.match).toBe("export {}");
  });
});

// The other half of the same contract: the constructs the target really does
// refuse must still be found, including the ones a previous version missed.
describe("constructs the target refuses are still found", () => {
  it("finds a real import declaration and reads its specifier", () => {
    const findings = scanCellArtifactSource('import x from "es-toolkit";');
    expect(findings.map(finding => finding.id)).toEqual(["import-declaration"]);
    expect(findings[0]?.specifier).toBe("es-toolkit");
    expect(findings[0]?.line).toBe(1);
  });

  it("finds a side-effect import and a brace import", () => {
    expect(scanCellArtifactSource('import "antd/reset.css";')[0]?.specifier).toBe("antd/reset.css");
    expect(scanCellArtifactSource('import { a } from "pkg";')[0]?.specifier).toBe("pkg");
    expect(scanCellArtifactSource('import * as ns from "pkg";')[0]?.specifier).toBe("pkg");
  });

  it("finds an export declaration", () => {
    expect(findingsFor("export default function App() {}")).toEqual(["export-declaration"]);
    expect(findingsFor("export const a = 1;")).toEqual(["export-declaration"]);
    expect(findingsFor("export { a };")).toEqual(["export-declaration"]);
  });

  it("finds the bare refused hooks", () => {
    expect(findingsFor("useFormStatus();")).toEqual(["use-form-status"]);
    expect(findingsFor("const [a] = useActionState(fn, 0);")).toEqual(["use-action-state"]);
    expect(findingsFor("useOptimistic(state);")).toEqual(["use-optimistic"]);
  });

  // The member forms are reported under the name's own code, because that is the
  // message the target throws for them: `React.useOptimistic()` is refused with
  // the `useOptimistic` message, and only `React.use` has a message of its own.
  it("finds the member forms the target also refuses, under the target's own code", () => {
    expect(findingsFor("React.useFormStatus();")).toEqual(["use-form-status"]);
    expect(findingsFor("React.use(promise);")).toEqual(["react-use"]);
    expect(findingsFor("ReactDOM.useActionState(fn, 0);")).toEqual(["use-action-state"]);
    expect(findingsFor("React . useOptimistic (state);")).toEqual(["use-optimistic"]);
    expect(findingsFor("React.useActionState(fn, 0);")).toEqual(["use-action-state"]);
  });

  it("finds a dynamic import call, which the platform validator does not", () => {
    const finding = findDynamicImportCall('var later = () => import("./heavy.js");');
    expect(finding).toBeDefined();
    expect(finding?.occurrences).toBe(1);
    expect(finding?.line).toBe(1);
  });

  it("counts repeated occurrences rather than reporting each one", () => {
    const findings = scanCellArtifactSource("useFormStatus();\nuseFormStatus();\nuseFormStatus();");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences).toBe(3);
  });

  it("reports the line and the platform's own wording", () => {
    const finding = scanCellArtifactSource('const a = 1;\nconst b = 2;\nuseFormStatus();').find(
      candidate => candidate.id === "use-form-status",
    );
    expect(finding?.line).toBe(3);
    expect(finding?.platformMessage).toBe(findCellSourceRejection("use-form-status").message);
    expect(finding?.platformMessage).toContain("useFormStatus is not supported");
  });
});

// The blanker is what makes the two blocks above true, so it is tested directly
// rather than only through the rules it enables.
describe("blanking preserves position and reports nothing of its own", () => {
  it("keeps the source length and every newline", () => {
    const source = [
      'import x from "pkg";',
      "// a comment",
      "const regex = /'/;",
      "/* multi",
      "   line */",
      "const s = 'text';",
      "const t = `template",
      "still template`;",
    ].join("\n");

    const blanked = blankNonSyntaxText(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);

    // Offsets of the surviving syntax are unchanged, which the scan depends on.
    expect(blanked.indexOf("const regex")).toBe(source.indexOf("const regex"));
    expect(blanked.indexOf("const s =")).toBe(source.indexOf("const s ="));
    expect(blanked.indexOf("const t =")).toBe(source.indexOf("const t ="));
  });

  it("removes comment text but keeps the code around it", () => {
    const blanked = blankNonSyntaxText("const a = 1; /* import x from \"pkg\" */ const b = 2;");
    expect(blanked).not.toContain("import");
    expect(blanked).toContain("const a = 1;");
    expect(blanked).toContain("const b = 2;");
  });

  // JavaScript forbids a raw newline inside a ' or " literal, so a quote the
  // lexer misreads as a literal opener cannot hide more than its own line. That
  // bound is what keeps a regular expression such as /'/ from swallowing the
  // artifact. Templates may span lines, so they are not bounded this way.
  it("contains a misread quote to its own line", () => {
    const blanked = blankNonSyntaxText("const re = /'/;\nconst kept = useFormStatus();");
    expect(blanked).toContain("const re");
    expect(blanked.split("\n")[1]).toBe("const kept = useFormStatus();");
  });

  it("treats an unterminated block comment as running to the end", () => {
    expect(blankNonSyntaxText("const a = 1;\n/* never closed").trimEnd()).toBe("const a = 1;");
  });

  it("leaves source with nothing to blank untouched", () => {
    const source = "function App(props) {\n  return React.createElement(Entry, props);\n}";
    expect(blankNonSyntaxText(source)).toBe(source);
  });
});

// The guard is a reproduction of a recorded mechanism, so the two can be checked
// against each other instead of drifting apart one edit at a time.
describe("faithfulness to the recorded mechanism", () => {
  it("has a rule for every callee the target refuses", () => {
    const patterns = CELL_SOURCE_SCAN_RULES.map(rule => rule.pattern).join("\n");
    for (const name of refusedCalleeNames()) {
      expect(patterns, name).toContain(name);
    }
  });

  it("models the member objects the mechanism names, and no others", () => {
    const patterns = CELL_SOURCE_SCAN_RULES.map(rule => rule.pattern).join("\n");
    for (const object of CELL_SOURCE_VALIDATION_MECHANISM.refusedMemberCalleeObjects) {
      expect(patterns, object).toContain(object);
    }
    // `ReactDOM.use` is absent from the mechanism's message table, so no rule may
    // refuse it — asserted as a false positive above, pinned here as a rule.
    expect(findingsFor("ReactDOM.use(promise);")).toEqual([]);
    // And one construct is one finding, never two: the bare and member forms share
    // a rule, so they cannot both fire.
    expect(findingsFor("React . useOptimistic (state);")).toHaveLength(1);
  });

  it("skips exactly the constructs a lexer cannot decide, and says why", () => {
    const skipped = CELL_SOURCE_SCAN_SKIPPED.map(omission => omission.id);
    expect(skipped).toEqual([
      "typescript-annotation",
      "top-level-await",
      "top-level-return",
      "duplicate-top-level-declaration",
      "runtime-import-call-not-rejected",
    ]);
    for (const omission of CELL_SOURCE_SCAN_SKIPPED) {
      expect(omission.whyNotLexical.trim().length, omission.id).toBeGreaterThan(20);
    }
  });

  it("every rule names a rejection the contract records, and says why it is faithful", () => {
    for (const rule of CELL_SOURCE_SCAN_RULES) {
      expect(findCellSourceRejection(rule.id)).toBeDefined();
      expect(rule.whyFaithfulToTarget.trim().length, rule.id).toBeGreaterThan(20);
      // Never compiled without the anchors that keep it off raw text.
      expect(() => new RegExp(rule.pattern, "gm")).not.toThrow();
    }
  });
});
