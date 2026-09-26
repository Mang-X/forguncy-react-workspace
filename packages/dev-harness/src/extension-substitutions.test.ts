import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { createServer } from "vite";

import type { ForguncyConfig } from "@forguncy-react-workspace/core";

import { readToolchainIdentity } from "@forguncy-react-workspace/dependency-resolver/local";

import { removeTempProject } from "./temp-project.ts";
import { devHarness } from "./vite-plugin.ts";

/**
 * #23 plan step 5's enforcement half, measured on a **real dev server**: the declared substitute is
 * the module the Cell actually loads, and `real-runtime-only` cannot fall back to an npm copy.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * ## Why every assertion here is fetched rather than resolved
 *
 * Review of the PR that added the audit found that `extensionChoices` were reported and never
 * honoured, and it proved it by running a server. That is the level this file works at, and for the
 * same reason the review was right: the resolver's *answer* and the *module the browser loads* are
 * different statements, and it was precisely their disagreement that constituted the defect. An
 * assertion on `pluginContainer.resolveId` would have passed for a design where the optimizer or a
 * virtual-id mishap still sent the page the npm copy — as several of the probe attempts did.
 *
 * So each case fetches the module the Cell's entry imports, and reads the substitute's own marker
 * out of the body. The marker is a string only the declared substitute contains, which is what makes
 * "the substitute is what loaded" a fact about the page rather than about the configuration.
 */
