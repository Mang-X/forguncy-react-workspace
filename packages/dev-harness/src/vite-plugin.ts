/**
 * The dev harness's Vite plugin: it turns a project's declared Cells into a running
 * React dev server.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), and its Spec,
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), under
 * - #26 "project configuration and React Cell target declarations"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 *
 * ## What this plugin is, in one sentence
 *
 * It takes the Cells a project already declared and serves them as ordinary React, so a
 * developer edits the *artifact's* source and sees the result without a Forguncy sync.
 *
 * Everything it needs already exists and is reused rather than re-derived:
 *
 * - the **Cell** comes from `virtual:forguncy/cell/<id>` (`vite-plugin-fgc`, #28), which
 *   honours `cells.<id>.entry` and refuses an entry that exposes no component, naming the
 *   exports it does have. This plugin never resolves an entry path itself — that would be a
 *   second answer to "which file is this Cell", and the two would come apart the first time
 *   a config was validated differently;
 * - the **host substitutions** come from #9's bridge table via `runtime`'s projection
 *   (`host-modules.ts`), so the dev server and the artifact agree about what the page
 *   provides;
 * - the **mock** comes from the Cell's own `fixture` (#28's contract, consumed by
 *   `mount.ts`), resolved through the façade's provider port (#27).
 *
 * ## One object, and why
 *
 * {@link devHarness} returns the whole plugin: the hooks that describe the project (`name`,
 * `configResolved`) and the ones that serve it (`config`, `resolveId`, `load`,
 * `transformIndexHtml`). It is deliberately not split into a "data half" and a "hooks half" —
 * see the function's own docstring for the draft that made that mistake and the silent failure
 * it produced.
 *
 * ## What is refused rather than guessed
 *
 * - **No Cell declared.** An empty `cells` map is legal in the config (a project may have
 *   none yet), but it leaves the harness with nothing to mount, so it says so instead of
 *   serving a blank page that reads like a broken Cell.
 * - **An unknown `cellId`.** Resolved through `registry.require`, so the failure names the
 *   ids that do exist.
 * - **A bridged id the harness has no copy of.** It is still aliased — to a module that throws
 *   the explanation at the import site (`unavailableHostModuleSource`) — so the failure lands on
 *   the `import` that needs the package instead of blocking configuration for a whole project,
 *   and the id can never quietly take the ordinary npm path.
 */

import react from "@vitejs/plugin-react-swc";

// `ForguncyConfigError` only, because the harness never normalizes a config itself: it composes
// `forguncy()` (#28) and reads the registry that plugin produced. `createCellRegistry` and
// `isCellRegistry` were imported here in an earlier draft that normalized the config in this
// file, which would have been a second answer to a question the Cell seam already answers.
import { ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, ForguncyConfig, RegisteredCell } from "@forguncy-react-workspace/core";
import { cellVirtualModuleId, forguncy } from "@forguncy-react-workspace/vite-plugin-fgc";

import {
  hostModuleAliases,
  hostModuleDedupePackages,
  hostPackageVersionMismatches,
  unavailableHostModuleOf,
  unavailableHostModuleSource,
} from "./host-modules.ts";

/** The DOM element the mount script renders into. */
export const HARNESS_MOUNT_ELEMENT_ID = "forguncy-cell-root";

export interface DevHarnessOptions {
  /**
   * The project's `forguncy.config.ts`, already loaded by the host.
   *
   * An object rather than a path, for #28's reason, which applies here unchanged: under
   * Vite+ the project's `vite.config.ts` imports `forguncy.config.ts` directly, so Vite
   * loads it with the very runtime it uses for its own config. Making the plugin load the
   * file again would create the second config runtime #26 forbids, and would let the plugin
   * and the Vite build disagree about which config was in effect.
   */
  readonly config: ForguncyConfig | CellRegistry;
  /**
   * The Cell to mount.
   *
   * Omitted means the project's first declared Cell, which is the common case for a
   * single-Cell example and keeps `vp dev` free of arguments.
   */
  readonly cellId?: string;
  /**
   * Mock props for the mounted Cell, merged over the fixture's `cellProps`.
   *
   * For seeing a state a fixture does not encode — a denied permission, an empty list —
   * without editing the fixture each time. The values go through the mock's own provider
   * options, so a key #5 never verified is refused there rather than here.
   *
   * Deliberately not a way to supply `ServerCommands` or data sources: those are call
   * shapes rather than values (#27), and the merge is shallow and JSON-shaped. A command
   * belongs in the fixture, where it is typed and where its absence is a recorded decision.
   */
  readonly props?: Partial<Record<string, unknown>>;
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
}

