/**
 * The project-level input for the `extension` mapping table, and its one normalization.
 *
 * Decision source: GitHub Issue #85 — "扩展配置：建立项目级 mappings 输入与统一校验入口"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/85), under parent Epic #81.
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * Spec Issues this module *reads* rather than restates:
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata" —
 *   owns what a mapping is, which two sources may verify an identity, and the
 *   `metadataSource`/`metadataReference`/`verifiedBy`/`verificationRule` fields.
 *   https://github.com/Mang-X/forguncy-react-workspace/issues/12
 * - #26 "project configuration and React Cell target declarations" — owns the config
 *   document, its portability rule and its diagnostic vocabulary.
 *   https://github.com/Mang-X/forguncy-react-workspace/issues/26
 *
 * ## The gap this module closes
 *
 * Before this module the only way to make an `extension` decision compile was to be
 * TanStack Query: `EXTENSION_EXTERNAL_MAPPINGS` is the table the compiler plans from,
 * and it carries one row. `planExtensionExternals` already accepted a `mappings`
 * option, but no path in the repository ever supplied one — so "support a new
 * extension" meant editing `core`, which is the state #85 exists to remove.
 *
 * ## The four inputs, and which one this is
 *
 * Four shapes are easy to confuse here, and #85 asks for the boundary to be written
 * down rather than inferred:
 *
 * | input | who writes it | what it can establish |
 * | --- | --- | --- |
 * | `extensions` (this module) | the project's committed config | **which npm import a named extension provides**, and where that claim came from |
 * | `EXTENSION_EXTERNAL_MAPPINGS` (`core`) | this repository | the same claim, for extensions this repository has verified |
 * | `ExtensionCatalog` (`dependency-resolver`) | the lock audit | a projection of the two above, for checking a recorded decision |
 * | `ExtensionLibraryListing` (`api.app.listFrontendLibraries`) | the running designer | **identity only** — an `id`, a `globalName`, and whether the bundle and types exist |
 *
 * The last row is the one this module must not blur. A listing has no `packageName`
 * field, and #12 refuses a `libraryId` inferred from a display name — so a listing
 * can *confirm* a mapping and can never *generate* one. A config row therefore
 * states the npm package it answers for; nothing here reads a display name as one,
 * and no code path turns a listing into a row. The listing's half of the work is
 * `auditExtensionLibraryMetadata`, which this module does not call and does not
 * replace.
 *
 * ## Merge rule: additive, and never a silent override
 *
 * The built-in table is a **default**, not a catalog the project may not touch — so a
 * project row *adds* to it rather than replacing it, and adding one row can never
 * silently drop the TanStack Query row a project was relying on. Opting out is a
 * written decision (`builtinMappings: false`), which is what makes the four states
 * below distinguishable:
 *
 * | `extensions` | normalized `source` | rows |
 * | --- | --- | --- |
 * | absent | `builtin-default` | the built-in table |
 * | `{ mappings: [...] }` | `project-extended` | built-ins, then the project's rows |
 * | `{ builtinMappings: false }` | `project-only` | none — declared empty, not unstated |
 * | `{ builtinMappings: false, mappings: [...] }` | `project-only` | the project's rows |
 *
 * "Absent" and "declared empty" are different answers, which is the same distinction
 * #12's `ExtensionExternalsActivation` draws for a listing and #9 draws between an
 * unobserved member and an absent one. A project that has opted out of the built-in
 * table is *stated* to have no built-in mappings; a project that never mentioned the
 * field is *unstated*, and gets the default.
 *
 * A project row claiming a module id, a library or a global the built-in table
 * already claims is a **conflict**, reported with the config path that produced it,
 * and never resolved by table order. That is #85's "冲突在编译/写入前给出具体配置位置，
 * 不静默覆盖", and it is why this module reuses #12's cross-row guard instead of
 * writing a second merge implementation: `assertExtensionExternalMappingsAreUnambiguous`
 * already answers exactly that question, and a second answer could disagree with it.
 *
 * ## What is deliberately absent
 *
 * No `strategy` field, and no way to express one. A mapping says how an `extension`
 * *decision* compiles, never that a package should be `extension` — that is #4's
 * strategy, applied by #16's selection flow and recorded in `fgc.lock.json`. So a
 * row that tried to decide a strategy is refused as an unknown field rather than
 * read, for the reason #26 rejects `dependencyDecisions` at the document root: a
 * config that could decide a strategy would be a second, unreviewed source of
 * dependency strategy.
 *
 * No export-surface narrowing either. A row cannot claim which members the extension
 * exports — there is no inventory to narrow to, and `core`'s
 * `EXTENSION_EXTERNAL_NON_GOALS` records why the generated module exports the page
 * object itself instead.
 */

