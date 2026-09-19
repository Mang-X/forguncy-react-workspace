/**
 * Bringing an older `fgc.lock.json` forward — deliberately, or not at all.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" — https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * — plan item 8 of #24: "Add schema migration/version failure behavior rather
 * than silently accepting unknown versions."
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * `lock.ts` already refuses a version it does not understand, and that is the
 * right answer for a *newer* document and the wrong one for an older one. A lock
 * written by a previous toolchain is not a file to reject; it is a file to read
 * and rewrite in the current shape. Which of the two a document is cannot be
 * decided by a single "is this version supported" test, so the two get separate
 * answers here:
 *
 * - **newer** — refused with `FgcLockSchemaVersionError`. A document written
 *   against a future shape must not be read on a best-effort basis, and
 *   migrating backwards is data loss.
 * - **older, with a chain** — migrated step by step, each step a named function
 *   from one version to the next.
 * - **older, with no chain** — refused with `FgcLockMigrationError` naming the
 *   version that has no step. A half-migrated document that still looks readable
 *   is worse than one that fails, because the caller would then treat a shape it
 *   does not understand as project state.
 *
 * The registry is empty, and that is the truthful state rather than a stub: v1 is
 * the only version this format has ever had, so there is nothing to migrate from
 * yet. What is implemented and tested here is the machine the first migration
 * will use — the chain, the per-step contract, and the three failure modes above
 * — exercised against an *injected* legacy version. Declaring a v0 on disk purely
 * so a test could read it would put a version into this repository that never
 * existed, and a reviewer would have no way to tell it apart from a real one.
 *
 * Where the version list in `lock.ts` and the chain here meet: `lock.ts` says
 * which versions the read path *accepts*, which is the current one, because a
 * migrated document always arrives at it. This module says which versions can be
 * *brought* to the current one. A version can therefore be migratable without
 * being accepted, and that is the whole point.
 */

import type { FgcLockDocument } from "./lock";
import {
  assertFgcLockDocument,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockSchemaVersionError,
  FgcLockValidationError,
  inspectFgcLockDocument,
} from "./lock";

// ---------------------------------------------------------------------------
// The step contract
// ---------------------------------------------------------------------------

/**
 * One version-to-version rewrite of the document.
 *
 * A step is a *format* migration and nothing else. It must not re-decide
 * anything: dropping a decision because the current model would not accept it, or
 * filling in a strategy nobody chose, would turn "read an old lock" into "make
 * dependency decisions", which is #8's explicit non-goal. A step that finds a
 * record it cannot carry forward has to fail loudly rather than quietly leave it
 * behind.
 */
export interface FgcLockMigrationStep {
  /** The version this step reads. */
  readonly from: number;
  /** The version it produces. Exactly `from + 1`; see {@link validateFgcLockMigrationSteps}. */
  readonly to: number;
  /** One line for a changelog or a PR body, e.g. "move `probe.fingerprint` to `probeEvidence.fingerprint`". */
  readonly description: string;
  /**
   * Rewrites one version's document into the next.
   *
   * Takes and returns `Record<string, unknown>` rather than `FgcLockDocument`,
   * because the *previous* version's shape is by definition not the current one.
   * Typing the parameter as the current document would force every step to cast
   * its input, which hides the only thing a step exists to handle.
   */
  readonly migrate: (document: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/**
 * The migrations this toolchain knows.
 *
 * Empty until the format changes. Adding the first one means adding a step here
 * *and* the test that reads a document of the previous shape, so the step is
 * never the only description of a format that once existed.
 */
export const FGC_LOCK_MIGRATION_STEPS: readonly FgcLockMigrationStep[] = [];

/**
 * Problems with a step registry, before it is used.
 *
 * A chain, not a graph: each step advances exactly one version and no version has
 * two steps. Both rules exist for the same reason — a document must have one
 * defined history. Two steps from the same version make the result depend on
 * which one a lookup happened to find first, and a step that skips a version
 * leaves the versions it skipped unreachable even though "a migration exists" for
 * the range.
 */
export function validateFgcLockMigrationSteps(steps: readonly FgcLockMigrationStep[]): readonly string[] {
  const problems: string[] = [];
  const seenFrom = new Set<number>();

  for (const step of steps) {
    if (!Number.isInteger(step.from) || !Number.isInteger(step.to)) {
      problems.push(`A migration step must declare integer \`from\` and \`to\` versions, got ${step.from} → ${step.to}.`);
      continue;
    }
    if (step.to !== step.from + 1) {
      problems.push(
        `A migration step must advance exactly one version, but "${step.description}" declares ${step.from} → ${step.to}. Migrating several versions in one step leaves the versions it skipped with no reachable history.`,
      );
    }
    if (seenFrom.has(step.from)) {
      problems.push(
        `Two migration steps both read version ${step.from}; a document must have one defined history, not one per lookup order.`,
      );
    }
    seenFrom.add(step.from);
  }

  return problems;
}

export class FgcLockMigrationError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number, detail: string) {
    super(`${FGC_LOCK_FILE_NAME} declares schema version ${schemaVersion}, which ${detail}`);
    this.name = "FgcLockMigrationError";
    this.schemaVersion = schemaVersion;
  }
}

