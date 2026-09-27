import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCellRegistry, ForguncyConfigError } from "./cell-registry.ts";
import { hostBridgeInterceptedModuleIds } from "./host-bridge.ts";
import { normalizeResolveConfig, RESOLVE_CONFIG_FIELD } from "./resolve-config.ts";

/**
 * Issue #97's first acceptance criterion, at the layer that can actually enforce it: "one
 * registry/alias configuration drives local and production actual resolution, with no implicit
 * second set of defaults".
 *
 * The rule this file pins has two halves, and both are measured rather than assumed. Against Vite
 * 8.3.0 and Rolldown 1.2.9:
 *
 * - a **plain string key** resolves identically in both engines — `importee === key ||
 *   startsWith(key + "/")` — so it is the one key shape this block accepts;
 * - a **pattern key** does not: Vite supports a `RegExp` (or a `"/re/"` string), and Rolldown's
 *   `resolve.alias` is a plain string-keyed map that matches nothing for one. A pattern is
 *   therefore refused *by name* rather than passed through, because passing it through is exactly
 *   the local-pass/production-ignore divergence #97 exists to remove;
 * - the same is true of a **trailing slash**: Vite strips it, Rolldown keeps it and so matches
 *   nothing. That one is a spelling difference, so it is normalized rather than refused.
 *
 * The tests assert the *normalized* object, because that object is what both consumers read —
 * `createRolldownCellBundler({ alias })` on the build side and the harness's `resolveId` on the
 * dev side. Asserting the config's own literals would leave "what each consumer is handed" unpinned,
 * which is the half a second normalization would break.
 */

const PROJECT_ROOT = join("C:", "repos", "sales-portal");

function resolveOf(config: unknown): ReturnType<typeof normalizeResolveConfig> {
  return normalizeResolveConfig(config, { root: PROJECT_ROOT });
}