/** A throwaway project with a Cell, a shim, and a substitute package the project's tree installs. */
async function projectWithShim(): Promise<{ root: string; shimMarker: string; substitutePackageMarker: string }> {
  const root = mkdtempSync(join(tmpdir(), "dev-harness-subst-"));
  onTestFinished(() => removeTempProject(root));

  // A lockfile, so this throwaway project is one an install could have produced (#94): identity is
  // read from the install graph, and a project with none has no identity this toolchain can
  // confirm — every record would report `install-graph-unknown` and be withheld, so the substitute
  // these cases load would never be asked for. Written before the lock below, because the identity
  // the record carries has to be the one this project reports.
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const shimMarker = "PROJECT_SHIM_MARKER_7f3a";
  const substitutePackageMarker = "SUBSTITUTE_PACKAGE_MARKER_9c14";
  mkdirSync(join(root, "cells", "probe", "src"), { recursive: true });
  mkdirSync(join(root, "shims"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@probe", "substitute"), { recursive: true });

  // A substitute *package*, installed in this project's own tree, so the `npm-package` branch is
  // genuinely exercised. Review found the earlier version of that test passing while the branch threw:
  // the temp project had no dependency tree, so `@tanstack/query-core` was unresolvable, the
  // generated module was the *unavailable* one — which throws — and the assertion matched the
  // package name inside the thrown text. A fixture that cannot resolve the substitute cannot test
  // the substitute.
  //
  // A local package rather than a workspace one because resolution starts at the project root, and
  // this temp project is outside the workspace by necessity (see the module docstring). Declaring it
  // in the project's own `node_modules` is what a real project's install produces, and it is the
  // only arrangement where the test exercises resolution rather than a missing dependency.
  writeFileSync(
    join(root, "node_modules", "@probe", "substitute", "package.json"),
    JSON.stringify({
      name: "@probe/substitute",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "node_modules", "@probe", "substitute", "index.js"),
    `export const SUBSTITUTE_PACKAGE_MARKER = ${JSON.stringify(substitutePackageMarker)};\nexport const QueryClient = class SubstitutePackageQueryClient {};\n`,
    "utf8",
  );

  // And the package the *lock records*, installed at the version it records.
  //
  // Needed for a reason the projection introduced: `package-version-unknown` is a
  // locally-observable staleness reason, so a lock naming a package this project does not have is a
  // lock the compiler would withhold — and a fixture built on one would be testing the withholding
  // path rather than the substitution path it names. The version must be the record's `5.102.8`,
  // because a different installed version is `package-version-changed`, which is likewise withheld.
  //
  // A stub rather than the real package: nothing here executes it, and the substitute is what loads.
  // The leaf directory needs `mkdirSync` of its own — creating `node_modules/@tanstack` does not
  // create `react-query` inside it, which the first version of this assumed and `writeFileSync`
  // reported as ENOENT.
  mkdirSync(join(root, "node_modules", "@tanstack", "react-query"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@tanstack", "react-query", "package.json"),
    JSON.stringify({ name: "@tanstack/react-query", version: "5.102.8", type: "module", main: "index.js" }),
    "utf8",
  );
  writeFileSync(
    join(root, "node_modules", "@tanstack", "react-query", "index.js"),
    "export const EXTENSION_RECORDED_PACKAGE = true;\n",
    "utf8",
  );
  // The project's own shim: the module the declaration names, and the one the Cell must load.
  writeFileSync(
    join(root, "shims", "query-shim.ts"),
    `export const SHIM = ${JSON.stringify(shimMarker)};\nexport const QueryClient = class ProjectShimQueryClient {};\nexport const QueryClientProvider = () => null;\nexport const useQuery = () => ({ data: "from-shim" });\n`,
    "utf8",
  );

  // The Cell imports the extension package by name, exactly as authored source does.
  writeFileSync(
    join(root, "cells", "probe", "src", "App.tsx"),
    [
      'import { SHIM, QueryClient } from "@tanstack/react-query";',
      "export function App() {",
      '  return <div data-probe={String(SHIM)} data-client={QueryClient.name} />;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  // The decision that makes the package an `extension` — without it the harness has nothing to
  // require a choice for, and the substitute would never be asked for.
  writeFileSync(
    join(root, "fgc.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      decisions: [
        {
          packageName: "@tanstack/react-query",
          cellTarget: null,
          strategy: "extension",
          resolvedVersion: "5.102.8",
          globalName: "TanStackQuery",
          libraryId: "tanstack-query",
          probe: { status: "passed", fingerprint: "probe=x", versionIndependent: false },
          target: {
            product: "Forguncy",
            productVersion: "12.0.100.0",
            productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
            hostReactVersion: "19.2.7",
          },
          // The project's own identity (#94), read after the lockfile above so the record and the
          // environment the harness computes agree. A literal would report `install-graph-changed`
          // for a project where nothing moved, and the decision would be withheld.
          probedWith: await readToolchainIdentity(root),
          extension: { version: "5.102.8", identity: "sha256:aa" },
          rejectedCandidate: null,
          rationale: "fixture",
          evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
        },
      ],
    }),
    "utf8",
  );

  return { root, shimMarker, substitutePackageMarker };
}

/**
 * The reason out of a Vite error page.
 *
 * Vite answers a failed transform with an HTML document whose message lives in an inline
 * `const error = {"message":"…"}` object, so neither the markup nor a plain slice of it is worth
 * asserting on — the first attempt at this file truncated 300 characters of `<!DOCTYPE html>` and a
 * reader learned nothing from the failure. The `message` field is what the test wants.
 */
function viteErrorReason(html: string): string {
  // The object is `{"message":"…","stack":"…","id":"…",…}` and may **span lines**, so a
  // single-line pattern misses it — which is what the first version of this did, leaving the
  // truncated HTML in the failure. Only `message` is needed, so it is read directly.
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
  if (message === undefined) {
    return html.slice(0, 300).split("\n").join(" ");
  }
  try {
    return JSON.parse(`"${message}"`) as string;
  } catch {
    return message;
  }
}

/**
 * The config every case hands the plugin; only `extensionChoices` differs.
 *
 * Typed as `ForguncyConfig` rather than a structural lookalike, and that is not cosmetic: the first
 * version widened `cells` to `Record<string, unknown>`, which `tsc` refused — a config the plugin
 * accepts is one whose Cells are `CellConfig`s, and a test that hands it something looser would be
 * asserting against a shape no real project has.
 */
function configFor(cellId = "probe"): ForguncyConfig {
  return {
    cells: { [cellId]: { entry: "./cells/probe/src/App.tsx", target: { pageName: "探针", cell: "A1" } } },
    runtime: { dependencyLockPath: "./fgc.lock.json" },
  };
}

/**
 * What the browser receives for the Cell's `@tanstack/react-query` import.
 *
 * The Cell's module id is claimed by the Cell seam (#28), and its transformed body carries the
 * import specifier already rewritten by Vite — so reading that body is how this finds the module
 * the page would fetch, without needing a browser.
 */
async function loadedForSubstitutedImport(root: string, choices: readonly unknown[]) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "spa",
    plugins: [devHarness({ config: configFor(), extensionChoices: choices as never }) as never],
    server: { port: 0, strictPort: false, hmr: false, watch: null, preTransformRequests: false },
  });

  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (base === undefined) throw new Error("the server reported no local URL");

    // The Cell's own module, as the harness serves it. Requested by the virtual id's URL form,
    // which is what Vite's module graph uses for a `\0`-prefixed module.
    //
    // Its body is the *seam's* generated module, which re-exports the authored file — so the
    // authored file is what carries the extension import, and that is what is fetched next. Reading
    // only the seam's module was the first version's mistake: it imports `/cells/probe/src/App.tsx`
    // and nothing else, so no substitution id appears in it at all.
    const cellResponse = await fetch(new URL("/@id/__x00__virtual:forguncy/cell/probe", base));
    const cellBody = await cellResponse.text();
    if (cellResponse.status !== 200) {
      throw new Error(`the Cell module did not serve (${cellResponse.status}): ${cellBody.slice(0, 300)}`);
    }

    const authoredPath = /from\s+"([^"]+)"/.exec(cellBody)?.[1];
    if (authoredPath === undefined) {
      throw new Error(`the Cell's seam module names no entry: ${cellBody.slice(0, 300)}`);
    }
    const authoredResponse = await fetch(new URL(authoredPath, base));
    const authoredBody = await authoredResponse.text();
    if (authoredResponse.status !== 200) {
      // Vite's error page carries the real message inside a `<script type="module">` block, so the
      // first 300 characters are HTML boilerplate and the reason is not in them. The message is
      // pulled out here rather than truncated, because "the entry did not serve (500)" with no
      // reason is exactly the kind of output that sends a reader to a second command.
      throw new Error(
        `the authored entry did not serve (${authoredResponse.status}): ${viteErrorReason(authoredBody)}`,
      );
    }

    // Every import the authored Cell makes, so the substituted one is found by its own module id
    // rather than by elimination — an earlier version excluded `react`/`/@vite` prefixes and let
    // `/.vite/deps/react_jsx-dev-runtime.js` through, so it fetched the wrong module and the
    // failure read as "the shim was not loaded".
    const imported = [...authoredBody.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!);
    const substituted = imported.find(specifier => specifier.includes("extension-substitution"));

    // No substitution import is a *result*, not an error: the stale-choice test asserts exactly that
    // — the choice was reported and not applied, so the id took the ordinary path. Returning the
    // imports lets that test say so, while every other caller asserts `exportedFrom` is defined and
    // therefore still fails loudly on an unexpected absence.
    if (substituted === undefined) {
      return { status: 200, body: "", resolvedBody: "", resolvedStatus: 0, exportedFrom: undefined, imported, substituted };
    }

    const response = await fetch(new URL(substituted, base));
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error(`substituted import "${substituted}" did not serve (${response.status}): ${body.slice(0, 400)}`);
    }

    // Follow the generated module's own re-export, because *that* is the question the review asked:
    // not "did the resolver answer differently" but "is the declared substitute the code that runs".
    // The generated module is a one-line `export * from <absolute target>` by design, so the target
    // is read from its body and fetched — which also proves the target is a module the server can
    // serve, where an assertion on the module id alone would not.
    const exportedFrom = /export \* from "([^"]+)"/.exec(body)?.[1];
    let resolvedBody = "";
    let resolvedStatus = 0;
    if (exportedFrom !== undefined) {
      const resolved = await fetch(new URL(exportedFrom, base));
      resolvedStatus = resolved.status;
      resolvedBody = await resolved.text();
    }

    return { status: response.status, body, resolvedBody, resolvedStatus, exportedFrom, imported, substituted };
  } finally {
    await server.close();
  }
}

