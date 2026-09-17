/**
 * The normalized Cell registry: the single answer to "which source entry is
 * which Forguncy Cell".
 *
 * Governing Spec Issue: #26 — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 * Implementation Issue: #28.
 *
 * The registry exists so the compiler, the local dev harness and MCP sync never
 * each invent their own mapping. Every consumer resolves a Cell from the same
 * normalized object, and every failure mode that must happen *before* a Forguncy
 * project is touched (missing entry, duplicate target, unportable path) is
 * detected here rather than at mutation time.
 *
 * Two failure classes are kept apart on purpose:
 *
 * - **invalid configuration** — the config cannot be normalized at all; nothing
 *   downstream should run;
 * - **unknown Cell lookup** — the config is fine, the caller asked for something
 *   that is not in it. Same error type, different diagnostic code, because the
 *   fix is different.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  CELL_ALLOWED_FIELDS,
  CELL_REFERENCE_PATTERN,
  CONFIG_ALLOWED_FIELDS,
  DEFAULT_CODE_MARKER_NAMESPACE,
  DEFAULT_DEPENDENCY_LOCK_PATH,
  DEPENDENCY_DECISION_FIELD_NAMES,
  FORGUNCY_CONFIG_SCHEMA_VERSION,
  isConfigRecord,
  normalizeCellReference,
  RUNTIME_ALLOWED_FIELDS,
  TARGET_LOCATOR_MODEL,
  targetLocatorKey,
} from "./forguncy-config";
import type { CellCodeBudgetOverrides, ForguncyTargetLocator, TargetLocatorModel } from "./forguncy-config";

/** Fields allowed inside a `target`. */
export const TARGET_ALLOWED_FIELDS = ["pageName", "cell"] as const;
/** Fields allowed inside an `output` override. */
export const OUTPUT_ALLOWED_FIELDS = ["codeBudgetBytes", "justification"] as const;

/** Logical Cell id: stable across file moves, so it is an identifier, not a path. */
export const CELL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type ConfigDiagnosticCode =
  // Document level.
  | "invalid-project-root"
  | "config-file-not-found"
  | "config-load-failed"
  | "config-missing-default-export"
  | "config-not-an-object"
  | "config-missing-cells"
  | "cells-not-an-object"
  | "unsupported-schema-version"
  | "unknown-config-field"
  // Portability.
  | "machine-specific-path"
  | "secret-looking-field"
  | "dependency-decision-in-config"
  // Cell level.
  | "invalid-cell-id"
  | "invalid-cell"
  | "unknown-cell-field"
  | "missing-cell-entry"
  | "invalid-entry-path"
  | "entry-outside-project-root"
  | "missing-entry-file"
  | "invalid-fixture-path"
  | "missing-fixture-file"
  | "missing-cell-target"
  | "invalid-target"
  | "unknown-target-field"
  | "invalid-target-page-name"
  | "invalid-target-cell"
  | "duplicate-target"
  // Output overrides.
  | "invalid-output-override"
  | "unknown-output-field"
  | "unjustified-output-override"
  // Runtime block.
  | "invalid-runtime-target"
  | "unknown-runtime-field"
  | "invalid-runtime-field"
  | "dependency-lock-outside-project-root"
  // Lookup.
  | "unknown-cell-id";

/**
 * One actionable problem.
 *
 * `path` is a JSON-ish location (`cells.orderList.target.cell`) so the message
 * can be pasted into a review comment without further explanation.
 */
export interface ConfigDiagnostic {
  readonly code: ConfigDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/**
 * Raised for invalid configuration and for lookups that cannot be satisfied.
 *
 * Carries every diagnostic collected in one pass rather than failing on the
 * first problem: a config with three mistakes should cost one round trip, not
 * three.
 */
export class ForguncyConfigError extends Error {
  readonly diagnostics: readonly ConfigDiagnostic[];

  constructor(diagnostics: readonly ConfigDiagnostic[], context = "forguncy.config") {
    const lines = diagnostics.map(diagnostic => `  - ${diagnostic.path}: ${diagnostic.message}`);
    super(`${context} is invalid:\n${lines.join("\n")}`);
    this.name = "ForguncyConfigError";
    this.diagnostics = diagnostics;
  }

