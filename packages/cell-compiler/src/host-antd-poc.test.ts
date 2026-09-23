/**
 * The `host` dependency PoC: `examples/host-antd` compiled for real.
 *
 * Decision source: GitHub Issue #11 — "Implement: `host` bridge PoC with React +
 * antd" (https://github.com/Mang-X/forguncy-react-workspace/issues/11).
 *
 * #11 asks a question neither the bridge unit tests nor the `inline` PoC ask:
 * can ordinary React/antd imports compile into a Cell artifact that reuses the
 * *exact* host runtime identities instead of bundling duplicate copies? So the
 * example is compiled here rather than described — `import React … from "react"`
 * and `import { Button, Card } from "antd"` in `examples/host-antd/src/App.tsx`,
 * two `host` decisions, and the artifact evaluated against the page globals.
 *
 * Two levels of proof, deliberately:
 *
 * - the artifact-shape test proves no second React/antd implementation exists in
 *   the generated code: no fingerprints, no surviving imports, and `antd` is not
 *   resolvable anywhere in this workspace, so a missed interception would have
 *   failed the compile instead of quietly inlining the library;
 * - the runtime tests execute the artifact against the installed React 19.2.7 —
 *   the version #5 measured on the host — plus a stub `antd` page global. Hooks
 *   and context only dispatch when the renderer and the imported React are the
 *   same object, so a passing render is an identity assertion, not a smoke test,
 *   and the example's own `identity=pass | antd=pass | …` report states the
 *   global comparisons explicitly.
 *
 * What is deliberately *not* claimed: AGENTS.md rule 7 forbids presenting any of
 * this as Forguncy runtime compatibility. These tests prove compilation,
 * assembly and sandboxed evaluation; the real ReactCellType execution is
 * performed against a real project and recorded on #11 itself, not asserted here.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it, vi } from "vitest";

import { compileCell } from "./artifact";
import type { CompileCellOutcome } from "./artifact";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry";
import { createRolldownCellBundler } from "./rolldown-bundler";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "..", "..", "examples", "host-antd");
const entry = "src/App.tsx";

const DECISIONS: readonly DependencyDecision[] = [
  { strategy: "host", packageName: "react", globalName: "React" },
  { strategy: "host", packageName: "antd", globalName: "antd" },
];

const EXPECTED_REPORT = "identity=pass | antd=pass | useState=pass | useContext=pass | keys=pass";

function compileExample(): Promise<CompileCellOutcome> {
  return compileCell({ entry, dependencies: DECISIONS }, { bundler: createRolldownCellBundler({ dir: exampleRoot }) });
}

function compiledCodeOf(outcome: Extract<CompileCellOutcome, { readonly status: "compiled" }>): string {
  return outcome.artifact.code;
}

async function compiledCode(): Promise<string> {
  const outcome = await compileExample();
  expect(outcome.status).toBe("compiled");
  if (outcome.status !== "compiled") throw new Error("unreachable: the compiled branch was taken");
  return compiledCodeOf(outcome);
}

// ---------------------------------------------------------------------------
// The real React the host injects, and the stub antd page global
// ---------------------------------------------------------------------------

/**
 * React 19.2.7, loaded at the *host's* version — test-only, through
 * `createRequire` rather than an `import`, because nothing in `src/` (and no
 * authored import in the example) may depend on React's types or module
 * identity. The artifact under test must reach this object through the
 * generated host bridge: that is the entire claim of #11.
 */
const require = createRequire(import.meta.url);
const hostReact = require("react") as Record<string, unknown> & {
  readonly version: string;
  readonly createElement: (type: unknown, props?: Record<string, unknown>) => unknown;
};
const { renderToString } = require("react-dom/server") as {
  renderToString: (element: unknown) => string;
};

/**
 * The page's `antd`, reduced to the two components the example imports.
 *
 * A stub rather than the installed library: `antd` is deliberately not
 * installed anywhere (host strategy — the page provides it), and a stub makes
 * "the artifact bound the *page* object" observable. An artifact that bundled
 * its own antd would ignore this object, and the example's `antd=pass`
 * self-check would answer `fail`.
 */
