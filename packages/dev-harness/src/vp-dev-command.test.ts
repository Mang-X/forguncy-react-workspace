import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { HARNESS_ENTRY_URL_PATH, HARNESS_MOUNT_ELEMENT_ID } from "./vite-plugin.ts";

/**
 * #67's criterion at the level it is written: **the `vp dev` command itself** starts the server
 * with no flags and no wrapper, and serves a Cell.
 *
 * Decision sources: GitHub Issues
 * - #67 — "Implement: bare `vp dev` for the local Cell harness (configLoader / workspace
 *   TypeScript resolution)" (https://github.com/Mang-X/forguncy-react-workspace/issues/67)
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose first acceptance
 *   criterion this closes
 *
 * ## Why this file exists next to `bare-vp-dev.test.ts`
 *
 * A review of this PR found the sibling test does not execute the acceptance path it is named
 * for, and that finding was correct. `bare-vp-dev.test.ts` calls `vite.loadConfigFromFile(...,
 * "bundle")` — it proves the config graph is loadable by *Vite's* bundle loader, but a regression
 * in Vite+'s own `vp dev` command, in how it picks a target package, or in what it forwards to
 * Vite would leave it green. Measured, that is not a hypothetical distinction: this test's
 * sibling imports `vite@8.3.0`, while `vp dev` resolves `vite` to `@voidzero-dev/vite-plus-core`.
 * They are **different packages**, so the config-level test cannot speak for the command.
 *
 * The division is therefore: `bare-vp-dev.test.ts` explains and pins the *mechanism* (which
 * loader resolves what, and why the extension convention is what makes it work), and this file
 * asserts the *public command* #67 names. Neither replaces the other, and this is the one that
 * would fail if `vp dev` regressed while Vite's loader did not.
 *
 * ## What is asserted, and the two things that make it non-vacuous
 *
 * The HTML and not merely the status code: the harness plugin injects `HARNESS_MOUNT_ELEMENT_ID`
 * and the entry script in `transformIndexHtml`, so finding both in the served page is evidence
 * that the plugin ran *inside the real command* — not just that some server answered 200. A
 * process that started and served a directory listing would satisfy the weaker check.
 *
 * ## The orphan hazard, found by building this test
 *
 * `child.kill()` is not enough, and getting that wrong is worse than not having the test: the
 * first draft of this file killed the direct child and left a **listening dev server** behind —
 * verified by fetching the port after the kill and getting 200 back. `vp` spawns Vite as a
 * separate process, so the test has to kill the whole tree. `killTree` below does that per
 * platform, and it runs in a `finally` so a failing assertion cannot leak a server either.
 *
 * ## `--port 0` and the "no flags" claim
 *
 * #67 asks for no flags, and this passes one. The claim being tested is that no flag is needed
 * *to make the config load* — that is what `--configLoader runner` was doing before, and it is
 * absent here. Port selection is orthogonal to config loading: `--port 0` asks the OS for a free
 * port so the test cannot collide with a developer's own `vp dev` or with a parallel run. Left
 * at Vite's default, the test would either collide or have to assert on a fixed port it does not
 * own, which would make it flaky rather than stricter.
 *
 * Deliberately **not** asserted: that a Cell mounts in a browser or that HMR preserves state.
 * Those were verified by hand for this PR (a real browser: the Cell rendered its fixture rows and
 * a source edit kept `useState` alive) and they are still owed to a real page; #20/#25 own that.
 * This file stops at "the command serves the harness page", which is the part that was broken.
 */
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..", "..", "..", "examples", "dev-harness");

/** How long to wait for the server's banner before failing with its captured output. */
const STARTUP_TIMEOUT_MS = 60_000;

/**
 * The project-local `vp` entry point.
 *
 * Resolved through `examples/dev-harness`'s own dependencies rather than taken from `PATH`,
 * because `vite-plus` is that example's devDependency: a globally installed `vp` of another
 * version would make this test measure the machine instead of the project. `vite-plus` exports
 * `./package.json`, and its `bin.vp` is the CLI's own entry — the same one `node_modules/.bin/vp`
 * shims to.
 */