  /** Diagnostic codes present, for callers that branch on the failure class. */
  get codes(): readonly ConfigDiagnosticCode[] {
    return this.diagnostics.map(diagnostic => diagnostic.code);
  }
}

/** A Forguncy target with its duplicate-detection identity attached. */
export interface NormalizedCellTarget extends ForguncyTargetLocator {
  /**
   * The case-folded identity used to detect two Cells claiming the same
   * Forguncy destination. See `targetLocatorKey`.
   */
  readonly locatorKey: string;
}

/** One fully resolved managed Cell. */
export interface RegisteredCell {
  /** Logical id, i.e. the `cells` key. Stable across entry renames. */
  readonly id: string;
  /** Project-relative entry exactly as authored, trimmed. */
  readonly entry: string;
  /** Absolute entry path, resolved against the project root. */
  readonly entryPath: string;
  readonly target: NormalizedCellTarget;
  /** Project-relative dev fixture/mock entry, when declared. */
  readonly fixture?: string;
  readonly fixturePath?: string;
  readonly output?: CellCodeBudgetOverrides;
}

/** Project/runtime target assumptions, with defaults applied. */
export interface NormalizedRuntimeTarget {
  readonly forguncyVersion?: string;
  readonly projectAlias?: string;
  readonly codeMarkerNamespace: string;
  /** Project-relative lock path. */
  readonly dependencyLockPath: string;
  readonly dependencyLockPathAbsolute: string;
}

/**
 * The normalized registry handed to every consumer.
 *
 * Lookups are methods rather than a plain map so callers cannot hold a stale
 * index, and so `require` can explain *what was available* instead of returning
 * `undefined` into a confusing downstream error.
 */
export interface CellRegistry {
  /** Absolute project root every relative path was resolved against. */
  readonly root: string;
  /** Config file the registry came from, when it came from a file. */
  readonly configPath?: string;
  readonly schemaVersion: number;
  readonly targetLocatorModel: TargetLocatorModel;
  readonly runtime: NormalizedRuntimeTarget;
  readonly cells: readonly RegisteredCell[];
  /** Ids in declaration order. */
  readonly cellIds: readonly string[];
  get(id: string): RegisteredCell | undefined;
  /** Throws a `ForguncyConfigError` naming the ids that do exist. */
  require(id: string): RegisteredCell;
  byTarget(locatorKey: string): RegisteredCell | undefined;
}

export interface CreateCellRegistryOptions {
  /** Absolute project root. Committed config is relative to this. */
  readonly root: string;
  /** Config file the document was loaded from, for diagnostics. */
  readonly configPath?: string;
  /**
   * Verify that declared entries (and fixtures) exist on disk.
   *
   * Defaults to `true`: a config that points at a file nobody wrote is a broken
   * project, and the point of the registry is to fail before compilation or MCP
   * mutation rather than after.
   */
  readonly requireEntryFiles?: boolean;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\/;
const POSIX_ABSOLUTE_PATH = /^\//;
const HOME_RELATIVE_PATH = /^~/;
const FILE_URL_PATTERN = /^file:\/\//i;
const MARKER_NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const SECRET_KEY_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
  "accesskey",
  "privatekey",
  "session",
  "cookie",
  "bearer",
  "authorization",
];

function diag(code: ConfigDiagnosticCode, path: string, message: string): ConfigDiagnostic {
  return { code, path, message };
}

/**
 * Why a string cannot be committed, or `undefined` when it is portable.
 *
 * Ordered from most to least specific so `C:\x` is reported as a Windows path
 * rather than as a generic directory-looking value.
 */
export function machineSpecificPathProblem(value: string): string | undefined {
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return "an absolute Windows path";
  }
  if (WINDOWS_UNC_PATH.test(value)) {
    return "a UNC path";
  }
  if (FILE_URL_PATTERN.test(value)) {
    return "a file:// URL";
  }
  if (HOME_RELATIVE_PATH.test(value)) {
    return "a home-relative path";
  }
  if (POSIX_ABSOLUTE_PATH.test(value)) {
    return "an absolute path";
  }
  return undefined;
}

