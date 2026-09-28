/**
 * The servability of a throwaway project root, asserted on any machine.
 *
 * Decision source: GitHub Issue #101 — the Windows CI leg, and the failure it found.
 *
 * ## What this pins, and why it is not in the test that found the defect
 *
 * `extension-substitutions.test.ts` failed on the GitHub Windows runner with
 * `403 Restricted … The request id "C:\Users\RUNNER~1\AppData\Local\Temp\…" is outside of Vite
 * serving allow list`. The `~1` is the whole of it: Vite refuses to serve **any** path containing a
 * Windows short-name segment, and it does so *before* consulting `server.fs.allow`:
 *
 * ```js
 * function isFileLoadingAllowed(config, filePath) {
 *   if (!config.server.fs.strict) return true;
 *   if (isWindows && looksLikeWindowsShortNamePath(filePath)) return false;   // ← the refusal
 *   …
 *   if (fs.allow.some(uri => isFileInTargetPath(uri, filePath))) return true;
 * ```
 *
 * So the error text is misleading — it names an allow list the path was never compared against — and
 * no `fs.allow` entry can fix it. The root has to be canonical, which `canonicalTempProject` does.
 *
 * That test cannot carry the assertion: it needs the runner's temp directory to *have* a short name,
 * which is exactly the condition a developer machine lacks. Measured: on this machine
 * `os.tmpdir()` is `C:\Users\hp\AppData\Local\Temp`, and the defect is invisible. Leaving it to CI is
 * what let a red check ship, so the rule itself is asserted here, on paths whose shape does not
 * depend on where the test runs.
 *
 * The path list is the evidence: the first two names are the real ones from the failing CI run and
 * the canonical form `realpath` produces for it, and the rest are the shapes that must not be
 * caught by a pattern this narrow.
 */

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalTempProject, looksLikeWindowsShortNamePath, removeTempProject, servableRoot } from "./temp-project.ts";

const created: string[] = [];

describe("Vite refuses a Windows short-name path, so a served root must be canonical", () => {
  it("flags the runner's short-name temp path and not the canonical form realpath gives", () => {
    // Verbatim from the CI failure, and the form `realpath` expands it to. The expansion is a
    // documented Windows behaviour, not a guess: `RUNNER~1` is the 8.3 name of `runneradmin`.
    expect(
      looksLikeWindowsShortNamePath("C:/Users/RUNNER~1/AppData/Local/Temp/dev-harness-subst-1GNOon/cells/probe/src/App.tsx"),
    ).toBe(true);
    expect(
      looksLikeWindowsShortNamePath(
        "C:/Users/runneradmin/AppData/Local/Temp/dev-harness-subst-1GNOon/cells/probe/src/App.tsx",
      ),
    ).toBe(false);
  });

  it("does not flag ordinary paths, so the rule is narrow", () => {
    // The near-misses matter more than the hit: a pattern loose enough to catch a developer's own
    // directory would make this helper reject roots it has no business rejecting, and a `~` in a
    // home directory name (`~` alone, or `me~home`) is not a short name.
    for (const path of [
      "C:/Users/hp/AppData/Local/Temp/dev-harness-subst-1GNOon/cells/probe/src/App.tsx",
      "/tmp/fgc-project/cells/probe/src/App.tsx",
      "C:/Users/a~bc/project/App.tsx",
      "C:/Users/hp/~/project/App.tsx",
      "C:/projects/abcdefg~1/App.tsx",
    ]) {
      expect(looksLikeWindowsShortNamePath(path), path).toBe(false);
    }
  });

  it("canonicalizes a root whose own path is a short-name shape", () => {
    // The load-bearing operation, exercised with an input that *is* a short-name path rather than
    // relying on `os.tmpdir()` to provide one. This is the assertion that fails if
    // `servableRoot` stops canonicalizing: measured by removing the `realpath` call, which this
    // catches while the properties above do not — on a developer machine the helper is otherwise a
    // no-op and every other case here passes for that reason.
    const base = canonicalTempProject("dev-harness-servable-");
    created.push(base);
    const real = join(base, "real-project");
    mkdirSync(join(real, "cells"), { recursive: true });
    writeFileSync(join(real, "cells", "App.tsx"), "export const x = 1;\n");

    const junction = join(base, "SHORTN~1");
    try {
      symlinkSync(real, junction, "junction");
    } catch (error) {
      process.stderr.write(`short-name junction unavailable, skipping: ${String(error)}\n`);
      return;
    }

    const asViteSees = (path: string): string => join(path, "cells", "App.tsx").split("\\").join("/");

    // Before: refused. After: servable. That pair is the fix.
    expect(looksLikeWindowsShortNamePath(asViteSees(junction))).toBe(true);
    expect(looksLikeWindowsShortNamePath(asViteSees(servableRoot(junction)))).toBe(false);
    expect(servableRoot(junction)).toBe(real);
  });

  it("returns a root with no short-name segment, which is what makes it servable", () => {
    // The helper's own contract on this machine: whatever `os.tmpdir()` is, the root it hands back
    // must be one Vite would serve. Asserted as the *property*, so this passes on a runner with a
    // `~1` temp directory by proving the canonicalization worked, and on a developer machine with
    // no short name by proving it changed nothing harmful.
    const root = canonicalTempProject("dev-harness-canonical-");
    created.push(root);

    expect(root).toBe(realpathSync(root));
    expect(looksLikeWindowsShortNamePath(root.split("\\").join("/"))).toBe(false);
  });

  it("is not fooled by a junction that has a short-name name", () => {
    // A hand-made stand-in for the runner's temp directory, so the property is exercised rather
    // than only described: the junction's *path* looks like a short name, and `realpath` resolves
    // it away. Measured on this machine — the predicate accepts the junction path and rejects the
    // canonical one, which is exactly the pair the CI failure turned on.
    const base = canonicalTempProject("dev-harness-shortname-");
    created.push(base);
    const real = join(base, "real-project");
    mkdirSync(join(real, "cells"), { recursive: true });
    writeFileSync(join(real, "cells", "App.tsx"), "export const x = 1;\n");

    const junction = join(base, "SHORTN~1");
    try {
      symlinkSync(real, junction, "junction");
    } catch (error) {
      // Windows without developer mode cannot create one. The property above still holds.
      process.stderr.write(`short-name junction unavailable, skipping: ${String(error)}\n`);
      return;
    }

    const asViteSees = (path: string): string => join(path, "cells", "App.tsx").split("\\").join("/");

    expect(looksLikeWindowsShortNamePath(asViteSees(junction))).toBe(true);
    expect(looksLikeWindowsShortNamePath(asViteSees(realpathSync(junction)))).toBe(false);
  });
});

afterAll(async () => {
  for (const root of created) {
    await removeTempProject(root);
  }
});
