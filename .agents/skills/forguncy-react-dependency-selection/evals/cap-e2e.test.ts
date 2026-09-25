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

  it("shows the declared cap as a fact, folds it into the fingerprint, and rejects on it", async () => {
    await withCappedCell(CAP_EXCEEDED, async root => {
      // `--imports` is part of the invocation rather than an extra: a cap rejection is only
      // sound on a **lower** bound, which is what a declared named surface produces. The
      // namespace run below pins the other direction.
      const probed = await cli(["probe", "--project", root, "--cell", "bench", "--imports", "debounce", "es-toolkit"]);
      expect(probed.code, probed.stderr).toBe(0);
      const report = json<ProbePayload>(probed);

      // The cap is reported, so a caller can see which ceiling was applied.
      expect(report.facts.find(fact => fact.name === "artifact.budgetCharacters")?.value).toBe(CAP_EXCEEDED);
      // It is a *declared input*, so it has to compose into the fingerprint — otherwise a
      // record measured under one cap would look fresh under another.
      expect(report.fingerprint).toContain('"budgetCharacters":1000');
      // And it is the only thing that may reject: the band is advisory, the cap is not.
      expect(report.rejectionFindings.map(finding => finding.signal)).toContain("cell-artifact-budget-exceeded");
      expect(report.facts.find(fact => fact.name === "size.bound")?.value).toBe("lower-bound");
    });
  }, CASE_TIMEOUT_MS);

  it("measures a namespace run over the same cap without rejecting, because it is an upper bound", async () => {
    // The complement of the case above, and the whole of the P1-c fix end to end: without a
    // declared surface the probe keeps every export, so its size is an upper bound on what the
    // Cell carries and an over-cap number is a measurement rather than a verdict. Measured on
    // `es-toolkit`, the namespace bundles to 249,750 characters against 2,865 for `debounce`
    // alone — filing `replace` evidence on the namespace number would be a rejection the
    // artifact does not support.
    await withCappedCell(CAP_EXCEEDED, async root => {
      const probed = await cli(["probe", "--project", root, "--cell", "bench", "es-toolkit"]);
      expect(probed.code, probed.stderr).toBe(0);
      const report = json<ProbePayload>(probed);

      expect(report.facts.find(fact => fact.name === "size.bound")?.value).toBe("upper-bound");
      // The comparison is still made and still reported — only the *verdict* is withheld.
      expect(report.facts.find(fact => fact.name === "artifact.budgetCharacters")?.value).toBe(CAP_EXCEEDED);
      expect(report.rejectionFindings.map(finding => finding.signal)).not.toContain("cell-artifact-budget-exceeded");
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
