/**
 * #16's fifth acceptance criterion, executed: one simple ESM package and one
 * Worker/WASM-risk package evaluated **end to end against real installed npm
 * artifacts**.
 *
 * Decision source: GitHub Issue #16 — "Spec: Agent-driven dependency selection and
 * empirical compatibility probe", the criterion
 *
 *   "At least one simple ESM package and one Worker/WASM-risk package are evaluated
 *    end-to-end before this spec is considered proven."
 *
 * which `SPEC_PROVING_CASES` fixes to exactly two cases, in order:
 * `simple-esm-package` then `worker-or-wasm-risk-package`.
 *
 * Governing Specs: #16 (the selection flow this test walks and the probe protocol it
 * invokes), #8 (the lock a decision is recorded into and the freshness rules
 * evaluated at the end), #4 (the ownership gate that runs first).
 *
 * ## Why this is a test and not a report
 *
 * Every other probe test in this package runs against a hand-written fixture under
 * `__fixtures__/probe/`, and that is what let three false rejections survive: each
 * fixture ships exactly one source file per package, so "every file in the tree" and
 * "every file a browser build reaches" were the same set, and a scanner that read the
 * whole tree looked correct. Running against genuine npm artifacts is the only thing
 * that separates those two sets, which is why #16 makes the criterion *evidence*
 * rather than a documentation task — and why it cannot be discharged by editing the
 * policy text that states it.
 *
 * ## What each case runs
 *
 * The selection flow from `SELECTION_STAGES`, in order, on a real package:
 *
 * 1. **Ownership gate** (`assessDependencyRole`) — the capability is cell-local UI,
 *    so the package is not a platform conflict and the react-island arm runs. A
 *    Forguncy-owned capability would stop here, which is the branch
 *    `SELECTION_BRANCHES` encodes.
 * 2. **Probe** (`runDependencyProbe`) — the executed deterministic probe #16
 *    requires; never documentation inspection.
 * 3. **Decision audit** (`auditSelectionDecision`) — the decision must satisfy the
 *    evidence `#8`'s profile names for it, and the probe must be about this package.
 * 4. **Record** (`recordDependencyDecision`) — the decision and its evidence written
 *    into the project lock.
 * 5. **Read back and evaluate freshness** (`readFgcLock` + `assessLockDecision`) —
 *    the record must be `fresh` against the environment that produced it, which is
 *    what makes the decision reproducible rather than merely written down.
 *
 * ## What this does NOT claim
 *
 * Local, deterministic checks only. AGENTS.md rule 7 forbids presenting this as
 * Forguncy runtime compatibility: no ReactCellType designer or runtime was involved,
 * and `runtime-smoke` is `skipped` in both reports with a reason. The evidence is
 * about the artifacts npm publishes and the lock contract, not about Forguncy.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyDecision, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import {
  assessDependencyRole,
  assessLockDecision,
  isPlatformConflict,
  lockEvidenceProfileForDecision,
  probeStepObservesSignal,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { recordDependencyDecision } from "./decision-recording.ts";
import { readFgcLock } from "./lock-store.ts";
import { auditSelectionDecision } from "@forguncy-react-workspace/core";
import { probeCacheRelativePath, probeLockEnvironment, probeRunLockEvidence, runDependencyProbe } from "./index.ts";
import { readToolchainIdentity } from "./probe/identity.ts";

/**
 * Wall-clock allowance for one case.
 *
 * Each case runs a real Rolldown build of a genuine npm package plus the probe that
 * consumes it, so the 5s default encodes an assumption about machine load rather
 * than a property of the code under test. Generous enough that only a genuine hang
 * fails, and still an explicit bound rather than a disabled timeout.
 */
const PROVING_CASE_TIMEOUT_MS = 120_000;

/**
 * The example that declares the two proving-case packages.
 *
 * Its `node_modules` is where the packages are actually installed, so the probe's
 * `createRequire` anchor must be this directory — a package is only resolvable from
 * the project that declares it.
 */
const PROVING_CASES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "examples",
  "probe-proving-cases",
);

/** The repository root, where the `vite-plus` version the record cites is declared. */
const REPOSITORY_ROOT = join(PROVING_CASES_ROOT, "..", "..");

/** The cell-local role both libraries are requested for. */
const ROLE = "cell-local-ui" as const;

