/**
 * Making the project's `extensionChoices` *resolve*, rather than only be reported.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 5 asks for "a
 *   clear mechanism for extension-backed packages in local mode: explicit npm/local substitute or
 *   a diagnostic saying real-runtime validation is required", and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose Responsibilities say
 *   "`extension` packages can either **use** an explicit local shim/npm source or be marked as
 *   requiring real-runtime validation", under
 * - #12 — "Spec: `extension` dependencies as external modules + `frontendLibraries` metadata"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/12), whose mapping table says which
 *   packages a choice can be about at all.
 *
 * ## The defect this module exists to fix, and how it was found
 *
 * The audit (`local-dev-audit.ts`) reads `extensionChoices` and reports on them, which is half of
 * plan step 5. It does not make them true. Review of that PR found the consequence and the finding
 * was correct, measured against a real Vite server rather than reasoned about:
 *
 * | declaration | what actually loaded |
 * | --- | --- |
 * | `substitute`, `kind: "project-shim"`, `resolvesTo: "./shim.ts"` | the **npm copy**; the shim was never consulted |
 * | `real-runtime-only` | the **npm copy**, as long as the package was installed |
 *
 * The second row is a contradiction rather than an omission. The branch's own contract record says
 * "no stand-in is used" and "the dependency is not exercised at all"
 * (`LOCAL_DEV_STRATEGY_HANDLINGS`, `extension`), so a project that declared it was told the loop
 * could not exercise that dependency — while the loop exercised an npm copy of it. `resolvesTo` and
 * `kind` were, in short, documentation: read by the validator and by no resolver.
 *
 * ## What a declaration now means
 *
 * Every choice resolves to a **generated module**, whatever its target, so there is one mechanism
 * and one place a declaration is honoured:
 *
 * - **`substitute` + `npm-package`** — the module re-exports the named package.
 * - **`substitute` + `project-shim`** — the module re-exports the project's own file. This is the
 *   half that was most clearly broken: the reason a project supplies a shim is that the npm copy is
 *   the wrong thing to run, so substituting the npm copy *anyway* is the opposite of the
 *   declaration.
 * - **`real-runtime-only`** — the module **throws** the project's own acknowledgement, and the id
 *   never reaches an npm copy.
 *
 * That last one is the judgement call here, so the reasoning is stated rather than left in the
 * diff. Two readings of "no stand-in is used" were available: (a) the import fails, or (b) the
 * import takes the ordinary npm path and the acknowledgement merely warns that this proves nothing.
 * Reading (b) is what the harness did, and the contract's own words rule it out — a dependency that
 * loads and runs *is* exercised, and the `consequence` the project wrote ("what this leaves
 * unexercised") would be false. Reading (a) is also what this package already does for the
 * identical situation on the host bridge: a bridged id with no local copy is aliased to a module
 * that throws the explanation, because letting the import take the ordinary npm path "would be
 * worse, because it would either fail with Vite's generic message or, if another install happened
 * to be reachable, bind a copy the artifact will never carry" (`unavailableHostModules`). Same
 * problem, same answer, so the two mechanisms agree.
 *
 * It stays **non-blocking**, as the contract says it must: the server starts, every other Cell keeps
 * working, and only the import that needs the extension fails — naming the library, the global and
 * the project's own stated consequence.
 *
 * ## Why a generated module and an exact `resolveId`, and not an alias
 *
 * Measured, in several attempts, and the failures are the reason:
 *
 * - **`resolve.alias` with a string replacement over-claims.** Vite matches a string pattern as
 *   `importee === pattern || importee.startsWith(pattern + "/")`, so aliasing
 *   `@tanstack/react-query` also rewrites `@tanstack/react-query/persist` — an id #12's table
 *   deliberately does not intercept, because the extension does not provide it. The over-claim is
 *   not theoretical: with a string alias, resolving that subpath produced a request for
 *   `./persist` *inside the substitute package*, which is not a file.
 * - **An anchored RegExp avoids that but does not resolve.** A single-id pattern leaves the
 *   subpath alone, and then the replacement has to be resolvable as a bare specifier from the
 *   importing file, which it is not (`500`: `"./persist" is not exported …`).
 * - **A bare package name returned from `resolveId` produces `/@id/<name>`, which 404s.**
 * - **An absolute file returned from `resolveId` bypasses the dependency optimizer**, and a
 *   CommonJS package served that way has no named exports at all — the trap `host-modules.ts`
 *   documents at length for `react`.
 * - **A `\0`-prefixed virtual module cannot name a bare specifier inside itself** — it has no
 *   importer directory, so `export * from "@tanstack/query-core"` fails to resolve.
 *
 * What does work, and is therefore what this module generates: `resolveId` matches the declared id
 * **exactly** and returns a `\0`-prefixed virtual id, and `load` generates a module whose
 * re-export target is an **absolute path** — the substitute package's directory, or the shim file.
 * The directory rather than the entry file, for `host-modules.ts`'s reason: a directory target goes
 * through Vite's ordinary resolution, so subpaths stay inside the bound copy and the optimizer
 * interops a CommonJS package; a file target skips all of that.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

import { extensionMappingForPackage } from "@forguncy-react-workspace/core";
import type { LocalDevExtensionChoice } from "@forguncy-react-workspace/runtime";

import { LocalHostResolutionError } from "./host-modules.ts";

/**
 * The prefix marking a generated extension-substitution module.
 *
 * `\0`-prefixed like the Cell seam's virtual ids, so nothing tries to read it from disk. Its own
 * prefix rather than a reuse of `UNAVAILABLE_HOST_MODULE_PREFIX`, because the two states are
 * different questions: a host id has no local copy *of the page's package*, while this is a
 * dependency the project declared something about. Collapsing them would make one explanation
 * serve both and name neither correctly.
 */
