/**
 * The CLI contract, executed against the real command.
 *
 * Decision source: GitHub Issue #18 — "Implement: Forguncy React dependency-selection
 * Agent Skill" — https://github.com/Mang-X/forguncy-react-workspace/issues/18
 *
 * Governing Specs: #16 (the Skill/scripts split and the evidence rule), #8 (the lock
 * whose evidence links must resolve), #12 (a `libraryId` comes from a listing or a
 * verified catalog, never from a display name).
 *
 * ## Why this file exists, and why `selection-cases.test.ts` did not cover it
 *
 * Every check here is about the *command-line* behaviour: which file lands on disk,
 * whether a cited path resolves, what an exit code means. `selection-cases.test.ts`
 * drives the resolver and `core` APIs directly, so it exercises the same policy while
 * never executing `select_dependency.mjs` — and three real defects lived exactly in that
 * gap (a `probe` link pointing at a file `--no-cache` never wrote, a `validated` branch
 * that no flag could reach, and an `extension` record written with a fabricated
 * `libraryId`). Those are all "the code was right and the wiring was not" failures, so
 * the regression suite has to run the wiring.
 *
 * ## What it asserts, and what it does not
 *
 * It asserts observable CLI facts: exit code, whether `fgc.lock.json` exists, whether a
 * path the lock cites can be read, and which problem codes came back. It does **not**
 * re-assert the policy reasoning — that is `selection-cases.test.ts`'s job, and a second
 * copy here would be two places to update and one to forget.
 *
 * ## Why the scratch project is a `.fgc/` directory inside a committed example
 *
 * The CLI needs a project root that actually installs the candidate, so it can only run
 * somewhere beneath `examples/`. A scratch root under the example's own `.fgc/` is
 * resolved by the same ancestor walk (`projectResolutionRoots` in
 * `packages/dependency-resolver/src/install-graph.ts`) and the whole path is already
 * git-ignored, so a run cannot dirty a committed file.
 *
 * A consequence worth stating rather than working around: `commandRecord` reads the
 * toolchain from the project root, and a scratch root has no manifest of its own, so a
 * record written there reports `toolchain-unknown` and is `stale`. That is the honest
 * result for a directory that declares no toolchain, and these tests assert on the record
 * and its evidence rather than on freshness for that reason.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..");
const CLI = join(REPOSITORY_ROOT, ".agents", "skills", "forguncy-react-dependency-selection", "scripts", "select_dependency.mjs");
const PROVING_CASES = join(REPOSITORY_ROOT, "examples", "probe-proving-cases");
const EXTENSION_QUERY = join(REPOSITORY_ROOT, "examples", "extension-query");

/** Both cases run a real Rolldown build of a published package. */
const CASE_TIMEOUT_MS = 120_000;

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI as a child process, which is the only way to observe the exit code and the
 * bytes actually written — the two things every defect here got wrong.
 */
async function cli(args: readonly string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function json<T = Record<string, unknown>>(result: CommandResult): T {
  return JSON.parse(result.stdout) as T;
}

/**
 * A scratch project root inside the example's git-ignored `.fgc/`.
 *
 * `mkdir` rather than only `mkdtemp`, because the root must exist before the CLI reads a
 * lock from it. Cleanup is the caller's, via `withScratch`.
 */
async function scratchRoot(example: string): Promise<string> {
  const parent = join(example, ".fgc");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "cli-contract-"));
}

/**
 * Removes a scratch root **and the `.fgc/` parent this file created for it**.
 *
 * Leaving the parent behind is not merely untidy: an empty `.fgc/` under an example is a
 * directory the probe engine and other suites walk into, and a leftover one made an
 * unrelated fixture-based test fail while this suite ran alongside it. So cleanup removes
 * the parent too, and only when it is empty — a `.fgc/` holding someone else's scratch
 * state (or a real probe cache) must not be deleted out from under them.
 */
async function removeScratch(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  const parent = dirname(root);
  if (basename(parent) !== ".fgc") {
    return;
  }
  const remaining = await readdir(parent).catch(() => null);
  if (remaining !== null && remaining.length === 0) {
    await rm(parent, { recursive: true, force: true });
  }
}

async function withScratch<T>(example: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await scratchRoot(example);
  try {
    return await body(root);
  } finally {
    await removeScratch(root);
  }
}

/** Writes a decision file outside the project root, so a probe never mistakes it for source. */
async function decisionFile(contents: Record<string, unknown>): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "fgc-cli-decision-"));
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify(contents, null, 2), "utf8");
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

interface LockRecord {
  readonly packageName: string;
  readonly strategy: string;
  readonly target: unknown;
  readonly resolvedVersion: string | null;
  readonly probe: { readonly status: string; readonly fingerprint: string | null };
  readonly extension: { readonly version: string | null; readonly identity: string | null } | null;
  readonly evidence: readonly { readonly kind: string; readonly reference: string }[];
}

async function readLock(root: string): Promise<{ decisions: readonly LockRecord[] }> {
  return JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as { decisions: readonly LockRecord[] };
}

/** The `probe` evidence link a record cites, or null when it cites none. */
function probeLink(record: LockRecord): string | null {
  return record.evidence.find(link => link.kind === "probe")?.reference ?? null;
}

// ---------------------------------------------------------------------------
// Defect 1 — every cited `probe` link must resolve
// ---------------------------------------------------------------------------

