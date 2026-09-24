#!/usr/bin/env node
/**
 * The deterministic half of the dependency-selection flow (#18).
 *
 * Decision source: GitHub Issue #18 — "Implement: Forguncy React dependency-selection
 * Agent Skill" — https://github.com/Mang-X/forguncy-react-workspace/issues/18
 *
 * Governing Specs: #16 (the selection protocol and the Skill/scripts split this
 * command surface implements), #8 (the lock `record`/`status` read and write), #17
 * (the probe engine `probe` runs), #4 (the ownership gate `audit` consumes).
 *
 * ## Where the line is
 *
 * #16 splits the flow into semantic reasoning — which the Agent owns — and
 * deterministic work: *"package inspection, builds, artifact scan, size calculation,
 * deterministic browser checks, lock updates"*. This script is that second half and
 * nothing else. It cannot choose a strategy, cannot pick a replacement package, and
 * cannot classify ownership, because `PROBE_ENGINE_NON_RESPONSIBILITIES` and
 * `SELECTION_STAGES`' `authority` fields place all three on the Agent side.
 *
 * The command names say so: `probe` measures, `audit` checks a decision the Agent
 * already formed, `record` persists it, `status` reads back whether it still holds.
 * There is deliberately no command that takes a capability and returns a strategy —
 * a script that could do that would have replaced the reasoning the Spec requires
 * with a lookup, which is the adapter registry #16 exists to avoid.
 *
 * ## Why it reads the workspace source instead of restating the policy
 *
 * Every rule this script enforces is imported from `packages/core` and
 * `packages/dependency-resolver` through `./workspace-loader.mjs`, so the ownership
 * boundary, the probe protocol, the evidence profiles and the freshness rules have
 * exactly one definition — the one the compiler acts on. A JavaScript copy here
 * would be a second source of truth that drifts silently.
 *
 * ## Commands
 *
 * - `policy`  — the selection surface as JSON: stages and their authority, the two
 *   branches, the signals by family, the acceptance criteria and where each is
 *   enforced. The Agent's grounding, and what the evals assert against.
 * - `probe`   — run the deterministic probe for one installed package. Emits
 *   `facts` / `risks` / `validation` / `environment` / `assessment`, and never a
 *   strategy.
 * - `audit`   — check a decision file against the ownership gate, the probe it owes
 *   and #8's evidence profile. Prints problems; decides nothing.
 * - `record`  — audit a decision file, then write it into `fgc.lock.json`. Refuses
 *   a decision the audit rejects, so an unrecordable decision cannot be persisted.
 * - `status`  — read the lock back and report each record's freshness.
 *
 * `--json` on any command prints machine-readable output (the default for `policy`,
 * `probe` and `status`).
 */

import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Registering the loader before the workspace packages are imported is what makes
// them resolvable at all — see the file's own header for why that matters.
register(new URL("./workspace-loader.mjs", import.meta.url).href);

