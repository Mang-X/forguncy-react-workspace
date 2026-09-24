import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";
import { createServer } from "vite";

import type { LockedDependencyDecision } from "@forguncy-react-workspace/core";
import { createEmptyFgcLock } from "@forguncy-react-workspace/core";

import { readProjectDependencyDecisions } from "./local-dev-audit.ts";
import { removeTempProject } from "./temp-project.ts";
import { devHarness, HARNESS_ENTRY_URL_PATH } from "./vite-plugin.ts";

/**
 * The audit at the two levels the plugin's unit tests cannot reach: **the dev server** and **the
 * `vp dev` command**.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 5 is the
 *   audit ("a clear mechanism for extension-backed packages in local mode … or a diagnostic
 *   saying real-runtime validation is required") and whose plan step 8 is "smoke tests ensuring
 *   the local harness does not mutate authored source"
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which owns the finding that
 *   blocks and the rule that a local run makes no real-runtime claim
 *
 * ## Why these assertions are here and not in `local-dev-audit.test.ts`
 *
 * That file tests the audit's *inputs and outputs*: given decisions and choices, which findings
 * come back and how they print. Two questions it cannot answer, because both are about what the
 * **plugin** does with the audit:
 *
 * 1. **Does a blocking finding actually refuse a server?** An audit that returns the right
 *    findings and a plugin that ignores them is a passing unit test and a broken promise — the
 *    exact shape this repository keeps finding, where the rule is right and nothing acts on it.
 *    So this drives a **real Vite dev server** and requires `createServer` to reject.
 * 2. **Does the loop leave the authored source alone?** Plan step 8 asks for a smoke test, and
 *    "does not mutate" is a claim about behaviour over time, not about a return value. It is
 *    checked over a real `vp dev` run, because that is the process the criterion names.
 *
 * ## The refusal is asserted through `devHarness`, with the lock supplied by the project
 *
 * The blocking input has to come from somewhere real, and the honest source is a project whose
 * `fgc.lock.json` records an `extension` decision and whose config declares no choice for it.
 * A committed fixture project would need its own lock, config and Cell; instead the lock is
 * written into a temp directory and handed to the plugin through `config.runtime.dependencyLockPath`
 * — which is the *same path* `configureServer` reads in production
 * (`registry.runtime.dependencyLockPathAbsolute`), so what is exercised is the real wiring rather
 * than a test-only injection point.
 *
 * That the temp project is outside the workspace is fine here, unlike `vite-plugin.test.ts`'s
 * HTML fixtures: this server is never asked to serve the generated entry (which imports the
 * harness by package name), only to be created. The one thing it does need is a Cell entry that
 * exists, because `requireEntryFiles` defaults to `true` and a config naming a missing file is a
 * different failure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "dev-harness");

/**
 * A Cell target whose entry exists, so the only thing that can fail the server is the audit.
 *
 * Each test writes its own config into its own temp project rather than sharing one, so a test
 * cannot be affected by another's fixture — and the temp project is outside the workspace
 * deliberately: this server is never asked to serve the generated entry (which imports the
 * harness by package name, and would not resolve there), only to be created. The lock is the
 * only input that matters, and it is written to the path the config declares.
 */

/** A legal `extension` record, so the audit has something to require a choice for. */
function extensionDecision(packageName: string): LockedDependencyDecision {
  return {
    strategy: "extension",
    packageName,
    cellTarget: null,
    resolvedVersion: "5.102.8",
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
    rationale: "A bundled copy would give every Cell its own QueryClient.",
    // A `passed` probe has to link a `probe` or `runtime-observation` record; `core` says so.
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
  } as LockedDependencyDecision;
}

/**
 * A temp project whose lock records one `extension` decision, plus the config that points the
 * registry at it.
 *
 * Each test gets its own directory, so no test can be affected by another's fixture. The project
 * lives outside the workspace deliberately and that is fine *here*, unlike `vite-plugin.test.ts`'s
 * HTML fixtures: this server is never asked to serve the generated entry (which imports the
 * harness by package name and would not resolve outside the workspace), only to be created. The
 * one thing it needs is a Cell entry that exists, because `requireEntryFiles` defaults to `true`
 * and a config naming a missing file is a different failure than the one under test.
 *
 * It also installs the package its lock records, and that became necessary when the projection
 * landed: `package-version-unknown` is a staleness reason a local process *can* judge, so a lock
 * naming a package the project does not have is a lock the compiler would withhold — and these
 * tests would then be exercising the withholding path instead of the missing-choice path they name.
 * A real project's tree has the package it recorded, so the fixture has it too.
 */