/**
 * A scratch project holding the `fgc.lock.json` a case writes.
 *
 * The lock is written beside the packages rather than into the example, because a
 * test that left `fgc.lock.json` in a committed directory would dirty the working
 * tree on every run. `.fgc/` is git-ignored and is already the probe's scratch space,
 * so the lock goes there and the assertions read it back through the real read path.
 */
async function scratchProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fgc-proving-cases-"));
}

interface RanCase {
  readonly decision: DependencyDecision;
  readonly record: LockedDependencyDecision | null;
  readonly lockPath: string;
  readonly projectRoot: string;
  readonly probeAssessment: string;
  readonly lockStatus: string | null;
  readonly fingerprints: Readonly<Record<string, string>>;
}

/**
 * Runs the whole flow for one package and returns what a reviewer needs to check it.
 *
 * Deliberately not returning a boolean: the point of #16 is that a decision is
 * reviewable from its evidence, so the test asserts on the parts and this function
 * hands them back rather than collapsing them.
 */
async function runProvingCase(options: {
  readonly packageName: string;
  readonly strategy: DependencyDecision;
  readonly rationale?: string;
}): Promise<RanCase> {
  const projectRoot = await scratchProject();
  const ownership = assessDependencyRole({ packageName: options.packageName, role: ROLE });

  // Stage 1 — the ownership gate is a *branch*, not a check. A platform conflict
  // would stop the flow here and owe no probe at all, so a conflict in either case
  // means this test is not exercising the flow it claims to.
  expect(isPlatformConflict(ownership), `${options.packageName} must not be Forguncy-owned`).toBe(false);

  // Stage 2 — the executed probe. `cache: false` so a stale cache entry can never
  // stand in for a measurement this run did not make.
  const probe = await runDependencyProbe({
    projectRoot: PROVING_CASES_ROOT,
    packageName: options.packageName,
    cache: false,
  });

  // Stage 3 — the audit. It reads the probe #8's evidence profile requires, insists
  // the report is about this package, and refuses a decision whose reason does not
  // match a machine-observed finding.
  const problems = auditSelectionDecision({
    decision: options.strategy,
    probe: probe.report,
    ownership,
  });
  expect(problems, `audit problems for ${options.packageName}`).toEqual([]);

  // Stage 4 — record. The write validates the whole canonical lock, so this is what
  // proves the record is loadable and not merely well-shaped in memory.
  const lockEvidence = probeRunLockEvidence(probe);
  expect(lockEvidence, `lock evidence for ${options.packageName}`).not.toBeNull();

  const recorded = await recordDependencyDecision(projectRoot, {
    decision: options.strategy,
    probe: lockEvidence!,
    ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    resolvedVersion: probe.report.environment.packageVersion,
    target: probe.report.environment.target,
    probedWith: probe.report.environment.toolchain,
    evidence: [
      // The probe this decision rests on, cited by the portable path the cache
      // actually writes to — the reference #8's portability rule accepts.
      { kind: "probe", reference: probeCacheRelativePath(probe.fingerprint) },
      // The Spec the decision was reached under.
      {
        kind: "spec-issue",
        reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/16",
      },
    ],
  });

  // First write into a fresh scratch project, so it cannot have replaced anything.
  // Asserted rather than ignored: a `true` here would mean the scratch project was not
  // fresh and this run's "recorded" decision might have inherited an earlier one's
  // rationale or evidence.
  expect(recorded.replaced, `${options.packageName} was recorded into a fresh project`).toBe(false);

  // Stage 5 — read back through the real read path, so a record the reader would
  // refuse cannot pass on the strength of the writer's in-memory copy.
  const lock = await readFgcLock(projectRoot);
  const record = lock.decisions.find(entry => entry.packageName === options.packageName) ?? null;

  return {
    decision: options.strategy,
    record,
    lockPath: join(projectRoot, "fgc.lock.json"),
    projectRoot,
    probeAssessment: probe.assessment.status,
    lockStatus: probe.lockStatus,
    fingerprints: { [options.packageName]: probe.fingerprint },
  };
}

