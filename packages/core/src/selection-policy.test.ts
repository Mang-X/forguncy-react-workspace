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
import { LOCK_EVIDENCE_POLICY, lockEvidenceProfileForDecision } from "./lock";
import { assessDependencyRole, isPlatformConflict } from "./platform-conflicts";
import type { ProbeEnvironment, ProbeRejectionFinding, ProbeReport, ProbeValidationEntry } from "./probe-protocol";
import { PROBE_REPORT_SCHEMA_VERSION, PROBE_STEP_IDS } from "./probe-protocol";
import {
  auditSelectionDecision,
  branchForOwnership,
  evaluateRepairRecipe,
  findSelectionBranch,
  findSelectionStage,
  isOwnershipGateFirst,
  isSelectionBranchId,
  isSelectionDecisionRecordable,
  isSelectionStageId,
  NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT,
  OWNERSHIP_GATE_STAGE_ID,
  REPAIR_RECIPE_CONDITIONS,
  SELECTION_ACCEPTANCE_CRITERIA,
  SELECTION_AUTHORITIES,
  SELECTION_BRANCHES,
  SELECTION_GOVERNING_DECISIONS,
  SELECTION_GOVERNING_SPEC_REFERENCE_LINE,
  SELECTION_STAGES,
  SELECTION_STAGE_IDS,
  selectionBranch,
  selectionJustificationRequired,
  selectionStage,
  selectionStageOrder,
  SPEC_PROVING_CASES,
  stagesBefore,
  stagesForBranch,
  stagesSkippedOnEarlyExit,
  stagesWithAuthority,
} from "./selection-policy";
import type { SelectionAuditInput } from "./selection-policy";
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

/** A report from a probe that ran every step and observed nothing disqualifying. */
function probeFor(packageName: string, overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
    environment: { ...ENVIRONMENT, packageName },
    facts: [{ step: "package-identity", name: "resolvedVersion", value: ENVIRONMENT.packageVersion }],
    risks: [],
    rejectionFindings: [],
    validation: PROBE_STEP_IDS.map(step => ({
      step,
      outcome: "passed" as const,
      detail: `ran "${step}"`,
      diagnostics: [],
    })),
    ...overrides,
  };
}

/** Builds a validation section from per-step outcomes; anything unlisted passed. */
function validationWith(
  outcomes: Partial<Record<(typeof PROBE_STEP_IDS)[number], "failed" | "skipped">>,
): readonly ProbeValidationEntry[] {
  return PROBE_STEP_IDS.map(step => {
    const outcome = outcomes[step];
    if (outcome === "failed") {
      return { step, outcome, detail: `"${step}" failed`, diagnostics: [`${step} reported an error`] };
    }
    if (outcome === "skipped") {
      return { step, outcome, detail: `"${step}" did not run`, diagnostics: [] };
    }
    return { step, outcome: "passed" as const, detail: `ran "${step}"`, diagnostics: [] };
  });
}

const NODE_BUILTIN_FINDING: ProbeRejectionFinding = {
  signal: "node-filesystem-process-or-native-addon",
  step: "node-builtin-scan",
  summary: "The resolved dependency graph reaches node:fs.",
  evidence: ["node-fetch -> node:fs"],
};

function ownershipConflict() {
  const assessment = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
  if (!isPlatformConflict(assessment)) {
    throw new Error("fixture is expected to be a platform conflict");
  }
  return assessment;
}

/** The allowed path: a cell-local role for es-toolkit is nobody's ownership conflict. */
const ISLAND_OWNERSHIP = assessDependencyRole({ packageName: "es-toolkit", role: "cell-local-ui" });

/** The conflict path: a router asked to fill application navigation. */
const CONFLICT_OWNERSHIP = ownershipConflict();

const INLINE: DependencyDecision = { strategy: "inline", packageName: "es-toolkit" };

/** A technical replace bound to the Node-builtin finding a report can carry. */
const TECHNICAL_REPLACE: DependencyDecision = {
  strategy: "replace",
  packageName: "es-toolkit",
  rejection: {
    kind: "technical",
    code: "platform-api-unavailable",
    summary: "The resolved dependency graph reaches a Node builtin.",
    remediation: "Evaluate a browser-first alternative.",
  },
  alternatives: ["lighter-toolkit"],
};