const core = await import("@forguncy-react-workspace/core");
const resolver = await import("@forguncy-react-workspace/dependency-resolver");

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { json: command === "policy" || command === "probe" || command === "status", positionals: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options.positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (name === "json" || name === "no-cache") {
      options[name === "json" ? "json" : "noCache"] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? rest[++index];
    options[name] = value;
  }
  return { command, options };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * Resolves a path argument against the caller's working directory.
 *
 * The script must be runnable from anywhere (`node .agents/skills/…/scripts/…`),
 * so `--project` and the decision file are resolved from `process.cwd()` rather
 * than from the skill directory.
 */
function fromWorkingDirectory(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

async function readJson(path, label) {
  const absolute = fromWorkingDirectory(path);
  let text;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    fail(`Cannot read the ${label} at "${absolute}": ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`The ${label} at "${absolute}" is not valid JSON: ${error.message}`);
  }
}

/**
 * Objects are always JSON: every payload here is evidence a reviewer re-checks, and
 * a "helpful" one-line rendering of a probe report would be a second, lossier
 * representation of the thing the tool exists to produce.
 */
function print(value, _options) {
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// policy — the selection surface, read from the modules that define it
// ---------------------------------------------------------------------------

/**
 * Everything the Agent has to ground on, emitted from the policy modules rather
 * than transcribed into the Skill's prose.
 *
 * The point is not convenience. `SKILL.md` may summarise the flow, but a summary
 * cannot be asserted against; this can, and the eval suite does — so a change to
 * the ownership gate, the stage order or an acceptance criterion's enforcement
 * point fails a test instead of leaving the Skill teaching the previous rule.
 */
async function policySurface() {
  const toolchain = (await resolver.probeLockEnvironment(REPOSITORY_ROOT)).toolchain;
  return {
    governingSpecReferenceLine: core.SELECTION_GOVERNING_SPEC_REFERENCE_LINE,
    ownershipInvariant: core.APPLICATION_OWNERSHIP_INVARIANT,
    ownershipGateIsFirst: core.isOwnershipGateFirst(),
    stages: core.SELECTION_STAGES.map((stage) => ({
      id: stage.id,
      label: stage.label,
      authority: stage.authority,
      produces: stage.produces,
      mustNot: stage.mustNot,
    })),
    branches: core.SELECTION_BRANCHES.map((branch) => ({
      id: branch.id,
      label: branch.label,
      enteredWhen: branch.enteredWhen,
      stages: branch.stages,
      skipsCandidateWork: branch.skipsCandidateWork,
      formsDecisionAt: branch.formsDecisionAt,
      decisionKind: branch.decisionKind,
    })),
    stagesSkippedOnEarlyExit: core.stagesSkippedOnEarlyExit(),
    conditionalStages: core.CONDITIONAL_SELECTION_STAGES.map((entry) => ({ ...entry })),
    strategies: core.DEPENDENCY_STRATEGIES.map((strategy) => {
      const semantics = core.DEPENDENCY_STRATEGY_SEMANTICS[strategy];
      return {
        strategy,
        isDefaultForCompatibleLibraries: semantics.isDefaultForCompatibleLibraries,
        requiresJustification: semantics.requiresJustification,
        requiresVerifiedHostCapability: semantics.requiresVerifiedHostCapability,
        realRuntimeRequired: semantics.realRuntimeRequired,
        selectedWhen: semantics.selectedWhen,
        requirements: semantics.requirements,
        effect: semantics.effect,
      };
    }),
    signalFamilySemantics: core.SELECTION_SIGNAL_FAMILY_SEMANTICS,
    signals: core.SELECTION_SIGNALS.map((signal) => ({
      id: signal.id,
      family: signal.family,
      label: signal.label,
      observedFrom: signal.observedFrom,
      observedByProbeSteps: core.probeStepsObserving(signal.id),
    })),
    replacementRejections: core.REPLACEMENT_SIGNAL_REJECTIONS.map((entry) => ({ ...entry })),
    repairRecipeConditions: core.REPAIR_RECIPE_CONDITIONS.map((condition) => ({ ...condition })),
    noAdapterRegistryInvariant: core.NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT,
    probeSteps: core.PROBE_STEP_IDS,
    probeDeploymentRequiredSteps: core.PROBE_DEPLOYMENT_REQUIRED_STEPS,
    probeAssessmentStatuses: core.PROBE_ASSESSMENT_STATUSES,
    applicationOwnedRoles: core.APPLICATION_OWNED_ROLES,
    cellLocalRoles: ["cell-local-ui", "cell-local-state", "cell-local-data-access"],
    platformConflictRules: core.PLATFORM_CONFLICT_RULES.map((rule) => ({
      id: rule.id,
      code: rule.code,
      concern: rule.concern,
      owner: rule.owner,
      packages: rule.packages,
      allowedCellLocalRoles: rule.allowedCellLocalRoles,
      guidance: rule.guidance,
    })),
    evidencePolicy: core.LOCK_EVIDENCE_POLICY,
    evidenceKinds: core.DECISION_EVIDENCE_KINDS,
    provingCases: core.SPEC_PROVING_CASES.map((entry) => ({ ...entry })),
    acceptanceCriteria: core.SELECTION_ACCEPTANCE_CRITERIA.map((entry) => ({ ...entry })),
    target: core.forguncyTargetIdentity(),
    toolchain,
  };
}

// ---------------------------------------------------------------------------
// probe — measurement only
// ---------------------------------------------------------------------------

function evaluateOwnership(packageName, role) {
  return core.assessDependencyRole({ packageName, role });
}

/**
 * Runs the probe, turning the engine's one identity failure into a message a caller
 * can act on.
 *
 * `ProbeIdentityError` means the package is not installed where the probe looked — a
 * `--project` that does not declare it, or a typo — and the engine is right to refuse
 * rather than describe a phantom. Letting it escape as a stack trace would bury the
 * fix (name the right project) under frames from inside the engine, which is exactly
 * the shape of failure the rest of this script exists to avoid.
 */
async function runProbe(options, packageName) {
  const projectRoot = fromWorkingDirectory(options.project ?? ".");
  try {
    const result = await resolver.runDependencyProbe({
      projectRoot,
      packageName,
      cache: options.noCache === true ? false : undefined,
    });
    return { projectRoot, result };
  } catch (error) {
    if (error instanceof resolver.ProbeIdentityError) {
      fail(
        `Cannot probe "${packageName}": it is not installed in "${projectRoot}". Point --project at a directory that declares it — a probe describes an installed artifact, not a package name. ` +
          `\`examples/probe-proving-cases\` declares es-toolkit and @embedpdf/pdfium.`,
      );
    }
    throw error;
  }
}

