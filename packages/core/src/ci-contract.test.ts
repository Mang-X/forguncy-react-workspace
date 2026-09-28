/**
 * The repository's own CI contract, pinned where a change to it has to be deliberate.
 *
 * Decision source: GitHub Issue #101 — "CI across platforms: add Windows Node 24 plus path,
 * line-ending and evidence-integrity regressions"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/101
 *
 * ## The rule this file exists to keep
 *
 * `main` is protected by the repository ruleset recorded in
 * `.github/rulesets/main-pr-ci-protection.json`, and that ruleset requires a status check whose
 * **context is the literal string `check`** (integration 15368). A required check matches by
 * name: renaming the job, or replacing it with a matrix whose legs report as
 * `check (ubuntu-latest)`, silently orphans the requirement, and a PR then waits on a check that
 * can never report. That failure is invisible in the diff that causes it — the workflow still
 * runs and still goes green — which is why it is pinned here rather than left to review.
 *
 * So the shape #101 requires is **additive**: a second, independently named job for Windows, with
 * the existing `check` job and its name untouched. This file asserts both halves — that the
 * required context survives, and that a Windows Node 24 leg exists at all — because either one
 * alone can be satisfied while the Issue's outcome is not.
 *
 * ## What this can and cannot say
 *
 * It reads the workflow and the ruleset record as text. That is a real limit: it proves the two
 * files agree with each other, not that GitHub's server has the ruleset applied (the record is a
 * copy; see #38 for why it cannot be the live object) and not that a Windows runner accepts the
 * steps. Those are runtime facts, and the honest local statement is that this file pins the
 * *repository's* half of the contract.
 *
 * ## Why jobs are split rather than pattern-matched over the whole file
 *
 * A YAML shape is easy to satisfy accidentally: a `windows-latest` somewhere in the file would
 * match a naive search even if it belonged to an unrelated job, and a `node-version: "24"` in one
 * job says nothing about another. So the workflow is split into its top-level job blocks first,
 * and every assertion names the one job it is about. Line endings are normalized on read for the
 * reason #91 recorded — a Windows checkout is CRLF, and a test that regex-matches file contents
 * must not depend on what Git did to them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A repository file's text, with line endings normalized to LF.
 *
 * Centralized rather than repeated per assertion for the reason `#91` recorded: a test that
 * regex-matches file *contents* must not depend on what the reader's Git did to the file. A
 * Windows checkout is CRLF without a `.gitattributes`, and the `.gitattributes` this PR adds
 * cannot be relied on by the test that asserts it exists.
 */
function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * The workflow split into its top-level jobs: name to that job's own configuration lines.
 *
 * Deliberately a small hand-rolled splitter rather than a YAML dependency: the shape being read
 * is one this repository writes, and `jobs:` with two-space-indented job keys is the whole of it.
 * A dependency here would be a second thing to keep fresh for no gain.
 *
 * **Comment lines are dropped, and that is load-bearing rather than tidiness.** A job's own
 * explanatory comment sits *above* its key, so it is appended to the *previous* job's body by any
 * splitter that only looks for declarations — measured: with the workflow as written,
 * `blocks.get("check")` contains `check-windows`'s prose. These assertions are about what a job
 * *does* (`runs-on:`, `matrix:`, the install `args:`), so prose that merely discusses those words
 * must not be able to satisfy — or trip — a check. Without this, documenting "do not make this a
 * matrix: …" beside the job would fail the very guard it was describing.
 */
function jobBlocks(workflow: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  let inJobs = false;

  for (const line of workflow.replace(/\r\n/g, "\n").split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs || line.trimStart().startsWith("#")) {
      continue;
    }
    const declared = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (declared !== null) {
      if (current !== undefined) {
        jobs.set(current, body.join("\n"));
      }
      current = declared[1] as string;
      body = [];
      continue;
    }
    if (current !== undefined) {
      body.push(line);
    }
  }

  if (current !== undefined) {
    jobs.set(current, body.join("\n"));
  }

  return jobs;
}

