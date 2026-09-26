/**
 * The project configuration contract.
 *
 * Governing Spec Issue: #26 "Spec: project configuration and React Cell target
 * declarations" — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 * Implementation Issue: #28.
 *
 * Scope note: this module declares *shape and intent*. It deliberately contains
 * no dependency compatibility evidence (that is `fgc.lock.json`, owned by
 * #8/#24), no live Forguncy project state, and no generated code. Normalization
 * and validation live in `cell-registry.ts`; file loading lives in
 * `config-loader.ts`.
 *
 * Portability rule: a committed config must be reviewable in a PR and must mean
 * the same thing on every machine. That is why nothing here accepts a secret, a
 * machine-specific absolute path, or a dependency-strategy decision.
 *
 * One exception to "no dependency-strategy decision", and it is a narrow one:
 * `extensions.mappings` states which npm import a named extension provides
 * (Issue #85). That is a *mapping*, not a strategy — a mapping says how an
 * `extension` decision compiles, never that a package should be one — so the
 * decision itself still lives in `fgc.lock.json` alone. `strategy`, `dependencies`
 * and their synonyms stay refused by name at every level.
 */

import type { ExtensionExternalMapping } from "./extension-externals.ts";

/** Schema revision of the config document itself. */
export const FORGUNCY_CONFIG_SCHEMA_VERSION = 1 as const;
export type ForguncyConfigSchemaVersion = typeof FORGUNCY_CONFIG_SCHEMA_VERSION;

/** The config file a project is expected to commit, resolved against the project root. */
export const DEFAULT_FORGUNCY_CONFIG_FILE = "forguncy.config.ts";

/**
 * Search order for the config file. `.ts` comes first because the contract is
 * authored as typed config, where `defineForguncyConfig` catches shape mistakes
 * in the editor instead of at sync time.
 */
export const FORGUNCY_CONFIG_FILE_CANDIDATES = [
  "forguncy.config.ts",
  "forguncy.config.mts",
  "forguncy.config.mjs",
  "forguncy.config.js",
] as const;

/**
 * Revision marker for the target locator model.
 *
 * **Final** as of Spec #26's last acceptance criterion ("the target locator
 * model is updated to match evidence from #5/#19 before implementation is
 * finalized"). Three independent evidence passes agree on the same two fields:
 *
 * - #5's probe wrote every one of its Cells through
 *   `api.page.setCells({ pageName, cells: [{ cell }] })`;
 * - #19's delivered MCP sync contract carries the same two fields as measured
 *   facts (`SYNC_TARGET_LOCATOR` in `mcp-sync`);
 * - #26's read-only designer probe (2026-09-22) found no stable page id
 *   anywhere in the `api.page` surface to prefer instead — see
 *   {@link TARGET_LOCATOR_FINALIZATION}.
 *
 * The revision stays `v0` on purpose: finalizing the model did not change its
 * fields, so no committed config needs a migration. A future evidence-driven
 * change to the fields *is* a new revision, which keeps it a reviewable event
 * rather than a silent reinterpretation of existing configs.
 */
export const TARGET_LOCATOR_MODEL = "forguncy-page-cell/v0" as const;
export type TargetLocatorModel = typeof TARGET_LOCATOR_MODEL;

/**
 * The evidence that finalized the locator, as data.
 *
 * This answers two things at once: #26's finalization acceptance criterion, and
 * the open question #19's contract deliberately left for it ("whether a stable
 * page id exists that a rename does not change … #26/#28 must resolve or accept
 * that before the target model is finalised"). It lives here, in `core`, so
 * `mcp-sync` carries this exact answer instead of maintaining a second one, and
 * so a test can assert the model is final rather than a comment being read.
 */
