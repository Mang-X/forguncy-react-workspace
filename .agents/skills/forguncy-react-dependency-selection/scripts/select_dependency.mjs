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
 * ## Where evidence lives, and why it is not the engine's cache
 *
 * Every probed report is persisted to `fgc-evidence/<content-hash>.json` — beside the lock it
 * belongs to, not under `.fgc/` — and that path, not the engine's
 * `.fgc/probe-cache/<fingerprint>.json`, is what a lock cites.
 *
 * The two addresses answer different questions and must not be confused. The cache is
 * keyed by the probe's declared inputs, and smoke mode is deliberately not one of them, so
 * a hook-bearing and a hookless report for the same package share a cache key. The engine
 * therefore refuses to cache a hook-bearing report at all. Writing one there instead looks
 * safe — the read side refuses to *serve* it — but a cache entry can be **overwritten**: a
 * later hookless run misses, re-probes, and stores its own report at the same path,
 * replacing the `runtime-smoke: passed` result a `validated` record cites while the record
 * keeps its non-null `target`. No read-side guard can prevent a write-side collision, which
 * is what an earlier revision of this script missed.
 *
 * A content address has neither problem: identical bytes reuse one path, different bytes
 * cannot collide, and the cited artifact is pinned to exactly what was measured.
 *
 * `--json` on any command prints machine-readable output (the default for `policy`,
 * `probe` and `status`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * The flags that take no value.
 *
 * `--json` is accepted on every command although only `policy` / `probe` / `status`
 * default to it, because a caller piping another command's output has no way to know
 * which commands already emit JSON.
 */
const BOOLEAN_OPTIONS = new Set(["json", "no-cache"]);

/**
 * Options that are meaningless without a value.
 *
 * Listed rather than inferred, because getting one wrong is a fail-*open*: a flag that
 * silently became `undefined` is indistinguishable from a flag that was never passed, and
 * every reader of these options treats absence as "use the default". `--extension-catalog`
 * is the one that bites — a caller who meant to verify against a real listing but dropped
 * the filename would get the shipped catalog instead and be told nothing.
 */
const VALUE_OPTIONS = new Set(["project", "decision", "runtime-smoke", "runtime-smoke-export", "extension-catalog"]);

/**
 * Parses `argv`, refusing anything it does not recognise.
 *
 * The recognised names are a whitelist rather than a fallback, because a typo in a
 * *verification* flag is the same failure as an omitted one and reaches the same place: a
 * misspelled `--extension-catalog` used to be stored as a key nobody reads, leaving the real
 * option `undefined`, so the command fell back to the shipped catalog and could report
 * success for a decision a real listing would have refused. Rejecting the whole invocation is
 * the only answer that cannot be mistaken for a pass — a silently ignored flag turns "I
 * verified against the project's listing" into "I verified against the default", with no
 * observable difference in the output.
 */
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

    if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) {
      const known = [...BOOLEAN_OPTIONS, ...VALUE_OPTIONS].sort().map(option => `--${option}`).join(", ");
      fail(`Unknown option "--${name}". Known options: ${known}.`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      options[name === "json" ? "json" : "noCache"] = inline === undefined ? true : inline !== "false";
      continue;
    }

    // A missing value is a usage error rather than an absent option. `--x --y` and a
    // trailing `--x` both mean the caller forgot the argument; consuming the next flag as
    // a value, or recording `undefined`, would turn either into a silent fallback. An empty
    // value (`--project=`) counts as missing for the same reason: it resolves to the current
    // directory, which is a default the caller did not ask for.
    const next = inline ?? rest[index + 1];
    if (inline === "") {
      fail(`--${name} needs a value (\`--${name} <value>\`); an empty value was given.`);
    }
    if (next === undefined || (inline === undefined && next.startsWith("--"))) {
      fail(`--${name} needs a value (\`--${name} <value>\`); none was given.`);
    }
    if (inline !== undefined) {
      options[name] = inline;
    } else {
      options[name] = rest[++index];
    }
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
    // The verified extension catalog the CLI checks `extension` decisions against,
    // emitted in the shape it is actually used so the expansion is inspectable instead
    // of only observable through a record attempt. A row covering several module ids
    // (`@tanstack/query-core` riding on the `@tanstack/react-query` row) appears once per
    // id, which is what makes "the projection does not drop `moduleIds`" checkable here.
    extensionCatalog: {
      source: "core EXTENSION_EXTERNAL_MAPPINGS",
      mappings: catalogEntriesFor(core.EXTENSION_EXTERNAL_MAPPINGS),
      declaredRows: core.EXTENSION_EXTERNAL_MAPPINGS.map((mapping) => ({
        packageName: mapping.packageName,
        moduleIds: mapping.moduleIds ?? [],
        libraryId: mapping.libraryId,
        globalName: mapping.globalName,
        metadataSource: mapping.metadataSource,
        metadataReference: mapping.metadataReference,
      })),
    },
    extensionListingContract: {
      source: "api.app.listFrontendLibraries",
      fields: ["id", "name", "globalName", "exists", "typeDefinitionAvailable"],
      note: "`name` is a display name and is never read as an npm package; a raw listing is checked against the declared rows above via auditExtensionLibraryMetadata rather than turned into mappings.",
    },
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

/**
 * Where probe evidence lives, relative to the project root, and why it is not `.fgc/`.
 *
 * Two independent requirements pick this location:
 *
 * 1. **It must not be shared with the cache by address.** Keyed by the report's *content*,
 *    not its fingerprint. The engine's cache is keyed by fingerprint — the probe's declared
 *    inputs — and deliberately leaves smoke mode out of it, so a hook-bearing and a hookless
 *    report for the same package share a cache key. Writing one there looks safe because the
 *    read side refuses to serve it, but a cache entry can also be **overwritten**: a later
 *    hookless run misses, re-probes, and stores its own report at the same path — silently
 *    replacing the `runtime-smoke: passed` result a `validated` record cites, while the record
 *    keeps its non-null `target`. Read-side guards cannot fix a write-side collision. A content
 *    address has neither problem: identical bytes reuse one path, different bytes cannot collide.
 *
 * 2. **It must be committable, and `.fgc/` is not.** `fgc.lock.json` is meant to be reviewed
 *    and committed, and the repository ignores `.fgc/` wholesale. Evidence stored there
 *    therefore cannot survive a fresh checkout: the lock keeps `probe.status: passed` and a
 *    non-null `target`, its citation resolves to nothing, and nothing in the reader notices —
 *    `assessLockDecision` recomputes freshness from versions and fingerprints and never looks
 *    at whether the cited bytes exist. That gap is worst for a runtime claim, because a static
 *    probe can be re-measured anywhere while a `runtime-smoke` result may not be reproducible
 *    on a reviewer's machine at all — which is exactly the case durable evidence is for.
 *
 * So evidence is a sibling of the lock it belongs to, and `status` treats a citation that does
 * not resolve as a blocker rather than as a fresh record.
 */
const EVIDENCE_DIRECTORY = "fgc-evidence";

/**
 * The content-addressed evidence reference form: `fgc-evidence/<64 hex>.json`.
 *
 * Matched rather than assumed, because only this form claims integrity. A lock is free to
 * cite an ordinary committed path (the repository's own fixture cites `docs/probes/*.md`),
 * and re-hashing one of those against its name would be meaningless — the name says nothing
 * about the bytes. For a content address the name *is* the claim, so it is checkable.
 */
const EVIDENCE_REFERENCE_PATTERN = new RegExp(`^${EVIDENCE_DIRECTORY}/([0-9a-f]{64})\\.json$`);

function evidenceRelativePath(report) {
  const digest = createHash("sha256").update(core.serializeProbeReport(report), "utf8").digest("hex");
  return `${EVIDENCE_DIRECTORY}/${digest}.json`;
}

/**
 * Writes a report as evidence and returns the portable path to cite.
 *
 * A failed write is fatal rather than best-effort, unlike the engine's cache: the lock is
 * about to cite this path, and a citation nothing can follow is the defect this exists to
 * prevent.
 *
 * An existing file is only acceptable when it holds **these** bytes. The earlier revision
 * treated `EEXIST` as proof of that, on the reasoning that the name is a function of the
 * content — which is true of the name and false of whatever is sitting there. A committed
 * evidence file that a merge resolved badly, a hand-edit, or a directory at that path would
 * all satisfy `EEXIST` while not being the report at all. So the existing bytes are re-hashed
 * and compared, and a mismatch is refused rather than silently cited.
 */
async function persistEvidence(projectRoot, report) {
  const relative = evidenceRelativePath(report);
  const absolute = join(projectRoot, ...relative.split("/"));
  const expected = core.serializeProbeReport(report);

  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, expected, { encoding: "utf8", flag: "wx" });
    return { relative, created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail(`Cannot persist probe evidence at "${absolute}": ${error.message}`);
    }
  }

  // The path is taken. It has to be this content or the citation is a lie — including the
  // case where the path is a directory, which `readFile` refuses and which would otherwise
  // count as "present".
  let existing;
  try {
    existing = await readFile(absolute, "utf8");
  } catch (error) {
    fail(
      `The evidence path "${relative}" already exists but cannot be read as a file (${error.code ?? error.message}). ` +
        `Remove it so the run can write the report it measured.`,
    );
  }
  if (existing !== expected) {
    fail(
      `The evidence path "${relative}" already exists with different content, so it is not the report this run measured. ` +
        `A content-addressed path is only trustworthy while its bytes hash to its name; remove the file to re-measure, or treat the difference as the finding it is.`,
    );
  }
  return { relative, created: false };
}