/**
 * The plugin's own view of itself, typed structurally like `vite-plugin-fgc`'s.
 *
 * Structural rather than Vite's `Plugin` type so this package does not pin the toolchain
 * version: any host accepting the Vite plugin shape (`name` plus lifecycle hooks) can load it,
 * which is what `vite-plugin-fgc` does for the same reason and what lets a test drive the hooks
 * directly. The members are exactly the hooks this harness implements and no more — a wider
 * interface would be a claim about hooks nothing here defines.
 */
export interface DevHarnessVitePlugin {
  readonly name: string;
  /** Claims the generated entry before Vite's own resolver decides it is a missing file. */
  readonly enforce: "pre";
  /** The registry and the mounted Cell, once the host has revealed its project root. */
  readonly api: {
    registry(): CellRegistry | undefined;
    mountedCell(): RegisteredCell | undefined;
  };
  configResolved(config: { readonly root: string; readonly plugins: readonly { readonly name: string }[] }): void;
  /**
   * The host-substitution aliases, the dedupe list and the optimizer inclusions.
   *
   * Takes the user's config because the aliases have to be filtered against it: Vite merges this
   * result *over* the project's config, so an unconditional alias here would silently replace a
   * project's own. See {@link unclaimedHostAliases}.
   *
   * Deliberately no `plugins` member: see {@link REACT_FAST_REFRESH_PLUGIN_NAME} for why a
   * plugin cannot supply one, and {@link reactFastRefresh} for what a project does instead.
   */
  config(userConfig: { readonly resolve?: { readonly alias?: unknown } }): {
    readonly resolve: { readonly alias: Readonly<Record<string, string>>; readonly dedupe: readonly string[] };
    readonly optimizeDeps: { readonly include: readonly string[] };
  };
  /** Claims the harness entry URL path and any unserved host substitution. */
  resolveId(id: string): string | null;
  /** Generates the mount module, or an explanation, or `null` for ids this plugin does not own. */
  load(id: string): string | null;
  /**
   * Adds the mount node and the entry script to the page.
   *
   * Returns Vite's tag-injection form rather than a rewritten HTML string, so the harness never
   * has to find an insertion point in the project's own template. See the implementation for the
   * silent-green failure the string form caused.
   */
  transformIndexHtml(): {
    readonly html: string;
    readonly tags: readonly {
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly injectTo: "body";
    }[];
  };
}

export const DEV_HARNESS_PLUGIN_NAME = "forguncy-dev-harness";

/**
 * The plugin name React Fast Refresh registers under, which is what makes it detectable.
 *
 * `@vitejs/plugin-react-swc` names its transform `vite:react-swc`, and detecting it by name is
 * the only way to tell "Fast Refresh is wired" from "the Cell is being transformed by some other
 * JSX transform" — the two look identical from inside a module's source, since Oxc's JSX
 * transform also emits `jsxDEV`. That similarity is exactly why this constant and
 * {@link formatFastRefreshWarning} exist: the failure mode is a *green* one.
 */
export const REACT_FAST_REFRESH_PLUGIN_NAME = "vite:react-swc";

/**
 * React Fast Refresh, for a project to put in its own `plugins` array.
 *
 * ## Why this is exported rather than installed by the harness
 *
 * The harness cannot wire it, and the reason is a Vite behaviour worth recording because it is
 * silent: **plugins returned from a plugin's `config()` hook are never registered.** Vite
 * collects `userPlugins` and then calls `runConfigHook` over *that array*; the hook's return
 * value is merged into the config object, but the final `resolved.plugins` is still the array
 * built before the hook ran. Verified against Vite 8.3.0's source and with a real server: an
 * inner plugin returned from `config()` appears in neither `server.config.plugins` nor
 * `transformRequest`'s output.
 *
 * The first draft of this plugin returned `plugins: [react()]` from its `config()` hook with a
 * comment claiming Fast Refresh. The comment was wrong in the most expensive way: the Cell still
 * rendered, `jsxDEV` was still present (from Oxc), and only the *state preservation* was
 * missing — so `useState` reset on every edit and the loop was a full page reload wearing HMR's
 * name. A silent degradation, which is what {@link formatFastRefreshWarning} is for.
 *
 * So the project adds it, which is ordinary Vite usage, and it needs no extra dependency:
 * re-exporting the plugin means a project imports both from this package.
 *
 * ## Why Fast Refresh, rather than Vite's default
 *
 * Vite's built-in JSX transform (Oxc) rewrites a module without registering it with React's
 * refresh runtime, so editing a Cell's source replaces the module and React remounts the
 * subtree — the page keeps running, but every `useState` in the edited component resets. Fast
 * Refresh is what makes an edit preserve state, which is the difference between iterating on a
 * form or a chart and re-navigating to the same state after every keystroke.
 *
 * This is a `local`-only concern and it adds no claim: it changes the *loop*, not the artifact.
 * The compiled Cell carries no refresh runtime, and `dev-harness-example.test.ts` asserts that
 * the artifact built from this same source has none.
 */
