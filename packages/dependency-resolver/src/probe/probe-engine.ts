/**
 * The probe engine: nine steps, one `ProbeReport`, one fingerprint.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (the protocol — steps, sections, the reports/does-not-decide
 * boundary, the observing-step table this engine must satisfy), #8 (the lock the
 * fingerprint and `lockStatus` feed; `probeLockEnvironment` and
 * `probeRunLockEvidence` are this engine's half of that integration), #5 (the
 * default target), #4 (the engine never classifies ownership, never picks a
 * replacement and never picks a strategy — `PROBE_ENGINE_NON_RESPONSIBILITIES`).
 *
 * Orchestration rules the shape of this module enforces:
 *
 * - **Every step appears exactly once** in `validation`, in `PROBE_STEPS` order,
 *   each `passed`, `failed` with non-empty portable diagnostics, or `skipped` with
 *   a reason — `validateProbeReport` refuses anything else, and the engine runs
 *   that validation on its own output before returning, so a protocol violation is
 *   an engine bug that surfaces here, not in a consumer.
 * - **A failed `build` cascades honestly**: `artifact-scan`, `asset-inventory` and
 *   `size` have no artifact and record `skipped` with a reason pointing at the
 *   build's diagnostics; `runtime-pattern-scan` still runs (it reads source, not
 *   output) because the package's requirements do not depend on bundling
 *   succeeding. A skip carries no findings, so no step invents observations about
 *   an artifact that was never produced.
 * - **`runtime-smoke` is `skipped` unless a hook is supplied.** #16 asks for a
 *   runtime result "where needed"; without a browser in this toolchain the honest
 *   record is a skip with a reason, and `assessProbeReport` already treats a
 *   report whose static steps passed as `supports-deployment` — `runtime-smoke`
 *   is deliberately not a deployment-required step. A hook that *throws* fails the
 *   step with the error message as diagnostics: an attempted runtime check that
 *   blew up is evidence, not a skip.
 * - **Determinism before caching.** The report is canonicalized and validated,
 *   the fingerprint composed from declared inputs (no version, target or
 *   toolchain — see `fingerprint.ts`), and only then consulted against the cache.
 *   `fromCache: true` means an identical report was already stored under this
 *   fingerprint; it never means "close enough". A hook-bearing report is never
 *   written: smoke mode is not in the fingerprint, so storing one would let a
 *   later hookless run inherit runtime evidence it did not request.
 *
 * The engine throws only for identity failure (`ProbeIdentityError`): a probe of
 * something that is not installed has no artifact to describe, and reporting
 * nine steps about a phantom would be worse than refusing to start. Everything a
 * *candidate* can do wrong — fail to build, exceed budget, reach Node builtins —
 * is a report outcome, because that is the evidence #16 exists to produce.
 */