/** The status-check contexts the recorded ruleset requires, paired with the app they must come from. */
function requiredStatusChecks(): readonly { context: string; integrationId: number }[] {
  const ruleset = JSON.parse(readRepositoryFile(".github/rulesets/main-pr-ci-protection.json")) as {
    rules: readonly {
      type: string;
      parameters?: { required_status_checks?: readonly { context: string; integration_id?: number }[] };
    }[];
  };
  const rule = ruleset.rules.find(entry => entry.type === "required_status_checks");

  return (rule?.parameters?.required_status_checks ?? []).map(entry => ({
    context: entry.context,
    integrationId: entry.integration_id as number,
  }));
}

const ciWorkflow = (): Map<string, string> =>
  jobBlocks(readRepositoryFile(join(".github", "workflows", "ci.yml")));

describe("the CI workflow keeps the required check and adds a Windows leg", () => {
  it("still exposes a job named exactly `check`, which is what the ruleset requires", () => {
    // The ruleset's requirement, read from the record rather than restated, so the two files
    // cannot drift apart without this test failing. The `integration_id` is part of it: GitHub
    // matches a required check on the (context, app) pair, so a same-named context published by
    // a different integration does not satisfy the rule — asserting only the context would call
    // such a ruleset satisfied.
    expect(requiredStatusChecks()).toEqual([{ context: "check", integrationId: 15368 }]);
    expect(ciWorkflow().has("check")).toBe(true);
  });

  it("runs the required `check` job on Linux, so its name stays a single unambiguous context", () => {
    const check = ciWorkflow().get("check") ?? "";

    expect(check).toContain("runs-on: ubuntu-latest");
    // The name is `check` only while the job is not a matrix: GitHub reports a matrix leg as
    // `check (ubuntu-latest)`, a different string the ruleset does not require.
    expect(check).not.toContain("matrix:");
  });

  it("runs the platform-sensitive suite on Windows with Node 24", () => {
    const windows = ciWorkflow().get("check-windows") ?? "";

    expect(windows, "a `check-windows` job must exist").not.toBe("");
    expect(windows).toContain("runs-on: windows-latest");
    expect(windows).toContain('node-version: "24"');
    // The same gates the Linux job runs. A Windows leg that only installed would not deliver
    // #101's outcome, so the gates are named rather than left to "whatever the other job does":
    // `vp check` is lint, and `vp run typecheck` is the separate TypeScript gate that a green
    // `vp check` does not imply.
    expect(windows).toContain("vp toolchain");
    expect(windows).toContain("vp check");
    expect(windows).toContain("vp test --run");
    expect(windows).toContain("vp run typecheck");
  });

  it("installs from the frozen lockfile on each leg, so a stale lock fails every platform", () => {
    // Per-leg, and reading it per-leg is the whole point. A global count over the file is
    // satisfied by an offsetting edit — measured: removing the flag from `check-windows` and
    // adding a duplicate inside `check` keeps the count at two while the Windows leg stops
    // checking the lockfile, which is the failure this assertion exists to prevent.
    //
    // Matched on the `args:` line that actually configures the install rather than on any
    // occurrence of the flag: the comment above the Linux install names it too while explaining
    // why it is passed, so an occurrence count over the raw text is not a count of installs.
    const install = /args: \['--frozen-lockfile'\]/;

    for (const job of ["check", "check-windows"]) {
      expect(ciWorkflow().get(job), `the ${job} job`).toMatch(install);
    }
  });

  it("keeps read-only workflow permissions", () => {
    const workflow = readRepositoryFile(join(".github", "workflows", "ci.yml"));

    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toMatch(/contents: write/);
  });
});

describe("the repository fixes its own line endings", () => {
  it("declares LF for text files in a tracked .gitattributes", () => {
    const attributes = readRepositoryFile(".gitattributes");

    // `text=auto` normalizes the index; `eol=lf` makes the checkout deterministic. Both are
    // needed: the first keeps the stored blob stable, the second is the one that makes a Windows
    // checkout match CI byte-for-byte.
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  it("leaves probe-engine.ts to Git's binary detection, because it holds a literal NUL", () => {
    // The file carries two U+0000 code points in a string literal, which is what makes Git treat
    // it as binary — and that is correct: marking it `text` would make Git normalize the bytes of
    // the very literal the file exists to hold. The pin is that no later rule reintroduces it,
    // matched as an *attribute rule* (`probe-engine … text`) rather than as the bare filename,
    // which the comment above the rule legitimately mentions while explaining this.
    const attributes = readRepositoryFile(".gitattributes");

    expect(attributes).not.toMatch(/probe-engine\S*\s+\S*text/);
  });
});
