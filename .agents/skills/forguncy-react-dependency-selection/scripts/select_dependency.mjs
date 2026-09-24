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
 * - `audit`   — check a decision file against the ownership gate, the probe it owes,
 *   #8's evidence profile and conformance against the verified target. Prints
 *   problems; decides nothing.
 * - `record`  — audit a decision file, then write it into `fgc.lock.json`. Runs the
 *   *same* checks `audit` does and refuses on any of them, so an unrecordable
 *   decision cannot be persisted. `audit` and `record` therefore agree by
 *   construction: a decision one calls ready is one the other writes.
 * - `status`  — read the lock back and report each record's freshness.
 *
 * Two of those checks are the CLI's own contribution rather than the resolver's, and
 * both exist because a strategy is *persisted* here: the conformance audit (a
 * fabricated `extension` `libraryId`, or a `host` global no target provides, is a
 * claim about a source this repository does not own, so nothing downstream could catch
 * it) and the runtime-target guard (`target` means "validated in a real runtime", which
 * only an executed `runtime-smoke` hook can support — a JSON file of results would make
 * it a value the caller types).
 *
 * `--json` on any command prints machine-readable output (the default for `policy`,
 * `probe` and `status`).
 */

import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
/**
 * Loads the caller's `runtime-smoke` hook, or returns `undefined` when none was given.
 *
 * Why the CLI executes a module instead of reading a recorded result: the engine
 * records `runtime-smoke: passed` **only** when a hook actually ran and returned
 * (`recordRuntimeSmoke` in `probe/probe-engine.ts` records `failed` when it throws,
 * and `skipped` when it is absent). So a passing smoke step is evidence that a real
 * check executed. Accepting a JSON file of smoke output instead would make
 * "was this verified?" a value a caller can type, which is precisely what
 * `runtimeTargetFor`'s guard exists to prevent — a claim that can be written down
 * without being performed is not a claim this flow may record.
 *
 * The hook is the caller's own local module, which is the same trust level as the
 * decision file they already hand in: this command already executes nothing on the
 * repository's behalf, and a real runtime check is the one thing #4 marks as
 * necessarily `real-runtime` rather than `local`.
 */
async function loadRuntimeSmokeHook(options) {
  // Keyed as spelled on the command line: `parseArguments` stores the flag name
  // verbatim, so a kebab-case option stays kebab-case here.
  const path = options["runtime-smoke"];
  if (path === undefined) {
    return undefined;
  }

  const absolute = fromWorkingDirectory(path);
  const exportName = options["runtime-smoke-export"] ?? "default";

  let module;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    fail(`Cannot load the --runtime-smoke module at "${absolute}": ${error.message}`);
  }

  const hook = module[exportName];
  if (typeof hook !== "function") {
    const available = Object.keys(module).sort().join(", ") || "(none)";
    fail(
      `The --runtime-smoke module at "${absolute}" has no callable export "${exportName}"; it exports: ${available}. ` +
        `Export the hook as \`default\`, or name it with --runtime-smoke-export.`,
    );
  }
  return hook;
}

