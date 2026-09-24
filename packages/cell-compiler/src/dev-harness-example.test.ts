import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact";
import type { CompileCellOutcome } from "./artifact";
import { createRolldownCellBundler } from "./rolldown-bundler";

/**
 * #23's second acceptance criterion, executed: "Same source compiles for Forguncy without
 * local-only branches in application code".
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 7 asks for
 *   "at least one example where the same source is used both by `vp dev` and by Cell compiler
 *   output", and
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6, #9 and #27 as recorded in
 *   the compiler's own provenance.
 *
 * ## Why the assertion lives here and not in `dev-harness`
 *
 * The claim has two halves — "compiles" and "runs locally" — and they are checked by different
 * packages on purpose. `dev-harness` reads the loop; this file reads the *artifact*. Putting it
 * here has one hard advantage: `dev-harness` may not be a dependency of `cell-compiler` (the
 * compiler is upstream of everything), so a test in `dev-harness` importing `compileCell` proves
 * the same thing while making the dependency direction look reversible. Here, the compiler
 * knows nothing about the harness and the harness is what depends on it — which is the real
 * shape.
 *
 * ## What is actually asserted, and what is deliberately not
 *
 * The compiler is pointed at `examples/dev-harness/cells/sales-summary/src/App.tsx` — the file
 * `vp dev` serves — and the resulting artifact is checked for the properties that make "the same
 * source" mean something:
 *
 * - it compiles at all, with no rejected diagnostics;
 * - the authored source is unchanged in the artifact *by content*: the Cell's own text is
 *   present, so the compiler wrapped the file rather than rewriting it for the target;
 * - no local-only branch reached it: no `import.meta.env`, no `isLocal`, no harness import,
 *   no `globalThis` host sniffing. `LOCAL_DEV_FORBIDDEN_PATTERNS` names these, and the point of
 *   checking them **in the artifact** rather than in the source is that this is what would ship:
 *   a `DEV` branch is a branch the page never takes, and the artifact is the only place its
 *   presence is decidable.
 * - the source file is not modified by compiling it. #23's plan step 8 asks for "smoke tests
 *   ensuring the local harness does not mutate authored source", and the compiler half of that
 *   is asserted here, where a copy silently written into the example would be visible.
 *
 * Deliberately *not* asserted: that the artifact renders, or that it is Forguncy-compatible.
 * AGENTS.md rule 7 separates a local build from runtime validation, and #20/#25 own the real
 * page. What this proves is a `local` check in #4's vocabulary and nothing more.
 */
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..", "..", "..", "examples", "dev-harness");
const cellSourcePath = join(exampleRoot, "cells", "sales-summary", "src", "App.tsx");

/**
 * The example's decisions, as its own `package.json` reasons them.
 *
 * `react` is `host` — #9 intercepts the specifier and binds the page's object — so the only
 * decision the Cell needs is that one. `@forguncy-react-workspace/runtime` reaches the artifact
 * as *workspace source* (#14) rather than as a dependency decision, which is why it needs no
 * row here: #14's contract flattens workspace packages into the consuming Cell like any other
 * source file, and the compiler's own workspace audit is what checks that it did.
 */
const DEPENDENCIES = [{ strategy: "host", packageName: "react", globalName: "React" }] as const;

async function compileExample(): Promise<CompileCellOutcome> {
  const bundler = createRolldownCellBundler({ dir: join(exampleRoot, "cells", "sales-summary", "src") });
  return compileCell({ entry: cellSourcePath, dependencies: [...DEPENDENCIES] }, { bundler });
}

/** The compiled branch, or a failure that names the diagnostics rather than the type error. */
function compiledCode(outcome: CompileCellOutcome): string {
  if (outcome.status !== "compiled") {
    throw new Error(
      `Expected the example to compile; it was rejected with:\n${outcome.diagnostics
        .map(diagnostic => `  - ${diagnostic.code}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return outcome.artifact.code;
}

/** The source the artifact is supposed to carry, with comments removed. */
function authoredCodeWithoutComments(): string {
  return readFileSync(cellSourcePath, "utf8")
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
    })
    .join("\n");
}

