/**
 * The Rolldown port's behaviour through the public boundary.
 *
 * Decision source: GitHub Issue #7 — "Implement: Cell compiler MVP for a single
 * React entry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7) and the review
 * comment on it
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7#issuecomment-5760952529),
 * which asks that the `@tanstack/react-query` case run through the *full*
 * `compileCell` path — entry, bundler, plans, assembly, audits — rather than
 * stopping at the plan, and that the namespace-import shape keep its coverage.
 *
 * Fixtures live in the OS temp tree on purpose, and the choice is part of the
 * assertions: nothing up-tree from a fixture directory has a `node_modules`, so
 * an authored `react` or `@tanstack/react-query` import cannot be resolved by
 * ordinary lookup. Reaching `status: "compiled"` therefore *proves* the resolver
 * hook interposed the host and extension modules — a build that missed them
 * could only externalize, and an external import is an assembly rejection. The
 * sandbox evaluations make the same claim from the other side: the artifact
 * runs against a stub React and a stub extension facade and has to produce the
 * right element, so the wiring is exercised, not merely present.
 *
 * What is *not* claimed: AGENTS.md rule 7 forbids presenting any of this as
 * Forguncy runtime compatibility. These tests prove compilation, assembly and
 * sandboxed evaluation of the artifact; the real-host confirmation belongs to
 * #7's downstream validation plan.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, Script } from "node:vm";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { afterAll, describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, compileCell } from "./artifact";
import type { CompileCellOutcome } from "./artifact";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry";
import { frontendLibraryIds } from "./frontend-libraries";
import { createRolldownCellBundler } from "./rolldown-bundler";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "forguncy-cell-bundler-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** One fixture directory per test; files are written relative to it. */
function fixture(name: string, files: Readonly<Record<string, string>>): string {
  const dir = path.join(fixtureRoot, name);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return dir;
}

function compileFixture(
  dir: string,
  entry: string,
  dependencies: readonly DependencyDecision[] = [],
): Promise<CompileCellOutcome> {
  return compileCell({ entry, dependencies }, { bundler: createRolldownCellBundler({ dir }) });
}

const TRIVIAL_ENTRY = `export function App() {
  return <section data-marker="trivial-marker">trivial cell</section>;
}
`;

const NAMED_EXTENSION_ENTRY = `import { QueryClient, useQuery } from "@tanstack/react-query";

export function App() {
  const client = new QueryClient();
  return <i>{\`\${typeof useQuery}|\${typeof client}|\${client.label}\`}</i>;
}
`;

const HOST_REACT_DECISION: DependencyDecision = {
  strategy: "host",
  packageName: "react",
  globalName: "React",
};

const TANSTACK_DECISION: DependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "tanstack-query",
  globalName: "TanStackQuery",
};

/** Same package and global as the row, one field wrong: the contradiction case. */
const CONFLICTING_TANSTACK_DECISION: DependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "wrong-library",
  globalName: "TanStackQuery",
};

// ---------------------------------------------------------------------------
// Sandbox evaluation
// ---------------------------------------------------------------------------

interface CellElement {
  readonly type: unknown;
  readonly props: { readonly children: unknown };
}

type CellComponent = () => CellElement;

/**
 * The page's React, reduced to what the fixtures touch.
 *
 * A stub rather than the installed `react`: the artifact under test must read
 * the *page* object (that is what `host` means), and a stub makes that
 * observable — an artifact that bundled its own React would ignore this object
 * entirely, and the `@license React` assertion above the sandbox catches the
 * bundling before the run does.
 */