export const TARGET_LOCATOR_FINALIZATION = {
  model: TARGET_LOCATOR_MODEL,
  status: "final",
  /** The fields, in the order `api.page.setCells` takes them. */
  fields: ["pageName", "cell"] as const,
  evidence: [
    "#5's probe addressed every written Cell as api.page.setCells({ pageName, cells: [{ cell }] }) on Forguncy 12.0.100.",
    "#19's delivered MCP sync contract (SYNC_TARGET_LOCATOR) carries the same two fields, both recorded as measured.",
    "#26's read-only designer probe (2026-09-22): api.page.setCells accepts only pageName + cells; listPages and getPageInfo expose no page id; runtime introspection of api.page and api.app finds no id lookup; renamePage is addressed by pageName.",
  ],
  resolvedOpenQuestion:
    "No stable page id exists in the designer MCP surface, so there is nothing to upgrade the locator to: pageName + cell is the platform's only page address.",
  renameSemantics:
    "Renaming a page invalidates the declared pageName until the config is updated, while logical Cell identity stays the config key (cells.<id>) — which is what keeps #26's rename rule independent of the locator.",
} as const;

/**
 * A1-style single-cell anchor. Row `0` and `.` are rejected because Forguncy
 * addresses cells from `1` and there is no partial reference in the API evidence.
 */
export const CELL_REFERENCE_PATTERN = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/;

/** Default namespace for the marker written into generated cell code. */
export const DEFAULT_CODE_MARKER_NAMESPACE = "fgc";

/** Default dependency-decision lock path, relative to the project root. */
export const DEFAULT_DEPENDENCY_LOCK_PATH = "fgc.lock.json";

/**
 * The Forguncy destination of one managed Cell.
 *
 * `pageName` and `cell` are exactly the two coordinates `api.page.setCells`
 * consumes, which is why they are the locator and not merely metadata about one.
 */
export interface ForguncyTargetLocator {
  /** Forguncy page name as the designer shows it, e.g. `销售订单`. */
  readonly pageName: string;
  /** Single anchor cell in A1 notation, e.g. `B4`. */
  readonly cell: string;
}

/**
 * A deliberate exception to the measured code budget.
 *
 * The override is not free: Spec #26 allows output/code-budget overrides "only
 * when evidence justifies them", so the justification is part of the contract
 * rather than a comment. It is rejected when empty.
 *
 * ## The unit, and why this field is named for it
 *
 * `codeBudgetCharacters` counts **characters of generated cell source** — the
 * same quantity `getCellCodeContext().length` reports and the same one #21's
 * bands are expressed in. It is a hard cap: an artifact longer than it is
 * refused by `compileCell`. The measured bands are *advisory* and are deliberately
 * not reachable through this field (see `cell-code-budget.ts`).
 *
 * This field was `codeBudgetBytes` before #77. That name was not merely a
 * misnomer — the number it held was compared against a byte count in the probe's
 * `size` step while the compiler compared characters, so one artifact could be
 * `inline` to the compiler and over budget to the probe. A byte value is not
 * convertible here either: 100,095 characters of CJK source is 300,095 bytes, so
 * reading the old number as characters would move a Chinese-language Cell by
 * roughly a band. The old name is therefore **retired, not reinterpreted** — a
 * config still declaring it is refused with `renamed-output-field` rather than
 * silently repriced (see `cell-registry.ts`).
 */
export interface CellCodeBudgetOverrides {
  /** Ceiling, in characters of generated cell source, this cell may reach instead of the project default. */
  readonly codeBudgetCharacters: number;
  /** Why the evidence supports the larger budget. */
  readonly justification: string;
}

/** One managed React Cell. */
export interface CellConfig {
  /**
   * Project-relative source entry, e.g. `./cells/order-list/src/index.tsx`.
   *
   * Must stay relative: the logical Cell identity is `cells.<id>`, so renaming
   * or moving the file must not change which Cell it is.
   */
  readonly entry: string;
  /** The one Forguncy Cell this entry is deployed to. */
  readonly target: ForguncyTargetLocator;
  /** Optional local-dev fixture/mock entry, used by the dev harness (#23). */
  readonly fixture?: string;
  /** Optional code-budget override; requires `justification`. */
  readonly output?: CellCodeBudgetOverrides;
}

/**
 * Project/runtime target assumptions.
 *
 * Readable in the designer, but never authorization: a stable non-secret alias
 * may be committed, a session token may not.
 */
