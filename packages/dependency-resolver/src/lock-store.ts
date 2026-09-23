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
 * Four behaviours are deliberate:
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
 * - **There is a second, explicitly local projection.** `compilationDependencies`
 *   is a deployment gate (fresh + runtime-validated). Local probe questions need
 *   the same freshness rules without a fake `target` to answer them;
 *   `localCompilationDependencies` is freshness-only and is never a shipping path.
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
  assertFgcLockDocumentShape,
  assessLockDecision,
  canonicalizeFgcLock,
  createEmptyFgcLock,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  findLockDecision,
  LOCK_EVIDENCE_POLICY,
  lockEvidenceProfileOf,
  parseMigratedFgcLockDocument,
  resolveLockDecision,
  serializeFgcLock,
} from "@forguncy-react-workspace/core";

/** The lock file's location for a project root. */
export function fgcLockPath(projectRoot: string): string {
  return join(projectRoot, FGC_LOCK_FILE_NAME);
}

/**
 * Reads, migrates and validates the project lock.
 *
 * Returns an empty lock when no file exists. A file that exists fails loudly
 * rather than becoming "no decisions": an older version is brought forward by a
 * declared migration step, and a version with no step — including a newer one —
 * throws.
 *
 * The two version directions are deliberately not symmetrical. Refusing a newer
 * document is the whole point of the schema-version check; refusing an older one
 * forever would mean the format could never change, so an older document is
 * migrated instead, and only a version nobody has written a step for is refused.
 * See `parseMigratedFgcLockDocument`, which also runs the full rules pass, so
 * migration is never a way past validation.
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
  return parseMigratedFgcLockDocument(text);
}

/**
 * Writes the canonical lock.
 *
 * Validates before it writes, so a malformed record cannot reach a file every
 * later run has to read: the read path refuses such a file, and leaving one
 * behind turns a writer's mistake into a lock nobody can load.
 *
 * Three steps in this order, and the order is the point: shape first, because
 * canonicalization *assumes* it (`[...lock.decisions]`, `[...record.evidence]`)
 * and would otherwise throw a native `TypeError` from inside the canonicalizer;
 * then the canonical form, because ordering is this function's job and demanding
 * that a caller pre-sort would push a serialization concern into every producer;
 * then the rules. The pure transforms above stay unchecked on purpose — they are
 * typed, and this is the boundary where a value becomes project state.
 */
export async function writeFgcLock(projectRoot: string, lock: FgcLockDocument): Promise<void> {
  assertFgcLockDocumentShape(lock);
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
 * The record for exactly this (package, cell target), or null.
 *
 * Not `findLockDecision`, and the difference is the point. That one *resolves* a
 * query — for a cell with no record of its own it falls back to the
 * target-independent record — which is right for reading a decision and wrong for
 * writing one: an update for cell target `customers-card` that fell back would
 * inherit the rationale and evidence recorded for the whole project, and then
 * write them back as the customers card's own justification. A record to *change*
 * is identified by its key, not by what it would resolve to.
 */
export function findExactLockDecision(
  lock: { readonly decisions: readonly LockedDependencyDecision[] },
  query: LockDecisionQuery,
): LockedDependencyDecision | null {
  const key = lockKey({ packageName: query.packageName, cellTarget: query.cellTarget ?? null });
  return lock.decisions.find(record => lockKey(record) === key) ?? null;
}

/**
 * Every package the lock records a decision for, in canonical order.
 *
 * Exported so a caller can feed the lock straight to a version lookup rather than
 * re-deriving the set — and so that "which packages does this lock need versions
 * for" has one answer instead of one per call site.
 */
export function recordedPackageNames(lock: { readonly decisions: readonly LockedDependencyDecision[] }): readonly string[] {
  return [...new Set(lock.decisions.map(record => record.packageName))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

export interface LocalCompilationDependencyOptions {
  /** The cell being compiled; defaults to null, i.e. the target-independent records. */
  readonly cellTarget?: string | null;
}

/**
 * The local/probe projection: fresh recorded decisions reduced to compiler
 * input without the deployment gate's real-runtime validation.
 *
 * `compilationDependencies` is a deployment gate — fresh *and* runtime-validated
 * or nothing. That is correct for shipping, and too strict for the local
 * questions a probe-driven PoC asks while `target` is honestly `null` (#13
 * steps 7–8 have not run): "does this recorded decision externalize?". The two
 * axes #8 already separates map onto the two projections:
 *
 * - `compilationDependencies` = freshness + real-runtime validation;
 * - `localCompilationDependencies` = freshness only.
 *
 * Stale evidence is withheld on both paths, with the same `not-verified` +
 * `stalenessReasons` shape — package version, probe fingerprint, toolchain and
 * extension version/identity drift all still fail closed here. The *only*
 * relaxation is `realRuntimeValidation === "not-validated"`. Rule 4 of #8 still
 * withholds `replace` as a cache once the record is fresh (a stale rejection is
 * re-probing, not a cache). Callers must run `auditLockDecisionConformance`
 * first, and must never present this projection's output as a deployment
 * decision — shipping goes through `compilationDependencies`, which withholds
 * exactly these `not-validated` records until a real Forguncy runtime check
 * records a `target`.
 */
export function localCompilationDependencies(
  lock: FgcLockDocument,
  environment: LockEnvironment,
  options: LocalCompilationDependencyOptions = {},
): CompilationDependencies {
  const cellTarget = options.cellTarget ?? null;
  const packageNames = [...new Set(lock.decisions.map(record => record.packageName))];
  const dependencies: DependencyDecision[] = [];
  const withheld: WithheldCompilationDependency[] = [];

  for (const packageName of packageNames) {
    const record = findLockDecision(lock, { packageName, cellTarget });
    if (record === null) {
      continue;
    }

    const assessment = assessLockDecision(record, environment);
    if (assessment.freshness !== "fresh") {
      withheld.push({
        packageName,
        strategy: record.strategy,
        reason: "not-verified",
        stalenessReasons: assessment.stalenessReasons,
        realRuntimeValidation: assessment.realRuntimeValidation,
      });
      continue;
    }

    const profile = lockEvidenceProfileOf(record);
    if (!LOCK_EVIDENCE_POLICY[profile].participatesInCompilation) {
      withheld.push({ packageName, strategy: record.strategy, reason: "replace-cache" });
      continue;
    }

    // Fresh on every axis; `realRuntimeValidation` is deliberately not checked —
    // that is the one thing this path exists to relax.
    dependencies.push(dependencyDecisionOf(record));
  }

  return { dependencies, withheld };
}
