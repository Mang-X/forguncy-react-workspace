/**
 * The two-Cell anti-claim: `cells-do-not-share-workspace-module-state`.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening PoC"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/15), under #14 —
 * "Spec: local workspace packages are source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * ## What this file proves, and what it deliberately does not claim
 *
 * #14 records this guarantee as `real-runtime`, and that level is about what a
 * **page** runs: two Cells mounted together in Forguncy, each its own artifact,
 * sharing one DOM. That execution was performed against a real Forguncy 12.0.100.0
 * project and is recorded on #15 — including the interaction the claim is about
 * (clicking one Cell and reading the other).
 *
 * This file proves the **structural half**, which is a real guard rather than a
 * restatement: each of the two compiled artifacts carries its **own inlined copy** of
 * the shared package, including the module-scope `Map` and the `createContext` call,
 * with no surviving `@app/session` import. A bundler that hoisted the package into a
 * shared chunk or left it external is caught here, before any deployment.
 *
 * What it does **not** claim is that a rendered absence of a label is evidence of
 * independence. An earlier draft asserted exactly that, and a mutation showed it was
 * vacuous: `renderToString` delivers no events, so the probe never records a visit and
 * `labels` is empty because nothing wrote — not because the Cells are separate. A
 * second draft asserted Cell B reads the Context default; React's Context visibility
 * follows the **component tree**, not object identity, so B would read `(none)` even
 * if the two artifacts shared one Context object. Both drafts were deleted, and this
 * header records why so the same shape is not re-added.
 *
 * The interaction that distinguishes the two cases — write in one Cell, read the
 * other — is what the real-page execution recorded on #15 does, and it is not
 * reproducible from a single test process.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

// The package's module-scope state, imported from a React-free file so this import
// does not pull JSX types into the typecheck project. This is the test process's own
// instance — a module the artifacts have no relationship with — which is what makes
// the assertion below able to fail. See `state.ts`'s header.
import { recordVisit, seenLabels } from "../../../examples/workspace-package/packages/session/src/state";

import { compileCell } from "./artifact";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry";
import { createRolldownCellBundler } from "./rolldown-bundler";
import { loadPnpmWorkspaceGraph } from "./workspace-graph";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "workspace-package");

const DECISIONS: readonly DependencyDecision[] = [{ strategy: "host", packageName: "react", globalName: "React" }];

const require = createRequire(import.meta.url);
const React = require("react") as Record<string, unknown>;
const { renderToString } = require("react-dom/server") as { renderToString: (element: unknown) => string };

/** One Cell artifact, evaluated in its own `vm` context, rendering from its own copy. */
function evaluateCell(code: string): { readonly render: () => string } {
  const sandbox: Record<string, unknown> = { React, console };
  sandbox.globalThis = sandbox;
  new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
  const Component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
  if (typeof Component !== "function") {
    throw new Error(`The artifact did not bind a component to ${CELL_ENTRY_COMPONENT_BINDING}.`);
  }
  return { render: () => renderToString((Component as () => unknown)() as never) };
}

/** One `data-*` attribute's value, or `undefined` when the element is absent. */
function attributeOf(html: string, attribute: string): string | undefined {
  return new RegExp(`${attribute}="([^"]*)"`).exec(html)?.[1];
}

async function compileCellEntry(entry: string): Promise<string> {
  const graph = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
  const outcome = await compileCell(
    { entry, dependencies: DECISIONS },
    { bundler: createRolldownCellBundler({ dir: exampleRoot }), workspace: graph.graph },
  );
  if (outcome.status !== "compiled") {
    throw new Error(`The ${entry} PoC entry was rejected:\n${JSON.stringify(outcome.diagnostics, null, 2)}`);
  }
  return outcome.artifact.code;
}

