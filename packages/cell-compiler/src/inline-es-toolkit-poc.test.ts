/**
 * The `inline` dependency PoC: `examples/inline-es-toolkit` compiled for real.
 *
 * Decision source: GitHub Issue #10 — "Implement: `inline` dependency PoC with
 * es-toolkit" (https://github.com/Mang-X/forguncy-react-workspace/issues/10).
 *
 * #10 asks a question the existing extension PoC does not: can a normal npm
 * dependency be flattened straight into one Cell artifact by the workspace
 * compiler, with no Forguncy Frontend Extension involved? So the example is
 * compiled here rather than described — ordinary ESM imports in
 * `examples/inline-es-toolkit/src/App.tsx`, one `inline` decision, and the
 * artifact evaluated in a sandbox against a stub page React. The example's own
 * deterministic self-check (es-toolkit's `chunk` and `groupBy`) is what makes
 * "the generated code runs the selected functions correctly" an assertion
 * instead of a claim: if tree-shaking or interop dropped either function, the
 * rendered report would say `fail`.
 *
 * What is deliberately *not* claimed: AGENTS.md rule 7 forbids presenting any
 * of this as Forguncy runtime compatibility. These tests prove compilation,
 * assembly and sandboxed evaluation; the real ReactCellType execution is
 * performed against a real project and recorded on #10 itself, not asserted
 * here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "..", "..", "examples", "inline-es-toolkit");
const entry = "src/App.tsx";

const DECISIONS: readonly DependencyDecision[] = [{ strategy: "inline", packageName: "es-toolkit" }];

const EXPECTED_REPORT = "chunk=pass | groupByKeys=pass | groupBySizes=pass";

function compileExample(): Promise<CompileCellOutcome> {
  return compileCell({ entry, dependencies: DECISIONS }, { bundler: createRolldownCellBundler({ dir: exampleRoot }) });
}

function compiledCodeOf(outcome: Extract<CompileCellOutcome, { readonly status: "compiled" }>): string {
  return outcome.artifact.code;
}

// ---------------------------------------------------------------------------
// Sandbox evaluation
// ---------------------------------------------------------------------------

interface CellElement {
  readonly type: unknown;
  readonly props: { readonly children?: unknown };
}

type CellComponent = () => CellElement;

/**
 * The page's React, reduced to what the example touches.
 *
 * A stub rather than the installed `react`: the artifact under test must read
 * the *page* object through the generated JSX runtime adapter — that is what
 * the host bridge exists for — and a stub makes that observable. An artifact
 * that bundled its own React would ignore this object entirely.
 */
function reactStub(): Record<string, unknown> {
  return {
    version: "19.2.7",
    Fragment: Symbol.for("react.fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
  };
}

/**
 * Evaluates an artifact in an isolated `vm` context seeded with `globals`.
 *
 * `node:vm` rather than the test process so the stubbed page globals are the
 * only ones the artifact can see. `globalThis` is aliased onto the sandbox
 * before the context is created because the generated host modules read their
 * page objects through `globalThis`.
 */
function runArtifact(code: string, globals: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { ...globals };
  sandbox.globalThis = sandbox;
  new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
  return sandbox;
}

function componentFrom(sandbox: Readonly<Record<string, unknown>>): CellComponent {
  const component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
  if (typeof component !== "function") {
    throw new Error(`The artifact did not bind a function to ${CELL_ENTRY_COMPONENT_BINDING}.`);
  }
  return component as CellComponent;
}

/** Every text node in an element tree, in render order. */
function flattenText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) flattenText(item, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    flattenText((node as CellElement).props.children, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inline es-toolkit PoC (#10)", () => {
  it("authors ordinary ESM imports from es-toolkit, with no extension global in sight", () => {
    const source = readFileSync(join(exampleRoot, entry), "utf8");

    // #10's source-shape requirement: ordinary imports only. The companion
    // assertion is the negative half — an `ESToolkit` global reference would be
    // the extension strategy wearing the PoC's clothes.
    expect(source).toContain('import { chunk, groupBy } from "es-toolkit"');
    expect(source).not.toContain("ESToolkit");
    expect(source).not.toContain("frontendLibraries");
  });

  it("flattens es-toolkit into one self-contained artifact with no extension metadata", async () => {
    const outcome = await compileExample();

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    const code = compiledCodeOf(outcome);

    // No es-toolkit Forguncy Extension may be referenced: the `inline`
    // strategy contributes nothing to `frontendLibraries`.
    expect(outcome.artifact.frontendLibraries).toEqual([]);

    // No unresolved import and no runtime chunk may remain. Assembly already
    // refuses both (an external import is a rejection, the source guard parses
    // for `import(...)`), so these assertions state #10's acceptance criteria
    // against the finished string rather than relying on the audits alone.
    expect(code).not.toContain("import(");
    expect(code).not.toMatch(/\bfrom\s*["']es-toolkit["']/);
    expect(code).not.toContain('require("es-toolkit")');
    // The entry wrapper #5/#6 prescribe, binding the single IIFE export.
    expect(code).toContain(`function App(props)`);
    expect(code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);
    // The compiled functions themselves are present in the artifact body.
    expect(code).toContain("inline es-toolkit PoC");
    expect(code).toContain("groupBySizes");

    // #10's "Bundle size is reported" criterion. Logged rather than pinned:
    // #21 owns the cell code budget, so a ceiling invented here would be
    // policy this PoC has no mandate to set.
    const bytes = Buffer.byteLength(code, "utf8");
    console.info(`#10 inline es-toolkit artifact: ${code.length} characters, ${bytes} bytes`);
  });

  it("runs the selected es-toolkit functions correctly inside the generated cell", async () => {
    const outcome = await compileExample();

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;

    const sandbox = runArtifact(compiledCodeOf(outcome), { React: reactStub() });
    const element = componentFrom(sandbox)();
    expect(element.type).toBe("section");

    // The example's own deterministic self-check is the oracle: `chunk` and
    // `groupBy` were bundled, tree-shaken and evaluated, and each rendered
    // verdict is computed from fixed inputs with no I/O.
    const text = flattenText(element).join(" ");
    expect(text).toContain(EXPECTED_REPORT);
    expect(text).toContain("inline es-toolkit PoC");
    expect(text).not.toContain("fail");
  });

  it("produces byte-identical artifacts for identical inputs", async () => {
    const original = await compileExample();
    const rerun = await compileExample();

    expect(original.status).toBe("compiled");
    expect(rerun.status).toBe("compiled");
    if (original.status !== "compiled" || rerun.status !== "compiled") return;
    expect(rerun.artifact.code).toBe(original.artifact.code);
    expect(rerun.artifact.frontendLibraries).toEqual(original.artifact.frontendLibraries);
  });
});