function reactStub(): Record<string, unknown> {
  return {
    version: "19.2.7",
    Fragment: Symbol.for("react.fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
    useState: (initial: unknown) => [initial, () => undefined],
  };
}

/** The extension global a page that loaded `tanstack-query` would publish. */
function tanStackQueryFacade(): Record<string, unknown> {
  class QueryClient {
    readonly label = "query client";
  }
  return {
    QueryClient,
    useQuery: () => ({ data: undefined }),
  };
}

/**
 * Evaluates an artifact in an isolated `vm` context seeded with `globals`.
 *
 * `node:vm` rather than the test process so the stubbed page globals are the
 * only ones the artifact can see — a test that leaked a real `React` onto
 * `globalThis` would pass for the wrong reason. `globalThis` is aliased onto
 * the sandbox before the context is created because the generated host and
 * extension modules read their page objects through `globalThis`.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRolldownCellBundler through compileCell", () => {
  it("compiles a trivial React entry into a single artifact with no chunk loading", async () => {
    const dir = fixture("trivial", { "App.jsx": TRIVIAL_ENTRY });

    const outcome = await compileFixture(dir, "App.jsx");

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    const code = outcome.artifact.code;
    expect(code.startsWith(CELL_ARTIFACT_BANNER)).toBe(true);
    // The IIFE export, under the binding the generated wrapper references.
    expect(code).toContain(`var ${CELL_ENTRY_COMPONENT_BINDING}`);
    expect(code).toContain("function App(props)");
    expect(code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);
    // Authored content survives bundling unchanged enough to recognize.
    expect(code).toContain("trivial-marker");
    // #7's single-chunk guarantee: no chunk loading may survive into the artifact.
    expect(code).not.toContain("import(");
    expect(code).not.toContain("\u001b");
    expect(outcome.artifact.frontendLibraries).toEqual([]);
  });

  it("produces byte-identical artifacts for identical inputs", async () => {
    // "Identical inputs" hides two ways a build can differ, so the test claims
    // both. The same directory compiled twice rules out run-to-run
    // nondeterminism (timestamps, ordering). A second directory with identical
    // content but a different absolute path rules out path embedding — that is
    // what `attachDebugInfo: "none"` is for, and a same-directory pair could
    // never notice a leaked module id. The extension entry repeats the
    // cross-path claim with non-empty `frontendLibraries`, so metadata
    // stability is exercised beyond the empty case.
    const source = { "App.jsx": TRIVIAL_ENTRY };
    const extensionSource = { "App.jsx": NAMED_EXTENSION_ENTRY };
    const pathA = fixture("byte-stable-a", source);
    const pathB = fixture("byte-stable-b", source);
    const extensionPathA = fixture("byte-stable-ext-a", extensionSource);
    const extensionPathB = fixture("byte-stable-ext-b", extensionSource);

    const original = await compileFixture(pathA, "App.jsx");
    const rerun = await compileFixture(pathA, "App.jsx");
    const moved = await compileFixture(pathB, "App.jsx");
    const extensionOriginal = await compileFixture(extensionPathA, "App.jsx", [TANSTACK_DECISION]);
    const extensionMoved = await compileFixture(extensionPathB, "App.jsx", [TANSTACK_DECISION]);

    for (const outcome of [original, rerun, moved, extensionOriginal, extensionMoved]) {
      expect(outcome.status).toBe("compiled");
    }
    if (
      original.status !== "compiled" ||
      rerun.status !== "compiled" ||
      moved.status !== "compiled" ||
      extensionOriginal.status !== "compiled" ||
      extensionMoved.status !== "compiled"
    ) {
      return;
    }
    expect(rerun.artifact.code).toBe(original.artifact.code);
    expect(moved.artifact.code).toBe(original.artifact.code);
    expect(rerun.artifact.frontendLibraries).toEqual(original.artifact.frontendLibraries);
    expect(moved.artifact.frontendLibraries).toEqual(original.artifact.frontendLibraries);
    expect(extensionMoved.artifact.code).toBe(extensionOriginal.artifact.code);
    expect(extensionOriginal.artifact.frontendLibraries).toEqual([{ libraryId: "tanstack-query" }]);
    expect(extensionMoved.artifact.frontendLibraries).toEqual(extensionOriginal.artifact.frontendLibraries);
  });

  it("refuses a malformed entry with a structured, ANSI-free bundler-failure", async () => {
    const dir = fixture("malformed", { "Broken.jsx": "export function App( {\n" });

    const outcome = await compileFixture(dir, "Broken.jsx");

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic?.code).toBe("bundler-failure");
    // #6's error model: a caller gets the parser's verdict, the file and the
    // position as data — and never a colour code to diff around.
    expect(diagnostic?.message).toContain("PARSE_ERROR");
    expect(diagnostic?.message).toMatch(/Broken\.jsx:\d+:\d+/);
    expect(diagnostic?.message).not.toContain("\u001b");
  });

  it("refuses an entry that exports neither a default nor a named App", async () => {
    const dir = fixture("no-component", { "Orphan.jsx": 'export const unrelated = "orphan";\n' });

    const outcome = await compileFixture(dir, "Orphan.jsx");

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic?.code).toBe("bundler-failure");
    expect(diagnostic?.message).toContain("neither a default export nor");
  });

  it("refuses an entry file that does not exist", async () => {
    const dir = fixture("missing-entry", { "placeholder.txt": "no entry here\n" });

    const outcome = await compileFixture(dir, "src/Missing.jsx");

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic?.code).toBe("bundler-failure");
    expect(diagnostic?.message).toContain("does not exist");
    expect(diagnostic?.message).toContain("src/Missing.jsx");
  });

  it("intercepts react for the host global instead of bundling an implementation", async () => {
    const dir = fixture("host-react", {
      "App.jsx": `import { useState } from "react";

export function App() {
  const [value] = useState("from-host");
  return <b>{value}</b>;
}
`,
    });

    const outcome = await compileFixture(dir, "App.jsx", [HOST_REACT_DECISION]);

    // Compiled at all proves interception: with no node_modules up-tree of the
    // fixture, an unintercepted `react` could only end up external — and an
    // external import is an assembly rejection.
    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    const code = outcome.artifact.code;
    expect(code).not.toContain("@license React");
    expect(code).not.toContain("process.env.NODE_ENV");
    expect(code).toContain("globalThis");
    expect(code).not.toContain("import(");

    // The artifact must read the page object: the stub below is the only React
    // the sandbox has, so `children` surviving to the element proves the host
    // module and the JSX adapter both resolved through it.
    const sandbox = runArtifact(code, { React: reactStub() });
    const element = componentFrom(sandbox)();
    expect(element.type).toBe("b");
    expect(element.props.children).toBe("from-host");
  });

  it("compiles an authored useQuery import and references tanstack-query exactly once", async () => {
    const dir = fixture("extension-named", { "App.jsx": NAMED_EXTENSION_ENTRY });

    const outcome = await compileFixture(dir, "App.jsx", [TANSTACK_DECISION]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    // The issue comment's requirement: exactly one reference, carrying exactly
    // the libraryId the mapping row resolves the package to.
    expect(outcome.artifact.frontendLibraries).toEqual([{ libraryId: "tanstack-query" }]);
    expect(frontendLibraryIds(outcome.artifact.frontendLibraries).filter(id => id === "tanstack-query")).toHaveLength(
      1,
    );

    const sandbox = runArtifact(compiledCodeOf(outcome), {
      React: reactStub(),
      TanStackQuery: tanStackQueryFacade(),
    });
    const element = componentFrom(sandbox)();
    // Both named imports reached the facade through the generated extension
    // module: the hook arrives as a function, and the class arrives as a
    // *constructor* — `new` against a stale or missing binding throws rather
    // than producing an object. The label exists only on our facade's class,
    // so the instance's identity traces the whole path: global → module →
    // interop → element.
    expect(element.props.children).toBe("function|object|query client");
  });

  it("compiles a namespace import of the extension package the same way", async () => {
    const dir = fixture("extension-namespace", {
      "App.jsx": `import * as TQ from "@tanstack/react-query";

export function App() {
  return <i>{\`\${typeof TQ.useQuery}|\${typeof TQ.QueryClient}\`}</i>;
}
`,
    });

    const outcome = await compileFixture(dir, "App.jsx", [TANSTACK_DECISION]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.frontendLibraries).toEqual([{ libraryId: "tanstack-query" }]);

    // The namespace shape is the one CJS interop breaks silently: the module
    // evaluates fine and the namespace simply never gains the members. typeof
    // through a real evaluation is what rules that out.
    const sandbox = runArtifact(compiledCodeOf(outcome), {
      React: reactStub(),
      TanStackQuery: tanStackQueryFacade(),
    });
    const element = componentFrom(sandbox)();
    expect(element.props.children).toBe("function|function");
  });

  it("refuses a decision that contradicts the extension mapping, reporting it once", async () => {
    const dir = fixture("extension-conflict", { "App.jsx": NAMED_EXTENSION_ENTRY });

    const outcome = await compileFixture(dir, "App.jsx", [CONFLICTING_TANSTACK_DECISION]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    // Once, even though three detectors see it: the build's translated finding,
    // the plan's own finding and the external-import audit all name the same
    // code and subject, and deduplication must collapse them to one report.
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["missing-extension-mapping"]);
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic?.subject).toBe("@tanstack/react-query");
    expect(diagnostic?.message).toContain("wrong-library");
  });

  it("refuses an installed package inlined without a dependency decision", async () => {
    // The review's regression case: a real npm package the fixture can resolve
    // by ordinary lookup (it has its own `node_modules`), with no decision at
    // all. #4 requires every non-workspace dependency to map to host | inline |
    // extension | replace, so an undecided installed package must never reach
    // `compiled` — `auditInlinedPackages` skips no-decision packages because
    // workspace source legitimately has none, which is exactly the hole this
    // test pins shut.
    const dir = fixture("undecided-installed", {
      "App.jsx": `import { value } from "sneaky-dep";

export function App() {
  return <i>{value}</i>;
}
`,
      "node_modules/sneaky-dep/package.json": JSON.stringify({
        name: "sneaky-dep",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/sneaky-dep/index.js": 'module.exports = { value: "from-sneaky" };\n',
    });

    const outcome = await compileFixture(dir, "App.jsx");

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain("unresolved-dependency-decision");
    const diagnostic = outcome.diagnostics.find(item => item.code === "unresolved-dependency-decision");
    expect(diagnostic?.subject).toBe("sneaky-dep");
    expect(diagnostic?.message).toContain("no dependency decision covers it");
  });

  it("accepts an installed package inlined with an explicit inline decision", async () => {
    const dir = fixture("decided-installed", {
      "App.jsx": `import { value } from "sneaky-dep";

export function App() {
  return <i>{value}</i>;
}
`,
      "node_modules/sneaky-dep/package.json": JSON.stringify({
        name: "sneaky-dep",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/sneaky-dep/index.js": 'module.exports = { value: "from-sneaky" };\n',
    });

    const outcome = await compileFixture(dir, "App.jsx", [
      { strategy: "inline", packageName: "sneaky-dep" },
    ]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.code).toContain("from-sneaky");
  });

  it("accepts relative workspace source with no dependency decision", async () => {
    // Workspace source (#14) needs no decision: it is source, not a runtime
    // module, and the undecided-installed-package check above must not
    // mistake it for one. The relative import never enters `inlinedPackages`
    // (its module id carries no `node_modules` segment), so this test proves
    // the new report is scoped to installed packages only.
    const dir = fixture("workspace-source", {
      "App.jsx": `import { label } from "./widget";

export function App() {
  return <i>{label}</i>;
}
`,
      "widget.jsx": 'export const label = "from-workspace";\n',
    });

    const outcome = await compileFixture(dir, "App.jsx");

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.code).toContain("from-workspace");
  });

  it("honors an exact-subpath inline decision that does not cover the package root", async () => {
    // Regression for the review's package-name folding finding: the entry
    // imports only `sneaky-dep/subpath`, governed by an exact-subpath inline
    // decision. Folding the module id to `sneaky-dep` before the decision
    // lookup would miss that exact record (exact-first precedence) and report
    // a false `unresolved-dependency-decision`.
    const dir = fixture("exact-subpath-inline", {
      "App.jsx": `import { value } from "sneaky-dep/subpath";

export function App() {
  return <i>{value}</i>;
}
`,
      "node_modules/sneaky-dep/package.json": JSON.stringify({
        name: "sneaky-dep",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/sneaky-dep/subpath.js": 'module.exports = { value: "from-subpath" };\n',
    });

    const outcome = await compileFixture(dir, "App.jsx", [
      { strategy: "inline", packageName: "sneaky-dep/subpath" },
    ]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.code).toContain("from-subpath");
  });

  it("lets an exact-subpath inline decision override a package-level host decision", async () => {
    // The companion regression: package-level `host` for `sneaky-dep`, exact
    // `inline` for `sneaky-dep/subpath`. Only the subpath is bundled, so the
    // governing decision is the exact inline record. Folding the module id to
    // the package root before `auditInlinedPackages` would pick the package-level
    // `host` decision and falsely report `duplicate-host-mapping`.
    const dir = fixture("exact-subpath-overrides-host", {
      "App.jsx": `import { value } from "sneaky-dep/subpath";

export function App() {
  return <i>{value}</i>;
}
`,
      "node_modules/sneaky-dep/package.json": JSON.stringify({
        name: "sneaky-dep",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/sneaky-dep/subpath.js": 'module.exports = { value: "from-subpath" };\n',
    });

    const outcome = await compileFixture(dir, "App.jsx", [
      { strategy: "host", packageName: "sneaky-dep", globalName: "React" },
      { strategy: "inline", packageName: "sneaky-dep/subpath" },
    ]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.code).toContain("from-subpath");
  });
});

/** The compiled artifact's code, for the narrowing-after-assert tests above. */
function compiledCodeOf(outcome: Extract<CompileCellOutcome, { readonly status: "compiled" }>): string {
  return outcome.artifact.code;
}
