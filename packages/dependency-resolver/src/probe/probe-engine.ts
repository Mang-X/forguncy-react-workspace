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

import { normalize } from "node:path";

import type {
  ArtifactCompileSnapshot,
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
  assertCellCodeBudget,
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

import { observeArtifact } from "./artifact-scan.ts";
import { observeAssets } from "./asset-inventory.ts";
import { runCandidateBuild } from "./build.ts";
import type { ProbeCache } from "./cache.ts";
import { createFileProbeCache, probeCacheRelativePath } from "./cache.ts";
import { observeExportMetadata } from "./export-metadata.ts";
import { composeProbeFingerprint } from "./fingerprint.ts";
import type { ResolvedPackageIdentity } from "./identity.ts";
import {
  buildProbeEnvironment,
  defaultProbeTarget,
  ProbeIdentityError,
  readToolchainIdentity,
  resolvePackageIdentity,
} from "./identity.ts";
import { observeNodeBuiltins } from "./node-scan.ts";
import { observeRuntimePatterns } from "./runtime-pattern-scan.ts";
import { compareStrings } from "./scan-utils.ts";
import { observeSize } from "./size.ts";
import { resolveInstalledVersions } from "../install-graph.ts";
import { recordedPackageNames } from "../lock-store.ts";

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

/**
 * What the smoke hook is handed: the eight completed steps, **not** a full
 * `ProbeReport`. `runtime-smoke` has not been recorded yet, so this value would
 * correctly fail `validateProbeReport`'s "all nine steps exactly once"
 * invariant — the type says so instead of claiming a complete report a hook
 * could pass to protocol helpers and get a surprising validation failure.
 */
export interface PreSmokeReport {
  readonly schemaVersion: typeof PROBE_REPORT_SCHEMA_VERSION;
  readonly environment: ProbeEnvironment;
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  /** `package-identity` through `size` only; the `runtime-smoke` entry is pending. */
  readonly validation: readonly ProbeValidationEntry[];
}

export type RuntimeSmokeHook = (input: {
  readonly report: PreSmokeReport;
  readonly output: readonly (OutputChunk | OutputAsset)[];
}) => RuntimeSmokeResult | Promise<RuntimeSmokeResult>;

export interface RunDependencyProbeOptions {
  readonly projectRoot: string;
  readonly packageName: string;
  /** Which probe this is; part of the fingerprint. Defaults to the issue's example, `inline-bundle`. */
  readonly probeId?: string;
  /** Entry specifier the synthetic build imports; defaults to the package name. Part of the fingerprint. */
  readonly entry?: string;
  /**
   * Named bindings the synthetic build imports; empty (the default) keeps the whole namespace.
   * Part of the fingerprint.
   *
   * It selects which way the size estimate leans (`size.estimateBias`); it does not make a
   * cap verdict provable, and no cap verdict is filed from this engine's `size` step under
   * any surface. That was the shape of an earlier revision and `size.ts` retracts it with
   * the counterexample.
   *
   * It is the caller's declaration rather than something the engine infers: only the Agent
   * knows which bindings the Cell will import, and the engine may not guess a Cell's import
   * surface (that would be choosing what the Cell does, which is not the probe's decision).
   * See `build.ts` and `size.ts`.
   */
  readonly imports?: readonly string[];
  readonly probeConfig?: Readonly<Record<string, unknown>>;
  readonly bundlerInput?: Readonly<Record<string, string>>;
  /**
   * The project's cell code cap in **characters** of emitted code; `null` (default)
   * means no cap applies to this run. Part of the fingerprint.
   *
   * Characters, not bytes (#77): the same quantity `compileCell`'s
   * `codeBudgetCharacters` caps and the quantity #21's bands classify. This was
   * `cellArtifactBudgetBytes` before #77 and the rename is deliberate — the unit
   * decides which artifact the cap rejects, so a caller that kept the old name and
   * passed a byte count would be refused at the type level rather than silently
   * comparing two different quantities.
   */
  readonly cellArtifactBudgetCharacters?: number | null;
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
  const budgetCharacters = options.cellArtifactBudgetCharacters ?? null;
  // Validated before the fingerprint is composed, not only before the comparison. A
  // non-finite cap would compose a `null` config segment, so `NaN`, `Infinity` and
  // `-Infinity` would share one fingerprint while producing different rejections — and
  // a cache keyed by that fingerprint would then answer a run it does not describe. The
  // guard is `core`'s, the same one `observeSize` and the compiler apply.
  if (budgetCharacters !== null) {
    assertCellCodeBudget(budgetCharacters);
  }
  const target = options.target === undefined ? defaultProbeTarget() : options.target;
  const toolchain = options.toolchain ?? (await readToolchainIdentity(options.projectRoot));

  // Identity failure is the one thing that throws: no artifact means no report.
  const identity = await resolvePackageIdentity(options.projectRoot, options.packageName);
  const environment: ProbeEnvironment = buildProbeEnvironment(identity, toolchain, target);

  const imports = options.imports ?? [];
  const composed = composeProbeFingerprint({
    probeId,
    entry,
    imports,
    probeConfig: options.probeConfig,
    bundlerInput: options.bundlerInput,
    budgetCharacters,
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

  // The candidate build runs **before** the two source scans even though `build` is declared
  // after them in `PROBE_STEPS`. Execution order is free here: `validationInOrder()` sorts by
  // the declared step order and the canonical report sorts facts and risks totally, so moving
  // the build changes nothing a consumer sees.
  //
  // It has to run first because both source scans are bounded by what the build actually
  // included. Reachability is not bundling — rolldown drops a module whose bindings are unused,
  // and it can drop it *before* resolving what the module imports or calls — so a scan over the
  // full reachable set reports findings from files the artifact does not contain. Measured on
  // `const x = () => import("./w.js")` where `w.js` needs `node:fs`: the bundler built cleanly
  // while the report rejected the package. That is the false-rejection class #16 exists to
  // remove, so the bound is not optional for either scan.
  const build = await runCandidateBuild({
    projectRoot: options.projectRoot,
    packageName: identity.packageName,
    entry,
    imports,
  });

  const buildFailed = build.outcome === "failed";
  // No artifact means no set to bound by, so the scans run unbounded and report what they see;
  // the build step's own failure is the actionable evidence in that case.
  const bundledFiles = buildFailed ? undefined : bundledSourceFiles(build.output);

  const nodeScan = await observeNodeBuiltins(options.projectRoot, identity, bundledFiles);
  steps.addFacts(nodeScan.facts);
  steps.addRisks(nodeScan.risks);
  steps.addRejections(nodeScan.rejectionFindings);
  steps.record(nodeScan.validation);

  steps.addFacts(build.facts);
  steps.record(build.validation);

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
  //
  // Bounded by what the build actually included when there is a build, because reachability is
  // not bundling: rolldown tree-shakes a module with unused bindings while the walk still
  // reaches it, and a risk drawn from a shaken-out file describes an artifact that does not
  // exist. Measured on an unused named import with `new Worker(` inside it.
  const runtimePatterns = await observeRuntimePatterns(
    identity,
    bundledFiles,
  );
  steps.addFacts(runtimePatterns.facts);
  steps.addRisks(runtimePatterns.risks);
  steps.addRejections(runtimePatterns.rejectionFindings);
  steps.record(runtimePatterns.validation);

  // The declared surface picks which way the estimate leans, and nothing more: a named build
  // pulls in only those bindings so the number probably understates, a namespace build keeps
  // everything reachable so it probably overstates. Neither is a bound — the probe's build and
  // the compiler's resolve `host`/`extension` dependencies differently, so the artifact can be
  // larger than the Cell (`size.ts` has the counterexample) — and `observeSize` files no
  // rejection, so the leaning selects between two estimates and never authorizes a verdict.
  // Derived from the surface the caller declared, never guessed here.
  const size = observeSize(build.output, budgetCharacters, imports.length > 0 ? "lower-leaning" : "upper-leaning");
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

/**
 * The files the build actually included, as **absolute** paths, for bounding the source scans.
 *
 * Read from the emitted chunks' `modules` map, which is the bundler's own record of what it
 * kept — the same authority `artifact-scan` reads for its facts, rather than a second
 * interpretation of the build.
 *
 * Absolute rather than package-relative, because the bound has to answer the question for
 * **every** graph member, not only the probed package: a transitive dependency is bundled (or
 * dropped) by the same build, and its files live under its own directory. A package-relative
 * set could only be compared against the probed package, which left a dependency's findings
 * unbounded — measured on a shaken-out `dep-lib` whose `process.dlopen` still produced a
 * rejection, the false-rejection class this bound exists to remove, one level of graph
 * indirection out.
 */
function bundledSourceFiles(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
): ReadonlySet<string> {
  const ids = (output ?? [])
    .filter((item): item is OutputChunk => item.type === "chunk")
    .flatMap(item => Object.keys(item.modules ?? {}));

  const files = new Set<string>();
  for (const id of ids) {
    // A virtual module id (` rolldown/runtime.js`) is not a file on disk.
    if (id.startsWith(" ")) {
      continue;
    }
    files.add(normalize(id));
  }
  return files;
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
  /**
   * Current compile identities by **record identity** (`packageName\u0000cellTarget`), for
   * `artifact-rejection` records. Defaults to `{}` for the same fail-closed reason as
   * `probeFingerprints`: a missing entry reports `artifact-compile-unknown` (stale) rather than
   * passing.
   *
   * Keyed by record rather than by Cell, because which Cell state a rejection was measured from is
   * a property of the record — two rejections in one Cell can come from different states.
   */
  readonly artifactFingerprints?: Readonly<Record<string, ArtifactCompileSnapshot>>;
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
    // Carried through rather than defaulted away: an environment built here is how a caller hands
    // the freshness axis the compile identity it just measured, so dropping it would make every
    // `artifact-rejection` report `artifact-compile-unknown` no matter what the caller knew.
    artifactFingerprints: options.artifactFingerprints ?? {},
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
