import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

/**
 * The Skill eval suite is collected once, not once per path to the same file (#100).
 *
 * Decision source: GitHub Issue #100 —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/100
 *
 * ## The defect
 *
 * `.claude/skills/forguncy-frontend-library` and `.claude/skills/forguncy-react-dependency-selection`
 * are committed symlinks (git mode `120000`) into `.agents/skills/**`. Agent-discovery tooling
 * that looks in `.claude` finds the Skills through them; that is why they exist and #18 is where
 * they were introduced.
 *
 * Vitest's default include glob does not treat a symlink as an alias. It walks the directory tree,
 * so it finds each eval test under **both** path spellings: **3 files collected twice and 89 test
 * cases re-run**, measured by withholding the exclusion below and diffing the two collections. The
 * duplicated three include `cli-contract.test.ts` and `cap-e2e.test.ts` — the two slowest files in
 * the repository, 114 s and 48 s on the CI run this was diagnosed from — so the duplication was
 * not a cosmetic count: it was a large share of the suite's wall clock.
 *
 * The same walk happens in Oxlint, where each finding is reported twice, once under each path.
 *
 * ## Why this test reads the toolchain instead of the config
 *
 * Asserting `vite.config.ts` contains a particular string would pass for a pattern that matches
 * nothing. The property that matters is about what the *toolchain collects*, so this test asks the
 * toolchain: `createVitest(...).globTestSpecifications()` is Vitest's own public collection entry
 * point, and the list it returns is the same one a run uses. Same for the lint half, through
 * `vp lint --format json`, which is why that call is `--format json` rather than a scrape of
 * coloured text.
 *
 * ## The counterfactual, and what it is for
 *
 * A test that asserts "no duplicate realpaths" passes trivially in a tree where the alias is
 * **absent** — which is exactly the state a Windows checkout is in, because `core.symlinks` is
 * false there and git writes the link target as a plain file. So on this repository's own Windows
 * machine the guard would be green for the wrong reason, and would stay green if `test.exclude`
 * were deleted, and CI would be the only place anything noticed.
 *
 * That is what the counterfactual assertion is for: it re-collects with the `.claude` exclusion
 * withheld and requires that the duplicates **appear**. It is a control on the fixture, not on the
 * fix — it fires when a reader's environment has no alias to deduplicate, and it fails loudly
 * instead of quietly reporting a green.
 *
 * This repository already has this exact problem documented: a Windows checkout materializes these
 * two links as files containing the relative path, so the `.claude` suite does not run locally at
 * all. The counterfactual makes that visible here rather than leaving it to CI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..", "..");

/** The committed symlinks this Issue is about, as paths relative to the repository root. */
const AGENT_DISCOVERY_LINKS = [
  ".claude/skills/forguncy-frontend-library",
  ".claude/skills/forguncy-react-dependency-selection",
] as const;

/** Where each link points, which is what makes the collection a duplicate rather than a second file. */
const CANONICAL_SKILLS_ROOT = ".agents/skills";

/** Normalize a path the way `realpathSync` output needs on Windows, where separators are mixed. */
function portable(path: string): string {
  return path.split("\\").join("/");
}

/** The repository-relative spelling of an absolute path, with `/` separators. */
function relativeToRoot(absolutePath: string): string {
  return portable(relative(repositoryRoot, absolutePath));
}

/** The physical identity of a collected path, following symlinks, or its spelling if it is gone. */
function physicalIdentity(absolutePath: string): string {
  try {
    return portable(realpathSync(absolutePath));
  } catch {
    return `unresolvable:${portable(absolutePath)}`;
  }
}

/** Resolve `vite-plus`'s own CLI entry, so this measures the project's toolchain, not a global one. */
function resolveVpEntry(): string {
  const require = createRequire(join(repositoryRoot, "package.json"));
  const manifestPath = require.resolve("vite-plus/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: Record<string, string> };

  return join(dirname(manifestPath), manifest.bin.vp!);
}

/**
 * The test files a Vitest run collects, under an optional `exclude` override.
 *
 * `exclude` is a CLI-shaped override rather than a config edit on purpose: a test that rewrote
 * `vite.config.ts` to take its own counterfactual reading would be mutating the file under test,
 * and a crash mid-run would leave the repository in the state the test was measuring.
 */
async function collectedTestFiles(exclude?: readonly string[]): Promise<readonly string[]> {
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    ...(exclude === undefined ? {} : { exclude: [...exclude] }),
  });
  try {
    const specifications = await vitest.globTestSpecifications();

    return specifications.map(specification => specification.moduleId);
  } finally {
    await vitest.close();
  }
}

/** Group collected paths by physical identity, keeping the spelling of each. */
function byPhysicalFile(collected: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of collected) {
    const identity = physicalIdentity(path);
    groups.set(identity, [...(groups.get(identity) ?? []), relativeToRoot(path)]);
  }

  return groups;
}

