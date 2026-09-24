/**
 * A Node module-resolution hook that lets a standalone ESM script import this
 * workspace's TypeScript packages by their `@forguncy-react-workspace/*` names.
 *
 * Why this exists: the selection policy (#16) and the probe engine (#17) are
 * TypeScript source packages with no build step — their `package.json` `exports`
 * point straight at `./src/index.ts`. Vite/Vitest resolve that through a bundler,
 * but `node scripts/…mjs` does not: it neither knows the workspace package names
 * (they are linked into each *consumer's* `node_modules`, not the root's) nor
 * resolves the extensionless relative specifiers the `"moduleResolution":
 * "Bundler"` tsconfig permits.
 *
 * The alternative was to duplicate the policy's constants into the skill as
 * JavaScript, which would put a second copy of the ownership boundary and the
 * probe steps next to the one the compiler acts on. Those two copies would drift,
 * and the drift would be invisible — the skill would keep teaching a rule the
 * repository had already changed. A loader that reaches the real source keeps the
 * skill reading the contract rather than restating it.
 *
 * Scope, stated because a resolve hook is a broad instrument:
 * - Only `@forguncy-react-workspace/*` specifiers are rewritten.
 * - Extensionless *relative* specifiers are only rewritten when the target
 *   actually exists as `<specifier>.ts` or `<specifier>/index.ts`.
 * - Everything else is handed to the default resolver untouched.
 *
 * Node strips the TypeScript type annotations itself (Node 24 + erasable syntax),
 * which is why nothing here transpiles anything.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_PREFIX = "@forguncy-react-workspace/";

/** Repository root, derived from this file's location: `.agents/skills/<skill>/scripts/`. */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Candidate extensions a bundler-style resolver would try for a bare relative path. */
const RESOLUTION_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(WORKSPACE_PREFIX)) {
    const packageName = specifier.slice(WORKSPACE_PREFIX.length).split("/")[0];
    const entry = new URL(`packages/${packageName}/src/index.ts`, pathToFileURL(REPOSITORY_ROOT));
    if (existsSync(fileURLToPath(entry))) {
      return nextResolve(entry.href, context);
    }
  }

  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL !== undefined) {
    const base = new URL(specifier, context.parentURL);
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = new URL(base.href + suffix);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
  }

  return nextResolve(specifier, context);
}