function resolveVpEntry(): string {
  const require = createRequire(pathToFileURL(join(exampleRoot, "package.json")).href);
  const manifestPath = require.resolve("vite-plus/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: Record<string, string> };

  return join(dirname(manifestPath), manifest.bin.vp!);
}

/** Kill the process *tree*, so the spawned server cannot outlive the test. */
function killTree(child: { pid?: number }): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    // `/T` is the tree, and it is the reason this is not `child.kill()`.
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already exited: taskkill reports "not found", which is success for this purpose.
    }
    return;
  }
  try {
    // The child is spawned `detached`, so it leads its own process group and a negative pid
    // signals the group — Vite included.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Same as above: gone already.
  }
}

/**
 * The local URL Vite announced, read from the banner with its colour codes stripped.
 *
 * The whole URL rather than a bare port, and this was a real failure rather than tidiness: the
 * first draft kept the port and fetched `127.0.0.1`, which was refused. Vite prints `localhost`,
 * which on this machine resolves to `::1` first, so the address the server actually listens on is
 * the one the banner names. Reading it back means the test follows the server instead of guessing
 * an equivalent.
 */
function announcedUrl(output: string): string | undefined {
  // Same pattern and the same disable as `cell-compiler`'s `stripAnsi`: matching the escape byte
  // is the entire point of this pattern, and Vite's banner is coloured whether or not anything
  // reads it.
  // eslint-disable-next-line no-control-regex -- matching the escape byte is the entire point of this pattern.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\/?/.exec(plain);

  return match === null ? undefined : match[1];
}

/**
 * The first URL that answers, polling until the deadline.
 *
 * Polling rather than a single fetch: the banner is printed *before* the socket accepts, so the
 * URL is announced at a moment when connecting still fails. That is a startup race, not a defect,
 * and asserting on the first attempt would make this test flaky in the direction of looking
 * broken.
 */
async function waitForServing(url: string, deadline: number, childMissing: () => string | undefined): Promise<Response> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    const gone = childMissing();
    if (gone !== undefined) {
      throw new Error(gone);
    }
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`\`vp dev\` announced ${url} but never answered on it: ${String(lastError)}`);
}

describe("the `vp dev` command starts the harness with no config flag", () => {
  it(
    "serves the Cell's page, with the mount node and entry the plugin injects",
    async () => {
      const child = spawn(process.execPath, [resolveVpEntry(), "dev", "--port", "0"], {
        cwd: exampleRoot,
        // `detached` is what makes the POSIX group kill in `killTree` possible.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

      /** The failure to report when the child died instead of serving, or `undefined`. */
      const childMissing = (): string | undefined =>
        child.exitCode === null
          ? undefined
          : `\`vp dev\` exited with code ${child.exitCode} before serving.\nCaptured output:\n${output}`;

      try {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        const url = await waitForAnnouncement(() => announcedUrl(output), deadline, childMissing);
        const page = await waitForServing(`${url}/`, deadline, childMissing);

        expect(page.status).toBe(200);

        const html = await page.text();
        // The two things the harness plugin injects, so this is the plugin running inside the
        // real command rather than merely a server answering.
        expect(html).toContain(`id="${HARNESS_MOUNT_ELEMENT_ID}"`);
        expect(html).toContain(HARNESS_ENTRY_URL_PATH);

        // The entry module itself, which is the plugin's generated virtual module. Requested
        // separately because it is served by the plugin's own `load` hook, and a 200 here is
        // what proves the Cell seam — not just the HTML injection — is wired under `vp dev`.
        const entry = await waitForServing(`${url}${HARNESS_ENTRY_URL_PATH}`, deadline, childMissing);
        expect(entry.status).toBe(200);
        expect(await entry.text()).toContain("mountCell");
      } finally {
        killTree(child);
      }
    },
    STARTUP_TIMEOUT_MS,
  );
});

/**
 * Wait for the banner to name a URL, failing with the captured output if it never does.
 *
 * The output is carried into the error deliberately: a bare timeout here would report "`vp dev`
 * did not start" and discard the one thing that explains why — the `ERR_MODULE_NOT_FOUND` this
 * whole Issue is about.
 */
async function waitForAnnouncement(
  urlOf: () => string | undefined,
  deadline: number,
  childMissing: () => string | undefined,
): Promise<string> {
  while (Date.now() < deadline) {
    const gone = childMissing();
    if (gone !== undefined) {
      throw new Error(gone);
    }
    const url = urlOf();
    if (url !== undefined) {
      return url;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for `vp dev` to announce a URL.");
}
