import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as barrel from "@forguncy-react-workspace/dependency-resolver";
import * as local from "@forguncy-react-workspace/dependency-resolver/local";

/**
 * `dependency-resolver/local` is a projection of the barrel's surface onto a graph that does not
 * pull a bundler — checked, not trusted.
 *
 * Decision source: GitHub Issue #23 —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/23, which is where the cost was measured
 * (the dev harness loads its plugin from a project's `vite.config.ts`, and the barrel reaches
 * `probe/build.ts`, which imports `rolldown`).
 *
 * ## Why this file exists, and what it guards
 *
 * A hand-written list of the safe modules would be exactly the "second copy of a rule" this
 * repository keeps deleting, so `local.ts` re-exports whole modules with `export *`. That makes the
 * projection self-maintaining for *new* exports of the four modules it names — and leaves two things
 * it cannot check by construction, which are the assertions here:
 *
 * 1. **Nothing reachable through `local` that the barrel does not export.** Otherwise this entry
 *    would be a second public surface that grows its own API, rather than a projection of one.
 * 2. **No `rolldown` in this entry's transitive graph.** That is the property the file exists for,
 *    and the one a future edit is most likely to break: a single new import of a `probe/` module
 *    into `lock-store` or `decision-conformance` would silently restore the cost, and every other
 *    test in the repository would still pass.
 *
 * `core/browser`'s `browser.test.ts` asserts the same two shapes for the same reasons, and the
 * comparison is deliberate: this is the same problem — a barrel whose weight a browser-shaped or
 * config-shaped consumer cannot afford — arriving one layer down.
 */

const here = dirname(fileURLToPath(import.meta.url));
const resolverRoot = resolve(here, "..", "..", "dependency-resolver");

/** The local specifiers a file imports, so the graph can be walked without resolving npm names. */
function relativeImportsOf(path: string): readonly string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/from\s+"(\.[^"]*)"/g)].map(match => match[1]!);
}

describe("`dependency-resolver/local` is a projection of the barrel, not a second surface", () => {
  it("exports every value the barrel exports for the modules it projects", () => {
    const localNames = Object.keys(local);
    // The control: the projection is non-empty, so the comparison is about something.
    expect(localNames.length).toBeGreaterThan(10);

    const barrelNames = new Set(Object.keys(barrel));
    const missing = localNames.filter(name => !barrelNames.has(name));

    // Everything reachable here is also reachable from the barrel. A name reachable *only* here
    // would make this entry a second public API rather than a projection of one.
    expect(missing).toEqual([]);
  });

  it("reaches no `rolldown`, which is the whole reason it exists", () => {
    // The graph is walked from `local.ts` through relative imports only, and the barrel is walked the
    // same way as a comparison — so the assertion is about this entry's closure rather than about
    // what the bundler happens to include.
    const reachedFromLocal = closureOf(join(resolverRoot, "src", "local.ts"));
    const reachedFromBarrel = closureOf(join(resolverRoot, "src", "index.ts"));

    // A path that imports `rolldown`: what the projection must not reach, and what the barrel does.
    const rolldownImporter = [...reachedFromBarrel].find(path => /from\s+"rolldown"/.test(readFileSync(path, "utf8")));
    expect(rolldownImporter, "the barrel no longer reaches rolldown, so this test is not measuring it").toBeDefined();
    expect(
      [...reachedFromLocal].some(path => /from\s+"rolldown"/.test(readFileSync(path, "utf8"))),
      "`local` reaches a module that imports rolldown, which is the cost it exists to avoid",
    ).toBe(false);

    // And the projection genuinely reaches the modules it names, so the walk is not vacuous.
    expect([...reachedFromLocal].some(path => path.endsWith("lock-store.ts"))).toBe(true);
    expect([...reachedFromLocal].some(path => path.endsWith("decision-conformance.ts"))).toBe(true);
  });
});

/** Every file reachable from `entry` through relative imports, including `entry`. */
function closureOf(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const walk = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of relativeImportsOf(path)) {
      // `../core/src/x.ts`-style escapes are outside this package and are not this test's question;
      // the projection's claim is about its own modules.
      // Only specifiers that already name a file are followed: this repository's convention is
      // that they all do (`relative-import-extension.test.ts` guards it repository-wide), and
      // resolving an extensionless one here would need node's algorithm rather than a join.
      if (!/\.[a-z]+$/i.test(specifier)) {
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (target.startsWith(resolverRoot)) {
        walk(target);
      }
    }
  };
  walk(entry);
  return seen;
}

describe("the two package entries are the ones the graph needs", () => {
  it("names its own files with extensions, which bare `vp dev` depends on", () => {
    // `local.ts` names its files with extensions like every other relative import in this
    // repository, because Node's ESM loader does not do extension resolution and bare `vp dev`
    // loads a `vite.config.ts` that imports workspace TypeScript. `relative-import-extension.test.ts`
    // scans `packages/**` and so covers this file already; this asserts the same thing one level
    // lower, where the reason is visible, rather than relying on that scan being run.
    for (const specifier of relativeImportsOf(join(resolverRoot, "src", "local.ts"))) {
      expect(specifier.endsWith(".ts") || specifier.endsWith(".tsx"), specifier).toBe(true);
    }
  });
});