async function runProbe(options, packageName) {
  const projectRoot = fromWorkingDirectory(options.project ?? ".");
  const runtimeSmoke = await loadRuntimeSmokeHook(options);

  // `--no-cache` forces the *read* to miss. It must not also discard the measurement,
  // because whatever cites the run cites `.fgc/probe-cache/<hash>.json`, and a lock
  // pointing at a file that was never written is exactly what #8's evidence rule
  // exists to prevent. A write-only view expresses that distinction: the engine sees a
  // cache that never hits, and the report still lands on disk.
  const fileCache = resolver.createFileProbeCache(projectRoot);
  const cache =
    options.noCache === true
      ? { get: async () => null, set: (fingerprint, report) => fileCache.set(fingerprint, report) }
      : fileCache;

  let result;
  try {
    result = await resolver.runDependencyProbe({
      projectRoot,
      packageName,
      cache,
      // Passing the hook is what makes the `runtime-smoke` step run at all; without
      // it the step is `skipped` with a reason, which is the honest local-only record.
      ...(runtimeSmoke === undefined ? {} : { runtimeSmoke }),
    });
  } catch (error) {
    if (error instanceof resolver.ProbeIdentityError) {
      fail(
        `Cannot probe "${packageName}": it is not installed in "${projectRoot}". Point --project at a directory that declares it — a probe describes an installed artifact, not a package name. ` +
          `\`examples/probe-proving-cases\` declares es-toolkit and @embedpdf/pdfium.`,
      );
    }
    // A hook returning a finding shape the protocol refuses surfaces as a throw from
    // inside the engine. That is a caller-input problem, not a crash, so it is reported
    // in this script's own style rather than as a stack trace through the engine — which
    // is the failure shape this script exists to avoid.
    fail(`Probing "${packageName}" failed: ${error.message}`);
  }

  // The engine writes a hookless report itself. It deliberately does not write one that
  // carries runtime-smoke findings, and `--no-cache` bypasses its write as well, so
  // persisting here is what makes a cited `probe` link resolve in every mode. Writing an
  // already-written report is an idempotent overwrite, not a second source of truth.
  await fileCache.set(result.fingerprint, result.report);
  return { projectRoot, result };
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
    // Names the flag rather than only the condition, because "supply a hook" is the
    // one thing the caller has to do and the option is not discoverable from the
    // record. A skipped smoke step is the normal local case, so reaching here without
    // one is expected — and the fix is a single flag, not a different workflow.
    fail(
      `The decision file for "${document.packageName}" claims validatedAgainstRuntime, but the probe's runtime-smoke step is "${smoke?.outcome ?? "absent"}". ` +
        `Pass \`--runtime-smoke <module>\` so a real check runs (\`passed\` is only recorded when a hook actually executed), or drop validatedAgainstRuntime for a local-only decision.`,
    );
  }

  return { target: core.forguncyTargetIdentity(), validation: "validated: the probe's runtime-smoke step passed for this target." };
}

/**
 * The verified extension catalog a conformance audit checks `extension` records against.
 *
 * Defaults to this repository's verified mappings, projected from
 * `EXTENSION_EXTERNAL_MAPPINGS` by name so a moved or added row moves here too —
 * restating the table would be the second source of truth the rest of this script
 * avoids. `--extension-catalog` overrides it with a real
 * `api.app.listFrontendLibraries` listing or a verified catalog artifact, which is
 * what discharges #12's rule that a `libraryId` comes from one of those two sources
 * rather than from a display name someone typed.
 */
async function extensionCatalogFor(options) {
  const override = options["extension-catalog"];
  if (override !== undefined) {
    const document = await readJson(override, "extension catalog");
    const rows = Array.isArray(document) ? document : (document.mappings ?? document.libraries);
    if (!Array.isArray(rows)) {
      fail(
        `The --extension-catalog file at "${fromWorkingDirectory(override)}" must be an array of extensions, or an object with a "mappings" (or "libraries") array. ` +
          `\`api.app.listFrontendLibraries\` returns the listing; only \`id\`, \`name\`/\`globalName\` are read.`,
      );
    }
    // Validated here rather than left to the audit: a catalog whose rows are missing
    // their id would reach `mappings.filter(...)` inside the conformance module and come
    // back as a native TypeError, which reads as a crash in the tool rather than as a
    // problem with the file the caller handed in.
    const mappings = rows.map((row, index) => {
      const entry = {
        packageName: row?.packageName ?? row?.name,
        libraryId: row?.libraryId ?? row?.id,
        globalName: row?.globalName,
      };
      const missing = Object.entries(entry).filter(([, value]) => typeof value !== "string" || value.length === 0);
      if (missing.length > 0) {
        fail(
          `The --extension-catalog file at "${fromWorkingDirectory(override)}" has an incomplete entry at index ${index}: ` +
            `${missing.map(([field]) => field).join(", ")} must be a non-empty string. A row needs the package it maps, the stable \`libraryId\`, and the \`globalName\` the extension publishes.`,
        );
      }
      return entry;
    });
    return { mappings };
  }

  return {
    mappings: core.EXTENSION_EXTERNAL_MAPPINGS.map((mapping) => ({
      packageName: mapping.packageName,
      libraryId: mapping.libraryId,
      globalName: mapping.globalName,
    })),
  };
}

