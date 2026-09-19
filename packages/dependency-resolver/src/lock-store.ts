/**
 * `fgc.lock.json` as a project artifact: where it lives, how it is read and
 * written, what the compiler is allowed to see of it, and nothing about what a
 * decision *means*.
 *
 * Decision source: GitHub Issue #8 —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * Governing architecture Spec Issues: #4 (strategy semantics) and #5 (verified
 * target contract).
 *
 * The model, its validation, its canonical form and its freshness rules live in
 * `@forguncy-react-workspace/core`; this module owns only the filesystem and the
 * projection onto compilation.
 *
 * Three behaviours are deliberate:
 *
 * - **A missing file is an empty lock, not an error.** "No decision recorded
 *   yet" is a normal state for a project, and `resolveLockDecision` reports it as
 *   `missing` per package. Failing to read an absent file would force every
 *   caller to special-case first run.
 * - **Writes are canonical.** The bytes on disk are always
 *   `serializeFgcLock`'s output, so re-running a resolver step does not produce a
 *   diff and a real strategy change is the only thing a reviewer sees.
 * - **The compiler projection is verified-only.** Handing a stale decision to the
 *   compiler is the failure this module exists to prevent: a package the runtime
 *   has moved past would be bundled as though someone had checked it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  DependencyDecision,
  DependencyStrategy,
  FgcLockDocument,
  LockDecisionQuery,
  LockEnvironment,
  LockedDependencyDecision,
  LockRealRuntimeValidation,
  LockStalenessReason,
} from "@forguncy-react-workspace/core";
import {
  assertFgcLockDocument,
  canonicalizeFgcLock,
  createEmptyFgcLock,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  LOCK_EVIDENCE_POLICY,
  lockEvidenceProfileOf,
  parseFgcLockDocument,
  resolveLockDecision,
  serializeFgcLock,
} from "@forguncy-react-workspace/core";

/** The lock file's location for a project root. */
export function fgcLockPath(projectRoot: string): string {
  return join(projectRoot, FGC_LOCK_FILE_NAME);
}

/**
 * Reads and validates the project lock.
 *
 * Returns an empty lock when no file exists. A file that exists but declares an
 * unsupported schema version, or fails validation, throws — a lock that cannot
 * be trusted must not silently become "no decisions".
 */
export async function readFgcLock(projectRoot: string): Promise<FgcLockDocument> {
  let text: string;
  try {
    text = await readFile(fgcLockPath(projectRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyFgcLock();
    }
    throw error;
  }
  return parseFgcLockDocument(text);
}

/**
 * Writes the canonical lock.
 *
 * Validates before it writes, so a malformed record cannot reach a file every
 * later run has to read: the read path refuses such a file, and leaving one
 * behind turns a writer's mistake into a lock nobody can load.
 *
 * It validates the *canonical* form, because ordering is this function's job
 * anyway — demanding that a caller pre-sort its decisions would push a
 * serialization concern into every producer. The pure transforms above stay
 * unchecked on purpose: they are typed, and this is the boundary where a value
 * becomes project state.
 */
export async function writeFgcLock(projectRoot: string, lock: FgcLockDocument): Promise<void> {
  const canonical = canonicalizeFgcLock(lock);
  assertFgcLockDocument(canonical);
  const path = fgcLockPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeFgcLock(canonical), "utf8");
}

function lockKey(record: Pick<LockedDependencyDecision, "packageName" | "cellTarget">): string {
  return `${record.packageName}\u0000${record.cellTarget ?? ""}`;
}

/**
 * Adds or replaces one decision, returning a canonical lock.
 *
 * Replacement is by (package, cell target), so changing a strategy rewrites that
 * record in place instead of appending a second one — which is what makes a
 * strategy change show up as an ordinary diff in review.
 */
export function upsertLockDecision(lock: FgcLockDocument, record: LockedDependencyDecision): FgcLockDocument {
  const key = lockKey(record);
  const decisions = lock.decisions.filter(existing => lockKey(existing) !== key);
  decisions.push(record);
  return canonicalizeFgcLock({ schemaVersion: lock.schemaVersion, decisions });
}