/**
 * The probe command's payload.
 *
 * The four sections #17 requires are kept apart — `facts` are deterministic
 * observations, `risks` are derived technical warnings, `validation` says which
 * steps actually ran, `environment` names the versions measured — and the
 * assessment is reported beside them rather than folding them into a verdict. A
 * strategy is deliberately absent: #16 puts that choice on the Agent.
 */
function probePayload({ projectRoot, result }) {
  const { report, assessment, fingerprint, lockStatus, fromCache, cacheRelativePath } = result;
  return {
    command: "probe",
    projectRoot,
    packageName: report.environment.packageName,
    resolvedVersion: report.environment.packageVersion,
    facts: report.facts,
    risks: report.risks,
    rejectionFindings: report.rejectionFindings,
    validation: report.validation,
    environment: report.environment,
    assessment,
    lockStatus,
    fingerprint,
    fromCache,
    cacheRelativePath,
    // Stated in the output so a consumer cannot read the payload as a decision.
    decides: "nothing: `facts`, `risks` and `validation` are measurements; the strategy is the Agent's call (#16).",
  };
}

// ---------------------------------------------------------------------------
// audit / record — a decision the Agent formed, checked and persisted
// ---------------------------------------------------------------------------

/**
 * The decision file an Agent hands to `audit` and `record`.
 *
 * Deliberately explicit about the two things the script is not allowed to infer:
 * `role` (the ownership question is #4's, and answering it here would be the
 * script classifying ownership) and the strategy itself.
 *
 *   {
 *     "packageName": "es-toolkit",
 *     "role": "cell-local-ui",
 *     "strategy": "inline",
 *     "rationale": "…",              // required for extension / replace
 *     "alternatives": ["…"],         // required for a technical replace
 *     "globalName": "React",         // host
 *     "libraryId": "…",              // extension
 *     "extensionVersion": "…",       // extension
 *     "rejection": { … }             // replace; omitted for an architectural
 *                                    // rejection, which uses the assessment's own
 *   }
 */