export function reactFastRefresh(): readonly unknown[] {
  return react();
}

/**
 * The message a missing Fast Refresh produces, or `undefined` when it is wired.
 *
 * Phrased as a warning rather than a refusal, for the reason `LOCAL_DEV_DIAGNOSTIC_RULES` gives
 * about version mismatches: the loop still *works* — the Cell renders, HMR still updates it — so
 * refusing to start would trade a degraded loop for no loop. What must not happen is the silent
 * version, where a developer concludes that HMR cannot preserve state and works around a
 * limitation that is really a missing line in their config.
 *
 * It names the fix in code, because the fix is one line and the reader is the person who can add
 * it. It also says what is *not* broken, so nobody goes looking for a bug in the harness.
 */
export function formatFastRefreshWarning(pluginNames: readonly string[]): string | undefined {
  if (pluginNames.includes(REACT_FAST_REFRESH_PLUGIN_NAME)) {
    return undefined;
  }

  return [
    "React Fast Refresh is not wired, so this loop runs on Vite's default JSX transform.",
    "",
    "What that means: the Cell renders and HMR still updates it, but editing a component remounts it, so every useState in the edited component resets. Nothing is broken and nothing is misconfigured in the harness — Fast Refresh is a plugin this project has to add itself.",
    "",
    "To enable it, put the one this package re-exports next to the harness in your vite.config.ts:",
    "",
    '  import { devHarness, reactFastRefresh } from "@forguncy-react-workspace/dev-harness";',
    "  export default defineConfig({ plugins: [reactFastRefresh(), devHarness({ config: forguncyConfig })] });",
    "",
    "The harness cannot add it for you: Vite ignores `plugins` returned from a plugin's `config()` hook, so returning it from there would look wired and do nothing.",
  ].join("\n");
}

/**
 * The URL path the generated page script is served at.
 *
 * A URL path rather than the `virtual:`-style specifier the Cell seam uses, and the reason is
 * mechanical rather than a preference: Vite's HTML pipeline handles a `<script src>` by
 * resolving that URL through the module graph, and it does not resolve an `@id/`-style virtual
 * id there — the request falls through to the SPA fallback, so the page silently loads HTML as
 * JavaScript. A path this plugin's own `resolveId`/`load` claim end to end is what Vite can
 * serve to a browser. Verified against a real dev server, not assumed.
 *
 * Still a *path* and not a file, so the page carries no machine path — the same rule #28 applies
 * to the Cell entry, and for the same reason: a committed template or a pasted log must not
 * embed one developer's directory layout.
 */
export const HARNESS_ENTRY_URL_PATH = "/@forguncy-dev-harness/entry.js";

/** The ids the dev server must serve from this package's own copies. */
export function harnessHostModulePlan(): {
  readonly aliases: Readonly<Record<string, string>>;
  readonly dedupe: readonly string[];
} {
  return { aliases: hostModuleAliases(), dedupe: hostModuleDedupePackages() };
}

