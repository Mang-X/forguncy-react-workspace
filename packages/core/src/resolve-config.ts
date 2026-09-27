/**
 * The project's module-resolution configuration: the one alias set both the local dev
 * server and the Cell build resolve through.
 *
 * Decision sources: GitHub Issues
 * - #97 — "构建入口：统一 Cell registry、别名与生产构建配置的消费路径"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/97), which owns this block
 *   and the requirement that one declared alias set drive both paths, and
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26), the config contract
 *   this block extends,
 *
 * both downstream of #4 "application ownership boundaries and dependency strategy
 * semantics" (https://github.com/Mang-X/forguncy-react-workspace/issues/4).
 *
 * ## Why this lives in the config file rather than in `vite.config.ts`
 *
 * #97's first acceptance criterion is that "one registry/alias configuration drives local
 * and production actual resolution, with no implicit second set of defaults". A
 * `vite.config.ts` alias can only ever satisfy half of that: Vite reads it, and the Cell
 * build — which drives Rolldown directly, because a Cell artifact is one IIFE rather than
 * a web bundle — never sees it. Measured on the build as it stood before this Issue:
 * `createRolldownCellBundler` took `{ dir }` and nothing else, and the generated Rolldown
 * options contained no `resolve` key at all, so `@/lib/x` resolved under `vp dev` and
 * failed the compile. That is precisely the "local uses a Vite config while production
 * ignores it" failure #97 names.
 *
 * So the alias set is *project* configuration — the same kind of declaration `cells` and
 * `extensions.mappings` already are — and each engine is handed the normalized result
 * rather than the project being asked to keep two files in step.
 *
 * ## The supported subset, and why it is a subset
 *
 * The two engines' alias rules agree for exactly one key shape, which is why this module
 * accepts exactly that shape and reports the rest by name rather than passing them
 * through. Measured against Vite 8.3.0 and Rolldown 1.2.9:
 *
 * | key shape | Vite | Rolldown `resolve.alias` | here |
 * | --- | --- | --- | --- |
 * | plain string (`"@/lib"`) | `===` or `startsWith(key + "/")` | same | accepted |
 * | string with a trailing slash | slash stripped, then the rule above | slash kept, so it matches nothing | normalized to the plain form |
 * | `RegExp`, or a `"/re/"` string | supported | not supported by this option | refused |
 *
 * The trailing-slash row is a **normalization** rather than a refusal because the two
 * engines intend the same rule and differ only in spelling. The regex row is a **refusal**
 * because no spelling makes them agree: Rolldown's `resolve.alias` is a plain
 * string-keyed map, and its regex support is a separate plugin (`viteAliasPlugin`) whose
 * ordering relative to this compiler's interception hooks is a different question. A
 * project asking for a regex alias is asking for something that cannot be honoured on
 * both paths, so it is told that instead of being handed an alias that works locally and
 * not in the artifact.
 *
 * A target is accepted only as a **project-relative path**, which is the portability rule
 * the rest of this config already follows. An absolute path is refused by the
 * whole-document pass in `cell-registry`, and a bare specifier (`{"old": "new"}`) is a
 * *module-id redirect* whose resolution differs between the engines — Rolldown resolves
 * the replacement through `node_modules` from the importing file while Vite resolves it
 * from the project root. Both are reported rather than silently reinterpreted.
 *
 * ## There is no built-in alias table
 *
 * Deliberately unlike `extensions.mappings`, whose absent state contributes the shipped
 * table. `alias` has no shipped default to merge, so "the config declared nothing" and
 * "the config declared an empty set" mean the same thing here — and saying so is worth a
 * sentence, because the asymmetry with `extensions` is the kind a reader assumes away.
 * What must not happen is a default *appearing*: an alias the project never wrote would
 * make the dev server and the artifact resolve through a rule nobody declared, which is
 * the "implicit second set of defaults" #97 forbids.
 */

import { resolve } from "node:path";

import { hostBridgeInterceptedModuleIds } from "./host-bridge.ts";
import { machineSpecificPathProblem } from "./portability.ts";

/** The config field this block is declared under. */
export const RESOLVE_CONFIG_FIELD = "resolve";

/** Fields allowed inside a `resolve` block. */
export const RESOLVE_ALLOWED_FIELDS = ["alias"] as const;