/**
 * A lock with a target-independent record plus one scoped to `cellTarget`.
 *
 * Both records are built from one base so every field the validator requires is present on both —
 * the first version spread a partial over a bare literal, which `core` refused six times over
 * (`packageName`, `resolvedVersion`, `rationale`, `probe`, `target`, `probedWith`). The overrides are
 * applied *after* the base, so a caller changes only the fields the case is about.
 */
async function writeLockWithCellScopedDecision(
  root: string,
  cellTarget: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const base = {
    packageName: "@tanstack/react-query",
    resolvedVersion: "5.102.8",
    probe: { status: "passed", fingerprint: "probe=x", versionIndependent: false },
    target: {
      product: "Forguncy",
      productVersion: "12.0.100.0",
      productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
      hostReactVersion: "19.2.7",
    },
    // The project's own identity (#94), so the record agrees with the environment the harness
    // computes at request time. A literal would report `install-graph-changed` and the decision
    // would be withheld — which would make the *control* case pass for the wrong reason.
    probedWith: await readToolchainIdentity(root),
    rejectedCandidate: null,
    rationale: "fixture",
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
  };

  writeFileSync(
    join(root, "fgc.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      decisions: [
        {
          ...base,
          cellTarget: null,
          strategy: "extension",
          globalName: "TanStackQuery",
          libraryId: "tanstack-query",
          extension: { version: "5.102.8", identity: "sha256:aa" },
        },
        { ...base, cellTarget, ...overrides },
      ],
    }),
    "utf8",
  );
}

