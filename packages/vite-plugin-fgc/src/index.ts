/**
 * The Vite+ integration for Forguncy React Cells.
 *
 * Governing Spec Issues: #22 (local Vite+ dev runtime) and #26 (project
 * configuration); implementation Issue: #28 wires the registry and exposes the
 * guarded `virtual:forguncy/cell/<cellId>` seam a dev harness resolves Cell
 * modules through, #23 owns the dev harness itself.
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
 * plugin shape (`name` plus lifecycle hooks) can load it. The same rule governs
 * the virtual-module seam: `resolveId`/`load` implement the Vite convention
 * (`\0` marks a resolved virtual id so nothing tries to read it from disk), but
 * nothing here imports Vite to do it.
 */

import { relative, sep } from "node:path";

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
 *
 * `resolveId`/`load` are the Issue #28 dev seam: one Cell, one virtual module,
 * whose exports are the contract Issue #23's harness consumes (`cellId`,
 * `target` verbatim from the registry, the resolved `Cell` component, and the
 * Cell's `fixture` default export or `undefined`). A `fixture` of `undefined`
 * means "the Cell declares none" only when the registry declares no
 * `fixturePath`; when one is declared, the harness passes the `undefined`
 * through to `resolveCellFixtureOptions` with `{ cellId, fixturePath }`, so a
 * fixture module that failed to default-export fails as `fixture-absent`
 * instead of passing for "no fixture". They resolve and validate only —
 * mounting, HMR and `vp dev` belong to #23 and are not built here.
 */
export interface ForguncyVitePlugin {
  readonly name: string;
  readonly api: ForguncyPluginApi;
  configResolved(config: { readonly root: string }): void;
  /**
   * Maps `virtual:forguncy/cell/<cellId>` to its `\0`-prefixed resolved form,
   * applying the same guards `load` does — an unknown Cell, a missing registry,
   * and an entry (or fixture) outside the project root all fail here too.
   */
  resolveId(id: string): string | null;
  /** Generates the resolved virtual module, or `null` for ids this seam does not own. */
  load(id: string): string | null;
}

export const FORGUNCY_PLUGIN_NAME = "forguncy-react-workspace";

/** The public specifier a harness imports one Cell through. */
export const FORGUNCY_CELL_VIRTUAL_MODULE_PREFIX = "virtual:forguncy/cell/";

/**
 * The same prefix after resolution: the leading `\0` tells every downstream
 * plugin and the filesystem layer that this id is virtual.
 */
const RESOLVED_CELL_VIRTUAL_MODULE_PREFIX = `\0${FORGUNCY_CELL_VIRTUAL_MODULE_PREFIX}`;

/** The public specifier for one Cell's virtual module. */
export function cellVirtualModuleId(cellId: string): string {
  return `${FORGUNCY_CELL_VIRTUAL_MODULE_PREFIX}${cellId}`;
}

/**
 * The Cell id an id refers to, in either public or resolved (`\0`) form — or
 * `undefined` when the id is not this seam's business, which is the common case
 * in a module graph full of ordinary imports.
 */
export function virtualModuleCellId(id: string): string | undefined {
  if (id.startsWith(RESOLVED_CELL_VIRTUAL_MODULE_PREFIX)) {
    return id.slice(RESOLVED_CELL_VIRTUAL_MODULE_PREFIX.length);
  }
  if (id.startsWith(FORGUNCY_CELL_VIRTUAL_MODULE_PREFIX)) {
    return id.slice(FORGUNCY_CELL_VIRTUAL_MODULE_PREFIX.length);
  }
  return undefined;
}

/**
 * A project-root-relative POSIX specifier, i.e. `/cells/order-list/src/index.ts`.
 *
 * Root-relative rather than absolute: the generated module must not carry a
 * machine path (the registry already refuses entries outside the project root,
 * so root-relative is always inside), and POSIX because import specifiers are
 * URL-shaped even on Windows. The containment check below is belt-and-braces
 * for a hand-built registry object that skipped `createCellRegistry`'s own.
 */
function rootRelativeSpecifier(root: string, absolute: string, cellId: string, field: string): string {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new ForguncyConfigError(
      [
        {
          code: "entry-outside-project-root",
          path: `cells.${cellId}.${field}`,
          message: `The ${field} of Cell "${cellId}" resolves outside the project root ("${absolute}"), so it cannot be referenced from a generated module. Keep managed source inside the project.`,
        },
      ],
      FORGUNCY_PLUGIN_NAME,
    );
  }
  return `/${rel.split(sep).join("/")}`;
}