/**
 * The conformance problems a candidate lock has, in the audit's own words.
 *
 * Runs over the **whole** candidate document, not the one record, because the rules
 * are not all per-record: `host-inline-conflict` is a fact about a *pair* of records
 * for the same module, so a per-record check cannot express it. That also mirrors how
 * the compiler consumes the lock — one document at a time.
 *
 * Errors block; warnings do not. A warning is a fact about the *cell* (whether a
 * preset-provided global is on the page depends on the cell's preset chain), which a
 * lock file is the wrong place to hold, so refusing on one would make a supported
 * configuration unwritable.
 */
async function conformanceProblems(lock, options) {
  const extensionCatalog = await extensionCatalogFor(options);
  return resolver.validateLockDecisionConformance(lock, { extensionCatalog });
}

/**
 * Why a decision recorded a runtime target or did not, in the words the report uses.
 *
 * `runtimeTargetFor` decides it once, and this states that same decision for the
 * payload — a caller that re-derived the sentence from the record's fields would
 * eventually describe a different rule than the one enforced.
 */
/**
 * Why a decision recorded a runtime target or did not, in the words the report uses.
 *
 * `runtimeTargetFor` decides it once, and this states that same decision for the
 * payload — a caller that re-derived the sentence from the record's fields would
 * eventually describe a different rule than the one enforced.
 */
function runtimeValidationOf(document, probe) {
  return runtimeTargetFor(document, probe).validation;
}

/**
 * The `audit` command's payload.
 *
 * `recordable` folds in every check the write path applies, which is the whole point of
 * `audit` being the read-only counterpart: a decision the audit calls recordable and the
 * write then refuses would be worse than no audit at all. So it is computed from both
 * sources `record` consults — the selection audit and the conformance gate — rather than
 * from the selection audit alone, which is what let an earlier revision report
 * `recordable: true` beside a non-empty `conformanceProblems` list.
 */
function auditPayload(entry, probe, problems, conformance = []) {
  return {
    command: "audit",
    packageName: entry.decision.packageName,
    role: entry.ownership.role,
    strategy: entry.decision.strategy,
    ownership: entry.ownership,
    branch: core.branchForOwnership(entry.ownership).id,
    evidenceProfile: core.lockEvidenceProfileForDecision(entry.decision),
    recordable: problems.length === 0 && conformance.length === 0,
    problems,
    conformanceProblems: conformance,
  };
}

/**
 * The lock update a decision file produces, given the probe it owes.
 *
 * Shared by `audit` and `record` so the two cannot disagree about what the record
 * would be: `audit` runs this to build the candidate it checks, `record` runs it to
 * build the one it writes. A second construction would let the checked document and
 * the written document differ, which is exactly the gap that let conformance be
 * bypassed before.
 *
 * Returns `null` when the probe reached no conclusion, because then no lock status can
 * claim its outcome — named rather than thrown so the caller reports it in its own
 * command's shape.
 */