/**
 * A migration step that did not do what its own declaration says.
 *
 * Separate from {@link FgcLockMigrationError} because the two have different
 * fixes: an unmigratable document is a reason not to read, while a step that
 * produced the wrong version is a bug in this repository, and reporting them as
 * one error would send a reader looking at their lock file for a defect in the
 * toolchain.
 */
export class FgcLockMigrationStepError extends Error {
  readonly from: number;
  readonly expectedVersion: number;
  readonly producedVersion: unknown;

  constructor(from: number, expectedVersion: number, producedVersion: unknown) {
    super(
      `The migration step from version ${from} must produce a document declaring schema version ${expectedVersion}, but it produced ${JSON.stringify(producedVersion)}.`,
    );
    this.name = "FgcLockMigrationStepError";
    this.from = from;
    this.expectedVersion = expectedVersion;
    this.producedVersion = producedVersion;
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function findFgcLockMigrationStep(
  from: number,
  steps: readonly FgcLockMigrationStep[] = FGC_LOCK_MIGRATION_STEPS,
): FgcLockMigrationStep | undefined {
  return steps.find(step => step.from === from);
}

/**
 * Every version that can be brought to `to`, ascending, including `to` itself.
 *
 * Walked down from the target rather than up from zero, because reachability is
 * the question: a step from version 2 is only useful if version 3 is itself
 * reachable.
 */
export function migratableFgcLockSchemaVersions(
  steps: readonly FgcLockMigrationStep[] = FGC_LOCK_MIGRATION_STEPS,
  to: number = FGC_LOCK_SCHEMA_VERSION,
): readonly number[] {
  const reachable = new Set<number>([to]);
  for (let version = to - 1; version >= 0; version -= 1) {
    if (reachable.has(version + 1) && findFgcLockMigrationStep(version, steps) !== undefined) {
      reachable.add(version);
    }
  }
  return [...reachable].sort((a, b) => a - b);
}

/**
 * The steps that take `from` to `to`, oldest first.
 *
 * Names the first version with no step rather than reporting a count: the useful
 * message is "nobody wrote the migration from v3", not "the chain was
 * incomplete".
 */
export function planFgcLockMigration(
  from: number,
  to: number = FGC_LOCK_SCHEMA_VERSION,
  steps: readonly FgcLockMigrationStep[] = FGC_LOCK_MIGRATION_STEPS,
): readonly FgcLockMigrationStep[] {
  const problems = validateFgcLockMigrationSteps(steps);
  if (problems.length > 0) {
    throw new FgcLockValidationError(problems, `${FGC_LOCK_FILE_NAME} migration steps`);
  }

  if (from === to) {
    return [];
  }

  const planned: FgcLockMigrationStep[] = [];
  for (let version = from; version < to; version += 1) {
    const step = findFgcLockMigrationStep(version, steps);
    if (step === undefined) {
      throw new FgcLockMigrationError(
        from,
        `has no migration step to version ${version + 1}, so it cannot be brought forward to version ${to}. Write the step rather than reading the document on a best-effort basis.`,
      );
    }
    planned.push(step);
  }

  return planned;
}

// ---------------------------------------------------------------------------
// Migrating
// ---------------------------------------------------------------------------

export interface FgcLockMigrationOptions {
  /** A registry to use in place of {@link FGC_LOCK_MIGRATION_STEPS}. */
  readonly steps?: readonly FgcLockMigrationStep[];
  /** The version to arrive at; defaults to this toolchain's current one. */
  readonly to?: number;
}

export interface FgcLockMigrationResult {
  /** The document at the target version. Structurally sound, but not yet rule-checked. */
  readonly document: FgcLockDocument;
  /** Oldest first. Empty when the document already declared the target version. */
  readonly appliedSteps: readonly FgcLockMigrationStep[];
  /** The version the document declared on input. */
  readonly fromVersion: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a document's declared version, or explains why it cannot be read.
 *
 * Deliberately weaker than `inspectFgcLockDocument`: an older version's document
 * is *expected* to fail the current shape, so running the full inspection before
 * migrating would reject every document there is a migration for. Migration only
 * needs the two things that precede any version decision — a JSON object, and a
 * declared version — and everything else is checked on the far side.
 */
function declaredSchemaVersion(input: unknown): number {
  if (!isPlainObject(input)) {
    throw new FgcLockValidationError([`${FGC_LOCK_FILE_NAME} must contain a JSON object.`]);
  }
  const { schemaVersion } = input;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new FgcLockValidationError([`${FGC_LOCK_FILE_NAME} must declare an integer \`schemaVersion\`.`]);
  }
  return schemaVersion;
}

/**
 * Brings an untrusted parsed document to the target version.
 *
 * Never guesses and never partially applies: a chain that cannot be completed
 * throws before the first step runs, so a document is either exactly as it was on
 * disk or exactly at the target version, never halfway.
 */
export function migrateFgcLockDocument(
  input: unknown,
  options: FgcLockMigrationOptions = {},
): FgcLockMigrationResult {
  const fromVersion = declaredSchemaVersion(input);
  const to = options.to ?? FGC_LOCK_SCHEMA_VERSION;

  // A newer document is not an older one with missing history. Migrating
  // backwards would drop whatever the newer shape added, so it fails with the
  // type the read path already raises for an unreadable version.
  if (fromVersion > to) {
    throw new FgcLockSchemaVersionError(fromVersion);
  }

  const steps = options.steps ?? FGC_LOCK_MIGRATION_STEPS;
  const planned = planFgcLockMigration(fromVersion, to, steps);

  let current: Record<string, unknown> = input as Record<string, unknown>;
  for (const step of planned) {
    const migrated = step.migrate(current);
    const producedVersion = isPlainObject(migrated) ? migrated.schemaVersion : undefined;
    if (producedVersion !== step.to) {
      throw new FgcLockMigrationStepError(step.from, step.to, producedVersion);
    }
    current = migrated;
  }

  const problems = inspectFgcLockDocument(current);
  if (problems.length > 0) {
    throw new FgcLockValidationError(problems);
  }

  return { document: current as unknown as FgcLockDocument, appliedSteps: planned, fromVersion };
}

/**
 * Migrates a lock file's text and checks the result completely.
 *
 * The read path's entry point, and the only place the two halves meet: migrate,
 * then `assertFgcLockDocument` so the caller receives a document that is both the
 * current version and a legal one. Migration is not a shortcut past validation —
 * a step that produces a well-versioned but illegal document is caught here
 * rather than by whichever consumer reads the field first.
 */
export function parseMigratedFgcLockDocument(
  text: string,
  options: FgcLockMigrationOptions = {},
): FgcLockDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FgcLockValidationError([`${FGC_LOCK_FILE_NAME} is not valid JSON: ${(error as Error).message}`]);
  }

  const { document } = migrateFgcLockDocument(parsed, options);
  assertFgcLockDocument(document);
  return document;
}