import {
  assertExtensionExternalMappingIsAdmissible,
  assertExtensionExternalMappingsAreUnambiguous,
  EXTENSION_EXTERNAL_MAPPINGS,
  EXTENSION_MAPPING_ALLOWED_FIELDS,
  ExtensionExternalContractError,
} from "./extension-externals.ts";
import type {
  ExtensionExternalContractOptions,
  ExtensionExternalMapping,
} from "./extension-externals.ts";
import { isConfigRecord } from "./forguncy-config.ts";

/** The config field this module owns, at the document root. */
export const EXTENSION_MAPPINGS_CONFIG_FIELD = "extensions";

/** Fields allowed inside the `extensions` block. Used verbatim in diagnostics. */
export const EXTENSION_MAPPINGS_ALLOWED_FIELDS = ["builtinMappings", "mappings"] as const;

/**
 * Whether the built-in table contributes rows when the config does not say.
 *
 * `true`, and it is the direction that keeps existing projects working: #85's
 * acceptance criterion is that a config which says nothing keeps today's TanStack
 * Query behaviour. A project that wants a different set writes `builtinMappings:
 * false`, which is a reviewable line in a diff rather than an inference.
 */
export const DEFAULT_BUILTIN_MAPPINGS = true;

/**
 * Where a normalized mapping set came from.
 *
 * Three members rather than two, because "the built-ins plus my rows" is a state a
 * reader of a report needs to be able to tell from "only my rows" — the difference
 * decides whether removing a project row changes which extensions the artifact
 * declares.
 */
export type ExtensionMappingsSource = "builtin-default" | "project-extended" | "project-only";

/** The codes this module reports. A subset of the config vocabulary `cell-registry` carries. */
export type ExtensionMappingsDiagnosticCode =
  | "unknown-extensions-field"
  | "invalid-extension-mappings"
  | "invalid-extension-mapping"
  | "unknown-extension-mapping-field"
  | "extension-mapping-conflict";

/**
 * One actionable problem, located at the config path that produced it.
 *
 * Structurally `cell-registry`'s `ConfigDiagnostic` — `code`/`path`/`message` — so the
 * registry can pass these through without translating them. Declared here rather than
 * imported from there because that module calls this one: a runtime import back would
 * be a cycle, and a config diagnostic is not worth one.
 */