/**
 * Whether the harness answered the Cell's extension import, and what it answered with.
 *
 * The projection tests below want the *absence* of a substitution to be a result rather than an
 * exception, because "the ordinary module path won" manifests as Vite failing to resolve a package
 * the fixture never installed. Wrapping the helper keeps that as an assertion about the substitute
 * instead of a test that passes because something threw.
 */
async function substitutionOutcome(
  root: string,
  choices: readonly unknown[],
): Promise<{ readonly substituted: string | undefined; readonly error: string | undefined }> {
  try {
    const { exportedFrom } = await loadedForSubstitutedImport(root, choices);
    return { substituted: exportedFrom, error: undefined };
  } catch (error) {
    return { substituted: undefined, error: (error as Error).message };
  }
}

describe("a cell-scoped decision governs the mounted Cell, not another Cell's record", () => {
  /**
   * The reviewer's case, and the reason the projection exists: the lock is keyed by
   * `(packageName, cellTarget)` because #4 defines a strategy per pair. Handing the audit the raw
   * lock let the target-independent `extension` record govern a Cell that had decided `inline`, so
   * the harness substituted or threw where the compiler inlined.
   */
  it("does not require a choice when the mounted Cell's own record is `inline`", async () => {
    const { root } = await projectWithShim();

    await writeLockWithCellScopedDecision(root, "probe", {
      strategy: "inline",
      // An `inline` record carries `extension: null`; the validator refuses one with a library.
      extension: null,
    });

    // No `extensionChoices` supplied, which is the assertion: with the unprojected lock the audit
    // saw the target-independent `extension` record and reported
    // `local-dev-extension-needs-substitute`, which is **blocking** — so the server was refused
    // before any module was served.
    const { substituted, error } = await substitutionOutcome(root, []);

    // The server started: no refusal, and no substitution either. That pair is the whole test —
    // with the raw lock this call would have failed with "refused to start", and with the record
    // applied it would have served the shim.
    expect(error).toBeUndefined();
    expect(substituted).toBeUndefined();
  }, 120_000);

  it("still refuses when the mounted Cell's own record is `extension`", async () => {
    const { root } = await projectWithShim();

    // The control, and it is what keeps the test above from passing for the wrong reason. Same
    // lock shape, but the cell-specific record *is* `extension` — so the projection must keep it,
    // and the blocking finding must still fire.
    await writeLockWithCellScopedDecision(root, "probe", {
      strategy: "extension",
      globalName: "TanStackQuery",
      libraryId: "tanstack-query",
      extension: { version: "5.102.8", identity: "sha256:aa" },
    });

    await expect(loadedForSubstitutedImport(root, [])).rejects.toThrow(
      /local-dev-extension-needs-substitute/,
    );
  }, 120_000);

  it("ignores a record scoped to a different Cell", async () => {
    const { root } = await projectWithShim();

    // `extension` scoped to a Cell this server does not mount, and the target-independent record set
    // to `inline` so the fallback is unambiguous. The mounted Cell resolves to `inline`, so no choice
    // is required — the other Cell's record is not this Cell's business.
    //
    // The helper builds this shape: it writes the base record as `extension` with `cellTarget: null`,
    // which the *second* call below overrides. Both records are needed in one file, so the lock is
    // rewritten here rather than composed from two helper calls.
    await writeLockWithCellScopedDecision(root, "another-cell", {
      strategy: "extension",
      globalName: "TanStackQuery",
      libraryId: "tanstack-query",
      extension: { version: "5.102.8", identity: "sha256:aa" },
    });
    // Now replace the target-independent record with `inline`, keeping the other Cell's scoped one.
    const lock = JSON.parse(readFileSync(join(root, "fgc.lock.json"), "utf8")) as {
      decisions: Record<string, unknown>[];
    };
    lock.decisions[0] = { ...lock.decisions[0], strategy: "inline", extension: null };
    writeFileSync(join(root, "fgc.lock.json"), JSON.stringify(lock), "utf8");

    const { substituted, error } = await substitutionOutcome(root, []);

    // Mounted `probe`, whose fallback is the target-independent `inline` record — so the other
    // Cell's `extension` record must not decide anything here. The server starts and nothing is
    // substituted.
    expect(error).toBeUndefined();
    expect(substituted).toBeUndefined();
  }, 120_000);
});

