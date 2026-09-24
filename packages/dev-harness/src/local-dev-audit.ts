/**
 * The project's local-development configuration, audited at dev-server start (#23 plan step 5).
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 5 asks for
 *   "a clear mechanism for extension-backed packages in local mode: explicit npm/local
 *   substitute or a diagnostic saying real-runtime validation is required", and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose fifth acceptance
 *   criterion is "Documentation/Skill clearly distinguishes local simulation from real
 *   Forguncy validation".
 *
 * ## The gap this module closes, stated exactly
 *
 * `runtime`'s `local-dev.ts` already decides *what* a local process may stand in for and what it
 * may then claim: `LocalDevExtensionChoice` is the two branches #22 allows, the validators that
 * refuse an empty one, and `auditLocalDevConfiguration` that turns a project's declarations into
 * findings. All of it was tested and none of it was reached. Every reported finding —
 * `local-dev-extension-needs-substitute` included, which the contract marks
 * `blocksLocalDevelopment: true` — was produced only by `runtime`'s own unit tests, so under a
 * real `vp dev` a Cell importing an `extension`-decided package resolved silently through the
 * ordinary npm path.
 *
 * That is precisely the failure #22's record exists to prevent, and it is worth naming why it is
 * worse than a missing diagnostic: `extension` is the one strategy whose *reason for existing* is
 * module identity or cross-cell singleton semantics, so a local run that loads an npm copy
 * produces a cell that renders correctly and a conclusion that is wrong. A developer cannot see
 * the difference, which is why the contract marks it as blocking rather than merely reportable.
 *
 * So this module is *wiring*, and it says so: it reads the two inputs the audit needs, calls the
 * audit, and splits its findings by the contract's own `blocksLocalDevelopment` — never by a list
 * written here. Nothing in this file decides what is a problem.
 *
 * ## Why the lock is read here and not through `readFgcLock`
 *
 * The obvious choice is `dependency-resolver`'s `readFgcLock`, and it is the wrong one for one
 * reason: importing that package's barrel evaluates every `probe/*` module, and
 * `probe/build.ts` statically imports `rolldown`:
 *
 * ```
 * import { rolldown, type OutputAsset, type OutputChunk } from "rolldown";
 * ```
 *
 * That is read off the import graph rather than inferred from a timing, and the timings that
 * motivated looking were noisy enough that they should not be quoted: what is *verified* is the
 * static edge, plus the scope it lands in. This module is loaded from `vite.config.ts`'s module
 * graph, so the edge would pull a bundler into the config load of every project that so much as
 * names the harness plugin, in order to read a file of at most a few kilobytes. (`lock-store.ts`,
 * which holds `readFgcLock`, imports none of that — the cost is the barrel, not the reader.)
 *
 * So the reader below is `readFgcLock`'s three behaviours, and the shared half is *imported*
 * rather than reproduced: `parseMigratedFgcLockDocument` and `createEmptyFgcLock` come from
 * `core`, which is already in this graph. What is duplicated is only the argument — this reads
 * the path `registry.runtime.dependencyLockPathAbsolute` names, while `readFgcLock` takes a
 * project root and always appends `fgc.lock.json`, so the two differ on a project that declared
 * `runtime.dependencyLockPath` at all. That divergence is intended and is the reason this module
 * does not simply call it.
 *
 * Two readers of one file can still drift, and the drift would be silent, so it is guarded rather
 * than asserted: `local-dev-audit.test.ts` runs **both** readers over the same real files — an
 * absent lock, a legal one, a malformed one — and requires equal results. That test reaches
 * `dependency-resolver` through a **devDependency**, which is the arrangement that makes this
 * work: `src/` must not import it, a test may, so the cost is paid once by the suite instead of by
 * every dev server.
 */

import { readFile } from "node:fs/promises";

import {
  createEmptyFgcLock,
  FGC_LOCK_FILE_NAME,
  parseMigratedFgcLockDocument,
} from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";
import {
  assertLocalDevExtensionChoicesAreDeclared,
  auditLocalDevConfiguration,
  formatLocalDevDiagnostic,
  formatLocalDevValidationDistinction,
  LOCAL_DEV_DIAGNOSTIC_RULES,
} from "@forguncy-react-workspace/runtime";
import type { LocalDevAudit, LocalDevDiagnostic, LocalDevExtensionChoice } from "@forguncy-react-workspace/runtime";