export interface ExtensionMappingsDiagnostic {
  readonly code: ExtensionMappingsDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/**
 * The normalized mapping set: what the compiler plans from, and what it came from.
 *
 * Frozen, because #85 asks for a result that stays read-only and reusable: a caller
 * that could mutate this would be editing the interception table of every consumer
 * that shares it, which is the "second source of truth" failure this whole line of
 * work removes. Freezing is what makes sharing it safe rather than merely intended.
 */
export interface NormalizedExtensionMappings {
  /** Every row the compiler plans from: the built-ins when included, then the project's. */
  readonly mappings: readonly ExtensionExternalMapping[];
  /**
   * The rows the project itself declared, in declaration order.
   *
   * Kept separately from {@link NormalizedExtensionMappings.mappings} because the
   * difference is the answer to "does removing this row change the artifact": a
   * project row can be removed, and a built-in row cannot be removed from here at all.
   */
  readonly projectMappings: readonly ExtensionExternalMapping[];
  readonly source: ExtensionMappingsSource;
  /** Whether the built-in table contributed rows. */
  readonly includesBuiltinMappings: boolean;
  /**
   * The table every row was checked against, for a caller that must report which one
   * a row was measured against.
   *
   * Carried rather than re-read from the module so a test — and a caller auditing a
   * config against a pinned table — compares against the same table the normalization
   * used, the way `planExtensionExternals`' `mappings` option does.
   */
  readonly builtinMappings: readonly ExtensionExternalMapping[];
}

export interface NormalizeExtensionMappingsOptions {
  /**
   * The built-in table, defaulting to `core`'s own.
   *
   * An option for the same reason `assertExtensionExternalContract` takes one: a
   * caller checking a config against a table it pinned should not be silently measured
   * against a different one, and the collision rule has to be exercised against a
   * table a test can state.
   */
  readonly builtinMappings?: readonly ExtensionExternalMapping[];
  /** The host bridge's globals and module ids, threaded to #12's guards. */
  readonly contract?: ExtensionExternalContractOptions;
}

export type NormalizeExtensionMappingsResult =
  | { readonly ok: true; readonly mappings: NormalizedExtensionMappings }
  | { readonly ok: false; readonly diagnostics: readonly ExtensionMappingsDiagnostic[] };

function diag(
  code: ExtensionMappingsDiagnosticCode,
  path: string,
  message: string,
): ExtensionMappingsDiagnostic {
  return { code, path, message };
}

/**
 * Reads one project row, or reports every field that is wrong with it.
 *
 * A row is the same shape #12 already defines, so this function's job is *reading a
 * value that came from a config file* rather than declaring a second record: every
 * field it accepts is a field of {@link ExtensionExternalMapping}, checked for type
 * and for presence, and the row it returns is handed to #12's own guards for the
 * questions those already answer.
 *
 * The per-field checks here are deliberately about *shape only* — "is this a string",
 * "is this an array of strings" — because a row that is merely incomplete is a
 * different repair from a row that is inadmissible, and #12's guard states the second
 * kind in the vocabulary the compiler and the sync already report under. Collapsing
 * them would make "you left out `libraryId`" and "this library id is one the platform
 * would refuse" arrive as the same message.
 */
function readProjectMapping(
  raw: unknown,
  path: string,
  out: ExtensionMappingsDiagnostic[],
): ExtensionExternalMapping | undefined {
  if (!isConfigRecord(raw)) {
    out.push(
      diag("invalid-extension-mapping", path, `An extension mapping must be an object with a \`packageName\`.`),
    );
    return undefined;
  }

  for (const key of Object.keys(raw)) {
    if ((EXTENSION_MAPPING_ALLOWED_FIELDS as readonly string[]).includes(key)) continue;
    out.push(
      diag(
        "unknown-extension-mapping-field",
        `${path}.${key}`,
        `Unknown extension mapping field "${key}". Allowed fields: ${EXTENSION_MAPPING_ALLOWED_FIELDS.join(", ")}. A mapping says how an \`extension\` decision compiles and never decides that a package should be one — the strategy belongs in the dependency lock (see Issues #4/#8).`,
      ),
    );
  }

  const failures: string[] = [];
  const required = (field: string): string | undefined => {
    const value = raw[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      failures.push(`\`${field}\` must be a non-empty string`);
      return undefined;
    }
    return value.trim();
  };

  const packageName = required("packageName");
  const libraryId = required("libraryId");
  const globalName = required("globalName");
  const metadataSource = required("metadataSource");
  const metadataReference = required("metadataReference");
  const verificationRule = required("verificationRule");

  let moduleIds: readonly string[] | undefined;
  if (raw.moduleIds !== undefined) {
    if (!Array.isArray(raw.moduleIds) || raw.moduleIds.some(id => typeof id !== "string" || id.trim().length === 0)) {
      failures.push("`moduleIds` must be an array of non-empty module id strings");
    } else {
      moduleIds = (raw.moduleIds as readonly string[]).map(id => id.trim());
    }
  }

  let verifiedBy: readonly string[] | undefined;
  if (raw.verifiedBy !== undefined) {
    if (!Array.isArray(raw.verifiedBy) || raw.verifiedBy.some(channel => typeof channel !== "string")) {
      failures.push("`verifiedBy` must be an array of evidence channels");
    } else {
      verifiedBy = raw.verifiedBy as readonly string[];
    }
  }

  let note: string | undefined;
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string") {
      failures.push("`note` must be a string");
    } else {
      note = raw.note;
    }
  }

  if (failures.length > 0) {
    out.push(
      diag(
        "invalid-extension-mapping",
        path,
        `This extension mapping is incomplete or misspelled: ${failures.join("; ")}. A project row states which npm import a named extension provides — the package, the stable \`libraryId\` from \`api.app.listFrontendLibraries\` or a verified catalog, the \`globalName\` it publishes, and where that identity came from.`,
      ),
    );
    return undefined;
  }

  // The required fields are all present and non-empty by here, which is what the
  // non-optional members of `ExtensionExternalMapping` need; the assertions narrow
  // `string | undefined` to `string` without a second set of checks that could drift.
  const mapping: ExtensionExternalMapping = {
    packageName: packageName!,
    ...(moduleIds === undefined ? {} : { moduleIds }),
    libraryId: libraryId!,
    globalName: globalName!,
    metadataSource: metadataSource! as ExtensionExternalMapping["metadataSource"],
    metadataReference: metadataReference!,
    verificationRule: verificationRule!,
    // An absent `verifiedBy` is *not* defaulted to an empty list here, so #12's
    // admissibility guard is what reports it — one place states "a claim with no
    // observation behind it" rather than two that could word it differently.
    verifiedBy: (verifiedBy ?? []) as ExtensionExternalMapping["verifiedBy"],
    note: note ?? "",
  };

  return mapping;
}

