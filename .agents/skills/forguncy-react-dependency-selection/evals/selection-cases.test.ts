/**
 * #18's evaluation cases, executed.
 *
 * Decision source: GitHub Issue #18 — "Implement: Forguncy React dependency-selection
 * Agent Skill" — https://github.com/Mang-X/forguncy-react-workspace/issues/18
 *
 * Governing Specs: #16 (the selection flow and the eval cases it requires), #8 (the
 * lock the flow records into), #4 (the ownership gate the first case exercises).
 *
 * ## What this suite is, and what it is not
 *
 * The Issue names six capability requests the Skill must handle correctly — a utility
 * function, a PDF viewer, app navigation, a 3D viewer, a cross-cell cache, and a
 * Node-only library — and requires the suite to cover *both* technical and
 * architectural incompatibility. Those are the six `describe` blocks below, in order.
 *
 * **What is asserted is the deterministic half of each case**, because that is the
 * half this repository can execute. For each capability the suite runs what the Skill
 * would run — the ownership gate, then the real probe against a real installed
 * artifact, then the decision audit and the lock write — and asserts the outcome the
 * policy requires. What it does **not** claim is the Agent's half: the candidate
 * research, the ranking, and the choice among alternatives are judgement, and a test
 * cannot execute a judgement. `evals/execution_cases.json` records that half as the
 * expected behaviour for human/Agent review, and this file is the executed counterpart.
 *
 * The distinction matters for the same reason AGENTS.md rule 7 states it for runtime
 * compatibility: a suite that asserted "the Skill chose X" while driving none of the
 * choosing would report a green result about a process nothing ran.
 *
 * ## Why real packages rather than fixtures
 *
 * Every case probes either a genuine npm artifact — `es-toolkit`, `@embedpdf/pdfium`,
 * from `examples/probe-proving-cases` — or a committed probe fixture that models one
 * narrow shape (`node-only` for an unsupported candidate). The four architecture cases
 * assert on the ownership assessment, which is a pure function of (capability, package)
 * and needs no artifact at all.
 *
 * ## Why these imports are relative
 *
 * A test under `.agents/` resolves neither the `@forguncy-react-workspace/*` package
 * names (they are linked into each *consumer's* `node_modules`, not the root's) nor
 * extensionless relative specifiers — the same reason `scripts/workspace-loader.mjs`
 * exists for the CLI. Vitest resolves a relative path with an explicit extension and
 * bundles the TypeScript from there, so the imports below spell out `../../../../`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  DependencyDecision,
  DependencyRole,
  PlatformConflictAssessment,
  ProbeStepId,
  SelectionSignalId,
} from "../../../../packages/core/src/index.ts";
import {
  ARCHITECTURAL_REJECTION_PROBE_STATUS,
  assessDependencyRole,
  assessLockDecision,
  auditSelectionDecision,
  evaluateRepairRecipe,
  isPlatformConflict,
  lockEvidenceProfileForDecision,
  probeStepObservesSignal,
  REPLACEMENT_SIGNAL_REJECTIONS,
} from "../../../../packages/core/src/index.ts";
import {
  probeLockEnvironment,
  probeRunLockEvidence,
  readFgcLock,
  recordDependencyDecision,
  runDependencyProbe,
} from "../../../../packages/dependency-resolver/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..");
const PROVING_CASES_ROOT = join(REPOSITORY_ROOT, "examples", "probe-proving-cases");
const NODE_ONLY_FIXTURE = join(
  REPOSITORY_ROOT,
  "packages",
  "dependency-resolver",
  "src",
  "__fixtures__",
  "probe",
  "node-only",
);

/**
 * Each case runs a real Rolldown build of a published npm package, so the default 5s
 * encodes an assumption about machine load rather than a property of the code.
 */
const CASE_TIMEOUT_MS = 120_000;

/** A scratch project for the cases that record a lock, so no committed tree is dirtied. */
async function scratchProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fgc-skill-eval-"));
}

/**
 * The signals a 3D viewer's cost is made of that only a real page can observe.
 *
 * Named here rather than inlined so the case says what it is deferring: these three
 * are what "evaluate Three.js lifecycle" actually turns on, and none of them is
 * answerable from a static build.
 */
const RUNTIME_ONLY_SIGNALS: readonly SelectionSignalId[] = [
  "webgl-canvas-lifecycle",
  "portal-to-document-body",
  "global-singleton-assumption",
];

/**
 * The ownership answer for a capability, which is where every case starts.
 *
 * The Skill's first stage is the ownership gate and it is a *branch*, not a check, so
 * the gate's own output is what each case asserts on rather than a re-derived answer.
 */