describe("cells do not share workspace module state (#14, two-Cell probe)", () => {
  it("inlines the shared package into each Cell, including its module-scope state", async () => {
    // The premise, and the bundler regression this file exists to catch: each
    // artifact must carry its *own* copy of the module. A shared chunk, a
    // `preserveModules` layout or an externals rule would leave an artifact without
    // the state, and the two Cells would share whatever the page happened to load.
    for (const entry of ["src/cells/cell-a.tsx", "src/cells/cell-b.tsx"]) {
      const code = await compileCellEntry(entry);
      expect(code).toContain("data-session-probe");
      // The module-scope `Map` and the `createContext` call are the two things whose
      // sharing #14 denies, so both must be present for the claim to be about anything.
      expect(code).toContain("visitsByLabel");
      expect(code).toContain("createContext");
      // And the source is inlined rather than linked: no workspace import survived.
      expect(code).not.toMatch(/\bfrom\s*["']@app\/session["']/);
      expect(code).not.toContain('require("@app/session")');
    }
  });

  it("does not read module state the test wrote to the package directly", async () => {
    // The assertion made in the direction that can fail, with one honest caveat about
    // *which* check actually fires first.
    //
    // The write goes into the **test process's own instance** of `@app/session`'s
    // state — a module the artifacts have no relationship with — and each Cell must be
    // blind to it. `state.ts` is a React-free file precisely so this import typechecks.
    //
    // Caveat, from a mutation test: when the bundler is mutated to leave
    // `@app/session` external, this test fails — but it fails because the *artifact
    // audit* rejects the compile (`source-level-import-remains`), before this
    // assertion runs. So the artifact-side audit is the first line of defence here and
    // this assertion is the second: it would catch the case the audit cannot see, an
    // artifact that inlined a *shared* module instance rather than its own copy. That
    // case cannot be constructed from a bundler mutation in this repository, so the
    // assertion is stated as what it is — a check on the artifact's own state — and
    // not as the thing that catches the external-import regression.
    const marker = "written-by-the-test-not-the-cell";
    recordVisit(marker);
    // The write landed, so the absence below is about the artifact and not about a
    // no-op.
    expect(seenLabels()).toContain(marker);

    for (const entry of ["src/cells/cell-a.tsx", "src/cells/cell-b.tsx"]) {
      const html = evaluateCell(await compileCellEntry(entry)).render();
      // The Cell rendered, so this is not passing because nothing happened.
      expect(attributeOf(html, "data-session-probe")).toBeDefined();
      expect(attributeOf(html, "data-session-own")).toBe("0");
      // And its own inlined copy of the state has never seen the test's write.
      expect(attributeOf(html, "data-session-labels")).toBe("");
    }
  });

  it("gives the two Cells different artifacts, each with its own copy of the package", async () => {
    // Two Cells means two compiles, and each must carry the source rather than point
    // at a shared one. Asserted on the artifacts themselves so a future change that
    // made the second Cell reuse the first's module would be caught here.
    const a = await compileCellEntry("src/cells/cell-a.tsx");
    const b = await compileCellEntry("src/cells/cell-b.tsx");

    expect(a).not.toBe(b);
    // Each artifact carries its own inlined module, so each has the `Map` and the
    // `createContext` call — the state is duplicated per Cell by construction.
    for (const code of [a, b]) {
      expect(code).toContain("visitsByLabel");
      expect(code).toContain("createContext");
    }
    // The two Cells are distinguishable in the output, so the render above is
    // genuinely reporting each Cell rather than one Cell rendered twice.
    expect(a).toContain("cell-a");
    expect(b).toContain("cell-b");
  });
});

// ---------------------------------------------------------------------------
// Context object identity, which the rendered probe cannot show
// ---------------------------------------------------------------------------

describe("each Cell's Context object is a different object", () => {
  it("answers the identity question by comparing the objects, not by rendering", async () => {
    // Why this test exists at all, and why it does not render: a Provider/Consumer
    // pair in two sibling React roots cannot distinguish "one shared Context object"
    // from "two Context objects", because value resolution walks the reading tree's
    // ancestor chain. Verified directly: with a *single* `createContext` result and
    // root A mounting a Provider, root B's Consumer still read the default. So the
    // rendered `data-session-context` is not evidence of module identity, and this
    // test asks the question the only way it can be asked — by comparing references.
    //
    // The channel is a sandbox global standing in for `window`, which is what the two
    // Cell entries use on a page. Each artifact is evaluated in its own context, so
    // each has its own `window` unless this test hands them a shared one — and handing
    // them one is exactly how a shared registry is simulated.
    const sharedWindow: Record<string, unknown> = {};

    // The publish happens inside `App`, so the artifact must be *rendered* for it to
    // run — evaluating the script alone only defines the component. That distinction
    // cost one debugging round here, and it is the same one the whole file is about:
    // a module-scope effect and a render-time effect are different observations.
    const evaluateWith = async (entry: string, win: Record<string, unknown>): Promise<void> => {
      const code = await compileCellEntry(entry);
      const sandbox: Record<string, unknown> = { React, console, window: win };
      sandbox.globalThis = sandbox;
      new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
      const Component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
      if (typeof Component !== "function") throw new Error("no component bound");
      renderToString((Component as () => unknown)() as never);
    };

    // Cell A publishes its Context reference; Cell B compares against its own. Both
    // are given the same `window`, which is what a page provides.
    await evaluateWith("src/cells/cell-a.tsx", sharedWindow);
    await evaluateWith("src/cells/cell-b.tsx", sharedWindow);

    const registry = sharedWindow["__fgcContextIdentity"] as Record<string, unknown>;
    expect(registry).toBeDefined();

    // The assertion: the two artifacts created **different** Context objects, so Cell
    // B's comparison against Cell A's reference is false. If a bundler hoisted the
    // package into one shared module instance, both Cells would hold one object and
    // this would be `true`.
    expect(registry["cell-b-matches-cell-a"]).toBe(false);
    // And Cell A really did publish, so the `false` is a comparison rather than an
    // absent key. The comparator's ability to answer `true` is the sibling test's
    // job — a `false` alone would be consistent with a comparator that never says
    // otherwise.
    expect("cell-a-published" in registry).toBe(true);
  });

  it("sharing a sandbox does not share the inlined module instance", async () => {
    // A boundary note rather than a positive control, and it records the mistake of
    // its own first draft: the test was named "reports a match when the two Cells are
    // handed the same module instance" and asserted `false`, with a comment claiming
    // both artifacts "see one `@app/session` module". They do not. Putting two
    // artifacts that each inlined their own copy into one `vm` context shares the
    // *sandbox* — `globalThis`, and nothing else. Each artifact's `createContext()`
    // ran inside its own closure when its script was evaluated, so neither a shared
    // global nor a shared `window` can merge the two module instances.
    //
    // The assertion is therefore the natural outcome of this setup, and it is worth
    // stating for exactly that reason: it is the property that makes the sibling-Cell
    // result trustworthy. If a shared sandbox *could* merge the module instances, the
    // two artifacts on a page might share one too, and the real-page `false` would
    // prove nothing.
    const sharedWindow: Record<string, unknown> = {};
    const sharedSandbox: Record<string, unknown> = { React, console, window: sharedWindow };
    sharedSandbox.globalThis = sharedSandbox;
    const sharedContext = createContext(sharedSandbox);

    for (const entry of ["src/cells/cell-a.tsx", "src/cells/cell-b.tsx"]) {
      const code = await compileCellEntry(entry);
      new Script(code, { filename: "cell-artifact.js" }).runInContext(sharedContext);
      const Component = sharedSandbox[CELL_ENTRY_COMPONENT_BINDING];
      if (typeof Component !== "function") throw new Error("no component bound");
      renderToString((Component as () => unknown)() as never);
    }

    const registry = sharedWindow["__fgcContextIdentity"] as Record<string, unknown>;
    expect(registry["cell-b-matches-cell-a"]).toBe(false);
  });

  it("discriminates: the same reference answers true, a different one answers false", async () => {
    // The positive control the previous test is not, and the reason the pair is an
    // experiment rather than a one-sided claim.
    //
    // Cell A publishes two rows from the same code path the page runs: its own
    // reference, and `Object.is(own, own)`. Cell B compares A's reference against its
    // own. Read together:
    //
    // | row | comparison | meaning |
    // | --- | --- | --- |
    // | `cell-a-self-match` | A against A | **`true`** — the comparator *can* answer true |
    // | `cell-b-matches-cell-a` | B against A | **`false`** — the two artifacts differ |
    //
    // Either row alone proves nothing: `false` alone is consistent with a comparator
    // that always says false, and `true` alone says nothing about the two Cells. This
    // is the assertion the review asked for, driven through the artifacts rather than
    // through a reimplementation of the comparison.
    const sharedWindow: Record<string, unknown> = {};

    const renderEntry = async (entry: string): Promise<void> => {
      const code = await compileCellEntry(entry);
      const sandbox: Record<string, unknown> = { React, console, window: sharedWindow };
      sandbox.globalThis = sandbox;
      new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
      const Component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
      if (typeof Component !== "function") throw new Error("no component bound");
      renderToString((Component as () => unknown)() as never);
    };

    // A publishes first, as it does on the page.
    await renderEntry("src/cells/cell-a.tsx");
    await renderEntry("src/cells/cell-b.tsx");

    const registry = sharedWindow["__fgcContextIdentity"] as Record<string, unknown>;
    // A's reference really was published, so neither row below is comparing against
    // an absent key.
    expect(registry["cell-a-published"]).toBeDefined();
    // The control: the comparator answers `true` for one and the same object.
    expect(registry["cell-a-self-match"]).toBe(true);
    // The claim: the two artifacts created different Context objects.
    expect(registry["cell-b-matches-cell-a"]).toBe(false);
  });
});
