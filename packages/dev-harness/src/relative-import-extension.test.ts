import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The repository-wide half of #67's convention: **every relative import in `packages/**` and
 * `examples/**` names its file with a `.ts`/`.tsx` extension.**
 *
 * Decision sources: GitHub Issues
 * - #67 — "Implement: bare `vp dev` for the local Cell harness (configLoader / workspace
 *   TypeScript resolution)" (https://github.com/Mang-X/forguncy-react-workspace/issues/67)
 *
 * ## Why this exists beside the two dev-harness tests
 *
 * A review of this PR found the AGENTS.md rule ("every relative import in `packages/**` and
 * `examples/**` names its file with an extension") was documented but not guarded at the scope it
 * claims, and that finding was correct. `bare-vp-dev.test.ts` and `vp-dev-command.test.ts` both
 * exercise `examples/dev-harness`, whose config reaches `core`, `runtime`, `vite-plugin-fgc` and
 * `dev-harness`. An extensionless import added to `cell-compiler`, `dependency-resolver` or
 * `mcp-sync` would violate the stated invariant and leave both of them green. Measured rather
 * than assumed: adding one to `mcp-sync/src/index.ts` left the dev-harness guard passing 3/3, and
 * plain Node could no longer load that package (`ERR_MODULE_NOT_FOUND`).
 *
 * So the three files answer three different questions, and none substitutes for another:
 *
 * | file | question |
 * | --- | --- |
 * | `vp-dev-command.test.ts` | does the `vp dev` **command** serve the harness? |
 * | `bare-vp-dev.test.ts` | does Vite's default **loader** resolve the config graph, and why does the convention make it work? |
 * | this file | does **every source file in the repository** obey the convention? |
 *
 * ## Why a parse and not a grep
 *
 * The obvious version of this test is a regex over each file's text, and it would be wrong in both
 * directions. This repository's probe tests hold *fixture strings* containing extensionless
 * imports on purpose — `'export { v } from "./impl";'` is the **user's** JavaScript that the
 * scanner is being asked to analyse, not this repository's own convention. A grep would flag that
 * data, and the fix a reader would reach for is an exception list, which is how a rule quietly
 * becomes a list of things it does not apply to. Parsing reads import *declarations*, so a string
 * literal is not an import and data stays data.
 *
 * The scan covers `packages/**` and `examples/**` and skips `node_modules`, which is what
 * AGENTS.md names. It does **not** skip `tests/fixtures`, deliberately: those files are real
 * modules the suite imports (`forguncy.config.ts`, Cell entries), so an extensionless import there
 * fails the same way — and a fixture that stops loading is a broken test the moment it is used.
 *
 * What it does not cover, stated rather than implied: `.js`/`.mjs`/`.jsx` sources. There are none
 * in the scanned scope today (the committed JavaScript under `packages/**` is either fixture data
 * or inside a fixture's own `node_modules`), and the convention is about the TypeScript sources
 * this repository authors. If a `.mjs` source is ever added, this test will not see it, and the
 * `vp-dev-command.test.ts` case is what would catch a config-visible one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");

/** The directories AGENTS.md names, relative to the repository root. */
const SCANNED_ROOTS = ["packages", "examples"] as const;

/** Directories that are never this repository's source. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage", ".vite", ".fgc"]);

/** Every `.ts`/`.tsx` file under `root`, excluding build output and dependencies. */
function sourceFilesIn(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) {
          walk(path);
        }
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        found.push(path);
      }
    }
  };
  walk(join(repositoryRoot, root));

  return found;
}

/** A relative specifier, which is the only kind this convention is about. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Whether a specifier already names its file.
 *
 * Checked as "has an extension at all" rather than against a list of the ones this repository
 * uses, so an import of a `.css` or `.json` file is left alone rather than reported as missing a
 * `.ts`.
 */
function hasExtension(specifier: string): boolean {
  return /\.[a-z]+$/i.test(specifier);
}

/** The relative speculative imports a file declares without an extension, with their positions. */
function extensionlessImportsIn(path: string): readonly string[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const found: string[] = [];
  const record = (specifier: string, node: ts.Node): void => {
    if (!isRelative(specifier) || hasExtension(specifier)) {
      return;
    }
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.push(`${relative(repositoryRoot, path).split("\\").join("/")}:${line} — "${specifier}"`);
  };

  const visit = (node: ts.Node): void => {
    // Static `import`/`export ... from "..."`.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text, node);
    }
    // `import("...")`. Covered because it fails identically at runtime and a scan that missed it
    // would have to be remembered as "the static half only" — which is exactly the kind of
    // caveat that gets lost. One such import was missed by the codemod that applied this
    // convention (`frozen-behaviour.test.ts`), so this is a worked example rather than a
    // hypothetical.
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0].text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return found;
}

describe("every relative import in this repository names its file", () => {
  it("finds no extensionless relative import under packages/** or examples/**", () => {
    const violations = SCANNED_ROOTS.flatMap(root => sourceFilesIn(root)).flatMap(path => extensionlessImportsIn(path));

    // The whole list, not the first: a reader fixing this wants to see every site, and an
    // assertion that stopped at one would make a repo-wide edit a sequence of single-file runs.
    expect(violations).toEqual([]);
  });

  it("scanned the files this rule is about, so the assertion above is not vacuous", () => {
    // Without this, a broken walk (a wrong root, an over-broad skip list) would report zero
    // violations and look like a pass. The counts are floors rather than exact numbers so that
    // adding a file does not fail this test; they are set well below today's totals, which are
    // roughly 165 under `packages/**` and 19 under `examples/**`.
    expect(sourceFilesIn("packages").length).toBeGreaterThan(100);
    expect(sourceFilesIn("examples").length).toBeGreaterThan(10);

    // The parser path is the one that matters — a walk that found files but parsed none of them
    // would also pass the assertion above. Asserted on a file known to import relatively.
    const probed = extensionlessImportsIn(join(repositoryRoot, "packages", "core", "src", "index.ts"));
    expect(probed).toEqual([]);

    // The control for the *reporter*: this file's own subject is detectable. Run the same
    // function over a string with a deliberate violation and confirm it reports one, so a
    // `record` that never fires cannot make the main assertion green.
    expect(detectableByThisScan('import { a } from "./dep";')).toBe(true);
    expect(detectableByThisScan('import { a } from "./dep.ts";')).toBe(false);
    expect(detectableByThisScan('const s = \'from "./dep"\';')).toBe(false);
  });
});

/**
 * Whether the scan would report a violation for a snippet, run through the same parser path.
 *
 * A snippet rather than a file so the reporter itself can be controlled without writing a
 * temporary module into the repository — the temporary file would be the thing most likely to
 * leak into a commit.
 */
function detectableByThisScan(snippet: string): boolean {
  const file = ts.createSourceFile("probe.ts", snippet, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (isRelative(specifier) && !hasExtension(specifier)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return found;
}
