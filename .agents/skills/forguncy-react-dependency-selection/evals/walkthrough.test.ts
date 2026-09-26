/**
 * The Skill's documented commands, executed.
 *
 * Decision source: GitHub Issue #91 — "修复 Skill：移除手填 artifactEvidence 指令，并执行文档示例回归"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/91).
 *
 * Governing Specs: #16 (the Skill/scripts split), #8 (the lock the flow records into),
 * #77 (the cell-code budget, whose revisions 13-15 moved the size verdict to the compiler).
 *
 * ## The defect this file exists for
 *
 * `SKILL.md` told an Agent to record an oversize rejection by compiling the Cell, copying two
 * numbers out of the compiler's `cell-code-budget-exceeded` diagnostic, and writing them into
 * the decision file as `artifactEvidence`. `scripts/select_dependency.mjs` refuses exactly that
 * input — `decisionFromFile` fails on `document.artifactEvidence !== undefined`, because a
 * rejection certified by numbers the deciding file chose is the evidence #77 removed. So the
 * repository shipped an instruction whose only outcome was a refusal, and #79's sweep of the
 * retracted *size-bound* claim did not touch it.
 *
 * ## Why this file reads the documentation instead of restating it
 *
 * A documentation bug cannot be caught by a test that re-types the correct commands: the test
 * would be green about its own copy while the doc stayed wrong. That is the trap #91 names —
 * "避免测试另写一份正确 JSON 而文档仍错". So the commands and the decision-file paths are
 * **extracted from `SKILL.md`** and executed here. If the doc's walkthrough is edited to
 * something the script refuses, or to name a fixture that does not exist, this fails.
 *
 * The same argument decides where the fixture lives: it is committed at
 * `examples/probe-proving-cases/walkthrough/`, the path the doc names, rather than being built
 * per-test. A fixture the test invents is a second copy of the example.
 *
 * ## What is executed, and what is only asserted about the prose
 *
 * The runnable half is the four commands in the doc's walkthrough block, run verbatim against a
 * **copy** of the committed fixture under the example's git-ignored `.fgc/`. `$S` and `$W` are
 * re-pointed at that copy — the doc declares them as variables precisely so a caller can — and
 * nothing else is rewritten.
 *
 * The prose half is a negative guard: the retracted instruction must not reappear in any file
 * that carried it. Per the pattern this repository has already been bitten by twice, the guard
 * has a **positive** half too, because `not.toMatch` alone is satisfied by deleting the
 * paragraph rather than correcting it.
 *
 * ## Why the negative guard lists its files rather than traversing
 *
 * `packages/dependency-resolver/src/provenance.test.ts` audits the *probe package* by traversal,
 * and its own header records that a traversal is structurally unable to reach a test file or a
 * markdown file. Every file this guard is about is either markdown or the CLI script — outside
 * any TypeScript source tree — so a traversal would be dead for all of them. The list is
 * therefore explicit, and each row is asserted non-empty first so a row cannot be hollowed out
 * while the test keeps reporting coverage.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..");
const SKILL_DIRECTORY = ".agents/skills/forguncy-react-dependency-selection";
const SKILL_DOCUMENT = `${SKILL_DIRECTORY}/SKILL.md`;
const CLI_RELATIVE = `${SKILL_DIRECTORY}/scripts/select_dependency.mjs`;
const WALKTHROUGH_RELATIVE = "examples/probe-proving-cases/walkthrough";

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
    const { stdout, stderr } = await run(process.execPath, [join(REPOSITORY_ROOT, CLI_RELATIVE), ...args], {
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
 * Every fenced ```bash block in a markdown file, in document order.
 *
 * Extracted rather than line-scanned so a command shown in prose (this file quotes one) is not
 * mistaken for an instruction to run.
 *
 * `\r?\n` rather than `\n`, because this repository sets no `.gitattributes` and a Windows
 * checkout under `core.autocrlf=true` has these files CRLF on disk while the index is LF. A
 * pattern that only accepts LF finds **no blocks at all** here and passes locally on CI's
 * checkout while failing on a contributor's machine — the platform-dependent guard this
 * repository has already been bitten by. The same applies to `commandsIn` below.
 */
function bashBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  const pattern = /```bash\r?\n([\s\S]*?)```/g;
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

/**
 * Prose with its line wrapping and CRLF endings flattened to single spaces.
 *
 * The assertions below are about what a file *says*, and markdown wraps a sentence across lines
 * at whatever column the author's editor chose. Matching the raw bytes would make every one of
 * them a test of where the line breaks happen to fall — a guard that breaks when a paragraph is
 * reflowed rather than when its meaning changes. Normalizing is safe here because none of the
 * asserted phrases spans a paragraph boundary.
 */
function flattened(source: string): string {
  return source.replace(/\s+/g, " ");
}

/** The one block that carries the walkthrough, located by the fixture path it names. */
function walkthroughBlock(): string {
  const block = bashBlocks(readFileSync(join(REPOSITORY_ROOT, SKILL_DOCUMENT), "utf8")).find(candidate =>
    candidate.includes("probe-proving-cases/walkthrough"),
  );
  // A block that cannot be found would make every assertion below vacuously pass, so the
  // lookup's own failure is the assertion.
  expect(block, `${SKILL_DOCUMENT} must carry a runnable walkthrough block`).toBeDefined();
  return block!;
}

/**
 * The decision files the walkthrough block names, as repository-relative paths.
 *
 * Read out of the doc rather than listed here, because "the doc's example runs" is only true if
 * the files it points at are the ones that exist. A `$W/decisions/x.json` the doc invents and
 * nobody committed fails the existence assertion below.
 */
function decisionPathsIn(block: string): readonly string[] {
  const found = new Set<string>();
  const pattern = /\$W\/(decisions\/[\w.-]+\.json)/g;
  for (let match = pattern.exec(block); match !== null; match = pattern.exec(block)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * The walkthrough's `node $S …` commands, in document order, as arguments to the script.
 *
 * Only the two variables the block itself declares are substituted, and only with the values a
 * reader would give them — the script's own path, and a project root. Nothing about the command
 * itself is rewritten, so what runs is what the doc shows.
 *
 * The substituted `$S` is **dropped** from the result rather than kept: `cli` already invokes the
 * script, so passing the path again would make it the command word and every documented command
 * would exit 2 with a usage error. What remains starts at the subcommand, which is also what the
 * assertions about the command sequence read.
 */
function commandsIn(block: string, scriptPath: string, projectRoot: string): readonly string[][] {
  const commands: string[][] = [];
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("node $S ")) {
      continue;
    }
    const argv = line.replace(/\$S/g, scriptPath).replace(/\$W/g, projectRoot).split(/\s+/);
    // `argv[0]` is `node`, `argv[1]` the script path just substituted — both are `cli`'s job.
    commands.push(argv.slice(2));
  }
  return commands;
}

/**
 * A scratch copy of the committed walkthrough fixture, under the example's git-ignored `.fgc/`.
 *
 * Copied rather than run in place because the flow *writes* — `record` creates `fgc.lock.json`
 * and `fgc-evidence/` beside the project — and a test that dirtied a committed directory would
 * make every later `git status` a review question. The copy sits under
 * `examples/probe-proving-cases/.fgc/`, so the probe's ancestor walk still resolves `es-toolkit`
 * from the enclosing example, which is where it is actually installed.
 *
 * The `.fgc/` parent is removed again when it is left empty, for the reason `cli-contract.test.ts`
 * records: an empty `.fgc/` under an example is a directory other suites walk into.
 */
async function withWalkthroughCopy<T>(body: (projectRoot: string, decisions: readonly string[]) => Promise<T>): Promise<T> {
  const parent = join(REPOSITORY_ROOT, "examples", "probe-proving-cases", ".fgc");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "walkthrough-"));
  try {
    await cp(join(REPOSITORY_ROOT, WALKTHROUGH_RELATIVE), root, { recursive: true });
    return await body(root, decisionPathsIn(walkthroughBlock()).map(path => join(root, path)));
  } finally {
    await rm(root, { recursive: true, force: true });
    const remaining = await readdir(parent).catch(() => null);
    if (remaining !== null && remaining.length === 0) {
      await rm(parent, { recursive: true, force: true });
    }
  }
}