export interface RuntimeTargetConfig {
  /** Target Forguncy product/build expectation, when intentionally pinned. */
  readonly forguncyVersion?: string;
  /** Stable, non-secret MCP project selector/alias. */
  readonly projectAlias?: string;
  /** Namespace for the marker written into generated cell code. */
  readonly codeMarkerNamespace?: string;
  /** Dependency lock path, when the project does not use the default. */
  readonly dependencyLockPath?: string;
}

/**
 * Project-level extension mappings.
 *
 * `undefined` means the config did not mention the field, which keeps the built-in
 * table; `{ builtinMappings: false }` is a *stated* opt-out. The distinction is the
 * whole reason this is an object rather than an array: an array cannot express
 * "declared, and empty".
 *
 * The shape is declared here and *validated* in `extension-mappings-config.ts`, for
 * the same split the rest of this file follows — this module states shape and intent
 * and normalizes nothing.
 */
export interface ExtensionMappingsConfig {
  /**
   * Whether the built-in mapping table contributes rows. Defaults to `true`.
   *
   * A project row adds to the built-in table rather than replacing it, so this field
   * is the only way to opt out, and opting out is a written line in a diff rather
   * than an inference from an empty array.
   */
  readonly builtinMappings?: boolean;
  /** Rows this project declares. Merged after the built-ins, in declaration order. */
  readonly mappings?: readonly ExtensionExternalMapping[];
}

/**
 * The whole config document.
 *
 * `cells` may be empty so a project can adopt the contract before its first
 * Cell exists; the *key* is required so an accidentally truncated config is a
 * validation error rather than a silent "no Cells managed".
 */
export interface ForguncyConfig {
  readonly schemaVersion?: ForguncyConfigSchemaVersion;
  readonly cells: Readonly<Record<string, CellConfig>>;
  readonly runtime?: RuntimeTargetConfig;
  /** Project-level extension mappings, when the built-in table is not enough. */
  readonly extensions?: ExtensionMappingsConfig;
}

/** Fields allowed at each level. Used verbatim in unknown-field diagnostics. */
export const CONFIG_ALLOWED_FIELDS = ["schemaVersion", "cells", "runtime", "extensions"] as const;
export const CELL_ALLOWED_FIELDS = ["entry", "target", "fixture", "output"] as const;
export const RUNTIME_ALLOWED_FIELDS = [
  "forguncyVersion",
  "projectAlias",
  "codeMarkerNamespace",
  "dependencyLockPath",
] as const;

/**
 * Field names that carry dependency-strategy decisions in *some* other tool.
 *
 * Reading them from config would make the loader a second, unreviewed source of
 * dependency strategy, silently overriding `fgc.lock.json`. They are rejected by
 * name so the diagnostic can point at the lock file instead of just saying
 * "unknown field".
 */
export const DEPENDENCY_DECISION_FIELD_NAMES = [
  "dependencies",
  "dependencyDecisions",
  "dependencyStrategies",
  "dependencyStrategy",
  "resolvedDependencies",
  "packageDecisions",
  "strategy",
  "strategies",
] as const;

/**
 * Declares a project config.
 *
 * A typed identity function, so the config file gets editor feedback and
 * excess-property checking without the loader having to trust it: the loader
 * still validates the *loaded module*, because a `.mjs`/`.js` config (or a
 * hand-edited one) bypasses these types entirely.
 */
export function defineForguncyConfig<const TConfig extends ForguncyConfig>(config: TConfig): TConfig {
  return config;
}

/** True when a value is a non-array object, i.e. something that can hold named fields. */
export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes an A1 reference to its canonical upper-case form. */
export function normalizeCellReference(cell: string): string {
  return cell.trim().toUpperCase();
}

/**
 * The duplicate-detection identity of a target.
 *
 * Case-folded on **both** coordinates as the conservative direction: if the
 * designer's addressing ever treats `Sales!A1` and `sales!a1` as two distinct
 * destinations, folding them reports a *false* duplicate — a refusal with an
 * actionable message before any mutation — while not folding risks the silent
 * overwrite of one Cell by another, which is the failure #26's rule ("must
 * never silently target the same Cell") exists to prevent. Declared strings are
 * preserved for display.
 */
export function targetLocatorKey(target: ForguncyTargetLocator): string {
  return `${target.pageName.trim().toLowerCase()}#${normalizeCellReference(target.cell)}`;
}
