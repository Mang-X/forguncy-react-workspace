import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { FgcLockDocument, LockEnvironment, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import {
  canonicalizeFgcLock,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockValidationError,
  findMachineSpecificPaths,
  forguncyTargetIdentity,
  parseFgcLockDocument,
  RUNTIME_CONTRACT_TARGET,
  resolveLockDecision,
  serializeFgcLock,
} from "@forguncy-react-workspace/core";

import {
  compilationDependencies,
  fgcLockPath,
  localCompilationDependencies,
  readFgcLock,
  removeLockDecision,
  upsertLockDecision,
  writeFgcLock,
} from "./index.ts";

/** The subset of `writeFile`'s overloads this file needs to name. */
type WriteFileLike = (path: string, data: string, options?: string) => Promise<void>;

// Intercepts `writeFile` so a test can make a write fail *after* it has truncated its target —
// the failure a read-only file cannot produce, and the one that makes the atomicity assertions
// discriminate. `vi.mock` is hoisted, so this is in place before the module under test loads.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const writeFileMock = writeFile as unknown as MockInstance<WriteFileLike>;

/**
 * The genuine `writeFile`, captured before the mock replaces the module export.
 *
 * `import { writeFile }` above resolves to the mock, so the injection cannot reach the real
 * implementation through it — using that name inside the injected failure recursed until the
 * stack ran out.
 */
const genuineWriteFile = writeFileMock.getMockImplementation()!;


const FIXTURE = fileURLToPath(new URL("./__fixtures__/fgc.lock.json", import.meta.url));

const CELL_FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";
const CUSTOMERS_FINGERPRINT = "probe=inline-bundle;entry=src/cells/customers-card/App.tsx";
const BUNDLER_FINGERPRINT = "probe=amd-detect;entry=src/cells/orders-table/App.tsx";

/** The environment the committed example was validated in. */
function fixtureEnvironment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    resolvedVersions: {
      "@tanstack/react-query": "5.90.2",
      dayjs: "1.11.13",
      "es-toolkit": "1.39.8",
      react: "19.2.7",
      "some-amd-package": "2.4.0",
    },
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: { vitePlus: "0.3.2" },
    probeFingerprints: {
      "@tanstack/react-query": CELL_FINGERPRINT,
      dayjs: CUSTOMERS_FINGERPRINT,
      "es-toolkit": CELL_FINGERPRINT,
      react: CELL_FINGERPRINT,
      "some-amd-package": BUNDLER_FINGERPRINT,
    },
    extensionVersions: { "tanstack-query": "5.90.2" },
    extensionIdentities: { "tanstack-query": "sha256:9f1c2b7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091" },
    ...overrides,
  };
}

async function readFixture(): Promise<FgcLockDocument> {
  return parseFgcLockDocument(await readFile(FIXTURE, "utf8"));
}

async function emptyProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fgc-lock-"));
}

