import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  citesEveryArchitectureDecision,
  DEPENDENCY_LOCK_DECISION,
  DEPENDENCY_SELECTION_DECISION,
} from "./governance";
import { assessDependencyRole, isPlatformConflict } from "./platform-conflicts";
import type { ProbeEnvironment, ProbeReport } from "./probe-protocol";
import { PROBE_REPORT_SCHEMA_VERSION, PROBE_STEP_IDS } from "./probe-protocol";
import {
  auditSelectionDecision,
  evaluateRepairRecipe,
  findSelectionStage,
  isOwnershipGateFirst,
  isSelectionDecisionRecordable,
  isSelectionStageId,
  NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT,
  OWNERSHIP_GATE_STAGE_ID,
  REPAIR_RECIPE_CONDITIONS,
  SELECTION_ACCEPTANCE_CRITERIA,
  SELECTION_AUTHORITIES,
  SELECTION_GOVERNING_DECISIONS,
  SELECTION_GOVERNING_SPEC_REFERENCE_LINE,
  SELECTION_STAGES,
  SELECTION_STAGE_IDS,
  selectionJustificationRequired,
  selectionStage,
  selectionStageOrder,
  SPEC_PROVING_CASES,
  stagesBefore,
  stagesWithAuthority,
} from "./selection-policy";
import { selectionSignalFamilyOf } from "./selection-signals";
import type { DependencyDecision } from "./strategy";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRepositoryFile(...segments: readonly string[]): string {
  return readFileSync(join(repositoryRoot, ...segments), "utf8");
}

const ENVIRONMENT: ProbeEnvironment = {
  packageName: "es-toolkit",
  packageVersion: "1.39.0",
  license: "MIT",
  source: "https://github.com/toss/es-toolkit",
  toolchain: { vitePlus: "0.3.2" },
  target: null,
};

function probeFor(packageName: string): ProbeReport {
  return {
    schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
    environment: { ...ENVIRONMENT, packageName },
    facts: [{ step: "package-identity", name: "resolvedVersion", value: ENVIRONMENT.packageVersion }],
    risks: [],
    validation: PROBE_STEP_IDS.map(step => ({
      step,
      outcome: "passed" as const,
      detail: `ran "${step}"`,
      diagnostics: [],
    })),
  };
}

const INLINE: DependencyDecision = { strategy: "inline", packageName: "es-toolkit" };

const REPLACE: DependencyDecision = {
  strategy: "replace",
  packageName: "es-toolkit",
  rejection: {
    kind: "technical",
    code: "cell-code-budget-exceeded",
    summary: "The inlined artifact exceeds the measured cell budget.",
    remediation: "Use a lighter alternative.",
  },
  alternatives: ["lighter-toolkit"],
};