/** True when the key names something that would have to be a secret. */
export function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_WORDS.some(word => normalized.includes(word));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExistingFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isInsideProjectRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Walks the whole document looking for anything a committed config must not
 * contain: machine-specific paths and secret-bearing fields.
 *
 * A whole-document walk rather than a field allow-list, because the failure this
 * prevents is a developer pasting a local absolute path or a session token into
 * *some* field — including a field added in a later revision that nobody
 * remembered to re-check.
 */
function collectPortabilityDiagnostics(value: unknown, path: string, out: ConfigDiagnostic[]): void {
  if (typeof value === "string") {
    const problem = machineSpecificPathProblem(value);
    if (problem !== undefined) {
      out.push(
        diag(
          "machine-specific-path",
          path,
          `Committed config must stay portable, but this value is ${problem}. Use a project-relative path instead.`,
        ),
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectPortabilityDiagnostics(item, `${path}[${index}]`, out);
    }
    return;
  }

  if (!isConfigRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      out.push(
        diag(
          "secret-looking-field",
          `${path}.${key}`,
          `"${key}" looks like a credential. Secrets, session tokens and machine-specific MCP connection details must not be committed; pass them through the environment instead.`,
        ),
      );
    }
    collectPortabilityDiagnostics(child, `${path}.${key}`, out);
  }
}

/**
 * Rejects fields that would make the loader a second source of dependency
 * strategy.
 *
 * Spec #26 puts dependency compatibility evidence in `fgc.lock.json` and forbids
 * duplicating it into config. Silently reading such a field would let a config
 * edit override a reviewed decision, so it is a hard error with a pointer to the
 * real owner.
 */
function collectDependencyDecisionFieldDiagnostics(
  record: Record<string, unknown>,
  path: string,
  out: ConfigDiagnostic[],
): readonly string[] {
  const rejected: string[] = [];
  for (const key of Object.keys(record)) {
    if ((DEPENDENCY_DECISION_FIELD_NAMES as readonly string[]).includes(key)) {
      rejected.push(key);
      out.push(
        diag(
          "dependency-decision-in-config",
          `${path}.${key}`,
          `"${key}" is a dependency-strategy decision, which belongs in the dependency lock (see Issues #8/#24), not in project config. Remove it so the lock stays the single reviewed source.`,
        ),
      );
    }
  }
  return rejected;
}

function collectUnknownFieldDiagnostics(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: ConfigDiagnosticCode,
  subject: string,
  out: ConfigDiagnostic[],
  skip: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key) || skip.includes(key)) {
      continue;
    }
    out.push(
      diag(code, `${path}.${key}`, `Unknown ${subject} field "${key}". Allowed fields: ${allowed.join(", ")}.`),
    );
  }
}

interface ResolvedEntry {
  readonly authored: string;
  readonly absolute: string;
}

/**
 * Validates and resolves one project-relative path.
 *
 * Absolute and machine-specific values are skipped here on purpose: the
 * whole-document portability pass already reported them, and reporting the same
 * problem under two codes would make the diagnostic list harder to read.
 */
function resolveDeclaredPath(
  value: unknown,
  options: {
    readonly root: string;
    readonly path: string;
    readonly code: ConfigDiagnosticCode;
    readonly missingCode: ConfigDiagnosticCode;
    readonly label: string;
    readonly requireEntryFiles: boolean;
  },
  out: ConfigDiagnostic[],
): ResolvedEntry | undefined {
  const { root, path, code, missingCode, label, requireEntryFiles } = options;

  if (value === undefined) {
    return undefined;
  }

  if (!isNonEmptyString(value)) {
    out.push(diag(code, path, `${label} must be a non-empty project-relative path.`));
    return undefined;
  }

  const authored = value.trim();

  if (machineSpecificPathProblem(authored) !== undefined) {
    return undefined;
  }

  const absolute = resolve(root, authored);

  if (absolute === root) {
    out.push(diag(code, path, `${label} must point at a source file, not at the project root itself.`));
    return undefined;
  }

  if (!isInsideProjectRoot(root, absolute)) {
    out.push(
      diag(
        code,
        path,
        `${label} resolves outside the project root ("${authored}"). Keep managed source inside the project so a clean checkout means the same thing.`,
      ),
    );
    return undefined;
  }

  if (requireEntryFiles && !isExistingFile(absolute)) {
    out.push(diag(missingCode, path, `${label} "${authored}" does not exist (resolved to ${absolute}).`));
    return undefined;
  }

  return { authored, absolute };
}