/**
 * The project's declared rows, read from the `extensions` block.
 *
 * Returns `undefined` for "the config did not declare the field", which is the state
 * that keeps the built-in default, and a (possibly empty) list otherwise — so
 * "declared nothing" and "declared no rows" stay distinguishable all the way to the
 * caller.
 */
function readProjectMappings(
  raw: unknown,
  out: ExtensionMappingsDiagnostic[],
): { readonly declared: boolean; readonly mappings: readonly ExtensionExternalMapping[] } | undefined {
  if (!isConfigRecord(raw)) {
    out.push(
      diag(
        "invalid-extension-mappings",
        EXTENSION_MAPPINGS_CONFIG_FIELD,
        `"${EXTENSION_MAPPINGS_CONFIG_FIELD}" must be an object with \`mappings\` (an array of extension mapping rows).`,
      ),
    );
    return undefined;
  }

  for (const key of Object.keys(raw)) {
    if ((EXTENSION_MAPPINGS_ALLOWED_FIELDS as readonly string[]).includes(key)) continue;
    out.push(
      diag(
        "unknown-extensions-field",
        `${EXTENSION_MAPPINGS_CONFIG_FIELD}.${key}`,
        `Unknown "${EXTENSION_MAPPINGS_CONFIG_FIELD}" field "${key}". Allowed fields: ${EXTENSION_MAPPINGS_ALLOWED_FIELDS.join(", ")}.`,
      ),
    );
  }

  const mappings: ExtensionExternalMapping[] = [];
  if (raw.mappings !== undefined) {
    if (!Array.isArray(raw.mappings)) {
      out.push(
        diag(
          "invalid-extension-mappings",
          `${EXTENSION_MAPPINGS_CONFIG_FIELD}.mappings`,
          `"mappings" must be an array of extension mapping rows.`,
        ),
      );
      return undefined;
    }
    for (const [index, row] of raw.mappings.entries()) {
      const mapping = readProjectMapping(row, `${EXTENSION_MAPPINGS_CONFIG_FIELD}.mappings[${index}]`, out);
      if (mapping !== undefined) mappings.push(mapping);
    }
  }

  return { declared: true, mappings };
}

