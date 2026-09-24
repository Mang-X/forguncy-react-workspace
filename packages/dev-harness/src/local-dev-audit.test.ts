import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditLocalDevConfiguration,
  formatLocalDevValidationDistinction,
  LOCAL_DEV_DIAGNOSTIC_RULES,
} from "@forguncy-react-workspace/runtime";
import type { FgcLockDocument, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import { createEmptyFgcLock, FGC_LOCK_SCHEMA_VERSION } from "@forguncy-react-workspace/core";

import {
  auditHarnessConfiguration,
  blockingLocalDevFindings,
  BlockingLocalDevFindingError,
  formatHarnessAudit,
  readProjectDependencyDecisions,
} from "./local-dev-audit.ts";

/**
 * #23's plan step 5, executed: what a project decided about its `extension` dependencies, and
 * whether the harness acts on it.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 5 asks for
 *   "a clear mechanism for extension-backed packages in local mode: explicit npm/local
 *   substitute or a diagnostic saying real-runtime validation is required"
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which owns both branches of
 *   that choice and the finding that blocks on its absence
 * - #4 — the strategy table whose `extension` row this exercises
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/4)
 *
 * ## What was wrong before this module existed, measured
 *
 * `runtime` had the whole mechanism and no caller: `auditLocalDevConfiguration`,
 * `assertLocalDevExtensionChoicesAreDeclared` and the three `local-dev-extension-*` rules were
 * reached only by `runtime`'s own unit tests. A grep for the audit outside `runtime` returned
 * nothing but re-exports. So the failure was not that the rule was wrong but that a real
 * `vp dev` never asked the question — and the consequence is specific enough to write down:
 * a Cell importing an `extension`-decided package resolved through the ordinary npm path, the
 * cell rendered, and the developer's conclusion ("this works locally") was wrong in a way nothing
 * in the output contradicted. That is `extension`'s whole reason for existing — module identity
 * and cross-cell singleton semantics — being silently traded for a guaranteed-looking render.
 *
 * ## Why the split is asserted against the contract rather than against a list
 *
 * The one thing this module could get wrong on its own is deciding *which* findings refuse a
 * server. A hand-written list of codes would silently downgrade a contract code added later with
 * `blocksLocalDevelopment: true`, and the failure would be a warning where the contract says
 * refusal. So the perturbation test below walks the entire diagnostic vocabulary and requires
 * this module's split to match `LOCAL_DEV_DIAGNOSTIC_RULES` for every code — including codes the
 * harness can never raise, which is what makes it a check on the *rule* rather than on the paths
 * exercised above it.
 *
 * ## The one place this file cannot test itself
 *
 * `readProjectDependencyDecisions` reproduces `readFgcLock`'s three behaviours rather than
 * importing them, for the measurement recorded in the module docstring (`dependency-resolver`'s
 * barrel evaluates `probe/*`, which imports `rolldown`: 617 ms against 46 ms, inside every
 * `vp dev` start). Two readers of one file can drift, and the cross-check at the end of this file
 * is what makes that a failing test instead of a silent difference. It is a `describe` and not a
 * comment because the drift would be invisible from either side alone.
 */

/** The repository root, so a test can name a committed example the way the harness does. */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A legal `extension` record for a project's lock.
 *
 * Typed as `LockedDependencyDecision` rather than `DependencyDecision`: the latter is the union
 * of the strategy-specific shapes, and only the *locked* form adds the record metadata
 * (`cellTarget`, `resolvedVersion`, `probe`, `target`, `probedWith`, `extension`,
 * `rejectedCandidate`) that a stored decision carries. The first draft returned
 * `DependencyDecision` and `tsc` refused it for exactly that reason — which is the type system
 * saying that a lock record is not merely a decision, and the distinction matters here because
 * this fixture is written to an `fgc.lock.json` that has to validate.
 */
function extensionDecision(packageName: string): LockedDependencyDecision {
  return {
    strategy: "extension",
    packageName,
    cellTarget: null,
    resolvedVersion: "5.102.8",
    // `globalName` and `libraryId` are not decoration: `core`'s validator requires both on an
    // `extension` record, and this fixture was rejected without them — which is the validator
    // working, since an extension whose global is unnamed is a `frontendLibraries` reference
    // nothing can resolve (#12).
    globalName: "TanStackQuery",
    libraryId: "tanstack-query",
    probe: { status: "passed", fingerprint: "probe=inline-bundle;entry=x", versionIndependent: false },
    target: {
      product: "Forguncy",
      productVersion: "12.0.100.0",
      productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
      hostReactVersion: "19.2.7",
    },
    probedWith: { vitePlus: "0.3.2" },
    extension: { version: "5.102.8", identity: "sha256:37df6a5941008a3de11d76d481ff9ab43331e6ed0b278a0ada69f803710bde3e" },
    rejectedCandidate: null,
    rationale: "A bundled copy would give every Cell its own QueryClient and query cache.",
    // Not decoration either, and this is the third thing `core`'s validator taught this fixture:
    // an `extension` decision needs evidence (a strategy change must link what it rests on) *and*
    // a `passed` probe needs a `probe` or `runtime-observation` link specifically. A
    // `spec-issue` link alone does not satisfy the second rule. Hand-building a legal record was
    // getting longer than the thing under test, so the cross-check below runs against the
    // project's **committed** lock instead — which is legal by construction, and is the artifact
    // the dev server actually meets.
    evidence: [
      {
        kind: "runtime-observation",
        reference: "https://github.com/MangMax/forguncy-react-library/blob/main/packages/tanstack-query/report.md",
      },
    ],
  } as LockedDependencyDecision;
}

/** The substitute branch: the project stands the extension in for locally, with its reason. */
const substitute = {
  packageName: "@tanstack/react-query",
  mode: "substitute",
  kind: "npm-package",
  resolvesTo: "@tanstack/react-query",
  justification: "Local UI work; the cross-cell singleton semantics are not exercised locally.",
} as const;

/** The other branch: the project accepts that validation happens on the page. */
const realRuntimeOnly = {
  packageName: "@tanstack/react-query",
  mode: "real-runtime-only",
  reason: "The extension's cross-cell singleton is the whole reason it is an extension.",
  consequence: "The local render uses the npm copy, so nothing here exercises the shared cache.",
} as const;

describe("an `extension` dependency with no declared local choice is refused, not approximated", () => {
  it("reports the missing declaration as blocking, through the contract's own rule", () => {
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [],
    });

    const blocking = blockingLocalDevFindings(audit);
    expect(blocking.map(finding => finding.code)).toEqual(["local-dev-extension-needs-substitute"]);
    // The asymmetry with the version warning beside it is the *contract's* and is asserted
    // against the contract, so a future change to `blocksLocalDevelopment` moves both together.
    expect(LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-extension-needs-substitute"].blocksLocalDevelopment).toBe(true);
    expect(LOCAL_DEV_DIAGNOSTIC_RULES["local-dev-host-version-mismatch"].blocksLocalDevelopment).toBe(false);
  });

  it("names the package and both ways to fix it, rather than reporting a bare absence", () => {
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [],
    });
    const report = formatHarnessAudit(audit);

    expect(report).toContain("@tanstack/react-query");
    // Both branches are named in the remediation, because the finding is "you declared neither"
    // rather than "you declared the wrong one" — and the second message is a different code.
    expect(report).toContain("real-runtime-only");
    expect(report).toContain("substitute");
    // The fix owner travels with the finding, so the reader is not left to guess whose config
    // this is. That is `formatLocalDevDiagnostic`'s format, printed rather than paraphrased.
    expect(report).toContain("fix owner: dependency-decision");
    expect(report).toContain("blocks local development");
  });

  it("is a decision and not an omission when the project declared a substitute", () => {
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [substitute],
    });

    expect(blockingLocalDevFindings(audit)).toEqual([]);
    expect(audit.diagnostics).toEqual([]);
    // The control for the case above: the *same* decision that blocks without a choice is clean
    // with one, so the finding is about the declaration and not about the decision being
    // `extension`. Without this, a harness that refused every `extension` dependency would pass.
    expect(formatHarnessAudit(audit)).toContain("No dependency is recorded as real-runtime-only.");
  });

  it("reports a `real-runtime-only` acknowledgement without blocking it", () => {
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [realRuntimeOnly],
    });

    expect(blockingLocalDevFindings(audit)).toEqual([]);
    // Reported, and this is the distinction the whole two-branch model exists for: a project that
    // chose this branch has not forgotten anything, so reporting it as an omission would teach
    // people to ignore the finding that *is* an omission.
    expect(audit.diagnostics.map(finding => finding.code)).toEqual(["local-dev-extension-real-runtime-only"]);
    expect(audit.realRuntimeOnly).toEqual(["@tanstack/react-query"]);
    // And it reaches the console by name: a developer needs to know *which* dependency the loop
    // cannot exercise, not merely that one exists.
    expect(formatHarnessAudit(audit)).toContain("Left to real-runtime validation by decision: @tanstack/react-query");
  });

  it("refuses a declaration that names a branch and not its content, as the contract's error", () => {
    // An acknowledgement with an empty `consequence` is the omission that learned the vocabulary:
    // it says "I accept this" without saying what is being accepted. The guard owns this, so the
    // error is the guard's rather than a finding from the audit one layer later.
    expect(() =>
      auditHarnessConfiguration({
        decisions: [extensionDecision("@tanstack/react-query")],
        extensionChoices: [{ ...realRuntimeOnly, consequence: "  " }],
      }),
    ).toThrow(/is not a decision/);
  });

  it("refuses two branches for one package instead of letting list order pick one", () => {
    expect(() =>
      auditHarnessConfiguration({
        decisions: [extensionDecision("@tanstack/react-query")],
        extensionChoices: [substitute, realRuntimeOnly],
      }),
    ).toThrow(/more than one local choice/);
  });
});