describe("a stale choice is reported but never applied", () => {
  it("lets the ordinary module path win when the lock no longer says `extension`", async () => {
    const { root } = await projectWithShim();

    // The decision moved to `inline` — the case the contract's own remediation names ("when a
    // package moves to another strategy — `extension` to `inline`, say — its choice is left
    // describing a decision that no longer exists"), and the contract reports the leftover choice as
    // `local-dev-extension-choice-unmatched`, whose subject is the package.
    //
    // The substitute package below *is* installed, so if the choice were applied this would resolve
    // to the shim and the assertion would see the shim's marker. Applying it would be the drift this
    // layer exists to prevent: the dev server serving a substitute
    // while the compiler follows the lock and bundles the real package.
    //
    // `@tanstack/react-query` is not installed in this temp project, so "the ordinary path" here
    // means Vite's own resolution answering for the id — which is what the compiler would do too.
    writeFileSync(
      join(root, "fgc.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            packageName: "@tanstack/react-query",
            cellTarget: null,
            strategy: "inline",
            resolvedVersion: "5.102.8",
            probe: { status: "passed", fingerprint: "probe=x", versionIndependent: false },
            target: {
              product: "Forguncy",
              productVersion: "12.0.100.0",
              productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
              hostReactVersion: "19.2.7",
            },
            // The project's own identity (#94), read after the lockfile above so the record and the
          // environment the harness computes agree. A literal would report `install-graph-changed`
          // for a project where nothing moved, and the decision would be withheld.
          probedWith: await readToolchainIdentity(root),
            // Required on every record, and `null` for a strategy that is not `extension` — the
            // validator says so, and this fixture was rejected without it.
            extension: null,
            rejectedCandidate: null,
            rationale: "fixture: moved from extension to inline",
            evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
          },
        ],
      }),
      "utf8",
    );

    // The assertion is that the stale choice is *not applied*: nothing substitutes the id, so the
    // ordinary module path answers it. The fixture installs `@tanstack/react-query` at the recorded
    // version, so the ordinary path resolves and the entry serves — with the shim's marker absent,
    // which is what proves the choice was dropped rather than applied. Before the fix the id was
    // claimed and the generated module carried the shim's re-export target instead.
    const { exportedFrom, resolvedBody } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "substitute",
        kind: "project-shim",
        resolvesTo: "./shims/query-shim.ts",
        justification: "fixture: a choice whose decision moved to inline",
      },
    ]);

    expect(exportedFrom).toBeUndefined();
    expect(resolvedBody).not.toContain("PROJECT_SHIM_MARKER_7f3a");
  }, 120_000);
});

