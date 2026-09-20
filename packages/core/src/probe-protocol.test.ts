import { describe, expect, it } from "vitest";

import {
  assessProbeReport,
  assertProbeReport,
  assertSupportedProbeReportSchemaVersion,
  canonicalizeProbeReport,
  executedProbeSteps,
  findForbiddenProbeKeys,
  findProbeStep,
  FORBIDDEN_PROBE_REPORT_KEYS,
  hasPassingEvidence,
  inspectProbeReport,
  isProbeStepId,
  isSupportedProbeReportSchemaVersion,
  parseProbeReport,
  PROBE_ASSESSMENT_STATUSES,
  PROBE_DEPLOYMENT_REQUIRED_STEPS,
  PROBE_ENGINE_NON_RESPONSIBILITIES,
  PROBE_EVIDENCE_POLICY,
  PROBE_OUTCOMES,
  PROBE_REPORT_MACHINE_READABILITY,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_REPORT_SECTIONS,
  PROBE_STEPS,
  PROBE_STEP_IDS,
  ProbeReportSchemaVersionError,
  ProbeReportValidationError,
  probeStep,
  probeStepOrder,
  probeSupportsDeployment,
  serializeProbeReport,
  validateProbeReport,
} from "./probe-protocol";
import type { ProbeEnvironment, ProbeOutcome, ProbeReport, ProbeRisk, ProbeValidationEntry } from "./probe-protocol";

const ENVIRONMENT: ProbeEnvironment = {
  packageName: "es-toolkit",
  packageVersion: "1.39.0",
  license: "MIT",
  source: "https://github.com/toss/es-toolkit",
  toolchain: { vitePlus: "0.3.2" },
  target: null,
};

function allSteps(outcome: ProbeOutcome): readonly ProbeValidationEntry[] {
  return PROBE_STEP_IDS.map(step => ({ step, outcome, detail: `recorded "${step}"`, diagnostics: [] }));
}

function probeReport(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
    environment: ENVIRONMENT,
    facts: [{ step: "package-identity", name: "resolvedVersion", value: "1.39.0" }],
    risks: [],
    validation: allSteps("passed"),
    ...overrides,
  };
}

const WORKER_RISK: ProbeRisk = {
  signal: "worker",
  step: "runtime-pattern-scan",
  summary: "The bundle starts a Worker.",
  evidence: ["assets/pdf.worker.js"],
};

describe("probe steps", () => {
  it("lists the deterministic steps in a fixed order", () => {
    expect(PROBE_STEP_IDS).toEqual([
      "package-identity",
      "export-metadata",
      "node-builtin-scan",
      "build",
      "artifact-scan",
      "asset-inventory",
      "runtime-pattern-scan",
      "size",
      "runtime-smoke",
    ]);
    expect(PROBE_STEPS).toHaveLength(PROBE_STEP_IDS.length);
    PROBE_STEP_IDS.forEach((id, index) => {
      expect(probeStepOrder(id)).toBe(index);
      expect(findProbeStep(id)?.id).toBe(id);
    });
  });

  it("rejects an unknown step id", () => {
    expect(isProbeStepId("build")).toBe(true);
    expect(isProbeStepId("vibes")).toBe(false);
    expect(findProbeStep("vibes")).toBeUndefined();
    expect(() => probeStep("vibes" as never)).toThrow(/Unknown probe step/);
  });
});