describe("the audit's blocking split is read off the contract, not written here", () => {
  /**
   * Derivation, proved by walking the whole vocabulary.
   *
   * The claim in `local-dev-audit.ts` is that `blockingLocalDevFindings` defers to
   * `LOCAL_DEV_DIAGNOSTIC_RULES`. A hand-written list would agree with the contract *today* and
   * disagree the first time a code were added or flipped, so this asserts the rule for every code
   * the contract defines — including ones no input here can produce, which is what makes it a
   * check on the derivation rather than a restatement of the cases above.
   */
  it("agrees with `blocksLocalDevelopment` for every code in the vocabulary", () => {
    const codes = Object.keys(LOCAL_DEV_DIAGNOSTIC_RULES) as (keyof typeof LOCAL_DEV_DIAGNOSTIC_RULES)[];
    expect(codes.length).toBeGreaterThan(0);

    for (const code of codes) {
      // A synthetic audit carrying one finding per code, so the split is asked about the whole
      // vocabulary instead of about the codes these inputs happen to raise.
      const audit = {
        ...auditLocalDevConfiguration({}),
        diagnostics: [{ code, subject: "probe", detail: "probe" }],
      };
      const blocking = blockingLocalDevFindings(audit);

      expect(blocking.length, `code "${code}"`).toBe(
        LOCAL_DEV_DIAGNOSTIC_RULES[code].blocksLocalDevelopment ? 1 : 0,
      );
    }
  });

  it("does not report a finding as blocking that the contract calls reportable", () => {
    // The direction that matters at runtime: a harness that blocked on everything would refuse a
    // server for a deferred module or a version mismatch, which the contract says it must not.
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [realRuntimeOnly],
    });

    expect(audit.diagnostics.length).toBeGreaterThan(0);
    expect(blockingLocalDevFindings(audit)).toEqual([]);
  });
});