describe("a declared substitute is the module the Cell loads", () => {
  it("loads the project's own shim, not the npm copy", async () => {
    const { root, shimMarker } = await projectWithShim();

    const { status, resolvedBody, resolvedStatus, exportedFrom } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "substitute",
        kind: "project-shim",
        resolvesTo: "./shims/query-shim.ts",
        justification: "fixture: the project supplies the module that should run locally",
      },
    ]);

    expect(status).toBe(200);
    // The generated module re-exports exactly the declared shim, and nothing else — which is what
    // makes the declaration the thing that decided, rather than a rule that happened to agree.
    expect(exportedFrom).toBe("/shims/query-shim.ts");

    // And the code that would run is the *shim's*: followed through the re-export, the served
    // module carries the project's own marker and its own class. Before this was wired, this
    // fetched `@tanstack/react-query`'s build — measured, not assumed.
    expect(resolvedStatus).toBe(200);
    expect(resolvedBody).toContain(shimMarker);
    expect(resolvedBody).toContain("ProjectShimQueryClient");
    // The npm implementation is nowhere in it, which is the other half of "the shim is what runs":
    // the original package's own source would be present here if the substitution had not happened.
    expect(resolvedBody).not.toContain("QueryObserver");
  }, 120_000);

  it("loads a named substitute package when the declaration names one", async () => {
    const { root, substitutePackageMarker } = await projectWithShim();

    // `@probe/substitute` is installed in this temp project's own tree (see `projectWithShim`), so
    // this exercises the resolving branch rather than the failing one.
    const { status, resolvedBody, resolvedStatus, exportedFrom } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "substitute",
        kind: "npm-package",
        resolvesTo: "@probe/substitute",
        justification: "fixture: an installed package stands in for the extension's global",
      },
    ]);

    expect(status).toBe(200);
    // The same two assertions the shim test makes, and for the same reason the review gave: assert
    // the re-export *target* and follow it, rather than matching a name anywhere in the body.
    //
    // The earlier version asserted `toMatch(/QueryClient|query-core|QueryObserver/)` against a body
    // that could be the **unavailable** module — which throws, and whose thrown text contains the
    // package name — so it passed while the branch it named was failing. A marker unique to the
    // substitute package is what tells the two apart.
    expect(exportedFrom).toBeDefined();
    expect(resolvedStatus).toBe(200);
    expect(resolvedBody).toContain(substitutePackageMarker);
    expect(resolvedBody).toContain("SubstitutePackageQueryClient");
    // And it is the substitute rather than the original: the extension package's own implementation
    // would be here if the declaration had not decided anything.
    expect(resolvedBody).not.toContain("QueryObserver");
  }, 120_000);
});

describe("`real-runtime-only` cannot silently take the npm path", () => {
  it("serves a module that throws the project's own acknowledgement", async () => {
    const { root } = await projectWithShim();

    const { status, body } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "real-runtime-only",
        reason: "the extension's cross-cell singleton is the whole reason it is an extension",
        consequence: "the local render would use the npm copy, so nothing here exercises the shared cache",
      },
    ]);

    expect(status).toBe(200);
    // The requirement the review named: this branch must not fall through to an npm copy, even
    // though `@tanstack/react-query` *is* installed and would resolve. Before this was wired, the
    // page received the package's own build.
    expect(body).toMatch(/throw new Error/);
    // The project's own words travel, because "what will I not be able to see" is the half a
    // teammate needs and the half the harness cannot invent.
    expect(body).toContain("cross-cell singleton");
    expect(body).toContain("shared cache");
    // And the npm implementation is nowhere in it — the check that makes "cannot fall back" a
    // statement about the served bytes rather than about the configuration.
    expect(body).not.toContain("QueryObserver");
  }, 120_000);
});