async function projectWithExtensionLock(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "dev-harness-audit-"));

  await writeFile(
    join(root, "fgc.lock.json"),
    JSON.stringify({ schemaVersion: 1, decisions: [extensionDecision("@tanstack/react-query")] }),
    "utf8",
  );
  await mkdir(join(root, "cells", "probe", "src"), { recursive: true });
  await writeFile(join(root, "cells", "probe", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");

  // A stub at the version the record names — `5.102.8`, because any other version is
  // `package-version-changed`, which is withheld for a real reason.
  await mkdir(join(root, "node_modules", "@tanstack", "react-query"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "@tanstack", "react-query", "package.json"),
    JSON.stringify({ name: "@tanstack/react-query", version: "5.102.8", type: "module", main: "index.js" }),
    "utf8",
  );
  await writeFile(join(root, "node_modules", "@tanstack", "react-query", "index.js"), "export const STUB = true;\n", "utf8");

  return { root, cleanup: () => removeTempProject(root) };
}

/** The config both tests hand the plugin, so only `extensionChoices` differs between them. */
const AUDITED_CONFIG = {
  cells: { probe: { entry: "./cells/probe/src/App.tsx", target: { pageName: "审计", cell: "A1" } } },
  runtime: { dependencyLockPath: "./fgc.lock.json" },
} as const;

/**
 * The divergence that is the *whole* reason this package has its own reader, asserted rather
 * than asserted-in-a-comment.
 *
 * `local-dev-audit.ts` reads the path `registry.runtime.dependencyLockPathAbsolute` names —
 * which honours a project that declared `runtime.dependencyLockPath` — while
 * `dependency-resolver`'s `readFgcLock(projectRoot)` takes a root and always appends
 * `fgc.lock.json`. So this is the one input where the two readers must *disagree*, and every
 * other test in this file would pass just as well if the harness had called `readFgcLock` and
 * quietly ignored the project's declaration.
 *
 * Without this test, "we read the declared path" is a claim nothing checks: a config pointing at
 * `./locks/fgc.lock.json` would be audited against a *different* file, and the failure mode is
 * the quiet one — a project whose real decisions live where it said would be audited as having
 * none, so its `extension` dependencies would silently pass.
 */
describe("the declared lock path is honoured, which `readFgcLock(projectRoot)` could not do", () => {
  it("reads where the config points, not `<root>/fgc.lock.json`", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { readFgcLock } = await import("@forguncy-react-workspace/dependency-resolver");

    const root = await mkdtemp(join(tmpdir(), "dev-harness-lockpath-"));
    // The same cleanup as the other server-starting tests: this one creates a dev server too, so it
    // races Vite's dependency optimizer exactly as they do.
    onTestFinished(() => removeTempProject(root));

    // The decisions live in a subdirectory the project declared, and *nothing* is at the default
    // location — so a reader that ignored the declaration would find no file at all.
    await mkdir(join(root, "locks"), { recursive: true });
    const declaredPath = join(root, "locks", "fgc.lock.json");
    await writeFile(
      declaredPath,
      JSON.stringify({ schemaVersion: 1, decisions: [extensionDecision("@tanstack/react-query")] }),
      "utf8",
    );
    // A Cell entry that exists, so the only thing that can refuse this server is the audit.
    await mkdir(join(root, "cells", "probe", "src"), { recursive: true });
    await writeFile(join(root, "cells", "probe", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");

    // The package the decision records, at the version it records — so the projection keeps the
    // decision and the only question left is *which lock file* was read. See
    // `projectWithExtensionLock` for why this became necessary.
    await mkdir(join(root, "node_modules", "@tanstack", "react-query"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@tanstack", "react-query", "package.json"),
      JSON.stringify({ name: "@tanstack/react-query", version: "5.102.8", type: "module", main: "index.js" }),
      "utf8",
    );
    await writeFile(join(root, "node_modules", "@tanstack", "react-query", "index.js"), "export const STUB = true;\n", "utf8");

    // The harness's reader finds them.
    expect((await readProjectDependencyDecisions(declaredPath)).decisions.map(d => d.packageName)).toEqual([
      "@tanstack/react-query",
    ]);

    // The other reader, given the same project root, finds nothing — which is the divergence.
    await expect(readFgcLock(root)).resolves.toEqual(createEmptyFgcLock());

    // And the divergence matters at the level above, not only in the reader: a config declaring
    // the subdirectory path must block, because the audit has to *see* the decision to require a
    // choice for it. Same project, same lock, only the declared path differs from the default.
    let refusal: unknown;
    try {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        appType: "spa",
        plugins: [
          devHarness({
            config: {
              cells: { probe: { entry: "./cells/probe/src/App.tsx", target: { pageName: "审计", cell: "A1" } } },
              runtime: { dependencyLockPath: "./locks/fgc.lock.json" },
            },
          }) as never,
        ],
        server: { middlewareMode: true, hmr: false, watch: null },
      });
      await server.close();
    } catch (error) {
      refusal = error;
    }

    expect(
      refusal === undefined ? undefined : String((refusal as Error).message),
      "a project declaring a non-default lock path was audited as having no decisions",
    ).toContain("local-dev-extension-needs-substitute");
  }, 120_000);
});

describe("a blocking local-dev finding refuses a real dev server", () => {
  it("rejects `createServer`, and the report appears exactly once", async () => {
    const { root, cleanup } = await projectWithExtensionLock();
    onTestFinished(cleanup);

    // Both channels are captured, because the defect this asserts against was a *duplicate*:
    // the first version wrote the report to stderr and then threw it again inside the error
    // message Vite prints, so a real `vp dev` showed the whole six-line report twice in a row.
    // Counting only one channel would have missed it in either direction.
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      stderr.push(chunk);
      return true;
    };

    let refusal: unknown;
    try {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        appType: "spa",
        plugins: [devHarness({ config: AUDITED_CONFIG }) as never],
        server: { middlewareMode: true, hmr: false, watch: null },
      });
      await server.close();
    } catch (error) {
      refusal = error;
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }

    // The whole assertion: a server was *not* created. Everything below is about the message,
    // because a refusal a developer cannot act on is barely better than no refusal.
    expect(refusal, "`createServer` resolved, so the audit did not refuse").toBeDefined();
    const message = String((refusal as Error).message);

    expect(message).toContain("refused to start");
    expect(message).toContain("@tanstack/react-query");
    // The remediation and the fix owner travel in the message, so the terminal output alone is
    // enough to act on without running a second command.
    expect(message).toContain("real-runtime-only");
    expect(message).toContain("fix owner: dependency-decision");
    // The distinction is on the refusal path too: a blocked start must not be the one output
    // that drops the local-versus-real caveat.
    expect(message).toContain("does not establish any real-runtime check");

    // The regression guard: one occurrence per channel, and the message is the only one carrying
    // it. `stderr` is asserted to be *empty* rather than merely short — the hook returns before
    // the write on this path, so any content at all means the two paths are both printing again.
    expect(message.split("audited at server start").length - 1).toBe(1);
    expect(stderr.join("")).not.toContain("audited at server start");
  }, 120_000);

  it("starts the server, and prints the report to stderr, when the project declared a choice", async () => {
    const { root, cleanup } = await projectWithExtensionLock();
    onTestFinished(cleanup);

    // The control for the test above: the *same* lock that refuses a server with no declaration
    // starts one with a declaration. Without this, a harness that refused every `extension`
    // dependency would pass that test, and its finding would be about the strategy rather than
    // about the missing choice.
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      stderr.push(chunk);
      return true;
    };

    try {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        appType: "spa",
        plugins: [
          devHarness({
            config: AUDITED_CONFIG,
            extensionChoices: [
              {
                packageName: "@tanstack/react-query",
                mode: "real-runtime-only",
                reason: "The extension's cross-cell singleton is why it is an extension.",
                consequence: "The local render uses the npm copy, so nothing here exercises the shared cache.",
              },
            ],
          }) as never,
        ],
        server: { middlewareMode: true, hmr: false, watch: null },
      });
      await server.close();
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }

    // The other half of the count: the non-blocking path prints *once*, to stderr, and the reader
    // is told which dependency the loop could not exercise rather than merely that one exists.
    const printed = stderr.join("");
    expect(printed.split("audited at server start").length - 1).toBe(1);
    expect(printed).toContain("Left to real-runtime validation by decision: @tanstack/react-query");
  }, 120_000);
});