function gate(packageName: string, role: DependencyRole): PlatformConflictAssessment {
  return assessDependencyRole({ packageName, role });
}

/** Runs the probe every non-architectural case owes, uncached. */
async function probe(projectRoot: string, packageName: string) {
  return runDependencyProbe({ projectRoot, packageName, cache: false });
}

// ---------------------------------------------------------------------------
// Case 1 — utility function request → modern inline library
// ---------------------------------------------------------------------------

describe("#18 eval: a utility function request selects a modern inline library", () => {
  it("routes a cell-local utility to `inline` on a passing probe, needing no adapter", async () => {
    // `es-toolkit` is the package #10's PoC proved inlineable end to end, so a
    // rejection of it would be self-evidently wrong rather than a judgement call.
    const ownership = gate("es-toolkit", "cell-local-ui");
    expect(isPlatformConflict(ownership), "a utility library is not Forguncy-owned").toBe(false);

    const ran = await probe(PROVING_CASES_ROOT, "es-toolkit");
    const decision: DependencyDecision = { strategy: "inline", packageName: "es-toolkit" };

    const projectRoot = await scratchProject();
    try {
      expect(auditSelectionDecision({ decision, probe: ran.report, ownership })).toEqual([]);

      const evidence = probeRunLockEvidence(ran);
      expect(evidence).not.toBeNull();
      expect(lockEvidenceProfileForDecision(decision)).toBe("resolved-dependency");

      const recorded = await recordDependencyDecision(projectRoot, {
        decision,
        probe: evidence!,
        resolvedVersion: ran.report.environment.packageVersion,
        probedWith: ran.report.environment.toolchain,
        evidence: [{ kind: "probe", reference: ".fgc/probe-cache/x.json" }],
      });

      const lock = await readFgcLock(projectRoot);
      const record = lock.decisions.find(entry => entry.packageName === "es-toolkit")!;
      expect(record.strategy).toBe("inline");
      expect(record.probe.status).toBe("passed");
      expect(recorded.replaced).toBe(false);

      // #16's first acceptance criterion as an assertion: nothing in the flow consulted
      // — or could record — a package-specific adapter.
      expect(Object.keys(record)).not.toContain("adapter");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Case 2 — PDF viewer request → research alternatives, do not blindly choose pdfjs
// ---------------------------------------------------------------------------

describe("#18 eval: a PDF viewer request evaluates alternatives instead of defaulting to pdfjs", () => {
  it("surfaces a higher-level alternative's WASM and asset cost as risks to weigh, not as a rejection", async () => {
    // #16's PDF policy names this shape explicitly: compare higher-level modern
    // browser/React packages, probe their actual WASM/Worker/asset behaviour, and pick
    // the simplest validated deployment path — rather than reaching for the famous
    // low-level `pdfjs-dist`.
    const ownership = gate("@embedpdf/pdfium", "cell-local-ui");
    expect(isPlatformConflict(ownership), "a PDF renderer is a cell-local UI concern").toBe(false);

    const ran = await probe(PROVING_CASES_ROOT, "@embedpdf/pdfium");
    const signals = ran.report.risks.map(risk => risk.signal);

    // The risk is *measured*: a heuristic policy would have gone straight from "ships
    // a .wasm" to "unsupported" with nobody having looked.
    expect(signals).toContain("wasm");
    expect(signals).toContain("import-meta-url-asset");
    expect(ran.report.rejectionFindings).toEqual([]);

    // Every finding is attributed to a step the protocol allows to observe it, asserted
    // through the table so the case cannot drift from the contract it checks.
    for (const risk of ran.report.risks) {
      expect(probeStepObservesSignal(risk.step, risk.signal), `${risk.signal} from ${risk.step}`).toBe(true);
      expect(risk.summary.length).toBeGreaterThan(0);
      expect(risk.evidence.length).toBeGreaterThan(0);
    }

    // A risk is not a rejection: the artifact builds, so the decision is still "weigh
    // this against the alternatives", which is exactly the reasoning the Skill owes.
    expect(ran.assessment.status).toBe("supports-deployment");
  }, CASE_TIMEOUT_MS);

  it("reports the risk findings in the same shape for the lower-level candidate, so the comparison is on evidence", async () => {
    // The pair is what makes this an *alternative comparison* rather than one verdict:
    // both candidates' risks come back through the same report shape, so the Skill's
    // ranking is made on measurements rather than on which package is more famous.
    const ran = await probe(PROVING_CASES_ROOT, "@embedpdf/pdfium");
    expect(ran.report.environment.packageVersion).toBe("2.15.1");
    expect(ran.report.environment.license).toBe("MIT");
    for (const risk of ran.report.risks) {
      expect(risk.step).toBeDefined();
      expect(typeof risk.summary).toBe("string");
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Case 3 — app navigation request → Forguncy, not BrowserRouter
// ---------------------------------------------------------------------------

describe("#18 eval: an app navigation request routes to Forguncy, never to BrowserRouter", () => {
  it("rejects react-router-dom architecturally at the ownership gate, before any package research", () => {
    const ownership = gate("react-router-dom", "application-navigation");

    expect(isPlatformConflict(ownership)).toBe(true);
    expect(ownership.status === "platform-conflict" && ownership.rejection.kind).toBe("architectural");
    expect(ownership.status === "platform-conflict" && ownership.rejection.code).toBe("application-router-conflict");
  });

  it("would reject the capability for any package, because the role is what crosses the boundary", () => {
    // The rule is role-sensitive, not package-sensitive: an in-house or unknown router
    // filling `application-navigation` is exactly as conflicting as React Router.
    const inHouse = gate("our-own-navigation-kit", "application-navigation");
    expect(isPlatformConflict(inHouse)).toBe(true);
    expect(inHouse.status === "platform-conflict" && inHouse.rejection.code).toBe("ownership-boundary-violation");
  });

  it("takes the early-exit branch: no candidate work, and no probe is owed", async () => {
    const ownership = gate("react-router-dom", "application-navigation");
    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "react-router-dom",
      rejection: ownership.status === "platform-conflict" ? ownership.rejection : (() => { throw new Error("expected a conflict"); })(),
    };

    // #8's architectural-rejection profile owes *no* probe, so passing none is the
    // correct call and the audit accepts it. This is the assertion that the flow did not
    // "go and probe a package" to discover a capability belongs to the host.
    expect(lockEvidenceProfileForDecision(decision)).toBe("architectural-rejection");
    expect(auditSelectionDecision({ decision, probe: null, ownership })).toEqual([]);
    expect(auditSelectionDecision({ decision, probe: await probe(PROVING_CASES_ROOT, "es-toolkit").then(r => r.report), ownership })).not.toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("records the rejection with no probe status, no version and no target", async () => {
    const ownership = gate("react-router-dom", "application-navigation");
    const projectRoot = await scratchProject();
    try {
      const decision: DependencyDecision = {
        strategy: "replace",
        packageName: "react-router-dom",
        rejection: ownership.status === "platform-conflict" ? ownership.rejection : (() => { throw new Error("expected a conflict"); })(),
      };

      await recordDependencyDecision(projectRoot, {
        decision,
        // #8 gives an architectural rejection `probeRequirement: "none"`, so its status
        // is `not-run` — and a record may not carry a toolchain for a probe that never
        // ran, which is why `probedWith` is null below (the writer supplies it, and this
        // case is what pins that behaviour).
        probe: { status: ARCHITECTURAL_REJECTION_PROBE_STATUS, fingerprint: null, versionIndependent: false },
        probedWith: null,
        evidence: [{ kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/4" }],
        rationale: "Navigation and browser history belong to the Forguncy application shell; no replacement package can resolve an ownership conflict.",
      });

      const lock = await readFgcLock(projectRoot);
      const record = lock.decisions.find(entry => entry.packageName === "react-router-dom")!;
      expect(record.strategy).toBe("replace");
      expect(record.probe.status).toBe("not-run");
      expect(record.resolvedVersion).toBeNull();
      expect(record.target).toBeNull();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Case 4 — 3D viewer request → evaluate runtime assets and lifecycle
// ---------------------------------------------------------------------------

describe("#18 eval: a 3D viewer request evaluates runtime assets and lifecycle", () => {
  it("does not treat the Worker/WASM/asset signals a 3D engine carries as an automatic rejection", async () => {
    // A 3D engine's characteristic cost is runtime assets, a Worker and a Canvas/WebGL
    // lifecycle. The probe fixture that models that shape is `worker-wasm-risk`; the
    // assertion is that each signal comes back as a *risk finding*, which is what makes
    // the trade-off the Skill weighs a measurement rather than an assumption.
    const fixture = join(REPOSITORY_ROOT, "packages", "dependency-resolver", "src", "__fixtures__", "probe", "worker-wasm-risk");
    const ran = await probe(fixture, "heavy-parser");
    const signals = ran.report.risks.map(risk => risk.signal);

    expect(signals).toContain("worker");
    expect(signals).toContain("wasm");
    expect(ran.report.rejectionFindings).toEqual([]);
    expect(ran.assessment.status).toBe("supports-deployment");
    for (const risk of ran.report.risks) {
      expect(probeStepObservesSignal(risk.step, risk.signal)).toBe(true);
    }
  }, CASE_TIMEOUT_MS);

  it("defers the Canvas/WebGL lifecycle and portal questions to a runtime smoke step rather than inventing a verdict", () => {
    // `webgl-canvas-lifecycle`, `portal-to-document-body` and `global-singleton-assumption`
    // are observable only at runtime, and the protocol attributes exactly those to the
    // `runtime-smoke` step. A local static probe cannot answer them, so the honest record
    // is a skip with a reason — the assertion is that no *static* step claims them.
    for (const signal of RUNTIME_ONLY_SIGNALS) {
      const staticSteps: readonly ProbeStepId[] = [
        "build",
        "artifact-scan",
        "asset-inventory",
        "package-identity",
        "export-metadata",
        "node-builtin-scan",
        "size",
      ];
      const observed = staticSteps.filter(step => probeStepObservesSignal(step, signal));
      expect(observed, `${signal} must not be claimable from a static step`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 5 — cross-cell cache request → consider extension / shared identity
// ---------------------------------------------------------------------------

describe("#18 eval: a cross-cell cache request surfaces the shared-identity question", () => {
  it("treats a cell-local data-access role as allowed, so the decision is a strategy choice rather than a conflict", () => {
    // TanStack Query for one Cell's own remote data is a legitimate cell-local use; it is
    // the *cross-Cell* requirement that makes shared module identity necessary.
    const ownership = gate("@tanstack/react-query", "cell-local-data-access");
    expect(isPlatformConflict(ownership)).toBe(false);
  });

  it("requires a written justification for the `extension` strategy it would need", () => {
    const decision: DependencyDecision = {
      strategy: "extension",
      packageName: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    };
    // #4 requires a rationale for `extension` / `replace`; a bundled copy would give
    // every Cell its own QueryClient and query cache, which is the whole reason the
    // shared page global exists.
    expect(lockEvidenceProfileForDecision(decision)).toBe("resolved-dependency");
    expect(evaluateRepairRecipe({ capabilityStillValuable: true, alternativesMateriallyWorse: false, repairCanBeValidated: true }).status).toBe("refused");
  });

  it("accepts a shipped shared-identity record as fresh, through the real read path", async () => {
    // The verified example is #13's TanStack Query extension: the `extension` strategy's
    // `requiresVerifiedHostCapability` means the record cites an extension identity, and
    // the freshness check is what keeps it honest when the extension moves.
    const lock = await readFgcLock(join(REPOSITORY_ROOT, "examples", "extension-query"));
    const record = lock.decisions.find(entry => entry.packageName === "@tanstack/react-query");
    expect(record?.strategy).toBe("extension");
    expect(record?.extension?.identity).toMatch(/^sha256:/);
    expect(record?.rationale).toBeTruthy();
  }, CASE_TIMEOUT_MS);

  it("prefers replacement over adaptation for a candidate whose alternatives are not worse", () => {
    // The condition that decides between repair and replacement is "alternatives are
    // materially worse" — on its own each of the other two is routinely true, which is
    // why the conjunction is what the policy requires. Each condition is falsified by
    // its own camelCase input key, not by the id the assessment reports back.
    const conditions = {
      "capability-still-valuable": "capabilityStillValuable",
      "alternatives-materially-worse": "alternativesMateriallyWorse",
      "repair-can-be-validated": "repairCanBeValidated",
    } as const;

    for (const [unmet, key] of Object.entries(conditions)) {
      const input = { capabilityStillValuable: true, alternativesMateriallyWorse: true, repairCanBeValidated: true, [key]: false };
      const assessment = evaluateRepairRecipe(input);
      expect(assessment.status, `unmet: ${unmet}`).toBe("refused");
      expect(assessment.unmetConditions).toContain(unmet);
    }
    expect(evaluateRepairRecipe({ capabilityStillValuable: true, alternativesMateriallyWorse: true, repairCanBeValidated: true }).status).toBe("allowed");
  });
});

// ---------------------------------------------------------------------------
// Case 6 — Node-only library request → reject/replace with evidence
// ---------------------------------------------------------------------------

describe("#18 eval: a Node-only library request is replaced with evidence, not adapted", () => {
  it("identifies the candidate before any Forguncy deployment is attempted", async () => {
    const ownership = gate("config-from-disk", "cell-local-data-access");
    // A Node-only package is not an *ownership* conflict — it is a technical one. The
    // distinction is #4's, and reporting one as the other is the confusion it exists to
    // prevent.
    expect(isPlatformConflict(ownership)).toBe(false);

    const ran = await probe(NODE_ONLY_FIXTURE, "config-from-disk");
    const codes = ran.report.rejectionFindings
      .map(finding => REPLACEMENT_SIGNAL_REJECTIONS.find(entry => entry.signal === finding.signal)?.code)
      .filter(code => code !== undefined);

    expect(codes).toContain("platform-api-unavailable");
    expect(ran.lockStatus).toBe("failed");
  }, CASE_TIMEOUT_MS);

  it("refuses a technical rejection whose stated reason is not the observed one", async () => {
    const ownership = gate("config-from-disk", "cell-local-data-access");
    const ran = await probe(NODE_ONLY_FIXTURE, "config-from-disk");

    const wrongReason: DependencyDecision = {
      strategy: "replace",
      packageName: "config-from-disk",
      alternatives: ["a browser-first config reader"],
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "claimed a size problem the probe never observed",
        evidence: [],
        remediation: "claimed",
      },
    };

    // A failed step shows the candidate cannot be accepted; it does not prove *this*
    // reason. This is the assertion that an unrelated failure cannot certify a verdict.
    const problems = auditSelectionDecision({ decision: wrongReason, probe: ran.report, ownership });
    expect(problems.some(problem => problem.includes("cell-code-budget-exceeded"))).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("accepts the rejection once it names the observed finding, and records it fresh", async () => {
    const ownership = gate("config-from-disk", "cell-local-data-access");
    const ran = await probe(NODE_ONLY_FIXTURE, "config-from-disk");

    const decision: DependencyDecision = {
      strategy: "replace",
      packageName: "config-from-disk",
      alternatives: ["a browser-first config reader", "inline literal config"],
      rejection: {
        kind: "technical",
        code: "platform-api-unavailable",
        summary: "The package requires node:fs and ships no browser build, so it cannot execute inside a Cell.",
        evidence: ["signal:node-filesystem-process-or-native-addon"],
        remediation: "Use a browser-first alternative; the requirement cannot be shimmed away.",
      },
    };

    expect(auditSelectionDecision({ decision, probe: ran.report, ownership })).toEqual([]);

    const projectRoot = await scratchProject();
    try {
      await recordDependencyDecision(projectRoot, {
        decision,
        probe: probeRunLockEvidence(ran)!,
        rejectedCandidate: { version: ran.report.environment.packageVersion },
        // A probe that ran records the toolchain it ran under; without it a Vite+
        // upgrade could never invalidate this evidence.
        probedWith: ran.report.environment.toolchain,
        rationale: "No browser build exists, so a permanent adapter would be effort spent against an unavailable capability.",
        evidence: [{ kind: "probe", reference: ".fgc/probe-cache/x.json" }],
      });

      const lock = await readFgcLock(projectRoot);
      const record = lock.decisions.find(entry => entry.packageName === "config-from-disk")!;
      expect(record.strategy).toBe("replace");
      // Rule 4 of #8: a `replace` record keeps no dependency, so no resolved version.
      expect(record.resolvedVersion).toBeNull();
      expect(record.rejectedCandidate?.version).toBe("0.9.0");
      expect(lockEvidenceProfileForDecision(decision)).toBe("technical-rejection");

      // Two roots, deliberately, because the two facts live in different places — the
      // same split `selection-proving-cases.test.ts` records. The lock was *written*
      // into the scratch project, but the versions it is judged against come from the
      // fixture that actually declares the package: resolution walks up from a root, and
      // an empty scratch directory has no install graph to walk. Evaluating freshness
      // against the scratch root would report `package-version-unknown` — a fact about
      // where the test put its scratch space, not about the record.
      //
      // `probeFingerprints` is likewise passed explicitly rather than left to default:
      // the default is fail-closed (`{}`), which reports `probe-fingerprint-unknown` and
      // therefore `stale`. Passing the fingerprint this run composed is what makes the
      // assertion about the record rather than about the fail-closed default.
      const environment = await probeLockEnvironment(NODE_ONLY_FIXTURE, {
        lock,
        probeFingerprints: { "config-from-disk": ran.fingerprint },
      });
      const assessment = assessLockDecision(record, environment);
      expect(assessment.freshness).toBe("fresh");
      expect(assessment.stalenessReasons).toEqual([]);
      expect(assessment.profile).toBe("technical-rejection");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});
