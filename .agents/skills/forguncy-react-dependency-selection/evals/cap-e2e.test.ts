/**
 * `--cell` end to end: the project's own declared cap reaches the CLI path.
 *
 * Decision source: GitHub Issue #77 — "Implement: align the dependency selection path with
 * #21's measured character-based cell-code bands"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/77), review of PR #78 (P1).
 *
 * ## The gap this covers
 *
 * #77 gave `RunDependencyProbeOptions` a `cellArtifactBudgetCharacters` input and gave the
 * probe a `size` step that rejects on it. The Skill — the one path an Agent actually
 * drives — never supplied it, so `budgetCharacters` was always `null` there: the band was
 * reported and a `cell-artifact-budget-exceeded` rejection was unreachable from the
 * command line. A capability only tests could reach is not wired.
 *
 * `--cell` closes it, and the shape is deliberate: the cap is **read from the project's
 * `forguncy.config`** rather than accepted as a number, because the compiler reads its own
 * cap from that same declaration. A flag carrying a loose number would let the probe and
 * the compile disagree about the ceiling, which is the drift #77 exists to remove.
 *
 * ## Why these cases live beside `cli-contract.test.ts` rather than inside it
 *
 * They need a project that *declares* a Cell. The scratch roots `cli-contract.test.ts`
 * builds are `.fgc/` directories with no config of their own, and the ancestor walk that
 * resolves the candidate's install graph does not invent a registry — so the fixture here
 * writes a config, a manifest and a Cell entry inside a committed example's git-ignored
 * `.fgc/`. That keeps the candidate (`es-toolkit`, installed in `examples/probe-proving-cases`
 * and reachable by the same walk) resolvable and the working tree clean.
 *
 * ## What each case can fail on
 *
 * 1. the cap is reported as a fact **and** composed into the fingerprint — the half that
 *    fails if the cap reaches `observeSize` but not `composeProbeFingerprint`;
 * 2. no cap means advisory-only, and the cap-free fingerprint is unchanged — the half that
 *    fails if a Cell merely existing invalidates every pre-#77 record;
 * 3. an undeclared `--cell` is refused with the config named — the half that fails if the
 *    cap silently becomes `null` for a typo, which is indistinguishable from "no cap";
 * 4. `--cell` and the decision file's `cellTarget` cannot disagree — one Cell identity;
 * 5. `record` writes the cap and `status` re-derives it, so an unchanged config is `fresh`
 *    and a moved cap is reported.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..");
const CLI = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  "forguncy-react-dependency-selection",
  "scripts",
  "select_dependency.mjs",
);
const PROVING_CASES = join(REPOSITORY_ROOT, "examples", "probe-proving-cases");

/** Each case runs a real Rolldown build of a published package. */
const CASE_TIMEOUT_MS = 120_000;

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI as a child process: the only way to observe the exit code and the bytes written. */
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

async function scratchRoot(example: string): Promise<string> {
  const parent = join(example, ".fgc");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "cap-e2e-"));
}

/** Removes a scratch root and the `.fgc/` parent this file created for it. */
async function removeScratch(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  const parent = dirname(root);
  const remaining = await import("node:fs/promises").then(module => module.readdir(parent).catch(() => null));
  if (remaining !== null && remaining.length === 0) {
    await rm(parent, { recursive: true, force: true });
  }
}

/** Writes a decision file outside the project root, so a probe never mistakes it for source. */
async function decisionFile(
  contents: Record<string, unknown>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "fgc-cap-decision-"));
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify(contents, null, 2), "utf8");
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

interface LockRecord {
  readonly packageName: string;
  readonly cellTarget: string | null;
  readonly imports?: readonly string[] | null;
  readonly artifactEvidence?: {
    readonly compileFingerprint: string;
    readonly subjectDecision?: { readonly strategy: string };
    readonly subjectRenderedCharacters: number;
    readonly codeCharacters: number;
    readonly budgetCharacters: number;
  };
  readonly probe: { readonly status: string; readonly fingerprint: string | null };
}

async function readLock(root: string): Promise<{ decisions: readonly LockRecord[] }> {
  return JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as { decisions: readonly LockRecord[] };
}

/**
 * A minimal project declaring **two** Cells with different caps, under an example's `.fgc/`.
 *
 * Two rather than one because the defect this exists for is only visible with two records for
 * one package: a single-Cell project cannot tell a per-record assessment apart from a
 * per-package one, and would pass against the bug.
 *
 * The caps are met (`900_000`, `950_000`) rather than exceeded, because `record` refuses an
 * `inline` decision whose probe rejects — the size rejection is `replace`-shaped evidence, and
 * `auditSelectionDecision` requires a passing probe for `inline`. The fingerprints still differ,
 * which is all this case needs: the cap is a declared input whatever its value.
 */