/**
 * The generated virtual module for one Cell.
 *
 * The shape of the contract, and why each piece is where it is:
 *
 * - `cellId` and `target` come verbatim from the registry, so a harness matches
 *   a Cell to its Forguncy destination without re-deriving anything;
 * - `Cell` resolves from the entry's default export, else its `App` export —
 *   both conventions exist in this repository (authored entries use
 *   `export function App()`, and a default export is the React norm) — and an
 *   entry with neither fails *at load*, listing what it does export, instead of
 *   rendering `undefined` on a page;
 * - `fixture` is the fixture module's default export, or `undefined` when the
 *   Cell declares none — the fixture consumption seam Issue #28 exists to prove;
 * - every import specifier is root-relative POSIX, never a machine path.
 */
function generateCellModule(cell: RegisteredCell, root: string): string {
  const entrySpecifier = rootRelativeSpecifier(root, cell.entryPath, cell.id, "entry");

  const lines = [
    `// Generated by ${FORGUNCY_PLUGIN_NAME} for Cell "${cell.id}". Do not edit.`,
    `import * as __entry from ${JSON.stringify(entrySpecifier)};`,
  ];

  if (cell.fixturePath !== undefined) {
    const fixtureSpecifier = rootRelativeSpecifier(root, cell.fixturePath, cell.id, "fixture");
    lines.push(`import * as __fixture from ${JSON.stringify(fixtureSpecifier)};`);
  }

  lines.push(
    `export const cellId = ${JSON.stringify(cell.id)};`,
    `export const target = ${JSON.stringify(cell.target)};`,
    `const __candidates = [__entry.default, __entry.App].filter(Boolean);`,
    `if (__candidates.length === 0) {`,
    `  throw new Error(`,
    `    ${JSON.stringify(
      `Cell "${cell.id}" (${entrySpecifier}) exposes no component: expected a default export or an "App" export. `,
    )} +`,
    `      \`Available exports: \${Object.keys(__entry).join(", ") || "(none)"}\`,`,
    `  );`,
    `}`,
    `export const Cell = __candidates[0];`,
    cell.fixturePath === undefined ? `export const fixture = undefined;` : `export const fixture = __fixture.default;`,
  );

  return lines.join("\n");
}

export function forguncy(options: ForguncyPluginOptions = {}): ForguncyVitePlugin {
  const requireEntryFiles = options.requireEntryFiles ?? true;
  let registry: CellRegistry | undefined;

  /** The one guard for "something asked for a Cell before config resolution". */
  const requireRegistry = (): CellRegistry => {
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
    return registry;
  };

  const api: ForguncyPluginApi = {
    registry: () => registry,
    resolveCell: cellId => requireRegistry().require(cellId),
  };

  /**
   * The one path both hooks take to a Cell: claim the id when it is this seam's,
   * require the registry, look the Cell up, and prove every path the generated
   * module will import stays inside the project root. Containment is checked
   * here — not only inside `generateCellModule` — so an out-of-root entry fails
   * at `resolveId`, the first hook that sees it, exactly like an unknown id.
   */
  const claimCellModule = (
    id: string,
  ): { readonly cell: RegisteredCell; readonly root: string } | null => {
    const cellId = virtualModuleCellId(id);
    if (cellId === undefined) {
      return null;
    }
    const active = requireRegistry();
    const cell = active.require(cellId);
    // The returned specifiers are discarded on purpose: this call *is* the
    // containment check; `generateCellModule` derives them again to write them.
    rootRelativeSpecifier(active.root, cell.entryPath, cell.id, "entry");
    if (cell.fixturePath !== undefined) {
      rootRelativeSpecifier(active.root, cell.fixturePath, cell.id, "fixture");
    }
    return { cell, root: active.root };
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
    resolveId(id) {
      const claim = claimCellModule(id);
      if (claim === null) {
        return null;
      }
      return `${RESOLVED_CELL_VIRTUAL_MODULE_PREFIX}${claim.cell.id}`;
    },
    load(id) {
      const claim = claimCellModule(id);
      if (claim === null) {
        return null;
      }
      return generateCellModule(claim.cell, claim.root);
    },
  };
}