/**
 * Whether a cited evidence reference resolves against the project root, and whether a
 * content-addressed one still hashes to its own name.
 *
 * Three answers rather than a boolean, because "not there" and "there but wrong" are
 * different findings with different fixes: the first means the evidence never travelled with
 * the lock, the second means what travelled is not what was measured.
 *
 * Only repository-relative references are checked. A URL — the form the repository's own
 * committed lock fixture uses for its runtime observations — is a claim about somewhere this
 * command cannot reach, and reporting it as "missing" would be a claim of its own.
 */
function inspectEvidenceReference(projectRoot, reference) {
  if (!core.isRepositoryRelativeReference(reference)) {
    return "ok";
  }
  const absolute = join(projectRoot, ...reference.trim().split(/[\\/]/));

  // A plain committed path: its existence is all this command can check.
  const contentAddressed = EVIDENCE_REFERENCE_PATTERN.exec(reference.trim());
  if (contentAddressed === null) {
    return existsSync(absolute) ? "ok" : "missing";
  }

  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch {
    // Absent, a directory, or unreadable. For a citation, "I cannot read the bytes you cited"
    // is the same finding as "they are not here".
    return "missing";
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return digest === contentAddressed[1] ? "ok" : "integrity-mismatch";
}

/**
 * Measures a package. **Persists nothing.**
 *
 * Measurement and persistence are separated deliberately, because they belong to different
 * outcomes: a probe is a read that may end in a decision nobody accepts, while writing
 * evidence changes a working tree. The earlier revision persisted here, inside the only
 * probe entry point, which meant `audit` — documented as the read-only counterpart — created
 * committable files, and a `record` refused by the selection or conformance audit left an
 * orphan behind under a message saying nothing had been written.
 *
 * So this returns the report and the path it *would* be cited at, and
 * {@link commitEvidence} is called only once a decision has been accepted.
 */
async function runProbe(options, packageName) {
  const projectRoot = fromWorkingDirectory(options.project ?? ".");
  const runtimeSmoke = await loadRuntimeSmokeHook(options);

  let result;
  try {
    result = await resolver.runDependencyProbe({
      projectRoot,
      packageName,
      // `false` means "do not consult a cached report", which is all `--no-cache` claims.
      cache: options.noCache === true ? false : undefined,
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

  // Where this report would be cited, without writing anything. `probe` reports it so a
  // caller can see the address before deciding; `record` commits it after the decision is
  // accepted.
  return { projectRoot, result, evidencePath: evidenceRelativePath(result.report) };
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
function probePayload({ projectRoot, result, evidencePath }) {
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
    // What a lock would cite: the immutable evidence artifact this run wrote. Reported
    // instead of the engine's `cacheRelativePath`, which is a *cache* entry — it can be
    // evicted by any other run under the same fingerprint, so it is not what evidence
    // should point at.
    evidencePath,
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
  const { projectRoot, result, evidencePath } = await runProbe(options, entry.decision.packageName);
  return { probe: result.report, probeResult: { ...result, projectRoot, evidencePath } };
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
 * One extension mapping as the conformance audit reads it, expanded over the module ids
 * it covers.
 *
 * `[packageName, ...moduleIds]` because #12 lets one extension stand in for more than
 * one npm package — `@tanstack/query-core` rides on the `@tanstack/react-query` row
 * because the vendor package re-exports it. The shipped row expresses that with
 * `moduleIds`, but a conformance mapping is a single package→extension pair, so a
 * projection that kept only `packageName` would report a legitimate
 * `@tanstack/query-core` decision as `extension-library-not-verified`. Reading the
 * expansion from `extensionModuleIds`-style logic here rather than hard-coding it keeps
 * a row that gains a module id from needing a second edit.
 */
function catalogEntriesFor(mappings) {
  return mappings.flatMap(mapping =>
    [mapping.packageName, ...(mapping.moduleIds ?? [])].map(packageName => ({
      packageName,
      libraryId: mapping.libraryId,
      globalName: mapping.globalName,
    })),
  );
}

/**
 * The verified extension catalog a conformance audit checks `extension` records against.
 *
 * Defaults to this repository's verified mappings, expanded from
 * `EXTENSION_EXTERNAL_MAPPINGS` so a moved or added row moves here too — restating the
 * table would be the second source of truth the rest of this script avoids.
 *
 * `--extension-catalog` accepts either of the two sources #12 names, and they are
 * handled differently on purpose:
 *
 * - **A verified mapping catalog** (`{ packageName, libraryId, globalName }` rows, the
 *   same shape the compiler's tests supply) is used directly. It already states which
 *   npm package each row answers for.
 * - **A raw `api.app.listFrontendLibraries` listing** does *not*, and reading its `name`
 *   as one would fabricate a mapping: the listing's real shape is
 *   `id` / `name` / `globalName` / `exists` / `typeDefinitionAvailable`, where `name` is
 *   a display name — `"TanStack Query for ReactCellType"` is not an npm package, and a
 *   catalog built from it can never match `@tanstack/react-query`. So a listing is used
 *   for what it can actually establish: this repository's declared rows for the packages
 *   the lock decides are checked against it through `auditExtensionLibraryMetadata`,
 *   which is #12's own id/global/bundle/types audit. The packages come from the shipped
 *   table because that is the only place the package→extension relation is recorded; the
 *   listing confirms the identity, it does not invent the mapping.
 *
 * Returns refusal problems separately from the catalog so the caller reports them in the
 * same channel as every other refusal — `audit` and `record` have to agree, and a
 * verification failure is a refusal, not a crash.
 */
async function extensionCatalogFor(options, lock) {
  const override = options["extension-catalog"];
  if (override === undefined) {
    return { extensionCatalog: { mappings: catalogEntriesFor(core.EXTENSION_EXTERNAL_MAPPINGS) }, problems: [] };
  }

  const at = fromWorkingDirectory(override);
  const document = await readJson(override, "extension catalog");
  const rows = Array.isArray(document) ? document : (document.mappings ?? document.libraries);
  if (!Array.isArray(rows)) {
    fail(
      `The --extension-catalog file at "${at}" must be an array, or an object with a "mappings" (or "libraries") array. ` +
        `Pass a verified mapping catalog (\`packageName\`/\`libraryId\`/\`globalName\` rows) or the raw \`api.app.listFrontendLibraries\` listing (\`id\`/\`name\`/\`globalName\`).`,
    );
  }

  // Rows that name the npm package they answer for are a mapping catalog; rows that only
  // carry a platform `id` are a listing. The distinction is the presence of the package
  // field, because that is exactly the fact a listing does not have.
  const mappingRows = rows.filter(row => typeof row?.packageName === "string");
  if (mappingRows.length === rows.length) {
    // Validated here rather than left to the audit: an incomplete row would reach
    // `mappings.filter(...)` inside the conformance module and come back as a native
    // TypeError, which reads as a crash in the tool rather than as a problem with the
    // file the caller handed in.
    const mappings = rows.map((row, index) => {
      const entry = { packageName: row?.packageName, libraryId: row?.libraryId, globalName: row?.globalName };
      const missing = Object.entries(entry).filter(([, value]) => typeof value !== "string" || value.length === 0);
      if (missing.length > 0) {
        fail(
          `The --extension-catalog file at "${at}" has an incomplete entry at index ${index}: ` +
            `${missing.map(([field]) => field).join(", ")} must be a non-empty string. A mapping row needs the package it maps, the stable \`libraryId\`, and the \`globalName\` the extension publishes.`,
        );
      }
      return entry;
    });
    return { extensionCatalog: { mappings }, problems: [] };
  }

  if (mappingRows.length > 0) {
    fail(
      `The --extension-catalog file at "${at}" mixes mapping rows (with \`packageName\`) and listing rows (without). Pass one or the other: a listing or a verified mapping catalog.`,
    );
  }

  const listings = rows.map((row, index) => {
    if (typeof row?.id !== "string" || row.id.length === 0 || typeof row?.globalName !== "string" || row.globalName.length === 0) {
      fail(
        `The --extension-catalog file at "${at}" has an entry at index ${index} without a usable \`id\` and \`globalName\`. ` +
          `A raw listing row needs the stable \`id\` and the \`globalName\` the extension publishes; \`name\` is a display name and is never read as a package.`,
      );
    }
    return {
      id: row.id,
      globalName: row.globalName,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof row.exists === "boolean" ? { exists: row.exists } : {}),
      ...(typeof row.typeDefinitionAvailable === "boolean" ? { typeDefinitionAvailable: row.typeDefinitionAvailable } : {}),
    };
  });

  // Only the rows the lock actually decides are audited: a listing is one project's
  // designer state, and holding it to every row of the shipped table would report a
  // finding for each extension this project legitimately does not use.
  const decided = new Set(
    lock.decisions.filter(decision => decision.strategy === "extension").map(decision => decision.packageName),
  );
  const relevant = core.EXTENSION_EXTERNAL_MAPPINGS.filter(
    mapping => decided.has(mapping.packageName) || (mapping.moduleIds ?? []).some(id => decided.has(id)),
  );

  // `auditExtensionLibraryMetadata` is #12's own audit of a mapping against real metadata:
  // stable id, published global, bundle presence, type definitions. Reused rather than
  // re-derived so the CLI and the compiler cannot disagree about what "verified" means.
  const diagnostics = core.auditExtensionLibraryMetadata(listings, { mappings: relevant });
  if (diagnostics.length > 0) {
    return {
      extensionCatalog: { mappings: [] },
      // Formatted like `validateLockDecisionConformance`'s problems so every refusal this
      // command prints reads the same way.
      problems: diagnostics.map(diagnostic => `${diagnostic.subject}: [${diagnostic.code}] ${diagnostic.detail}`),
    };
  }

  const unverifiable = [...decided].filter(
    packageName => !relevant.some(mapping => mapping.packageName === packageName || (mapping.moduleIds ?? []).includes(packageName)),
  );
  if (unverifiable.length > 0) {
    // A listing confirms identities; it cannot establish which npm package an extension
    // provides, and that relation lives in the shipped table. Saying so here is better
    // than letting the conformance audit report the same package as merely "not
    // verified" — the caller needs to know the *listing* was the wrong input for this.
    return {
      extensionCatalog: { mappings: [] },
      problems: unverifiable.map(
        packageName =>
          `${packageName}: [extension-mapping-not-declared] A raw listing cannot establish that an extension provides "${packageName}": only a declared mapping records which npm package an extension answers for, and this repository declares none for it. Pass a verified mapping catalog with a \`packageName\` row instead, or use a package the shipped table declares.`,
      ),
    };
  }

  return { extensionCatalog: { mappings: catalogEntriesFor(relevant) }, problems: [] };
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
  const { extensionCatalog, problems } = await extensionCatalogFor(options, lock);
  if (problems.length > 0) {
    return problems;
  }
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
    evidence.push({ kind: "probe", reference: probeResult.evidencePath });
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

  // Every check has passed, so this decision is about to exist and the report it cites has
  // to exist with it. Written here rather than during measurement: before this point a
  // refusal is still possible, and an evidence file left behind by a decision nobody
  // accepted would be an orphan in a working tree under a message saying nothing was
  // written.
  //
  // Ordered before the lock write on purpose. Evidence is a precondition of the citation
  // the lock will contain, so a failure to write it must abort before the lock is touched —
  // the reverse order could leave a lock citing a file that this run then failed to write.
  const evidence = probeResult === null ? null : await persistEvidence(projectRoot, probeResult.report);

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
      // What evidence this write produced, so a caller can see whether it has a new file to
      // commit — the answer is `created: true` on the first record of a report, and
      // `created: false` when an identical report was already there. Stated rather than
      // implied because the file is committable and a reviewer has to know to add it.
      evidence: evidence === null ? null : { path: evidence.relative, created: evidence.created },
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

    // A citation problem is a blocker, and it is reported *beside* the core assessment
    // rather than through it: `assessLockDecision` answers "do the versions, fingerprints and
    // runtime still match", which is a different question from "are the bytes the record
    // rests on still here, and are they the bytes that were measured". Core cannot answer the
    // second — it is handed a parsed document, not a working directory — and the gap is
    // exactly how a fresh checkout, or a bad merge of a committed evidence file, could keep
    // reporting `fresh`/`validated` for a record whose evidence is absent or altered.
    const evidenceFindings = record.evidence
      .map(link => ({ reference: link.reference, state: inspectEvidenceReference(projectRoot, link.reference) }))
      .filter(finding => finding.state !== "ok");

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
      blockers: [
        ...core.lockDecisionBlockers(assessment),
        ...evidenceFindings.map(finding => `evidence-${finding.state}:${finding.reference}`),
      ],
      // Named separately so a consumer can tell "the evidence never arrived" from "what
      // arrived is not what was measured" — different causes, different fixes.
      unresolvedEvidence: evidenceFindings.filter(finding => finding.state === "missing").map(finding => finding.reference),
      alteredEvidence: evidenceFindings
        .filter(finding => finding.state === "integrity-mismatch")
        .map(finding => finding.reference),
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

  // Non-zero when anything a caller has to act on is wrong: a stale record, or a citation
  // that is absent or no longer matches its own name. All of them mean "do not treat this
  // lock as verified as it stands".
  if (
    decisions.some(
      entry => entry.freshness === "stale" || entry.unresolvedEvidence.length > 0 || entry.alteredEvidence.length > 0,
    )
  ) {
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
                    measurement is still persisted as evidence, so the lock's
                    \`fgc-evidence/\` link resolves.
  --runtime-smoke <module>
                    Load a local module and run its export as the probe's
                    runtime-smoke hook. Needed for a decision that claims
                    validatedAgainstRuntime: the step is only \`passed\` when a hook
                    really executed.
  --runtime-smoke-export <name>
                    Which export of that module is the hook (default: \`default\`).
  --extension-catalog <file>
                    Verify \`extension\` records against a real source instead of this
                    repository's declared mappings. Accepts either a verified mapping
                    catalog (\`packageName\`/\`libraryId\`/\`globalName\` rows) or the raw
                    \`api.app.listFrontendLibraries\` listing (\`id\`/\`name\`/\`globalName\`/
                    \`exists\`/\`typeDefinitionAvailable\`). A listing is checked against
                    the declared rows via #12's metadata audit; its display \`name\` is
                    never read as an npm package.
  --json            Machine-readable output (default for policy, probe and status).

audit and record run the same checks, including conformance against the verified target;
record refuses to write anything the checks reject. Unknown options are refused rather than
ignored, and an option that needs a value must have one.

Evidence: record writes the report it cites to \`fgc-evidence/<content-hash>.json\` beside
fgc.lock.json, once the decision is accepted — probe and audit measure only and write
nothing. status verifies those bytes against their name, reporting \`evidence-missing\` or
\`evidence-integrity-mismatch\`. Commit that directory with the lock; an ignored one would
not survive a fresh checkout.

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