/**
 * The host aliases a project has *not* already claimed for itself.
 *
 * Vite merges a plugin's `config()` result over the user's config, so an alias emitted here can
 * win against the project's own — which is wrong for the one case the split exists to support: a
 * project deliberately pointing a host package somewhere else (a patched React, a local fork).
 * Dropping the ids the project already claims is what turns `harnessHostModulePlan()` from a
 * duplicate of this hook into an actual override.
 *
 * ## Claiming is a *prefix* relation, not equality
 *
 * Vite decides whether an alias entry matches an import with:
 *
 * ```js
 * importee === pattern || importee.startsWith(pattern + "/")
 * ```
 *
 * so naming `react` claims `react/jsx-runtime` and `react/jsx-dev-runtime` as well. Filtering by
 * exact equality was therefore wrong, and the fix is to reproduce Vite's rule in
 * {@link isClaimedBy} rather than invent a simpler one.
 *
 * ## Why only the array form actually broke, which is worth recording
 *
 * The merge order differs by form, so the same bug had different consequences. Measured against
 * Vite 8.3.0 with a real server, with the harness emitting its own `react/jsx-dev-runtime` entry
 * beside a project claiming `react`:
 *
 * | project's `resolve.alias` | entries, in evaluation order | bare `react` | `react/jsx-dev-runtime` |
 * | --- | --- | --- | --- |
 * | object `{ react: "/patched" }` | `[react, react/jsx-dev-runtime]` | project | **project** |
 * | array `[{ find: "react" }]` | `[react/jsx-dev-runtime, react]` | project | **harness** |
 *
 * With the object form Vite produces the project's entry *first*, so its prefix match wins the
 * subpath and the exact-equality filter was harmless. With the array form the harness's entry
 * comes first and wins — the project got its patched React for the bare import and the harness's
 * stock React for every JSX runtime import. That asymmetry is why a resolution-level test is
 * needed and an alias-list assertion is not enough: in the object case the list looks fine, and in
 * the array case it also looks fine, because the defect is in evaluation order rather than in
 * contents.
 *
 * ## The three forms, and what changed for RegExps
 *
 * - **object form** (`{ react: "/path" }`) — the keys, normalized then matched by the prefix rule;
 * - **array string `find`** — normalized then matched by the prefix rule;
 * - **array `RegExp` `find`** — matched by `pattern.test(importee)`, which is what Vite itself
 *   does with it. This replaces an earlier conservative version that ignored RegExps, reasoning
 *   that which ids they match is undecidable. It is decidable: the question is not what the
 *   expression *means* but whether it matches each of the finite host ids, and `test` answers
 *   that. Ignoring them was wrong in the direction that matters — a project's `find: /^react$/`
 *   override would have been beaten by the harness exactly as the array string case was.
 *
 * ## Why the string form is normalized before matching
 *
 * A third review round found that matching the `find` *as written* is still not the same question
 * as matching the `find` Vite uses, because Vite normalizes a trailing slash off both `find` and
 * `replacement` when both carry one. `{ find: "react/", replacement: "/patched-react/" }` is a
 * valid alias, and matching `"react/"` claims neither `react` nor `react/jsx-dev-runtime`, so the
 * harness kept its exact aliases and the project's override did nothing at all — worse than the
 * subpath-only failure the previous round found.
 *
 * The rule is reproduced rather than approximated: stripping the slash unconditionally would
 * decline to alias on behalf of `{ find: "react/", replacement: "/patched-react" }`, which Vite
 * does *not* normalize and whose prefix rule therefore matches nothing — leaving a project with no
 * React at all. Both conditions are Vite's, so both are reproduced, in both alias forms.
 *
 * Each round of this filter has shared one shape, and it is worth naming because the next change
 * here should watch for it: the filter decides by *reimplementing* a rule Vite already owns, so it
 * is only ever as correct as its reproduction — equality instead of prefix, then prefix without
 * normalization, then normalization in one form and not the other. The tests that guard it
 * therefore assert through `pluginContainer.resolveId` rather than against the alias list, since
 * every one of the first two defects was invisible in the list.
 *
 * An `undefined` or unreadable `userAlias` claims nothing, so a bare `devHarness({ config })`
 * with no `resolve.alias` of its own still gets the full plan.
 */
function unclaimedHostAliases(userAlias: unknown): Record<string, string> {
  const patterns = readAliasPatterns(userAlias);

  return Object.fromEntries(
    Object.entries(hostModuleAliases()).filter(([moduleId]) => !patterns.some(pattern => isClaimedBy(pattern, moduleId))),
  );
}

/**
 * Every alias `find` the user's config declares, as Vite will see it, in either shape.
 *
 * Both forms are read because Vite accepts either and a project may use whichever. A member that
 * is not a usable pattern — an array entry that is not an object, an object key that is empty —
 * is dropped rather than guessed at; an unreadable pattern claims nothing, which leaves the
 * harness's alias in place.
 *
 * Both forms are also normalized, and the fourth round's documentation fix is why that is stated
 * rather than implied. An earlier version of this comment claimed object-form aliases "have no
 * such rule", on the reasoning that this module reads only the keys of a `{ key: value }` map. The
 * rule is not in the reading, it is in Vite: object entries are converted to `{ find, replacement }`
 * pairs by `Object.entries` and then run through the same `normalizeSingleAlias`, so
 * `{ "react/": "/patched-react/" }` really does become `find: "react"`. Measured against Vite
 * 8.3.0 — the entry arrives as `react` and both `react` and `react/jsx-dev-runtime` resolve to the
 * project's path.
 *
 * Reproducing it in both branches matters even though the *bug* it caused was array-only. An
 * object-form alias with trailing slashes was still misjudged by the filter — the harness kept its
 * own `react` entry alongside the project's, and the resolution happened to be right only because
 * the project's entry is merged first. Two entries for one id disagreeing about nothing is a
 * latent failure, not a working state, and `vite-plugin.test.ts` asserts on the entry set for this
 * case rather than on the resolved id, precisely because the id looked fine either way.
 *
 * Returning patterns of one type rather than a `{ find, replacement }` record keeps
 * `isClaimedBy`'s contract as simple as the string-or-RegExp question it actually asks.
 */