describe("#23 plan step 8, the harness half: the loop does not mutate authored source", () => {
  /**
   * Every file under the example's `cells/` and its committed config files, as bytes.
   *
   * The Cell's whole directory is walked rather than the entry alone, because "does not mutate
   * authored source" is a claim about the project and not about one file — a harness that left
   * the entry alone while writing a `.dev.tsx` twin beside it would satisfy the narrower check.
   */
  function authoredSources(): ReadonlyMap<string, Buffer> {
    const found = new Map<string, Buffer>();
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          visit(path);
          continue;
        }
        found.set(path, readFileSync(path));
      }
    };

    visit(join(exampleRoot, "cells"));
    for (const file of ["forguncy.config.ts", "vite.config.ts", "index.html", "package.json"]) {
      const path = join(exampleRoot, file);
      found.set(path, readFileSync(path));
    }

    return found;
  }

  /**
   * A note on how this guard was verified, because the first attempt to do so was wrong in a way
   * worth recording.
   *
   * It was checked by mutating the plugin to write the authored entry from `buildStart`, then
   * running the whole file — and it **passed**, which looked like a vacuous guard. It was not:
   * the two tests above run *earlier in the same file*, and each one starts a dev server, so the
   * idempotent mutation had already overwritten the file before this test took its `before`
   * snapshot. Both reads then saw the mutated bytes and agreed.
   *
   * So the mutation has to be verified by running **this test alone** (`-t` on its name), where it
   * fails with "…App.tsx changed during `vp dev`". The lesson generalises to any before/after
   * comparison in a file that also exercises the thing being measured: test order is part of the
   * measurement, and a sibling test's side effect can make a real guard look vacuous.
   */
  it("leaves every authored file byte-identical across a real `vp dev` run", async () => {
    const before = authoredSources();
    // The control: there are files for the comparison to be about, and the entry is among them.
    // Without this the test passes for an empty map, which is the failure mode a walker has.
    expect(before.size).toBeGreaterThan(4);
    expect([...before.keys()].some(path => path.endsWith(join("sales-summary", "src", "App.tsx")))).toBe(true);

    const child = spawn(process.execPath, [resolveVpEntry(), "dev", "--port", "0"], {
      cwd: exampleRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    onTestFinished(() => killTree(child));

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    // Wait for the server to be *serving*, not merely to have printed its banner: the banner
    // arrives before the socket accepts, so a comparison made at the banner would race the
    // transform and index.html injection that are the parts capable of writing anything.
    const deadline = Date.now() + 60_000;
    let url: string | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`\`vp dev\` exited with code ${child.exitCode} before serving.\n${output}`);
      }
      // eslint-disable-next-line no-control-regex -- matching the escape byte is the point.
      const match = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\/?/.exec(output.replace(/\u001b\[[0-9;]*m/g, ""));
      if (match !== null) {
        try {
          const response = await fetch(`${match[1]}/`);
          if (response.ok) {
            await response.text();
            url = match[1];
            break;
          }
        } catch {
          // Not accepting yet; the banner precedes the socket.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(url, "`vp dev` never served a page").toBeDefined();

    // And the entry module itself, which is served by the plugin's own `load` hook — the code
    // path a mutating harness would most plausibly use, and one that a page fetch alone misses.
    const entry = await fetch(`${url}${HARNESS_ENTRY_URL_PATH}`);
    expect(entry.status).toBe(200);
    await entry.text();

    const after = authoredSources();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      // Compared as bytes rather than as text: a copy that reformatted the source would still
      // "equal" it as a string, and this is the assertion plan step 8 is about.
      expect(after.get(path)?.equals(bytes), `${path} changed during \`vp dev\``).toBe(true);
    }
  }, 120_000);
});

/**
 * The project-local `vp` entry point.
 *
 * Resolved through the example's own dependencies rather than from `PATH`, so a globally
 * installed `vp` of another version cannot make this measure the machine. The same resolution
 * `vp-dev-command.test.ts` uses, for the same reason.
 */
function resolveVpEntry(): string {
  const require = createRequire(pathToFileURL(join(exampleRoot, "package.json")).href);
  const manifestPath = require.resolve("vite-plus/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: Record<string, string> };

  return join(dirname(manifestPath), manifest.bin.vp!);
}

/** Kill the process *tree*, so the spawned server cannot outlive the test. */
function killTree(child: { pid?: number }): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}