const inlineRecord: LockedDependencyDecision = {
  strategy: "inline",
  packageName: "dayjs",
  cellTarget: null,
  resolvedVersion: "1.11.13",
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: forguncyTargetIdentity(),
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [
    { kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8" },
    { kind: "probe", reference: "docs/probes/inline-dayjs.md" },
  ],
};

describe("fgc.lock.json as a project artifact", () => {
  it("ships a committed example that is exactly what the serializer produces", async () => {
    // The strongest form of "deterministic and reviewable in PRs": the committed
    // file is byte-identical to a fresh serialization of its own parsed content,
    // so a reviewer reads the real format and drift cannot hide.
    const text = await readFile(FIXTURE, "utf8");

    expect(serializeFgcLock(parseFgcLockDocument(text))).toBe(text);
    expect(findMachineSpecificPaths(JSON.parse(text))).toEqual([]);
  });

  it("resolves every record in the committed example as verified", async () => {
    const lock = await readFixture();
    const environment = fixtureEnvironment();

    for (const record of lock.decisions) {
      const resolution = resolveLockDecision(
        lock,
        { packageName: record.packageName, cellTarget: record.cellTarget },
        environment,
      );

      expect(resolution.state, record.packageName).toBe("verified");
    }
  });

  it("treats a project with no lock file as having no decisions", async () => {
    const projectRoot = await emptyProject();

    await expect(readFgcLock(projectRoot)).resolves.toEqual({
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [],
    });
    expect(fgcLockPath(projectRoot)).toBe(join(projectRoot, "fgc.lock.json"));
  });

  it("writes canonical bytes and reads them back unchanged", async () => {
    const projectRoot = await emptyProject();
    const lock: FgcLockDocument = {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [{ ...inlineRecord, packageName: "es-toolkit" }, inlineRecord],
    };

    await writeFgcLock(projectRoot, lock);
    const written = await readFile(fgcLockPath(projectRoot), "utf8");
    const reread = await readFgcLock(projectRoot);

    expect(written).toBe(serializeFgcLock(lock));
    expect(reread).toEqual(canonicalizeFgcLock(lock));

    // Rewriting an unchanged lock must not touch a byte, or every run would
    // produce a diff nobody made.
    await writeFgcLock(projectRoot, reread);
    expect(await readFile(fgcLockPath(projectRoot), "utf8")).toBe(written);
  });

  it("refuses to write a lock the read path would refuse", async () => {
    const projectRoot = await emptyProject();
    const broken = {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [{ ...inlineRecord, cellTarget: undefined }],
    };

    await expect(writeFgcLock(projectRoot, broken as never)).rejects.toThrow(FgcLockValidationError);
    // Nothing was written, so a later run does not inherit a file it cannot read.
    await expect(readFgcLock(projectRoot)).resolves.toEqual({
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [],
    });
  });

  /**
   * The write is an atomic replace, and callers depend on that.
   *
   * `writeFile(path, …)` opens the target with `w`, truncating it before a byte is written, so
   * a failure part-way through that call destroys the previous lock and leaves a partial one.
   * The dependency-selection Skill reads a throw as "nothing was written" and rolls back the
   * evidence it created on exactly that understanding, so a non-atomic writer would leave a
   * damaged lock *and* deleted evidence while reporting neither.
   *
   * The failure is injected by intercepting `writeFile` and making it truncate its own target
   * before throwing — the behaviour a mid-write I/O failure produces, and one a read-only file
   * cannot produce (that fails at `open`, before anything is destroyed). Without the injection
   * these tests pass against the old writer too, which is what an earlier version of them did.
   */
  describe("atomic replacement", () => {
    /** Truncates the destination and fails, as an interrupted write does. */
    function failingWriteFile(): WriteFileLike {
      return async (path: string) => {
        await genuineWriteFile(path, "", "utf8"); // the truncation an `open(w)` performs
        throw new Error("injected write failure after truncation");
      };
    }

    it("leaves the previous lock byte-identical when a write fails mid-way", async () => {
      const projectRoot = await emptyProject();
      await writeFgcLock(projectRoot, {
        schemaVersion: FGC_LOCK_SCHEMA_VERSION,
        decisions: [{ ...inlineRecord, packageName: "dayjs" }],
      });
      const before = await readFile(fgcLockPath(projectRoot), "utf8");

      writeFileMock.mockImplementation(failingWriteFile());
      try {
        await expect(
          writeFgcLock(projectRoot, {
            schemaVersion: FGC_LOCK_SCHEMA_VERSION,
            decisions: [{ ...inlineRecord, packageName: "dayjs" }, { ...inlineRecord, packageName: "react" }],
          }),
        ).rejects.toThrow("injected write failure");
      } finally {
        writeFileMock.mockRestore();
      }

      // Byte-identical, not merely "still parseable": the old writer truncated this file before
      // throwing, and a lock that lost content is exactly what this prevents.
      expect(await readFile(fgcLockPath(projectRoot), "utf8")).toBe(before);
      await expect(readFgcLock(projectRoot)).resolves.toEqual(
        canonicalizeFgcLock(JSON.parse(before) as FgcLockDocument),
      );
    });

    it("leaves no temporary file beside the lock when a write fails mid-way", async () => {
      // The staging file is an implementation detail the caller must not have to clean up, and a
      // stray one beside a lock is a file a later review would have to explain.
      const projectRoot = await emptyProject();
      await writeFgcLock(projectRoot, { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [inlineRecord] });

      writeFileMock.mockImplementation(failingWriteFile());
      try {
        await expect(
          writeFgcLock(projectRoot, {
            schemaVersion: FGC_LOCK_SCHEMA_VERSION,
            decisions: [inlineRecord, { ...inlineRecord, packageName: "react" }],
          }),
        ).rejects.toThrow();
      } finally {
        writeFileMock.mockRestore();
      }
      expect((await readdir(projectRoot)).sort()).toEqual(["fgc.lock.json"]);
    });

    it("replaces the lock at the same path when the write succeeds", async () => {
      // The other direction, so atomicity is not bought by never replacing the file: the bytes
      // change and the path does not, which is what the read path and the committed example
      // depend on.
      const projectRoot = await emptyProject();
      await writeFgcLock(projectRoot, { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [inlineRecord] });
      await writeFgcLock(projectRoot, {
        schemaVersion: FGC_LOCK_SCHEMA_VERSION,
        decisions: [{ ...inlineRecord, packageName: "dayjs" }, { ...inlineRecord, packageName: "react" }],
      });

      const reread = await readFgcLock(projectRoot);
      expect(reread.decisions.map(record => record.packageName)).toEqual(["dayjs", "react"]);
      expect((await readdir(projectRoot)).sort()).toEqual(["fgc.lock.json"]);
    });
  });
  // Canonicalization assumes the shape — `[...lock.decisions]`,
  // `[...record.evidence]` — so checking it after canonicalizing meant a
  // malformed value threw a native TypeError from inside the canonicalizer.
  it("refuses malformed input on the write path without a TypeError", async () => {
    const projectRoot = await emptyProject();
    const malformed: readonly unknown[] = [
      { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: undefined },
      { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [{ ...inlineRecord, evidence: undefined }] },
      { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [{ ...inlineRecord, evidence: "docs/probes/inline-dayjs.md" }] },
      { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [{ ...inlineRecord, probe: undefined }] },
    ];

    for (const lock of malformed) {
      await expect(writeFgcLock(projectRoot, lock as never)).rejects.toThrow(FgcLockValidationError);
    }
    await expect(readFgcLock(projectRoot)).resolves.toEqual({
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [],
    });
  });

  // The model describes `not-validated`, `probe-failed` and `probe-never-run` for
  // a resolved dependency. A lock file that cannot hold them makes those states
  // unreachable, so this round-trips them through the real artifact path.
  it("can persist a decision that makes no runtime claim yet", async () => {
    const projectRoot = await emptyProject();
    const locallyProbed: LockedDependencyDecision = { ...inlineRecord, packageName: "locally-probed", target: null };
    const failed: LockedDependencyDecision = {
      ...inlineRecord,
      packageName: "probe-failed",
      target: null,
      probe: { status: "failed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
    };
    const notRun: LockedDependencyDecision = {
      ...inlineRecord,
      packageName: "probe-not-run",
      target: null,
      probedWith: null,
      probe: { status: "not-run", fingerprint: null, versionIndependent: false },
    };

    await writeFgcLock(projectRoot, {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [locallyProbed, failed, notRun],
    });
    const read = await readFgcLock(projectRoot);
    const environment = fixtureEnvironment({
      resolvedVersions: { "locally-probed": "1.11.13", "probe-failed": "1.11.13", "probe-not-run": "1.11.13" },
      probeFingerprints: { "locally-probed": CELL_FINGERPRINT, "probe-failed": CELL_FINGERPRINT },
    });

    expect(resolveLockDecision(read, { packageName: "locally-probed" }, environment).assessment).toMatchObject({
      freshness: "fresh",
      stalenessReasons: [],
      realRuntimeValidation: "not-validated",
    });
    expect(resolveLockDecision(read, { packageName: "probe-failed" }, environment).assessment).toMatchObject({
      freshness: "stale",
      stalenessReasons: ["probe-failed"],
    });
    expect(resolveLockDecision(read, { packageName: "probe-not-run" }, environment).assessment).toMatchObject({
      stalenessReasons: ["probe-never-run"],
    });
  });

  it("refuses to read a lock it does not understand", async () => {
    const projectRoot = await emptyProject();
    await writeFile(fgcLockPath(projectRoot), JSON.stringify({ schemaVersion: 99, decisions: [] }), "utf8");

    await expect(readFgcLock(projectRoot)).rejects.toThrow(/unsupported schema version 99/i);
  });

  it("replaces a decision in place so a strategy change is an ordinary diff", () => {
    const before: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [inlineRecord] };

    const after = upsertLockDecision(before, {
      ...inlineRecord,
      strategy: "host",
      globalName: "dayjs",
      probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      target: null,
      probedWith: null,
      evidence: [{ kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/9" }],
    });

    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]?.strategy).toBe("host");
  });

  it("keeps decisions ordered when one is added or removed", () => {
    const lock: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [inlineRecord] };
    const added = upsertLockDecision(lock, { ...inlineRecord, packageName: "@tanstack/react-query" });

    expect(added.decisions.map(record => record.packageName)).toEqual(["@tanstack/react-query", "dayjs"]);
    expect(removeLockDecision(added, { packageName: "dayjs" }).decisions.map(record => record.packageName)).toEqual([
      "@tanstack/react-query",
    ]);
  });
});