describe("CLI contract: a recorded probe link resolves to real evidence", () => {
  it("writes the report `record` cites, including under --no-cache", async () => {
    // The defect: `--no-cache` made the engine skip its write, while the lock still cited
    // a cache path — a lock whose evidence points at nothing, which is the one thing #8's
    // evidence rule exists to prevent.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const recorded = await cli(["record", "--project", root, "--no-cache", "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        const reference = probeLink(record);
        expect(reference, "a passing record must cite its probe").not.toBeNull();

        const onDisk = join(root, ...reference!.split("/"));
        expect(existsSync(onDisk), `cited evidence ${reference} must exist`).toBe(true);

        // Resolving is not enough: the bytes have to be the report this run measured, which
        // is what makes the fingerprint in the lock re-checkable. Evidence is stored as a
        // bare report (no wrapper), so the fingerprint it must agree with is the record's.
        const report = JSON.parse(await readFile(onDisk, "utf8")) as {
          schemaVersion: number;
          validation: readonly { step: string; outcome: string }[];
        };
        expect(report.schemaVersion).toBeGreaterThan(0);
        expect(report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("skipped");
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("reports the path a lock would cite, without writing it", async () => {
    // `probe` measures and reports; `record` persists. That split is deliberate: a probe is a
    // read that may end in a decision nobody accepts, and evidence is a committable file, so
    // writing it during measurement would let `audit` — the read-only counterpart — dirty a
    // working tree. The address is still reported here so a caller can see it before deciding.
    await withScratch(PROVING_CASES, async root => {
      const probed = await cli(["probe", "--project", root, "--no-cache", "es-toolkit"]);
      expect(probed.code, probed.stderr).toBe(0);

      const report = json<{ evidencePath: string }>(probed);
      expect(report.evidencePath.startsWith("fgc-evidence/")).toBe(true);
      expect(existsSync(join(root, ...report.evidencePath.split("/"))), "probe must not write evidence").toBe(false);
    });
  }, CASE_TIMEOUT_MS);

  it("does not let a hook-bearing report answer a later hookless run", async () => {
    // The reason the engine declines to cache a hook-bearing report. Writing one is now
    // deliberate, so this pins the guarantee that makes it safe: the refusal lives in
    // `cacheHitAnswersThisRun`, on the read side.
    await withScratch(PROVING_CASES, async root => {
      const hookDirectory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
      const hook = join(hookDirectory, "hook.mjs");
      await writeFile(
        hook,
        'export default () => ({ risks: [{ signal: "global-singleton-assumption", summary: "page global observed", evidence: ["page:forguncy"] }] });\n',
        "utf8",
      );
      try {
        const withHook = await cli(["probe", "--project", root, "--runtime-smoke", hook, "es-toolkit"]);
        expect(withHook.code, withHook.stderr).toBe(0);
        const hookReport = json<{ validation: readonly { step: string; outcome: string }[] }>(withHook);
        expect(hookReport.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");

        // A later hookless run must re-probe: it cannot inherit a runtime result it did
        // not request, even though the report is now sitting in the cache.
        const hookless = await cli(["probe", "--project", root, "es-toolkit"]);
        expect(hookless.code, hookless.stderr).toBe(0);
        const hooklessReport = json<{ validation: readonly { step: string; outcome: string }[]; risks: readonly unknown[] }>(hookless);
        expect(hooklessReport.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("skipped");
        expect(hooklessReport.risks).toEqual([]);
      } finally {
        await rm(hookDirectory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Defect 2 — the runtime-smoke path is reachable and still evidence-backed
// ---------------------------------------------------------------------------

describe("CLI contract: a validated runtime target requires a real hook", () => {
  it("records a non-null target when a hook actually ran", async () => {
    // The defect: `runtimeTargetFor` required `runtime-smoke: passed`, and nothing in the
    // CLI could supply a hook — so the branch that records `validated` was unreachable.
    await withScratch(PROVING_CASES, async root => {
      const hookDirectory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
      const hook = join(hookDirectory, "hook.mjs");
      await writeFile(hook, "export default () => ({ facts: [{ name: 'page.global', value: 'forguncy' }] });\n", "utf8");
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        validatedAgainstRuntime: true,
        evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(record.target).not.toBeNull();
        expect(json<{ freshness: { realRuntimeValidation: string } }>(recorded).freshness.realRuntimeValidation).toBe("validated");
      } finally {
        await decision.cleanup();
        await rm(hookDirectory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);

  it("records a null target by default, so a local probe is not a runtime claim", async () => {
    // The other direction, and the one AGENTS.md rule 7 is about: no hook, no claim.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(record.target).toBeNull();
        expect(json<{ freshness: { realRuntimeValidation: string } }>(recorded).freshness.realRuntimeValidation).toBe("not-validated");
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses the runtime claim when the hook threw, and writes nothing", async () => {
    // A hook that throws makes the step `failed`, which is evidence about the attempt
    // rather than a confirmation — so the claim it was invoked to support cannot stand.
    await withScratch(PROVING_CASES, async root => {
      const hookDirectory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
      const hook = join(hookDirectory, "hook.mjs");
      await writeFile(hook, 'export default () => { throw new Error("page did not load"); };\n', "utf8");
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        validatedAgainstRuntime: true,
        evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(recorded.stderr).toContain("failed");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await decision.cleanup();
        await rm(hookDirectory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses the runtime claim with no hook at all, naming the flag", async () => {
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        validatedAgainstRuntime: true,
        evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(recorded.stderr).toContain("--runtime-smoke");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("reports a missing hook module and a non-function export cleanly, without a stack trace", async () => {
    // A caller-input problem has to read as one. Letting `import()` throw or the engine's
    // report validation escape would surface this as engine frames, which is the failure
    // shape the script's own header says it exists to avoid.
    await withScratch(PROVING_CASES, async root => {
      const missing = await cli(["probe", "--project", root, "--runtime-smoke", join(root, "no-such-hook.mjs"), "es-toolkit"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("Cannot load the --runtime-smoke module");
      expect(missing.stderr).not.toContain("at async");

      const hookDirectory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
      const hook = join(hookDirectory, "hook.mjs");
      await writeFile(hook, "export const notAHook = 1;\n", "utf8");
      try {
        const wrongExport = await cli(["probe", "--project", root, "--runtime-smoke", hook, "es-toolkit"]);
        expect(wrongExport.code).not.toBe(0);
        expect(wrongExport.stderr).toContain('no callable export "default"');
        expect(wrongExport.stderr).not.toContain("at async");

        // A hook returning a finding the protocol refuses is the same class of problem, and
        // it surfaces from inside the engine, so it has to be caught rather than escape.
        const malformed = join(hookDirectory, "malformed.mjs");
        await writeFile(malformed, 'export default () => ({ facts: [{ bogus: true }] });\n', "utf8");
        const badFinding = await cli(["probe", "--project", root, "--runtime-smoke", malformed, "es-toolkit"]);
        expect(badFinding.code).not.toBe(0);
        expect(badFinding.stderr).toContain("failed");
        expect(badFinding.stderr).not.toContain("at async");
      } finally {
        await rm(hookDirectory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still honours --no-cache together with --runtime-smoke", async () => {
    await withScratch(PROVING_CASES, async root => {
      const hookDirectory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
      const hook = join(hookDirectory, "hook.mjs");
      await writeFile(hook, "export default () => ({ facts: [{ name: 'page.global', value: true }] });\n", "utf8");
      try {
        const probed = await cli(["probe", "--project", root, "--no-cache", "--runtime-smoke", hook, "es-toolkit"]);
        expect(probed.code, probed.stderr).toBe(0);
        const report = json<{ validation: readonly { step: string; outcome: string }[]; evidencePath: string }>(probed);
        expect(report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");
        // Still measured only: the smoke result is in the report the caller just received, and
        // `record` is what will persist it if the decision it supports is accepted.
        expect(report.evidencePath.startsWith("fgc-evidence/")).toBe(true);
        expect(existsSync(join(root, ...report.evidencePath.split("/")))).toBe(false);
      } finally {
        await rm(hookDirectory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Defect 3 — conformance gates the write, for extensions and hosts alike
// ---------------------------------------------------------------------------

describe("CLI contract: conformance is checked before anything is written", () => {
  it("refuses an `extension` record whose libraryId nothing verifies", async () => {
    // The defect: `recordDependencyDecision` validates lock *shape* only, so a fabricated
    // `libraryId`/`globalName`/identity recorded happily. #18's "only when supported by
    // evidence" was therefore unenforced at the exact point a strategy is persisted.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-data-access",
        strategy: "extension",
        libraryId: "completely-invented-library-id",
        globalName: "InventedGlobal",
        extensionVersion: "0.0.1",
        extensionIdentity: "sha256:deadbeef",
        rationale: "claims a verified extension that does not exist",
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join(" ")).toContain(
          "extension-library-not-verified",
        );
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("records the verified catalog row", async () => {
    // The positive case, and the one that proves the gate is not simply refusing every
    // `extension`: this repository's one verified mapping has to pass.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile({
        packageName: "@tanstack/react-query",
        role: "cell-local-data-access",
        strategy: "extension",
        libraryId: "tanstack-query",
        globalName: "TanStackQuery",
        extensionVersion: "5.102.8",
        rationale: "A bundled copy would give every Cell its own QueryClient, so the shared page global is required.",
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "@tanstack/react-query")!;
        expect(record.strategy).toBe("extension");
        expect(record.extension).not.toBeNull();
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a `host` record naming a global the target does not provide", async () => {
    // Conformance is not only about extensions: a `host` decision claims a page global,
    // and a claim about a global no target provides is the same class of defect.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "host",
        globalName: "notAProvidedGlobal",
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join(" ")).toContain("host-global-not-provided");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("audit and record reach the same verdict on the same decision file", async () => {
    // `audit` is the read-only counterpart, so a decision it calls recordable and the write
    // then refuses would be worse than no audit — the caller would have been told it was
    // ready. Asserted through the pair rather than on either alone.
    await withScratch(PROVING_CASES, async root => {
      const fabricated = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-data-access",
        strategy: "extension",
        libraryId: "invented",
        globalName: "Invented",
        rationale: "x",
      });
      const legitimate = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const audited = await cli(["audit", "--project", root, "--decision", fabricated.path]);
        expect(audited.code).not.toBe(0);
        const payload = json<{ recordable: boolean; problems: readonly string[] }>(audited);
        // `recordable` must not contradict the problems it reports beside it.
        expect(payload.recordable).toBe(false);
        expect(payload.problems.join(" ")).toContain("extension-library-not-verified");

        const refused = await cli(["record", "--project", root, "--decision", fabricated.path]);
        expect(refused.code).not.toBe(0);
        // Both commands report the same problems, in the same key: one vocabulary, so a caller
        // does not have to know which audit produced a refusal.
        expect(json<{ problems: readonly string[] }>(refused).problems).toEqual(payload.problems);

        // And the legitimate decision must pass both, so the pair is not merely rejecting
        // everything.
        const auditedOk = await cli(["audit", "--project", root, "--decision", legitimate.path]);
        expect(auditedOk.code, auditedOk.stderr).toBe(0);
        expect(json<{ recordable: boolean }>(auditedOk).recordable).toBe(true);

        const recordedOk = await cli(["record", "--project", root, "--decision", legitimate.path]);
        expect(recordedOk.code, recordedOk.stderr).toBe(0);
      } finally {
        await fabricated.cleanup();
        await legitimate.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses when --extension-catalog is malformed rather than crashing", async () => {
    // An override file with no usable rows would otherwise reach `mappings.filter(...)`
    // inside the conformance module and come back as a native TypeError — a crash in the
    // tool rather than a problem with the file the caller handed in.
    await withScratch(PROVING_CASES, async root => {
      const directory = await mkdtemp(join(tmpdir(), "fgc-cli-catalog-"));
      const empty = join(directory, "empty.json");
      const incomplete = join(directory, "incomplete.json");
      await writeFile(empty, JSON.stringify({}), "utf8");
      await writeFile(incomplete, JSON.stringify({ mappings: [{ packageName: "es-toolkit" }] }), "utf8");
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-data-access",
        strategy: "extension",
        libraryId: "tanstack-query",
        globalName: "TanStackQuery",
        rationale: "x",
      });
      try {
        for (const catalog of [empty, incomplete]) {
          const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog, "--decision", decision.path]);
          expect(recorded.code).not.toBe(0);
          expect(recorded.stderr).toContain("--extension-catalog");
          expect(recorded.stderr).not.toContain("at async");
        }
      } finally {
        await decision.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still loads a lock that holds a fabricated extension, so the gate does not reach the read path", async () => {
    // Conformance gates *writing*. Freshness is a separate question, and `status` has to
    // keep answering it for a lock that already exists — otherwise a bad record written
    // before this gate landed would make the project unreadable.
    await withScratch(PROVING_CASES, async root => {
      await writeFile(
        join(root, "fgc.lock.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            decisions: [
              {
                packageName: "es-toolkit",
                cellTarget: null,
                strategy: "extension",
                resolvedVersion: "1.52.0",
                libraryId: "fabricated-before-the-gate",
                globalName: "Fabricated",
                probe: { status: "passed", fingerprint: "fingerprint", versionIndependent: false },
                target: null,
                probedWith: { vitePlus: "0.3.2" },
                extension: { version: "1.52.0", identity: null },
                rejectedCandidate: null,
                rationale: "recorded before the gate existed",
                evidence: [{ kind: "probe", reference: ".fgc/probe-cache/x.json" }],
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      // `status` exits non-zero when a record is stale — that is its documented signal, and
      // this record is stale for the ordinary reasons (a scratch root declares no toolchain,
      // and the fingerprints do not match). What matters is that it *loaded*: the gate must
      // not have reached the read path, or a lock written before this change would become
      // unreadable rather than reported stale.
      const status = await cli(["status", "--project", root]);
      const payload = json<{ decisions: readonly { packageName: string; freshness: string; stalenessReasons: readonly string[] }[] }>(status);
      expect(payload.decisions.map(entry => entry.packageName)).toEqual(["es-toolkit"]);
      expect(payload.decisions[0]?.freshness).toBe("stale");
      // Reported for freshness reasons only — never as a conformance refusal.
      expect(payload.decisions[0]?.stalenessReasons.join(" ")).not.toContain("verified");
      expect(status.stderr).not.toContain("conformance");
    });
  }, CASE_TIMEOUT_MS);

  it("keeps a re-record idempotent, preserving accumulated evidence and rationale", async () => {
    // The reason the read-modify-write is composed from the exported primitives rather than
    // hand-rolled: `mergeDependencyDecisionUpdate` owns the merge rules, and a second copy
    // would be where an idempotency bug (dropping `existing`) hides.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const first = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(first.code, first.stderr).toBe(0);
        const second = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(second.code, second.stderr).toBe(0);

        const payload = json<{ replaced: boolean; record: { evidence: readonly { kind: string; reference: string }[] } }>(second);
        expect(payload.replaced).toBe(true);

        // One record, and the evidence of both runs still there — the merge unions links
        // rather than replacing them.
        const lock = await readLock(root);
        expect(lock.decisions).toHaveLength(1);
        expect(probeLink(lock.decisions[0]!)).not.toBeNull();
        expect(payload.record.evidence.length).toBeGreaterThanOrEqual(lock.decisions[0]!.evidence.length);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 2 — the extension-catalog wiring
// ---------------------------------------------------------------------------

/**
 * `--extension-catalog` accepts the two sources #12 names, and they are not
 * interchangeable: a *verified mapping catalog* states which npm package each row
 * answers for, while a raw `api.app.listFrontendLibraries` listing does not.
 *
 * Both defects these cover came from treating a listing as though it did — reading its
 * display `name` as a package name — and from projecting the shipped table so narrowly
 * that a declared sibling module id became unverifiable. Both made *legitimate* input
 * fail, which is the direction a gate must never fail in.
 */
describe("CLI contract: a raw listing is not a mapping catalog", () => {
  /** One real `listFrontendLibraries` row: the fields the platform actually returns. */
  const listing = (overrides: Record<string, unknown> = {}) => [
    {
      id: "tanstack-query",
      name: "TanStack Query for ReactCellType",
      globalName: "TanStackQuery",
      exists: true,
      typeDefinitionAvailable: true,
      ...overrides,
    },
  ];

  async function listingFile(
    rows: readonly Record<string, unknown>[],
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-cli-listing-"));
    const path = join(directory, "listing.json");
    await writeFile(path, JSON.stringify(rows, null, 2), "utf8");
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  const extensionDecision = (packageName: string, overrides: Record<string, unknown> = {}) => ({
    packageName,
    role: "cell-local-data-access",
    strategy: "extension",
    libraryId: "tanstack-query",
    globalName: "TanStackQuery",
    extensionVersion: "5.102.8",
    rationale: "A bundled copy would give every Cell its own QueryClient, so the shared page global is required.",
    ...overrides,
  });

  it("verifies a decision against the listing's stable id, not its display name", async () => {
    // The defect: the listing's `name` was read as `packageName`, so a real listing became
    // `packageName: "TanStack Query for ReactCellType"` — a string that is not an npm
    // package and can never match `@tanstack/react-query`. Every legitimate decision
    // through a real listing was therefore refused as `extension-library-not-verified`.
    await withScratch(EXTENSION_QUERY, async root => {
      const catalog = await listingFile(listing());
      const decision = await decisionFile(extensionDecision("@tanstack/react-query"));
      try {
        const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog.path, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "@tanstack/react-query")!;
        expect(record.libraryId).toBe("tanstack-query");
        expect(record.globalName).toBe("TanStackQuery");
      } finally {
        await catalog.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("keeps the bundle and type-definition findings a raw listing can actually establish", async () => {
    // #12's listing carries `exists` and `typeDefinitionAvailable`, and the review's point
    // was that dropping them loses the metadata audit entirely. They are checked through
    // `core`'s own `auditExtensionLibraryMetadata`, so the CLI and the compiler agree
    // about what those two fields mean.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(extensionDecision("@tanstack/react-query"));
      const cases: readonly { readonly rows: readonly Record<string, unknown>[]; readonly code: string }[] = [
        { rows: listing({ exists: false }), code: "extension-bundle-missing" },
        { rows: listing({ typeDefinitionAvailable: false }), code: "extension-types-missing" },
        { rows: listing({ globalName: "WrongGlobal" }), code: "extension-global-mismatch" },
        { rows: listing({ id: "some-other-library" }), code: "extension-library-unverified" },
      ];
      try {
        for (const { rows, code } of cases) {
          const catalog = await listingFile(rows);
          try {
            const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog.path, "--decision", decision.path]);
            expect(recorded.code, `${code} should refuse`).not.toBe(0);
            expect(json<{ problems: readonly string[] }>(recorded).problems.join(" ")).toContain(code);
            expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
          } finally {
            await catalog.cleanup();
          }
        }
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses to let a listing imply a mapping the shipped table does not declare", async () => {
    // A listing confirms an identity; it cannot establish which npm package an extension
    // provides, because that relation is recorded only in the declared table. Reporting
    // this as a plain "not verified" would send the caller looking for a row to add
    // rather than at the input that was wrong for the question.
    await withScratch(PROVING_CASES, async root => {
      const catalog = await listingFile(listing());
      const decision = await decisionFile(
        extensionDecision("es-toolkit", { libraryId: "es-toolkit-ext", globalName: "EsToolkit" }),
      );
      try {
        const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog.path, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join(" ")).toContain(
          "extension-mapping-not-declared",
        );
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await catalog.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still accepts a verified mapping catalog, which does state its package", async () => {
    // The other accepted input, so the fix is not "a listing is now refused instead".
    await withScratch(EXTENSION_QUERY, async root => {
      const catalog = await listingFile([
        { packageName: "@tanstack/react-query", libraryId: "tanstack-query", globalName: "TanStackQuery" },
      ]);
      const decision = await decisionFile(extensionDecision("@tanstack/react-query"));
      try {
        const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog.path, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
      } finally {
        await catalog.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a file that mixes mapping rows and listing rows", async () => {
    await withScratch(EXTENSION_QUERY, async root => {
      const catalog = await listingFile([
        { packageName: "@tanstack/react-query", libraryId: "tanstack-query", globalName: "TanStackQuery" },
        { id: "tanstack-query", name: "x", globalName: "TanStackQuery" },
      ]);
      const decision = await decisionFile(extensionDecision("@tanstack/react-query"));
      try {
        const recorded = await cli(["record", "--project", root, "--extension-catalog", catalog.path, "--decision", decision.path]);
        expect(recorded.code).not.toBe(0);
        expect(recorded.stderr).toContain("mixes mapping rows");
        expect(recorded.stderr).not.toContain("at async");
      } finally {
        await catalog.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

describe("CLI contract: a declared sibling module id is verifiable", () => {
  it("projects every module id a mapping covers, not only its primary package", async () => {
    // #12's canonical row is `@tanstack/react-query` with `moduleIds: ["@tanstack/query-core"]`,
    // because the vendor package re-exports query-core. A projection that kept only
    // `packageName` would report a legitimate `@tanstack/query-core` decision as
    // `extension-library-not-verified` — refused for a declared relationship.
    //
    // Asserted through `policy`, because the projection is the thing that was wrong and
    // `policy` is where the CLI publishes the catalog it will actually use. A full
    // `record` of this package is not reachable: query-core is a transitive dependency,
    // resolvable from no project root, so the probe refuses before conformance is asked.
    const policy = await cli(["policy"]);
    expect(policy.code, policy.stderr).toBe(0);

    const surface = json<{
      extensionCatalog: {
        mappings: readonly { packageName: string; libraryId: string; globalName: string }[];
        declaredRows: readonly { packageName: string; moduleIds: readonly string[]; libraryId: string; globalName: string }[];
      };
    }>(policy);

    const row = surface.extensionCatalog.declaredRows.find(entry => entry.packageName === "@tanstack/react-query");
    expect(row, "@tanstack/react-query is a declared row").toBeDefined();
    expect(row!.moduleIds).toContain("@tanstack/query-core");

    // Every declared module id has a catalog entry of its own, carrying the same identity
    // as the row it came from.
    for (const moduleId of [row!.packageName, ...row!.moduleIds]) {
      const entry = surface.extensionCatalog.mappings.find(mapping => mapping.packageName === moduleId);
      expect(entry, `${moduleId} must be verifiable`).toBeDefined();
      expect(entry!.libraryId).toBe(row!.libraryId);
      expect(entry!.globalName).toBe(row!.globalName);
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 3 — evidence lifecycle, and options that need a value
// ---------------------------------------------------------------------------

/**
 * The recorded claim and the evidence it cites have to stay consistent across the whole
 * lifecycle, not only at the moment of writing.
 *
 * The defect this covers was a *write-side* collision, which is why the read-side guard
 * that looked sufficient did not catch it: the engine's cache is keyed by the probe's
 * declared inputs (`fingerprint`), and smoke mode is deliberately not one of them. Writing
 * a hook-bearing report under that key meant any later hookless run re-probed, missed, and
 * stored its own report at the same path — silently replacing the `runtime-smoke: passed`
 * result that a `validated` record cited, while the record kept its non-null `target`.
 *
 * The fix stores evidence at a content address instead, so two different reports cannot
 * share a path. These tests read the cited bytes back after the operations that used to
 * clobber them.
 */
describe("CLI contract: cited evidence survives later runs", () => {
  const runtimeObservedDecision = {
    packageName: "es-toolkit",
    role: "cell-local-ui",
    strategy: "inline",
    validatedAgainstRuntime: true,
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
  };

  async function smokeHook(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
    const path = join(directory, "hook.mjs");
    await writeFile(path, "export default () => ({ facts: [{ name: 'page.global', value: 'forguncy' }] });\n", "utf8");
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  /** The runtime-smoke outcome recorded in the report a lock cites, or null if it is gone. */
  async function citedSmokeOutcome(root: string, reference: string): Promise<string | null> {
    const onDisk = join(root, ...reference.split("/"));
    if (!existsSync(onDisk)) {
      return null;
    }
    const report = JSON.parse(await readFile(onDisk, "utf8")) as {
      validation: readonly { step: string; outcome: string }[];
    };
    return report.validation.find(entry => entry.step === "runtime-smoke")?.outcome ?? null;
  }

  it("keeps the smoke evidence a validated record cites, through a later status run", async () => {
    // The minimal form of the reported path: record with a hook, then the read-only command
    // that uses a hookless probe, then re-read the same reference.
    await withScratch(PROVING_CASES, async root => {
      const hook = await smokeHook();
      const decision = await decisionFile(runtimeObservedDecision);
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook.path, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const reference = probeLink((await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!)!;
        expect(await citedSmokeOutcome(root, reference)).toBe("passed");

        const status = await cli(["status", "--project", root]);
        void status; // its exit code is the freshness signal, which is not what this test is about

        expect(await citedSmokeOutcome(root, reference), "status must not clobber cited evidence").toBe("passed");

        // And the claim it supports is still there.
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(record.target).not.toBeNull();
      } finally {
        await hook.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("keeps it through a hookless probe and a hookless record of the same package", async () => {
    // Both are operations that write a probe report under the *same fingerprint* — the
    // collision the fix removes — so this is the assertion that a report cannot land on
    // another report's path.
    await withScratch(PROVING_CASES, async root => {
      const hook = await smokeHook();
      const withRuntime = await decisionFile(runtimeObservedDecision);
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook.path, "--decision", withRuntime.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const smokeReference = probeLink((await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!)!;

        await cli(["probe", "--project", root, "--no-cache", "es-toolkit"]);
        const plain = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
        try {
          const plainRecorded = await cli(["record", "--project", root, "--decision", plain.path]);
          expect(plainRecorded.code, plainRecorded.stderr).toBe(0);
        } finally {
          await plain.cleanup();
        }

        // The smoke artifact still holds what it held, and the replacement record is
        // self-consistent rather than pointing at the other record's evidence.
        expect(await citedSmokeOutcome(root, smokeReference)).toBe("passed");
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        const current = probeLink(record)!;
        expect(current).not.toBe(smokeReference);
        expect(await citedSmokeOutcome(root, current)).toBe("skipped");
        // A record with no runtime observation must not claim a runtime target.
        expect(record.target).toBeNull();
      } finally {
        await hook.cleanup();
        await withRuntime.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("addresses evidence by content, so an identical report reuses one path", async () => {
    // The property that makes the address meaningful: same bytes, same path — so a
    // reviewer re-measuring an unchanged package finds the cited artifact where the lock
    // said it would be, and two runs cannot disagree about what a path holds.
    await withScratch(PROVING_CASES, async root => {
      const first = await cli(["probe", "--project", root, "es-toolkit"]);
      const second = await cli(["probe", "--project", root, "--no-cache", "es-toolkit"]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(json<{ evidencePath: string }>(second).evidencePath).toBe(json<{ evidencePath: string }>(first).evidencePath);
    });
  }, CASE_TIMEOUT_MS);
});

describe("CLI contract: an option that needs a value fails closed", () => {
  it("refuses a value-taking flag whose value is missing, rather than falling back to a default", async () => {
    // The defect: the parser stored `undefined` for a bare trailing `--extension-catalog`,
    // which was indistinguishable from the flag never being passed — so the command fell
    // back to the shipped catalog and reported success. A caller who meant to verify
    // against a real listing would be told nothing, and a listing that *failed*
    // verification would never be consulted.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        // Trailing, and followed by another flag: both are a missing value, not an absent one.
        for (const args of [
          ["record", "--project", root, "--decision", decision.path, "--extension-catalog"],
          ["record", "--project", root, "--extension-catalog", "--decision", decision.path],
        ]) {
          const refused = await cli(args);
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain("--extension-catalog needs a value");
          expect(refused.stderr).not.toContain("at async");
          expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
        }
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("applies the same rule to the other value-taking options", async () => {
    await withScratch(PROVING_CASES, async () => {
      for (const flag of ["--project", "--decision", "--runtime-smoke", "--runtime-smoke-export"]) {
        const refused = await cli(["probe", flag]);
        expect(refused.code, `${flag} must be refused`).not.toBe(0);
        expect(refused.stderr).toContain(`${flag} needs a value`);
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still accepts an inline value and a value that is not a flag", async () => {
    // The guard must not break the two forms the CLI documents.
    await withScratch(PROVING_CASES, async root => {
      const attached = await cli(["probe", `--project=${root}`, "es-toolkit"]);
      expect(attached.code, attached.stderr).toBe(0);

      const separate = await cli(["probe", "--project", root, "es-toolkit"]);
      expect(separate.code, separate.stderr).toBe(0);
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 4 — evidence durability, and unknown options
// ---------------------------------------------------------------------------

/**
 * A lock has to be checkable by someone who did not write it.
 *
 * The defect this covers is about *durability*, not about the write path: evidence was
 * content-addressed and collision-free, but it lived under `.fgc/`, which the repository
 * ignores wholesale. A committed lock therefore arrived on a fresh checkout with a
 * citation that resolved to nothing — while every reader still reported `fresh`,
 * `validated` and no blockers, because `assessLockDecision` recomputes freshness from
 * versions and fingerprints and never asks whether the cited bytes exist. A
 * `runtime-smoke` result cannot simply be re-derived on a reviewer's machine, which is
 * the case the durable artifact is for.
 */
describe("CLI contract: cited evidence travels with the lock", () => {
  const runtimeObserved = {
    packageName: "es-toolkit",
    role: "cell-local-ui",
    strategy: "inline",
    validatedAgainstRuntime: true,
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
  };

  async function smokeHook(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-cli-hook-"));
    const path = join(directory, "hook.mjs");
    await writeFile(path, "export default () => ({ facts: [{ name: 'page.global', value: 'forguncy' }] });\n", "utf8");
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  it("stores evidence outside .fgc/, so a commit can carry it", async () => {
    // Asserted on the path's *first segment* rather than with `git check-ignore`, and the
    // reason is worth recording: this suite's scratch root deliberately lives inside the
    // example's `.fgc/`, so every path under it is ignored by inheritance whatever the CLI
    // does. A `check-ignore` assertion here would fail for a harness reason and would keep
    // failing no matter where the CLI put the file. The property that actually matters is
    // that the citation is not under the repository-wide ignored directory, which
    // `git check-ignore` confirms for the real project root in the run below.
    await withScratch(PROVING_CASES, async root => {
      const hook = await smokeHook();
      const decision = await decisionFile(runtimeObserved);
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook.path, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        const reference = probeLink(record)!;

        // `.fgc/` is the repository's ignored scratch tree; evidence must not be in it.
        expect(reference.startsWith(".fgc/")).toBe(false);
        expect(reference.startsWith("fgc-evidence/")).toBe(true);
        expect(existsSync(join(root, ...reference.split("/")))).toBe(true);

        // The real root, where a lock actually lives: an evidence file there is committable.
        const committable = await run(
          "git",
          ["check-ignore", "-q", join(PROVING_CASES, ...reference.split("/"))],
          { cwd: REPOSITORY_ROOT },
        ).then(
          () => false,
          () => true,
        );
        expect(committable, `fgc-evidence must not be ignored under a real project root`).toBe(true);
      } finally {
        await hook.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("reports a citation that does not resolve as a blocker, not as a fresh record", async () => {
    // The clean-checkout simulation: keep the lock, drop the evidence. Freshness is
    // unaffected — versions and fingerprints still match — so this is precisely the gap
    // where a lock could look verified while resting on bytes that never arrived.
    await withScratch(PROVING_CASES, async root => {
      const hook = await smokeHook();
      const decision = await decisionFile(runtimeObserved);
      try {
        const recorded = await cli(["record", "--project", root, "--runtime-smoke", hook.path, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const before = await cli(["status", "--project", root]);
        const beforeRecord = json<{ decisions: readonly { blockers: readonly string[]; unresolvedEvidence: readonly string[] }[] }>(before).decisions[0]!;
        expect(beforeRecord.unresolvedEvidence).toEqual([]);

        // Simulate the fresh checkout: the evidence never made it into the commit.
        const reference = probeLink((await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!)!;
        await rm(join(root, ...reference.split("/")), { force: true });

        const after = await cli(["status", "--project", root]);
        expect(after.code, "a missing citation is actionable").not.toBe(0);
        const afterRecord = json<{ decisions: readonly { freshness: string; blockers: readonly string[]; unresolvedEvidence: readonly string[] }[] }>(after).decisions[0]!;

        expect(afterRecord.unresolvedEvidence).toEqual([reference]);
        expect(afterRecord.blockers).toContain(`evidence-missing:${reference}`);
        // The point of the finding: freshness alone would have said this record was fine.
        expect(afterRecord.freshness).toBe("fresh");
      } finally {
        await hook.cleanup();
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("does not report a URL citation as missing, because it asserts somewhere unreachable", async () => {
    // The repository's own committed lock fixture cites runtime observations by URL. A
    // check that called those missing would be making a claim it cannot support.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        evidence: [{ kind: "runtime-observation", reference: "https://github.com/example/report.md" }],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const status = await cli(["status", "--project", root]);
        const record = json<{ decisions: readonly { unresolvedEvidence: readonly string[] }[] }>(status).decisions[0]!;
        expect(record.unresolvedEvidence).toEqual([]);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

describe("CLI contract: an unrecognised option is refused", () => {
  it("rejects a typo instead of silently falling back to a default", async () => {
    // The defect: a misspelled flag was stored as a key nobody reads, so the real option
    // stayed `undefined` and the command fell back to the shipped catalog. A decision that
    // a supplied listing *refused* was recorded successfully — the caller believed a real
    // listing had been consulted.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        for (const args of [
          ["probe", "--no-cach", "--project", root, "es-toolkit"],
          ["status", "--porject", root],
          ["record", "--project", root, "--decision", decision.path, "--extension-catlog=listing.json"],
          ["policy", "--nope"],
        ]) {
          const refused = await cli(args);
          expect(refused.code, `${args.join(" ")} must be refused`).not.toBe(0);
          expect(refused.stderr).toContain("Unknown option");
          expect(refused.stderr).not.toContain("at async");
        }
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("names the known options and treats an empty value as missing", async () => {
    await withScratch(PROVING_CASES, async () => {
      const refused = await cli(["policy", "--telemetry"]);
      expect(refused.code).not.toBe(0);
      // "Known options" is the fix for the failure mode: the caller can compare what they
      // typed against what exists, which a silent accept never let them do.
      expect(refused.stderr).toContain("--extension-catalog");

      // `--project=` resolves to the working directory, which is a default the caller did
      // not ask for — the same class of silent fallback as an omitted value.
      const empty = await cli(["status", "--project="]);
      expect(empty.code).not.toBe(0);
      expect(empty.stderr).toContain("needs a value");
    });
  }, CASE_TIMEOUT_MS);

  it("still accepts every documented option", async () => {
    // The guard must not reject the surface it exists to protect.
    await withScratch(PROVING_CASES, async root => {
      const decision = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const recorded = await cli(["record", "--json", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const status = await cli(["status", "--project", root]);
        expect(status.code, status.stderr).toBe(0);
        const policy = await cli(["policy"]);
        expect(policy.code, policy.stderr).toBe(0);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 5 — evidence is written only for an accepted decision, and only
// when its bytes match its name
// ---------------------------------------------------------------------------

/**
 * Evidence is a committable file, so *when* it is written matters as much as what it holds.
 *
 * The defect this covers is a side effect that moved from invisible to visible: while
 * evidence lived under an ignored directory, `audit` writing it merely filled scratch
 * space; once it became durable, the same write dirtied a working tree. A read-only command
 * has to stay read-only, and a refusal that says "nothing was written" has to be true.
 */
describe("CLI contract: evidence appears only when a decision is accepted", () => {
  async function evidenceFiles(example: string): Promise<readonly string[]> {
    return readdir(join(example, "fgc-evidence")).catch(() => []);
  }

  it("writes nothing for `audit`, which is the read-only counterpart", async () => {
    // Run against the real example root, because that is where evidence is committable —
    // inside the `.fgc/` scratch root the same file is invisible and the assertion would pass
    // whichever way the command behaved.
    const extensionExample = EXTENSION_QUERY;
    const before = await evidenceFiles(extensionExample);
    const decision = await decisionFile({
      packageName: "@tanstack/react-query",
      role: "cell-local-data-access",
      strategy: "extension",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
      extensionVersion: "5.102.8",
      rationale: "x",
    });
    try {
      const audited = await cli(["audit", "--project", extensionExample, "--decision", decision.path]);
      expect(audited.code, audited.stderr).toBe(0);
      expect(await evidenceFiles(extensionExample)).toEqual(before);
    } finally {
      await decision.cleanup();
    }
  }, CASE_TIMEOUT_MS);

  it("writes nothing when `record` is refused, so its 'Nothing was written' is true", async () => {
    const extensionExample = EXTENSION_QUERY;
    const before = await evidenceFiles(extensionExample);
    // A fabricated `libraryId`: refused by the conformance gate, which runs *after* the probe.
    const decision = await decisionFile({
      packageName: "@tanstack/react-query",
      role: "cell-local-data-access",
      strategy: "extension",
      libraryId: "completely-invented",
      globalName: "Invented",
      rationale: "x",
    });
    try {
      const refused = await cli(["record", "--project", extensionExample, "--decision", decision.path]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("Nothing was written");
      expect(await evidenceFiles(extensionExample), "a refused record must leave no orphan").toEqual(before);
    } finally {
      await decision.cleanup();
    }
  }, CASE_TIMEOUT_MS);
});

/**
 * A content address is a claim about bytes, not about a filename.
 *
 * The previous revision derived the path from the report's hash and then trusted `EEXIST` to
 * mean "the file already holds this content" — true of the name, false of whatever is
 * actually there. A committed evidence file that a merge resolved badly, a hand-edit, or a
 * directory at that path all satisfied it, and `status` checked only that the path existed.
 * Both now verify the bytes.
 */
describe("CLI contract: a content-addressed citation is verified, not assumed", () => {
  const decision = {
    packageName: "es-toolkit",
    role: "cell-local-ui",
    strategy: "inline",
  };

  /** Records once and returns the cited evidence reference. */
  async function recordOnce(root: string, file: { path: string }): Promise<string> {
    const recorded = await cli(["record", "--project", root, "--decision", file.path]);
    expect(recorded.code, recorded.stderr).toBe(0);
    const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
    return probeLink(record)!;
  }

  it("reports altered bytes as an integrity blocker rather than as resolved", async () => {
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));

        // Untouched: nothing to report.
        const clean = await cli(["status", "--project", root]);
        expect(json<{ decisions: readonly { alteredEvidence: readonly string[]; unresolvedEvidence: readonly string[] }[] }>(clean).decisions[0]!.alteredEvidence).toEqual([]);

        await writeFile(absolute, '{"tampered":true}\n', "utf8");

        const tampered = await cli(["status", "--project", root]);
        expect(tampered.code, "altered evidence is actionable").not.toBe(0);
        const finding = json<{ decisions: readonly { alteredEvidence: readonly string[]; unresolvedEvidence: readonly string[]; blockers: readonly string[] }[] }>(tampered).decisions[0]!;

        expect(finding.alteredEvidence).toEqual([reference]);
        // Distinct from "missing": the file is there, and what is there is not what was measured.
        expect(finding.unresolvedEvidence).toEqual([]);
        expect(finding.blockers).toContain(`evidence-integrity-mismatch:${reference}`);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("treats a directory at the evidence path as unresolved rather than as present", async () => {
    // `existsSync` is what "resolved" used to mean, and a directory satisfies it while holding
    // no report at all — the same class of assumption as trusting `EEXIST`.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));
        await rm(absolute, { force: true });
        await mkdir(absolute, { recursive: true });

        const status = await cli(["status", "--project", root]);
        expect(status.code).not.toBe(0);
        const finding = json<{ decisions: readonly { alteredEvidence: readonly string[]; unresolvedEvidence: readonly string[] }[] }>(status).decisions[0]!;
        expect(finding.unresolvedEvidence).toEqual([reference]);
        expect(finding.alteredEvidence).toEqual([]);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses to cite a path that does not hold this report, instead of accepting it", async () => {
    // The acceptance-check half. Accepting the existing file is what would silently attach the
    // wrong content to a new record, and it would do so under a message reporting success. The
    // refusal now happens before any write, reported under the unified `problems` key.
    //
    // Two distinct findings, because the comparison now parses before it compares: content that
    // is not a report at all fails validation, while a report whose fields differ canonicalizes
    // to other bytes. Neither may be accepted, and they are not the same message.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));
        const original = await readFile(absolute, "utf8");

        await writeFile(absolute, "not a report\n", "utf8");
        const invalid = await cli(["record", "--project", root, "--decision", file.path]);
        expect(invalid.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(invalid).problems.join(" ")).toContain("does not hold a valid probe report");
        expect(invalid.stderr).toContain("Nothing was written");

        // A well-formed report whose content changed: same shape, different canonical bytes.
        const altered = JSON.parse(original) as { environment: { packageVersion: string } };
        altered.environment.packageVersion = "9.9.9";
        await writeFile(absolute, `${JSON.stringify(altered, null, 2)}\n`, "utf8");

        const changed = await cli(["record", "--project", root, "--decision", file.path]);
        expect(changed.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(changed).problems.join(" ")).toContain("already exists with different content");

        // Still present: the preflight is not the only guard, it just refuses earlier.
        expect(existsSync(absolute)).toBe(true);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("reuses an identical report's path without rewriting it", async () => {
    // The other direction, so the integrity check is not simply refusing every second write:
    // same report, same address, and the run reports that it created nothing.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const first = await cli(["record", "--project", root, "--decision", file.path]);
        expect(json<{ evidence: { created: boolean } }>(first).evidence.created).toBe(true);

        const second = await cli(["record", "--project", root, "--decision", file.path]);
        expect(second.code, second.stderr).toBe(0);
        expect(json<{ evidence: { created: boolean } }>(second).evidence.created).toBe(false);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 6 — the acceptance checks include the candidate lock's own validation
// ---------------------------------------------------------------------------

/**
 * `writeFgcLock` refuses any document `validateFgcLockDocument` rejects, and that validator
 * knows rules the conformance audit does not restate — #8's requirement that an `extension`
 * or `replace` decision carry a written rationale, for instance.
 *
 * The acceptance checks stopped short of it, which produced two symptoms from one cause:
 * `audit` reported `recordable: true` for a decision the write then refused, and `record`
 * created durable evidence **before** that refusal, leaving an orphan under a message saying
 * nothing had been written. Both are asserted here through a single decision file — a legal
 * `extension` decision that only omits its `rationale`.
 */
describe("CLI contract: audit and record apply the same checks, including the lock's own", () => {
  /** A decision that is legal in every respect except the missing written justification. */
  const extensionWithoutRationale = {
    packageName: "@tanstack/react-query",
    role: "cell-local-data-access",
    strategy: "extension",
    libraryId: "tanstack-query",
    globalName: "TanStackQuery",
    extensionVersion: "5.102.8",
  };

  const extensionWithRationale = {
    ...extensionWithoutRationale,
    rationale: "A bundled copy would give every Cell its own QueryClient, so the shared page global is required.",
  };

  it("refuses it in `audit`, naming the rule, instead of reporting it recordable", async () => {
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(extensionWithoutRationale);
      try {
        const audited = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(audited.code, "a decision the write would refuse must not audit clean").not.toBe(0);

        const payload = json<{ recordable: boolean; problems: readonly string[] }>(audited);
        expect(payload.recordable).toBe(false);
        // The rule is named, so the caller knows what to add rather than that something failed.
        expect(payload.problems.join(" ")).toContain("rationale");

        // And the same decision with its rationale is accepted, so this is not refusing the shape.
        const fixed = await decisionFile(extensionWithRationale);
        try {
          const clean = await cli(["audit", "--project", root, "--decision", fixed.path]);
          expect(clean.code, clean.stderr).toBe(0);
          expect(json<{ recordable: boolean }>(clean).recordable).toBe(true);
        } finally {
          await fixed.cleanup();
        }
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses it in `record` with nothing written — no lock and no evidence", async () => {
    // The orphan is the part that matters: evidence is a committable file, so creating one for
    // a decision nobody accepted dirties a working tree under a message denying it happened.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(extensionWithoutRationale);
      try {
        const refused = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("Nothing was written");
        expect(refused.stderr).not.toContain("at async");

        expect(existsSync(join(root, "fgc.lock.json")), "no lock").toBe(false);
        expect(await readdir(join(root, "fgc-evidence")).catch(() => []), "no orphan evidence").toEqual([]);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("records the same decision once the rationale is present", async () => {
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(extensionWithRationale);
      try {
        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "@tanstack/react-query")!;
        expect(record.strategy).toBe("extension");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(true);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still refuses conformance problems, which is the other half of the same list", async () => {
    // The two audits now run together, so this pins that adding the lock validator did not
    // displace the conformance one.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile({
        ...extensionWithRationale,
        libraryId: "completely-invented",
        globalName: "Invented",
      });
      try {
        const refused = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(refused.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(refused).problems.join(" ")).toContain("extension-library-mismatch");

        const audited = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(audited.code).not.toBe(0);
        expect(json<{ recordable: boolean }>(audited).recordable).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 7 — the evidence path is part of whether a decision is ready
// ---------------------------------------------------------------------------

/**
 * The evidence path is a precondition `record` checks by reading, so `audit` has to check it
 * too.
 *
 * This is the third instance of one pattern rather than a new kind of defect: each round
 * added the check that had been missing, and the rule is that anything `record` refuses for a
 * reason it can determine by *reading* belongs in the acceptance checks — otherwise `audit`
 * reports a decision ready that the write then refuses, which is the disagreement every one of
 * these rounds has been about.
 *
 * The reproducible path: `probe` computes the address an accepted record would cite without
 * writing anything, so a caller can observe it; then place wrong bytes (or a directory) there;
 * then a legal decision audits clean even though its citation can never be satisfied.
 */
describe("CLI contract: audit checks the evidence path too", () => {
  const legalExtension = {
    packageName: "@tanstack/react-query",
    role: "cell-local-data-access",
    strategy: "extension",
    libraryId: "tanstack-query",
    globalName: "TanStackQuery",
    extensionVersion: "5.102.8",
    rationale: "A bundled copy would give every Cell its own QueryClient, so the shared page global is required.",
  };

  it("refuses when the path it would cite already holds different bytes", async () => {
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(legalExtension);
      try {
        // The address comes from `probe`, which measures only — the path is computable before
        // anything is written, which is exactly why the check belongs on the read side.
        const probed = json<{ evidencePath: string }>(await cli(["probe", "--project", root, "@tanstack/react-query"]));
        const occupied = join(root, ...probed.evidencePath.split("/"));
        await mkdir(dirname(occupied), { recursive: true });
        await writeFile(occupied, "not a probe report\n", "utf8");

        const audited = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(audited.code, "a citation that cannot be satisfied must not audit clean").not.toBe(0);
        const payload = json<{ recordable: boolean; problems: readonly string[] }>(audited);
        expect(payload.recordable).toBe(false);

        // And `record` refuses for the same reason, in the same words — so the two agree.
        const refused = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("Nothing was written");
        const reason = payload.problems.find(problem => problem.includes("does not hold a valid probe report"));
        expect(reason, "audit names the invalid report").toBeDefined();
        expect(json<{ problems: readonly string[] }>(refused).problems).toContain(reason);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses when the path it would cite is a directory", async () => {
    // A directory is not "absent" — `writeFile` cannot replace it — and `existsSync` alone
    // would call it present.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(legalExtension);
      try {
        const probed = json<{ evidencePath: string }>(await cli(["probe", "--project", root, "@tanstack/react-query"]));
        await mkdir(join(root, ...probed.evidencePath.split("/")), { recursive: true });

        const audited = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(audited.code).not.toBe(0);
        expect(json<{ recordable: boolean }>(audited).recordable).toBe(false);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("stays recordable when the path is free, and after `record` fills it", async () => {
    // The other direction, so the preflight is not simply refusing whenever a path exists:
    // absent is the ordinary case, and `record` is what makes it present.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile(legalExtension);
      try {
        const before = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(before.code, before.stderr).toBe(0);
        expect(json<{ recordable: boolean }>(before).recordable).toBe(true);

        const recorded = await cli(["record", "--project", root, "--decision", decision.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        expect(json<{ evidence: { created: boolean } }>(recorded).evidence.created).toBe(true);

        // Now the path holds exactly this report, which is the other acceptable state.
        const after = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(after.code, after.stderr).toBe(0);
        expect(json<{ recordable: boolean }>(after).recordable).toBe(true);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("leaves an architectural rejection alone, since it cites no probe report", async () => {
    // The preflight needs a report; a rejection has none, and inventing one to check would
    // fail a decision that is entirely correct.
    await withScratch(EXTENSION_QUERY, async root => {
      const decision = await decisionFile({
        packageName: "react-router-dom",
        role: "application-navigation",
        strategy: "replace",
        rationale: "Navigation and browser history belong to the Forguncy application shell.",
      });
      try {
        const audited = await cli(["audit", "--project", root, "--decision", decision.path]);
        expect(audited.code, audited.stderr).toBe(0);
        expect(json<{ recordable: boolean }>(audited).recordable).toBe(true);
      } finally {
        await decision.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 8 — the content address is defined over the canonical report
// ---------------------------------------------------------------------------

/**
 * An evidence address must not depend on the reader's Git configuration.
 *
 * `serializeProbeReport` emits LF, and the address is the hash of that string. `status` used to
 * re-hash the working-tree *bytes*, and `evidencePreflight` compared raw bytes — so Git's
 * `core.autocrlf=true`, which rewrites text files to CRLF on checkout, reported a
 * false `evidence-integrity-mismatch` for a file nobody had edited. The repository has no
 * `.gitattributes` fixing those files, and it already carries a known Windows CRLF-fixture
 * failure, so a design that depends on the consumer's Git configuration is the wrong one.
 *
 * The address is now defined over the **canonical report**: an EOL change does not alter what
 * the document means, so it does not alter the address. Tampering still shows, because the
 * content is parsed and re-serialized — anything that is not a well-formed report fails, and any
 * altered field changes the canonical bytes.
 *
 * These tests simulate the checkout conversion directly rather than relying on the machine's
 * `core.autocrlf`, so they mean the same thing on CI as locally.
 */
describe("CLI contract: a CRLF checkout is not a content mismatch", () => {
  const decision = { packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" };

  /** The CRLF conversion Git performs on a text file under `core.autocrlf=true`. */
  async function asCheckedOutByWindowsGit(path: string): Promise<void> {
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
  }

  async function recordOnce(root: string, file: { path: string }): Promise<string> {
    const recorded = await cli(["record", "--project", root, "--decision", file.path]);
    expect(recorded.code, recorded.stderr).toBe(0);
    const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
    return probeLink(record)!;
  }

  it("leaves status, audit and record agreeing after the file is converted", async () => {
    // All three consumers, because each one compared differently: `status` hashed the raw bytes,
    // `audit` compared them for equality, and `record` reused the `evidencePreflight` rule.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));
        await asCheckedOutByWindowsGit(absolute);
        expect(await readFile(absolute, "utf8")).toContain("\r\n");

        const status = await cli(["status", "--project", root]);
        const finding = json<{ decisions: readonly { alteredEvidence: readonly string[]; unresolvedEvidence: readonly string[] }[] }>(status).decisions[0]!;
        expect(finding.alteredEvidence, "a re-checkout is not an edit").toEqual([]);
        expect(finding.unresolvedEvidence).toEqual([]);

        const audited = await cli(["audit", "--project", root, "--decision", file.path]);
        expect(audited.code, audited.stderr).toBe(0);
        expect(json<{ recordable: boolean }>(audited).recordable).toBe(true);

        // Re-recording reuses the file rather than refusing it: same report, same address.
        const rerecorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(rerecorded.code, rerecorded.stderr).toBe(0);
        expect(json<{ evidence: { created: boolean } }>(rerecorded).evidence.created).toBe(false);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still detects tampering through the canonical form", async () => {
    // The property the tolerance must not have cost. A file that parses but says something else
    // canonicalizes to different bytes; a file that is not a report at all fails to parse. Both
    // are mismatches.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));

        for (const replacement of ['{"tampered":true}\n', "not a report at all\n"]) {
          await writeFile(absolute, replacement, "utf8");
          const status = await cli(["status", "--project", root]);
          expect(status.code, `${replacement.trim()} must be reported`).not.toBe(0);
          const finding = json<{ decisions: readonly { alteredEvidence: readonly string[] }[] }>(status).decisions[0]!;
          expect(finding.alteredEvidence).toEqual([reference]);

          const refused = await cli(["record", "--project", root, "--decision", file.path]);
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain("Nothing was written");
        }
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("keeps the address stable across the conversion, so the citation still matches", async () => {
    // The deeper property: the address is a function of the report, not of the file's bytes on
    // disk. Converting the file must not change what the lock should cite.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision);
      try {
        const reference = await recordOnce(root, file);
        const absolute = join(root, ...reference.split("/"));
        const before = await readFile(absolute, "utf8");

        await asCheckedOutByWindowsGit(absolute);

        // The lock still cites the same path, and that path still verifies — which is only
        // possible because the address is over the canonical report.
        const after = await cli(["status", "--project", root]);
        const finding = json<{ decisions: readonly { alteredEvidence: readonly string[] }[] }>(after).decisions[0]!;
        expect(finding.alteredEvidence).toEqual([]);
        expect(probeLink((await readLock(root)).decisions[0]!)).toBe(reference);

        // And the two files differ only in EOL, which is what makes this a real test.
        expect(before).not.toBe(await readFile(absolute, "utf8"));
        expect(before.replace(/\r\n/g, "\n")).toBe((await readFile(absolute, "utf8")).replace(/\r\n/g, "\n"));
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Review round 9 — the rollback depends on the writer being atomic
// ---------------------------------------------------------------------------

/**
 * The CLI's evidence rollback reads a throw from `writeFgcLock` as "the lock is unchanged", so
 * the lock writer has to actually guarantee that.
 *
 * `writeFile(path, …)` opens the target with `w`, truncating it before a byte is written: a
 * failure part-way through leaves a partial lock. Deleting the evidence this run created on
 * that reading would then produce the worst of both — a damaged lock, evidence rolled back, and
 * a message claiming nothing was written. `writeFgcLock` now stages the bytes in a sibling
 * temporary file and `rename`s it over the target, so the target holds either the old document
 * or the new one.
 *
 * **Where atomicity itself is proven:** `packages/dependency-resolver/src/lock-store.test.ts`,
 * where a `writeFile` that truncates its target before throwing can be injected. The failure
 * used here — a read-only lock — cannot prove it, because `open` fails before anything is
 * truncated, so these tests pass against the old non-atomic writer too. They are kept for the
 * CLI half they *do* pin: after a failed write the evidence this run created is gone, the
 * evidence a previous run left is not, the lock bytes are unchanged, and nothing is left behind.
 */
describe("CLI contract: the lock write leaves no debris behind", () => {
  /**
   * A narrower claim than atomicity, and deliberately so.
   *
   * **Where atomicity is proven:** `packages/dependency-resolver/src/lock-store.test.ts`, which
   * injects a `writeFile` that truncates its target before throwing — the behaviour a mid-write
   * I/O failure produces. That injection needs the module seam, which the CLI does not have.
   * An earlier version of this suite tried to force the failure from outside by making the lock
   * read-only; it passed on Windows and **failed on CI**, because `rename` needs write permission
   * on the *parent directory* on Linux but on the *target file* on Windows. A test whose
   * injection is platform-dependent is worse than no test, so that case now lives where the
   * failure can be injected portably.
   *
   * What remains here is the observation the CLI can make on a successful write: nothing is left
   * beside the lock, and the lock is written where the read path expects it.
   */
  const decision = (packageName: string) => ({ packageName, role: "cell-local-ui", strategy: "inline" });

  it("leaves no staging file beside the lock after a successful write", async () => {
    // The temporary file is an implementation detail a caller must never have to clean up, and a
    // stray one beside a lock is a file a reviewer would have to explain.
    await withScratch(PROVING_CASES, async root => {
      const file = await decisionFile(decision("es-toolkit"));
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        // `.fgc/` is the probe engine's own scratch — not this command's, and not evidence.
        const entries = (await readdir(root)).filter(name => name !== "node_modules" && name !== ".fgc").sort();
        expect(entries).toEqual(["fgc-evidence", "fgc.lock.json"]);
        expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});