/**
 * The codes this module reports. A subset of the config vocabulary `cell-registry` carries.
 *
 * Declared here and folded into that union rather than being a second error type, for the
 * reason `extension-mappings-config` records: a project with a bad alias *and* a bad Cell
 * entry should cost one round trip, and a caller branching on `ForguncyConfigError.codes`
 * should not have to know which sub-module found the problem.
 */
export type ResolveConfigDiagnosticCode =
  | "unknown-resolve-field"
  | "invalid-resolve-config"
  | "invalid-resolve-alias"
  | "unsupported-resolve-alias-pattern"
  | "nonportable-resolve-alias-target"
  | "host-module-alias-conflict";

/**
 * One actionable problem, located at the config path that produced it.
 *
 * Structurally `cell-registry`'s `ConfigDiagnostic` — `code`/`path`/`message` — so the
 * registry passes these through without translating them. Declared here rather than
 * imported because that module calls this one, and a runtime import back would be a cycle.
 */
export interface ResolveConfigDiagnostic {
  readonly code: ResolveConfigDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/** One alias as the project declared it, beside the absolute target both engines receive. */
export interface ResolvedAliasEntry {
  /** The module-id prefix, with any trailing slash already stripped. */
  readonly find: string;
  /** The target exactly as authored, for a report that has to quote the project back. */
  readonly replacement: string;
  /** The target as an absolute path, which is the form both engines are handed. */
  readonly target: string;
}

/**
 * The normalized alias set.
 *
 * Frozen, for the reason `NormalizedExtensionMappings` is: this object is shared by the
 * dev server and by every compile in one build, so a caller that could mutate it would be
 * editing the resolution table of every consumer at once — the "second source of truth"
 * failure this whole line of work removes.
 */
export interface NormalizedResolveConfig {
  /**
   * The alias set as both engines take it: module-id prefix to **absolute** path.
   *
   * Absolute rather than project-relative because that is the only form both engines
   * accept. Vite resolves a relative replacement against its own root, and Rolldown
   * throws on a relative one (measured: `resolve.alias: { "@/lib": "./srclib" }` fails the
   * build outright). Resolving here, against the registry's root, is what makes one
   * declared string mean the same file on both paths.
   */
  readonly alias: Readonly<Record<string, string>>;
  /** The entries as declared, in declaration order, for reporting. */
  readonly entries: readonly ResolvedAliasEntry[];
}

export type NormalizeResolveConfigResult =
  | { readonly ok: true; readonly resolve: NormalizedResolveConfig }
  | { readonly ok: false; readonly diagnostics: readonly ResolveConfigDiagnostic[] };

function diag(code: ResolveConfigDiagnosticCode, path: string, message: string): ResolveConfigDiagnostic {
  return { code, path, message };
}

function isConfigRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an **object** key is meant as a regular expression rather than as a literal prefix.
 *
 * Two spellings, because both appear in the wild: the `/…/` one Vite accepts for a `RegExp` in the
 * array form, and the anchored `^…$` one people copy from a `paths` mapping. Neither works here,
 * and the reason is slightly different for each — measured against Vite 8.3.0:
 *
 * - an object key is a **literal** in Vite, so `"/^my-lib$/"` and `"^my-lib$"` both match nothing;
 * - the Cell build's Rolldown `resolve.alias` is a string-keyed map with no pattern support at all.
 *
 * So the two engines agree — on matching nothing. That is not a divergence to refuse, it is a
 * declaration that silently does nothing, which is worse for the author: the alias looks declared
 * and no import is affected. Reporting it is the helpful answer, and the alternative (`^`/`$` are
 * not characters a module id starts or ends with) has no false positive worth worrying about.
 */
function looksLikePatternKey(key: string): boolean {
  if (key.length > 2 && key.startsWith("/") && key.endsWith("/")) {
    return true;
  }
  return key.startsWith("^") || key.endsWith("$");
}

/**
 * The key as both engines will actually match it, or a refusal when they would agree on nothing.
 *
 * The rule is Vite's `normalizeSingleAlias` condition, reproduced rather than simplified, because
 * a plain "strip the trailing slash" is wrong in a way that *creates* the divergence this module
 * exists to prevent. Measured against Vite 8.3.0 and Rolldown 1.2.9 for a key `"my-lib/"`:
 *
 * | target | Vite | Rolldown | this module |
 * | --- | --- | --- | --- |
 * | ends in `/` | strips both, then prefix-matches | key keeps its slash, matches nothing | key stripped, so **both** prefix-match |
 * | does not | keeps the slash, matches nothing | matches nothing | refused: neither engine honours it |
 *
 * The second row is the one a naive strip gets wrong. Stripping there would make the alias start
 * resolving locally *and* in the artifact — which sounds like the fix and is actually a project's
 * never-really-declared alias being silently activated. Refusing says what to do instead.
 */
function normalizeAliasKey(
  key: string,
  replacement: string,
  path: string,
  out: ResolveConfigDiagnostic[],
): string | undefined {
  if (!key.endsWith("/")) {
    return key;
  }

  if (replacement.endsWith("/")) {
    return key.replace(/\/+$/, "");
  }

  out.push(
    diag(
      "invalid-resolve-alias",
      path,
      `Alias "${key}" has a trailing slash on the key but not on the target, and neither engine strips a slash in that case — Vite only strips when both sides have one, and Rolldown keeps the key as written. The entry therefore matches nothing on either path. Either remove the trailing slash from "${key}", or add one to "${replacement}".`,
    ),
  );
  return undefined;
}

/** The empty result: no aliases declared, which is a stated state rather than a default. */
export const EMPTY_NORMALIZED_RESOLVE_CONFIG: NormalizedResolveConfig = Object.freeze({
  alias: Object.freeze({}),
  entries: Object.freeze([]),
});

/**
 * Reads one `resolve.alias` entry, or reports every reason it cannot be honoured.
 *
 * Split out so the refusals read as different repairs rather than one "invalid alias": a key that
 * is not a module id, a key that looks like a pattern, a target that is not a project-relative
 * path, and a bridged id each send a reader somewhere different — the same argument
 * `extension-mappings-config` makes for its per-row checks.
 *
 * **A machine-specific target is skipped rather than reported**, following the convention
 * `cell-registry`'s `resolveDeclaredPath` states: the whole-document portability pass already
 * reported that value under `machine-specific-path`, and reporting it again under a second code
 * makes one mistake read as two. Every form `machineSpecificPathProblem` recognises is
 * unambiguously not a project-relative path, so the entry cannot be honoured either way — what
 * differs is only which diagnostic explains it, and the document walk's carries the project-wide
 * rule.
 */
function readAliasEntry(
  rawKey: string,
  rawValue: unknown,
  options: { readonly root: string; readonly bridgedModuleIds: ReadonlySet<string> },
  path: string,
  out: ResolveConfigDiagnostic[],
): ResolvedAliasEntry | undefined {
  const authoredKey = rawKey.trim();

  if (authoredKey.length === 0) {
    out.push(
      diag("invalid-resolve-alias", path, `An alias key must be the module id prefix it matches, and an empty key matches nothing.`),
    );
    return undefined;
  }

  // Before the path check, because a `"/…/"` object key *also* starts with `/`, and "you wrote a
  // path" is the wrong repair for somebody who wrote a pattern.
  if (looksLikePatternKey(authoredKey)) {
    out.push(
      diag(
        "unsupported-resolve-alias-pattern",
        path,
        `"${authoredKey}" looks like a regular expression, and as an *object key* Vite reads it literally — measured: it matches neither the bare id nor anything else — while the Cell build's Rolldown configuration has no pattern support at all. So it would silently alias nothing rather than working locally, which is why this is reported instead of accepted. Name the module ids explicitly, one entry each; for a Vite-only pattern, put it in \`vite.config.ts\`.`,
      ),
    );
    return undefined;
  }

  if (authoredKey.startsWith("./") || authoredKey.startsWith("../") || authoredKey.startsWith("/")) {
    out.push(
      diag(
        "invalid-resolve-alias",
        path,
        `An alias key must be a module id (what the source reads), not a path. Got "${authoredKey}". Put the path on the right-hand side.`,
      ),
    );
    return undefined;
  }

  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    out.push(diag("invalid-resolve-alias", path, `Alias "${authoredKey}" must have a non-empty target string.`));
    return undefined;
  }

