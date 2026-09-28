/**
 * Removing a throwaway project directory a test started a Vite dev server over.
 *
 * Not exported from the package (`exports` names only `.` and `./mount`), so this is reachable by
 * the tests that need it and by nothing else. It lives here rather than in each test file because
 * three tests across two files need it, and a second copy of a retry rule is the kind of duplicate
 * this repository deletes on sight — the copies drift the first time one of them is strengthened.
 *
 * ## The race it exists for
 *
 * Vite's dependency optimizer writes `.vite/deps_temp_*` **asynchronously**, and `rm -rf` does not
 * wait for it. On POSIX the loser of that race leaves a stray directory behind; on Windows the same
 * race is a hard failure:
 *
 * ```
 * Error: ENOTEMPTY: directory not empty, rmdir '…\dev-harness-audit-UPmUg0\.vite\deps_temp_45388ef9'
 * ```
 *
 * Measured rather than suspected: `local-dev-audit-server.test.ts`'s server test failed in roughly
 * half of full-suite runs and never once when that file ran alone, and the failure was *this*, not
 * an assertion. Opting the servers out of pre-transforming requests did not close it, because
 * building the optimizer's own cache is what the run does.
 *
 * A retry is the right shape rather than a longer sleep or joining a promise: the optimizer is not
 * something a test can await, so the only usable statement is "nothing outside this test is writing
 * into the directory any more", which a bounded retry establishes and a delay only guesses at.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The form of a project root that Vite will serve from.
 *
 * ## Why a served root has to be canonical, separately from the removal above
 *
 * Vite refuses to serve **any** path that looks like a Windows short name, and it does so before
 * its allow list is consulted:
 *
 * ```js
 * function isFileLoadingAllowed(config, filePath) {
 *   const { fs } = config.server;
 *   if (!fs.strict) return true;
 *   if (isWindows && looksLikeWindowsShortNamePath(filePath)) return false;   // ← here
 *   …
 *   if (fs.allow.some(uri => isFileInTargetPath(uri, filePath))) return true;
 * ```
 *
 * On a GitHub Windows runner `os.tmpdir()` is `C:\Users\RUNNER~1\AppData\Local\Temp`, so a temp
 * project created there is *unservable as a module* — the request dies with
 * `403 Restricted … is outside of Vite serving allow list`, and the hint lists the short-name root
 * as being allowed, which is the misleading part: the refusal happened above that check. Measured on
 * #101: `extension-substitutions.test.ts` failed exactly this way on CI while passing on a developer
 * machine whose temp path has no short name.
 *
 * `realpath` expands the short name, so a canonical root is a servable one — and `realpathSync` of
 * an already-canonical path is a no-op, so a developer machine is unaffected.
 *
 * Split out from {@link canonicalTempProject} so this operation can be tested with an input whose
 * path *is* a short-name shape (a junction), rather than only through `os.tmpdir()`, which has no
 * short name locally and would make the helper look like it does nothing.
 */
export function servableRoot(root: string): string {
  return realpathSync(root);
}

/** A throwaway project directory, canonicalized via {@link servableRoot} for a test that serves it. */
export function canonicalTempProject(prefix: string): string {
  return servableRoot(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Whether Vite would refuse to serve a path because of a Windows short name.
 *
 * A copy of Vite 8.3.0's own predicate (`windowsShortNameSegmentRE` and
 * `looksLikeWindowsShortNamePath` in its `dist`, used by `isFileLoadingAllowed`), kept here so the
 * rule that decides this can be asserted on **any** machine rather than only on a runner whose temp
 * directory happens to have a short name. The alternative — relying on CI to exercise it — is what
 * let this defect reach a red check in the first place.
 *
 * Deliberately a copy rather than an import: Vite does not export it, and importing from its `dist`
 * would bind this package's tests to an internal path. The caller passing a slashed path matches how
 * Vite normalizes before checking.
 */
export function looksLikeWindowsShortNamePath(path: string): boolean {
  return (
    path.includes("~") &&
    path.split("/").some(segment => /^[^~.]{1,6}~\d+(?:\.[^~.]{0,3})?$/.test(segment))
  );
}

/** Retry only the codes this race produces; anything else is a real failure and is rethrown. */
const RACE_CODES = new Set(["ENOTEMPTY", "EPERM", "EBUSY", "ENOENT"]);

/**
 * Remove a temp project, tolerating Vite's optimizer still writing into it.
 *
 * Resolves once the directory is gone. If the race outlasts the bounded retries it reports to
 * stderr and resolves anyway, rather than failing a test over a directory in the OS temp root: the
 * alternative — throwing from an `onTestFinished` hook — would report an untidy temp directory as a
 * failed assertion, which is the more expensive lie. The message says which directory was left, so
 * the condition is visible instead of silent.
 */
export async function removeTempProject(root: string): Promise<void> {
  const { rm } = await import("node:fs/promises");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RACE_CODES.has(code)) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  process.stderr.write(
    `removeTempProject could not remove ${root}: Vite's dependency optimizer kept writing into it. A directory under the OS temp root is left behind; no assertion was affected.\n`,
  );
}