function decisionFromFile(document) {
  const { packageName, role, strategy } = document;
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail('The decision file must name the package: { "packageName": "…" }.');
  }
  if (typeof role !== "string" || role.length === 0) {
    fail(`The decision file for "${packageName}" must state the role it is requested for, e.g. { "role": "cell-local-ui" }. Ownership is assessed per (capability, package) pair, and the script must not infer it.`);
  }
  if (!core.DEPENDENCY_STRATEGIES.includes(strategy)) {
    fail(`The decision file for "${packageName}" must state one of ${core.DEPENDENCY_STRATEGIES.join(", ")} as its "strategy"; received ${JSON.stringify(strategy)}. The script never chooses it.`);
  }

  const ownership = evaluateOwnership(packageName, role);
  const architectural = core.isPlatformConflict(ownership);

  // On the Forguncy-owned branch the gate forms the rejection from its own
  // assessment, so a hand-written one is refused rather than merged — the same
  // rule `auditSelectionDecision` applies, enforced here so the file cannot smuggle
  // a different code past it.
  if (architectural && document.rejection !== undefined) {
    fail(
      `The decision file for "${packageName}" supplies a rejection, but "${packageName}" is Forguncy-owned ("${ownership.rejection.code}"). The ownership assessment is the rejection; drop the field and the gate's own code is recorded.`,
    );
  }
  if (!architectural && document.rejection !== undefined && document.rejection.kind === "architectural") {
    fail(
      `The decision file for "${packageName}" records an architectural rejection, but the #4 assessment for role "${role}" did not find the capability Forguncy-owned. An architectural rejection is an ownership answer, and the ownership answer disagrees.`,
    );
  }

  const rejection = architectural ? ownership.rejection : document.rejection;

  // A technical rejection is the Agent's finding to state, because it names *which*
  // observation disqualified the candidate — `auditSelectionDecision` refuses a code
  // the probe's own findings do not map to, so supplying the wrong one is caught
  // rather than accepted. Omitting it entirely would leave the decision with no
  // `rejection` at all, which is what `lockEvidenceProfileForDecision` reads.
  if (strategy === "replace" && !architectural && document.rejection === undefined) {
    fail(
      `The decision file for "${packageName}" uses strategy "replace" but states no "rejection". A technical rejection has to name the finding that disqualified the candidate; the codes the probe can produce are ${[...new Set(core.REPLACEMENT_SIGNAL_REJECTIONS.map((entry) => entry.code))].sort().join(", ")}.`,
    );
  }

  const decision = {
    packageName,
    strategy,
    ...(strategy === "host" ? { globalName: document.globalName } : {}),
    ...(strategy === "extension" ? { libraryId: document.libraryId, globalName: document.globalName } : {}),
    ...(strategy === "replace" ? { rejection, ...(document.alternatives === undefined ? {} : { alternatives: document.alternatives }), ...(document.supersededBy === undefined ? {} : { supersededBy: document.supersededBy }) } : {}),
  };

  return { decision, ownership, architectural, document };
}

/**
 * Runs the probe a decision owes, or `null` when it owes none.
 *
 * #8's `architectural-rejection` profile has `probeRequirement: "none"` — its
 * evidence is the ownership decision — so probing there would be the ownership-first
 * gate running backwards. Every other decision is probed, and `cache: false` is
 * honoured when asked so a stale cache entry cannot stand in for a measurement this
 * run did not make.
 */
async function probeForDecision(entry, options) {
  if (entry.architectural) {
    return { probe: null, probeResult: null };
  }
  const { projectRoot, result } = await runProbe(options, entry.decision.packageName);
  return { probe: result.report, probeResult: { ...result, projectRoot } };
}

/**
 * The runtime a record may claim it was validated against, or `null`.
 *
 * Two different fields carry the word "target" and conflating them is the exact
 * mistake AGENTS.md rule 7 exists to stop:
 *
 * - `ProbeEnvironment.target` is the Forguncy contract a probe was *measured
 *   against* — the engine defaults it to #5's verified identity, so it is non-null
 *   even for a purely static local run.
 * - `LockRecordMetadata.target` is the runtime the evidence was *validated in*.
 *   #8: it is "the runtime claim", and its presence is what makes
 *   `assessLockDecision` report `validated` rather than `not-validated`.
 *
 * Copying the first into the second is how a green local build becomes a runtime
 * compatibility claim nobody made. So the record's target is null unless the
 * decision file says a real page confirmed it, and even then only on evidence: the
 * file has to cite a `runtime-observation`, and the probe's `runtime-smoke` step has
 * to have actually passed. A skipped smoke step is not a confirmation, and
 * `runtime-smoke` is skipped whenever no hook was supplied — which is the normal
 * local case.
 */