describe("a declaration that cannot be honoured fails loudly rather than resolving elsewhere", () => {
  it("refuses a shim that is not there, instead of running the npm copy", async () => {
    const { root } = await projectWithShim();

    // The declaration names a file nobody wrote. Resolving the npm package instead is the tempting
    // fallback and the wrong one: the reason a project declares a shim is that the npm copy is the
    // wrong thing to run, so falling back would run exactly the module the declaration avoids —
    // and the Cell would render, which is what makes it dangerous.
    const { body, exportedFrom } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "substitute",
        kind: "project-shim",
        resolvesTo: "./shims/absent.ts",
        justification: "fixture: a shim that does not exist",
      },
    ]);

    // The module served for this id throws, and the message is the one that names the declaration —
    // so the failure lands at the authored import with the fix attached.
    expect(exportedFrom).toBeUndefined();
    expect(body).toContain("throw new Error");
    expect(body).toContain("absent.ts");
    expect(body).not.toContain("QueryObserver");
  }, 120_000);

  it("drops a choice for a package the extension table cannot bind, and does not substitute it", async () => {
    const { root } = await projectWithShim();

    // A decision *does* name this package, so the choice is not unmatched for want of a decision — it
    // is dropped because the mapping table cannot bind the package at all. The compiler refuses this
    // lock too (`extension-mapping-missing`), and the audit reports
    // `lock-conformance-extension-library-not-verified`.
    //
    // The test's premise changed with the projection, and the change is worth recording because the
    // old assertion is now unreachable rather than merely failing: it asserted that
    // `extensionSubstitutions` *threw* for this case, and it cannot, because a choice whose decision
    // the audit could not match is filtered out before that point. Measured (`subs=0`, no throw).
    // What a developer sees is unchanged and is what matters: the id is not substituted, so it
    // resolves the way the compiler would resolve it.
    writeFileSync(
      join(root, "fgc.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            packageName: "not-a-listed-extension",
            cellTarget: null,
            strategy: "extension",
            resolvedVersion: "1.0.0",
            globalName: "NotListed",
            libraryId: "not-listed",
            probe: { status: "passed", fingerprint: "probe=x", versionIndependent: false },
            target: {
              product: "Forguncy",
              productVersion: "12.0.100.0",
              productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
              hostReactVersion: "19.2.7",
            },
            // The project's own identity (#94), read after the lockfile above so the record and the
          // environment the harness computes agree. A literal would report `install-graph-changed`
          // for a project where nothing moved, and the decision would be withheld.
          probedWith: await readToolchainIdentity(root),
            extension: { version: "1.0.0", identity: "sha256:bb" },
            rejectedCandidate: null,
            rationale: "fixture: an `extension` decision the table cannot bind",
            evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
          },
        ],
      }),
      "utf8",
    );

    const { substituted, error } = await substitutionOutcome(root, [
      {
        packageName: "not-a-listed-extension",
        mode: "substitute",
        kind: "npm-package",
        resolvesTo: "es-toolkit",
        justification: "fixture: no mapping row covers this package",
      },
    ]);

    // The server refuses, and that is the correct answer rather than a strictness: the conformance
    // audit reports `extension-library-not-verified` for a decision the mapping table cannot bind, so
    // the compiler will not compile the artifact either — refusing here is the same answer, reached
    // earlier. The refusal names the conformance finding, which is what tells a reader this is the
    // lock's problem and not a substitute the project failed to declare.
    expect(error).toContain("refused to start");
    expect(error).toContain("lock-conformance-extension-library-not-verified");
    // And nothing was substituted on the way to that refusal.
    expect(substituted).toBeUndefined();
  }, 120_000);
});