interface ResolvedCell {
  readonly id: string;
  readonly entry: ResolvedEntry;
  readonly target: NormalizedCellTarget;
  readonly fixture?: ResolvedEntry;
  readonly output?: CellCodeBudgetOverrides;
}

function validateCell(
  id: string,
  raw: unknown,
  options: { readonly root: string; readonly requireEntryFiles: boolean },
  out: ConfigDiagnostic[],
): ResolvedCell | undefined {
  const path = `cells.${id}`;

  if (!CELL_ID_PATTERN.test(id)) {
    out.push(
      diag(
        "invalid-cell-id",
        path,
        `Logical Cell ids are stable identifiers (letters, digits, "-", "_", starting with a letter) because they, not file paths, define Cell identity. Got "${id}".`,
      ),
    );
    return undefined;
  }

  if (!isConfigRecord(raw)) {
    out.push(diag("invalid-cell", path, `Cell "${id}" must be an object with at least "entry" and "target".`));
    return undefined;
  }

  const rejected = collectDependencyDecisionFieldDiagnostics(raw, path, out);
  collectUnknownFieldDiagnostics(raw, CELL_ALLOWED_FIELDS, path, "unknown-cell-field", "Cell", out, rejected);

  const entry = resolveDeclaredPath(
    raw.entry,
    {
      root: options.root,
      path: `${path}.entry`,
      code: "invalid-entry-path",
      missingCode: "missing-entry-file",
      label: "Cell entry",
      requireEntryFiles: options.requireEntryFiles,
    },
    out,
  );

  if (raw.entry === undefined) {
    out.push(
      diag(
        "missing-cell-entry",
        `${path}.entry`,
        `Every managed Cell needs exactly one source entry; "${id}" declares none.`,
      ),
    );
  }

  const target = validateTarget(raw.target, `${path}.target`, out, id);

  const fixture = resolveDeclaredPath(
    raw.fixture,
    {
      root: options.root,
      path: `${path}.fixture`,
      code: "invalid-fixture-path",
      missingCode: "missing-fixture-file",
      label: "Cell fixture",
      requireEntryFiles: options.requireEntryFiles,
    },
    out,
  );

  const output = validateOutputOverride(raw.output, `${path}.output`, out);

  if (entry === undefined || target === undefined) {
    return undefined;
  }

  return { id, entry, target, fixture, output };
}

function validateTarget(
  raw: unknown,
  path: string,
  out: ConfigDiagnostic[],
  cellId: string,
): NormalizedCellTarget | undefined {
  if (raw === undefined) {
    out.push(
      diag(
        "missing-cell-target",
        path,
        `Cell "${cellId}" declares no Forguncy target. A Cell without a target cannot be compiled or synced, so it fails before any MCP mutation.`,
      ),
    );
    return undefined;
  }

  if (!isConfigRecord(raw)) {
    out.push(diag("invalid-target", path, `Target must be an object with "pageName" and "cell".`));
    return undefined;
  }

  collectUnknownFieldDiagnostics(raw, TARGET_ALLOWED_FIELDS, path, "unknown-target-field", "target", out);

  let pageName: string | undefined;
  if (!isNonEmptyString(raw.pageName)) {
    out.push(
      diag(
        "invalid-target-page-name",
        `${path}.pageName`,
        `Target page name must be the non-empty Forguncy page name as the designer shows it.`,
      ),
    );
  } else {
    pageName = raw.pageName.trim();
  }

  let cell: string | undefined;
  if (typeof raw.cell !== "string" || !CELL_REFERENCE_PATTERN.test(raw.cell.trim())) {
    out.push(
      diag(
        "invalid-target-cell",
        `${path}.cell`,
        `Target cell must be a single A1-style anchor such as "B4" (letters then a row >= 1). Got ${JSON.stringify(raw.cell)}.`,
      ),
    );
  } else {
    cell = normalizeCellReference(raw.cell);
  }

  if (pageName === undefined || cell === undefined) {
    return undefined;
  }

  const target = { pageName, cell };
  return { ...target, locatorKey: targetLocatorKey(target) };
}