function runtimeTargetFor(document, probe) {
  const claimed = document.validatedAgainstRuntime === true;
  const observation = (document.evidence ?? []).some((link) => link.kind === "runtime-observation");

  if (!claimed) {
    return { target: null, validation: "not-validated: probed locally; no real Forguncy page confirmed it." };
  }

  if (!observation) {
    fail(
      `The decision file for "${document.packageName}" claims validatedAgainstRuntime but cites no "runtime-observation" evidence. A runtime claim has to name the observation it rests on (#8).`,
    );
  }

  const smoke = probe?.validation.find((entry) => entry.step === "runtime-smoke");
  if (smoke?.outcome !== "passed") {
    fail(
      `The decision file for "${document.packageName}" claims validatedAgainstRuntime, but the probe's runtime-smoke step is "${smoke?.outcome ?? "absent"}". Run the probe with a real runtime-smoke hook before claiming a target; a skipped smoke step is not a confirmation.`,
    );
  }

  return { target: core.forguncyTargetIdentity(), validation: "validated: the probe's runtime-smoke step passed for this target." };
}

function auditPayload(entry, probe, problems) {
  return {
    command: "audit",
    packageName: entry.decision.packageName,
    role: entry.ownership.role,
    strategy: entry.decision.strategy,
    ownership: entry.ownership,
    branch: core.branchForOwnership(entry.ownership).id,
    evidenceProfile: core.lockEvidenceProfileForDecision(entry.decision),
    recordable: problems.length === 0,
    problems,
  };
}

