import { describe, expect, it } from "vitest";

import type { FgcLockDocument, FgcLockMigrationStep, LockedDependencyDecision } from "./index.ts";
import {
  FGC_LOCK_MIGRATION_STEPS,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockMigrationError,
  FgcLockMigrationStepError,
  FgcLockSchemaVersionError,
  FgcLockValidationError,
  findFgcLockMigrationStep,
  migrateFgcLockDocument,
  migratableFgcLockSchemaVersions,
  parseMigratedFgcLockDocument,
  planFgcLockMigration,
  serializeFgcLock,
  validateFgcLockMigrationSteps,
} from "./index.ts";

const validRecord: LockedDependencyDecision = {
  strategy: "inline",
  packageName: "dayjs",
  cellTarget: null,
  resolvedVersion: "1.11.13",
  probe: { status: "passed", fingerprint: "probe=inline-bundle;entry=src/cells/orders-table/App.tsx", versionIndependent: false },
  target: null,
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
};

const currentDocument: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [validRecord] };

/**
 * A v0 document, invented here rather than committed.
 *
 * The migration machinery has to be exercised, and v1 is the only version this
 * format has ever had — so the legacy shape lives in this test, where the absence
 * of a real v0 on disk is visible, instead of being written into the repository as
 * a fixture a reviewer could mistake for a format that once shipped.
 */
const legacyV0Document = {
  schemaVersion: 0,
  entries: [
    {
      packageName: "dayjs",
      strategy: "inline",
      resolvedVersion: "1.11.13",
      probe: validRecord.probe,
      target: null,
      probedWith: { vitePlus: "0.3.2" },
      extension: null,
      rejectedCandidate: null,
      rationale: null,
      // v0 called the list `sources` and had no `cellTarget`.
      sources: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
    },
  ],
};

/** The step a v0 → v1 migration would be: a rename and a filled-in default. */
const legacyV0Step: FgcLockMigrationStep = {
  from: 0,
  to: 1,
  description: "rename `entries[].sources` to `evidence` and default `cellTarget` to null",
  migrate: document => ({
    schemaVersion: 1,
    decisions: (document.entries as readonly Record<string, unknown>[]).map(entry => {
      const migrated: Record<string, unknown> = { ...entry, cellTarget: null, evidence: entry.sources };
      delete migrated.sources;
      return migrated;
    }),
  }),
};

const legacySteps: readonly FgcLockMigrationStep[] = [legacyV0Step];