function antdStub(): Record<string, unknown> {
  return {
    Button: (props: Record<string, unknown>) =>
      hostReact.createElement("button", {
        type: props.type,
        "data-role": "antd-button",
        children: props.children,
      }),
    Card: (props: Record<string, unknown>) =>
      hostReact.createElement("div", {
        className: "ant-card",
        "data-title": props.title,
        children: props.children,
      }),
  };
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

/**
 * The artifact's top-level `App` — the wrapper ReactCellType itself calls.
 *
 * The entry binding (`CELL_ENTRY_COMPONENT_BINDING`) is the authored component
 * *inside* the IIFE; invoking that directly would run its hooks outside any
 * renderer. The wrapper is what the real cell executes, and only its element
 * may be handed to `renderToString`.
 */
function wrapperFrom(sandbox: Readonly<Record<string, unknown>>): CellComponent {
  const wrapper = sandbox.App;
  if (typeof wrapper !== "function") {
    throw new Error("The artifact did not bind a function to App.");
  }
  return wrapper as CellComponent;
}

interface RenderedExample {
  readonly html: string;
  readonly consoleErrors: readonly string[];
}

/**
 * Compiles the example, evaluates it against the host React and stub antd page
 * globals, and server-renders the entry wrapper.
 *
 * `renderToString` rather than a client root: the renderer and the artifact's
 * imported React are then provably the same installed package — hooks that ran
 * could only have dispatched through *this* React — and the HTML string is a
 * stable oracle for children structure and keyed-list order. `console.error` is
 * captured because React reports a dropped list key there, which is exactly the
 * adapter regression #11's fifth implementation step asks to cover.
 */
async function renderExample(): Promise<RenderedExample> {
  const code = await compiledCode();
  const sandbox = runArtifact(code, { React: hostReact, antd: antdStub() });
  const element = wrapperFrom(sandbox)();

  const consoleErrors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    // `format` rather than `join`: React's key warning splits the offending
    // element and the owning component across `%s` substitution arguments, and
    // a flattened join hides exactly the part that names the list at fault.
    consoleErrors.push(format(...(args as [unknown, ...unknown[]])));
  });
  let html: string;
  try {
    html = renderToString(element);
  } finally {
    spy.mockRestore();
  }
  return { html, consoleErrors };
}