async function updateFor(entry, probe, probeResult) {
  const lockEvidence = probeResult === null
    ? { status: core.ARCHITECTURAL_REJECTION_PROBE_STATUS, fingerprint: null, versionIndependent: false }
    : resolver.probeRunLockEvidence(probeResult);

  if (lockEvidence === null) {
    return null;
  }

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

  const runtime = runtimeTargetFor(entry.document, probe);

  return {
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
}

/** The lock a decision file would produce, for a caller that wants to check it first. */
async function candidateLockFor(entry, probe, probeResult, options) {
  const update = await updateFor(entry, probe, probeResult);
  if (update === null) {
    return null;
  }
  const projectRoot = probeResult?.projectRoot ?? fromWorkingDirectory(options.project ?? ".");
  const lock = await resolver.readFgcLock(projectRoot);
  const existing = resolver.findExactLockDecision(lock, {
    packageName: entry.decision.packageName,
    cellTarget: entry.document.cellTarget ?? null,
  });
  return { projectRoot, lock, existing, update, candidate: resolver.upsertLockDecision(lock, resolver.mergeDependencyDecisionUpdate(existing, update)) };
}

async function commandAudit(options) {
  const path = options.decision ?? options.positionals[0];
  if (path === undefined) {
    fail("audit needs a decision file: `audit --decision <path>`. See the decision-file shape in this script's header.");
  }
  const entry = decisionFromFile(await readJson(path, "decision file"));
  const { probe, probeResult } = await probeForDecision(entry, options);
  const problems = core.auditSelectionDecision({ decision: entry.decision, probe, ownership: entry.ownership });

  // The same conformance gate `record` applies, over the lock this decision *would*
  // produce. `audit` is the read-only check, so the two have to reach the same verdict
  // — an audit that passed a decision the write then refused would be worse than no
  // audit, because the caller would have been told it was ready.
  //
  // The conformance problems are folded into `problems` rather than reported beside it,
  // so a consumer that only reads `problems` cannot miss a refusal, and both commands
  // speak one vocabulary. `inconclusive` is folded the same way for the same reason.
  const built = await candidateLockFor(entry, probe, probeResult, options);
  const conformance = built === null ? [] : await conformanceProblems(built.candidate, options);
  const allProblems = built === null
    ? [...problems, "The probe reached no conclusion, so no lock status can claim its outcome."]
    : [...problems, ...conformance];

  print({ ...auditPayload(entry, probe, allProblems, conformance), problems: allProblems }, { ...options, json: true });
  if (allProblems.length > 0) {
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

  // The candidate lock is built by the same helper `audit` uses, so the document
  // checked and the document written cannot differ — a second construction was the gap
  // that let conformance be bypassed in the first place.
  const built = await candidateLockFor(entry, probe, probeResult, options);
  if (built === null) {
    print(
      { command: "record", packageName: entry.decision.packageName, recorded: false, problems: ["The probe reached no conclusion, so no lock status can claim its outcome."] },
      { ...options, json: true },
    );
    process.stderr.write(`Refused to record "${entry.decision.packageName}": the probe was inconclusive. Nothing was written.\n`);
    process.exitCode = 1;
    return;
  }
  const { projectRoot, candidate, existing } = built;

  // The measurement is already persisted by `runProbe`, which is where the `probe`
  // command's `cacheRelativePath` gets the same guarantee — one place, so the two
  // commands cannot disagree about whether a cited report exists.

  // The gate that makes "only when supported by evidence" true at the point a strategy
  // is persisted. #8's lock-shape validation cannot answer "is this record *true*", and
  // for an `extension` decision the answer lives in an extension catalog this
  // repository does not own — without this, a fabricated `libraryId` records happily.
  //
  // Composing the read-modify-write rather than changing `recordDependencyDecision` is
  // deliberate: that helper has its own callers and tests, and giving it a
  // default-blocking audit would change a merged contract and strand every caller that
  // does not hold a catalog. The refusal belongs where the Agent hands the decision in.
  const conformance = await conformanceProblems(candidate, options);
  if (conformance.length > 0) {
    print(
      { command: "record", packageName: entry.decision.packageName, recorded: false, conformanceProblems: conformance },
      { ...options, json: true },
    );
    process.stderr.write(
      `Refused to record "${entry.decision.packageName}": the record does not conform to the verified target for ${conformance.length} reason(s). Nothing was written.\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await resolver.writeFgcLock(projectRoot, candidate);
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

  // Read the written lock back rather than reporting the in-memory candidate, so what is
  // reported is what a later reader will load.
  const written = await resolver.readFgcLock(projectRoot);
  const record = resolver.findExactLockDecision(written, {
    packageName: entry.decision.packageName,
    cellTarget: entry.document.cellTarget ?? null,
  });
  const environment = await resolver.probeLockEnvironment(projectRoot, {
    lock: written,
    probeFingerprints: probeResult === null ? {} : { [entry.decision.packageName]: probeResult.fingerprint },
  });

  print(
    {
      command: "record",
      recorded: true,
      replaced: existing !== null,
      lockPath: resolver.fgcLockPath(projectRoot),
      record,
      freshness: core.assessLockDecision(record, environment),
      runtimeValidation: runtimeValidationOf(entry.document, probe),
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
  --no-cache        Force a fresh probe instead of reusing .fgc/probe-cache/. The
                    measurement is still persisted, so the lock's evidence resolves.
  --runtime-smoke <module>
                    Load a local module and run its export as the probe's
                    runtime-smoke hook. Needed for a decision that claims
                    validatedAgainstRuntime: the step is only \`passed\` when a hook
                    really executed.
  --runtime-smoke-export <name>
                    Which export of that module is the hook (default: \`default\`).
  --extension-catalog <file>
                    Verify \`extension\` records against a real listing or catalog
                    artifact instead of this repository's verified mappings.
  --json            Machine-readable output (default for policy, probe and status).

audit and record run the same checks, including conformance against the verified target;
record refuses to write anything the checks reject.

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
