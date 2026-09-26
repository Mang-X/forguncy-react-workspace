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
 *
 * **Both levels of `src/`, not `src/probe/` alone.** The first version of this list walked only
 * the `probe` directory, and the retracted sentence in `src/decision-recording.ts` was one level up:
 * the pattern written for that file was applied to fourteen files that did not include it, so the
 * guard was dead — restoring the sentence there left this test's negative half green, and only the
 * positive assertion below caught it. Widening to the package root is the same "traversed, not
 * listed" argument this file's header makes, applied to the traversal itself.
 */
const packageSourceRoot = join(packageSourceDirectory); // .../packages/dependency-resolver/src

function modulesUnder(directory: string): readonly string[] {
  return readdirSync(join(packageSourceRoot, directory))
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map(name => (directory === "" ? `packages/dependency-resolver/src/${name}` : `packages/dependency-resolver/src/${directory}/${name}`));
}

const packageModules = [...modulesUnder(""), ...modulesUnder("probe")];

/**
 * Every corrected declaration in this repository, as `(file, retracted text)` pairs.
 *
 * ## Why this is a separate list from `packageModules`, and why it has to exist
 *
 * The traversal above filters `.test.ts` out — deliberately, because this guard file is itself a
 * test and it *quotes* the retracted sentences as data, so including tests would make its own
 * patterns match it. But the sweep touched test files and a markdown file too, and for those the
 * traversal is structurally incapable of covering the site. A reviewer caught exactly that: two
 * corrected declarations (`size.test.ts`'s old test title, `decision-recording.md`'s old 至少这么大
 * / 至多这么大 gloss) were restored by hand and this file stayed green.
 *
 * So each corrected declaration is named here with the text it must not revert to, and the pair is
 * falsified individually. A new site added to the sweep must add a row — the alternative is what
 * happened twice already: a pattern that reads as coverage while matching nothing.
 *
 * The paths are repository-relative and forward-slashed for the same reason `packageModules` is.
 */
const correctedDeclarations: readonly { readonly path: string; readonly retracted: readonly RegExp[] }[] = [
  {
    path: "packages/dependency-resolver/src/probe/size.test.ts",
    // The old title asserted the bound relation outright, and the old comment named a `bound`
    // parameter `observeSize` has never had. Both were corrected in place; neither was covered by
    // the `SizeBound` / `passes no \`bound\`` assertions, which is why the title is named here.
    retracted: [/defaults to the upper bound/, /which is the direction that leans over/],
  },
  {
    path: ".agents/skills/forguncy-react-dependency-selection/references/decision-recording.md",
    // The Chinese gloss translated the lean into bounds — "至少这么大" ("at least this big") for
    // 下 ("down") — which is the retracted relation in the file's own language. No regex in the
    // Skill loop matched CJK, so it survived the first sweep's English-only patterns.
    retracted: [/至少这么大/, /至多这么大/],
  },
];

const SKILL_DIRECTORY = ".agents/skills/forguncy-react-dependency-selection";

describe("the retracted size-bound claim does not reappear", () => {
  it("reads every module of the package, so a third copy cannot hide", () => {
    // The traversal is the point: the first sweep missed files because it was a list someone
    // wrote down. `build.ts` and `probe-engine.ts` are the ones it missed.
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/build.ts");
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/probe-engine.ts");
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/size.ts");
    // The gap the second sweep closed: `decision-recording.ts` is one level up from the probe
    // directory, so a traversal of `src/probe/` alone left the pattern written for it dead.
    expect(packageModules).toContain("packages/dependency-resolver/src/decision-recording.ts");
    // And the modules that legitimately describe the retraction are in scope, which is what
    // makes the negative assertions below meaningful rather than trivially true.
    expect(packageModules).toContain("packages/dependency-resolver/src/probe/size.ts");
    expect(packageModules.length).toBeGreaterThan(18);
    // No duplicates: the two traversals must not overlap.
    expect(new Set(packageModules).size).toBe(packageModules.length);
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

  it("rejects each corrected declaration by name, including the ones the traversal cannot reach", () => {
    // The half the traversal cannot do. `size.test.ts` is a test file and `decision-recording.md`
    // is not TypeScript, so `packageModules` excludes both by construction — a pattern list alone
    // read as coverage for two sites it never touched.
    //
    // Each row is asserted to be **non-empty first**. Found by falsifying this test: emptying a
    // row's `retracted` array left the suite green, because a `for` loop over zero patterns asserts
    // nothing and a `toMatch` on a real file still passes. So the table could have been hollowed out
    // one row at a time while this test reported coverage. The row count is checked too, so a row
    // cannot be deleted either.
    expect(correctedDeclarations.length).toBeGreaterThanOrEqual(2);
    for (const { path, retracted } of correctedDeclarations) {
      expect(retracted.length, `${path} is listed but asserts no retracted text, so it guards nothing`).toBeGreaterThan(0);
      const source = readRepositoryFile(path);
      for (const pattern of retracted) {
        expect(source, `${path} must not assert the retracted relation: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("states the corrected wording at those two sites, so deleting it cannot pass either", () => {
    // The positive half, for the same reason the other positive assertions exist: a site could be
    // emptied rather than corrected, and `not.toMatch` cannot tell the difference.
    const sizeTests = readRepositoryFile("packages/dependency-resolver/src/probe/size.test.ts");
    expect(sizeTests).toMatch(/defaults to leaning over, which is the less flattering direction/);
    expect(sizeTests).toMatch(/passes no `bias`/);

    const recording = readRepositoryFile(
      ".agents/skills/forguncy-react-dependency-selection/references/decision-recording.md",
    );
    // The corrected gloss keeps the direction but says it is a direction, not a bound — the
    // emphasised words are 偏小/偏大 ("leans small/large"), where the old text had 下/上 bracketed
    // by bound claims.
    expect(recording).toMatch(/\*\*偏小\*\*/);
    expect(recording).toMatch(/\*\*偏大\*\*/);
    // And the file still carries its own retraction, so this cannot be satisfied by deleting prose.
    expect(recording).toMatch(/\*\*都不是上下界\*\*/);
  });

  it("covers every corrected site, so a new one cannot be added to the sweep uncovered", () => {
    // The guard against a third round. The first sweep missed files because it was a list; the
    // second missed two sites because the traversal excludes test files and markdown. Coverage is
    // asserted as "this file carries corrected wording the guard asserts about", not as "this file
    // is readable" — the latter is true of every file in the repository and would pass even if the
    // file were added to no list at all.
    const skillCorrected = [
      {
        path: `${SKILL_DIRECTORY}/scripts/select_dependency.mjs`,
        // The corrected sentence, in the file's own words.
        corrected: /No cap rejection is sound under \*any\* surface/,
      },
      {
        path: `${SKILL_DIRECTORY}/evals/cap-e2e.test.ts`,
        corrected: /never a rejection basis/,
      },
    ];
    for (const { path, corrected } of skillCorrected) {
      const source = readRepositoryFile(path);
      expect(source, `${path} is corrected by this sweep but carries none of the replaced wording`).toMatch(corrected);
    }

    // The markdown site is in `correctedDeclarations`, and its positive half is asserted by the
    // test above; asserting it again here would be the duplicate-guard defect, so this only checks
    // the site is still listed rather than restating its content.
    expect(correctedDeclarations.map(entry => entry.path)).toContain(
      ".agents/skills/forguncy-react-dependency-selection/references/decision-recording.md",
    );
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