describe("selection stage order", () => {
  it("runs the ownership gate before anything else", () => {
    expect(SELECTION_STAGE_IDS).toEqual([
      "classify-ownership",
      "research-candidates",
      "rank-candidates",
      "probe-candidate",
      "decide-strategy",
      "resolve-replacement",
      "persist-decision",
    ]);
    expect(OWNERSHIP_GATE_STAGE_ID).toBe("classify-ownership");
    expect(isOwnershipGateFirst()).toBe(true);
  });

  it("detects a flow that classifies the package before the capability", () => {
    // Reversing the gate is the failure mode #16 rule 1 exists to prevent, so it
    // has to be detectable rather than merely discouraged in a comment.
    const reordered = [...SELECTION_STAGES].reverse();
    expect(isOwnershipGateFirst(reordered)).toBe(false);
    expect(isOwnershipGateFirst([])).toBe(false);
  });

  it("keeps every semantic step before the deterministic one it feeds", () => {
    const beforeProbe = stagesBefore("probe-candidate").map(stage => stage.id);
    expect(beforeProbe).toEqual(["classify-ownership", "research-candidates", "rank-candidates"]);
    expect(selectionStageOrder("persist-decision")).toBe(SELECTION_STAGE_IDS.length - 1);
  });

  it("keeps deterministic work on the scripts side of #16's boundary", () => {
    // #16 puts "package inspection, builds, artifact scan, size calculation,
    // deterministic browser checks, lock updates" on the scripts side. Probing *and*
    // persisting are therefore scripts work; judgement stays with the Agent.
    expect(stagesWithAuthority("scripts").map(stage => stage.id)).toEqual(["probe-candidate", "persist-decision"]);
    expect(stagesWithAuthority("agent").map(stage => stage.id)).toEqual([
      "classify-ownership",
      "research-candidates",
      "rank-candidates",
      "decide-strategy",
      "resolve-replacement",
    ]);
    expect([...SELECTION_AUTHORITIES]).toEqual(["agent", "scripts"]);
  });

  it("makes the lock-write stage refuse an unrecordable decision", () => {
    const stage = selectionStage("persist-decision");
    expect(stage.authority).toBe("scripts");
    expect(stage.mustNot.join(" ")).toMatch(/Do not decide the strategy/);
    expect(stage.mustNot.join(" ")).toMatch(/refuse it and report why/);
  });

  it("resolves a stage and rejects an unknown one", () => {
    expect(isSelectionStageId("probe-candidate")).toBe(true);
    expect(isSelectionStageId("probe-everything")).toBe(false);
    expect(findSelectionStage("probe-candidate")?.authority).toBe("scripts");
    expect(findSelectionStage("probe-everything")).toBeUndefined();
    expect(() => selectionStage("probe-everything" as never)).toThrow(/Unknown dependency-selection stage/);
  });

  it("tells each stage what it must not become", () => {
    for (const stage of SELECTION_STAGES) {
      expect(stage.mustNot.length, stage.id).toBeGreaterThan(0);
      expect(stage.produces.length, stage.id).toBeGreaterThan(0);
    }
    expect(selectionStage("resolve-replacement").mustNot.join(" ")).toMatch(/global package compatibility or adapter registry/);
    expect(selectionStage("probe-candidate").mustNot.join(" ")).toMatch(/choose a deployment strategy/);
  });
});