describe("the report states the local-versus-real distinction at the moment the loop starts", () => {
  it("carries `runtime`'s own distinction text rather than a paraphrase", () => {
    const report = formatHarnessAudit(auditHarnessConfiguration({ decisions: [], extensionChoices: [] }));

    // The same string, not a lookalike: #23's plan step 5 and #22's fifth criterion both ask for
    // the distinction, and two copies of it are two places for it to drift. Asserted by sampling
    // both ends of the contract's own text, so a report that grew its own summary fails here.
    const distinction = formatLocalDevValidationDistinction();
    expect(report).toContain(distinction);
    expect(report).toContain("does not establish any real-runtime check");
  });

  it("corrects the claim that this package printed the distinction, by printing it", () => {
    // `index.ts` has said since the package was written that
    // "`formatLocalDevValidationDistinction()` is the report of what remains owed, and this
    // package prints it rather than paraphrasing it" — while nothing in the package called it.
    // A green local render is exactly when a reader is most likely to mistake local for
    // compatible, so the text appears in the startup report and not only on request.
    expect(formatHarnessAudit(auditHarnessConfiguration({ decisions: [], extensionChoices: [] }))).toContain(
      "Local Vite+ development produces `local` evidence only.",
    );
  });

  it("says the extension question was answered, in both directions", () => {
    // Silence would read the same whether the project declared `real-runtime-only` or the audit
    // never asked. Both lines are asserted, because the empty one is the easier to drop in a
    // refactor and the one a developer with no `extension` dependencies actually sees.
    const none = formatHarnessAudit(auditHarnessConfiguration({ decisions: [], extensionChoices: [] }));
    const some = formatHarnessAudit(
      auditHarnessConfiguration({
        decisions: [extensionDecision("@tanstack/react-query")],
        extensionChoices: [realRuntimeOnly],
      }),
    );

    expect(none).toContain("No dependency is recorded as real-runtime-only.");
    expect(some).toContain("Left to real-runtime validation by decision:");
    expect(some).not.toContain("No dependency is recorded as real-runtime-only.");
  });
});