describe("probe engine boundaries", () => {
  it("keeps ownership, replacement and strategy out of the engine", () => {
    expect(PROBE_ENGINE_NON_RESPONSIBILITIES.map(entry => entry.id)).toEqual([
      "classify-capability-ownership",
      "choose-replacement-package",
      "choose-deployment-strategy",
    ]);
    for (const entry of PROBE_ENGINE_NON_RESPONSIBILITIES) {
      // Nothing here may be answered by the engine itself.
      expect(["agent", "ownership-decision"]).toContain(entry.answeredBy);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(PROBE_ENGINE_NON_RESPONSIBILITIES[0]?.answeredBy).toBe("ownership-decision");
    expect(PROBE_ENGINE_NON_RESPONSIBILITIES[1]?.answeredBy).toBe("agent");
  });

  it("states that a probe is the only basis for a compatibility claim", () => {
    expect(PROBE_EVIDENCE_POLICY.requiresExecutedProbe).toBe(true);
    expect(PROBE_EVIDENCE_POLICY.acceptsDocumentationOnlyEvidence).toBe(false);
    expect(PROBE_EVIDENCE_POLICY.riskFindingsAreRejections).toBe(false);
  });

  it("names the four separable report sections and the readability contract", () => {
    expect([...PROBE_REPORT_SECTIONS]).toEqual(["environment", "facts", "risks", "validation"]);
    expect(PROBE_REPORT_MACHINE_READABILITY.length).toBeGreaterThanOrEqual(5);
  });

  it("detects a decision smuggled into the report, wherever it sits", () => {
    expect(findForbiddenProbeKeys(probeReport())).toEqual([]);
    expect(findForbiddenProbeKeys({ ...probeReport(), strategy: "inline" })).toEqual(["strategy"]);
    expect(findForbiddenProbeKeys({ risks: [{ signal: "worker", recommendation: "inline" }] })).toEqual([
      "risks[0].recommendation",
    ]);
    expect(FORBIDDEN_PROBE_REPORT_KEYS).toContain("replacementPackage");
  });
});

describe("probe report validation", () => {
  it("accepts a report whose steps all ran", () => {
    const report = probeReport();
    expect(inspectProbeReport(report)).toEqual([]);
    expect(validateProbeReport(report)).toEqual([]);
    expect(hasPassingEvidence(report)).toBe(true);
    expect(executedProbeSteps(report)).toEqual([...PROBE_STEP_IDS]);
  });

  it("requires every step to be accounted for", () => {
    const report = probeReport({ validation: allSteps("passed").filter(entry => entry.step !== "runtime-smoke") });
    const problems = validateProbeReport(report);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"runtime-smoke"/);
    expect(problems[0]).toMatch(/Record it as "skipped" with a reason/);
  });

  it("refuses a step recorded twice", () => {
    const report = probeReport({ validation: [...allSteps("passed"), { step: "build", outcome: "passed", detail: "again", diagnostics: [] }] });
    const problems = validateProbeReport(report);
    expect(problems.some(problem => problem.includes("2 times"))).toBe(true);
  });

  it("refuses a failure with no actionable evidence", () => {
    const validation = allSteps("passed").map(entry =>
      entry.step === "build" ? { ...entry, outcome: "failed" as const, detail: "build failed" } : entry,
    );
    const problems = validateProbeReport(probeReport({ validation }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/failed without diagnostics/);
    expect(problems[0]).toMatch(/cannot be acted on/);
  });

  it("accepts a failure that carries diagnostics", () => {
    const validation = allSteps("passed").map(entry =>
      entry.step === "build"
        ? {
            ...entry,
            outcome: "failed" as const,
            detail: "rolldown could not resolve a Node builtin",
            diagnostics: ["Could not resolve \"node:fs\"", "imported by node-fetch/lib/index.mjs"],
          }
        : entry,
    );
    expect(validateProbeReport(probeReport({ validation }))).toEqual([]);
  });

  it("refuses diagnostics on a step that did not fail", () => {
    const validation = allSteps("passed").map(entry =>
      entry.step === "size" ? { ...entry, diagnostics: ["leftover note"] } : entry,
    );
    const problems = validateProbeReport(probeReport({ validation }));
    expect(problems.some(problem => problem.includes("carries diagnostics"))).toBe(true);
  });

  it("requires a reason for a skipped step", () => {
    const validation = allSteps("passed").map(entry =>
      entry.step === "runtime-smoke" ? { ...entry, outcome: "skipped" as const, detail: "" } : entry,
    );
    const problems = validateProbeReport(probeReport({ validation }));
    expect(problems.some(problem => problem.includes("skipped without a reason"))).toBe(true);

    const withReason = validation.map(entry =>
      entry.step === "runtime-smoke" ? { ...entry, detail: "no browser available in this run" } : entry,
    );
    expect(validateProbeReport(probeReport({ validation: withReason }))).toEqual([]);
  });

  it("refuses a report with no observations", () => {
    const problems = validateProbeReport(probeReport({ facts: [] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/records no facts/);
  });

  it("refuses a machine-specific source path", () => {
    const problems = validateProbeReport(
      probeReport({ environment: { ...ENVIRONMENT, source: "C:\\Users\\mang\\packages\\thing" } }),
    );
    expect(problems.some(problem => problem.includes("machine-specific path"))).toBe(true);
    expect(validateProbeReport(probeReport({ environment: { ...ENVIRONMENT, source: null } }))).toEqual([]);
  });
});

describe("probe risk findings", () => {
  it("accepts a risk-family finding that has evidence and a step that ran", () => {
    expect(validateProbeReport(probeReport({ risks: [WORKER_RISK] }))).toEqual([]);
  });

  it("refuses a finding attributed to a step that was skipped", () => {
    const validation = allSteps("passed").map(entry =>
      entry.step === "runtime-pattern-scan" ? { ...entry, outcome: "skipped" as const, detail: "not run" } : entry,
    );
    const problems = validateProbeReport(probeReport({ risks: [WORKER_RISK], validation }));

    expect(problems.some(problem => problem.includes("which the report records as skipped"))).toBe(true);
  });

  it("refuses a finding with no evidence", () => {
    const problems = validateProbeReport(probeReport({ risks: [{ ...WORKER_RISK, evidence: [] }] }));
    expect(problems.some(problem => problem.includes("records no evidence"))).toBe(true);
  });

  it("refuses a non-risk signal filed as a risk", () => {
    // The mis-filing that matters: a rejection arriving through the warning list.
    const problems = validateProbeReport(
      probeReport({
        risks: [{ signal: "cell-artifact-budget-exceeded", step: "size", summary: "too big", evidence: ["3.1 MB"] }],
      }),
    );
    expect(problems.some(problem => problem.includes('is a "replacement" signal'))).toBe(true);
  });

  it("refuses an unknown signal", () => {
    const problems = validateProbeReport(
      probeReport({ risks: [{ signal: "sneaky" as never, step: "size", summary: "?", evidence: ["?"] }] }),
    );
    expect(problems.some(problem => problem.includes("not in the selection catalogue"))).toBe(true);
  });
});

describe("canonical probe report", () => {
  it("serializes identically regardless of discovery order", () => {
    const shuffled = probeReport({
      facts: [
        { step: "size", name: "bytes", value: 4096 },
        { step: "package-identity", name: "resolvedVersion", value: "1.39.0" },
      ],
      validation: [...allSteps("passed")].reverse(),
    });

    expect(serializeProbeReport(shuffled)).toBe(serializeProbeReport(canonicalizeProbeReport(shuffled)));
    expect(serializeProbeReport(shuffled).endsWith("}\n")).toBe(true);
    expect(serializeProbeReport(shuffled).indexOf('"package-identity"')).toBeLessThan(
      serializeProbeReport(shuffled).indexOf('"size"'),
    );
  });

  it("round-trips through parse without changing bytes", () => {
    const report = probeReport({ risks: [WORKER_RISK] });
    const text = serializeProbeReport(report);
    expect(serializeProbeReport(parseProbeReport(text))).toBe(text);
  });

  it("fails explicitly on an unsupported schema version", () => {
    expect(isSupportedProbeReportSchemaVersion(PROBE_REPORT_SCHEMA_VERSION)).toBe(true);
    expect(isSupportedProbeReportSchemaVersion(2)).toBe(false);

    const text = serializeProbeReport(probeReport()).replace(`"schemaVersion": ${PROBE_REPORT_SCHEMA_VERSION}`, '"schemaVersion": 99');
    expect(() => parseProbeReport(text)).toThrow(ProbeReportSchemaVersionError);
    expect(() => assertSupportedProbeReportSchemaVersion(99)).toThrow(/unsupported schema version 99/);
  });

  it("reports malformed JSON as a validation problem, not a syntax error", () => {
    expect(() => parseProbeReport("{")).toThrow(ProbeReportValidationError);
  });

  it("throws a validation error listing the problems", () => {
    let caught: unknown;
    try {
      assertProbeReport(probeReport({ facts: [] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProbeReportValidationError);
    expect((caught as ProbeReportValidationError).problems).toHaveLength(1);
  });

  it("keeps the outcome vocabulary closed", () => {
    expect([...PROBE_OUTCOMES]).toEqual(["passed", "failed", "skipped"]);
  });
});

describe("probe risk typing", () => {
  it("requires a signal from the selection catalogue", () => {
    // @ts-expect-error a risk must cite a catalogue signal, not arbitrary text
    const arbitrary: ProbeRisk = { signal: "made-up", step: "size", summary: "?", evidence: ["?"] };
    expect(arbitrary.signal).toBe("made-up");
  });
});

describe("deployment support", () => {
  it("requires every deployment-required step to have passed", () => {
    expect(PROBE_DEPLOYMENT_REQUIRED_STEPS).toHaveLength(8);
    // #16 asks for a runtime/browser result "where needed", so a static path cannot
    // be required to have run one.
    expect(PROBE_DEPLOYMENT_REQUIRED_STEPS).not.toContain("runtime-smoke");
    expect(probeSupportsDeployment(probeReport())).toBe(true);
    expect(assessProbeReport(probeReport()).status).toBe("supports-deployment");
  });

  it("does not call a candidate working because one step passed", () => {
    // The scenario a "hasPassingEvidence" gate accepts: identity resolved, build
    // failed, everything else skipped.
    const validation: readonly ProbeValidationEntry[] = PROBE_STEP_IDS.map(step => {
      if (step === "package-identity") {
        return { step, outcome: "passed" as const, detail: "resolved", diagnostics: [] };
      }
      if (step === "build") {
        return {
          step,
          outcome: "failed" as const,
          detail: "the bundle could not be produced",
          diagnostics: ['Could not resolve "node:fs"'],
        };
      }
      return { step, outcome: "skipped" as const, detail: "no artifact to inspect", diagnostics: [] };
    });
    const report = probeReport({ validation });

    expect(hasPassingEvidence(report)).toBe(true);
    expect(probeSupportsDeployment(report)).toBe(false);

    const assessment = assessProbeReport(report);
    expect(assessment.status).toBe("supports-rejection-only");
    expect(assessment.failedSteps).toEqual(["build"]);
    expect(assessment.blockingSteps).toContain("build");
    expect(assessment.blockingSteps).toContain("artifact-scan");
    expect(assessment.reason).toMatch(/cannot support a strategy that claims the candidate works/);
  });

  it("separates 'could not find out' from 'it does not work'", () => {
    const validation = PROBE_STEP_IDS.map(step =>
      step === "artifact-scan" || step === "size"
        ? { step, outcome: "skipped" as const, detail: "not run in this environment", diagnostics: [] }
        : { step, outcome: "passed" as const, detail: "ran", diagnostics: [] },
    );
    const assessment = assessProbeReport(probeReport({ validation }));

    expect(assessment.status).toBe("inconclusive");
    expect(assessment.failedSteps).toEqual([]);
    expect(assessment.blockingSteps).toEqual(["artifact-scan", "size"]);
    expect(assessment.reason).toMatch(/neither shows the candidate working nor shows why it cannot/);
  });

  it("weighs risks without letting them block deployment", () => {
    const assessment = assessProbeReport(probeReport({ risks: [WORKER_RISK] }));

    expect(assessment.status).toBe("supports-deployment");
    expect(assessment.risksToWeigh.map(risk => risk.signal)).toEqual(["worker"]);
    expect(assessment.reason).toMatch(/risk finding/);
  });

  it("keeps the assessment vocabulary closed", () => {
    expect([...PROBE_ASSESSMENT_STATUSES]).toEqual([
      "supports-deployment",
      "supports-rejection-only",
      "inconclusive",
    ]);
  });
});

describe("canonical ordering is total", () => {
  it("orders findings that share a key by their content", () => {
    // Same step and name with different values: a stable sort keeps discovery order
    // here, which is the one thing canonicalization has to remove.
    const factA = { step: "asset-inventory" as const, name: "asset", value: "a.css" };
    const factB = { step: "asset-inventory" as const, name: "asset", value: "b.css" };

    expect(serializeProbeReport(probeReport({ facts: [factA, factB] }))).toBe(
      serializeProbeReport(probeReport({ facts: [factB, factA] })),
    );
    expect(canonicalizeProbeReport(probeReport({ facts: [factB, factA] })).facts.map(fact => fact.value)).toEqual([
      "a.css",
      "b.css",
    ]);
  });

  it("orders risks that share a signal by their content", () => {
    const first: ProbeRisk = { signal: "wasm", step: "artifact-scan", summary: "a", evidence: ["a.wasm"] };
    const second: ProbeRisk = { signal: "wasm", step: "artifact-scan", summary: "b", evidence: ["b.wasm"] };

    expect(serializeProbeReport(probeReport({ risks: [first, second] }))).toBe(
      serializeProbeReport(probeReport({ risks: [second, first] })),
    );
  });

  it("sorts set-like arrays so discovery order cannot leak into the bytes", () => {
    const report = probeReport({
      facts: [{ step: "artifact-scan", name: "unresolvedImports", value: ["b.mjs", "a.mjs"] }],
      risks: [{ ...WORKER_RISK, evidence: ["z.js", "a.js"] }],
    });

    const serialized = serializeProbeReport(report);
    expect(serialized.indexOf('"a.mjs"')).toBeLessThan(serialized.indexOf('"b.mjs"'));
    expect(serialized.indexOf('"a.js"')).toBeLessThan(serialized.indexOf('"z.js"'));
    expect(serializeProbeReport(parseProbeReport(serialized))).toBe(serialized);
  });

  it("reaches the same bytes from a shuffled input", () => {
    const report = probeReport({
      facts: [
        { step: "size", name: "bytes", value: 4096 },
        { step: "artifact-scan", name: "unresolvedImports", value: ["b.mjs", "a.mjs"] },
        { step: "package-identity", name: "resolvedVersion", value: "1.39.0" },
      ],
      risks: [WORKER_RISK, { ...WORKER_RISK, evidence: ["other.worker.js"] }],
      validation: [...allSteps("passed")].reverse(),
    });
    const shuffledAgain = probeReport({
      facts: [...report.facts].reverse(),
      risks: [...report.risks].reverse(),
      validation: [...report.validation].reverse(),
    });

    expect(serializeProbeReport(report)).toBe(serializeProbeReport(shuffledAgain));
  });
});
