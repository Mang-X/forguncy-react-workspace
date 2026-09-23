/**
 * The probe engine end-to-end against the committed fixture projects (#17).
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (protocol validity, observing-step table, determinism,
 * no absolute paths, risks-vs-failures), #8 (fingerprint/cache invalidation and
 * the lock evidence this engine hands back), #4 (architecture conflicts are
 * ownership, not probe, findings — `assessDependencyRole` decides those).
 *
 * Local checks only: these tests execute the engine's build step through the
 * workspace Rolldown stack. They are not a Forguncy runtime validation.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ProbeReport } from "@forguncy-react-workspace/core";
import {
  assessDependencyRole,
  assessLockDecision,
  assessProbeReport,
  assertProbeReport,
  findForbiddenProbeKeys,
  forguncyTargetIdentity,
  lockProbeStatusForAssessment,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_STEP_IDS,
  replacementRejectionFor,
  RUNTIME_CONTRACT_TARGET,
  serializeProbeReport,
  validateProbeReport,
} from "@forguncy-react-workspace/core";

import type { DependencyProbeResult, RunDependencyProbeOptions } from "./probe-engine";
import {
  ProbeIdentityError,
  probeLockEnvironment,
  probeRunLockEvidence,
  runDependencyProbe,
} from "./probe-engine";
import { probeCacheRelativePath } from "./cache";
import { composeProbeFingerprint } from "./fingerprint";

const FIXTURES_ROOT = fileURLToPath(new URL("../__fixtures__/probe", import.meta.url));

function fixture(name: string): string {
  return join(FIXTURES_ROOT, name);
}

async function probe(
  name: string,
  packageName: string,
  overrides: Partial<RunDependencyProbeOptions> = {},
): Promise<DependencyProbeResult> {
  return runDependencyProbe({
    projectRoot: fixture(name),
    packageName,
    cache: false,
    ...overrides,
  });
}

function validationByStep(report: ProbeReport): Map<string, string> {
  return new Map(report.validation.map(entry => [entry.step, entry.outcome]));
}

function riskSignals(report: ProbeReport): string[] {
  return report.risks.map(risk => risk.signal);
}

function rejectionSignals(report: ProbeReport): string[] {
  return report.rejectionFindings.map(finding => finding.signal);
}

describe("runDependencyProbe: report validity", () => {
  it("emits a protocol-valid report with all nine steps exactly once", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math");

    expect(validateProbeReport(report)).toEqual([]);
    assertProbeReport(report);
    expect(report.schemaVersion).toBe(PROBE_REPORT_SCHEMA_VERSION);
    expect(report.validation.map(entry => entry.step)).toEqual([...PROBE_STEP_IDS]);
    expect(findForbiddenProbeKeys(report)).toEqual([]);
    expect(report.environment.packageName).toBe("tiny-math");
    expect(report.environment.packageVersion).toBe("1.0.0");
    expect(report.environment.source).toBe("https://github.com/example/tiny-math");
  });

  it("keeps absolute fixture paths out of the serialized report", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math");
    const text = serializeProbeReport(report);
    const root = fixture("pure-esm-utility");

    expect(text).not.toContain(root);
    expect(text).not.toContain(root.split("\\").join("/"));
    // A leaked absolute path would still show a drive-letter or home path form.
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\//);
  });

  it("is byte-identical across two uncached runs of the same inputs", async () => {
    const first = await probe("pure-esm-utility", "tiny-math");
    const second = await probe("pure-esm-utility", "tiny-math");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(serializeProbeReport(first.report)).toBe(serializeProbeReport(second.report));
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(false);
  });
});

describe("runDependencyProbe: pure ESM utility", () => {
  it("supports deployment with the positive signals as facts", async () => {
    const { report, assessment, lockStatus } = await probe("pure-esm-utility", "tiny-math");

    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");
    expect(rejectionSignals(report)).toEqual([]);
    expect(riskSignals(report)).toEqual([]);

    const facts = report.facts;
    expect(facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
    expect(facts.some(fact => fact.name === "exports.browser-resolvable" && fact.value === true)).toBe(true);
    expect(facts.some(fact => fact.name === "signal.self-contained-runtime-assets" && fact.value === true)).toBe(true);

    const outcomes = validationByStep(report);
    expect(outcomes.get("package-identity")).toBe("passed");
    expect(outcomes.get("export-metadata")).toBe("passed");
    expect(outcomes.get("node-builtin-scan")).toBe("passed");
    expect(outcomes.get("build")).toBe("passed");
    expect(outcomes.get("artifact-scan")).toBe("passed");
    expect(outcomes.get("asset-inventory")).toBe("passed");
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");
    expect(outcomes.get("size")).toBe("passed");
    // No browser in this toolchain: the honest record is a skip with a reason.
    expect(outcomes.get("runtime-smoke")).toBe("skipped");
    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.diagnostics).toEqual([]);
    expect(smoke.detail.length).toBeGreaterThan(0);
  });
});

describe("runDependencyProbe: react library", () => {
  it("records peer ranges and shipped types as facts, still supports deployment", async () => {
    const { report, assessment } = await probe("react-library", "@fixture/date-picker");

    expect(assessment.status).toBe("supports-deployment");
    expect(report.facts.some(fact => fact.name === "peerDependencies.ranges")).toBe(true);
    expect(report.facts.some(fact => fact.name === "exports.types-present" && fact.value === true)).toBe(true);
    expect(rejectionSignals(report)).toEqual([]);
  });
});

describe("runDependencyProbe: worker and wasm risks are risks, not failures", () => {
  it("keeps Worker/WASM as risks and still passes the static steps", async () => {
    const { report, assessment, lockStatus } = await probe("worker-wasm-risk", "heavy-parser");

    const outcomes = validationByStep(report);
    expect(outcomes.get("build")).toBe("passed");
    expect(outcomes.get("artifact-scan")).toBe("passed");
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");

    const signals = riskSignals(report);
    expect(signals).toContain("worker");
    expect(signals).toContain("import-meta-url-asset");
    // WASM may surface from artifact-scan (or asset-inventory); never as a rejection.
    expect(signals).toContain("wasm");
    expect(rejectionSignals(report)).toEqual([]);

    // Risks never turn a clean static report into a rejection-only one on their own.
    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");
    expect(assessment.risksToWeigh.length).toBeGreaterThan(0);
  });

  it("attributes worker risks to the observing steps the protocol allows", async () => {
    const { report } = await probe("worker-wasm-risk", "heavy-parser");

    for (const risk of report.risks) {
      expect(["artifact-scan", "runtime-pattern-scan", "asset-inventory"]).toContain(risk.step);
    }
    for (const finding of report.rejectionFindings) {
      expect(["artifact-scan", "runtime-pattern-scan", "asset-inventory"]).not.toContain(
        // no rejections expected here; guard against wasm being mis-filed
        finding.signal === "wasm" ? "runtime-pattern-scan" : "",
      );
    }
    expect(rejectionSignals(report)).toEqual([]);
  });
});

describe("runDependencyProbe: node-only package", () => {
  it("files the node-filesystem rejection and maps it to platform-api-unavailable", async () => {
    const { report, assessment, lockStatus } = await probe("node-only", "config-from-disk");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.step).toBe("node-builtin-scan");
    expect(finding?.evidence.some(item => item.startsWith("builtin:"))).toBe(true);

    // Positive signal is absent when builtins were found.
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(false);

    expect(assessment.status).toBe("supports-rejection-only");
    expect(lockStatus).toBe("failed");
    expect(replacementRejectionFor("node-filesystem-process-or-native-addon", "config-from-disk")?.code).toBe(
      "platform-api-unavailable",
    );
    // The step succeeded at observing — a rejection is not a step failure.
    expect(validationByStep(report).get("node-builtin-scan")).toBe("passed");
  });
});

describe("runDependencyProbe: broken build", () => {
  it("fails the build with actionable, portable diagnostics and cascades skips", async () => {
    const { report, assessment, lockStatus } = await probe("broken-build", "broken-widget");

    const build = report.validation.find(entry => entry.step === "build")!;
    expect(build.outcome).toBe("failed");
    expect(build.diagnostics.length).toBeGreaterThan(0);
    expect(build.diagnostics.every(line => line.trim().length > 0)).toBe(true);
    expect(build.detail.length).toBeGreaterThan(0);

    const outcomes = validationByStep(report);
    expect(outcomes.get("artifact-scan")).toBe("skipped");
    expect(outcomes.get("asset-inventory")).toBe("skipped");
    expect(outcomes.get("size")).toBe("skipped");
    // Source is still readable: this step does not cascade into a skip.
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");
    // Runtime smoke skipped with a reason pointing at the failed required step.
    expect(outcomes.get("runtime-smoke")).toBe("skipped");

    // A skip carries no findings, so the cascade invents nothing about an
    // artifact that was never produced.
    const skipped = report.validation.filter(entry => entry.outcome === "skipped");
    expect(skipped.every(entry => entry.diagnostics.length === 0)).toBe(true);
    expect(
      report.rejectionFindings.every(finding => finding.step !== "artifact-scan" && finding.step !== "size"),
    ).toBe(true);

    expect(assessment.status).toBe("supports-rejection-only");
    expect(assessment.failedSteps).toContain("build");
    expect(lockStatus).toBe("failed");
    // Diagnostics must not leak absolute paths even on failure.
    const text = serializeProbeReport(report);
    expect(text).not.toContain(fixture("broken-build"));
  });
});

describe("runDependencyProbe: budget", () => {
  it("files cell-artifact-budget-exceeded while the size step still passes", async () => {
    const { report, assessment } = await probe("pure-esm-utility", "tiny-math", {
      cellArtifactBudgetBytes: 4,
    });

    const size = report.validation.find(entry => entry.step === "size")!;
    expect(size.outcome).toBe("passed");
    const finding = report.rejectionFindings.find(entry => entry.signal === "cell-artifact-budget-exceeded");
    expect(finding?.step).toBe("size");
    expect(assessment.status).toBe("supports-rejection-only");
    expect(assessment.rejectionFindings.map(entry => entry.signal)).toContain("cell-artifact-budget-exceeded");
  });

  it("keeps the budget out of a second run's fingerprint when it is not declared", async () => {
    const withoutBudget = await probe("pure-esm-utility", "tiny-math");
    const withBudget = await probe("pure-esm-utility", "tiny-math", { cellArtifactBudgetBytes: 1_000_000 });

    expect(withoutBudget.fingerprint).not.toBe(withBudget.fingerprint);
    expect(withBudget.fingerprint).toContain("budget");
  });
});

describe("runDependencyProbe: cache", () => {
  // A prior run's `.fgc/probe-cache/` would make the first assertion a lie:
  // these tests own a cold start, so they clear the fixture's scratch space.
  it("serves a byte-identical report from the file cache on the second run", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(first.fromCache).toBe(false);

    const second = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(second.fromCache).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(serializeProbeReport(second.report)).toBe(serializeProbeReport(first.report));
    expect(second.cacheRelativePath).toBe(probeCacheRelativePath(first.fingerprint));
    expect(second.cacheRelativePath.startsWith(".fgc/probe-cache/")).toBe(true);
  });

  it("re-probes when the declared fingerprint inputs change", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });
    await runDependencyProbe({ projectRoot, packageName: "tiny-math", cache: false });

    const changed = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      probeId: "amd-detect",
    });

    expect(changed.fromCache).toBe(false);
    expect(changed.fingerprint).toContain("probe=amd-detect");
  });

  it("treats a corrupt cache file as a miss", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });
    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = join(projectRoot, ...first.cacheRelativePath.split("/"));
    await mkdir(join(projectRoot, ".fgc", "probe-cache"), { recursive: true });
    await writeFile(path, "not json", "utf8");

    const second = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(second.fromCache).toBe(false);
    expect(serializeProbeReport(second.report)).toBe(serializeProbeReport(first.report));
  });
});

describe("runDependencyProbe: runtime smoke", () => {
  it("runs a supplied hook, re-stamps its findings, and passes the step", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: () => ({
        facts: [{ name: "smoke.mounted", value: true }],
        risks: [{ signal: "global-singleton-assumption", summary: "React identity assumed.", evidence: ["page"] }],
      }),
    });

    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.outcome).toBe("passed");
    expect(smoke.detail).toContain("fact(s)");
    expect(report.facts.some(fact => fact.step === "runtime-smoke" && fact.name === "smoke.mounted")).toBe(true);
    expect(
      report.risks.some(risk => risk.step === "runtime-smoke" && risk.signal === "global-singleton-assumption"),
    ).toBe(true);
    expect(validateProbeReport(report)).toEqual([]);
  });

  it("fails the step with the thrown message as diagnostics", async () => {
    const { report, assessment } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: () => {
        throw new Error("browser unavailable\nsecond line");
      },
    });

    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.outcome).toBe("failed");
    expect(smoke.diagnostics).toEqual(["browser unavailable", "second line"]);
    // runtime-smoke is not deployment-required; a thrown smoke does not by
    // itself block supports-deployment when every static step passed.
    expect(assessment.failedSteps).toContain("runtime-smoke");
    expect(validateProbeReport(report)).toEqual([]);
  });

  it("awaits an async hook", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: async () => ({ facts: [{ name: "smoke.async", value: true }] }),
    });

    expect(report.facts.some(fact => fact.name === "smoke.async")).toBe(true);
    expect(report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");
  });
});

describe("runDependencyProbe: identity failures throw", () => {
  it("throws ProbeIdentityError for a package that is not installed", async () => {
    await expect(probe("pure-esm-utility", "definitely-not-installed")).rejects.toBeInstanceOf(ProbeIdentityError);
    await expect(probe("pure-esm-utility", "definitely-not-installed")).rejects.toMatchObject({
      reason: "not-installed",
      packageName: "definitely-not-installed",
    });
  });
});

describe("architecture conflict is ownership, not a probe finding (#4 vs #16)", () => {
  it("probes react-router-dom cleanly while assessDependencyRole rejects the role", async () => {
    const { report, assessment } = await probe("architecture-conflict", "react-router-dom");

    // The probe reports only artifact observations: no rejection findings, steps pass.
    expect(validateProbeReport(report)).toEqual([]);
    expect(rejectionSignals(report)).toEqual([]);
    expect(assessment.status).toBe("supports-deployment");
    expect(assessment.rejectionFindings).toEqual([]);

    // Ownership is a separate gate. A clean probe must not excuse it.
    const ownership = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
    expect(ownership.status).toBe("platform-conflict");
    expect(ownership).toMatchObject({
      status: "platform-conflict",
      packageName: "react-router-dom",
      role: "application-navigation",
    });
    if (ownership.status === "platform-conflict") {
      expect(ownership.rejection.kind).toBe("architectural");
    }
  });
});

describe("lock integration (#8)", () => {
  it("produces lock evidence with versionIndependent false for a passed run", async () => {
    const result = await probe("pure-esm-utility", "tiny-math");
    const evidence = probeRunLockEvidence(result);

    expect(evidence).toEqual({
      status: "passed",
      fingerprint: result.fingerprint,
      versionIndependent: false,
    });
    expect(evidence?.fingerprint).toBe(
      composeProbeFingerprint({ probeId: "inline-bundle", entry: "tiny-math" }).fingerprint,
    );
  });

  it("returns null lock evidence when the assessment is inconclusive", () => {
    expect(
      probeRunLockEvidence({ fingerprint: "probe=x;entry=y", lockStatus: null }),
    ).toBeNull();
  });

  it("maps assessments to #8 statuses through lockProbeStatusForAssessment", async () => {
    const passed = await probe("pure-esm-utility", "tiny-math");
    const rejected = await probe("node-only", "config-from-disk");

    expect(lockProbeStatusForAssessment(assessProbeReport(passed.report))).toBe("passed");
    expect(lockProbeStatusForAssessment(assessProbeReport(rejected.report))).toBe("failed");
    expect(lockProbeStatusForAssessment(assessProbeReport({
      ...passed.report,
      validation: passed.report.validation.map(entry =>
        entry.step === "runtime-pattern-scan" ? { ...entry, outcome: "skipped" as const } : entry,
      ),
      rejectionFindings: [],
      risks: [],
    }))).toBeNull();
  });

  it("builds a LockEnvironment whose probeFingerprints drive freshness", async () => {
    const result = await probe("pure-esm-utility", "tiny-math");
    const environment = await probeLockEnvironment(fixture("pure-esm-utility"), {
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
      probeFingerprints: { "tiny-math": result.fingerprint },
    });

    expect(environment.probeFingerprints["tiny-math"]).toBe(result.fingerprint);
    expect(environment.resolvedVersions["tiny-math"]).toBe("1.0.0");
    expect(environment.target).toEqual(RUNTIME_CONTRACT_TARGET);

    const { findLockDecision } = await import("@forguncy-react-workspace/core");
    const record = findLockDecision(
      {
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
      { packageName: "tiny-math" },
    );
    expect(record).not.toBeNull();
    expect(assessLockDecision(record!, environment).freshness).toBe("fresh");
    expect(assessLockDecision(record!, environment).stalenessReasons).toEqual([]);

    const moved = await probeLockEnvironment(fixture("pure-esm-utility"), {
      probeFingerprints: { "tiny-math": "probe=inline-bundle;entry=other" },
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
    });
    const changed = assessLockDecision(record!, moved);
    expect(changed.freshness).toBe("stale");
    expect(changed.stalenessReasons).toContain("probe-fingerprint-changed");

    const unknown = await probeLockEnvironment(fixture("pure-esm-utility"), {
      probeFingerprints: {},
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
    });
    const missing = assessLockDecision(record!, unknown);
    expect(missing.stalenessReasons).toContain("probe-fingerprint-unknown");
  });
});