function validateOutputOverride(
  raw: unknown,
  path: string,
  out: ConfigDiagnostic[],
): CellCodeBudgetOverrides | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isConfigRecord(raw)) {
    out.push(diag("invalid-output-override", path, `Output override must be an object.`));
    return undefined;
  }

  collectUnknownFieldDiagnostics(raw, OUTPUT_ALLOWED_FIELDS, path, "unknown-output-field", "output override", out);

  const budget = raw.codeBudgetBytes;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) {
    out.push(
      diag("invalid-output-override", `${path}.codeBudgetBytes`, `Code budget must be a positive whole number of bytes.`),
    );
    return undefined;
  }

  if (!isNonEmptyString(raw.justification)) {
    out.push(
      diag(
        "unjustified-output-override",
        `${path}.justification`,
        `A code-budget override is only allowed when evidence justifies it (Spec #26), so "justification" is required and must not be empty.`,
      ),
    );
    return undefined;
  }

  return { codeBudgetBytes: budget, justification: raw.justification.trim() };
}

interface ResolvedRuntime {
  readonly runtime: NormalizedRuntimeTarget;
}

function validateRuntime(
  raw: unknown,
  root: string,
  out: ConfigDiagnostic[],
): ResolvedRuntime | undefined {
  const path = "runtime";

  if (raw === undefined) {
    return undefined;
  }

  if (!isConfigRecord(raw)) {
    out.push(diag("invalid-runtime-target", path, `"runtime" must be an object.`));
    return undefined;
  }

  const rejected = collectDependencyDecisionFieldDiagnostics(raw, path, out);
  collectUnknownFieldDiagnostics(raw, RUNTIME_ALLOWED_FIELDS, path, "unknown-runtime-field", "runtime", out, rejected);

  let forguncyVersion: string | undefined;
  if (raw.forguncyVersion !== undefined) {
    if (!isNonEmptyString(raw.forguncyVersion)) {
      out.push(
        diag("invalid-runtime-field", `${path}.forguncyVersion`, `Pin a concrete Forguncy version, never an empty value.`),
      );
      return undefined;
    }
    forguncyVersion = raw.forguncyVersion.trim();
  }

  let projectAlias: string | undefined;
  if (raw.projectAlias !== undefined) {
    if (!isNonEmptyString(raw.projectAlias)) {
      out.push(
        diag("invalid-runtime-field", `${path}.projectAlias`, `"projectAlias" must be a stable non-secret identifier.`),
      );
      return undefined;
    }
    projectAlias = raw.projectAlias.trim();
  }

  let codeMarkerNamespace = DEFAULT_CODE_MARKER_NAMESPACE;
  if (raw.codeMarkerNamespace !== undefined) {
    if (typeof raw.codeMarkerNamespace !== "string" || !MARKER_NAMESPACE_PATTERN.test(raw.codeMarkerNamespace)) {
      out.push(
        diag(
          "invalid-runtime-field",
          `${path}.codeMarkerNamespace`,
          `Marker namespace must be an identifier so it can be written into generated code as a comment marker.`,
        ),
      );
      return undefined;
    }
    codeMarkerNamespace = raw.codeMarkerNamespace;
  }

  let dependencyLockPath = DEFAULT_DEPENDENCY_LOCK_PATH;
  const declaredLockPath = raw.dependencyLockPath;
  if (declaredLockPath !== undefined) {
    if (!isNonEmptyString(declaredLockPath)) {
      out.push(
        diag("invalid-runtime-field", `${path}.dependencyLockPath`, `"dependencyLockPath" must be a project-relative path.`),
      );
      return undefined;
    }
    const authored = declaredLockPath.trim();
    if (machineSpecificPathProblem(authored) === undefined) {
      const absolute = resolve(root, authored);
      if (!isInsideProjectRoot(root, absolute)) {
        out.push(
          diag(
            "dependency-lock-outside-project-root",
            `${path}.dependencyLockPath`,
            `Dependency lock must live inside the project root; "${authored}" resolves outside it.`,
          ),
        );
        return undefined;
      }
    }
    dependencyLockPath = authored;
  }

  return {
    runtime: {
      forguncyVersion,
      projectAlias,
      codeMarkerNamespace,
      dependencyLockPath,
      dependencyLockPathAbsolute: resolve(root, dependencyLockPath),
    },
  };
}

