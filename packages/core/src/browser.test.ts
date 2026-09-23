import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as barrel from "./index";
import * as browser from "./browser";

/**
 * The `core/browser` projection, and the property it exists for.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), which surfaced the defect,
 *   under
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 *
 * Three assertions, and each is a different way this file could rot:
 *
 * 1. **No `node:` builtin in the graph.** The property the module exists for, and the one a
 *    future edit is most likely to break — a single `import { existsSync }` added to any
 *    browser-safe module silently re-breaks both a dev server and a Cell artifact.
 * 2. **Nothing is exported here that `index.ts` does not export.** Without it, `./browser`
 *    could grow into a second public API whose names nothing else in the repository knows
 *    about.
 * 3. **Nothing browser-safe is *missing* here.** Without it, a name added to a browser-safe
 *    module would be reachable from `core` and not from `core/browser`, and the failure would
 *    appear as a runtime "does not provide an export named" in a browser rather than as a test.
 *
 * The three are asserted rather than the file being written defensively, because `export *`
 * was chosen deliberately: a hand-copied list of names would be the "second copy of a rule"
 * this repository keeps finding and deleting, and it would drift on the first omission.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

/**
 * Every module `index.ts` re-exports, read from its source.
 *
 * The *source* rather than the module namespace, because the namespace cannot answer the
 * question this needs: `export *` flattens away which module a name came from, and "which
 * modules are browser-safe" is only answerable per module. Reading the barrel's `from "./x"`
 * clauses is also what makes the check independent of the barrel's current spelling — a
 * namespace check would pass for a name re-exported here from anywhere.
 */
function barrelModuleNames(): readonly string[] {
  const source = readFileSync(join(here, "index.ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/from "\.\/([a-z-]+)"/g)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** Every module `browser.ts` re-exports. */
function browserModuleNames(): readonly string[] {
  const source = readFileSync(join(here, "browser.ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/from "\.\/([a-z-]+)"/g)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/**
 * The `node:` specifiers a module imports, following its relative imports transitively.
 *
 * Transitive rather than direct, because that is what actually breaks: `index.ts` imports no
 * builtin itself, and the defect was still real — it reached `node:fs` through `cell-registry`.
 * A direct-only check would have passed on the exact graph that failed in a browser.
 *
 * `import type` is excluded, and that exclusion is not a loophole: a type-only import is erased
 * before anything runs, so it cannot throw at module initialisation. `verbatimModuleSyntax` is
 * on in this repository, so `import type` is the *only* form that survives erasure — but a
 * plain `import` of a type-only binding would still be a real edge, so the check reads the
 * specifier rather than trying to judge the binding.
 */
function nodeImportsOf(moduleName: string, seen = new Set<string>()): readonly string[] {
  if (seen.has(moduleName)) {
    return [];
  }
  seen.add(moduleName);

  const file = join(here, `${moduleName}.ts`);
  const source = readFileSync(file, "utf8");
  const found: string[] = [];

  for (const line of source.split("\n")) {
    // A type-only import is erased, so it cannot be the edge that throws.
    if (/^\s*import\s+type\b/.test(line)) {
      continue;
    }
    const specifier = /from "(node:[^"]+)"/.exec(line)?.[1];
    if (specifier !== undefined) {
      found.push(specifier);
    }
  }

  const relative = /from "\.\/([a-z-]+)"/g;
  for (const match of source.matchAll(relative)) {
    if (match[1] !== undefined) {
      found.push(...nodeImportsOf(match[1], seen));
    }
  }

  return found;
}

describe("core/browser is a projection of core's surface, not a second one", () => {
  it("re-exports every browser-safe module the barrel does", () => {
    const barrelModules = barrelModuleNames();
    const browserModules = browserModuleNames();

    // The two node-side modules, and the reason they are named rather than derived: "reads the
    // project off disk" is not decidable from a module's source, so a predicate that tried
    // would be a guess. Naming them here means adding a third node-side module has to come
    // with a deliberate edit — which is the point, because a new node-side module left in the
    // browser projection is exactly the defect this file guards.
    const nodeSide = ["cell-registry", "config-loader"] as const;

    const expected = barrelModules.filter(name => !(nodeSide as readonly string[]).includes(name));
    expect(expected.length).toBeGreaterThan(10);
    expect(browserModules).toEqual(expected);
  });

  it("reaches no `node:` builtin transitively", () => {
    for (const moduleName of browserModuleNames()) {
      expect(nodeImportsOf(moduleName), `module "${moduleName}"`).toEqual([]);
    }

    // The check is not vacuous: the barrel *does* reach builtins, through the two modules the
    // projection excludes. Without this the assertion above could pass because the walker
    // silently found nothing to walk.
    const barrelReach = barrelModuleNames().flatMap(name => nodeImportsOf(name));
    expect(barrelReach.length).toBeGreaterThan(0);
  });

  it("exports the same names as the barrel does for the modules it projects", () => {
    const browserNames = Object.keys(browser).sort();
    expect(browserNames.length).toBeGreaterThan(100);

    // Every name reachable from `./browser` must be reachable from `core` itself: the
    // projection may not be a superset. The reverse direction cannot be asserted by name —
    // `index.ts` legitimately exports the two node-side modules' names too — so it is covered
    // by the module-list assertion above, which is where those names come from.
    const missingFromBarrel = browserNames.filter(name => !(name in barrel));
    expect(missingFromBarrel).toEqual([]);
  });

  it("is a projection because the two node-side modules read the project off disk", () => {
    // The claim the whole file rests on, asserted rather than commented: these two reach a
    // builtin, and every browser-safe module reaches none. A reader who wants to know why
    // `cell-registry` is absent from the projection gets the walker's answer, not a promise.
    for (const moduleName of ["cell-registry", "config-loader"]) {
      expect(nodeImportsOf(moduleName), `module "${moduleName}"`).toContain("node:fs");
    }
  });

  it("keeps the projection's module list resolvable on disk", () => {
    // A `from "./typo"` inside `browser.ts` would satisfy every check above while failing at
    // import time, so the files are confirmed to exist. `relative` is used for the message
    // rather than an absolute path, for the portability rule `cell-registry` enforces.
    for (const moduleName of browserModuleNames()) {
      const file = resolve(here, `${moduleName}.ts`);
      expect(() => readFileSync(file, "utf8"), relative(packageRoot, file)).not.toThrow();
    }
  });
});