/** Every `<li>` body in render order. */
function listItemTexts(html: string): string[] {
  return [...html.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(match => match[1] ?? "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host React + antd PoC (#11)", () => {
  it("authors ordinary imports from react and antd, with no source rewrite", () => {
    const source = readFileSync(join(exampleRoot, entry), "utf8");

    // #11's source-shape requirement: standard imports, byte-for-byte. The
    // negative half is the rewrite the Issue explicitly forbids — a manual
    // alias to a page global would make the bridge unnecessary and prove
    // nothing.
    expect(source).toContain('import React, { createContext, useContext, useState } from "react"');
    expect(source).toContain('import { Button, Card } from "antd"');
    expect(source).not.toContain("const R = React");
    expect(source).not.toContain("const { Button }");
    expect(source).not.toContain("require(");
    expect(source).not.toContain("frontendLibraries");
    // The only page-global reads allowed are the identity assertions inside
    // `selfCheck`, which *compare* against the global — they are not how the
    // module obtains React or antd.
    expect(source).toContain("globalThis as typeof globalThis");
  });

  it("binds the host identities without bundling a second React or antd", async () => {
    const outcome = await compileExample();

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    const code = compiledCodeOf(outcome);

    // `host` decisions contribute no extension metadata — the page already has
    // these libraries, so there is nothing for ReactCellType to load.
    expect(outcome.artifact.frontendLibraries).toEqual([]);

    // No unresolved import and no runtime chunk may remain. Assembly already
    // refuses both, so these state #11's acceptance criteria against the
    // finished string rather than relying on the audits alone.
    expect(code).not.toContain("import(");
    expect(code).not.toMatch(/\bfrom\s*["']react["']/);
    expect(code).not.toContain('require("react")');
    expect(code).not.toMatch(/\bfrom\s*["']antd["']/);
    expect(code).not.toContain('require("antd")');

    // The entry wrapper #5/#6 prescribe, binding the single IIFE export.
    expect(code).toContain(`function App(props)`);
    expect(code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);

    // The bridge's generated modules are in the artifact: both page-global
    // bindings and the structured runtime error the missing-global criterion
    // requires.
    expect(code).toMatch(/globalThis\[\s*["']React["']\s*\]|globalThis\.React\b/);
    expect(code).toMatch(/globalThis\[\s*["']antd["']\s*\]|globalThis\.antd\b/);
    expect(code).toContain("host-global-missing");

    // No React implementation: the classic fingerprints of a bundled copy
    // (license banner, development build, env-gated process shim). What remains
    // must be the bridge's reference to the page object only.
    expect(code).not.toContain("@license React");
    expect(code).not.toContain("react.development");
    expect(code).not.toContain("process.env.NODE_ENV");

    // No antd implementation: a package-scope string or antd's CSS-in-JS
    // signature could only appear if the library itself were flattened in —
    // which a missed interception would have to do, since `antd` resolves
    // nowhere in this workspace.
    expect(code).not.toContain("@ant-design");
    expect(code).not.toContain("anticon");

    // The authored example itself is present in the body.
    expect(code).toContain("host antd PoC");
    expect(code).toContain("identity=");

    // #11 reports size the way #10 did: logged rather than pinned, because #21
    // owns the cell code budget.
    const bytes = Buffer.byteLength(code, "utf8");
    console.info(`#11 host-antd artifact: ${code.length} characters, ${bytes} bytes`);
  });

  it("runs hooks and context against the host React identity", async () => {
    const { html } = await renderExample();

    // `identity=pass` means the imported React *is* `globalThis.React`; a
    // bundled second copy would answer `fail`. `useState`/`useContext=pass`
    // means the renderer that executed this cell and the React it imported are
    // one object — a duplicate copy fails with an invalid-hook-call long before
    // any verdict text could render.
    expect(html).toContain("identity=pass");
    expect(html).toContain("useState=pass");
    expect(html).toContain("useContext=pass");
    expect(html).toContain("antd=pass");
    expect(html).toContain(EXPECTED_REPORT);
    expect(html).not.toContain("fail");
    // The host React version the artifact read off the page global, rendered
    // through the context provider.
    expect(html).toContain(`<small>${hostReact.version}</small>`);
  });

  it("preserves JSX children and keyed list semantics through the adapter", async () => {
    const { html, consoleErrors } = await renderExample();

    // Children, in nesting order: the report inside `<output>`, the verdict
    // inside `<data>`, the version inside `footer > small`. Any drop in the
    // adapter's two-argument/two-case rule loses `props.children` and these
    // disappear with it.
    expect(html).toContain("<h1>host antd PoC</h1>");
    expect(html).toContain(`<output>${EXPECTED_REPORT}</output>`);
    expect(html).toContain('<data value="pass">pass</data>');
    expect(html).toContain(`<footer><small>${hostReact.version}</small></footer>`);

    // Keyed list: labels in authored order, and never the raw key text. The
    // keys are deliberately distinct from the labels (`row-alpha` vs `alpha`)
    // because an adapter that forwards the key as `createElement`'s third
    // argument takes the children branch — children become the key, and the
    // rendered label would read `row-alpha`.
    expect(listItemTexts(html)).toEqual(["alpha", "beta", "gamma"]);
    expect(html).not.toContain("row-alpha");

    // React reports a dropped list key through `console.error` only, so a
    // silent key loss would otherwise pass every assertion above.
    expect(consoleErrors.join("\n")).not.toContain('unique "key"');
  });

  it("renders the antd components bound to the host antd global", async () => {
    const { html } = await renderExample();

    // The stub page global is the only `antd` in the sandbox: if the artifact
    // had bundled the library (or bound nothing), `Button`/`Card` would be
    // different objects, `antd=pass` could not render, and these stub-produced
    // markers — which exist only on the page object — would be absent.
    expect(html).toContain("antd=pass");
    expect(html).toContain('<button type="primary" data-role="antd-button">self-check</button>');
    expect(html).toContain('class="ant-card"');
    expect(html).toContain('data-title="host antd PoC"');
  });

  it("fails with an actionable structured error when host React is missing", async () => {
    const code = await compiledCode();

    let caught: Record<string, unknown> | undefined;
    try {
      runArtifact(code, {});
    } catch (error) {
      caught = error as Record<string, unknown>;
    }

    // Not a TypeError from whichever property ran first: the bridge's own
    // structured error, branchable by `code`, naming the specifier, the global,
    // and the owner of the fix.
    expect(caught).toBeDefined();
    expect(caught?.name).toBe("HostBridgeError");
    expect(caught?.code).toBe("host-global-missing");
    expect(caught?.specifier).toBe("react");
    expect(caught?.globalName).toBe("React");
    expect(caught?.fixOwner).toBe("host-environment");
    expect(String(caught?.message)).toContain("[host-bridge] host-global-missing");
    expect(String(caught?.message)).toContain("React");
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