/** The normalized alias map, or a failure naming the diagnostics rather than the type error. */
function aliasOf(config: unknown): Readonly<Record<string, string>> {
  const result = resolveOf(config);
  if (!result.ok) {
    throw new Error(
      `Expected this config's alias block to normalize; it was refused with:\n${result.diagnostics
        .map(diagnostic => `  - ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return result.resolve.alias;
}

/** The diagnostic codes a config produces, for the refusal cases. */
function codesOf(config: unknown): readonly string[] {
  const result = resolveOf(config);
  return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code);
}

describe("the project's alias block normalizes to one set both engines take", () => {
  it("resolves every target against the project root", () => {
    // Absolute, because that is the only form both engines accept: Vite resolves a relative
    // replacement against its own root, and Rolldown throws on one outright. Resolving here is what
    // makes one declared string mean the same file on both paths.
    expect(aliasOf({ resolve: { alias: { "@/lib": "./src/lib", "~": "./src" } } })).toEqual({
      "@/lib": join(PROJECT_ROOT, "src", "lib"),
      "~": join(PROJECT_ROOT, "src"),
    });
  });

  it("normalizes a trailing slash on both sides the way Vite does, so Rolldown agrees", () => {
    // Measured: Rolldown keeps the slash and matches nothing at all, while Vite strips both sides
    // and prefix-matches. Stripping here is what makes the two agree rather than merely coexist.
    //
    // A package the bridge does not own is the subject, because a bridged id is refused outright —
    // see the conflict test below.
    expect(aliasOf({ resolve: { alias: { "echarts/": "./vendor/echarts/" } } })).toEqual({
      echarts: join(PROJECT_ROOT, "vendor", "echarts"),
    });
  });

  it("reads the array form Vite also accepts", () => {
    // A block copied out of a `vite.config.ts` should work rather than be refused as an unknown
    // shape — the two containers mean one thing, and only one of them is representable in Rolldown.
    expect(aliasOf({ resolve: { alias: [{ find: "@/lib", replacement: "./src/lib" }] } })).toEqual({
      "@/lib": join(PROJECT_ROOT, "src", "lib"),
    });
  });

  it("takes no default when the config declares nothing", () => {
    // Deliberately unlike `extensions.mappings`, whose absent state contributes the shipped table:
    // there is no shipped alias to contribute. An alias appearing from nowhere would be the
    // "implicit second set of defaults" #97 forbids, so the empty set is stated as empty.
    for (const config of [{}, { cells: {} }, { resolve: {} }, { resolve: { alias: {} } }]) {
      const result = resolveOf(config);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.resolve.alias).toEqual({});
      expect(result.resolve.entries).toEqual([]);
    }
  });

  it("keeps the project's declaration order in the report", () => {
    // The map is unordered for matching (see `projectAliasTarget`, which takes the longest match
    // rather than the first), but a report that reordered a project's own lines would be hard to
    // diff against the config it came from.
    const result = resolveOf({ resolve: { alias: { "~": "./src", "@/lib": "./src/lib" } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolve.entries.map(entry => entry.find)).toEqual(["~", "@/lib"]);
    expect(result.resolve.entries[0]?.replacement).toBe("./src");
  });
});

describe("what the alias block refuses, and why the refusal is the honest answer", () => {
  it("refuses a pattern alias, naming the engine that cannot honour it", () => {
    // Three spellings, and the reason differs between them, which is why the assertions are split.
    //
    // An **object** key is a literal in Vite (measured: neither `"/^@\\/lib/"` nor `"^@/lib$"`
    // matched anything), so those two would silently alias nothing. A **`RegExp`** in the array
    // form is genuinely honoured by Vite and has no Rolldown equivalent, so that one really would
    // resolve locally and fail in the artifact. Both are refused; neither is accepted silently.
    for (const pattern of ["/^@\\/lib/", "^@/lib$", "^@/lib"]) {
      expect(codesOf({ resolve: { alias: { [pattern]: "./src/lib" } } })).toEqual([
        "unsupported-resolve-alias-pattern",
      ]);
    }

    expect(codesOf({ resolve: { alias: [{ find: /^@\/lib$/, replacement: "./src/lib" }] } })).toEqual([
      "unsupported-resolve-alias-pattern",
    ]);
  });

  it("refuses a host-bridged module id, because the two engines order it oppositely", () => {
    // Measured, and the ordering is what makes this a refusal rather than a warning. Vite applies
    // the user's `resolve.alias` *before* a plugin's `resolveId`, while Rolldown applies the plugin
    // `resolveId` hook (where #9's bridge intercepts) *before* `resolve.alias`. So an alias on a
    // bridged id would win locally and lose in the artifact — one import, two modules.
    const [bridged] = hostBridgeInterceptedModuleIds();
    expect(bridged, "the bridge table is empty, so this test would be vacuous").toBeDefined();

    expect(codesOf({ resolve: { alias: { [bridged!]: "./shims/react" } } })).toEqual([
      "host-module-alias-conflict",
    ]);
  });

  it("accepts a subpath of a bridged package that the bridge does not intercept", () => {
    // The control for the check above: the refusal is on the *intercepted* ids, not on the package
    // name. `react-dom/server` is the documented case of an id the bridge deliberately leaves
    // unaliased, so a project may point it wherever it likes.
    const bridged = hostBridgeInterceptedModuleIds();
    expect(bridged).not.toContain("react-dom/server");
    expect(aliasOf({ resolve: { alias: { "react-dom/server": "./src/ssr-shim" } } })).toEqual({
      "react-dom/server": join(PROJECT_ROOT, "src", "ssr-shim"),
    });
  });

  it("refuses a bare-specifier target, because the engines resolve it from different places", () => {
    // A module-id redirect, not a path. Rolldown resolves the replacement through `node_modules`
    // from the *importing file* and Vite from the *project root*, so the same declaration two-hops
    // differently. Reported rather than reinterpreted, since neither reading is what the author
    // necessarily meant.
    expect(codesOf({ resolve: { alias: { "old-lib": "new-lib" } } })).toEqual([
      "nonportable-resolve-alias-target",
    ]);
  });

  it("leaves a machine-specific target to the document-wide portability pass", () => {
    // The entry is dropped — no machine path is a project-relative one — but the *finding* belongs
    // to the whole-document walk in `cell-registry`, which reports it as `machine-specific-path`
    // with the project-wide rule behind it. Reporting it here too would make one mistake read as
    // two, which is the convention `cell-registry`'s `resolveDeclaredPath` states for a declared
    // path. So this module is silent and the alias set is simply empty of that entry.
    const result = resolveOf({ resolve: { alias: { "@/lib": "C:\\abs\\lib", "@ok": "./src" } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolve.alias).toEqual({ "@ok": join(PROJECT_ROOT, "src") });

    // And the registry, where the document walk runs, does report it — once.
    let thrown: unknown;
    try {
      createCellRegistry(
        { cells: {}, resolve: { alias: { "@/lib": "C:\\abs\\lib" } } },
        { root: PROJECT_ROOT, requireEntryFiles: false },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForguncyConfigError);
    expect([...(thrown as ForguncyConfigError).codes]).toEqual(["machine-specific-path"]);
  });

  it("refuses a key that is a path rather than a module id", () => {
    expect(codesOf({ resolve: { alias: { "./src/lib": "./src/lib" } } })).toEqual(["invalid-resolve-alias"]);
    expect(codesOf({ resolve: { alias: { "": "./src/lib" } } })).toEqual(["invalid-resolve-alias"]);
  });

  it("refuses a target pointing at the project root itself", () => {
    // An alias to `.` would make the entire project importable under one id, which is a way to
    // defeat the entry/containment rules by accident rather than a way to shorten an import.
    expect(codesOf({ resolve: { alias: { "@": "." } } })).toEqual(["invalid-resolve-alias"]);
    expect(codesOf({ resolve: { alias: { "@": "./" } } })).toEqual(["invalid-resolve-alias"]);
  });

  it("refuses a key with a trailing slash the engines do not strip", () => {
    // Measured: Vite strips a trailing slash only when the *target* has one too, and Rolldown keeps
    // the key as written. So `{ "~/": "./src" }` matches nothing in either engine. A plain strip
    // would "fix" it by activating an alias the project never really declared, which is worse than
    // saying what is wrong.
    expect(codesOf({ resolve: { alias: { "~/": "./src" } } })).toEqual(["invalid-resolve-alias"]);
  });

  it("names the allowed fields when the block carries something else", () => {
    // Vite options that have no Cell-build equivalent are refusals with a reason, because a Cell is
    // one IIFE: an option the build cannot honour would change local resolution only.
    const result = resolveOf({ resolve: { dedupe: ["react"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-resolve-field"]);
    expect(result.diagnostics[0]?.message).toContain("Allowed fields: alias");
  });

  it("still reports an unknown field when no alias is declared beside it", () => {
    // The regression the first version had: the "no alias key" early return produced a success and
    // dropped the diagnostic the loop above had just pushed, so `{ resolve: { dedupe: [...] } }`
    // reported nothing at all. An absent `alias` is not an absent error.
    const result = resolveOf({ resolve: { conditions: ["browser"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-resolve-field"]);
  });

  it("refuses a non-object block and a non-object alias, as config errors rather than crashes", () => {
    expect(codesOf({ resolve: [] })).toEqual(["invalid-resolve-config"]);
    expect(codesOf({ resolve: { alias: "src" } })).toEqual(["invalid-resolve-alias"]);
  });
});

describe("the registry carries the normalized alias set", () => {
  function registryOf(config: unknown) {
    return createCellRegistry(config, { root: PROJECT_ROOT, requireEntryFiles: false });
  }

  it("exposes it as `registry.resolve`, absolute and normalized", () => {
    // On the registry rather than re-read by each consumer, so the dev server and the build cannot
    // normalize one config file twice and disagree — which is the whole point of putting it here.
    const registry = registryOf({ cells: {}, resolve: { alias: { "@/lib": "./src/lib" } } });

    expect(registry.resolve.alias).toEqual({ "@/lib": join(PROJECT_ROOT, "src", "lib") });
  });

  it("reports every alias problem and every Cell problem in one pass", () => {
    // The convention the rest of the config follows: a config with two mistakes costs one round
    // trip, not two. A bad alias and a bad Cell entry must therefore arrive together.
    let thrown: unknown;
    try {
      registryOf({
        cells: { orderList: { entry: "./cells/a.ts", target: { pageName: "P", cell: "A1" }, bogus: 1 } },
        resolve: { alias: { "@/lib": "some-package" } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForguncyConfigError);
    const codes = [...(thrown as ForguncyConfigError).codes].sort();
    expect(codes).toEqual(["nonportable-resolve-alias-target", "unknown-cell-field"]);
  });

  it("keeps `unknown-config-field` from claiming an aliased block is unknown", () => {
    // The control for adding the field to `CONFIG_ALLOWED_FIELDS`: without that, a project with a
    // valid alias block would be refused for having one.
    expect(RESOLVE_CONFIG_FIELD).toBe("resolve");
    expect(() => registryOf({ cells: {}, resolve: { alias: { "@/lib": "./src/lib" } } })).not.toThrow();
  });
});