interface LockRecord {
  readonly packageName: string;
  readonly cellTarget: string | null;
  readonly strategy: string;
  readonly artifactEvidence?: {
    readonly compileFingerprint: string;
    readonly subjectDecision?: { readonly strategy: string };
    readonly subjectRenderedCharacters: number;
    readonly codeCharacters: number;
    readonly budgetCharacters: number;
  };
}

async function readLock(root: string): Promise<{ decisions: readonly LockRecord[] }> {
  return JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as { decisions: readonly LockRecord[] };
}

describe("the Skill's documented walkthrough runs as written", () => {
  it("names decision files that exist, so the doc cannot point at nothing", () => {
    // The lookup is the assertion: `decisionPathsIn` reads the paths out of the doc, and this
    // checks the repository actually carries them. A walkthrough whose example files were never
    // committed is a doc a reader cannot follow.
    const paths = decisionPathsIn(walkthroughBlock());
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(existsSync(join(REPOSITORY_ROOT, WALKTHROUGH_RELATIVE, path)), `${path} is named by ${SKILL_DOCUMENT}`).toBe(true);
    }
    // Both halves of the walkthrough: the strategy that puts the package in the Cell, and the
    // rejection measured on the compile that included it. Without the first, the second is
    // refused as unattributable — so a doc naming only the rejection would be wrong.
    expect(paths.some(path => path.includes("inline"))).toBe(true);
    expect(paths.some(path => path.includes("oversize"))).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("runs its four commands to a fresh artifact-rejection record", async () => {
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      const block = walkthroughBlock();
      const commands = commandsIn(block, join(REPOSITORY_ROOT, CLI_RELATIVE), projectRoot);
      expect(commands.length, "the walkthrough block must carry commands to run").toBeGreaterThanOrEqual(3);

      const results: CommandResult[] = [];
      for (const args of commands) {
        const result = await cli(args);
        // Every documented command is asserted to succeed. A doc that shows a command the CLI
        // refuses is the defect #91 is about, and asserting only the last one would let an
        // earlier refusal through.
        expect(result.code, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
        results.push(result);
      }

      // The commands the doc shows, in order: two `record`s then a `status`.
      expect(commands.map(args => args[0])).toEqual(["record", "record", "status"]);

      const recorded = json<{ recorded: boolean }>(results[0]!);
      expect(recorded.recorded).toBe(true);
      const rejected = json<{ recorded: boolean }>(results[1]!);
      expect(rejected.recorded).toBe(true);

      // The oversize rejection's evidence is the compiler's, produced by the CLI's own compile
      // of the Cell — not a number any decision file supplied. This is the property the retracted
      // instruction violated, asserted on the artifact the documented commands actually wrote.
      const record = (await readLock(projectRoot)).decisions.find(entry => entry.strategy === "replace");
      expect(record?.cellTarget).toBe("capped");
      expect(record?.artifactEvidence?.budgetCharacters).toBe(8_000);
      expect(record?.artifactEvidence?.codeCharacters).toBeGreaterThan(8_000);
      expect(record?.artifactEvidence?.subjectRenderedCharacters).toBeGreaterThan(0);
      expect(record?.artifactEvidence?.compileFingerprint).toMatch(/^cell="[0-9a-f]{64}";budget=8000$/);
      // The strategy the package was in when the measurement was taken, preserved so a re-record
      // replays the same compile rather than measuring a Cell the package is no longer part of.
      expect(record?.artifactEvidence?.subjectDecision).toEqual({ strategy: "inline" });

      // And `status` recompiles that identity and finds it unchanged — the doc's third command,
      // asserted on its own output rather than merely on its exit code.
      const status = json<{ decisions: readonly { profile: string; freshness: string; stalenessReasons: readonly string[] }[] }>(
        results[2]!,
      );
      expect(status.decisions[0]?.profile).toBe("artifact-rejection");
      expect(status.decisions[0]?.freshness).toBe("fresh");
      expect(status.decisions[0]?.stalenessReasons).toEqual([]);

      // The decision files the doc named are the ones that ran.
      expect(decisions.every(existsSync)).toBe(true);
    });
  }, CASE_TIMEOUT_MS);

  it("refuses the oversize rejection on a Cell that declares no ceiling, as the prose says", async () => {
    // The walkthrough's prose claims this, so it is executed rather than trusted. It is also the
    // case that distinguishes "over the cap" from "no cap at all": with no declared ceiling the
    // compiler files no diagnostic, so there is no measurement to record — and a record claiming
    // one would be aimed at a ceiling nobody set.
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      // The subject has to be in that Cell's graph first, or the refusal would be the
      // *attribution* rule firing rather than the cap one — and a test that accepted either
      // message would not be checking what its name says.
      const inline = decisions.find(path => path.includes("inline"))!;
      const inlineForUncapped = { ...(JSON.parse(await readFile(inline, "utf8")) as Record<string, unknown>) };
      inlineForUncapped.cellTarget = "uncapped";
      await writeFile(inline, JSON.stringify(inlineForUncapped, null, 2), "utf8");
      const subject = await cli(["record", "--project", projectRoot, "--decision", inline]);
      expect(subject.code, subject.stderr).toBe(0);

      const oversize = decisions.find(path => path.includes("oversize"))!;
      const moved = JSON.parse(await readFile(oversize, "utf8")) as Record<string, unknown>;
      moved.cellTarget = "uncapped";
      await writeFile(oversize, JSON.stringify(moved, null, 2), "utf8");

      const result = await cli(["record", "--project", projectRoot, "--decision", oversize]);
      expect(result.code).not.toBe(0);
      expect(json<{ problems: readonly string[] }>(result).problems.join("\n")).toMatch(
        /declares no output\.codeBudgetCharacters/,
      );
      // The subject's own record is what the refusal left behind — the rejection is not, and a
      // refusal that had written one would make the lock claim a ceiling nobody declared.
      const lock = await readLock(projectRoot);
      expect(lock.decisions.map(entry => entry.strategy)).toEqual(["inline"]);
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a decision file that supplies its own compile measurement", async () => {
    // The negative half of the doc fix, against the doc's own fixture. The walkthrough's
    // `oversize.json` is a decision file the CLI accepts; adding the field the retracted
    // instruction told the reader to add is what makes it unacceptable — and the refusal has to
    // be a *usage* error rather than a silently dropped field, or the caller would believe the
    // numbers were used.
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      const oversize = decisions.find(path => path.includes("oversize"))!;
      const doctored = JSON.parse(await readFile(oversize, "utf8")) as Record<string, unknown>;
      doctored.artifactEvidence = { compileFingerprint: "typed", codeCharacters: 200_000, budgetCharacters: 100_000 };
      await writeFile(oversize, JSON.stringify(doctored, null, 2), "utf8");

      const result = await cli(["record", "--project", projectRoot, "--decision", oversize]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/not the caller's to state/);
      expect(existsSync(join(projectRoot, "fgc.lock.json"))).toBe(false);
    });
  }, CASE_TIMEOUT_MS);

  it("leaves the committed fixture untouched, so the doc's example is not the test's scratch", async () => {
    // The copy is not tidiness: if the documented commands ran in place, the committed example
    // would gain a lock and evidence directory on every test run, and a reviewer would have to
    // decide each time whether those bytes were authored or generated.
    //
    // The commands are run *inside* this case rather than beside it, so the assertion is about
    // bytes this test could actually have written. An earlier version ran nothing and then
    // asserted the committed tree was clean — true, but also true of a copy helper that was
    // never wired up, which is the vacuous shape this file's header warns about.
    const committed = join(REPOSITORY_ROOT, WALKTHROUGH_RELATIVE);
    const before = await readdir(committed);
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      // Recorded in the doc's order, so both are accepted and both write — which is what makes
      // the committed-tree assertion below a statement about writes that really happened.
      for (const decision of decisions) {
        const result = await cli(["record", "--project", projectRoot, "--decision", decision]);
        expect(result.code, `${decision}\n${result.stdout}${result.stderr}`).toBe(0);
      }
      // The writes landed in the copy, which is what makes the committed-tree assertion mean
      // something: a scratch root that had silently been the real directory would show here.
      expect(existsSync(join(projectRoot, "fgc.lock.json"))).toBe(true);
    });
    expect(existsSync(join(committed, "fgc.lock.json"))).toBe(false);
    expect(existsSync(join(committed, "fgc-evidence"))).toBe(false);
    // And no file was added to the committed fixture, so a run cannot leave a generated sibling.
    expect(await readdir(committed)).toEqual(before);
  }, CASE_TIMEOUT_MS);
});

