/**
 * The Vite+ integration for Forguncy React Cells.
 *
 * Governing Spec Issues: #22 (local Vite+ dev runtime) and #26 (project
 * configuration); implementation Issue: #28 wires the registry, #23 owns the dev
 * harness itself.
 *
 * Why the plugin takes a *config object* and not a config file path: under Vite+
 * the project's `vite.config.ts` imports `forguncy.config.ts` directly, so Vite+
 * loads it with the very same runtime it already uses for its own config. Making
 * the plugin load the file again would create the second config runtime Spec #26
 * forbids, and would let the plugin and the Vite build disagree about which config
 * was in effect.
 *
 * The plugin is typed structurally instead of importing Vite's `Plugin` type so
 * this package does not pin the toolchain version: any host that accepts the Vite
 * plugin shape (`name` plus lifecycle hooks) can load it.
 */

import {
  createCellRegistry,
  ForguncyConfigError,
  isCellRegistry,
} from "@forguncy-react-workspace/core";
import type { CellRegistry, ForguncyConfig, RegisteredCell } from "@forguncy-react-workspace/core";

export interface ForguncyPluginOptions {
  /**
   * "cell" selects cell-artifact mode for the local dev harness (Issue #23).
   * It does not change how Cells are resolved.
   */
  readonly mode?: "cell";
  /**
   * The already-loaded `forguncy.config.ts`, or a registry normalized elsewhere.
   *
   * Omit it only when something else in the pipeline will supply the registry;
   * otherwise `resolveCell` has nothing to resolve against and says so.
   */
  readonly config?: ForguncyConfig | CellRegistry;
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
}

export interface ForguncyPluginApi {
  /** The normalized registry, once the host has revealed its project root. */
  registry(): CellRegistry | undefined;
  /** Resolves a Cell, or reports that no config was supplied. */
  resolveCell(cellId: string): RegisteredCell;
}

/**
 * The subset of the Vite plugin contract this plugin needs.
 *
 * `configResolved` is the first hook that carries the resolved project root, which
 * is why normalization waits for it: resolving entries against anything else would
 * bind the registry to the wrong directory.
 */
export interface ForguncyVitePlugin {
  readonly name: string;
  readonly api: ForguncyPluginApi;
  configResolved(config: { readonly root: string }): void;
}

export const FORGUNCY_PLUGIN_NAME = "forguncy-react-workspace";

export function forguncy(options: ForguncyPluginOptions = {}): ForguncyVitePlugin {
  const requireEntryFiles = options.requireEntryFiles ?? true;
  let registry: CellRegistry | undefined;

  const api: ForguncyPluginApi = {
    registry: () => registry,
    resolveCell: cellId => {
      if (registry === undefined) {
        throw new ForguncyConfigError(
          [
            {
              code: "config-missing-cells",
              path: "config",
              message:
                "No forguncy config was supplied to the plugin yet. Pass `config: forguncyConfig` (imported from forguncy.config.ts) so Cells can be resolved.",
            },
          ],
          FORGUNCY_PLUGIN_NAME,
        );
      }
      return registry.require(cellId);
    },
  };

  return {
    name: FORGUNCY_PLUGIN_NAME,
    api,
    configResolved(config) {
      if (options.config === undefined) {
        return;
      }

      registry = isCellRegistry(options.config)
        ? options.config
        : createCellRegistry(options.config, { root: config.root, requireEntryFiles });
    },
  };
}
