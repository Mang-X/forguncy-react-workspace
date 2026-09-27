import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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
 * `vp lint --debug=files`, which prints the files it will lint and exits without linting.
 *
 * That flag rather than `--format json` is a review finding, and the difference is not cosmetic:
 * diagnostics only name files that *have* a finding, so a control built on them makes whatever
 * warnings the repository happens to carry into this test's fixture. The file list is the tool's
 * account of the walk itself, and on this tree it is identical before and after silencing the
 * three unrelated `.agents` warnings, while the diagnostics change.
 *
 * ## The counterfactual, and what it is for
 *
 * A test that asserts "no duplicate realpaths" passes trivially in a tree where the alias is
 * **absent** — which is exactly the state a Windows checkout is in, because `core.symlinks` is
 * false there and git writes the link target as a plain file. So on this repository's own Windows
 * machine the guard would be green for the wrong reason, and would stay green if `test.exclude`
 * were deleted, and CI would be the only place anything noticed.
 *
 * That is what each half's control is for, and they take different shapes because the two tools
 * offer different readings:
 *
 * - **Vitest** re-collects with the `.claude` exclusion withheld and requires the duplicates to
 *   **appear**. It is a control on the fixture: it fires when a reader's environment has no alias
 *   to deduplicate, and fails loudly instead of quietly reporting a green.
 * - **Oxlint** pairs the two spellings for every file under the alias, read from the filesystem,
 *   and requires each to be on the linter's list under its canonical spelling and not its alias
 *   one. `--ignore-pattern` only *adds* exclusions, so there is no way to withdraw this one from
 *   the command line; the filesystem walk supplies the counterfactual instead.
 *
 * This repository already has this exact problem documented: a Windows checkout materializes these
 * two links as files containing the relative path, so the `.claude` suite does not run locally at
 * all. Both controls make that visible rather than leaving it to CI.
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
 * The files the linter says it will lint, in repository-relative `/`-separated spelling.
 *
 * `--debug=files` is the tool's own account of that list and prints it to stdout, then exits
 * without linting. It is the right reading here because it is **independent of the repository's
 * warnings** — which the first draft of this file got wrong: asserting that canonical `.agents`
 * paths appeared among `--format json` *diagnostics* made three unrelated warnings load-bearing
 * for a test about symlink deduplication, so cleaning them up would have failed it. Verified on
 * this tree: this list is byte-identical before and after silencing those warnings, while the
 * diagnostics change.
 */
function lintedFiles(): readonly string[] {
  const output = execFileSync(process.execPath, [resolveVpEntry(), "lint", "--debug=files"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  // Same disable as `vp-dev-command.test.ts`'s banner reader, on the line carrying the pattern for
  // that hook's reason: matching the escape byte is the point, because `--debug=files` output is
  // coloured whether or not anything reads it.
  // eslint-disable-next-line no-control-regex -- matching the escape byte is the entire point of this pattern.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");

  return plain
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/** Extensions the linter's default walk considers, used only to pair the two spellings. */
const LINTABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

/** Every lintable file under `directory`, following the tree rather than the linter's ignore list. */
function lintableFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (LINTABLE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) {
        found.push(path);
      }
    }
  };
  if (existsSync(directory)) {
    walk(directory);
  }

  return found;
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
    // The lint half of the same deduplication. It reads the linter's **file list**, not its
    // diagnostics, and that distinction is the whole reason this test survives maintenance.
    //
    // The first draft asserted on `--format json` diagnostics under the canonical paths, and a
    // review found that turns the repository's current warnings into this test's fixture. The
    // `.agents` findings it required are ordinary warnings with nothing to do with #100, so
    // anybody eventually cleaning them up — the correct thing to do — would have failed a
    // regression test about symlink deduplication. Reproduced: silencing the three `.agents`
    // warnings, with the deduplication config untouched, failed this test.
    //
    // `--debug=files` is the tool's own account of which files it will lint, which is exactly the
    // property in question and is independent of whether any warning exists. Verified on this tree:
    // the list is byte-identical before and after silencing those three warnings, while the
    // diagnostics changed. So the control below cannot be maintained into a false failure, and an
    // empty or truncated list still fails it because the canonical sources must appear.
    const linted = lintedFiles();
    const lintedSet = new Set(linted);

    // The control: the linter walked this repository, and the list is the linter's own — so "no
    // `.claude` entries" is about a populated walk rather than about a command that never ran.
    expect(linted.length).toBeGreaterThan(50);

    expect(
      linted.filter(path => path.startsWith(".claude/")),
      "the `.claude` alias is in the lint file list, so it is being linted a second time",
    ).toEqual([]);

    // Stated positively, because an over-broad ignore is how this goes wrong: the probe fixtures
    // under a committed `node_modules` are miniature dependency trees that *are* fixture data, and
    // a blanket `node_modules` ignore would hide them along with everything else under that name.
    // Warnings-independent like the rest of this test — they are on the list because they exist.
    expect(linted.some(path => path.includes("__fixtures__"))).toBe(true);

    // The counterfactual, which the Vitest half also carries and for the same reason: on a Windows
    // checkout with `core.symlinks` false the alias is not a directory at all, so "no `.claude`
    // entries" is true for a reason unrelated to the exclusion. Reported rather than passed.
    if (!AGENT_DISCOVERY_LINKS.some(link => existsSync(join(repositoryRoot, link, "SKILL.md")))) {
      process.stderr.write(
        "note: `core.symlinks` is false, so `.claude/skills/*` did not materialize as symlinks " +
          "and the #100 duplication cannot be reproduced on this machine; CI is what verifies it.\n",
      );
      return;
    }

    // The pairing that makes the assertion above non-vacuous, and the reason it does not need a
    // second linter run to be meaningful: enumerate the lintable files under the alias *from the
    // filesystem*, then require that each one appears on the linter's list under its **canonical**
    // spelling and **not** under its alias spelling. That is a statement about this walk, not
    // about whether the walk would otherwise have included the alias — a reading the tool does not
    // offer, since `--ignore-pattern` adds exclusions and cannot withdraw one.
    const aliasFiles = lintableFilesUnder(join(repositoryRoot, AGENT_DISCOVERY_LINKS[0]));
    expect(
      aliasFiles.length,
      "no lintable file was found under the `.claude` alias, so this assertion would be vacuous",
    ).toBeGreaterThan(0);

    const canonicalWithoutAlias: string[] = [];
    const aliasStillListed: string[] = [];
    for (const file of aliasFiles) {
      const canonicalSpelling = relativeToRoot(realpathSync(file));
      const aliasSpelling = relativeToRoot(file);
      if (lintedSet.has(aliasSpelling)) {
        aliasStillListed.push(aliasSpelling);
      } else if (!lintedSet.has(canonicalSpelling)) {
        canonicalWithoutAlias.push(canonicalSpelling);
      }
    }

    // Nothing was dropped by excluding the alias: every file it holds is still linted once, under
    // the `.agents` path. This is the "uniqueness is not reduced" half of #100's acceptance,
    // asserted by pairing the two spellings rather than by counting them.
    expect(
      canonicalWithoutAlias,
      "a file under the `.claude` alias is neither linted by its alias spelling nor by its " +
        "canonical one, so the alias exclusion dropped it instead of deduplicating it",
    ).toEqual([]);
    expect(
      aliasStillListed,
      "a file under the `.claude` alias is linted by its alias spelling, so it is linted twice",
    ).toEqual([]);
  }, 300_000);
});