function collectDuplicateTargetDiagnostics(cells: readonly ResolvedCell[], out: ConfigDiagnostic[]): void {
  const byLocator = new Map<string, ResolvedCell[]>();

  for (const cell of cells) {
    const group = byLocator.get(cell.target.locatorKey);
    if (group === undefined) {
      byLocator.set(cell.target.locatorKey, [cell]);
    } else {
      group.push(cell);
    }
  }

  for (const [locatorKey, group] of byLocator) {
    if (group.length < 2) {
      continue;
    }
    const ids = group.map(cell => cell.id).sort();
    const [first] = group;
    if (first === undefined) {
      continue;
    }
    const rendered = group.map(cell => `${cell.id} -> ${cell.target.pageName}!${cell.target.cell}`).join(", ");
    for (const cell of group) {
      out.push(
        diag(
          "duplicate-target",
          `cells.${cell.id}.target`,
          `Cells ${ids.join(", ")} all claim Forguncy target ${locatorKey}. One Cell owns one target (${rendered}); rename or retarget before compiling or syncing.`,
        ),
      );
    }
  }
}

/**
 * Builds the normalized registry, or throws with every problem found.
 *
 * It performs no Forguncy-side work at all; the only I/O is confirming that
 * declared entries exist on disk, which is what lets a caller treat "I have a
 * registry" as "these gates already passed".
 */
export function createCellRegistry(config: unknown, options: CreateCellRegistryOptions): CellRegistry {
  const { root, configPath } = options;
  const requireEntryFiles = options.requireEntryFiles ?? true;

  if (!isAbsolute(root)) {
    throw new ForguncyConfigError(
      [diag("invalid-project-root", "root", `Project root must be an absolute path. Got ${JSON.stringify(root)}.`)],
      configPath ?? "forguncy.config",
    );
  }

  const context = configPath ?? "forguncy.config";
  const diagnostics: ConfigDiagnostic[] = [];

  if (!isConfigRecord(config)) {
    throw new ForguncyConfigError(
      [diag("config-not-an-object", "config", `Config must be an object with a "cells" map.`)],
      context,
    );
  }

  collectPortabilityDiagnostics(config, "config", diagnostics);

  const rejectedTopLevel = collectDependencyDecisionFieldDiagnostics(config, "config", diagnostics);
  collectUnknownFieldDiagnostics(config, CONFIG_ALLOWED_FIELDS, "config", "unknown-config-field", "config", diagnostics, rejectedTopLevel);

  if (config.schemaVersion !== undefined && config.schemaVersion !== FORGUNCY_CONFIG_SCHEMA_VERSION) {
    diagnostics.push(
      diag(
        "unsupported-schema-version",
        "config.schemaVersion",
        `Unsupported schema version ${JSON.stringify(config.schemaVersion)}; this toolchain understands ${FORGUNCY_CONFIG_SCHEMA_VERSION}.`,
      ),
    );
  }

  if (!("cells" in config) || config.cells === undefined) {
    diagnostics.push(
      diag(
        "config-missing-cells",
        "config.cells",
        `Config must declare "cells" (an empty object is allowed while a project has no managed Cells yet).`,
      ),
    );
  } else if (!isConfigRecord(config.cells)) {
    diagnostics.push(diag("cells-not-an-object", "config.cells", `"cells" must be a map of logical Cell id to Cell config.`));
  }

  const runtimeResult = validateRuntime(config.runtime, root, diagnostics);

  const resolvedCells: ResolvedCell[] = [];
  if (isConfigRecord(config.cells)) {
    // Declaration order, not alphabetical: the registry should read back the way
    // the config file reads, and a plain object preserves that deterministically.
    for (const id of Object.keys(config.cells)) {
      const cell = validateCell(id, config.cells[id], { root, requireEntryFiles }, diagnostics);
      if (cell !== undefined) {
        resolvedCells.push(cell);
      }
    }
  }

  collectDuplicateTargetDiagnostics(resolvedCells, diagnostics);

  if (diagnostics.length > 0) {
    throw new ForguncyConfigError(diagnostics, context);
  }

  const runtime: NormalizedRuntimeTarget = runtimeResult?.runtime ?? {
    codeMarkerNamespace: DEFAULT_CODE_MARKER_NAMESPACE,
    dependencyLockPath: DEFAULT_DEPENDENCY_LOCK_PATH,
    dependencyLockPathAbsolute: resolve(root, DEFAULT_DEPENDENCY_LOCK_PATH),
  };

  const cells: RegisteredCell[] = resolvedCells.map(cell => ({
    id: cell.id,
    entry: cell.entry.authored,
    entryPath: cell.entry.absolute,
    target: cell.target,
    fixture: cell.fixture?.authored,
    fixturePath: cell.fixture?.absolute,
    output: cell.output,
  }));

  const byId = new Map(cells.map(cell => [cell.id, cell]));
  const byLocator = new Map(cells.map(cell => [cell.target.locatorKey, cell]));

  return {
    root,
    configPath,
    schemaVersion: FORGUNCY_CONFIG_SCHEMA_VERSION,
    targetLocatorModel: TARGET_LOCATOR_MODEL,
    runtime,
    cells,
    cellIds: cells.map(cell => cell.id),
    get: id => byId.get(id),
    require: id => {
      const cell = byId.get(id);
      if (cell === undefined) {
        const known = cells.length === 0 ? "none" : cells.map(entry => entry.id).join(", ");
        throw new ForguncyConfigError(
          [
            diag(
              "unknown-cell-id",
              `cells.${id}`,
              `No managed Cell with logical id "${id}". Declared Cells: ${known}.`,
            ),
          ],
          context,
        );
      }
      return cell;
    },
    byTarget: locatorKey => byLocator.get(locatorKey),
  };
}