describe("compiler projection", () => {
  it("never hands a replace decision to the compiler", async () => {
    const lock = await readFixture();

    const { dependencies, withheld } = compilationDependencies(lock, fixtureEnvironment(), { cellTarget: "orders-table" });

    expect(dependencies.map(decision => decision.packageName)).toEqual(["@tanstack/react-query", "es-toolkit", "react"]);
    expect(withheld).toEqual([
      { packageName: "react-router-dom", strategy: "replace", reason: "replace-cache" },
      { packageName: "some-amd-package", strategy: "replace", reason: "replace-cache" },
    ]);
  });

  // The first draft filtered only `replace`, so a decision the runtime had moved
  // past was still compiled as though someone had checked it.
  it("withholds a stale decision instead of compiling it", async () => {
    const lock = await readFixture();

    const { dependencies, withheld } = compilationDependencies(
      lock,
      fixtureEnvironment({ resolvedVersions: { ...fixtureEnvironment().resolvedVersions, "es-toolkit": "1.40.0" } }),
    );

    expect(dependencies.map(decision => decision.packageName)).not.toContain("es-toolkit");
    expect(withheld).toContainEqual({
      packageName: "es-toolkit",
      strategy: "inline",
      reason: "not-verified",
      stalenessReasons: ["package-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  // A rejection is checked for staleness before it is treated as a cache:
  // otherwise an expired technical rejection would be reported as a decision that
  // simply does not compile, and the caller would never learn it needs re-probing.
  it("reports an expired technical rejection as stale, not as a cache", async () => {
    const lock = await readFixture();

    const { dependencies, withheld } = compilationDependencies(
      lock,
      fixtureEnvironment({ resolvedVersions: { ...fixtureEnvironment().resolvedVersions, "some-amd-package": "2.5.0" } }),
    );

    expect(dependencies.map(decision => decision.packageName)).not.toContain("some-amd-package");
    expect(withheld).toContainEqual({
      packageName: "some-amd-package",
      strategy: "replace",
      reason: "not-verified",
      stalenessReasons: ["rejected-candidate-version-changed"],
      realRuntimeValidation: "not-required",
    });
    // The architectural rejection is not tied to any candidate, so it is still a
    // cache rather than something to re-probe.
    expect(withheld).toContainEqual({ packageName: "react-router-dom", strategy: "replace", reason: "replace-cache" });
  });

  it("withholds a decision whose runtime check never happened", async () => {
    const locallyProbed: LockedDependencyDecision = { ...inlineRecord, target: null, probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false } };
    const lock: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [locallyProbed] };

    const { dependencies, withheld } = compilationDependencies(
      lock,
      fixtureEnvironment({ probeFingerprints: { dayjs: CELL_FINGERPRINT } }),
    );

    expect(dependencies).toEqual([]);
    expect(withheld).toEqual([
      {
        packageName: "dayjs",
        strategy: "inline",
        reason: "not-verified",
        stalenessReasons: [],
        realRuntimeValidation: "not-validated",
      },
    ]);
  });

  it("resolves one decision per package, for the cell being compiled", async () => {
    const lock = await readFixture();

    const forCustomers = compilationDependencies(lock, fixtureEnvironment(), { cellTarget: "customers-card" });
    const forOrders = compilationDependencies(lock, fixtureEnvironment(), { cellTarget: "orders-table" });

    expect(forCustomers.dependencies.map(decision => decision.packageName)).toEqual([
      "@tanstack/react-query",
      "dayjs",
      "es-toolkit",
      "react",
    ]);
    // `dayjs` was only decided for the customers card, so another cell gets no
    // decision for it — reporting an undecided import is the compiler's own
    // audit, not something the lock can answer.
    expect(forOrders.dependencies.map(decision => decision.packageName)).toEqual([
      "@tanstack/react-query",
      "es-toolkit",
      "react",
    ]);
  });

  it("hands the compiler #4's decision model and nothing from the lock", async () => {
    const lock = await readFixture();

    const { dependencies } = compilationDependencies(lock, fixtureEnvironment());

    for (const decision of dependencies) {
      expect(Object.keys(decision)).not.toContain("probe");
      expect(Object.keys(decision)).not.toContain("evidence");
      expect(Object.keys(decision)).not.toContain("cellTarget");
      expect(Object.keys(decision)).not.toContain("resolvedVersion");
    }
    expect(dependencies[0]).toEqual({
      strategy: "extension",
      packageName: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    });
  });

  it("projects an empty lock to an empty dependency list", () => {
    const empty: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [] };

    expect(compilationDependencies(empty, fixtureEnvironment())).toEqual({ dependencies: [], withheld: [] });
    expect(localCompilationDependencies(empty, fixtureEnvironment())).toEqual({ dependencies: [], withheld: [] });
  });
});

describe("local compilation projection", () => {
  // The deployment gate withholds a locally probed record (target: null) as
  // not-validated. The local projection must still hand it to the compiler when
  // fresh — that is the whole point: local PoC questions are answerable without
  // a fake runtime claim in the lock.
  it("projects a not-validated record the deployment gate would withhold", async () => {
    const locallyProbed: LockedDependencyDecision = {
      ...inlineRecord,
      target: null,
      probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
    };
    const lock: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [locallyProbed] };
    const environment = fixtureEnvironment({ probeFingerprints: { dayjs: CELL_FINGERPRINT } });

    const gated = compilationDependencies(lock, environment);
    expect(gated.dependencies).toEqual([]);
    expect(gated.withheld).toEqual([
      {
        packageName: "dayjs",
        strategy: "inline",
        reason: "not-verified",
        stalenessReasons: [],
        realRuntimeValidation: "not-validated",
      },
    ]);

    const local = localCompilationDependencies(lock, environment);
    expect(local.withheld).toEqual([]);
    expect(local.dependencies).toEqual([{ strategy: "inline", packageName: "dayjs" }]);
  });

  // Freshness is NOT relaxed on the local path — only real-runtime validation
  // is. A moved package version is stale evidence on both projections.
  it("withholds a package-version drift the same way the deployment gate does", async () => {
    const lock = await readFixture();
    const environment = fixtureEnvironment({
      resolvedVersions: { ...fixtureEnvironment().resolvedVersions, "es-toolkit": "1.40.0" },
    });

    const local = localCompilationDependencies(lock, environment);
    expect(local.dependencies.map(decision => decision.packageName)).not.toContain("es-toolkit");
    expect(local.withheld).toContainEqual({
      packageName: "es-toolkit",
      strategy: "inline",
      reason: "not-verified",
      stalenessReasons: ["package-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("withholds an extension-version drift on the local path too", async () => {
    const lock = await readFixture();
    const environment = fixtureEnvironment({ extensionVersions: { "tanstack-query": "5.91.0" } });

    const local = localCompilationDependencies(lock, environment);
    expect(local.dependencies.map(decision => decision.packageName)).not.toContain("@tanstack/react-query");
    expect(local.withheld).toContainEqual({
      packageName: "@tanstack/react-query",
      strategy: "extension",
      reason: "not-verified",
      stalenessReasons: ["extension-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("still withholds replace as a cache — rule 4 of #8 applies locally too", async () => {
    const lock = await readFixture();

    const { dependencies, withheld } = localCompilationDependencies(lock, fixtureEnvironment());

    expect(withheld).toEqual([
      { packageName: "react-router-dom", strategy: "replace", reason: "replace-cache" },
      { packageName: "some-amd-package", strategy: "replace", reason: "replace-cache" },
    ]);
    expect(dependencies.map(decision => decision.packageName)).toEqual([
      "@tanstack/react-query",
      "es-toolkit",
      "react",
    ]);
  });

  it("hands the compiler #4's decision model, same shape as the gate", async () => {
    const lock = await readFixture();

    const { dependencies } = localCompilationDependencies(lock, fixtureEnvironment());

    expect(dependencies[0]).toEqual({
      strategy: "extension",
      packageName: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    });
    for (const decision of dependencies) {
      expect(Object.keys(decision)).not.toContain("probe");
      expect(Object.keys(decision)).not.toContain("evidence");
      expect(Object.keys(decision)).not.toContain("target");
    }
  });
});
