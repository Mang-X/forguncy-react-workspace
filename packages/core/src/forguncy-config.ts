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
 */

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
 * **Provisional.** Spec #26 requires the locator model to be updated from the
 * evidence gathered in #5 (ReactCellType target/runtime contract) and #19
 * (one-way MCP sync) before the model is final. The current model matches the
 * only target addressing the repository actually has evidence for:
 * `api.page.setCells({ pageName, cells: [{ cell }] })`, as recorded in the
 * installed `forguncy-frontend-library` Skill
 * (`references/upload-and-integrate.md`).
 *
 * Every registry carries this value so an evidence-driven change to the locator
 * model is a visible, reviewable revision rather than a silent reinterpretation
 * of existing configs.
 */
export const TARGET_LOCATOR_MODEL = "forguncy-page-cell/v0" as const;
export type TargetLocatorModel = typeof TARGET_LOCATOR_MODEL;

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
 */
export interface CellCodeBudgetOverrides {
  /** Ceiling this cell is allowed to reach instead of the project default. */
  readonly codeBudgetBytes: number;
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
}

/** Fields allowed at each level. Used verbatim in unknown-field diagnostics. */
export const CONFIG_ALLOWED_FIELDS = ["schemaVersion", "cells", "runtime"] as const;
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
 * Case-folded on **both** coordinates: two Cells that differ only by case would
 * be indistinguishable in the Forguncy designer's addressing, so treating them
 * as distinct targets would be a false negative. Declared strings are preserved
 * for display.
 */
export function targetLocatorKey(target: ForguncyTargetLocator): string {
  return `${target.pageName.trim().toLowerCase()}#${normalizeCellReference(target.cell)}`;
}