/**
 * The retracted instruction, and the files that must not carry it again.
 *
 * Issue #91's confirmed defect was a documentation-only contradiction, so no behavioural test can
 * catch a regression of it: the CLI's refusal is covered above, but a future edit re-adding "copy
 * the two numbers into `artifactEvidence`" to the prose would leave every one of those assertions
 * green. This guard is therefore on the text.
 *
 * The rows are explicit rather than traversed, for the reason this file's header states: every
 * site is markdown or the CLI script, and a traversal of a TypeScript source tree cannot reach
 * any of them. The pattern is the *instruction* rather than the word `artifactEvidence`, because
 * the corrected files legitimately name the field — `decision-recording.md` documents it as a lock
 * field, and the CLI script refuses it by name. A blanket ban would delete the correction along
 * with the defect.
 */
const handFillSites: readonly { readonly path: string; readonly retracted: readonly RegExp[] }[] = [
  {
    path: SKILL_DOCUMENT,
    // The exact instruction: compile, transcribe the two numbers, write them into the decision
    // file's `artifactEvidence`.
    retracted: [/逐字誊出两个数字，写进决策文件的 artifactEvidence/, /"artifactEvidence": \{ "codeCharacters": \d+/, /必须等于该 Cell 声明的 output\.codeBudgetCharacters，否则会被拒绝/],
  },
  {
    path: `${SKILL_DIRECTORY}/README.md`,
    retracted: [/必须\*\*带 `artifactEvidence: \{ codeCharacters, budgetCharacters \}`/, /两个数字逐字誊自编译器自己的诊断/],
  },
  {
    path: `${SKILL_DIRECTORY}/references/decision-recording.md`,
    // The decision-file shape table carried the field with "required when the rejection code is
    // cell-code-budget-exceeded", which is the instruction in its most literal form.
    retracted: [/rejection\.code 为 cell-code-budget-exceeded 时\*\*必填\*\*/, /两个数字逐字誊自编译器自己的诊断/],
  },
  {
    path: CLI_RELATIVE,
    // The script's own decision-file header documented the field as part of the shape a caller
    // hands in — the machine-readable half of the same contradiction.
    retracted: [/required exactly when the rejection code is/, /"artifactEvidence": \{         \/\/ required exactly when/],
  },
];

describe("the hand-filled compile measurement is not documented as an input", () => {
  it("rejects each retracted instruction by name, and each row guards something", () => {
    // Non-empty rows first: a `for` loop over zero patterns asserts nothing while the suite still
    // reports coverage, so a row could be hollowed out one at a time. The row count is checked for
    // the same reason a row could otherwise be deleted.
    expect(handFillSites.length).toBeGreaterThanOrEqual(4);
    for (const { path, retracted } of handFillSites) {
      expect(retracted.length, `${path} is listed but asserts no retracted text, so it guards nothing`).toBeGreaterThan(0);
      const source = flattened(readFileSync(join(REPOSITORY_ROOT, path), "utf8"));
      for (const pattern of retracted) {
        expect(source, `${path} must not instruct a hand-filled compile measurement: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps the corrected instruction at each site, so deleting the prose cannot pass either", () => {
    // The positive half. Without it, `not.toMatch` is satisfied by removing the paragraph rather
    // than correcting it — and a walkthrough that explains nothing about where the numbers come
    // from is the state #91 is trying to leave behind.
    const skill = flattened(readFileSync(join(REPOSITORY_ROOT, SKILL_DOCUMENT), "utf8"));
    expect(skill).toMatch(/\*\*决策文件里不要写 artifactEvidence\*\*/);
    expect(skill).toMatch(/由脚本自己编译产生/);

    const readme = flattened(readFileSync(join(REPOSITORY_ROOT, `${SKILL_DIRECTORY}/README.md`), "utf8"));
    expect(readme).toMatch(/\*\*决策文件里不要写 `artifactEvidence`\*\*/);
    expect(readme).toMatch(/a compile measurement is not the caller's to state/);

    const recording = flattened(
      readFileSync(join(REPOSITORY_ROOT, `${SKILL_DIRECTORY}/references/decision-recording.md`), "utf8"),
    );
    expect(recording).toMatch(/决策文件里\*\*没有\*\* `artifactEvidence`/);
    expect(recording).toMatch(/这是 Agent 输入与脚本产出之间最容易搞错的一处/);

    const script = flattened(readFileSync(join(REPOSITORY_ROOT, CLI_RELATIVE), "utf8"));
    expect(script).toMatch(/is deliberately \*\*absent\*\* from that shape/);
    // Not anchored past "after the": the sentence continues onto the next JSDoc line, whose
    // leading `* ` survives `flattened` as a comment marker. Asserting the whole clause would
    // be a test of where that line wraps.
    expect(script).toMatch(/a \*\*lock\*\* field, written after the/);
  });

  it("still refuses the input at runtime, so the prose and the script agree", async () => {
    // The link between the two halves: the corrected prose says the field is refused, and this is
    // the refusal. Asserted on the script's own message rather than on a copy of it, so a message
    // edit cannot silently make the documentation wrong.
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      const oversize = decisions.find(path => path.includes("oversize"))!;
      const doctored = JSON.parse(await readFile(oversize, "utf8")) as Record<string, unknown>;
      doctored.artifactEvidence = { codeCharacters: 1, budgetCharacters: 0 };
      await writeFile(oversize, JSON.stringify(doctored, null, 2), "utf8");

      const result = await cli(["audit", "--project", projectRoot, "--decision", oversize]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/not the caller's to state/);
      // `audit` is the read-only counterpart, so it wrote nothing either — neither the lock nor
      // the evidence `record` would have persisted. Asserting only the lock would miss an
      // `audit` that left an orphan report behind, which is the debris the read-only claim is
      // about (the file is committable, so a stray one becomes a review question).
      expect(existsSync(join(projectRoot, "fgc.lock.json"))).toBe(false);
      expect(existsSync(join(projectRoot, "fgc-evidence"))).toBe(false);
    });
  }, CASE_TIMEOUT_MS);

  it("keeps the corrected audit-and-record agreement, which is the same contract the field broke", async () => {
    // #91's plan item 4 asks for the ordinary paths to stay consistent, not only the refusals. A
    // decision the corrected docs call recordable has to audit as recordable — otherwise the fix
    // would have moved the contradiction rather than removed it, and `audit` (the command an
    // Agent runs first) would be the one lying.
    await withWalkthroughCopy(async (projectRoot, decisions) => {
      const inline = decisions.find(path => path.includes("inline"))!;
      const audited = await cli(["audit", "--project", projectRoot, "--decision", inline]);
      expect(audited.code, audited.stderr).toBe(0);
      expect(json<{ recordable: boolean; evidenceProfile: string }>(audited)).toMatchObject({
        recordable: true,
        evidenceProfile: "resolved-dependency",
      });
      // `audit` measures and decides nothing, so the recordable verdict left no lock behind.
      expect(existsSync(join(projectRoot, "fgc.lock.json"))).toBe(false);

      const recorded = await cli(["record", "--project", projectRoot, "--decision", inline]);
      expect(recorded.code, recorded.stderr).toBe(0);
      expect(json<{ recorded: boolean }>(recorded).recorded).toBe(true);
      const record = (await readLock(projectRoot)).decisions.find(entry => entry.strategy === "inline");
      expect(record?.cellTarget).toBe("capped");
      // An `inline` record's evidence is the probe, so it carries no `artifactEvidence` — the
      // field is the compiler-measured rejection's, and a record that had one here would be a
      // size verdict attached to a decision that was never rejected.
      expect(record?.artifactEvidence).toBeUndefined();
    });
  }, CASE_TIMEOUT_MS);
});
