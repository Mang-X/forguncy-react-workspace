import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The retracted "size bound" relation, and the declarations that must not assert it again.
 *
 * Decision source: GitHub Issue #79 — "Fix: sweep the retracted probe "size bound" claim out of
 * the remaining declarations (#77/#78)"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/79). It consumes #77's PR #78, whose
 * revisions 13-14 retracted a claim that the same PR had introduced one revision earlier.
 *
 * ## What was retracted, and why it is easy to leave half-applied
 *
 * Revision 12 held that a **named** import surface makes the probe's `size` measurement a
 * **lower bound** on the composed Cell, so a `cell-artifact-budget-exceeded` rejection filed from
 * that step would be *sound*. Revision 13 disproved it, and `size.ts` carries the counterexample:
 * `react-library`'s `DatePicker` measured through a *named* probe is 279 characters with npm
 * React inlined, while the real Cell resolves `react` to the host and is *smaller*. So a named
 * probe is not a lower bound either, `size.ts` files no rejection under any input, and
 * `PROBE_STEPS_OBSERVING_SIGNAL` gives the signal no observing step at all.
 *
 * The retraction landed in `size.ts` and `fingerprint.ts` — and stopped there. The same claim
 * survived in `build.ts`, `probe-engine.ts` and `decision-recording.ts`, where it is worse than
 * ordinary stale prose: `build.import-surface` is a **recorded, machine-readable fact**, and the
 * documented meaning of its empty/non-empty values *was* the falsified relation.
 *
 * ## Why this test reads source text rather than asserting behaviour
 *
 * The defect was documentation-only, and no behavioural test can catch it: `imports` is
 * load-bearing for exactly three things — the synthetic entry's shape, the fingerprint, and the
 * `size.estimateBias` string — and those are all covered elsewhere. The regression this guards
 * against is a future edit *re-writing the retracted claim into a comment*, which is invisible to
 * every assertion on values. So this file asserts on the prose, the way
 * `cell-compiler`'s `budget-cross-path.test.ts` pins `size.ts`'s own retraction.
 *
 * ## The distinction these assertions have to preserve
 *
 * `size.ts` and `fingerprint.ts` legitimately **name** the old vocabulary — `size.bound`,
 * `lower-bound` — when describing the rename and what it falsified. A blanket ban on the words
 * would delete the correction along with the defect. So the negative half targets the retracted
 * **sentences** (the assertions as fact), and the positive half requires the corrected story to be
 * present at each site. Both halves are needed: without the positive half a site could be emptied
 * rather than corrected, and without the negative half the old claim can simply be restored.
 */

const packageSourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(packageSourceDirectory, "..", "..", "..");

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

/**
 * Every non-test module of this package, so a claim is audited by traversal and not by list.
 *
 * Repository-relative and forward-slashed rather than built with `join`: these strings are both
 * read back off disk and asserted on, and `join` would make the assertions platform-dependent
 * (backslashes on Windows), so the test would pass locally and fail in CI or the reverse.
 */
const packageModules = readdirSync(join(packageSourceDirectory, "probe"))
  .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort()
  .map(name => `packages/dependency-resolver/src/probe/${name}`);

const SKILL_DIRECTORY = ".agents/skills/forguncy-react-dependency-selection";

describe("the retracted size-bound claim does not reappear", () => {
  it("reads every module of the probe package, so a third copy cannot hide", () => {
    // The traversal is the point: the first sweep missed files because it was a list someone
    // wrote down. `build.ts` and `probe-engine.ts` are the ones it missed.
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/build.ts");
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/probe-engine.ts");
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/size.ts");
    // And the modules that legitimately describe the retraction are in scope, which is what
    // makes the negative assertions below meaningful rather than trivially true.
    expect(packageModules.length).toBeGreaterThan(10);
  });

  it("asserts no bound relation anywhere in the probe package, only reports its retraction", () => {
    // The retracted sentences, quoted from the revision this replaced. Each is an assertion of
    // the falsified relation in the present tense; a correct file may *name* the vocabulary
    // while saying it is false, which is why these are sentences and not words.
    const retracted = [
      /make the measured artifact a \*\*lower bound\*\*/,
      /That is an \*\*upper\*\* bound on the code the Cell/,
      /bounds the Cell from below and a cap rejection on it is sound/,
      /the reason the cap verdict is\s+\* gated on this list being non-empty/,
      /the whole of the\s+\* lower\/upper bound distinction/,
      /size\.ts` reads this fact's meaning when it decides/,
      /what makes a size cap verdict \*provable\*/,
      /which is the only shape a cap rejection is sound on/,
      /does this record's cap rejection rest on a lower bound/,
    ];

    for (const path of packageModules) {
      const source = readRepositoryFile(path);
      for (const pattern of retracted) {
        // Reported with the file, because a bare `not.toMatch` failure names only the regex and
        // sends the reader looking through twelve modules.
        expect(source, `${path} must not assert the retracted relation: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("states the corrected relation where the surface and the leaning are defined", () => {
    // The positive half. Each site has to *say* what replaced the claim, not merely avoid the old
    // wording — otherwise deleting the paragraph would satisfy the assertions above.
    const build = readRepositoryFile("packages/dependency-resolver/src/probe/build.ts");
    expect(build).toMatch(/selects \*\*which way the size\s+\* estimate leans\*\*/);
    expect(build).toMatch(/it authorizes nothing/);
    expect(build).toMatch(/Neither is a bound on the Cell/);
    // The figures stay: they are real, and they are the reason the surface must travel with the
    // number. What changed is what they are said to *imply*.
    expect(build).toMatch(/249,750 characters/);
    expect(build).toMatch(/2,865/);

    const engine = readRepositoryFile("packages/dependency-resolver/src/probe/probe-engine.ts");
    expect(engine).toMatch(/estimat\w+ leans/);
    expect(engine).toMatch(/does not make a\s+\* cap verdict provable/);

    const recording = readRepositoryFile("packages/dependency-resolver/src/decision-recording.ts");
    expect(recording).toMatch(/which way does this record's size estimate lean/);
  });

  it("keeps the correction itself, so the sweep cannot delete it alongside the defect", () => {
    // `size.ts` is where the retraction lives. If a future sweep over-corrects and strips this
    // too, the file stops explaining why the step files nothing — and the defect returns with
    // nothing to contradict it.
    const size = readRepositoryFile("packages/dependency-resolver/src/probe/size.ts");
    expect(size).toMatch(/revision 13 disproved the bound relation for \*\*both\*\* shapes/);
    expect(size).toMatch(/the `react-library` counterexample/);
    expect(size).toMatch(/measures \*\*279\*\* characters/);

    const fingerprint = readRepositoryFile("packages/dependency-resolver/src/probe/fingerprint.ts");
    expect(fingerprint).toMatch(/named imports make the measurement a lower bound; that is false/);
  });

  it("keeps the skill's own retraction while asserting none of the retracted claim", () => {
    // The Skill is the path an Agent actually drives, so its files are read here too — this is
    // the one place the sweep crosses out of `packages/`.
    const skillFiles = [
      `${SKILL_DIRECTORY}/scripts/select_dependency.mjs`,
      `${SKILL_DIRECTORY}/evals/cap-e2e.test.ts`,
      `${SKILL_DIRECTORY}/references/decision-recording.md`,
    ];

    for (const path of skillFiles) {
      const source = readRepositoryFile(path);
      expect(source, `${path} must not assert the retracted relation`).not.toMatch(
        /only a named\s+\/\/ surface makes a `cell-code-budget-exceeded` rejection sound/,
      );
      expect(source, `${path} must not assert the retracted relation`).not.toMatch(
        /the one state under which no cap rejection is sound/,
      );
      expect(source, `${path} must not assert the retracted relation`).not.toMatch(
        /so the measurement is a lower bound/,
      );
    }

    // And the Skill's prose still carries the correction, in the language that file uses.
    const skillReadme = readRepositoryFile(`${SKILL_DIRECTORY}/README.md`);
    expect(skillReadme).toMatch(/probe 在任何情况下都\*\*不产生\*\* `cell-artifact-budget-exceeded`/);
  });

  it("names the surviving type and parameter, so the dangling references stay fixed", () => {
    // Two references outlived their symbols: a comment citing `SizeBound` (renamed
    // `SizeEstimateBias`) and one citing a `bound` parameter that is named `bias`. A type that
    // does not exist reads as documentation and is a dead end for whoever follows it.
    const size = readRepositoryFile("packages/dependency-resolver/src/probe/size.ts");
    expect(size).toMatch(/export type SizeEstimateBias/);
    expect(size).not.toMatch(/export type SizeBound\b/);

    const tests = readRepositoryFile("packages/dependency-resolver/src/probe/size.test.ts");
    expect(tests).not.toMatch(/`SizeBound`/);
    expect(tests).not.toMatch(/passes no `bound`/);
  });
});