describe("the Skill eval suite is collected once per physical file (#100)", () => {
  it("collects no two paths that resolve to the same file", async () => {
    const collected = await collectedTestFiles();
    const groups = byPhysicalFile(collected);
    const duplicated = [...groups.entries()].filter(([, spellings]) => spellings.length > 1);

    // The control: collection ran and found this suite, so "no duplicates" is the result of
    // comparing a real list rather than of an empty one.
    expect(collected.length).toBeGreaterThan(50);

    expect(
      duplicated.map(([identity, spellings]) => ({
        identity: relativeToRoot(identity),
        spellings,
      })),
    ).toEqual([]);
  });

  it("withholds only the alias, and the canonical source is still collected", async () => {
    // Stated from the other side, which is the half a dedupe can get wrong: a config that excluded
    // the canonical source instead of the alias would satisfy the assertion above while silently
    // dropping the Skill's evals from the run entirely.
    const groups = byPhysicalFile(await collectedTestFiles());
    const collectedSpellings = [...groups.values()].flat();

    for (const link of AGENT_DISCOVERY_LINKS) {
      expect(collectedSpellings.some(path => path.startsWith(`${link}/`)), link).toBe(false);
    }

    const canonical = collectedSpellings.filter(path => path.startsWith(`${CANONICAL_SKILLS_ROOT}/`));
    expect(canonical.length, "the canonical .agents Skill sources were not collected").toBeGreaterThan(0);
  });

  it("fails on a tree where the alias would be collected twice, so a green is not vacuous", async () => {
    // See the file header: this is the control on the fixture. Where the `.claude` links resolve —
    // Linux, and macOS — re-collecting with the exclusion withheld must show duplicates. Where they
    // do not resolve — a Windows checkout with `core.symlinks` false — there is nothing to
    // deduplicate, and the assertion says so rather than passing as if the fix had been verified.
    const collected = await collectedTestFiles();
    const vitest = await createVitest("test", { watch: false, run: true });
    let resolvedExclude: readonly string[];
    try {
      resolvedExclude = [...vitest.config.exclude];
    } finally {
      await vitest.close();
    }

    // The exclusion under test is in the config the run actually resolved — not merely written in
    // `vite.config.ts`, where a typo'd key would leave this reading identical and the collection
    // undeduplicated.
    const aliasPatterns = resolvedExclude.filter(pattern => pattern.includes(".claude"));
    expect(aliasPatterns.length, "vite.config.ts no longer excludes `.claude` from collection").toBeGreaterThan(0);

    const aliasResolves = AGENT_DISCOVERY_LINKS.some(link =>
      existsSync(join(repositoryRoot, link, "SKILL.md")),
    );
    if (!aliasResolves) {
      // A Windows checkout with `core.symlinks` false: git wrote the link target as a file, so
      // there is no alias to collect and nothing here can be verified. Reported, not silently green.
      process.stderr.write(
        "note: `core.symlinks` is false, so `.claude/skills/*` did not materialize as symlinks " +
          "and the #100 duplication cannot be reproduced on this machine; CI is what verifies it.\n",
      );
      return;
    }

    const withheld = resolvedExclude.filter(pattern => !pattern.includes(".claude"));
    const counterfactual = await collectedTestFiles(withheld);
    const duplicated = [...byPhysicalFile(counterfactual).values()].filter(spellings => spellings.length > 1);

    // The control on the control: withholding the exclusion must bring the duplicates *back*.
    // Without this, a `test.exclude` that excluded nothing at all would pass the first test and
    // this one, because both would be measuring an already-deduplicated tree.
    expect(
      duplicated.map(spellings => spellings.sort()),
      "withholding the `.claude` exclusion did not reproduce the duplication, so the first " +
        "assertion is not evidence that the exclusion is what removed it",
    ).not.toEqual([]);

    // And the duplication is the alias itself, not some unrelated pair: every duplicated group
    // must have exactly one `.claude` spelling and one `.agents` spelling.
    for (const spellings of duplicated) {
      expect(spellings.filter(path => path.startsWith(".claude/")).length).toBe(1);
      expect(spellings.filter(path => path.startsWith(`${CANONICAL_SKILLS_ROOT}/`)).length).toBe(1);
    }

    // Nothing in the counterfactual is missing from the real collection: the exclusion removes
    // duplicate *paths*, not test files. This is the "uniqueness is not reduced" half of #100's
    // acceptance, asserted against the toolchain's own two readings rather than by counting names.
    const realIdentities = new Set(byPhysicalFile(collected).keys());
    const counterfactualIdentities = byPhysicalFile(counterfactual).keys();
    expect([...counterfactualIdentities].filter(identity => !realIdentities.has(identity))).toEqual([]);
  }, 300_000);

  it("does not lint the same physical file under both path spellings", () => {
    // The lint half of the same deduplication, asserted through the linter's own structured output
    // rather than by scraping its rendered text — the finding count is what a reader sees in CI,
    // and it moves for reasons other than this rule (a new warning in a fixture, for instance), so
    // the assertion is about *which files* were reported, not how many findings they hold.
    const lintEntry = resolveVpEntry();
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [lintEntry, "lint", "--format", "json"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      // Oxlint exits non-zero only on errors, and this repository's policy is warnings-on-existing
      // noise, so a non-zero exit is a real finding to surface rather than a harness problem.
      stdout = (failure.stdout ?? "") + (failure.stderr ?? "");
    }

    const report = JSON.parse(stdout) as { diagnostics?: readonly { filename?: string }[] };
    const reportedFiles = [...new Set((report.diagnostics ?? []).map(diagnostic => diagnostic.filename))];

    // The control: the linter ran over this repository, so "no `.claude` findings" is about a
    // populated report. A linter that failed to start would produce no diagnostics and pass.
    expect(reportedFiles.length).toBeGreaterThan(0);

    expect(
      reportedFiles.filter(filename => filename?.startsWith(".claude/")),
      "a finding was reported under the `.claude` alias, so the alias is being linted a second time",
    ).toEqual([]);

    // Stated positively as well, because an over-broad ignore is the way this goes wrong: the
    // canonical Skill sources are still linted, and the probe fixtures under a committed
    // `node_modules` are still linted too — they are fixture data whose warnings are the point,
    // which a blanket `node_modules` ignore would hide.
    expect(reportedFiles.some(filename => filename?.startsWith(`${CANONICAL_SKILLS_ROOT}/`))).toBe(true);
    expect(reportedFiles.some(filename => filename?.includes("__fixtures__"))).toBe(true);
  }, 300_000);
});