function readAliasPatterns(userAlias: unknown): readonly unknown[] {
  if (Array.isArray(userAlias)) {
    return userAlias
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map(entry => {
        const { find, replacement } = entry;
        if (typeof find === "string") {
          return normalizeAliasFind(find, replacement);
        }
        return find;
      })
      .filter(find => find !== undefined);
  }

  if (typeof userAlias === "object" && userAlias !== null) {
    // `Object.entries` then normalize, which is Vite's own order for a map: it converts the map to
    // pairs first (`getEntries`) and only then strips the slashes. Normalizing before splitting
    // would produce the same answer for these keys, but following Vite's order keeps the two
    // readable side by side.
    return Object.entries(userAlias as Record<string, unknown>)
      .map(([key, value]) => (key.length === 0 ? undefined : normalizeAliasFind(key, value)))
      .filter(key => key !== undefined);
  }

  return [];
}

/**
 * Whether one alias pattern claims a module id, by Vite's own rule.
 *
 * The regular-expression branch is Vite's too, including `test` (not `match`, and no anchoring of
 * its own): reproducing the rule is the point, because a filter that decided differently from the
 * resolver would be a filter that disagrees with the thing it is compensating for — which is how
 * the equality bug got through. A pattern that matches partially, so that the user's replacement
 * of `react` would be applied to `react/jsx-dev-runtime` as a *string* concatenation, is still a
 * claim: Vite will use the user's entry for that id, whoever's replacement it produces.
 *
 * The `lastIndex` save/restore is not tidiness. `test` on a `/g` or `/y` pattern is stateful — it
 * advances `lastIndex` on a match and resets it on a miss — so asking a caller's own RegExp would
 * make *this* function's call count decide what Vite's later resolution sees: a project writing
 * `find: /react/g` would get an override that applied on every other import. Restoring the
 * property leaves the pattern exactly as the project handed it over, which is what a predicate
 * borrowed from someone else's object owes them.
 *
 * The pattern arrives already normalized — see {@link normalizeAliasFind} for why that has to
 * happen before matching rather than being folded in here.
 */