/**
 * The evidence `#8`'s freshness rules are evaluated against, built from the same
 * install graph and toolchain the probe used.
 *
 * **Two roots, deliberately, because the two facts live in different places.** The
 * installed versions come from the example, which is what declares `es-toolkit` and
 * `@embedpdf/pdfium` — that is the graph the probe measured, so it is the graph the
 * record's `resolvedVersion` has to be judged against. The toolchain comes from the
 * repository root, which is what declares `vite-plus`.
 *
 * Passing one root for both was a real defect this test had, and it only showed up on
 * CI: `probeLockEnvironment(REPOSITORY_ROOT, …)` resolves versions upward from the repo
 * root, and on a Windows checkout the walk-up happened to find `es-toolkit` while on
 * Linux it did not — so the record reported `stale` (`package-version-unknown`) there and
 * `fresh` here. A test that passes on one platform and fails on another is worse than no
 * test, so the roots are now stated rather than left to where the walk lands.
 *
 * `probeFingerprints` is likewise passed explicitly rather than left to default: the
 * default is fail-closed (`{}`), which makes a recorded fingerprint report
 * `probe-fingerprint-unknown` and therefore `stale`. Passing the fingerprint the run
 * composed is what makes this an assertion about freshness rather than about the
 * fail-closed default.
 */
async function freshnessOf(ran: RanCase) {
  const environment = await probeLockEnvironment(PROVING_CASES_ROOT, {
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: await readToolchainIdentity(REPOSITORY_ROOT),
    probeFingerprints: ran.fingerprints,
  });
  return assessLockDecision(ran.record!, environment);
}

describe("#16 proving case: a simple ESM package", () => {
  it("reaches `inline` through the probe alone, with no per-package entry anywhere", async () => {
    const ran = await runProvingCase({
      packageName: "es-toolkit",
      strategy: { strategy: "inline", packageName: "es-toolkit" },
    });

    try {
      // The probe measured a deployable artifact. `es-toolkit` is the package #10's
      // PoC already proved inlineable end to end, so this is the assertion that a
      // real, ordinary npm library needs no special handling at all.
      expect(ran.probeAssessment).toBe("supports-deployment");
      expect(ran.lockStatus).toBe("passed");

      // `inline` is the strategy for a compatible browser-first library, and #8
      // requires probe evidence of `passed` for it — no exception, no adapter.
      expect(lockEvidenceProfileForDecision(ran.decision)).toBe("resolved-dependency");

      expect(ran.record).not.toBeNull();
      expect(ran.record!.strategy).toBe("inline");
      expect(ran.record!.resolvedVersion).toBe("1.52.0");
      expect(ran.record!.probe.status).toBe("passed");
      expect(ran.record!.probe.fingerprint).not.toBeNull();

      // The record cites the probe it rests on.
      expect(ran.record!.evidence.map(link => link.kind)).toContain("probe");

      // #16's first acceptance criterion, stated as the assertion it is: normal
      // operation needs no package-specific adapter registry. The lock document has
      // no place to put one, and the flow reached a strategy without consulting any.
      expect(Object.keys(ran.record!)).not.toContain("adapter");
    } finally {
      await rm(ran.projectRoot, { recursive: true, force: true });
    }
  }, PROVING_CASE_TIMEOUT_MS);

  it("records a decision that is fresh against the environment that produced it", async () => {
    const ran = await runProvingCase({
      packageName: "es-toolkit",
      strategy: { strategy: "inline", packageName: "es-toolkit" },
    });

    try {
      const assessment = await freshnessOf(ran);

      expect(assessment.freshness).toBe("fresh");
      expect(assessment.stalenessReasons).toEqual([]);
      expect(assessment.profile).toBe("resolved-dependency");
    } finally {
      await rm(ran.projectRoot, { recursive: true, force: true });
    }
  }, PROVING_CASE_TIMEOUT_MS);

  it("does not claim a Forguncy runtime check it never ran", async () => {
    const ran = await runProvingCase({
      packageName: "es-toolkit",
      strategy: { strategy: "inline", packageName: "es-toolkit" },
    });

    try {
      // AGENTS.md rule 7: local checks must not be presented as runtime
      // compatibility. The report records exactly which steps ran, and the runtime
      // one is a skip with a reason — there is no browser in this toolchain.
      const probe = await runDependencyProbe({
        projectRoot: PROVING_CASES_ROOT,
        packageName: "es-toolkit",
        cache: false,
      });
      const smoke = probe.report.validation.find(entry => entry.step === "runtime-smoke");

      expect(smoke?.outcome).toBe("skipped");
      expect(smoke?.detail).toContain("No runtime-smoke hook was supplied");

      // And the record must not carry a runtime observation it did not perform:
      // `evidence` cites the probe and the Spec, never a runtime observation.
      expect(ran.record!.evidence.map(link => link.kind).sort()).toEqual(["probe", "spec-issue"]);
    } finally {
      await rm(ran.projectRoot, { recursive: true, force: true });
    }
  }, PROVING_CASE_TIMEOUT_MS);
});