  const replacement = rawValue.trim();

  // Skipped, not reported: see this function's docstring.
  if (machineSpecificPathProblem(replacement) !== undefined) {
    return undefined;
  }

  if (!isProjectRelativeTarget(replacement)) {
    out.push(
      diag(
        "nonportable-resolve-alias-target",
        path,
        `Alias "${authoredKey}" targets "${replacement}", which is a bare specifier rather than a project-relative path. A module-id redirect resolves the target differently in Vite (from the project root) and in Rolldown (from the importing file), so it cannot be honoured on both paths. Write the target as "./…" or "../…".`,
      ),
    );
    return undefined;
  }

  // Both separators are accepted on input and the authored spelling is kept for the report;
  // `resolve` normalizes to the host's form, which is what the engines receive.
  const target = resolve(options.root, replacement);
  if (target === options.root) {
    out.push(
      diag(
        "invalid-resolve-alias",
        path,
        `Alias "${authoredKey}" targets the project root itself ${JSON.stringify(replacement)}. Alias a directory inside the project, so the alias cannot make the whole root importable under one id.`,
      ),
    );
    return undefined;
  }

  const find = normalizeAliasKey(authoredKey, replacement, path, out);
  if (find === undefined) {
    return undefined;
  }

  // The host bridge owns its module ids, and the two engines order that binding *oppositely*:
  // Vite applies the project's own `resolve.alias` before a plugin's `resolveId`, while the
  // artifact's Rolldown configuration intercepts bridged ids in its `resolveId` hook before its
  // `resolve.alias`. Both measured. So an alias here would win locally and lose in the artifact —
  // one import, two modules, which is the divergence #97 exists to remove.
  if (options.bridgedModuleIds.has(find)) {
    out.push(
      diag(
        "host-module-alias-conflict",
        path,
        `"${find}" is bound by the host bridge (#9), and the two engines order that binding oppositely, so an alias here would change local resolution only. The artifact resolves it to the page's own object before any alias applies. Point it at a patched build from \`vite.config.ts\` instead — that is a local override, not a claim about the artifact.`,
      ),
    );
    return undefined;
  }

