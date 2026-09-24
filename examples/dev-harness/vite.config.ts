import { defineConfig } from "vite-plus";

import forguncyConfig from "./forguncy.config.ts";
import { devHarness, harnessHostModulePlan, reactFastRefresh } from "@forguncy-react-workspace/dev-harness";

/**
 * `vp dev` in this example: the harness, the config, and nothing else.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * ## The config file is *imported*, not loaded
 *
 * That is #26's rule and it is why the harness takes a config *object*: under Vite+ the
 * project's `vite.config.ts` imports `forguncy.config.ts` itself, so Vite loads it with the very
 * runtime it already uses for its own config. Handing the harness a path would make it load the
 * file a second time, creating the second config runtime #26 forbids and letting the plugin and
 * the build disagree about which config was in effect.
 *
 * ## Why the host aliases appear here *and* in the plugin
 *
 * `harnessHostModulePlan()` is called in this file and fed to the server's `resolve` settings.
 * That is the project taking ownership of the substitution, which is what makes an override
 * possible at all: this file naming `react` is how a developer points it at a patched build, and
 * reading the plan here also makes the substitution visible in the project's own config — where
 * a developer looks when a bare import resolves somewhere unexpected.
 *
 * The plugin also emits the plan, but only for the ids this file has *not* named. That filter is
 * the fix for a review finding, and it is worth understanding both halves:
 *
 * - The plugin emitting nothing would make `devHarness({ config })` alone a broken harness — no
 *   host substitutions, so the first `import ... from "react"` fails. A bare plugin should work.
 * - The plugin emitting everything unconditionally was the actual bug. Vite merges a plugin's
 *   `config()` result *over* the user's config, key by key, with the later value winning — so an
 *   unconditional emission silently replaced the entry above, and a project's deliberate
 *   override would have been ignored while the comment here claimed it was honoured.
 *
 * So: this file's entries win, the plugin fills the rest, and neither can quietly undo the other.
 *
 * `optimizeDeps.include` needs no such care, and the asymmetry is not an oversight: it is an
 * array, and Vite concatenates array config values rather than replacing them, so the plugin's
 * additions cannot drop this file's. It is *include* rather than exclude for a related reason —
 * React's published entry is CommonJS, so an excluded package is served to the browser without
 * interop and the first named import from it fails. The optimizer is what resolves the alias,
 * interops the package once, and hands every importer that single instance.
 */
const { aliases, dedupe } = harnessHostModulePlan();

export default defineConfig({
  // `reactFastRefresh()` first, and it has to be here rather than inside `devHarness` for a
  // verified reason: Vite ignores `plugins` returned from a plugin's `config()` hook, so the
  // harness cannot add it on the project's behalf. Without it the Cell still renders and HMR
  // still updates it — but editing a component remounts it, so every `useState` resets, and the
  // harness prints that warning at startup. This one line is the difference between the two.
  plugins: [reactFastRefresh(), devHarness({ config: forguncyConfig })],
  resolve: {
    alias: aliases,
    dedupe,
  },
  optimizeDeps: {
    include: [...dedupe],
  },
});
