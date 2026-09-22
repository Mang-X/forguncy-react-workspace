/**
 * Loading `forguncy.config.ts` without standing up a second config runtime.
 *
 * Governing Spec Issue: #26 — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 * Implementation Issue: #28.
 *
 * The rule this file exists to obey: the config is plain project code, so it must
 * be loaded by the *host's* module runtime, not by a bespoke TypeScript config
 * transpiler bolted on here. Two host shapes therefore have to work:
 *
 * - **Vite+ / local dev (#23)** — the project's `vite.config.ts` imports
 *   `forguncy.config.ts` itself, so Vite+ bundles and loads it with the very same
 *   runtime it already uses for its own config. Nothing in this file runs, and
 *   `vite-plugin-fgc` receives the already-evaluated object.
 * - **MCP sync / CLI (#20)** — there is no Vite process, so the config has to be
 *   imported directly. That is what `loadForguncyConfig` is for: it resolves the
 *   file and hands it to the host's own ESM loader (`loadModule`), which defaults
 *   to a content-stamped dynamic `import()` and can be replaced by a host that
 *   already has a richer config loader (Vite+'s `loadConfigFromFile`, for
 *   instance) instead of this package shipping one.
 *
 * In both shapes the resulting document goes through exactly one normalization
 * path — `createCellRegistry` — so "which entry is which Forguncy Cell" has one
 * answer.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCellRegistry,
  ForguncyConfigError,
} from "./cell-registry";
import type { CellRegistry, ConfigDiagnostic, CreateCellRegistryOptions } from "./cell-registry";
import { FORGUNCY_CONFIG_FILE_CANDIDATES } from "./forguncy-config";

/**
 * Loads a config module and returns whatever it exported.
 *
 * The seam exists so a host can supply *its* loader. `MCP sync` has no reason to
 * reimplement TypeScript handling if the host already provides it, and no second
 * loader should ever be invented when one is available.
 */
export type ForguncyConfigModuleLoader = (configFile: string) => Promise<unknown> | unknown;

/**
 * The default loader: the importing runtime's own ESM loader, stamped with the
 * config's content hash.
 *
 * Correct for `.ts` whenever the host already strips/transpiles types (the Vite+
 * runner, or Node's own type stripping) — which is the same condition under which
 * the project's `vite.config.ts` would load. It is deliberately not a
 * transpiler: if a host cannot import a `.ts` config, that host should pass
 * `loadModule`.
 *
 * **Freshness contract.** Native `import()` caches by URL, so a long-lived
 * process — the MCP server of #20, a watch-mode CLI — that imported a config
 * once would otherwise keep seeing the old module after the file changed, and
 * sync to the old target. Appending the file's content hash to the module URL
 * makes every call observe the file's *current* content, while an unchanged file
 * still resolves to a cached module and costs nothing. The limit is stated
 * rather than papered over: modules the config itself imports keep their own
 * URLs and the host runtime's caching; a host that needs module-graph-wide
 * reload semantics passes `loadModule` and uses its own loader (Vite+'s
 * `loadConfigFromFile` reloads its module graph exactly this way).
 */
export const importForguncyConfigModule: ForguncyConfigModuleLoader = configFile => {
  const url = pathToFileURL(configFile).href;

  let content: Buffer;
  try {
    content = readFileSync(configFile);
  } catch {
    // Unreadable or missing: let the import itself report the failure, exactly
    // as a plain `import()` would, so the diagnostic path is unchanged.
    return import(url);
  }

  const stamp = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return import(`${url}?t=${stamp}`);
};

export interface FindForguncyConfigFileOptions {
  /** Absolute project root the config is resolved against. */
  readonly root: string;
  /** Explicit config file, absolute or relative to `root`. */
  readonly configFile?: string;
}

function isExistingFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Locates the config file.
 *
 * Returns `undefined` rather than throwing so the caller can report "not found"
 * together with the candidates it searched, which is the actionable half of the
 * message.
 */
export function findForguncyConfigFile(options: FindForguncyConfigFileOptions): string | undefined {
  const { root, configFile } = options;

  if (configFile !== undefined) {
    const absolute = isAbsolute(configFile) ? configFile : resolve(root, configFile);
    return isExistingFile(absolute) ? absolute : undefined;
  }

  for (const candidate of FORGUNCY_CONFIG_FILE_CANDIDATES) {
    const absolute = join(root, candidate);
    if (isExistingFile(absolute)) {
      return absolute;
    }
  }

  return undefined;
}

export interface LoadForguncyConfigOptions extends CreateCellRegistryOptions {
  /**
   * Explicit config file, absolute or relative to `root`.
   *
   * Omitted (the normal case) means the candidate search: `forguncy.config.ts`
   * first, then the `.mts`/`.mjs`/`.js` fallbacks.
   */
  readonly configFile?: string;
  /** Overrides the module loader. Defaults to `importForguncyConfigModule`. */
  readonly loadModule?: ForguncyConfigModuleLoader;
}

function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Resolves, loads, validates and normalizes a project config in one step.
 *
 * Everything that must be true before a Forguncy project is touched is checked
 * here, including the on-disk existence of each declared entry, so a caller that
 * receives a registry has already cleared those gates.
 */
export async function loadForguncyConfig(options: LoadForguncyConfigOptions): Promise<CellRegistry> {
  const { root, configFile, loadModule = importForguncyConfigModule } = options;
  const requireEntryFiles = options.requireEntryFiles ?? true;

  if (!isAbsolute(root)) {
    throw new ForguncyConfigError(
      [
        {
          code: "invalid-project-root",
          path: "root",
          message: `Project root must be an absolute path. Got ${JSON.stringify(root)}.`,
        },
      ],
      "forguncy.config",
    );
  }

  const resolvedFile = findForguncyConfigFile({ root, configFile });

  if (resolvedFile === undefined) {
    const searched =
      configFile === undefined
        ? `Searched ${FORGUNCY_CONFIG_FILE_CANDIDATES.join(", ")} in ${root}.`
        : `Looked for the explicitly requested file at ${resolve(root, configFile)}.`;
    const diagnostics: ConfigDiagnostic[] = [
      {
        code: "config-file-not-found",
        path: configFile ?? FORGUNCY_CONFIG_FILE_CANDIDATES[0],
        message: `No forguncy.config file found. ${searched} Add one (see Spec #26) or pass "configFile".`,
      },
    ];
    throw new ForguncyConfigError(diagnostics, "forguncy.config");
  }

  let loaded: unknown;
  try {
    loaded = await loadModule(resolvedFile);
  } catch (error) {
    throw new ForguncyConfigError(
      [
        {
          code: "config-load-failed",
          path: resolvedFile,
          message: `Loading the config threw. Fix the module before retrying. Cause: ${describeCause(error)}`,
        },
      ],
      resolvedFile,
    );
  }

  const exported = (loaded as { default?: unknown } | null | undefined)?.default;

  if (exported === undefined) {
    throw new ForguncyConfigError(
      [
        {
          code: "config-missing-default-export",
          path: resolvedFile,
          message:
            'A forguncy config must export its document as the default export, e.g. `export default defineForguncyConfig({ cells: { ... } })`.',
        },
      ],
      resolvedFile,
    );
  }

  if (typeof exported === "function") {
    throw new ForguncyConfigError(
      [
        {
          code: "config-not-an-object",
          path: resolvedFile,
          message:
            "A forguncy config default export must be the config object itself, not a function. Environment-dependent config belongs in vite.config.ts.",
        },
      ],
      resolvedFile,
    );
  }

  return createCellRegistry(exported, { root, configPath: resolvedFile, requireEntryFiles });
}