  return { find, replacement, target };
}

/**
 * Whether a target is spelled as a project-relative path.
 *
 * `.` and `..` are accepted alongside the `./`-prefixed forms because they are the same request in
 * a shorter spelling and `resolve` treats them identically. Leaving them out would refuse
 * `{ "@": "." }` as a "bare specifier", which names the wrong problem: the real answer for that
 * entry is that it points at the project root, and `readAliasEntry` reports exactly that.
 */
function isProjectRelativeTarget(target: string): boolean {
  return target === "." || target === ".." || target.startsWith("./") || target.startsWith("../");
}

/**
 * Normalizes a project's `resolve` block, or reports every problem found.
 *
 * `root` is required rather than optional because every accepted target is made absolute
 * against it, and a caller with no root could not answer the one question the normalization
 * exists for. It is the registry's root, so the paths here are the same ones the Cells'
 * entries were resolved against.
 *
 * The result is `ok: false` only when something was reported: an absent block, a block that
 * declares no aliases, and a block whose every alias is refused all differ in the
 * diagnostics they carry but not in the shape of the answer.
 */
export function normalizeResolveConfig(
  config: unknown,
  options: { readonly root: string },
): NormalizeResolveConfigResult {
  const diagnostics: ResolveConfigDiagnostic[] = [];

  if (!isConfigRecordValue(config) || !(RESOLVE_CONFIG_FIELD in config)) {
    // No block at all. `EMPTY` rather than `undefined` so a consumer never has to test for
    // absence before reading `alias` — and so an absent block cannot be mistaken for an
    // unvalidated one.
    return { ok: true, resolve: EMPTY_NORMALIZED_RESOLVE_CONFIG };
  }

  const raw = config[RESOLVE_CONFIG_FIELD];
  const path = RESOLVE_CONFIG_FIELD;

  if (!isConfigRecordValue(raw)) {
    diagnostics.push(
      diag(
        "invalid-resolve-config",
        path,
        `"${RESOLVE_CONFIG_FIELD}" must be an object with an "alias" map. Allowed fields: ${RESOLVE_ALLOWED_FIELDS.join(", ")}.`,
      ),
    );
    return { ok: false, diagnostics };
  }

  for (const key of Object.keys(raw)) {
    if (!(RESOLVE_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      diagnostics.push(
        diag(
          "unknown-resolve-field",
          `${path}.${key}`,
          `Unknown "${RESOLVE_CONFIG_FIELD}" field "${key}". Allowed fields: ${RESOLVE_ALLOWED_FIELDS.join(", ")}. ` +
            `Vite options that have no Cell-build equivalent (conditions, dedupe, plugins, a tsconfig \`paths\` bridge) are not supported here: a Cell artifact is one IIFE, so an option the build cannot honour would change local resolution only.`,
        ),
      );
    }
  }

  const rawAlias = raw.alias;
  if (rawAlias === undefined) {
    // A block with no `alias` is legal and means "no aliases" — but only once the unknown-field
    // pass above came back clean. Returning `EMPTY` unconditionally was the first version and it
    // silently dropped a reported problem: `{ resolve: { dedupe: [...] } }` produced a diagnostic
    // and then a success, so the finding reached nobody. An absent key is not an absent error.
    return diagnostics.length === 0
      ? { ok: true, resolve: EMPTY_NORMALIZED_RESOLVE_CONFIG }
      : { ok: false, diagnostics };
  }

  return normalizeAliasMap(rawAlias, options, diagnostics);
}

/**
 * The `alias` map itself, in either shape Vite accepts.
 *
 * An array of `{ find, replacement }` is the other spelling Vite takes, so it is read too
 * rather than refused as an unknown shape: a project that copied the array form from a
 * `vite.config.ts` should get its aliases, not a message about the container. A `RegExp`
 * in `find` is reported by the same pattern code a `"/re/"` object key gets, because it is
 * the same request.
 */
function normalizeAliasMap(
  rawAlias: unknown,
  options: { readonly root: string },
  diagnostics: ResolveConfigDiagnostic[],
): NormalizeResolveConfigResult {
  const path = `${RESOLVE_CONFIG_FIELD}.alias`;
  const entries: ResolvedAliasEntry[] = [];
  const bridgedModuleIds = new Set(hostBridgeInterceptedModuleIds());

  if (Array.isArray(rawAlias)) {
    for (const [index, member] of rawAlias.entries()) {
      const memberPath = `${path}[${index}]`;
      if (!isConfigRecordValue(member)) {
        diagnostics.push(
          diag("invalid-resolve-alias", memberPath, `An alias entry must be an object with "find" and "replacement".`),
        );
        continue;
      }
      if (member.find instanceof RegExp) {
        // Measured: Vite *does* honour a `RegExp` here, and Rolldown's `resolve.alias` has no
        // pattern support at all. So unlike the object-key spelling below — which silently matches
        // nothing in either engine — this one really would resolve locally and fail in the
        // artifact, which is the divergence #97 exists to remove.
        diagnostics.push(
          diag(
            "unsupported-resolve-alias-pattern",
            memberPath,
            `A \`RegExp\` alias is supported by Vite but not by the Cell build's Rolldown configuration, whose \`resolve.alias\` is a string-keyed map, so it would resolve locally and not in the artifact. Name the module ids explicitly, one entry each; for a Vite-only pattern, put it in \`vite.config.ts\`.`,
          ),
        );
        continue;
      }
      if (typeof member.find !== "string") {
        diagnostics.push(
          diag("invalid-resolve-alias", memberPath, `An alias entry's "find" must be a string module id.`),
        );
        continue;
      }
      const entry = readAliasEntry(member.find, member.replacement, { ...options, bridgedModuleIds }, memberPath, diagnostics);
      if (entry !== undefined) entries.push(entry);
    }
  } else if (isConfigRecordValue(rawAlias)) {
    for (const [key, value] of Object.entries(rawAlias)) {
      const entry = readAliasEntry(key, value, { ...options, bridgedModuleIds }, `${path}.${key}`, diagnostics);
      if (entry !== undefined) entries.push(entry);
    }
  } else {
    diagnostics.push(
      diag(
        "invalid-resolve-alias",
        path,
        `"alias" must be an object of module id to target, or an array of { find, replacement }.`,
      ),
    );
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const alias: Record<string, string> = {};
  for (const entry of entries) {
    alias[entry.find] = entry.target;
  }

  return {
    ok: true,
    resolve: Object.freeze({
      alias: Object.freeze(alias),
      entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
    }),
  };
}

/** A report block for a CI log or a PR body. */
export function formatResolveConfig(normalized: NormalizedResolveConfig): string {
  const rows = normalized.entries.map(entry => `${entry.find} -> ${entry.replacement}`);
  return [
    `Module resolution aliases: ${normalized.entries.length}`,
    `Aliases: ${rows.join(", ") || "(none declared)"}`,
  ].join("\n");
}