import type {
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockEnvironment,
  LockProbeEvidence,
  ProbeAssessment,
  ProbeEnvironment,
  ProbeFact,
  ProbeRejectionFinding,
  ProbeReport,
  ProbeRisk,
  ProbeStatus,
  ProbeStepId,
  ProbeValidationEntry,
  ToolchainIdentity,
} from "@forguncy-react-workspace/core";
import {
  assessProbeReport,
  assertProbeReport,
  canonicalizeProbeReport,
  lockProbeStatusForAssessment,
  matchesForguncyTargetIdentity,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_STEP_IDS,
  probeStepOrder,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";

import type { OutputAsset, OutputChunk } from "rolldown";

import { observeArtifact } from "./artifact-scan";
import { observeAssets } from "./asset-inventory";
import { runCandidateBuild } from "./build";
import type { ProbeCache } from "./cache";
import { createFileProbeCache, probeCacheRelativePath } from "./cache";
import { observeExportMetadata } from "./export-metadata";
import { composeProbeFingerprint } from "./fingerprint";
import type { ResolvedPackageIdentity } from "./identity";
import {
  buildProbeEnvironment,
  defaultProbeTarget,
  ProbeIdentityError,
  readToolchainIdentity,
  resolvePackageIdentity,
} from "./identity";
import { observeNodeBuiltins } from "./node-scan";
import { observeRuntimePatterns } from "./runtime-pattern-scan";
import { compareStrings } from "./scan-utils";
import { observeSize } from "./size";
import { resolveInstalledVersions } from "../install-graph";
import { recordedPackageNames } from "../lock-store";

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

/**
 * What a caller-supplied `runtime-smoke` hook must return.
 *
 * Findings the hook files are re-stamped to `runtime-smoke`, so the hook states
 * observations without having to attribute them itself — and cannot mis-attribute
 * them to a static step it never ran. Signals only `runtime-smoke` observes
 * (`portal-to-document-body`, `webgl-canvas-lifecycle`,
 * `global-singleton-assumption`, `service-worker-or-special-header-requirement`,
 * `host-module-identity-mismatch-observed`, `global-namespace-collision-observed`)
 * are the hook's vocabulary; the last three are `target-runtime-observation`
 * findings and require `environment.target`, which this engine defaults to the
 * verified contract (#5).
 */
export interface RuntimeSmokeResult {
  readonly facts?: readonly Omit<ProbeFact, "step">[];
  readonly risks?: readonly Omit<ProbeRisk, "step">[];
  readonly rejectionFindings?: readonly Omit<ProbeRejectionFinding, "step">[];
}

export type RuntimeSmokeHook = (input: {
  readonly report: ProbeReport;
  readonly output: readonly (OutputChunk | OutputAsset)[];
}) => RuntimeSmokeResult | Promise<RuntimeSmokeResult>;

export interface RunDependencyProbeOptions {
  readonly projectRoot: string;
  readonly packageName: string;
  /** Which probe this is; part of the fingerprint. Defaults to the issue's example, `inline-bundle`. */
  readonly probeId?: string;
  /** Entry specifier the synthetic build imports; defaults to the package name. Part of the fingerprint. */
  readonly entry?: string;
  readonly probeConfig?: Readonly<Record<string, unknown>>;
  readonly bundlerInput?: Readonly<Record<string, string>>;
  /** Cell code budget in bytes; null (default) means no budget applies to this run. Part of the fingerprint. */
  readonly cellArtifactBudgetBytes?: number | null;
  /** Defaults to the verified runtime contract (#5). Null records a run with no target named. */
  readonly target?: ForguncyTargetIdentity | null;
  /** Defaults to reading `vite-plus` from the workspace manifest. */
  readonly toolchain?: ToolchainIdentity;
  /** When supplied, runs as the `runtime-smoke` step; when absent, that step is skipped with a reason. */
  readonly runtimeSmoke?: RuntimeSmokeHook;
  /** File cache under `.fgc/probe-cache/` (default), or `false` to force a fresh run. */
  readonly cache?: ProbeCache | false;
}

export interface DependencyProbeResult {
  readonly report: ProbeReport;
  readonly fingerprint: string;
  readonly assessment: ProbeAssessment;
  /** #8's statuses via `lockProbeStatusForAssessment`; null when inconclusive (no status can claim it). */
  readonly lockStatus: ProbeStatus | null;
  readonly fromCache: boolean;
  /** Portable path lock evidence can cite as a `probe` link: `.fgc/probe-cache/<sha256>.json`. */
  readonly cacheRelativePath: string;
}

// ---------------------------------------------------------------------------
// Step bookkeeping
// ---------------------------------------------------------------------------

class StepBook {
  readonly facts: ProbeFact[] = [];
  readonly risks: ProbeRisk[] = [];
  readonly rejectionFindings: ProbeRejectionFinding[] = [];
  private readonly validation = new Map<ProbeStepId, ProbeValidationEntry>();

  addFacts(facts: readonly ProbeFact[]): void {
    this.facts.push(...facts);
  }

  /**
   * Dedupe by signal across steps: the earliest observing step keeps the
   * finding, so a marker seen in both the artifact and the source scan is filed
   * once — by `artifact-scan`, which observes it first in `PROBE_STEPS` order.
   */
  addRisks(risks: readonly ProbeRisk[]): void {
    for (const risk of risks) {
      if (this.risks.some(existing => existing.signal === risk.signal)) {
        continue;
      }
      this.risks.push(risk);
    }
  }

  addRejections(findings: readonly ProbeRejectionFinding[]): void {
    for (const finding of findings) {
      if (this.rejectionFindings.some(existing => existing.signal === finding.signal)) {
        continue;
      }
      this.rejectionFindings.push(finding);
    }
  }

  record(entry: ProbeValidationEntry): void {
    this.validation.set(entry.step, entry);
  }

  skip(step: ProbeStepId, detail: string): void {
    this.validation.set(step, { step, outcome: "skipped", detail, diagnostics: [] });
  }

  /** Canonical order: `PROBE_STEPS` order, exactly once per recorded step. */
  validationInOrder(): ProbeValidationEntry[] {
    return PROBE_STEP_IDS.flatMap(step => {
      const entry = this.validation.get(step);
      return entry === undefined ? [] : [entry];
    }).sort((a, b) => probeStepOrder(a.step) - probeStepOrder(b.step));
  }
}

function identityValidation(identity: ResolvedPackageIdentity): ProbeValidationEntry {
  return {
    step: "package-identity",
    outcome: "passed",
    detail: `Resolved "${identity.packageName}@${identity.packageVersion}" from the install graph${
      identity.license !== null ? ` (license ${identity.license})` : ""
    }.`,
    diagnostics: [],
  };
}

function smokeSkipReason(hookPresent: boolean, failedEarlier: boolean): string {
  if (failedEarlier) {
    return "A deployment-required step failed before runtime validation was meaningful; that step's diagnostics are the evidence for this run.";
  }
  if (hookPresent) {
    return "The runtime-smoke hook was supplied but produced no artifact to exercise.";
  }
  return "No runtime-smoke hook was supplied for this run; #16 asks for a runtime result where needed, and this toolchain ran the static steps only.";
}

/**
 * Whether a cached report may answer *this* run.
 *
 * The lock fingerprint deliberately excludes package version, toolchain and
 * target (#8 tracks those staleness dimensions separately), so the cache cannot
 * inherit that exclusion: a hit under the same fingerprint still has to describe
 * the artifact and environment now in front of the engine. `entry` is part of
 * the fingerprint but is overridable, so two packages can share one fingerprint
 * — the cached environment must still name *this* package before it answers.
 *
 * Smoke mode is checked in both directions: a supplied hook always re-probes
 * (the cached report may never have collected runtime evidence), and a hookless
 * run only accepts a cached report whose `runtime-smoke` is `skipped` — a
 * hook-bearing report would otherwise leak runtime facts/risks/rejections into
 * a run that explicitly did not perform runtime smoke.
 */
function cacheHitAnswersThisRun(
  cached: ProbeReport,
  identity: ResolvedPackageIdentity,
  toolchain: ToolchainIdentity,
  target: ForguncyTargetIdentity | null,
  runtimeSmokeRequested: boolean,
): boolean {
  if (runtimeSmokeRequested) {
    return false;
  }
  if (cached.environment.packageName !== identity.packageName) {
    return false;
  }
  if (cached.environment.packageVersion !== identity.packageVersion) {
    return false;
  }
  if (cached.environment.toolchain.vitePlus !== toolchain.vitePlus) {
    return false;
  }
  const cachedSmoke = cached.validation.find(entry => entry.step === "runtime-smoke");
  if (cachedSmoke?.outcome !== "skipped") {
    return false;
  }
  const cachedTarget = cached.environment.target;
  if (target === null || cachedTarget === null) {
    return cachedTarget === target;
  }
  return matchesForguncyTargetIdentity(cachedTarget, target);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function runDependencyProbe(options: RunDependencyProbeOptions): Promise<DependencyProbeResult> {
  const probeId = options.probeId ?? "inline-bundle";
  const entry = options.entry ?? options.packageName;
  const budget = options.cellArtifactBudgetBytes ?? null;
  const target = options.target === undefined ? defaultProbeTarget() : options.target;
  const toolchain = options.toolchain ?? (await readToolchainIdentity(options.projectRoot));

  // Identity failure is the one thing that throws: no artifact means no report.
  const identity = await resolvePackageIdentity(options.projectRoot, options.packageName);
  const environment: ProbeEnvironment = buildProbeEnvironment(identity, toolchain, target);

  const composed = composeProbeFingerprint({
    probeId,
    entry,
    probeConfig: options.probeConfig,
    bundlerInput: options.bundlerInput,
    budget,
  });
  const fingerprint = composed.fingerprint;
  const cache = options.cache === false ? null : (options.cache ?? createFileProbeCache(options.projectRoot));

  if (cache !== null) {
    const cachedReport = await cache.get(fingerprint);
    // Package identity, version, toolchain, target and smoke mode are
    // deliberately *not* in the lock fingerprint (see `fingerprint.ts` — #8
    // tracks those dimensions on the record), so a hit under one fingerprint is
    // only trusted when the stored report still describes this artifact, this
    // environment and this run mode. Otherwise an upgrade, a different package
    // sharing an overridden `entry`, a toolchain bump, a different target or a
    // smoke-mode change would be answered with yesterday's evidence.
    if (
      cachedReport !== null &&
      cacheHitAnswersThisRun(cachedReport, identity, toolchain, target, options.runtimeSmoke !== undefined)
    ) {
      const assessment = assessProbeReport(cachedReport);
      return {
        report: cachedReport,
        fingerprint,
        assessment,
        lockStatus: lockProbeStatusForAssessment(assessment),
        fromCache: true,
        cacheRelativePath: probeCacheRelativePath(fingerprint),
      };
    }
  }

  const steps = new StepBook();
  steps.record(identityValidation(identity));

  const exportMetadata = observeExportMetadata(identity);
  steps.addFacts(exportMetadata.facts);
  steps.addRisks(exportMetadata.risks);
  steps.addRejections(exportMetadata.rejectionFindings);
  steps.record(exportMetadata.validation);

  const nodeScan = await observeNodeBuiltins(options.projectRoot, identity);
  steps.addFacts(nodeScan.facts);
  steps.addRisks(nodeScan.risks);
  steps.addRejections(nodeScan.rejectionFindings);
  steps.record(nodeScan.validation);

  const build = await runCandidateBuild({
    projectRoot: options.projectRoot,
    packageName: identity.packageName,
    entry,
  });
  steps.addFacts(build.facts);
  steps.record(build.validation);

  const buildFailed = build.outcome === "failed";

  const artifact = observeArtifact(build.output, options.projectRoot);
  steps.addFacts(artifact.facts);
  steps.addRisks(artifact.risks);
  steps.addRejections(artifact.rejectionFindings);
  steps.record(artifact.validation);

  const assets = observeAssets(build.output, options.projectRoot);
  steps.addFacts(assets.facts);
  steps.addRisks(assets.risks);
  steps.addRejections(assets.rejectionFindings);
  steps.record(assets.validation);

  // Source, not output: still meaningful when the build failed, which is why
  // this step does not cascade into a skip.
  const runtimePatterns = await observeRuntimePatterns(identity.directory);
  steps.addFacts(runtimePatterns.facts);
  steps.addRisks(runtimePatterns.risks);
  steps.addRejections(runtimePatterns.rejectionFindings);
  steps.record(runtimePatterns.validation);

  const size = observeSize(build.output, budget);
  steps.addFacts(size.facts);
  steps.addRisks(size.risks);
  steps.addRejections(size.rejectionFindings);
  steps.record(size.validation);

  await recordRuntimeSmoke(steps, options, build.output, environment, buildFailed);

  const report: ProbeReport = {
    schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
    environment,
    facts: steps.facts,
    risks: steps.risks,
    rejectionFindings: steps.rejectionFindings,
    validation: steps.validationInOrder(),
  };

  const canonical = canonicalizeProbeReport(report);
  // The engine's own gate: a report that violates the protocol is a bug in the
  // steps above, and surfacing it here keeps every consumer on the valid path.
  assertProbeReport(canonical);

  // Smoke mode is not in the fingerprint, so a hook-bearing report must not be
  // written under the shared key — a later hookless run would otherwise inherit
  // runtime facts/risks/rejections it never requested. Hookless reports (whose
  // `runtime-smoke` is always `skipped`) are the only cacheable shape.
  if (cache !== null && options.runtimeSmoke === undefined) {
    await cache.set(fingerprint, canonical);
  }

  const assessment = assessProbeReport(canonical);

  return {
    report: canonical,
    fingerprint,
    assessment,
    lockStatus: lockProbeStatusForAssessment(assessment),
    fromCache: false,
    cacheRelativePath: probeCacheRelativePath(fingerprint),
  };
}

async function recordRuntimeSmoke(
  steps: StepBook,
  options: RunDependencyProbeOptions,
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  environment: ProbeEnvironment,
  buildFailed: boolean,
): Promise<void> {
  const hook = options.runtimeSmoke;

  if (output === undefined || output.length === 0) {
    steps.skip("runtime-smoke", smokeSkipReason(hook !== undefined, true));
    return;
  }

  if (hook === undefined) {
    steps.skip("runtime-smoke", smokeSkipReason(false, buildFailed));
    return;
  }

  let partial: RuntimeSmokeResult;
  try {
    partial = await hook({
      report: {
        schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
        environment,
        facts: steps.facts,
        risks: steps.risks,
        rejectionFindings: steps.rejectionFindings,
        validation: steps.validationInOrder(),
      },
      output,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.record({
      step: "runtime-smoke",
      outcome: "failed",
      detail: "The runtime-smoke hook threw; the attempt itself is the evidence for this run.",
      diagnostics: message
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0),
    });
    return;
  }

  // Re-stamp every finding to `runtime-smoke`: the hook observed at runtime and
  // cannot attribute findings to static steps it did not run.
  steps.addFacts((partial.facts ?? []).map(fact => ({ ...fact, step: "runtime-smoke" as const })));
  steps.addRisks((partial.risks ?? []).map(risk => ({ ...risk, step: "runtime-smoke" as const })));
  steps.addRejections(
    (partial.rejectionFindings ?? []).map(finding => ({ ...finding, step: "runtime-smoke" as const })),
  );
  steps.record({
    step: "runtime-smoke",
    outcome: "passed",
    detail: `The runtime-smoke hook executed and returned ${String((partial.facts ?? []).length)} fact(s), ${String(
      (partial.risks ?? []).length,
    )} risk(s), ${String((partial.rejectionFindings ?? []).length)} rejection finding(s).`,
    diagnostics: [],
  });
}

// ---------------------------------------------------------------------------
// Lock integration (#8)
// ---------------------------------------------------------------------------

export interface ProbeLockEnvironmentOptions {
  /** Defaults to the verified runtime contract (#5). Omit for null (target unknown). */
  readonly target?: typeof RUNTIME_CONTRACT_TARGET | null;
  /** Defaults to reading `vite-plus` from the workspace manifest; pass null for "unknown". */
  readonly toolchain?: ToolchainIdentity | null;
  /**
   * Current fingerprints by package name. Defaults to `{}` — fail-closed: a
   * missing entry makes a recorded fingerprint report
   * `probe-fingerprint-unknown` (stale) rather than silently passing, which is
   * #8's answer when the environment cannot say what the probe would produce now.
   */
  readonly probeFingerprints?: Readonly<Record<string, string>>;
  readonly extensionVersions?: Readonly<Record<string, string>>;
  readonly extensionIdentities?: Readonly<Record<string, string>>;
  readonly lock?: FgcLockDocument;
}

/**
 * The `LockEnvironment` a probe flow hands `assessLockDecision`.
 *
 * `resolvedVersions` comes from the same install graph the type is defined
 * against — unioned with every fingerprint key, so a package asked about by
 * fingerprint alone still gets a version answer (or an honest
 * `package-version-unknown`) instead of being invisible to the map.
 */
export async function probeLockEnvironment(
  projectRoot: string,
  options: ProbeLockEnvironmentOptions = {},
): Promise<LockEnvironment> {
  const toolchain = options.toolchain === undefined ? await readToolchainIdentity(projectRoot) : options.toolchain;
  const target = "target" in options ? (options.target ?? null) : RUNTIME_CONTRACT_TARGET;
  const probeFingerprints = options.probeFingerprints ?? {};

  const packageNames = new Set<string>(Object.keys(probeFingerprints));
  if (options.lock !== undefined) {
    for (const name of recordedPackageNames(options.lock)) {
      packageNames.add(name);
    }
  }
  const { versions } = await resolveInstalledVersions(projectRoot, [...packageNames].sort(compareStrings));

  return {
    resolvedVersions: versions,
    target,
    toolchain,
    probeFingerprints,
    extensionVersions: options.extensionVersions ?? {},
    extensionIdentities: options.extensionIdentities ?? {},
  };
}

/**
 * The `LockProbeEvidence` a completed run records, or null when the assessment
 * is inconclusive (no probe status can claim an outcome the report does not
 * support — #8's audit refuses an inconclusive report for exactly that reason).
 *
 * `versionIndependent: false` always: nothing in this engine's steps has been
 * *shown* version-independent, and #8 rule 2 requires an explicit demonstration
 * before the flag may be set — assuming it would defeat the staleness rule the
 * field exists to express.
 */
export function probeRunLockEvidence(
  result: Pick<DependencyProbeResult, "fingerprint" | "lockStatus">,
): LockProbeEvidence | null {
  if (result.lockStatus === null) {
    return null;
  }
  return {
    status: result.lockStatus,
    fingerprint: result.fingerprint,
    versionIndependent: false,
  };
}

export { ProbeIdentityError };
export type { ResolvedPackageIdentity };