describe("fgc.lock.json schema migration", () => {
  // The honest state of the registry, asserted so a reader does not have to open
  // the module to learn that v1 is the only version there has ever been.
  it("has nothing to migrate yet, and says so", () => {
    expect(FGC_LOCK_MIGRATION_STEPS).toEqual([]);
    expect(migratableFgcLockSchemaVersions()).toEqual([FGC_LOCK_SCHEMA_VERSION]);
    expect(planFgcLockMigration(FGC_LOCK_SCHEMA_VERSION)).toEqual([]);
    expect(findFgcLockMigrationStep(FGC_LOCK_SCHEMA_VERSION)).toBeUndefined();
  });

  it("leaves a current-version document alone", () => {
    const result = migrateFgcLockDocument(currentDocument);

    expect(result).toEqual({ document: currentDocument, appliedSteps: [], fromVersion: FGC_LOCK_SCHEMA_VERSION });
  });

  it("brings an older document forward and validates the result", () => {
    // The whole point of the feature: a document written by a previous toolchain is
    // read by this one instead of being refused for ever.
    const document = parseMigratedFgcLockDocument(JSON.stringify(legacyV0Document), { steps: legacySteps });

    expect(document).toEqual(currentDocument);
    expect(serializeFgcLock(document)).toContain('"schemaVersion": 1');
  });

  it("reports which steps it applied", () => {
    const result = migrateFgcLockDocument(legacyV0Document, { steps: legacySteps });

    expect(result.fromVersion).toBe(0);
    expect(result.appliedSteps.map(step => step.from)).toEqual([0]);
  });

  it("refuses an older version nobody wrote a step for", () => {
    // Half-migrating is the failure mode this refuses: a document that still reads
    // as project state while carrying a shape nothing here validated.
    expect(() => migrateFgcLockDocument(legacyV0Document, { steps: [] })).toThrow(FgcLockMigrationError);
    expect(() => migrateFgcLockDocument(legacyV0Document, { steps: [] })).toThrow(/no migration step to version 1/i);
  });

  it("names the version that has no step, not just the failure", () => {
    const gap: readonly FgcLockMigrationStep[] = [
      { from: 2, to: 3, description: "a step for a version this document is not", migrate: document => document },
    ];

    // v0 → v1 has no step even though a later one exists, and the message has to
    // point at v0 rather than at the chain being "incomplete" in general.
    expect(() => migrateFgcLockDocument({ schemaVersion: 0, entries: [] }, { steps: gap })).toThrow(
      /schema version 0, which has no migration step/,
    );
  });

  it("refuses a newer document instead of migrating backwards", () => {
    // Symmetry is deliberate: an older document is readable history, a newer one is
    // a shape this toolchain cannot judge, and reading it backwards loses whatever
    // the newer format added.
    const newer = { schemaVersion: FGC_LOCK_SCHEMA_VERSION + 1, decisions: [] };

    expect(() => migrateFgcLockDocument(newer)).toThrow(FgcLockSchemaVersionError);
    expect(() => parseMigratedFgcLockDocument(JSON.stringify(newer))).toThrow(/unsupported schema version 2/i);
  });

  it("refuses a step that does not produce the version it declares", () => {
    const liar: FgcLockMigrationStep = {
      from: 0,
      to: 1,
      description: "declares 0 → 1 but writes 2",
      migrate: document => ({ ...document, schemaVersion: 2 }),
    };

    expect(() => migrateFgcLockDocument(legacyV0Document, { steps: [liar] })).toThrow(FgcLockMigrationStepError);
    // A step that happens to leave the version off is the same defect.
    const silent: FgcLockMigrationStep = {
      from: 0,
      to: 1,
      description: "produces no version at all",
      migrate: () => ({ decisions: [] }),
    };
    expect(() => migrateFgcLockDocument(legacyV0Document, { steps: [silent] })).toThrow(FgcLockMigrationStepError);
  });

  it("refuses a migrated document that breaks the current rules", () => {
    // Migration is not a way past validation: a step that ships a well-versioned but
    // illegal document is caught here rather than by whichever consumer reads the
    // field first.
    const careless: FgcLockMigrationStep = {
      from: 0,
      to: 1,
      description: "drops the evidence list",
      migrate: () => ({ schemaVersion: 1, decisions: [{ ...validRecord, evidence: [] }] }),
    };

    expect(() => parseMigratedFgcLockDocument(JSON.stringify(legacyV0Document), { steps: [careless] })).toThrow(
      FgcLockValidationError,
    );
  });

  it("refuses input that declares no usable version", () => {
    for (const input of [null, [], "fgc.lock.json", { decisions: [] }, { schemaVersion: "1" }, { schemaVersion: 1.5 }]) {
      expect(() => migrateFgcLockDocument(input)).toThrow(FgcLockValidationError);
    }
  });

  it("reports a malformed JSON file as malformed rather than as unmigratable", () => {
    expect(() => parseMigratedFgcLockDocument("{ not json")).toThrow(/is not valid JSON/);
  });

  it("reads the current version through the same path, rules and all", () => {
    expect(parseMigratedFgcLockDocument(serializeFgcLock(currentDocument))).toEqual(currentDocument);
    // Same refusal the plain parser gives, so adding migration did not soften it.
    expect(() => parseMigratedFgcLockDocument('{"schemaVersion":1,"decisions":[{"packageName":"x"}]}')).toThrow(
      FgcLockValidationError,
    );
  });
});

describe("the migration step registry's own contract", () => {
  it("accepts a well-formed chain", () => {
    expect(validateFgcLockMigrationSteps(legacySteps)).toEqual([]);
  });

  it("refuses a step that skips a version", () => {
    // A skipping step leaves the versions it skipped unreachable while looking like
    // a migration "for" the range.
    const skipping: readonly FgcLockMigrationStep[] = [
      { from: 1, to: 3, description: "1 → 3", migrate: document => document },
    ];

    expect(validateFgcLockMigrationSteps(skipping)).toEqual([expect.stringContaining("advance exactly one version")]);
    expect(() => planFgcLockMigration(1, 3, skipping)).toThrow(FgcLockValidationError);
  });

  it("refuses two steps that read the same version", () => {
    const ambiguous: readonly FgcLockMigrationStep[] = [
      { from: 0, to: 1, description: "a", migrate: document => document },
      { from: 0, to: 1, description: "b", migrate: document => document },
    ];

    expect(validateFgcLockMigrationSteps(ambiguous)).toEqual([
      expect.stringContaining("Two migration steps both read version 0"),
    ]);
  });

  it("refuses non-integer versions", () => {
    const fractional: readonly FgcLockMigrationStep[] = [
      { from: 0.5, to: 1.5, description: "fractional", migrate: document => document },
    ];

    expect(validateFgcLockMigrationSteps(fractional)).toEqual([expect.stringContaining("integer")]);
  });

  it("counts only versions that can actually reach the target", () => {
    // v1 is reachable from v0 when the step exists, and v2 is not reachable from v1
    // because nothing reads v1.
    expect(migratableFgcLockSchemaVersions(legacySteps, 1)).toEqual([0, 1]);
    expect(migratableFgcLockSchemaVersions([], 1)).toEqual([1]);
  });
});