/** A claimed Forguncy destination, for invariant checks at a mutation boundary. */
export interface TargetClaim {
  /** Logical Cell id doing the claiming. */
  readonly cellId: string;
  readonly locatorKey: string;
}

/**
 * Fails when two claims point at one Forguncy target.
 *
 * Two names for one destination mean the second write silently overwrites the
 * first, so this has to fail *before* any mutation — after a partial sync there is
 * no safe rollback.
 */
export function assertDistinctTargetClaims(claims: readonly TargetClaim[], context = "cell registry"): void {
  const byLocator = new Map<string, string[]>();

  for (const claim of claims) {
    const group = byLocator.get(claim.locatorKey);
    if (group === undefined) {
      byLocator.set(claim.locatorKey, [claim.cellId]);
    } else {
      group.push(claim.cellId);
    }
  }

  const diagnostics: ConfigDiagnostic[] = [];
  for (const [locatorKey, cellIds] of byLocator) {
    if (cellIds.length < 2) {
      continue;
    }
    const sorted = [...cellIds].sort();
    for (const cellId of sorted) {
      diagnostics.push(
        diag(
          "duplicate-target",
          `cells.${cellId}.target`,
          `Cells ${sorted.join(", ")} all claim Forguncy target ${locatorKey}; refusing to continue before any project mutation.`,
        ),
      );
    }
  }

  if (diagnostics.length > 0) {
    throw new ForguncyConfigError(diagnostics, context);
  }
}

/**
 * Re-asserts the registry's uniqueness invariant at a mutation boundary.
 *
 * A registry built by `createCellRegistry` is already unique, but MCP sync may
 * receive one from a host, a cached snapshot or a deserialized payload.
 */
export function assertUniqueTargets(registry: CellRegistry): void {
  assertDistinctTargetClaims(
    registry.cells.map(cell => ({ cellId: cell.id, locatorKey: cell.target.locatorKey })),
    registry.configPath ?? "cell registry",
  );
}

/**
 * True when a value already is a normalized registry.
 *
 * Needed because the Vite plugin and MCP sync accept "config or registry": a host
 * that has already loaded and validated the config must not be re-validated with
 * a different root, which would silently re-resolve every entry path.
 */
export function isCellRegistry(value: unknown): value is CellRegistry {
  return (
    isConfigRecord(value) &&
    typeof value.root === "string" &&
    typeof value.targetLocatorModel === "string" &&
    Array.isArray(value.cells) &&
    Array.isArray(value.cellIds) &&
    typeof value.get === "function" &&
    typeof value.require === "function" &&
    typeof value.byTarget === "function" &&
    isConfigRecord(value.runtime)
  );
}
