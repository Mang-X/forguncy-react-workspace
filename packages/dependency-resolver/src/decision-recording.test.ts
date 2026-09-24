import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LockEnvironment } from "@forguncy-react-workspace/core";
import {
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockValidationError,
  forguncyTargetIdentity,
  resolveLockDecision,
  RUNTIME_CONTRACT_TARGET,
  serializeFgcLock,
} from "@forguncy-react-workspace/core";

import type { DependencyDecisionUpdate } from "./index.ts";
import {
  fgcLockPath,
  mergeDependencyDecisionUpdate,
  readFgcLock,
  recordDependencyDecision,
  recordDependencyDecisions,
} from "./index.ts";

const CELL_FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fgc-recording-"));
}

function inlineUpdate(packageName: string, overrides: Partial<DependencyDecisionUpdate> = {}): DependencyDecisionUpdate {
  return {
    decision: { strategy: "inline", packageName },
    probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
    resolvedVersion: "1.11.13",
    probedWith: { vitePlus: "0.3.2" },
    target: forguncyTargetIdentity(),
    evidence: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
    ...overrides,
  };
}

function extensionUpdate(overrides: Partial<DependencyDecisionUpdate> = {}): DependencyDecisionUpdate {
  return {
    decision: {
      strategy: "extension",
      packageName: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    },
    probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
    resolvedVersion: "5.90.2",
    probedWith: { vitePlus: "0.3.2" },
    target: forguncyTargetIdentity(),
    extension: { version: "5.90.2", identity: null },
    rationale: "A bundled copy would give every cell its own query cache, so the shared global is required.",
    evidence: [{ kind: "runtime-observation", reference: "docs/probes/extension-tanstack-query.md" }],
    ...overrides,
  };
}

function environment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    resolvedVersions: { dayjs: "1.11.13", "@tanstack/react-query": "5.90.2" },
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: { vitePlus: "0.3.2" },
    probeFingerprints: { dayjs: CELL_FINGERPRINT, "@tanstack/react-query": CELL_FINGERPRINT },
    extensionVersions: { "tanstack-query": "5.90.2" },
    extensionIdentities: {},
    ...overrides,
  };
}