function isClaimedBy(pattern: unknown, moduleId: string): boolean {
  if (pattern instanceof RegExp) {
    const { lastIndex } = pattern;
    try {
      return pattern.test(moduleId);
    } finally {
      pattern.lastIndex = lastIndex;
    }
  }
  if (typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  return moduleId === pattern || moduleId.startsWith(`${pattern}/`);
}

/**
 * A string alias `find` as Vite will see it, which is not always as the project wrote it.
 *
 * Vite 8.3's `normalizeSingleAlias` strips a trailing slash from **both** `find` and
 * `replacement` when **both** end in one:
 *
 * ```js
 * if (typeof find === "string" && find.endsWith("/") && replacement.endsWith("/")) { … slice both … }
 * ```
 *
 * The filter runs earlier than that, so a project writing the perfectly valid
 *
 * ```ts
 * { find: "react/", replacement: "/patched-react/" }
 * ```
 *
 * handed this module the pattern `"react/"`, which matches neither `react` nor
 * `react/jsx-dev-runtime`. The harness concluded the project claimed nothing, kept its own exact
 * aliases, and — because Vite merges the plugin's aliases *before* the user's array and only then
 * normalizes — those exact entries won the resolution. Measured against Vite 8.3.0: with that
 * alias in the array form, **both** `react` and `react/jsx-dev-runtime` resolved to the harness's
 * stock React, so the project's override did nothing at all rather than only failing for subpaths.
 *
 * Reproducing the normalization is the whole fix. Two half-versions are worth ruling out
 * explicitly, because both look reasonable and both are wrong:
 *
 * - **Stripping the trailing slash unconditionally** would claim ids on behalf of an entry Vite
 *   never normalizes. `{ find: "react/", replacement: "/patched-react" }` — one slash, not two —
 *   keeps `find: "react/"` in Vite, whose prefix rule then matches nothing, so the project has
 *   claimed nothing and the harness must keep its substitutions. Stripping anyway would leave the
 *   project with no React at all: the harness would decline to alias on behalf of an entry that
 *   resolves nothing. (That one-slash form is arguably a project mistake, but it is not this
 *   module's to correct, and guessing would trade one silent failure for another.)
 * - **Requiring the slash on `replacement` only** is the same error in a different place; both
 *   conditions are Vite's, so both are reproduced.
 *
 * `replacement` is passed in solely to reproduce that condition — the value is never used for
 * matching, which is why the parameter is documented rather than typed as optional.
 *
 * Exported for `vite-plugin.test.ts` to assert directly, which is unusual for a helper this small
 * and is deliberate: the *conditionality* is the whole content of the fix, and it is not
 * observable through resolution. Both the correct implementation and an unconditional strip
 * produce the same resolved module for `{ find: "react/", replacement: "/patched-react" }` — the
 * user's entry claims nothing either way, so the harness's own alias serves the id in both. The
 * difference is only whether the pattern is claimed, which is why the guard asserts on this
 * function rather than on a resolved id.
 */
export function normalizeAliasFind(find: string, replacement: unknown): string {
  if (find.endsWith("/") && typeof replacement === "string" && replacement.endsWith("/")) {
    return find.slice(0, -1);
  }
  return find;
}

/**
 * The message a version mismatch produces, or `undefined` when the install matches.
 *
 * Exported so a test asserts the wording and a caller can decide where it goes. Not a gate
 * on the loop: #22's own diagnostic rule records that this condition does not block local
 * development (`blocksLocalDevelopment: false`), because refusing to start would be the
 * harness deciding that a difference it cannot weigh matters more than the developer's
 * time. It is reported because a Cell developed against a different React version is not
 * evidence about this target, and the two fixes — a stale install, a newer host — differ.
 */
export function formatHostVersionWarning(): string | undefined {
  const mismatches = hostPackageVersionMismatches();
  if (mismatches.length === 0) {
    return undefined;
  }

  return [
    "The dev harness's own install is not at the version #5 recorded for this target:",
    ...mismatches.map(
      mismatch =>
        `  - ${mismatch.packageName}: installed ${mismatch.installed ?? "(absent)"}, #5 recorded ${mismatch.field} = ${mismatch.expected}`,
    ),
    "",
    "Local UI feedback still works, and it is not evidence about this target: a Cell developed against a different React version says nothing about the page. Align this package's dependency or re-probe the target (#5).",
  ].join("\n");
}

/**
 * The generated page script.
 *
 * Generated rather than authored as a file so the Cell id travels with the mount call and
 * the browser half stays a pure function a test can call directly. The import specifier is
 * the Cell's *virtual module id*, so #28's guards (`unknown-cell-id`,
 * `entry-outside-project-root`, "no component export") fire here as they do for any other
 * consumer instead of being re-implemented.
 *
 * The Cell module is imported and handed to `mountCell` whole, which is what keeps this
 * file free of any assumption about how a Cell exports its component: `mount.ts` reads
 * `cell.Cell`, `cell.fixture` and `cell.cellId`, and #28's generated module is what
 * guarantees those names mean what the harness thinks.
 */
function generateEntryModule(cell: RegisteredCell, overlay: Readonly<Record<string, unknown>> | undefined): string {
  const hasOverlay = overlay !== undefined && Object.keys(overlay).length > 0;

  // The whole message is built here and JSON-encoded once. Interpolating an encoded value *into*
  // a quoted literal is how the first draft produced `... so Cell "salesSummary" has nowhere ...`
  // — valid prose, invalid JavaScript, and a page that fails to parse for a reason nothing in the
  // message explains.
  const missingNodeMessage =
    `The dev harness mount node #${HARNESS_MOUNT_ELEMENT_ID} is not in the page, so Cell "${cell.id}" has nowhere to render. ` +
    `The harness plugin adds it in transformIndexHtml; a page template that removed it would do this.`;

  return [
    `// Generated by ${DEV_HARNESS_PLUGIN_NAME} for Cell "${cell.id}". Do not edit.`,
    `import { mountCell } from "@forguncy-react-workspace/dev-harness/mount";`,
    `import * as cell from ${JSON.stringify(cellVirtualModuleId(cell.id))};`,
    ``,
    `const element = document.getElementById(${JSON.stringify(HARNESS_MOUNT_ELEMENT_ID)});`,
    `if (element === null) {`,
    `  throw new Error(${JSON.stringify(missingNodeMessage)});`,
    `}`,
    ``,
    `const mounted = mountCell(cell, {`,
    `  element,`,
    ...(cell.fixturePath === undefined ? [] : [`  fixturePath: ${JSON.stringify(cell.fixturePath)},`]),
    // The overlay travels into the mount call so it is merged into the *mock's options*, where
    // `mock-provider` validates which keys are legal — not passed beside them, which would route
    // it around the check that keeps a mock no wider than the host.
    ...(hasOverlay ? [`  propsOverlay: ${JSON.stringify(overlay)},`] : []),
    `});`,
    ``,
    `// On the global for the browser console and for a targeted test, so what the loop`,
    `// installed can be inspected without a debug branch in authored source.`,
    `globalThis.__forguncyDevHarness = mounted;`,
    ``,
    `export default mounted;`,
  ].join("\n");
}

/**
 * The harness as a Vite plugin.
 *
 * One function, not a "data half" plus a "hooks half", and the reason is a mistake this file
 * made in its first draft: the data half looked like a complete plugin (it has `name`,
 * `configResolved` and `transformIndexHtml`), so an example wired it up, the page rendered its
 * mount node and a script tag — and the script tag 404'd into the SPA fallback, because the
 * module hooks lived in the other function. A plugin that *looks* finished and silently serves
 * HTML as JavaScript is worse than one that is obviously incomplete, so the two are one object
 * and the only way to get the mount is to get the module graph with it.
 *
 * `enforce: "pre"` because the generated entry has to be claimed before Vite's own
 * `vite:resolve` decides it is a missing file — the id is a URL path with nothing behind it.
 */
export function devHarness(options: DevHarnessOptions): DevHarnessVitePlugin {
  const requireEntryFiles = options.requireEntryFiles ?? true;
  // Only `dedupe` is read here: the aliases are derived inside `config()`, because they have to
  // be filtered against the user's own alias settings, which are not available until then.
  const { dedupe } = harnessHostModulePlan();
  let registry: CellRegistry | undefined;
  let mounted: RegisteredCell | undefined;

  // The Cell seam (#28), created once and *delegated to* rather than merely asked for its
  // registry. Its `resolveId`/`load` are what turn `virtual:forguncy/cell/<id>` into the Cell's
  // module, and this plugin's generated entry imports that id — so a harness that composed only
  // its `configResolved` would resolve the Cell to nothing and fail with Vite's "failed to
  // resolve ... Does the file exist?" instead of with the seam's own diagnostics. One instance,
  // not one per hook call, so it holds one registry.
  const cells = forguncy({ config: options.config, requireEntryFiles });

  return {
    name: DEV_HARNESS_PLUGIN_NAME,
    enforce: "pre",

    api: {
      registry: () => registry,
      mountedCell: () => mounted,
    },

    configResolved(config) {
      // The plugin list is final here — every plugin's `config()` has been merged by now — so this
      // is the first (and only) place the loop can honestly report whether React Fast Refresh is
      // wired. Asking anywhere else would report a missing plugin for a project that added it,
      // which is the kind of false warning that teaches people to ignore warnings.
      const fastRefreshWarning = formatFastRefreshWarning(config.plugins.map(plugin => plugin.name));
      if (fastRefreshWarning !== undefined) {
        // The same channel as the version warning, and for the same reason: it is a startup
        // notice about the loop, not output of the Cell.
        process.stderr.write(`${fastRefreshWarning}\n`);
      }

      // The nested plugin is handed the same config value, so nothing is normalized twice:
      // whichever of the two runs `configResolved` first owns the registry, and the harness
      // reads the same normalized object either way.
      cells.configResolved(config);
      registry = cells.api.registry();
      if (registry === undefined) {
        return;
      }

      if (options.cellId !== undefined) {
        mounted = registry.require(options.cellId);
        return;
      }

      const [first] = registry.cells;
      if (first === undefined) {
        throw new ForguncyConfigError(
          [
            {
              code: "config-missing-cells",
              path: "cells",
              message:
                "The dev harness has no Cell to mount: this project's config declares none. Add one under `cells` (see Spec #26), or pass `cellId` explicitly — `vp dev`'s whole purpose here is to run one Cell's source.",
            },
          ],
          DEV_HARNESS_PLUGIN_NAME,
        );
      }
      mounted = first;
    },

    config(userConfig) {
      // No `plugins` here, and that is the whole point of `formatFastRefreshWarning`: Vite
      // ignores plugins returned from a `config()` hook, so a `react()` returned here would be a
      // line that reads as Fast Refresh and does nothing. See `reactFastRefresh` for the
      // verified mechanism and for what a project does instead.
      //
      // `resolve.alias` *is* emitted here, but only for the ids the project has not claimed —
      // and that filter is a review finding, not a first-draft nicety. The harness used to return
      // every host alias unconditionally while also exporting `harnessHostModulePlan()` for the
      // project to spread into its own config, which reads as belt-and-braces and is actually a
      // silent override: Vite merges a `config()` result with `mergeConfig(conf, res)`, and
      // object-form `resolve.alias` merges key-by-key with the *later* value winning, so this
      // hook — which runs after the user's config — replaced every entry it named. A project that
      // deliberately pointed `react` at a patched build found its alias silently ignored, which
      // is exactly the failure the example's comment claimed the split prevented. Verified
      // against Vite 8.3.0 with a real server: a user `react` alias came back as the plugin's.
      //
      // Keeping the aliases here (rather than deleting them and making the project responsible)
      // is deliberate: a project that never calls `harnessHostModulePlan()` still gets a working
      // harness, which is the common case and the one a bare `devHarness({ config })` should
      // serve. The filter is what makes the export an *override* rather than a duplicate.
      //
      // `dedupe` and `optimizeDeps.include` need no such filter: both are arrays, and Vite
      // concatenates array config values instead of replacing them (verified: a user
      // `dedupe: ["user-pkg"]` beside this hook's yields both), so they cannot drop a project's
      // entries.
      return {
        resolve: {
          alias: unclaimedHostAliases(userConfig.resolve?.alias),
          // Covers the ids the bridge deliberately leaves unaliased — `react-dom/server` is
          // the case that matters — so a second copy cannot reach the same page.
          dedupe,
        },
        optimizeDeps: {
          // The host packages are *included* — forced through the optimizer — and that is the
          // opposite of what this harness did in its first draft, which excluded them on the
          // reasoning that a pre-bundled copy would be a different module instance from the one
          // the alias binds. That reasoning was backwards, and the failure it caused is worth
          // recording: `react`'s published entry is CommonJS, so an excluded package is served to
          // the browser raw, with no interop — and the first `import { createElement } from
          // "react"` dies with "does not provide an export named 'createElement'", a message about
          // React that is really about the optimizer being switched off.
          //
          // Pre-bundling is what *creates* the single instance: the optimizer resolves the
          // alias, interops the CJS package once, and every importer gets that one module.
          // Excluding a package is for sources that must not be pre-bundled (a plugin's own
          // virtual modules, a package with side effects at import time), which is not this case.
          include: [...dedupe],
        },
      };
    },

    resolveId(id) {
      // Returned as itself rather than `\0`-prefixed: this id is served to a browser, and a
      // resolved id beginning with NUL tells the rest of Vite "never look this up on disk".
      // The id is a URL path this plugin owns end to end, so claiming it here is enough —
      // there is no file behind it to shadow.
      if (id === HARNESS_ENTRY_URL_PATH) {
        return id;
      }
      // An unserved host substitution: recognised here and loaded below, so the failure it
      // describes happens at the authored `import` rather than in Vite's resolver with a
      // message about a missing dependency.
      if (unavailableHostModuleOf(id) !== undefined) {
        return `\0${id}`;
      }
      // Everything else, including the Cell's own `virtual:forguncy/cell/<id>`, is the Cell
      // seam's business. Delegated rather than re-implemented: the seam owns the guards
      // (`unknown-cell-id`, `entry-outside-project-root`, "no component export"), and a second
      // answer here would be exactly the drift this plugin exists to avoid.
      return cells.resolveId(id);
    },

    load(id) {
      const unavailable = unavailableHostModuleOf(id.startsWith("\0") ? id.slice(1) : id);
      if (unavailable !== undefined) {
        return unavailableHostModuleSource(unavailable);
      }

      if (id !== HARNESS_ENTRY_URL_PATH) {
        return cells.load(id);
      }
      if (mounted === undefined) {
        throw new Error(
          "The dev harness entry was requested before its Cell was resolved, so there is nothing to mount. That means `configResolved` did not run, which only happens outside a Vite server.",
        );
      }
      return generateEntryModule(mounted, options.props);
    },

    transformIndexHtml() {
      const warning = formatHostVersionWarning();
      if (warning !== undefined) {
        // To stderr rather than into the page: the page is what a developer is looking at when
        // they are looking at the Cell, and a warning printed there would be read as part of the
        // Cell's own output. stderr is where Vite's other startup notices go.
        process.stderr.write(`${warning}\n`);
      }

      // The mount node, then the module that fills it — returned as *tags* for Vite to inject
      // rather than spliced into the HTML string, and that is a review finding rather than a
      // style preference.
      //
      // The first version did `html.replace("</body>", ...)`, which is a no-op for any template
      // whose closing body tag is absent, upper-case, or formatted with whitespace inside it —
      // and every one of those is valid HTML. The server still started and the page still
      // served, so the failure was a *green* one: no mount node, no entry script, a blank page,
      // and nothing in the output to say why. That is precisely the silent-green shape this
      // package exists to avoid, so it was the wrong mechanism even though it worked for the
      // example's own template.
      //
      // `injectTo: "body"` is Vite's own answer and it needs no closing tag to exist: verified
      // against Vite 8.3.0 with a real server and a template whose `</body>` was omitted
      // entirely — both tags were still injected, appended after the existing content. It also
      // means the harness never rewrites the project's HTML, so a template's own formatting
      // survives untouched.
      //
      // The element id comes from this module rather than from the template, so a project's
      // `index.html` cannot disagree with the generated script about where the Cell renders.
      //
      // Annotated rather than inferred: without the type, TypeScript widens the two different
      // `attrs` shapes into a union whose members each carry the *other's* keys as `undefined`,
      // which does not satisfy the interface's `Record<string, string>`.
      const tags: readonly {
        readonly tag: string;
        readonly attrs: Readonly<Record<string, string>>;
        readonly injectTo: "body";
      }[] = [
        { tag: "div", attrs: { id: HARNESS_MOUNT_ELEMENT_ID }, injectTo: "body" },
        { tag: "script", attrs: { type: "module", src: HARNESS_ENTRY_URL_PATH }, injectTo: "body" },
      ];

      return { html: "", tags };
    },
  };
}

