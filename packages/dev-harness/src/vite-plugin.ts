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
} from "./host-modules";

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
   * Deliberately no `plugins` member: see {@link REACT_FAST_REFRESH_PLUGIN_NAME} for why a
   * plugin cannot supply one, and {@link reactFastRefresh} for what a project does instead.
   */
  config(): {
    readonly resolve: { readonly alias: Readonly<Record<string, string>>; readonly dedupe: readonly string[] };
    readonly optimizeDeps: { readonly include: readonly string[] };
  };
  /** Claims the harness entry URL path and any unserved host substitution. */
  resolveId(id: string): string | null;
  /** Generates the mount module, or an explanation, or `null` for ids this plugin does not own. */
  load(id: string): string | null;
  /** Adds the mount node and the entry script to the page. */
  transformIndexHtml(html: string): string;
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
  const { aliases, dedupe } = harnessHostModulePlan();
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

    config() {
      // No `plugins` here, and that is the whole point of `formatFastRefreshWarning`: Vite
      // ignores plugins returned from a `config()` hook, so a `react()` returned here would be a
      // line that reads as Fast Refresh and does nothing. See `reactFastRefresh` for the
      // verified mechanism and for what a project does instead.
      return {
        resolve: {
          // The host substitutions, bound to this package's own copies. See `host-modules.ts`
          // for why the harness installs them rather than the example.
          alias: aliases,
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
          // Pre-bundling is what *creates* the single instance: the optimizer resolves the alias,
          // interops the CJS package once, and every importer gets that one module. Excluding a
          // package is for sources that must not be pre-bundled (a plugin's own virtual modules,
          // a package with side effects at import time), which is not this case.
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

    transformIndexHtml(html) {
      const warning = formatHostVersionWarning();
      if (warning !== undefined) {
        // To stderr rather than into the page: the page is what a developer is looking at when
        // they are looking at the Cell, and a warning printed there would be read as part of the
        // Cell's own output. stderr is where Vite's other startup notices go.
        process.stderr.write(`${warning}\n`);
      }

      // The mount node, then the module that fills it. The element id comes from this module
      // rather than from the template, so a project-provided `index.html` cannot disagree with
      // the generated script about where the Cell goes.
      return html.replace(
        "</body>",
        [
          `<div id="${HARNESS_MOUNT_ELEMENT_ID}"></div>`,
          `<script type="module" src="${HARNESS_ENTRY_URL_PATH}"></script>`,
          "</body>",
        ].join("\n"),
      );
    },
  };
}