export const EXTENSION_SUBSTITUTION_MODULE_PREFIX = "\0virtual:forguncy-dev-harness/extension-substitution/";

/** The virtual module id a declared choice resolves to. */
export function extensionSubstitutionModuleId(packageName: string): string {
  return `${EXTENSION_SUBSTITUTION_MODULE_PREFIX}${packageName}`;
}

/** The package name a substitution module id carries, or `undefined` when it is not one. */
export function extensionSubstitutionModuleOf(id: string): string | undefined {
  return id.startsWith(EXTENSION_SUBSTITUTION_MODULE_PREFIX)
    ? id.slice(EXTENSION_SUBSTITUTION_MODULE_PREFIX.length)
    : undefined;
}

/** Where one declared choice sends the id it is about. */
export type ExtensionSubstitutionTarget =
  | {
      readonly kind: "package";
      /** Absolute directory of the installed package the id resolves to. */
      readonly directory: string;
    }
  | {
      readonly kind: "shim";
      /** Absolute path of the project's own file. */
      readonly path: string;
    }
  | {
      readonly kind: "unavailable";
      /** Why nothing stands in, in the project's own words wherever it gave them. */
      readonly reason: string;
    };

/** One id a project's `extensionChoices` sends somewhere. */
export interface ExtensionSubstitution {
  /** The module id as the Cell imports it — the choice's own `packageName`, exactly. */
  readonly moduleId: string;
  readonly packageName: string;
  readonly target: ExtensionSubstitutionTarget;
}

/**
 * Raised when a choice cannot be honoured at all.
 *
 * A throw rather than a silent fallback to the npm path, for the reason the whole module exists: a
 * declaration that resolves somewhere other than where it says is worse than one that fails,
 * because the developer sees a working Cell and concludes the substitute ran.
 */
export class ExtensionSubstituteError extends Error {
  readonly packageName: string;

  constructor(packageName: string, message: string) {
    super(message);
    this.name = "ExtensionSubstituteError";
    this.packageName = packageName;
  }
}