async function commandAudit(options) {
  const path = options.decision ?? options.positionals[0];
  if (path === undefined) {
    fail("audit needs a decision file: `audit --decision <path>`. See the decision-file shape in this script's header.");
  }
  const entry = decisionFromFile(await readJson(path, "decision file"));
  const { probe } = await probeForDecision(entry, options);
  const problems = core.auditSelectionDecision({ decision: entry.decision, probe, ownership: entry.ownership });
  const payload = auditPayload(entry, probe, problems);
  print(payload, { ...options, json: options.json === true });
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * Records a decision, after the same audit `audit` runs.
 *
 * The script's whole reason for existing on the write side: an unrecordable decision
 * has to be *refused*, not written. `writeFgcLock` would refuse it anyway, but the
 * refusal would come back as a lock-format error rather than as the selection problem
 * it is, and a caller would have to work out which rule it broke.
 */
async function commandRecord(options) {
  const path = options.decision ?? options.positionals[0];
  if (path === undefined) {
    fail("record needs a decision file: `record --decision <path>`.");
  }
  const entry = decisionFromFile(await readJson(path, "decision file"));
  const { probe, probeResult } = await probeForDecision(entry, options);
  const problems = core.auditSelectionDecision({ decision: entry.decision, probe, ownership: entry.ownership });

  if (problems.length > 0) {
    print({ ...auditPayload(entry, probe, problems), command: "record", recorded: false }, { ...options, json: true });
    process.stderr.write(`Refused to record "${entry.decision.packageName}": the decision audit found ${problems.length} problem(s). Nothing was written.\n`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = probeResult?.projectRoot ?? fromWorkingDirectory(options.project ?? ".");
  const evidence = [];

  // An architectural rejection owes no probe evidence, so its record cites the
  // ownership decision instead — which is what #8's profile names for it. Every
  // other decision cites the probe it rests on, by the portable cache path.
  if (probeResult !== null) {
    evidence.push({ kind: "probe", reference: resolver.probeCacheRelativePath(probeResult.fingerprint) });
  }
  for (const link of entry.document.evidence ?? []) {
    if (!core.DECISION_EVIDENCE_KINDS.includes(link.kind)) {
      fail(`The decision file cites evidence of kind "${link.kind}"; the allowed kinds are ${core.DECISION_EVIDENCE_KINDS.join(", ")}.`);
    }
    evidence.push({ kind: link.kind, reference: link.reference });
  }
  // The Spec the decision was reached under, always cited: a later reader has to be
  // able to re-derive the rule the decision was made by.
  evidence.push({
    kind: "spec-issue",
    reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/16",
  });

  // Rule 5 of #8: an architectural conflict comes *from* #4, so the record has to be
  // traceable to the ownership decision rather than to a bundle experiment. This link
  // is provenance the flow already knows rather than a decision, so it is added here
  // instead of being demanded from the Agent's file — the reference is read out of
  // `core`, so a moved Issue cannot leave a stale URL in a record.
  if (entry.decision.strategy === "replace" && entry.decision.rejection.kind === "architectural") {
    evidence.push({ kind: "spec-issue", reference: core.OWNERSHIP_AND_DEPENDENCY_DECISION.url });
  }

  const lockEvidence = probeResult === null
    ? { status: core.ARCHITECTURAL_REJECTION_PROBE_STATUS, fingerprint: null, versionIndependent: false }
    : resolver.probeRunLockEvidence(probeResult);

  if (lockEvidence === null) {
    print(
      { command: "record", packageName: entry.decision.packageName, recorded: false, problems: ["The probe reached no conclusion, so no lock status can claim its outcome."] },
      { ...options, json: true },
    );
    process.stderr.write(`Refused to record "${entry.decision.packageName}": the probe was inconclusive. Nothing was written.\n`);
    process.exitCode = 1;
    return;
  }

  const runtime = runtimeTargetFor(entry.document, probe);

  const update = {
    decision: entry.decision,
    probe: lockEvidence,
    cellTarget: entry.document.cellTarget ?? null,
    // Rule 4 of #8: a `replace` record keeps no dependency for the compiled cell, so
    // recording a resolved version there would imply the package is still installed for
    // it. The version that was rejected goes in `rejectedCandidate` instead — see below.
    resolvedVersion: entry.decision.strategy === "replace" ? null : (probe?.environment.packageVersion ?? null),
    // Null for a local probe — see `runtimeTargetFor`. The probe's own
    // `environment.target` is the contract it was measured against, not a runtime
    // this evidence was validated in, and reporting one as the other is what makes a
    // green local build read as Forguncy compatibility.
    target: runtime.target,
    probedWith: probe?.environment.toolchain ?? null,
    evidence,
    ...(entry.document.rationale === undefined ? {} : { rationale: entry.document.rationale }),
    ...(entry.decision.strategy === "extension"
      ? {
          extension: {
            version: entry.document.extensionVersion ?? null,
            identity: entry.document.extensionIdentity ?? null,
          },
        }
      : {}),
    ...(entry.decision.strategy === "replace" && entry.decision.rejection.kind === "technical" && probe !== null
      ? { rejectedCandidate: { version: probe.environment.packageVersion } }
      : {}),
  };

  let recorded;
  try {
    recorded = await resolver.recordDependencyDecision(projectRoot, update);
  } catch (error) {
    // `writeFgcLock` validates the whole canonical document on the way out, and it
    // knows rules this audit does not restate — #8's rationale requirement is the one
    // that bites a `replace` decision whose file omitted it. Reporting the validator's
    // own problems is what keeps the refusal actionable: a stack trace here would make
    // a rule the caller can satisfy look like a crash.
    const problems = Array.isArray(error?.problems) ? error.problems : [error.message];
    print({ command: "record", packageName: entry.decision.packageName, recorded: false, problems }, { ...options, json: true });
    process.stderr.write(
      `Refused to record "${entry.decision.packageName}": the lock rejected the record for ${problems.length} reason(s) this audit does not cover. Nothing was written.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const environment = await resolver.probeLockEnvironment(projectRoot, {
    lock: recorded.lock,
    probeFingerprints: probeResult === null ? {} : { [entry.decision.packageName]: probeResult.fingerprint },
  });
  const assessment = core.assessLockDecision(recorded.record, environment);

  print(
    {
      command: "record",
      recorded: true,
      replaced: recorded.replaced,
      lockPath: resolver.fgcLockPath(projectRoot),
      record: recorded.record,
      freshness: assessment,
      runtimeValidation: runtime.validation,
    },
    { ...options, json: true },
  );
}

// ---------------------------------------------------------------------------
// status — read back, and say whether the record still holds
// ---------------------------------------------------------------------------

async function commandStatus(options) {
  const projectRoot = fromWorkingDirectory(options.project ?? ".");
  const lock = await resolver.readFgcLock(projectRoot);

  if (lock.decisions.length === 0) {
    print({ command: "status", projectRoot, lockPath: resolver.fgcLockPath(projectRoot), decisions: [] }, options);
    return;
  }

  const fingerprints = {};
  for (const record of lock.decisions) {
    if (record.probe.status === "not-run" || record.probe.fingerprint === null) {
      continue;
    }
    try {
      const rebuilt = await resolver.runDependencyProbe({
        projectRoot,
        packageName: record.packageName,
        cache: undefined,
      });
      fingerprints[record.packageName] = rebuilt.fingerprint;
    } catch {
      // A package that can no longer be probed stays out of the environment map, so
      // the record reports `probe-fingerprint-unknown` — stale rather than silently
      // fresh. Rebuilding the fingerprint from a phantom would be worse.
    }
  }

  const environment = await resolver.probeLockEnvironment(projectRoot, {
    lock,
    probeFingerprints: fingerprints,
  });

  const decisions = lock.decisions.map((record) => {
    const assessment = core.assessLockDecision(record, environment);
    return {
      packageName: record.packageName,
      strategy: record.strategy,
      cellTarget: record.cellTarget,
      resolvedVersion: record.resolvedVersion,
      profile: assessment.profile,
      freshness: assessment.freshness,
      stalenessReasons: assessment.stalenessReasons,
      realRuntimeValidation: assessment.realRuntimeValidation,
      // `lockDecisionBlockers` reads the assessment, not the record: it is the
      // assessment plus the runtime question, and re-deriving it from the record
      // here would be a second copy of a rule core already states.
      blockers: core.lockDecisionBlockers(assessment),
    };
  });

  print(
    {
      command: "status",
      projectRoot,
      lockPath: resolver.fgcLockPath(projectRoot),
      schemaVersion: lock.schemaVersion,
      decisions,
    },
    options,
  );

  if (decisions.some((entry) => entry.freshness === "stale")) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage: select_dependency.mjs <command> [options]

Commands:
  policy                          Print the selection surface as JSON (stages, branches,
                                  signals, criteria, evidence policy, target).
  probe   --project <dir> <name>  Run the deterministic probe for one installed package.
  audit   --decision <file>       Check a decision file; print problems. Decides nothing.
  record  --decision <file>       Audit a decision file, then write fgc.lock.json.
  status  --project <dir>         Read the lock back and report each record's freshness.

Options:
  --project <dir>   Project root holding the package (default: current directory).
  --decision <file> The Agent-formed decision JSON. See this script's header for its shape.
  --no-cache        Force a fresh probe instead of reusing .fgc/probe-cache/.
  --json            Machine-readable output (default for policy, probe and status).

The script measures, audits and persists. It never chooses a strategy, never picks a
replacement package and never classifies ownership — #16 puts all three on the Agent.
`;

const { command, options } = parseArguments(process.argv.slice(2));

switch (command) {
  case "policy":
    print(await policySurface(), options);
    break;
  case "probe": {
    const packageName = options.positionals[0];
    if (packageName === undefined) {
      fail("probe needs a package name: `probe --project <dir> <packageName>`.");
    }
    print(probePayload(await runProbe(options, packageName)), options);
    break;
  }
  case "audit":
    await commandAudit(options);
    break;
  case "record":
    await commandRecord(options);
    break;
  case "status":
    await commandStatus(options);
    break;
  default:
    process.stderr.write(command === undefined ? USAGE : `Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 2;
}