async function withTwoCappedCells<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await scratchRoot(PROVING_CASES);
  try {
    await mkdir(join(root, "cells", "bench", "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "two-capped-cells", version: "0.0.0", private: true, type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      join(root, "forguncy.config.ts"),
      [
        'import { defineForguncyConfig } from "@forguncy-react-workspace/core";',
        "",
        "export default defineForguncyConfig({",
        '  runtime: { forguncyVersion: "12.0.100" },',
        "  cells: {",
        "    alpha: {",
        '      entry: "./cells/bench/src/App.tsx",',
        '      target: { pageName: "Bench", cell: "A1" },',
        '      output: { codeBudgetCharacters: 900000, justification: "cap-e2e fixture" },',
        "    },",
        "    beta: {",
        '      entry: "./cells/bench/src/App.tsx",',
        // A distinct target: one Cell owns one Forguncy target, and two Cells claiming
        // `Bench!A1` is refused by the config validator before any cap is read.
        '      target: { pageName: "Bench", cell: "B2" },',
        '      output: { codeBudgetCharacters: 950000, justification: "cap-e2e fixture" },',
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    return await body(root);
  } finally {
    await removeScratch(root);
  }
}

/**
 * A minimal project that declares one Cell, optionally with a cap, under an example's `.fgc/`.
 *
 * `cap === null` declares the Cell with no `output` block at all — the state a project that
 * has adopted the contract but set no ceiling is in, which is what "no cap" has to mean.
 */
async function withCappedCell<T>(cap: number | null, body: (root: string) => Promise<T>): Promise<T> {
  const root = await scratchRoot(PROVING_CASES);
  try {
    await mkdir(join(root, "cells", "bench", "src"), { recursive: true });
    // A real entry: the compile-evidence path *builds* this Cell, so the fixture has to have
    // something to build. Small enough to compile in a test, large enough to exceed a tight cap.
    // A real entry that *imports the subject*: a size rejection claims this package is what puts
    // the Cell over its cap, and the attribution rule refuses a rejection for a package the Cell
    // does not carry. An entry that merely renders its own markup would make every rejection here
    // unattributable — correct, but not what these cases are about.
    await writeFile(
      join(root, "cells", "bench", "src", "App.tsx"),
      [
        'import { chunk, debounce, groupBy, orderBy, uniqBy, zip } from "es-toolkit";',
        "",
        'const rows = orderBy(chunk(zip(uniqBy(groupBy([1, 2, 3], String), Number), ["a", "b"]), 3), [0]);',
        "const later = debounce(() => rows, 10);",
        "",
        "export default function App() {",
        "  return <ul>{later().map(row => <li key={String(row)}>{String(row)}</li>)}</ul>;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "capped-cell", version: "0.0.0", private: true, type: "module" }, null, 2),
      "utf8",
    );
    const output =
      cap === null
        ? ""
        : `\n      output: { codeBudgetCharacters: ${String(cap)}, justification: "cap-e2e fixture" },`;
    await writeFile(
      join(root, "forguncy.config.ts"),
      [
        'import { defineForguncyConfig } from "@forguncy-react-workspace/core";',
        "",
        "export default defineForguncyConfig({",
        '  runtime: { forguncyVersion: "12.0.100" },',
        "  cells: {",
        "    bench: {",
        '      entry: "./cells/bench/src/App.tsx",',
        '      target: { pageName: "Bench", cell: "A1" },' + output,
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    return await body(root);
  } finally {
    await removeScratch(root);
  }
}

/**
 * Writes a lock placing `es-toolkit` in the fixture's Cell.
 *
 * Called by the compile-evidence cases and not by the fixture, because those cases need it and the
 * refusal cases assert that no lock is left behind — an unconditional write made the fixture itself
 * look like a recorded decision. The compile-evidence path needs the record for a real reason: the
 * compile to reproduce is the one that *included* the package being rejected, and the round-5
 * attribution rule refuses a rejection for a package no Cell record places here.
 */
/**
 * Adds a second declared Cell with its own cap, over the same source as `bench`.
 *
 * Distinct caps are what make the two records' compile identities differ, which is the property the
 * per-record keying exists for. A distinct Forguncy target, because one Cell owns one target.
 */
async function writeSecondCappedCell(root: string, cap: number): Promise<void> {
  const config = await readFile(join(root, "forguncy.config.ts"), "utf8");
  await writeFile(
    join(root, "forguncy.config.ts"),
    config.replace(
      "    },\n  },\n});",
      `    },\n    second: {\n      entry: "./cells/bench/src/App.tsx",\n      target: { pageName: "Second", cell: "B2" },\n      output: { codeBudgetCharacters: ${String(cap)}, justification: "cap-e2e fixture" },\n    },\n  },\n});`,
    ),
    "utf8",
  );
}

/** Adds the `second` Cell's own record for the subject, so its compile can include it. */
async function writeSecondCellRecord(root: string): Promise<void> {
  const lock = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
    decisions: Record<string, unknown>[];
  };
  lock.decisions.push({ ...lock.decisions[0], cellTarget: "second" });
  await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock, null, 2), "utf8");
}

async function withRecordedCell(root: string): Promise<void> {
  await writeFile(
    join(root, "fgc.lock.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        decisions: [
          {
            packageName: "es-toolkit",
            cellTarget: "bench",
            imports: null,
            strategy: "inline",
            resolvedVersion: "1.39.8",
            globalName: null,
            libraryId: null,
            probe: { status: "passed", fingerprint: "probe=\"inline-bundle\";entry=\"es-toolkit\";analysis=14", versionIndependent: false },
            target: null,
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [{ kind: "probe", reference: "fgc-evidence/fixture.json" }],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface ProbePayload {
  readonly fingerprint: string;
  readonly facts: readonly { readonly name: string; readonly value: unknown }[];
  readonly rejectionFindings: readonly { readonly signal: string }[];
}

interface ProbePayload {
  readonly fingerprint: string;
  readonly facts: readonly { readonly name: string; readonly value: unknown }[];
  readonly rejectionFindings: readonly { readonly signal: string }[];
}

describe("CLI contract: the declared cell code cap reaches probe, audit, record and status", () => {
  // Chosen either side of a real `es-toolkit` artifact (~226k characters): one cap is far
  // under it, the other comfortably over, so both outcomes are observable on one candidate.
  const CAP_EXCEEDED = 1_000;
  const CAP_MET = 900_000;
  /**
   * A cap the subject is actually *responsible* for exceeding.
   *
   * The compile-evidence cases need one, and the reason is the attribution rule: `CAP_EXCEEDED`
   * (1,000) is below the Cell's own banner and wrapper, so the composed Cell is over it with or
   * without the subject — a rejection measured against it is correctly refused as unattributable.
   * Between the without-subject size (~4.4k, mostly the generated wrapper) and the with-subject size
   * (~15k, mostly `es-toolkit`), the subject is what makes the difference.
   */
  const CAP_SUBJECT_DECIDES = 8_000;

  it("shows the declared cap as a fact and folds it into the fingerprint, without rejecting", async () => {
    await withCappedCell(CAP_EXCEEDED, async root => {
      // #77 revision 13: no probe run files the cap verdict, under any surface. Both are
      // exercised here because revision 12 filed on the named one and this revision retracts
      // that — the probe's build and the compiler's do not share a resolution graph.
      for (const extra of [[], ["--imports", "debounce"]]) {
        const probed = await cli(["probe", "--project", root, "--cell", "bench", ...extra, "es-toolkit"]);
        expect(probed.code, probed.stderr).toBe(0);
        const report = json<ProbePayload>(probed);
        const where = extra.length === 0 ? "namespace" : "named";

        // The cap is reported, so a caller can see which ceiling was applied.
        expect(report.facts.find(fact => fact.name === "artifact.budgetCharacters")?.value, where).toBe(CAP_EXCEEDED);
        // It is a *declared input*, so it has to compose into the fingerprint — otherwise a
        // record measured under one cap would look fresh under another.
        expect(report.fingerprint, where).toContain('"budgetCharacters":1000');
        // …and the verdict is the compiler's, so no probe run files it.
        expect(report.rejectionFindings.map(finding => finding.signal), where).not.toContain(
          "cell-artifact-budget-exceeded",
        );
        expect(report.validation.find(entry => entry.step === "size")?.detail, where).toMatch(/not a cap verdict/);
      }
    });
  }, CASE_TIMEOUT_MS);

  it("still leans the estimate by the declared surface, which no longer authorizes a rejection", async () => {
    // The leaning survives because it makes the number interpretable, and the *lower* lean is
    // the one to check: it is the direction revision 12 treated as provable, so a regression
    // back to filing on it would show up here rather than only in the unit tests.
    await withCappedCell(CAP_EXCEEDED, async root => {
      const named = await cli(["probe", "--project", root, "--cell", "bench", "--imports", "debounce", "es-toolkit"]);
      expect(named.code, named.stderr).toBe(0);
      const report = json<ProbePayload>(named);

      expect(report.facts.find(fact => fact.name === "size.estimateBias")?.value).toBe("lower-leaning");
      expect(report.rejectionFindings.map(finding => finding.signal)).not.toContain("cell-artifact-budget-exceeded");
    });
  }, CASE_TIMEOUT_MS);

  // PR review of #77, P1 (rounds 4-5). Revision 13 removed the only path that could *record* a size
  // rejection — the probe cannot prove one. Revision 14 gave the rejection a route through the
  // compiler's own diagnostic; revision 15 made the CLI run that compiler rather than accept the
  // numbers from the deciding file. These cases cover the resulting path end to end.
  it("records a compile-observed size rejection the CLI produced, and `status` verifies it", async () => {
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      // The decision file states *which* rejection it is and carries no measurement: a rejection
      // certified by numbers the deciding file chose is the evidence revision 13 removed.
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The composed Cell exceeds the cap this Cell declares.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's declared cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        // The evidence is the compiler's: real character counts for the Cell this fixture declares,
        // and an identity composed from the entry, the Cell's decisions and the cap.
        expect(record.artifactEvidence?.budgetCharacters).toBe(CAP_SUBJECT_DECIDES);
        expect(record.artifactEvidence?.codeCharacters).toBeGreaterThan(CAP_SUBJECT_DECIDES);
        expect(record.artifactEvidence?.compileFingerprint).toMatch(/^cell="[0-9a-f]{64}";budget=\d+$/);

        // `status` recompiles the Cell's identity and finds it unchanged, so the record verifies —
        // the profile whose probe requirement is *passed*, because the package builds cleanly and
        // the composed Cell is what exceeds the cap.
        const status = await cli(["status", "--project", root]);
        const decision = json<{ decisions: readonly { freshness: string; stalenessReasons: readonly string[]; profile: string }[] }>(status).decisions[0];
        expect(decision.profile).toBe("artifact-rejection");
        expect(decision.stalenessReasons).toEqual([]);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a decision file that supplies its own compile measurement", async () => {
    // The round-5 requirement in one assertion: the deciding file cannot manufacture the evidence.
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "Claimed a size with numbers of its own choosing.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "Claimed.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
        artifactEvidence: { compileFingerprint: "typed", codeCharacters: 5_000, budgetCharacters: 4_000 },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        // A malformed *file* is a usage error, so it is refused before any payload is printed —
        // asserted on stderr, which is where `fail()` writes, not on a JSON document.
        expect(recorded.code).not.toBe(0);
        expect(recorded.stderr).toMatch(/not the caller's to state/);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a size rejection whose Cell does not actually exceed its cap", async () => {
    // The CLI compiles the Cell, so a rejection the compile does not support is refused on the
    // compiler's own answer rather than on a number the file supplied. `CAP_MET` is far above this
    // fixture's composed size, so the compile fits and files no budget diagnostic.
    await withCappedCell(CAP_MET, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "Claims a size the Cell does not have.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "Claimed, but the Cell fits.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join("\n")).toMatch(/within the cap/);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  // PR review of #77, P1 (round 7). The record has to describe the compile it was measured from,
  // and re-recording is where that breaks: the first write turned the subject's decision into
  // `replace`, so reading the lock again would persist `subjectDecision: { strategy: "replace" }`
  // and destroy the field's whole purpose on the second write.
  // PR review of #77, P1 (round 8). `status` recompiled and compared the artifact fingerprint but
  // discarded the freshly-produced attribution, so a record could keep a real fingerprint beside a
  // doctored `subjectRenderedCharacters` and stay fresh. Reproduced before this was fixed.
  // PR review of #77, P1 (round 9). Round 8 stopped at the attribution; the two numbers that state
  // the hard rejection were still trusted, so a forged `codeCharacters` could make the lock report a
  // verified rejection the current compiler does not emit.
  it("goes stale when the recorded verdict numbers are doctored and the artifact is unchanged", async () => {
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        // Doctor ONLY the verdict pair: the fingerprint is real (the artifact genuinely is the one
        // it names) and the share is real, so nothing but a verdict comparison can notice.
        const lock = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
          decisions: Record<string, { artifactEvidence?: Record<string, unknown> }>[];
        };
        const evidence = lock.decisions.find(entry => (entry as { packageName?: string }).packageName === "es-toolkit")!.artifactEvidence!;
        evidence.codeCharacters = 9_000_000;

        await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock, null, 2), "utf8");
        const status = await cli(["status", "--project", root]);

        const decision = json<{ decisions: readonly { stalenessReasons: readonly string[] }[] }>(status).decisions[0];
        expect(decision.stalenessReasons).toContain("artifact-verdict-changed");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("goes stale when the recorded subject share is doctored and the artifact is unchanged", async () => {
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const before = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(before.artifactEvidence?.subjectRenderedCharacters).toBeGreaterThan(0);

        // Doctor ONLY the attribution: the fingerprint, the character count and the cap stay real,
        // so a fingerprint-only comparison cannot notice.
        const lock = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
          decisions: Record<string, { artifactEvidence?: Record<string, unknown> }>[];
        };
        const evidence = lock.decisions.find(entry => (entry as { packageName?: string }).packageName === "es-toolkit")!.artifactEvidence!;
        evidence.subjectRenderedCharacters = 1;

        await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock, null, 2), "utf8");
        const status = await cli(["status", "--project", root]);

        const decision = json<{ decisions: readonly { stalenessReasons: readonly string[] }[] }>(status).decisions[0];
        expect(decision.stalenessReasons).toContain("artifact-attribution-changed");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("preserves the subject's pre-rejection decision across a re-record", async () => {
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const first = await cli(["record", "--project", root, "--decision", file.path]);
        expect(first.code, first.stderr).toBe(0);
        expect((await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")?.artifactEvidence?.subjectDecision).toEqual({
          strategy: "inline",
        });

        // The re-record. The lock now says `replace` for this package, so a naive read would save
        // that as the subject's decision.
        const second = await cli(["record", "--project", root, "--decision", file.path]);
        expect(second.code, second.stderr).toBe(0);
        const evidence = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")?.artifactEvidence;
        expect(evidence?.subjectDecision).toEqual({ strategy: "inline" });
        // And the measurement is still real: the re-record recompiled with the replayed decision
        // rather than the `replace` the lock now holds.
        expect(evidence?.subjectRenderedCharacters).toBeGreaterThan(0);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  // PR review of #77, P2 (round 7). `record` measured the compile a moment earlier, so reporting the
  // record it just wrote as `artifact-compile-unknown` was a command contradicting its own work.
  it("reports the record it just wrote as fresh, without waiting for `status`", async () => {
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const payload = json<{ freshness: { freshness: string; stalenessReasons: readonly string[] } }>(recorded);
        expect(payload.freshness.stalenessReasons).not.toContain("artifact-compile-unknown");
        expect(payload.freshness.freshness).toBe("fresh");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  // PR review of #77, P1 (round 7). One compile identity cannot describe two records measured from
  // different states: `artifactFingerprints` is keyed by record identity, so each record is
  // assessed against its own replay rather than one shared Cell fingerprint.
  it("assesses two Cells' records against their own compile identities, not one shared Cell one", async () => {
    // Two Cells over the *same* source but with different caps, so their records carry different
    // identities. A Cell-keyed map could hold only one of them, and the other would be assessed
    // against a compile that is not its own.
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      await writeSecondCappedCell(root, 12_000);
      await writeSecondCellRecord(root);

      const second = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "second",
        rationale: "This Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", second.path]);
        expect(recorded.code, recorded.stderr).toBe(0);

        const status = await cli(["status", "--project", root]);
        const decisions = json<{ decisions: readonly { cellTarget: string | null; stalenessReasons: readonly string[] }[] }>(status).decisions;
        expect(decisions).toHaveLength(2);
        // Each record answers for its own identity. Asserted on the artifact axes rather than on
        // the whole reason list, because the fixture's probe fingerprint and recorded version are
        // placeholders — unrelated to the compile identity under test.
        for (const decision of decisions) {
          const artifactReasons = decision.stalenessReasons.filter(reason => reason.startsWith("artifact-compile-"));
          expect(artifactReasons, `cell ${String(decision.cellTarget)}`).toEqual([]);
        }
      } finally {
        await second.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses attribution when two decisions share one package root", async () => {
    // PR review of #77, P1 (round 7). The module graph reports rendered bytes per package, not per
    // specifier, and the compiler resolves an exact-subpath decision before the root — so which
    // record owns a shared root's bytes cannot be proved from the compile. Refused rather than
    // guessed: crediting the root with a subpath's code is the misattribution this evidence exists
    // to prevent, and reporting zero to the subpath makes a real rejection unattributable forever.
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      const lock = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
        decisions: Record<string, unknown>[];
      };
      lock.decisions.push({ ...lock.decisions[0], packageName: "es-toolkit/compat" });
      await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock, null, 2), "utf8");

      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "Rejects the root while a subpath decision also applies.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join("\n")).toMatch(
          /also applies to that Cell under the same package root/,
        );
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("applies a target-independent decision to the Cell, and folds it into the identity", async () => {
    // PR review of #77, P1 (round 6). A `cellTarget: null` record means "applies to **every** Cell",
    // and the effective decision set has to be resolved the way the compiler's own projection
    // resolves it — exact target first, then the null fallback. Filtering records by exact target
    // dropped every target-independent decision, so a Cell whose React mapping is declared globally
    // would have had that mapping omitted from the evidence compile (and from the fingerprint),
    // reintroducing the very failure revision 13 removed: the probe-style compile bundling npm React
    // where the real compile applies the host bridge.
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      await withRecordedCell(root);
      // The host decision for `react` is recorded with NO cell target.
      const lock = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
        decisions: Record<string, unknown>[];
      };
      lock.decisions.push({
        packageName: "react",
        cellTarget: null,
        imports: null,
        strategy: "host",
        resolvedVersion: "19.2.7",
        globalName: "React",
        libraryId: null,
        probe: { status: "passed", fingerprint: "probe=fixture", versionIndependent: false },
        target: null,
        probedWith: { vitePlus: null },
        extension: null,
        rejectedCandidate: null,
        rationale: null,
        evidence: [{ kind: "probe", reference: "fgc-evidence/fixture.json" }],
      });
      await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock, null, 2), "utf8");

      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "The Cell is over its cap because of this package.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "The composed Cell is over this Cell's cap.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        // The record succeeds, which is the assertion that matters: the compile could only run with
        // the target-independent `react` decision resolved (a bare React import with no decision is
        // an unresolved dependency), so reaching a recorded record proves it was applied.
        expect(recorded.code, recorded.stderr).toBe(0);
        // And it participates in freshness: changing the target-independent decision must move the
        // identity, or a later edit to it would leave this rejection reporting `fresh`.
        const before = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        const fingerprintBefore = before.artifactEvidence?.compileFingerprint;
        expect(fingerprintBefore).toBeDefined();

        const relocked = JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
          decisions: Record<string, unknown>[];
        };
        const reactRecord = relocked.decisions.find(entry => entry.packageName === "react")!;
        // Same strategy, different global: the decision still resolves `react` to a page object, but
        // a different one — so the composed Cell differs and the identity has to as well.
        reactRecord.globalName = "ReactDOM";
        await writeFile(join(root, "fgc.lock.json"), JSON.stringify(relocked, null, 2), "utf8");

        const status = await cli(["status", "--project", root]);
        const decision = json<{ decisions: readonly { packageName: string; stalenessReasons: readonly string[] }[] }>(status).decisions.find(
          entry => entry.packageName === "es-toolkit",
        )!;
        expect(decision.stalenessReasons).toContain("artifact-compile-changed");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a size rejection for a Cell the lock does not place the package in", async () => {
    // A package the lock does not put in this Cell is not in its graph, so no compile of that Cell
    // measured this package — the attribution the round-5 review asked to keep explicit.
    await withCappedCell(CAP_SUBJECT_DECIDES, async root => {
      // The lock records `es-toolkit`; the decision rejects `@embedpdf/pdfium`, which the fixture
      // declares but the Cell's record does not include. Both are installed, so the probe passes
      // and the refusal under test is the attribution rule rather than "not installed".
      await withRecordedCell(root);
      const file = await decisionFile({
        packageName: "@embedpdf/pdfium",
        role: "cell-local-ui",
        strategy: "replace",
        cellTarget: "bench",
        rationale: "Rejects a package the Cell never used.",
        alternatives: ["a lighter date utility"],
        rejection: {
          kind: "technical",
          code: "cell-code-budget-exceeded",
          summary: "Attributed to the wrong package.",
          evidence: [],
          remediation: "Evaluate a lighter alternative.",
        },
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code).not.toBe(0);
        expect(json<{ problems: readonly string[] }>(recorded).problems.join("\n")).toMatch(
          /no decision for "@embedpdf\/pdfium" applies to that Cell/,
        );
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);


  it("carries the declared surface into the record, and `status` rebuilds it from there", async () => {
    // The whole P1-c plumbing in one case, because each half is useless without the other: the
    // decision file's `imports` has to reach the probe (so the measurement is a lower bound), be
    // written onto the record (so a reader can tell which bound the size evidence rests on), and
    // be read back by `status` (so the rebuilt fingerprint is the one that was measured). Drop
    // any one and the record either loses its verdict or reports a change nobody made.
    await withCappedCell(CAP_MET, async root => {
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        imports: ["debounce"],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--cell", "bench", "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(record.imports).toEqual(["debounce"]);
        expect(record.probe.fingerprint).toContain('"imports":["debounce"]');

        // `status` reads `record.imports` back out and re-probes with it. Were it to rebuild as a
        // namespace run it would compose a different fingerprint and report a change nobody made.
        const stable = await cli(["status", "--project", root]);
        expect(stable.code, stable.stderr).toBe(0);
        expect(json<{ decisions: readonly { freshness: string }[] }>(stable).decisions[0]?.freshness).toBe("fresh");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a `--imports` and a decision file that name different surfaces", async () => {
    // Mirrors the `--cell` / `cellTarget` refusal below and for the same reason: one declared
    // input, one spelling. Whichever won, the record would carry a fingerprint for a surface
    // the other spelling did not name.
    await withCappedCell(CAP_MET, async root => {
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        imports: ["chunk"],
      });
      try {
        const refused = await cli([
          "record", "--project", root, "--cell", "bench", "--imports", "debounce", "--decision", file.path,
        ]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("debounce");
        expect(refused.stderr).toContain("chunk");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("stays advisory-only when the Cell declares no cap", async () => {
    // The complement, and the one that keeps #21's finding intact: a band is measured
    // evidence and never a rejection.
    await withCappedCell(null, async root => {
      const probed = await cli(["probe", "--project", root, "--cell", "bench", "es-toolkit"]);
      expect(probed.code, probed.stderr).toBe(0);
      const report = json<ProbePayload>(probed);

      // The band is still measured and still recorded…
      expect(report.facts.find(fact => fact.name === "size.band")?.value).toBeDefined();
      // …but with no cap there is nothing to exceed, so nothing is filed.
      expect(report.facts.some(fact => fact.name === "artifact.budgetCharacters")).toBe(false);
      expect(report.rejectionFindings.map(finding => finding.signal)).not.toContain("cell-artifact-budget-exceeded");
      // And the fingerprint is the cap-free one, so a Cell merely existing does not
      // invalidate every record written before it declared a cap.
      expect(report.fingerprint).toContain("config={}");
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a `--cell` the project does not declare, naming the Cell and the config", async () => {
    // A typo has to fail rather than quietly become "no cap": those two states produce
    // different verdicts on the same artifact, so a silent fallback is a wrong answer
    // wearing a success.
    await withCappedCell(CAP_MET, async root => {
      const refused = await cli(["probe", "--project", root, "--cell", "no-such-cell", "es-toolkit"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("no-such-cell");
      expect(refused.stderr).toContain("forguncy.config");
    });
  }, CASE_TIMEOUT_MS);

  it("applies the decision file's own `cellTarget` cap without any --cell on the command line", async () => {
    // The P1-a complement, and the direction the fix is actually about. `cellTargetFor` exists
    // because a file's `cellTarget` and `--cell` are two spellings of one identity, and the
    // defect was that only the flag reached the probe: a file scoped to `bench` probed
    // **uncapped**, wrote an uncapped fingerprint, and then scoped the record to `bench` — so
    // `status` reported `probe-fingerprint-changed` immediately and the cap rejection was never
    // visible during the audit that was supposed to surface it.
    //
    // Nothing here passes `--cell`. If the file's spelling does not reach the probe, the
    // fingerprint loses its `budgetCharacters` and the rejection disappears.
    await withCappedCell(CAP_MET, async root => {
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        cellTarget: "bench",
        imports: ["debounce"],
      });
      try {
        const recorded = await cli(["record", "--project", root, "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        // The cap the *file* named is in the fingerprint the record was measured under…
        expect(record.cellTarget).toBe("bench");
        expect(record.probe.fingerprint).toContain('"budgetCharacters":900000');
        // …and the record is fresh against that same cap, which it cannot be if the probe ran
        // without one.
        const stable = await cli(["status", "--project", root]);
        expect(stable.code, stable.stderr).toBe(0);
        expect(json<{ decisions: readonly { freshness: string }[] }>(stable).decisions[0]?.freshness).toBe("fresh");
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("keeps two Cells' records for one package independently fresh, and moves only the one that changed", async () => {
    // The P1-b case. The lock is keyed by `(packageName, cellTarget)` and the cap is a
    // fingerprint input, so one package can carry two records with two different fingerprints.
    // `status` rebuilt them into a map keyed by **package name**, so the second iteration
    // overwrote the first and *both* records were assessed against whichever Cell was processed
    // last — reversing the lock's order reversed which one was wrongly reported stale.
    await withTwoCappedCells(async root => {
      const first = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline", cellTarget: "alpha" });
      const second = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline", cellTarget: "beta" });
      try {
        const firstRecord = await cli(["record", "--project", root, "--decision", first.path]);
        if (firstRecord.code !== 0) console.error("TWO_DEBUG", firstRecord.stdout, firstRecord.stderr);
        expect((await cli(["record", "--project", root, "--decision", first.path])).code).toBe(0);
        expect((await cli(["record", "--project", root, "--decision", second.path])).code).toBe(0);

        // Both records were measured under their own Cell's cap, so both are fresh.
        const stable = await cli(["status", "--project", root]);
        expect(stable.code, stable.stderr).toBe(0);
        const fresh = json<{ decisions: readonly { cellTarget: string; freshness: string }[] }>(stable).decisions;
        expect(fresh.map(entry => entry.cellTarget).sort()).toEqual(["alpha", "beta"]);
        expect(fresh.map(entry => entry.freshness)).toEqual(["fresh", "fresh"]);

        // Move *one* Cell's cap. Only that Cell's record may report the change. The replacement
        // names the justification so it cannot also rewrite `beta`'s `2000` — a `replace("1000", …)`
        // would match inside it and move both, which is the opposite of what this case asserts.
        const configPath = join(root, "forguncy.config.ts");
        const before = await readFile(configPath, "utf8");
        const moved = before.replace('codeBudgetCharacters: 900000,', 'codeBudgetCharacters: 910000,');
        expect(moved).not.toBe(before);
        await writeFile(configPath, moved, "utf8");
        const afterMove = await cli(["status", "--project", root]);
        expect(afterMove.code).not.toBe(0);
        const after = json<{ decisions: readonly { cellTarget: string; stalenessReasons: readonly string[] }[] }>(afterMove).decisions;
        const byCell = new Map(after.map(entry => [entry.cellTarget, entry.stalenessReasons]));
        expect(byCell.get("alpha")).toContain("probe-fingerprint-changed");
        expect(byCell.get("beta")).toEqual([]);
      } finally {
        await first.cleanup();
        await second.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a `--cell` that disagrees with the decision file's own `cellTarget`", async () => {
    // One Cell identity per record: a file scoped to one Cell measured against another
    // Cell's cap would apply a ceiling that was never declared for the Cell it names.
    await withCappedCell(CAP_MET, async root => {
      const file = await decisionFile({
        packageName: "es-toolkit",
        role: "cell-local-ui",
        strategy: "inline",
        cellTarget: "other-cell",
      });
      try {
        const refused = await cli(["record", "--project", root, "--cell", "bench", "--decision", file.path]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("other-cell");
        expect(refused.stderr).toContain("bench");
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);

  it("records a capped decision and reports it fresh, then stale when the cap moves", async () => {
    // `record` and `status` have to agree about the cap. `record` composes it into the
    // fingerprint; `status` re-reads the *declared* cap to rebuild that fingerprint, so an
    // unchanged config stays fresh and a moved one is reported rather than silently accepted.
    await withCappedCell(CAP_MET, async root => {
      const file = await decisionFile({ packageName: "es-toolkit", role: "cell-local-ui", strategy: "inline" });
      try {
        const recorded = await cli(["record", "--project", root, "--cell", "bench", "--decision", file.path]);
        expect(recorded.code, recorded.stderr).toBe(0);
        const record = (await readLock(root)).decisions.find(entry => entry.packageName === "es-toolkit")!;
        expect(record.cellTarget).toBe("bench");
        expect(record.probe.fingerprint).toContain('"budgetCharacters":900000');

        // Unchanged config: the rebuild must reproduce the same fingerprint, or every
        // capped record would report a change nobody made.
        const stable = await cli(["status", "--project", root]);
        expect(stable.code, stable.stderr).toBe(0);
        expect(json<{ decisions: readonly { freshness: string }[] }>(stable).decisions[0]?.freshness).toBe("fresh");

        // The cap moves: the record was measured against a ceiling that no longer exists.
        const configPath = join(root, "forguncy.config.ts");
        await writeFile(configPath, (await readFile(configPath, "utf8")).replace("900000", "950000"), "utf8");
        const moved = await cli(["status", "--project", root]);
        expect(moved.code).not.toBe(0);
        expect(json<{ decisions: readonly { stalenessReasons: readonly string[] }[] }>(moved).decisions[0]?.stalenessReasons).toContain(
          "probe-fingerprint-changed",
        );
      } finally {
        await file.cleanup();
      }
    });
  }, CASE_TIMEOUT_MS);
});