/**
 * Raised when the audit finds a condition the contract says blocks local development.
 *
 * Its own type rather than a bare `Error`, so a test — and a future caller — can tell "this
 * project's local configuration is incomplete" apart from "the dev server failed to start for
 * some other reason". The message is the formatted report, so the person who sees it in a
 * terminal has the finding, its remediation and its fix owner without a second command.
 */
export class BlockingLocalDevFindingError extends Error {
  /** The findings that refused the server, in the audit's order. */
  readonly findings: readonly LocalDevDiagnostic[];

  constructor(findings: readonly LocalDevDiagnostic[], report: string) {
    super(report);
    this.name = "BlockingLocalDevFindingError";
    this.findings = findings;
  }
}

/**
 * The dependency decisions the project's lock records.
 *
 * `readFgcLock`'s behaviour reproduced without `dependency-resolver`'s barrel — see the module
 * docstring for the measurement, and `local-dev-audit.test.ts` for the guard that keeps the two
 * in step. Three cases, all of them `readFgcLock`'s:
 *
 * - **no file** is an empty lock rather than an error, because "no decision recorded yet" is a
 *   normal state for a project and failing here would force every first run to special-case it;
 * - **a file that exists** goes through the full migration-then-validation path, so an older
 *   document is brought forward and an illegal one is refused. Both halves matter: reading the
 *   JSON without `parseMigratedFgcLockDocument` would let this module act on a record the
 *   compiler would reject;
 * - **anything else** — unreadable, malformed — propagates. A lock this process cannot read is
 *   not "no decisions", and treating it as one would be the silent pass this whole module exists
 *   to prevent.
 */
export async function readProjectDependencyDecisions(
  lockPathAbsolute: string,
): Promise<readonly DependencyDecision[]> {
  let text: string;
  try {
    text = await readFile(lockPathAbsolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyFgcLock().decisions;
    }
    throw new Error(`The project's ${FGC_LOCK_FILE_NAME} at ${lockPathAbsolute} could not be read: ${String(error)}`);
  }

  try {
    return parseMigratedFgcLockDocument(text).decisions;
  } catch (error) {
    throw new Error(
      `The project's ${FGC_LOCK_FILE_NAME} at ${lockPathAbsolute} is not a lock this toolchain accepts, so the local loop cannot say whether the Cell's dependencies are exercised locally: ${String(error)}`,
    );
  }
}

/** The two inputs the audit needs, both of them the project's own declarations. */
export interface HarnessAuditInput {
  /** The decisions the project's lock records, as {@link readProjectDependencyDecisions} answers. */
  readonly decisions: readonly DependencyDecision[];
  /**
   * What the project decided about each of its `extension` dependencies.
   *
   * Validated by `runtime`'s own guard rather than here, so a malformed entry is refused by the
   * module that owns the vocabulary instead of by a second opinion about it. An entry that has
   * learned the two branch names and not their content is exactly the omission the guard exists
   * to catch, and restating its rules here is how the two would come apart.
   */
  readonly extensionChoices: readonly LocalDevExtensionChoice[];
}

/**
 * Audit the project's local configuration, through the contract that owns the rules.
 *
 * The audit is called with **no `installedVersions`**, and that abstention is a decision rather
 * than an omission: the harness already reports host-version drift through
 * `formatHostVersionWarning`, from the same `localDevAlignmentChecks` rows this audit's
 * `alignment` list is built from. Supplying the versions here would report one discrepancy twice,
 * through two channels, in two wordings — and the second copy is the one that would be trusted
 * without being maintained.
 *
 * `assertLocalDevExtensionChoicesAreDeclared` runs first so a malformed choice fails as the
 * contract's own error rather than as the audit's `local-dev-extension-choice-malformed` finding.
 * Both are correct answers to the same input, which is why only one is allowed to speak: the
 * guard names what is missing from the declaration, and the audit's finding describes the same
 * thing one layer later. Raising the guard's error here is the earlier and more specific answer.
 */
export function auditHarnessConfiguration(input: HarnessAuditInput): LocalDevAudit {
  assertLocalDevExtensionChoicesAreDeclared(input.extensionChoices);

  return auditLocalDevConfiguration({
    decisions: input.decisions,
    extensionChoices: input.extensionChoices,
  });
}