/**
 * Whether the project asked for the built-in table, defaulting to yes.
 *
 * A non-boolean is reported and read as the default, which is the direction that
 * cannot silently drop a row: a misspelled `false` keeps the built-ins and says so,
 * while reading it as `false` would remove every built-in row on the strength of a
 * value the project never wrote.
 */
function readBuiltinMappings(raw: Record<string, unknown>, out: ExtensionMappingsDiagnostic[]): boolean {
  if (raw.builtinMappings === undefined) return DEFAULT_BUILTIN_MAPPINGS;
  if (typeof raw.builtinMappings !== "boolean") {
    out.push(
      diag(
        "invalid-extension-mappings",
        `${EXTENSION_MAPPINGS_CONFIG_FIELD}.builtinMappings`,
        `"builtinMappings" must be a boolean: \`false\` declares that this project does not use the built-in mapping table, and omitting the field keeps it.`,
      ),
    );
    return DEFAULT_BUILTIN_MAPPINGS;
  }
  return raw.builtinMappings;
}

/**
 * Turns the project's `extensions` block into the one mapping set every stage reads.
 *
 * This is the single normalization exit #85 asks for. Everything downstream —
 * the compiler's `planExtensionExternals`, the dev harness, the sync — is handed
 * this result rather than reading `EXTENSION_EXTERNAL_MAPPINGS` itself, so "which
 * extensions does this project use" has one answer instead of one per stage.
 *
 * ## Why the conflicts are found here rather than by the compiler
 *
 * A project row colliding with a built-in row is a config defect, and the compiler's
 * `extension-mapping-conflict` diagnostic cannot say *where* in the config it came
 * from — the plan has no config. #85 requires the location before a compile or a
 * write, so the collision is detected here, against the same guard the compiler
 * runs, and reported with the `extensions.mappings[i]` path that produced it.
 *
 * The two checks are deliberately both run rather than one replacing the other:
 * the per-row guard states what is wrong with a row on its own, and the cross-row
 * guard states what is wrong between rows. A caller that reported only the second
 * would tell a project with a reserved global that its rows "conflict", sending it
 * looking for a second row that does not exist.
 *
 * ## What it refuses to do
 *
 * It does not verify a `libraryId` against a real project. #12's rule is that an id
 * comes from `api.app.listFrontendLibraries` or a verified catalog artifact, and a
 * config file is neither — so a row records *which* of the two sources it used
 * (`metadataSource`) and *what* it read (`metadataReference`), and
 * `auditExtensionLibraryMetadata` is what later confirms it against a live listing.
 * A normalization that claimed to verify would be reporting a check it did not run.
 */