describe("selection provenance", () => {
  it("cites the architecture Specs and both dependency Specs", () => {
    expect(SELECTION_GOVERNING_DECISIONS.map(decision => decision.issue)).toEqual([4, 5, 8, 16]);
    expect(SELECTION_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #8, #16");
    expect(citesDecision(SELECTION_GOVERNING_SPEC_REFERENCE_LINE, DEPENDENCY_SELECTION_DECISION)).toBe(true);
    expect(citesDecision(SELECTION_GOVERNING_SPEC_REFERENCE_LINE, DEPENDENCY_LOCK_DECISION)).toBe(true);
  });

  it("is declared by its own module header", () => {
    // AGENTS.md requires a Spec that decides ownership or dependency strategy to
    // name the architecture Spec Issue that governs it. Asserting it here keeps
    // the back-reference from rotting when the file is edited.
    const source = readRepositoryFile("packages", "core", "src", "selection-policy.ts");
    expect(citesEveryArchitectureDecision(source)).toBe(true);
    expect(citesDecision(source, DEPENDENCY_LOCK_DECISION)).toBe(true);
    expect(citesDecision(source, DEPENDENCY_SELECTION_DECISION)).toBe(true);
  });
});

describe("replacement over adaptation", () => {
  it("states the absence of an adapter registry as an invariant", () => {
    expect(NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT).toMatch(/No package-specific global adapter registry/);
  });

  it("allows a repair recipe only when all three conditions hold", () => {
    const allowed = evaluateRepairRecipe({
      capabilityStillValuable: true,
      alternativesMateriallyWorse: true,
      repairCanBeValidated: true,
    });
    expect(allowed.status).toBe("allowed");
    expect(allowed.unmetConditions).toEqual([]);
    expect(REPAIR_RECIPE_CONDITIONS).toHaveLength(3);
  });

  it("refuses a repair for each missing condition, naming it", () => {
    // Each condition on its own is routinely true, which is why the conjunction is
    // the policy rather than any single clause.
    const cases = [
      { input: { capabilityStillValuable: false, alternativesMateriallyWorse: true, repairCanBeValidated: true }, unmet: "capability-still-valuable" },
      { input: { capabilityStillValuable: true, alternativesMateriallyWorse: false, repairCanBeValidated: true }, unmet: "alternatives-materially-worse" },
      { input: { capabilityStillValuable: true, alternativesMateriallyWorse: true, repairCanBeValidated: false }, unmet: "repair-can-be-validated" },
    ] as const;

    for (const { input, unmet } of cases) {
      const assessment = evaluateRepairRecipe(input);
      expect(assessment.status, unmet).toBe("refused");
      expect(assessment.unmetConditions, unmet).toEqual([unmet]);
      expect(assessment.reason, unmet).toMatch(/Prefer `replace` with an evaluated alternative/);
    }
  });
});

describe("proving the Spec", () => {
  it("fixes both required end-to-end cases", () => {
    expect(SPEC_PROVING_CASES.map(provingCase => provingCase.id)).toEqual([
      "simple-esm-package",
      "worker-or-wasm-risk-package",
    ]);
  });

  it("exercises positive signals in the plain case and risk signals in the risky one", () => {
    const [plain, risky] = SPEC_PROVING_CASES;
    for (const signal of plain!.signalsExercised) {
      expect(selectionSignalFamilyOf(signal), signal).toBe("positive");
    }
    for (const signal of risky!.signalsExercised) {
      expect(selectionSignalFamilyOf(signal), signal).toBe("risk");
    }
    expect(risky!.signalsExercised).toContain("wasm");
  });
});

describe("acceptance criteria", () => {
  it("names an enforcement point for each criterion", () => {
    expect(SELECTION_ACCEPTANCE_CRITERIA).toHaveLength(5);
    expect(SELECTION_ACCEPTANCE_CRITERIA.map(criterion => criterion.id)).toEqual([
      "no-adapter-registry",
      "machine-readable-probe-output",
      "replacement-preferred",
      "lock-integration",
      "end-to-end-proof",
    ]);
    for (const criterion of SELECTION_ACCEPTANCE_CRITERIA) {
      expect(criterion.enforcedBy.length, criterion.id).toBeGreaterThan(0);
    }
  });
});

describe("selection decision audit", () => {
  it("accepts a decision backed by a passing probe", () => {
    expect(
      auditSelectionDecision({
        decision: INLINE,
        probe: probeFor("es-toolkit"),
        signals: ["browser-first-esm-distribution"],
      }),
    ).toEqual([]);
    expect(
      isSelectionDecisionRecordable({ decision: INLINE, probe: probeFor("es-toolkit") }),
    ).toBe(true);
  });

  it("refuses a decision taken without a probe", () => {
    const problems = auditSelectionDecision({ decision: INLINE, probe: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/decided without a probe report/);
    expect(problems[0]).toMatch(/never inspection of the package's documentation alone/);
  });

  it("refuses a probe about a different package", () => {
    const problems = auditSelectionDecision({ decision: INLINE, probe: probeFor("some-other-package") });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/probe report is about "some-other-package"/);
  });

  it("refuses a strategy the probe does not support", () => {
    const failing: ProbeReport = {
      ...probeFor("es-toolkit"),
      validation: PROBE_STEP_IDS.map(step => ({
        step,
        outcome: "failed" as const,
        detail: `failed "${step}"`,
        diagnostics: ["boom"],
      })),
    };
    const problems = auditSelectionDecision({ decision: INLINE, probe: failing });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not support recording "inline"/);
    expect(problems[0]).toMatch(/claims the candidate works/);
  });

  it("does not accept a strategy because one unrelated step passed", () => {
    // `package-identity` passing while `build` fails used to be enough, because the
    // gate was `hasPassingEvidence`. That report describes a candidate that does not
    // work, so it must not be recordable as `inline`.
    const report: ProbeReport = {
      ...probeFor("es-toolkit"),
      validation: PROBE_STEP_IDS.map(step => {
        if (step === "package-identity") {
          return { step, outcome: "passed" as const, detail: "resolved", diagnostics: [] };
        }
        if (step === "build") {
          return { step, outcome: "failed" as const, detail: "build failed", diagnostics: ["unresolved node:fs"] };
        }
        return { step, outcome: "skipped" as const, detail: "no artifact to inspect", diagnostics: [] };
      }),
    };

    const problems = auditSelectionDecision({ decision: INLINE, probe: report });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not support recording "inline"/);
  });

  it("lets a build failure support replace but never a positive strategy", () => {
    const report: ProbeReport = {
      ...probeFor("es-toolkit"),
      validation: PROBE_STEP_IDS.map(step =>
        step === "build"
          ? { step, outcome: "failed" as const, detail: "build failed", diagnostics: ["unresolved node:fs"] }
          : { step, outcome: "passed" as const, detail: "ran", diagnostics: [] },
      ),
    };

    expect(auditSelectionDecision({ decision: INLINE, probe: report })).toHaveLength(1);
    expect(auditSelectionDecision({ decision: REPLACE, probe: report })).toEqual([]);
  });

  it("refuses to replace a candidate that passed unless a signal disqualifies it", () => {
    const passing = probeFor("es-toolkit");
    const problems = auditSelectionDecision({
      decision: REPLACE,
      probe: passing,
      signals: ["browser-first-esm-distribution"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/has to name the replacement signal/);

    expect(
      auditSelectionDecision({ decision: REPLACE, probe: passing, signals: ["cell-artifact-budget-exceeded"] }),
    ).toEqual([]);
  });

  it("refuses a report that fails its own contract", () => {
    const invalid: ProbeReport = { ...probeFor("es-toolkit"), facts: [] };
    const problems = auditSelectionDecision({ decision: INLINE, probe: invalid });

    expect(problems.some(problem => problem.includes("fails its own contract"))).toBe(true);
    expect(problems.some(problem => problem.includes("records no facts"))).toBe(true);
  });

  it("consumes the #4 ownership decision rather than a signal", () => {
    const ownership = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });

    const asInline = auditSelectionDecision({ decision: INLINE, probe: probeFor("es-toolkit"), ownership });
    expect(asInline.some(problem => problem.includes("assessed as Forguncy-owned"))).toBe(true);

    // Recording an ownership conflict as a bundling failure is the reporting bug #4
    // exists to prevent, so it is refused even in a `replace` decision.
    const misreported = auditSelectionDecision({ decision: REPLACE, probe: probeFor("es-toolkit"), ownership });
    expect(misreported.some(problem => problem.includes("but the recorded rejection is technical"))).toBe(true);
  });

  it("accepts an ownership conflict recorded with the assessment's own rejection", () => {
    const ownership = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
    if (!isPlatformConflict(ownership)) {
      throw new Error("fixture is expected to be a platform conflict");
    }

    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "es-toolkit",
      rejection: ownership.rejection,
    };
    expect(auditSelectionDecision({ decision, probe: probeFor("es-toolkit"), ownership })).toEqual([]);
  });

  it("rejects an architectural rejection that does not match the assessment", () => {
    const ownership = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "es-toolkit",
      rejection: {
        kind: "architectural",
        code: "auth-framework-conflict",
        summary: "hand-written rejection",
        remediation: "hand-written",
      },
    };

    const problems = auditSelectionDecision({ decision, probe: probeFor("es-toolkit"), ownership });
    expect(problems.some(problem => problem.includes("record the assessment's rejection"))).toBe(true);
  });

  it("refuses a non-replace strategy once a replacement signal was observed", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      signals: ["worker", "cell-artifact-budget-exceeded"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/cannot be deployed to this target/);
    expect(problems[0]).toMatch(/the decision cannot be "inline"/);
  });

  it("accepts a replace strategy for the same signals", () => {
    expect(
      auditSelectionDecision({
        decision: REPLACE,
        probe: probeFor("es-toolkit"),
        signals: ["cell-artifact-budget-exceeded"],
      }),
    ).toEqual([]);
  });

  it("refuses unknown signals", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      signals: ["vibes"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unknown signals \(vibes\)/);
  });

  it("refuses a repair recipe that does not meet the conditions", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      repairRecipe: { capabilityStillValuable: true, alternativesMateriallyWorse: false, repairCanBeValidated: true },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/repair recipe for "es-toolkit" is refused/);
  });

  it("delegates #4's decision rules rather than restating them", () => {
    const malformed = {
      strategy: "extension",
      packageName: "react",
      globalName: "React",
      libraryId: "",
    } as unknown as DependencyDecision;

    const problems = auditSelectionDecision({ decision: malformed, probe: probeFor("react") });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/must name both the library id and the global/);
    expect(problems[0]).toMatch(/#4 decision shape/);
  });

  it("reads the justification requirement from the strategy semantics", () => {
    expect(selectionJustificationRequired("extension")).toBe(true);
    expect(selectionJustificationRequired("replace")).toBe(true);
    expect(selectionJustificationRequired("inline")).toBe(false);
    expect(selectionJustificationRequired("host")).toBe(false);
  });
});
