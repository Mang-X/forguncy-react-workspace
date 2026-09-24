import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

import { DEV_HARNESS_PLUGIN_NAME } from "./vite-plugin.ts";

/**
 * #67's mechanism, pinned: Vite's **default** config loader can resolve the workspace TypeScript
 * that `examples/dev-harness/vite.config.ts` imports.
 *
 * Decision sources: GitHub Issues
 * - #67 — "Implement: bare `vp dev` for the local Cell harness (configLoader / workspace
 *   TypeScript resolution)" (https://github.com/Mang-X/forguncy-react-workspace/issues/67)
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose first acceptance
 *   criterion this closes
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose Developer workflow
 *   spells the loop as `vp dev`
 *
 * ## What this file is, and what it is not
 *
 * A review of this PR found this test does not execute the acceptance path its name implies, and
 * that finding was correct — the docstring here previously stopped one step short of saying so.
 * It calls `vite.loadConfigFromFile(..., "bundle")`, so it proves the config graph loads under
 * *Vite's* bundle loader. It cannot speak for the `vp dev` **command**: this file imports
 * `vite@8.3.0`, while `vp dev` resolves `vite` to `@voidzero-dev/vite-plus-core` — different
 * packages — so a regression in Vite+'s target selection or its forwarding would leave this green.
 *
 * The command half lives in `vp-dev-command.test.ts`, which spawns `vp dev` and expects the
 * plugin's mount node and entry in the served page. Keep both: this file explains and pins the
 * *mechanism* (which loader resolves what, and why the extension convention is what makes it
 * work), and that one asserts the public command. Deleting this in favour of the command test
 * would lose the assertions below about how far the config's workspace closure actually reaches;
 * deleting that one in favour of this would let the command regress unnoticed.
 *
 * The repo-wide *convention* is a third scope again — `relative-import-extension.test.ts` — since
 * neither of these sees an extensionless import in `cell-compiler`, `dependency-resolver` or
 * `mcp-sync`.
 *
 * ## The failure this explains, measured
 *
 * Vite's default `configLoader` is `bundle`. It bundles `vite.config.ts` and **externalizes every
 * bare import that resolves into `node_modules`** — which includes this repository's workspace
 * packages, because pnpm links them there and their `exports` point at `.ts` source. The config
 * is then handed to Node's ESM loader, which does not do extension resolution: `./dep.ts` loads
 * and `./dep` does not. So a single extensionless relative import anywhere in the config's
 * workspace closure makes bare `vp dev` die before Vite starts, with
 *
 * ```
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/core/src/ownership'
 * ```
 *
 * That is why every relative import in `packages/**` and `examples/**` names its file with a
 * `.ts`/`.tsx` extension, and why the root `tsconfig.json` sets `allowImportingTsExtensions`.
 *
 * ## Why this is behavioural and not a grep for the convention
 *
 * A test that read the sources looking for extensionless specifiers would be a *second copy* of
 * the rule, and it would answer the wrong question: it would describe what the sources look like,
 * not whether the toolchain can load them. This calls `loadConfigFromFile` with
 * `configLoader: "bundle"` — Vite's documented default — so it fails for the reason the loader
 * would fail.
 *
 * That is also why the assertion is on the *evaluated* config rather than on "did not throw".
 * Evaluating this config imports `forguncy.config.ts` (which imports `core`) and
 * `@forguncy-react-workspace/dev-harness` (which imports `runtime` and `vite-plugin-fgc`), so the
 * harness plugin appearing in the result with its host substitution plan filled in is evidence
 * that four workspace packages of TypeScript *ran*. A config that resolved to an empty object
 * would satisfy an absence-of-error assertion and prove nothing.
 *
 * The config path is read from `examples/dev-harness` rather than invented, because that example
 * *is* the case #22 names.
 *
 * Deliberately **not** asserted: that the server starts (that is `vp-dev-command.test.ts`), that
 * a Cell mounts in a browser, or that HMR preserves state. The latter two were verified by hand
 * for this PR and are still owed to a real page; #20/#25 own that.
 */
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..", "..", "..", "examples", "dev-harness");
const configFile = join(exampleRoot, "vite.config.ts");

/** The config environment Vite hands `loadConfigFromFile` for a dev server. */
const DEV_CONFIG_ENV = {
  mode: "development",
  command: "serve",
  isSsrBuild: false,
  isPreview: false,
} as const;

/** The plugin names Vite resolved, flattened over the nested arrays the config declares. */
async function loadedPluginNames(): Promise<readonly string[]> {
  const loaded = await loadConfigFromFile(DEV_CONFIG_ENV, configFile, exampleRoot, "silent", undefined, "bundle");
  const plugins: readonly unknown[] = loaded?.config.plugins ?? [];

  return plugins
    .flat(2)
    .map(entry => (entry === null || typeof entry !== "object" ? undefined : (entry as { name?: unknown }).name))
    .filter((name): name is string => typeof name === "string");
}

describe("bare `vp dev` can load the harness example's config with Vite's default loader", () => {
  it("loads the config under `configLoader: 'bundle'`, the value `vp dev` uses", async () => {
    const loaded = await loadConfigFromFile(DEV_CONFIG_ENV, configFile, exampleRoot, "silent", undefined, "bundle");

    expect(loaded).not.toBeNull();
    // The config *evaluated* rather than merely resolving: `defineConfig` returned an object and
    // the harness plugin is in it. This is the weakest of the three assertions here; the two
    // below are what make it evidence.
    expect(loaded?.config.plugins?.length).toBeGreaterThan(0);
  });

  it("ran the workspace packages the config graph reaches, rather than loading a config that names nothing", async () => {
    // The harness plugin's *presence* is `dev-harness` having run. Its `config()` result is
    // merged by Vite, so a plugin object that arrived here came through the module graph the
    // failure was in.
    expect(await loadedPluginNames()).toContain(DEV_HARNESS_PLUGIN_NAME);
  });

  it("produced the host substitution plan, which is `core` and `runtime` having run too", async () => {
    const loaded = await loadConfigFromFile(DEV_CONFIG_ENV, configFile, exampleRoot, "silent", undefined, "bundle");
    const finds = aliasFindsOf(loaded?.config.resolve?.alias);

    // #9's host table projected through `runtime` (#22), reached from `core` — the deep end of
    // the config's workspace closure. `react` is decided `host`, so it is substituted; `antd` is
    // decided `host` but is not installed here, so the plan points it at the harness's
    // "unavailable" virtual module rather than silently leaving the bare specifier.
    //
    // Asserted as membership rather than equality: the plan is a table upstream owns, and
    // pinning its whole contents here would make this test refuse a legitimate edit to #9's
    // decisions — which are not this Issue's subject.
    expect(finds).toContain("react");
    expect(finds).toContain("antd");
  });
});

/**
 * Every `find` in a resolved `resolve.alias`, whichever form the config declared.
 *
 * Vite accepts both an array of `{ find, replacement }` and a plain object mapping, and it keeps
 * the shape it was given here — the example spreads the harness plan in, so what arrives depends
 * on how that plan is built. Reading one form would make this assertion depend on a detail of the
 * harness's return type rather than on the substitution being present.
 */
function aliasFindsOf(alias: unknown): readonly string[] {
  if (Array.isArray(alias)) {
    return alias.map(entry => (typeof entry === "string" ? entry : String((entry as { find: unknown }).find)));
  }
  if (alias !== null && typeof alias === "object") {
    return Object.keys(alias);
  }
  return [];
}