describe("recording an observation", () => {
  it("writes a decision that nothing had recorded before", async () => {
    const root = await project();

    const result = await recordDependencyDecision(root, inlineUpdate("dayjs"));

    expect(result.replaced).toBe(false);
    expect(result.record.packageName).toBe("dayjs");
    expect(result.record.rationale).toBeNull();
    expect(await readFgcLock(root)).toEqual(result.lock);
    expect(await readFile(fgcLockPath(root), "utf8")).toBe(serializeFgcLock(result.lock));
  });

  // The requirement the whole API exists for. #4 requires a written justification
  // for `extension` and `replace`, and a probe re-runs many times — so an API that
  // replaced the record would delete the justification on the first re-run, and the
  // diff would not show it because every key would still be present.
  it("keeps the recorded reason when a re-probe carries only a measurement", async () => {
    const root = await project();
    const first = await recordDependencyDecision(root, extensionUpdate());

    const second = await recordDependencyDecision(root, extensionUpdate({ rationale: undefined }));

    expect(second.replaced).toBe(true);
    expect(second.record.rationale).toBe(first.record.rationale);
    expect(second.record.rationale).toContain("own query cache");
  });

  it("lets an update replace the reason deliberately", async () => {
    const root = await project();
    await recordDependencyDecision(root, extensionUpdate());

    const second = await recordDependencyDecision(root, extensionUpdate({ rationale: "Sharing measured at 41 KB." }));

    expect(second.record.rationale).toBe("Sharing measured at 41 KB.");
  });

  it("drops the reason when the strategy changes, and refuses a new strategy that owes one", async () => {
    const root = await project();
    await recordDependencyDecision(root, extensionUpdate());

    // `inline` needs no justification, so the stale one is dropped and the write
    // succeeds — carrying it over would attach a written reason to a strategy
    // nobody justified.
    const asInline = await recordDependencyDecision(
      root,
      inlineUpdate("@tanstack/react-query", { resolvedVersion: "5.90.2" }),
    );

    expect(asInline.record.rationale).toBeNull();

    // And the reverse: going back to `extension` without a reason fails the write,
    // because #4 requires one and the old one no longer applies.
    await expect(
      recordDependencyDecision(root, extensionUpdate({ rationale: undefined })),
    ).rejects.toThrow(FgcLockValidationError);
    await expect(
      recordDependencyDecision(root, extensionUpdate({ rationale: undefined })),
    ).rejects.toThrow(/requires a written justification/i);
  });

  // Removal is deliberately not expressible through an update: a lock whose history
  // an update could silently drop is not reviewable.
  it("accumulates evidence instead of replacing it", async () => {
    const root = await project();
    const first = await recordDependencyDecision(root, inlineUpdate("dayjs"));

    const second = await recordDependencyDecision(
      root,
      inlineUpdate("dayjs", {
        evidence: [
          { kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8" },
        ],
      }),
    );

    expect(first.record.evidence).toHaveLength(1);
    expect(second.record.evidence.map(link => link.reference)).toEqual([
      "docs/probes/inline-dayjs.md",
      "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
    ]);

    // Recording the same evidence again is not a second entry: a re-probe that
    // observes the same thing must not grow the list.
    const third = await recordDependencyDecision(
      root,
      inlineUpdate("dayjs", {
        evidence: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
      }),
    );
    expect(third.record.evidence).toHaveLength(2);
  });

  it("takes the measurement from the update", async () => {
    const root = await project();
    await recordDependencyDecision(root, inlineUpdate("dayjs"));

    const failed = await recordDependencyDecision(
      root,
      inlineUpdate("dayjs", {
        probe: { status: "failed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
        // A failed probe cannot carry a runtime claim, so the target goes with it —
        // the same rule the lock's validation enforces, reached through the update
        // rather than by writing the record out by hand.
        target: undefined,
      }),
    );

    expect(failed.record.probe.status).toBe("failed");
    // A re-run that left the previous measurement in place would report a state
    // nobody observed.
    expect(failed.record.probe.fingerprint).toBe(CELL_FINGERPRINT);
    expect(failed.record.target).toBeNull();
    expect(resolveLockDecision(failed.lock, { packageName: "dayjs" }, environment()).assessment).toMatchObject({
      freshness: "stale",
      stalenessReasons: ["probe-failed"],
      realRuntimeValidation: "not-validated",
    });
  });

  it("refuses a failed probe that still claims the runtime it never validated against", async () => {
    const root = await project();

    await expect(
      recordDependencyDecision(
        root,
        inlineUpdate("dayjs", {
          probe: { status: "failed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
        }),
      ),
    ).rejects.toThrow(/names a Forguncy target while its probe is "failed"/i);
  });

  // A record to change is identified by its key. `findLockDecision` *resolves* a
  // query and falls back to the target-independent record, which for a write would
  // copy one target's justification onto another.
  it("does not copy a target-independent reason onto a cell-specific record", async () => {
    const root = await project();
    const shared = await recordDependencyDecision(
      root,
      inlineUpdate("dayjs", { rationale: "Every cell in this project needs a date formatter." }),
    );

    const specific = await recordDependencyDecision(
      root,
      inlineUpdate("dayjs", { cellTarget: "customers-card", rationale: undefined }),
    );

    expect(shared.record.rationale).toContain("Every cell");
    expect(specific.record.rationale).toBeNull();
    expect(specific.lock.decisions).toHaveLength(2);
    expect(specific.lock.decisions.find(record => record.cellTarget === null)?.rationale).toBe(shared.record.rationale);
  });

  it("refuses an update the read path would refuse", async () => {
    const root = await project();

    // A passed probe with nothing linking it: the record would claim a measurement
    // it cannot be re-checked against.
    await expect(recordDependencyDecision(root, inlineUpdate("dayjs", { evidence: [] }))).rejects.toThrow(
      /records no evidence/i,
    );

    // A passed probe linked only to a Spec: the probe itself is unaccounted for.
    await expect(
      recordDependencyDecision(
        root,
        inlineUpdate("dayjs", {
          evidence: [
            { kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8" },
          ],
        }),
      ),
    ).rejects.toThrow(/links no `probe` or `runtime-observation` evidence/i);

    // Nothing reached the file, so the next run does not inherit a lock it cannot read.
    expect(await readFgcLock(root)).toEqual({ schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [] });
  });

  it("is idempotent: recording the same observation twice does not touch a byte", async () => {
    const root = await project();

    await recordDependencyDecision(root, extensionUpdate());
    const afterFirst = await readFile(fgcLockPath(root), "utf8");
    await recordDependencyDecision(root, extensionUpdate());

    expect(await readFile(fgcLockPath(root), "utf8")).toBe(afterFirst);
  });

  it("records a batch in one lock write", async () => {
    const root = await project();

    const result = await recordDependencyDecisions(root, [
      extensionUpdate(),
      inlineUpdate("dayjs"),
      // The same package twice in one batch must still produce one record.
      inlineUpdate("dayjs", { resolvedVersion: "1.11.14" }),
    ]);

    expect(result.records).toHaveLength(3);
    expect(result.lock.decisions.map(record => record.packageName)).toEqual(["@tanstack/react-query", "dayjs"]);
    expect(result.lock.decisions.find(record => record.packageName === "dayjs")?.resolvedVersion).toBe("1.11.14");
    expect(await readFile(fgcLockPath(root), "utf8")).toBe(serializeFgcLock(result.lock));
  });
});

describe("the merge, on its own", () => {
  it("is pure, so a caller can inspect the result before writing it", () => {
    const merged = mergeDependencyDecisionUpdate(null, extensionUpdate());

    // Narrowed rather than cast: the merge returns #4's union, and asserting the
    // variant is the same check a caller would make before acting on it.
    if (merged.strategy !== "extension") {
      throw new Error(`expected an extension decision, got "${merged.strategy}"`);
    }
    expect(merged.libraryId).toBe("tanstack-query");
    expect(merged.globalName).toBe("TanStackQuery");
    expect(merged.rationale).toContain("query cache");
    expect(merged.cellTarget).toBeNull();
  });

  it("nulls every measurement an update omits rather than inheriting the old one", () => {
    const existing = mergeDependencyDecisionUpdate(null, extensionUpdate());

    const merged = mergeDependencyDecisionUpdate(existing, extensionUpdate({ target: undefined, extension: undefined }));

    expect(merged.target).toBeNull();
    expect(merged.extension).toBeNull();
    // …while the reason, which is not a measurement, is still there.
    expect(merged.rationale).toBe(existing.rationale);
  });

  it("treats an empty rationale as supplied, not as absent", async () => {
    const merged = mergeDependencyDecisionUpdate(
      mergeDependencyDecisionUpdate(null, extensionUpdate()),
      extensionUpdate({ rationale: "" }),
    );

    // `""` is not the same as omitting the field: the update spoke, and said there
    // is no reason. That is a strategy owing a justification with none, which is an
    // error — not a silent reversion to the recorded one.
    expect(merged.rationale).toBe("");

    const root = await project();
    await expect(recordDependencyDecision(root, extensionUpdate({ rationale: "" }))).rejects.toThrow(
      FgcLockValidationError,
    );
  });
});
