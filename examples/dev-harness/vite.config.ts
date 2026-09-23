import { defineConfig } from "vite-plus";

import forguncyConfig from "./forguncy.config";
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
 * ## Why the host aliases appear here
 *
 * `harnessHostModulePlan()` is called in this file and fed to the server's `resolve` settings,
 * rather than being installed by the plugin's own `config` hook. The reason is precedence:
 * Vite merges `resolve.alias` from configs with the file's own, and an example that wanted to
 * override one entry — to develop against a patched React, say — must be able to do so
 * *deliberately* instead of finding its override silently re-applied by the plugin. Reading the
 * plan here also makes the substitution visible in the project's own config, which is where a
 * developer looks when a bare import resolves somewhere unexpected.
 *
 * `optimizeDeps.include` is the other half of the same decision, and it is *include* rather than
 * exclude: React's published entry is CommonJS, so an excluded package is served to the browser
 * without interop and the first named import from it fails. The optimizer is what resolves the
 * alias, interops the package once and hands every importer that one module — which is the single
 * instance the harness needs. Both settings come from one derivation.
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
