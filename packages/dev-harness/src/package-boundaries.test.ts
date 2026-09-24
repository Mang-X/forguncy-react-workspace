import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A package's `src/` may only import what its `dependencies` declare.
 *
 * Decision source: GitHub Issue #23 —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/23, where the rule was broken and a
 * review found it.
 *
 * ## The defect, and why a comment could not have caught it
 *
 * `local-decision-projection.ts` began importing `@forguncy-react-workspace/dependency-resolver/local`
 * from `src/` while that package sat in `devDependencies`. The harness plugin loads through a
 * project's `vite.config.ts`, so a production or filtered install that omits devDependencies would
 * fail while *loading the config* — before Vite starts, with a module-resolution error that names
 * the harness rather than the missing package.
 *
 * The `package.json` comment above the entry said the opposite of what was true by then: "`src/`
 * must not import this package; a test may". A comment is a claim nothing checks, and this one was
 * written by the same change that broke it — which is the argument for asserting the rule rather
 * than restating it.
 *
 * ## What is asserted, in both directions
 *
 * 1. **Every workspace package `src/` imports is a `dependencies` entry.** A `devDependencies`-only
 *    import is the defect above; a missing entry entirely is worse, since it only works while some
 *    other package's install happens to hoist it.
 * 2. **Nothing in `devDependencies` is reachable from `src/`.** The same rule stated from the other
 *    side, so a transitive path cannot slip past by importing a module that is not the dependency's
 *    own entry — `dependency-resolver/local` is exactly that shape, a subpath the package name
 *    lookup would miss if the check only compared names.
 *
 * ## Scope, and why it is not every package
 *
 * `dev-harness` is where the rule was broken and where the cost is paid, because its `src/` is
 * loaded into *another project's* config graph. The check is written over the workspace so it covers
 * any package, and the scan is over relative imports so it does not need a resolver — the same
 * technique `dependency-resolver-local.test.ts` and `relative-import-extension.test.ts` use for
 * graphs a bundler would otherwise be needed to inspect.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..", "..");

/** The workspace packages, by directory name, with their manifests. */
function workspacePackages(): readonly {
  readonly directory: string;
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
  readonly devDependencies: ReadonlySet<string>;
}[] {
  const packagesRoot = join(repositoryRoot, "packages");
  return readdirSync(packagesRoot)
    .filter(entry => statSync(join(packagesRoot, entry)).isDirectory())
    .map(entry => {
      const manifestPath = join(packagesRoot, entry, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return {
        directory: join(packagesRoot, entry),
        name: manifest.name,
        dependencies: new Set(Object.keys(manifest.dependencies ?? {})),
        devDependencies: new Set(Object.keys(manifest.devDependencies ?? {})),
      };
    });
}

/** The bare package names `src/` imports, including subpath entries and type-only imports. */
function bareImportsIn(srcDirectory: string): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) {
          visit(path);
        }
        continue;
      }
      // Tests are excluded on purpose, and it is the whole distinction the rule turns on: a test may
      // import a devDependency, `src/` may not. This is the sentence the stale comment got wrong.
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/from\s+"([^".][^"]*)"/g)) {
        const specifier = match[1]!;
        // A workspace package's subpath resolves to its own package name: `@scope/name/sub` is
        // provided by `@scope/name`. Scoped names have two segments, everything else one.
        const segments = specifier.split("/");
        found.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!);
      }
    }
  };
  visit(join(srcDirectory, "src"));
  return found;
}

describe("a package's `src/` imports only what its `dependencies` declare", () => {
  it("declares every package `src/` reaches, and reaches no devDependency", () => {
    const packages = workspacePackages();
    // The control: the scan found the workspace, so a passing assertion is about these packages
    // rather than about an empty list.
    expect(packages.length).toBeGreaterThan(5);

    const problems: string[] = [];
    let sawAWiredImport = false;

    for (const pkg of packages) {
      const imported = bareImportsIn(pkg.directory);
      for (const name of imported) {
        // Only workspace packages are this rule's business: a published dependency's placement is
        // decided by `fgc.lock.json` and #4's strategy table, not by this test.
        if (!name.startsWith("@forguncy-react-workspace/")) {
          continue;
        }
        // A package's own name is not a boundary violation, and it appears here from *generated
        // source* rather than from an import: `vite-plugin.ts` emits modules whose text contains
        // `from "@forguncy-react-workspace/dev-harness/mount"`, and this scan reads files as text.
        // Telling code from string content by pattern is not a solved problem — `cell-compiler`'s
        // `source-guard.ts` says so and uses a real parser for the same reason — so this check
        // excludes the case it cannot read correctly rather than reporting a false violation.
        if (name === pkg.name) {
          continue;
        }
        sawAWiredImport = true;
        if (pkg.devDependencies.has(name)) {
          problems.push(`${pkg.name}: src/ imports ${name}, which is a devDependency`);
          continue;
        }
        if (!pkg.dependencies.has(name)) {
          problems.push(`${pkg.name}: src/ imports ${name}, which is not declared in dependencies`);
        }
      }
    }

    // The control for the check itself: at least one package's `src/` imports a workspace package,
    // so "no problems" is the result of comparing something. Without this the test would pass for a
    // scanner that found no imports at all.
    expect(sawAWiredImport, "no workspace import was found, so the rule was never exercised").toBe(true);
    expect(problems).toEqual([]);
  });

  it("finds the harness's own resolver edge, so the check is about a live dependency", () => {
    // The case that motivated this file, asserted positively: without it, the test above could pass
    // for a package whose `src/` imports nothing at all — and it is the specific edge a reviewer had
    // to find by hand, so it is worth naming where it is now checked.
    const harness = workspacePackages().find(pkg => pkg.name === "@forguncy-react-workspace/dev-harness");
    expect(harness, "the dev-harness package is missing from the workspace scan").toBeDefined();

    const imported = bareImportsIn(harness!.directory);
    expect(imported).toContain("@forguncy-react-workspace/dependency-resolver");
    expect(harness!.dependencies).toContain("@forguncy-react-workspace/dependency-resolver");
    expect(harness!.devDependencies).not.toContain("@forguncy-react-workspace/dependency-resolver");
  });

  it("keeps the resolver's conformance audit independent of the compiler's plan", () => {
    // #52's validation plan asks for this to be asserted rather than assumed. The reason the
    // host-bridge plan's `wireable` field cannot change the resolver's audit is structural:
    // `decision-conformance.ts` derives `DEFAULT_HOST_BRIDGE_MANIFEST` from `core`'s
    // `HOST_BRIDGE_MAPPINGS`, and `core` is the only workspace package the resolver may reach.
    // So the plan is not merely unused here — it is unreachable, and a change that made the
    // audit consume the plan would have to break the package boundary to do it.
    const resolver = workspacePackages().find(pkg => pkg.name === "@forguncy-react-workspace/dependency-resolver");
    expect(resolver, "the dependency-resolver package is missing from the workspace scan").toBeDefined();

    const imported = [...bareImportsIn(resolver!.directory)].filter(name =>
      name.startsWith("@forguncy-react-workspace/"),
    );
    expect(imported).toEqual(["@forguncy-react-workspace/core"]);
  });
});