/** An architectural replace: the capability is Forguncy's, so there is nothing to bundle. */
const ARCHITECTURAL_REPLACE: DependencyDecision = {
  strategy: "replace",
  packageName: "react-router-dom",
  rejection: CONFLICT_OWNERSHIP.rejection,
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
    expect(stage.mustNot.join(" ")).toMatch(/Refuse it and report why/);
    // The evidence a record owes follows #8's profile, so an architectural rejection
    // must not be told to link a probe.
    expect(stage.mustNot.join(" ")).toMatch(/the ownership decision for an architectural rejection/);
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
    // The exported strings must not describe an unconditional pipeline: an architectural
    // rejection is decided by the gate and owes no probe.
    expect(selectionStage("persist-decision").produces).toMatch(/the ownership decision for an architectural rejection/);
    expect(selectionStage("decide-strategy").produces).toMatch(/evidence #8's profile names/);
  });
});

describe("the flow is a branch, not a pipeline", () => {
  it("gives the two arms the gate can select", () => {
    expect(SELECTION_BRANCHES.map(branch => branch.id)).toEqual(["forguncy-owned", "react-island-owned"]);
    for (const branch of SELECTION_BRANCHES) {
      expect(branch.decidedAt).toBe(OWNERSHIP_GATE_STAGE_ID);
    }
    expect(isSelectionBranchId("forguncy-owned")).toBe(true);
    expect(isSelectionBranchId("pipeline")).toBe(false);
    expect(findSelectionBranch("pipeline" as never)).toBeUndefined();
    expect(() => selectionBranch("pipeline" as never)).toThrow(/Unknown dependency-selection branch/);
  });

  it("exits before any candidate work for a Forguncy-owned capability", () => {
    const early = selectionBranch("forguncy-owned");
    expect(early.stages).toEqual(["classify-ownership", "persist-decision"]);
    expect(early.skipsCandidateWork).toBe(true);

    // The difference a reader most easily misses when treating SELECTION_STAGES as
    // linear, and the one that decides whether an ownership conflict is answered by
    // routing it to the host or by researching packages.
    expect(stagesSkippedOnEarlyExit()).toEqual([
      "research-candidates",
      "rank-candidates",
      "probe-candidate",
      "decide-strategy",
      "resolve-replacement",
    ]);
  });

  it("runs every stage on the React-island arm", () => {
    const island = selectionBranch("react-island-owned");
    expect(island.skipsCandidateWork).toBe(false);
    expect([...island.stages]).toEqual([...SELECTION_STAGE_IDS]);
    expect(stagesForBranch("react-island-owned").map(stage => stage.id)).toEqual([...SELECTION_STAGE_IDS]);
  });

  it("keeps every arm in canonical stage order and inside the vocabulary", () => {
    for (const branch of SELECTION_BRANCHES) {
      for (const stageId of branch.stages) {
        expect(SELECTION_STAGE_IDS, `${branch.id}/${stageId}`).toContain(stageId);
      }
      const orders = branch.stages.map(stageId => selectionStageOrder(stageId));
      expect([...orders].sort((a, b) => a - b), branch.id).toEqual(orders);
    }
  });

  it("selects the arm from the ownership assessment rather than from the stage list", () => {
    expect(branchForOwnership(CONFLICT_OWNERSHIP).id).toBe("forguncy-owned");
    expect(branchForOwnership(ISLAND_OWNERSHIP).id).toBe("react-island-owned");
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

describe("the audit reads the probe a decision owes from #8", () => {
  it("agrees with #8's evidence profiles", () => {
    // The audit does not decide which probe a decision owes; #8 does. This asserts the
    // two contracts actually line up, because a record written under one answer and
    // evaluated under the other looks like a fresh decision.
    expect(lockEvidenceProfileForDecision(INLINE)).toBe("resolved-dependency");
    expect(lockEvidenceProfileForDecision(ARCHITECTURAL_REPLACE)).toBe("architectural-rejection");
    expect(lockEvidenceProfileForDecision(TECHNICAL_REPLACE)).toBe("technical-rejection");

    expect(LOCK_EVIDENCE_POLICY[lockEvidenceProfileForDecision(INLINE)].probeRequirement).toBe("passed");
    expect(LOCK_EVIDENCE_POLICY[lockEvidenceProfileForDecision(ARCHITECTURAL_REPLACE)].probeRequirement).toBe("none");
    expect(LOCK_EVIDENCE_POLICY[lockEvidenceProfileForDecision(TECHNICAL_REPLACE)].probeRequirement).toBe("not-passed");
  });
});

describe("selection decision audit", () => {
  it("accepts a decision backed by the probe it owes", () => {
    const input: SelectionAuditInput = {
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      ownership: ISLAND_OWNERSHIP,
    };
    expect(auditSelectionDecision(input)).toEqual([]);
    expect(isSelectionDecisionRecordable(input)).toBe(true);
  });

  it("requires the ownership assessment as an input", () => {
    // @ts-expect-error the ownership gate is not optional; omitting it used to skip it
    const incomplete: SelectionAuditInput = { decision: INLINE, probe: probeFor("es-toolkit") };
    expect(incomplete.decision.packageName).toBe("es-toolkit");
  });

  it("refuses an ownership assessment made about a different package", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      ownership: CONFLICT_OWNERSHIP,
    });
    expect(
      problems.some(problem =>
        problem.includes(
          'The ownership assessment is about "react-router-dom" but the decision is about "es-toolkit"',
        ),
      ),
    ).toBe(true);
  });

  it("refuses a decision taken without the probe #8 requires", () => {
    const problems = auditSelectionDecision({ decision: INLINE, probe: null, ownership: ISLAND_OWNERSHIP });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/probeRequirement "passed"/);
  });

  it("refuses a probe about a different package", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("some-other-package"),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes('probe report is about "some-other-package"'))).toBe(true);
  });

  it("refuses a strategy the probe does not satisfy", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit", { validation: validationWith({ build: "failed" }) }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("does not satisfy the evidence"))).toBe(true);
  });

  it("does not accept a strategy because one unrelated step passed", () => {
    // `package-identity` passing while `build` fails was enough under the old
    // "hasPassingEvidence" gate. It describes a candidate that does not work.
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit", {
        validation: validationWith({ build: "failed", "artifact-scan": "skipped", size: "skipped" }),
      }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("does not satisfy the evidence"))).toBe(true);
  });

  it("refuses a positive strategy when an observed finding disqualifies the candidate", () => {
    // The hole that optional caller-supplied signals left: the scanner found a Node
    // builtin, and omitting the list used to let `supports-deployment` stand.
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit", { rejectionFindings: [NODE_BUILTIN_FINDING] }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("does not satisfy the evidence"))).toBe(true);
  });

  it("accepts a technical replace bound to the finding that supports its reason", () => {
    expect(
      auditSelectionDecision({
        decision: TECHNICAL_REPLACE,
        probe: probeFor("es-toolkit", { rejectionFindings: [NODE_BUILTIN_FINDING] }),
        ownership: ISLAND_OWNERSHIP,
      }),
    ).toEqual([]);
  });

  it("refuses a technical replace whose code no observed finding supports", () => {
    // The reviewer's case: `build` failed on a Node builtin while the decision recorded
    // a size rejection. The failure shows the candidate cannot be accepted; it does not
    // prove *this* reason.
    const problems = auditSelectionDecision({
      decision: TECHNICAL_REPLACE,
      probe: probeFor("es-toolkit", { validation: validationWith({ build: "failed" }) }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("it does not prove this reason"))).toBe(true);
    expect(problems.some(problem => problem.includes("none (the report contains no rejection finding)"))).toBe(true);
  });

  it("refuses a technical replace whose code is a different finding's code", () => {
    const sizeFinding: ProbeRejectionFinding = {
      signal: "cell-artifact-budget-exceeded",
      step: "size",
      summary: "The artifact exceeds the cell budget.",
      evidence: ["3.1 MB"],
    };
    const problems = auditSelectionDecision({
      decision: TECHNICAL_REPLACE,
      probe: probeFor("es-toolkit", { rejectionFindings: [sizeFinding] }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("cell-code-budget-exceeded"))).toBe(true);
  });

  it("refuses a report that fails its own contract", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit", { facts: [] }),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("fails its own contract"))).toBe(true);
    expect(problems.some(problem => problem.includes("records no facts"))).toBe(true);
  });

  it("refuses a repair recipe that does not meet the conditions", () => {
    const problems = auditSelectionDecision({
      decision: INLINE,
      probe: probeFor("es-toolkit"),
      ownership: ISLAND_OWNERSHIP,
      repairRecipe: { capabilityStillValuable: true, alternativesMateriallyWorse: false, repairCanBeValidated: true },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/repair recipe for "es-toolkit" is refused/);
  });

  it("delegates #4's decision rules rather than restating them", () => {
    const malformed = {
      strategy: "extension",
      packageName: "es-toolkit",
      globalName: "React",
      libraryId: "",
    } as unknown as DependencyDecision;

    const problems = auditSelectionDecision({
      decision: malformed,
      probe: probeFor("es-toolkit"),
      ownership: ISLAND_OWNERSHIP,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/must name both the library id and the global/);
    expect(problems[0]).toMatch(/#4 decision shape/);
  });

  it("refuses an architectural rejection the ownership assessment does not agree with", () => {
    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "es-toolkit",
      rejection: {
        kind: "architectural",
        code: "ownership-boundary-violation",
        summary: "hand-written ownership claim",
        remediation: "hand-written",
      },
    };
    const problems = auditSelectionDecision({ decision, probe: null, ownership: ISLAND_OWNERSHIP });
    expect(problems.some(problem => problem.includes("did not find the capability to be Forguncy-owned"))).toBe(true);
  });
});

describe("ownership conflicts stop the flow", () => {
  it("records an architectural rejection with no probe at all", () => {
    // #16 rule 1: the gate runs first and routing to the host is the answer. #8 encodes
    // the same thing as probeRequirement "none" for this profile.
    expect(
      auditSelectionDecision({ decision: ARCHITECTURAL_REPLACE, probe: null, ownership: CONFLICT_OWNERSHIP }),
    ).toEqual([]);
  });

  it("refuses a probe attached to an architectural rejection", () => {
    const problems = auditSelectionDecision({
      decision: ARCHITECTURAL_REPLACE,
      probe: probeFor("react-router-dom"),
      ownership: CONFLICT_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("carries a probe report"))).toBe(true);
    expect(problems.some(problem => problem.includes('probeRequirement "none"'))).toBe(true);
  });

  it("refuses a positive strategy for an owned capability", () => {
    const problems = auditSelectionDecision({
      decision: { strategy: "inline", packageName: "react-router-dom" },
      probe: null,
      ownership: CONFLICT_OWNERSHIP,
    });
    expect(problems.some(problem => problem.includes("assessed as Forguncy-owned"))).toBe(true);
    expect(problems.some(problem => problem.includes("Route the capability to the host"))).toBe(true);
  });

  it("refuses an ownership conflict recorded as a bundling failure", () => {
    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "react-router-dom",
      rejection: {
        kind: "technical",
        code: "amd-umd-branch-mismatch",
        summary: "misreported as a bundling failure",
        remediation: "misreported",
      },
      alternatives: ["another-router"],
    };
    const problems = auditSelectionDecision({ decision, probe: null, ownership: CONFLICT_OWNERSHIP });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/but the recorded rejection is technical/);
  });

  it("refuses an architectural code that is not the one the assessment produced", () => {
    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "react-router-dom",
      rejection: {
        kind: "architectural",
        code: "auth-framework-conflict",
        summary: "hand-written but plausible-looking",
        remediation: "hand-written",
      },
    };
    const problems = auditSelectionDecision({ decision, probe: null, ownership: CONFLICT_OWNERSHIP });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/record the assessment's rejection/);
  });
});

describe("strategy justification", () => {
  it("reads the requirement from the strategy semantics", () => {
    expect(selectionJustificationRequired("extension")).toBe(true);
    expect(selectionJustificationRequired("replace")).toBe(true);
    expect(selectionJustificationRequired("inline")).toBe(false);
    expect(selectionJustificationRequired("host")).toBe(false);
  });
});