export function removeLockDecision(lock: FgcLockDocument, query: LockDecisionQuery): FgcLockDocument {
  const key = lockKey({ packageName: query.packageName, cellTarget: query.cellTarget ?? null });
  return canonicalizeFgcLock({
    schemaVersion: lock.schemaVersion,
    decisions: lock.decisions.filter(record => lockKey(record) !== key),
  });
}

// ---------------------------------------------------------------------------
// The compiler projection
// ---------------------------------------------------------------------------

/** A package the projection deliberately did not hand to the compiler. */
export type WithheldCompilationDependency =
  | {
      readonly packageName: string;
      readonly strategy: DependencyStrategy;
      /** Rule 4 of #8: a rejection is an Agent decision cache, not a dependency. */
      readonly reason: "replace-cache";
    }
  | {
      readonly packageName: string;
      readonly strategy: DependencyStrategy;
      readonly reason: "not-verified";
      readonly stalenessReasons: readonly LockStalenessReason[];
      readonly realRuntimeValidation: LockRealRuntimeValidation;
    };

export interface CompilationDependencies {
  /** Exactly the verified decisions that reach the graph, in canonical order. */
  readonly dependencies: readonly DependencyDecision[];
  /**
   * Everything the lock holds but the compiler must not act on, with the reason.
   *
   * Returned rather than dropped because the compiler's error model (#6) has
   * diagnostics for an unresolved or conflicting dependency decision, and a
   * caller that silently ignores a withheld package would compile a cell that
   * imports a package nobody approved.
   */
  readonly withheld: readonly WithheldCompilationDependency[];
}

export interface CompilationDependencyOptions {
  /** The cell being compiled; defaults to null, i.e. the target-independent records. */
  readonly cellTarget?: string | null;
}

/**
 * The decisions the compiler may act on.
 *
 * Rule 4 of #8 keeps `replace` out of the generated graph, and a decision only
 * counts once it is verified: fresh against the current environment *and*, where
 * its strategy owes one, validated against a named Forguncy target. A package is
 * resolved once, through the same target-preferring lookup the rest of the
 * resolver uses, so a cell never receives two records for one package.
 *
 * A package the lock only decides for a *different* cell target contributes
 * nothing here, and is not reported as withheld: the lock has no decision about
 * this cell at all. Whether a cell imports something nobody decided is the
 * compiler's own import audit (#6), which is the only layer that knows what the
 * cell imports.
 */
export function compilationDependencies(
  lock: FgcLockDocument,
  environment: LockEnvironment,
  options: CompilationDependencyOptions = {},
): CompilationDependencies {
  const cellTarget = options.cellTarget ?? null;
  const packageNames = [...new Set(lock.decisions.map(record => record.packageName))];
  const dependencies: DependencyDecision[] = [];
  const withheld: WithheldCompilationDependency[] = [];

  for (const packageName of packageNames) {
    const resolution = resolveLockDecision(lock, { packageName, cellTarget }, environment);
    if (resolution.record === null || resolution.assessment === null) {
      continue;
    }

    // Staleness is checked before participation on purpose. A technical
    // rejection can expire — its candidate, toolchain, target or probe inputs can
    // move — and reporting that as `replace-cache` would hide the fact that the
    // rejection needs re-probing. Only a rejection that still holds is a cache.
    if (resolution.state !== "verified") {
      withheld.push({
        packageName,
        strategy: resolution.record.strategy,
        reason: "not-verified",
        stalenessReasons: resolution.assessment.stalenessReasons,
        realRuntimeValidation: resolution.assessment.realRuntimeValidation,
      });
      continue;
    }

    const profile = lockEvidenceProfileOf(resolution.record);
    if (!LOCK_EVIDENCE_POLICY[profile].participatesInCompilation) {
      withheld.push({ packageName, strategy: resolution.record.strategy, reason: "replace-cache" });
      continue;
    }

    dependencies.push(dependencyDecisionOf(resolution.record));
  }

  return { dependencies, withheld };
}