/**
 * The packages whose declared choice matches no `extension` decision, read off the audit.
 *
 * The bridge between "the audit reported this" and "the resolver must not apply it", and it exists
 * so the matching rule has exactly one implementation. `extensionSubstitutions` drops these before
 * claiming any id, because applying a stale choice would make the dev server serve a substitute
 * while the compiler bundles the real package — the drift that function's docstring describes, and
 * a defect review found in the first version of this wiring.
 *
 * Read from the audit's `diagnostics` rather than recomputed from `decisions` here, and that is the
 * whole point: the contract decides which choices matched (it compares `decision.strategy ===
 * "extension"` over the packages it can read), and a second copy of that comparison would be a
 * second place for the answer to differ the first time the contract's rule was refined.
 *
 * A finding's `subject` is the package name for this code — the audit constructs it that way, and
 * `local-dev-audit.test.ts` asserts the subject on a real finding rather than trusting the shape.
 */
export function unmatchedExtensionChoicePackages(audit: LocalDevAudit): readonly string[] {
  return audit.diagnostics
    .filter(finding => finding.code === "local-dev-extension-choice-unmatched")
    .map(finding => finding.subject);
}

/**
 * The audit's findings that the contract says block local development.
 *
 * Derived from `LOCAL_DEV_DIAGNOSTIC_RULES` rather than from a list of codes here, and the
 * difference is not tidiness: a code added to the contract with `blocksLocalDevelopment: true`
 * would, with a hand-written list, be reported as a warning by a harness that never heard about
 * it. Asking the table makes *the contract* the authority on what refuses a dev server, which is
 * the same division every other rule in this package follows.
 */
export function blockingLocalDevFindings(audit: LocalDevAudit): readonly LocalDevDiagnostic[] {
  return audit.diagnostics.filter(finding => LOCAL_DEV_DIAGNOSTIC_RULES[finding.code].blocksLocalDevelopment);
}

/**
 * The audit's report, for a terminal.
 *
 * Two blocks, and the split is what the reader needs: the **findings** first, one line each with
 * the remediation and the fix owner (`formatLocalDevDiagnostic`'s format, printed rather than
 * paraphrased); then the **distinction**, which is not a finding about this project but the
 * standing caveat on every local session — what the loop established and what is still owed to a
 * real Forguncy page.
 *
 * The distinction is printed here rather than left for a reader to ask for, and that corrects an
 * existing claim: `index.ts` already said "`formatLocalDevValidationDistinction()` is the report
 * of what remains owed, and this package prints it rather than paraphrasing it" while nothing in
 * the package called it. A green local render is the moment a developer is most likely to read it
 * as compatibility, so it is printed at the moment the loop starts.
 *
 * The report always states the extension question, even when nothing is left to real-runtime
 * validation — see the empty case below for why a line beats a silence, and why the line is
 * phrased about what the project *recorded* rather than about what it has.
 */
export function formatHarnessAudit(audit: LocalDevAudit): string {
  const lines = [
    "Local development configuration, audited at server start:",
    ...audit.diagnostics.map(finding => `  ${formatLocalDevDiagnostic(finding)}`),
    // The empty case is stated rather than omitted, and the reason is the one
    // `formatLocalDevAudit` gives for its own version of this line: a report that says nothing
    // about a question reads the same whether the answer was "nothing to report" or "nobody
    // asked". A developer who declared a `real-runtime-only` choice needs to see *that* the loop
    // cannot exercise that dependency, and silence would leave the audit's own abstention
    // indistinguishable from a clean pass.
    //
    // Phrased about what is *recorded* — "no dependency is recorded as real-runtime-only" —
    // rather than about the project's extensions, and that is a correction: the first wording was
    // "No extension dependency is left to real-runtime validation", which printed directly
    // underneath a finding saying an `extension` dependency had no declaration at all. In that
    // case the audit knows there *is* an extension dependency and that nothing local exercises
    // it, so a sentence denying exactly that is worse than no sentence. `realRuntimeOnly` lists
    // the packages a project *acknowledged*; empty means no acknowledgement, which is true and
    // non-contradictory whether the reason is a substitute, an omission, or no dependency at all.
    audit.realRuntimeOnly.length === 0
      ? "  No dependency is recorded as real-runtime-only."
      : `  Left to real-runtime validation by decision: ${audit.realRuntimeOnly.join(", ")}`,
    "",
    formatLocalDevValidationDistinction(),
  ];

  return lines.join("\n");
}