describe("#16 proving case: a Worker/WASM-risk package", () => {
  it("surfaces WASM and asset risks as findings to weigh, not as an automatic rejection", async () => {
    const ran = await runProvingCase({
      packageName: "@embedpdf/pdfium",
      strategy: { strategy: "inline", packageName: "@embedpdf/pdfium" },
    });

    try {
      // The risk is *surfaced*, which is the whole point of the case: a heuristic
      // policy would have gone from "this ships a .wasm" to "unsupported" without
      // anyone measuring it.
      const probe = await runDependencyProbe({
        projectRoot: PROVING_CASES_ROOT,
        packageName: "@embedpdf/pdfium",
        cache: false,
      });

      const riskSignals = probe.report.risks.map(risk => risk.signal);
      expect(riskSignals).toContain("wasm");
      expect(riskSignals).toContain("import-meta-url-asset");

      // Each finding is attributed to a step the protocol allows to observe it —
      // asserted through the table rather than against a literal list, so the test
      // cannot drift from the contract it is checking.
      for (const risk of probe.report.risks) {
        expect(probeStepObservesSignal(risk.step, risk.signal), `${risk.signal} from ${risk.step}`).toBe(true);
      }

      // A risk is not a rejection. The artifact is a real artifact that builds; the
      // Worker/WASM/asset cost is a trade-off for the Agent to weigh against
      // alternatives, which is what makes this case evidence *for* the policy rather
      // than a counter-example to it.
      expect(probe.report.rejectionFindings).toEqual([]);
      expect(ran.probeAssessment).toBe("supports-deployment");

      // The decision is supported by evidence rather than by the absence of a failure.
      expect(ran.record).not.toBeNull();
      expect(ran.record!.strategy).toBe("inline");
      expect(ran.record!.resolvedVersion).toBe("2.15.1");
      expect(ran.record!.probe.status).toBe("passed");
    } finally {
      await rm(ran.projectRoot, { recursive: true, force: true });
    }
  }, PROVING_CASE_TIMEOUT_MS);

  it("ships the risk findings in the report a reviewer re-checks, not only in the verdict", async () => {
    const probe = await runDependencyProbe({
      projectRoot: PROVING_CASES_ROOT,
      packageName: "@embedpdf/pdfium",
      cache: false,
    });

    try {
      // The evidence for the risk has to be re-checkable without re-running the
      // probe: a summary naming the signal and the files that exhibited it.
      for (const risk of probe.report.risks) {
        expect(risk.summary.length).toBeGreaterThan(0);
        expect(risk.evidence.length).toBeGreaterThan(0);
      }

      // `runtime-smoke` is skipped with a reason, never silently absent: there is no
      // browser in this toolchain, and #16 asks for a runtime result only "where
      // needed". Recorded so "was a runtime check run?" has an answer.
      const smoke = probe.report.validation.find(entry => entry.step === "runtime-smoke");
      expect(smoke?.outcome).toBe("skipped");
      expect(smoke?.detail.length).toBeGreaterThan(0);
      expect(smoke?.diagnostics).toEqual([]);

      // The probe is a measurement of a real published artifact, not of a fixture
      // this repository wrote: the identity comes from npm's own manifest.
      expect(probe.report.environment.packageVersion).toBe("2.15.1");
      expect(probe.report.environment.license).toBe("MIT");
      expect(probe.report.environment.source).toContain("github.com/embedpdf/embed-pdf-viewer");
    } finally {
      // Nothing written: this case ran with `cache: false` and recorded no lock.
    }
  }, PROVING_CASE_TIMEOUT_MS);
});

describe("#16 proving cases: the two cases the Spec fixes", () => {
  it("covers both, and neither is a synthetic fixture written by this repository", async () => {
    // Both packages resolve out of the example's install, which is the fact that
    // makes these cases end-to-end rather than fixture-based.
    const manifest = JSON.parse(await readFile(join(PROVING_CASES_ROOT, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@embedpdf/pdfium", "es-toolkit"]);

    // Exact versions, never ranges: the evidence is about one published artifact.
    for (const range of Object.values(manifest.dependencies ?? {})) {
      expect(range).toMatch(/^\d+\.\d+\.\d+/);
    }
  }, PROVING_CASE_TIMEOUT_MS);
});