/** Resolve an installed package's directory from a project root, or `undefined`. */
function resolvePackageDirectory(projectRoot: string, packageName: string): string | undefined {
  const require = createRequire(join(projectRoot, "package.json"));
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

/** Whether a declared shim is a file that exists, so the declaration is checked and not trusted. */
function shimIsReadable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where one choice sends the ids it declares.
 *
 * `resolvesTo` is interpreted by `kind`, and the two kinds mean different things — which is why the
 * declaration carries both fields rather than one: `npm-package` names a package the project's tree
 * installs (resolved from the project root, so it is the project's copy), while `project-shim`
 * names a file the project supplies *instead of* a package.
 */
export function resolveChoiceTarget(
  choice: LocalDevExtensionChoice,
  projectRoot: string,
): ExtensionSubstitutionTarget {
  if (choice.mode === "real-runtime-only") {
    // Never an npm copy. The branch's whole content is that the local loop does not exercise this
    // dependency, and the project's own `consequence` is what the generated module repeats.
    return {
      kind: "unavailable",
      reason: `The project recorded this dependency as needing real-runtime validation: ${choice.reason} Consequently ${choice.consequence}`,
    };
  }

  const resolvesTo = choice.resolvesTo;

  if (choice.kind === "project-shim") {
    const path = isAbsolute(resolvesTo) ? resolvesTo : join(projectRoot, resolvesTo);
    return shimIsReadable(path)
      ? { kind: "shim", path }
      : {
          kind: "unavailable",
          reason: `The project declared a ${choice.kind} substitute for this dependency, at "${resolvesTo}", and no readable file exists there relative to the project root. A shim that is not there cannot stand in for anything, and resolving the npm package instead would run the very module the declaration exists to avoid.`,
        };
  }

  const directory = resolvePackageDirectory(projectRoot, resolvesTo);
  return directory === undefined
    ? {
        kind: "unavailable",
        reason: `The project declared "${resolvesTo}" as the local substitute for this dependency, and that package is not installed in the project's own tree. Install it, correct \`resolvesTo\`, or record the \`real-runtime-only\` branch instead — resolving the original package instead would run a module the declaration does not name.`,
      }
    : { kind: "package", directory };
}

/**
 * The substitutions a project's choices call for, keyed by the id a Cell imports.
 *
 * The ids are the choice's own `packageName`, exactly — not the mapping row's sibling `moduleIds`
 * and not a prefix. A row can cover more than one package (`@tanstack/query-core` rides on the
 * `@tanstack/react-query` row), and widening over those siblings would resolve an id to a target
 * the project never named, which is the class of silent divergence this module exists to remove.
 */
export function extensionSubstitutions(
  choices: readonly LocalDevExtensionChoice[],
  projectRoot: string,
): readonly ExtensionSubstitution[] {
  const substitutions: ExtensionSubstitution[] = [];

  for (const choice of choices) {
    if (extensionMappingForPackage(choice.packageName) === undefined) {
      // The compiler refuses this too (`extension-mapping-missing`): a decision for a package the
      // table cannot bind would compile to a global nothing publishes. Thrown rather than skipped,
      // because skipping would leave the id resolving through npm — the outcome the choice exists
      // to prevent.
      throw new ExtensionSubstituteError(
        choice.packageName,
        `The project declared a local choice for "${choice.packageName}", and the extension mapping table does not intercept that package, so there is no extension for a substitute to stand in for.`,
      );
    }

    substitutions.push({
      moduleId: choice.packageName,
      packageName: choice.packageName,
      target: resolveChoiceTarget(choice, projectRoot),
    });
  }

  return substitutions;
}

/**
 * The substitution an id triggers, or `undefined`.
 *
 * Exact match, and that is the point rather than an implementation detail: Vite's alias rule would
 * also claim `@tanstack/react-query/persist`, and #12's table intercepts exactly the ids it lists —
 * a subpath "the extension does not provide". An exact lookup is the same rule the compiler applies
 * (`findExtensionExternalMapping`), so the dev server and the artifact agree about which imports
 * are answered locally.
 */
export function substitutionForModuleId(
  moduleId: string,
  substitutions: readonly ExtensionSubstitution[],
): ExtensionSubstitution | undefined {
  return substitutions.find(substitution => substitution.moduleId === moduleId);
}

/**
 * The module a declared choice resolves to.
 *
 * Two shapes, and both are `export * from <absolute path>` where there is something to re-export,
 * because a re-export forwards the substitute's names rather than inventing a surface. The
 * unsimulatable branch throws instead, so the failure lands on the authored `import` that needs the
 * dependency — which is where the decision has to be made.
 */
export function extensionSubstitutionModuleSource(substitution: ExtensionSubstitution): string {
  const banner = [
    `// Generated by @forguncy-react-workspace/dev-harness for the \`extension\` dependency`,
    `// "${substitution.moduleId}", which this project's \`forguncy.config.ts\`/dev harness options`,
    `// declared a local handling for. Do not edit.`,
  ];

  if (substitution.target.kind === "unavailable") {
    // The unavailable case is also reachable through the module-id lookup, and both routes must
    // produce the same text — so the source is built once, here, rather than in two places that
    // could describe one failure differently.
    return [...banner, ...unavailableLines(substitution)].join("\n");
  }

  const target = JSON.stringify(substitution.target.kind === "package" ? substitution.target.directory : substitution.target.path);
  return [
    ...banner,
    `//`,
    `// The target is absolute on purpose. A bare specifier cannot resolve from a module with a`,
    `// NUL-prefixed id (there is no importer directory), and an absolute *file* would bypass`,
    `// Vite's dependency optimizer — which is what interops a CommonJS package so that a named`,
    `// import of it has anything to bind. A directory goes through the ordinary resolution path.`,
    `export * from ${target};`,
    ``,
  ].join("\n");
}

/** The generated module for an `unavailable` target: it throws, deliberately. */
function unavailableLines(substitution: ExtensionSubstitution): readonly string[] {
  if (substitution.target.kind !== "unavailable") {
    // A programming error, not a configuration one: one list produces both this function's input
    // and the resolver's answer, so a mismatch means one of them was edited alone.
    throw new LocalHostResolutionError(
      substitution.moduleId,
      `No unavailable substitution is recorded for "${substitution.moduleId}", which resolves to a ${substitution.target.kind}. The resolver and this function are derived from one list; a mismatch means one of them was edited alone.`,
      substitution.packageName,
    );
  }

  const explanation =
    `${substitution.packageName} is an \`extension\` dependency and the local dev harness has no stand-in for it. ` +
    `${substitution.target.reason} ` +
    `Keep the import and validate this on a real Forguncy page, where the extension's own global is what binds — or declare a substitute in \`devHarness({ extensionChoices })\`.`;

  return [
    `//`,
    `// This module throws rather than exporting a stand-in. The alternative — resolving the npm`,
    `// package — would run a module the declaration does not name and report a local result for a`,
    `// dependency the project recorded that the loop cannot validate.`,
    `throw new Error(${JSON.stringify(explanation)});`,
    ``,
  ];
}

/** The ids a substitution set answers for, for a report or a test. */
export function substitutedExtensionModuleIds(
  substitutions: readonly ExtensionSubstitution[],
): readonly string[] {
  return substitutions.map(substitution => substitution.moduleId);
}