describe("the dev harness example compiles for the target from the same source `vp dev` serves", () => {
  it("compiles with no rejected diagnostics", async () => {
    const outcome = await compileExample();

    expect(outcome.status).toBe("compiled");
  });

  it("carries the authored source, so the compiler wrapped the Cell rather than rewriting it", async () => {
    const code = compiledCode(await compileExample());

    // The distinct strings a rewrite-for-the-target would have to remove: the Chinese labels
    // are the Cell's own UI text, and the permission name is its own claim about the page. A
    // generator that emitted a stub, or that stripped body text, fails here.
    expect(code).toContain("本月销售");
    expect(code).toContain("Orders.Read");
    expect(code).toContain("GetSalesData");
    // The `useState` holder, which is the observable HMR keeps alive under `vp dev`. Its
    // presence is what makes the artifact the *same component* the local loop renders, not a
    // compiled equivalent of it.
    expect(code).toContain("useState");
  });

  it("carries no local-only branch, checked in the artifact rather than in the source", async () => {
    const code = compiledCode(await compileExample());

    // `LOCAL_DEV_FORBIDDEN_PATTERNS`' first three, as the artifact would show them. Each is a
    // shape that only exists to make local development easier, which is precisely why finding
    // one in deployment output is the failure this asserts against — the branch that only runs
    // locally is the branch that never runs on the page.
    expect(code).not.toMatch(/import\.meta\.env/);
    expect(code).not.toMatch(/\bisLocal\b/);
    expect(code).not.toMatch(/__forguncyDevHarness/);
    // The harness's own package ids: a Cell *importing* one would make the artifact depend on
    // the dev loop, which is the second-code-path failure `local-only-source-branch` describes.
    //
    // Matched with the package specifier rather than the bare word, because the Cell legitimately
    // carries `data-dev-harness="sales-summary"` — a DOM attribute the harness's own test uses as
    // an oracle, which is a marker *of* the Cell rather than a dependency *on* the loop. A
    // substring check on `dev-harness` would refuse the marker and, worse, would be the kind of
    // assertion that gets deleted the first time it fires for a reason nobody can explain.
    expect(code).not.toMatch(/@forguncy-react-workspace\/dev-harness/);
    // Host globals read at the point of use (`RUNTIME_FACADE_FORBIDDEN_PATTERNS`'
    // `host-global-sniffing`). The bridge binds module ids; a Cell reading `globalThis.React`
    // would work locally against the alias and bind nothing on the page.
    expect(code).not.toMatch(/globalThis\.(React|antd|ReactDOM)\b/);
  });

  it("is bundled into one self-contained script with no runtime chunk loading", async () => {
    const code = compiledCode(await compileExample());

    // #6's artifact contract, which is what makes the output a Cell rather than a web bundle.
    // Asserted here because it is the other half of "the same source": the local loop loads a
    // module graph with real imports, and the artifact must be the opposite of that while
    // coming from the same file.
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\bexport\s*\{/);
    expect(outcomeBannerOf(code)).toBe(true);
    expect(code.length).toBeGreaterThan(1000);
    // The React *implementation* must not be in the artifact: `react` is `host`, so the
    // compiler interposes a binding to the page's object. A bundled copy would be the second
    // identity #11's PoC measured against.
    expect(code).not.toMatch(/react\.development\.js/);
    void RUNTIME_CONTRACT_TARGET;
  });

  it("does not mutate the authored source it compiled", async () => {
    // #23's plan step 8, the compiler half. Read before and after a compile rather than only
    // after, so the assertion is about the compile rather than about the file's current state —
    // and compared as bytes, because a copy that reformatted the source would still "equal" it
    // as text.
    const before = readFileSync(cellSourcePath);
    await compileExample();
    const after = readFileSync(cellSourcePath);

    expect(after.equals(before)).toBe(true);
    // The control: the file has content for the comparison to be about. Without this the test
    // would pass for an empty file.
    expect(before.length).toBeGreaterThan(500);
    expect(authoredCodeWithoutComments().length).toBeGreaterThan(500);
  });
});

/** Whether the artifact opens with #6's fixed banner. */
function outcomeBannerOf(code: string): boolean {
  return code.startsWith("/* Generated by @forguncy-react-workspace/cell-compiler.");
}