export function normalizeExtensionMappings(
  config: unknown,
  options: NormalizeExtensionMappingsOptions = {},
): NormalizeExtensionMappingsResult {
  const builtinMappings = options.builtinMappings ?? EXTENSION_EXTERNAL_MAPPINGS;
  const diagnostics: ExtensionMappingsDiagnostic[] = [];

  const raw = isConfigRecord(config) ? config[EXTENSION_MAPPINGS_CONFIG_FIELD] : undefined;
  const project = raw === undefined ? undefined : readProjectMappings(raw, diagnostics);

  if (project === undefined) {
    if (diagnostics.length > 0) {
      return { ok: false, diagnostics };
    }
    // Absent, so the default applies — and the default is the built-in table as it
    // stands, which is what keeps a config that says nothing behaving as it did.
    return {
      ok: true,
      mappings: freezeMappings({
        mappings: [...builtinMappings],
        projectMappings: [],
        source: "builtin-default",
        includesBuiltinMappings: true,
        builtinMappings,
      }),
    };
  }

  const includesBuiltinMappings = readBuiltinMappings(
    isConfigRecord(raw) ? raw : {},
    diagnostics,
  );

  const mappings = includesBuiltinMappings ? [...builtinMappings, ...project.mappings] : [...project.mappings];

  // #12's own guards, over the assembled set. Run even when the project declared no
  // rows, because `builtinMappings: false` with nothing declared is a *stated* empty
  // set and the built-in table is then not checked at all — the per-row loop over an
  // empty list is vacuously true, which is the honest answer for a set with no rows.
  for (const mapping of mappings) {
    try {
      assertExtensionExternalMappingIsAdmissible(mapping, options.contract);
    } catch (error) {
      // A project row is reported at its own config path; a built-in row can only fail
      // here if the repository's own table is broken, which the table's own test
      // asserts, so the path names the table rather than inventing a config location.
      const index = project.mappings.indexOf(mapping);
      const path =
        index >= 0
          ? `${EXTENSION_MAPPINGS_CONFIG_FIELD}.mappings[${index}]`
          : "EXTENSION_EXTERNAL_MAPPINGS";
      diagnostics.push(
        diag(
          "invalid-extension-mapping",
          path,
          error instanceof ExtensionExternalContractError
            ? error.message
            : String(error),
        ),
      );
    }
  }

  // Run unconditionally, beside the per-row loop rather than after it, so a project with
  // both a malformed row and a collision reads both in one round trip — the convention
  // `cell-registry` states as "a config with three mistakes should cost one round trip,
  // not three". Gating this on `diagnostics.length === 0` was the first version, and it
  // silently halved the report for exactly the configs that were most wrong. A row that
  // failed to read is simply absent from `mappings`, which can only *miss* a collision
  // and never invent one — so running over the rows that did read is sound.
  try {
    assertExtensionExternalMappingsAreUnambiguous(mappings, options.contract);
  } catch (error) {
    // Located at the project's rows, because the built-in table is checked by its own
    // test and a collision between the two is necessarily the project's addition: the
    // shipped table cannot conflict with itself, so naming the project's rows is the
    // actionable location rather than a guess.
    diagnostics.push(
      diag(
        "extension-mapping-conflict",
        project.mappings.length > 0
          ? `${EXTENSION_MAPPINGS_CONFIG_FIELD}.mappings`
          : "EXTENSION_EXTERNAL_MAPPINGS",
        error instanceof ExtensionExternalContractError ? error.message : String(error),
      ),
    );
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    mappings: freezeMappings({
      mappings,
      projectMappings: [...project.mappings],
      source: includesBuiltinMappings ? "project-extended" : "project-only",
      includesBuiltinMappings,
      builtinMappings,
    }),
  };
}

/**
 * The result, with every array and row frozen.
 *
 * A deep freeze of the containers this module created, not of the rows themselves: a
 * built-in row is `core`'s own table entry, and freezing it here would mutate a
 * module-level constant's reachability from a function that was merely asked to read
 * a config. The rows are read-only by their own type, which is where that guarantee
 * belongs; what freezing adds is that a caller cannot *reorder or append to* the set
 * every other consumer is sharing.
 */
function freezeMappings(result: NormalizedExtensionMappings): NormalizedExtensionMappings {
  Object.freeze(result.projectMappings);
  Object.freeze(result.builtinMappings);
  return Object.freeze({ ...result, mappings: Object.freeze(result.mappings) });
}

/**
 * Whether the project supplied a mapping for a package, and which set it came from.
 *
 * Offered so a report can answer "is this row the project's or the repository's"
 * without comparing object identity against two lists, which is the shape a caller
 * gets wrong once and then repeats.
 */
export function extensionMappingOrigin(
  normalized: NormalizedExtensionMappings,
  mapping: ExtensionExternalMapping,
): "project" | "builtin" {
  return normalized.projectMappings.includes(mapping) ? "project" : "builtin";
}

/** A report block for a CI log or a PR body. */
export function formatExtensionMappingsConfig(normalized: NormalizedExtensionMappings): string {
  const rows = normalized.mappings.map(
    mapping => `${mapping.packageName} -> ${mapping.libraryId}/${mapping.globalName}`,
  );
  return [
    `Extension mappings: ${normalized.source}${
      normalized.includesBuiltinMappings ? "" : " (the built-in table is not used)"
    }`,
    `Rows: ${rows.join(", ") || "(none)"}`,
    `Project rows: ${normalized.projectMappings.length}`,
  ].join("\n");
}