describe("the lock reader, and the guard that keeps it in step with `readFgcLock`", () => {
  /** A project root in a temp directory, so nothing here touches a committed file. */
  async function tempProject(): Promise<string> {
    return mkdtemp(join(tmpdir(), "dev-harness-lock-"));
  }

  it("treats an absent lock as no decisions, which is a normal first-run state", async () => {
    const root = await tempProject();

    await expect(readProjectDependencyDecisions(join(root, "fgc.lock.json"))).resolves.toEqual([]);
    // The control: the reader was pointed at a real path in a real directory, so the empty answer
    // is about the missing file rather than about a path that does not exist at all.
    await expect(readFile(join(root, "absent.txt"), "utf8")).rejects.toThrow();
  });

  it("reads a committed lock's decisions, through migration and validation", async () => {
    const root = await tempProject();
    const lock: FgcLockDocument = {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [extensionDecision("@tanstack/react-query")],
    };
    await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock), "utf8");

    const decisions = await readProjectDependencyDecisions(join(root, "fgc.lock.json"));

    expect(decisions.map(decision => decision.packageName)).toEqual(["@tanstack/react-query"]);
    expect(decisions[0]?.strategy).toBe("extension");
  });

  it("refuses a malformed lock instead of reading it as no decisions", async () => {
    const root = await tempProject();
    // A file that exists and is not a lock: reporting `[]` here would make "this project decided
    // nothing" indistinguishable from "this project's decisions could not be read", and the audit
    // would then pass a project it knows nothing about — the silent pass this module prevents.
    await writeFile(join(root, "fgc.lock.json"), "{ not json", "utf8");

    await expect(readProjectDependencyDecisions(join(root, "fgc.lock.json"))).rejects.toThrow(
      /not a lock this toolchain accepts/,
    );
  });

  /**
   * The drift guard, and the reason this file imports `dependency-resolver` at all.
   *
   * `readProjectDependencyDecisions` duplicates `readFgcLock`'s argument handling deliberately —
   * the module docstring records why (the barrel statically reaches `probe/build.ts`, which
   * imports `rolldown`, and this runs inside `vite.config.ts`'s graph). A duplication is a place
   * for two readers of one file to disagree, and neither side can see it alone: `readFgcLock`
   * would keep passing its own tests while the harness acted on a different reading.
   *
   * So both are run over the same real files and required to agree. It is a *devDependency* and
   * not a dependency, which is the whole arrangement: `src/` must not import the barrel (that is
   * the cost being avoided), while a test may, so the cost is paid once by the suite rather than
   * by every dev server.
   *
   * The committed lock is included on purpose. A hand-built fixture has already been rejected
   * three times by `core`'s validator in this file — missing `globalName`, missing evidence,
   * evidence of the wrong kind — and each rejection was correct. `examples/extension-query`'s lock
   * is a real record that passed the real probe flow, so it is the one input here whose legality
   * is not this test's own opinion.
   */
  it("agrees with `dependency-resolver`'s `readFgcLock` on every real file it could meet", async () => {
    const { readFgcLock } = await import("@forguncy-react-workspace/dependency-resolver");

    // The project's own committed lock, which the audit this test suite guards will read at
    // `vp dev` start in that example.
    const committedRoot = join(repositoryRoot, "examples", "extension-query");
    const committed = await readFgcLock(committedRoot);
    // The control: a legal lock with decisions in it, so the agreement below is about a real
    // record rather than about two readers both answering "empty" to an absent file.
    expect(committed.decisions.length).toBeGreaterThan(0);
    expect(await readProjectDependencyDecisions(join(committedRoot, "fgc.lock.json"))).toEqual(committed.decisions);

    const root = await tempProject();

    // Absent: the first-run case.
    await expect(readFgcLock(root)).resolves.toEqual(createEmptyFgcLock());
    expect(await readProjectDependencyDecisions(join(root, "fgc.lock.json"))).toEqual(
      (await readFgcLock(root)).decisions,
    );

    // Present and legal.
    const lock: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [extensionDecision("x")] };
    await writeFile(join(root, "fgc.lock.json"), JSON.stringify(lock), "utf8");
    expect(await readProjectDependencyDecisions(join(root, "fgc.lock.json"))).toEqual(
      (await readFgcLock(root)).decisions,
    );

    // Present and malformed: both refuse, so neither can silently report an empty project. This
    // is the direction that matters most — a reader that answered `[]` here would make "this
    // project decided nothing" indistinguishable from "this project's record is unreadable", and
    // the audit would then pass a project it knows nothing about.
    await writeFile(join(root, "fgc.lock.json"), "{ not json", "utf8");
    await expect(readFgcLock(root)).rejects.toThrow();
    await expect(readProjectDependencyDecisions(join(root, "fgc.lock.json"))).rejects.toThrow();
  });
});

describe("a blocking finding is a typed refusal, so a caller can tell it from a broken server", () => {
  it("carries the findings and a message that is the report", () => {
    const audit = auditHarnessConfiguration({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionChoices: [],
    });
    const blocking = blockingLocalDevFindings(audit);
    const report = formatHarnessAudit(audit);
    const error = new BlockingLocalDevFindingError(blocking, report);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BlockingLocalDevFindingError");
    expect(error.findings).toEqual(blocking);
    // The remediation travels in the message rather than only in a field: the person who sees
    // this in a terminal has the fix without running a second command, and a test asserting on
    // `findings` would not catch a message that dropped it.
    expect(error.message).toContain("@tanstack/react-query");
    expect(error.message).toContain("substitute");
  });
});
