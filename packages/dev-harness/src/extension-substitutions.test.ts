import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { createServer } from "vite";

import type { ForguncyConfig } from "@forguncy-react-workspace/core";

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
/** A throwaway project with an `extension` decision, a Cell, and a shim the project declares. */
function projectWithShim(): { root: string; shimMarker: string } {
  const root = mkdtempSync(join(tmpdir(), "dev-harness-subst-"));
  onTestFinished(() => removeTempProject(root));

  const shimMarker = "PROJECT_SHIM_MARKER_7f3a";
  mkdirSync(join(root, "cells", "probe", "src"), { recursive: true });
  mkdirSync(join(root, "shims"), { recursive: true });

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
            productBuild: "b",
            hostReactVersion: "19.2.7",
          },
          probedWith: { vitePlus: "0.3.2" },
          extension: { version: "5.102.8", identity: "sha256:aa" },
          rejectedCandidate: null,
          rationale: "fixture",
          evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
        },
      ],
    }),
    "utf8",
  );

  return { root, shimMarker };
}

/**
 * The config every case hands the plugin; only `extensionChoices` differs.
 *
 * Typed as `ForguncyConfig` rather than a structural lookalike, and that is not cosmetic: the first
 * version widened `cells` to `Record<string, unknown>`, which `tsc` refused — a config the plugin
 * accepts is one whose Cells are `CellConfig`s, and a test that hands it something looser would be
 * asserting against a shape no real project has.
 */
function configFor(): ForguncyConfig {
  return {
    cells: { probe: { entry: "./cells/probe/src/App.tsx", target: { pageName: "探针", cell: "A1" } } },
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
      throw new Error(`the authored entry did not serve (${authoredResponse.status}): ${authoredBody.slice(0, 300)}`);
    }

    // Every import the authored Cell makes, so the substituted one is found by its own module id
    // rather than by elimination — an earlier version excluded `react`/`/@vite` prefixes and let
    // `/.vite/deps/react_jsx-dev-runtime.js` through, so it fetched the wrong module and the
    // failure read as "the shim was not loaded".
    const imported = [...authoredBody.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!);
    const substituted = imported.find(specifier => specifier.includes("extension-substitution"));
    if (substituted === undefined) {
      const flat = authoredBody.slice(0, 700).split("\n").join(" | ");
      throw new Error(`the authored Cell names no substitution module. imports=${JSON.stringify(imported)} body=${flat}`);
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

describe("a declared substitute is the module the Cell loads", () => {
  it("loads the project's own shim, not the npm copy", async () => {
    const { root, shimMarker } = projectWithShim();

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
    const { root } = projectWithShim();

    // `@tanstack/query-core` is installed in this workspace, so a `npm-package` substitute naming it
    // is a real substitution rather than a missing dependency. `examples/extension-query` installs
    // both packages, and this temp project resolves through the workspace root's tree.
    const { status, body } = await loadedForSubstitutedImport(root, [
      {
        packageName: "@tanstack/react-query",
        mode: "substitute",
        kind: "npm-package",
        resolvesTo: "@tanstack/query-core",
        justification: "fixture: any installed package stands in for the extension's global",
      },
    ]);

    expect(status).toBe(200);
    // It resolved to *something*, and what it resolved to is the named package's own code — the
    // substitute was consulted rather than the original package being served.
    expect(body).toMatch(/QueryClient|query-core|QueryObserver/);
  }, 120_000);
});

describe("`real-runtime-only` cannot silently take the npm path", () => {
  it("serves a module that throws the project's own acknowledgement", async () => {
    const { root } = projectWithShim();

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
    const { root } = projectWithShim();

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

  it("refuses a choice for a package the extension table does not intercept", async () => {
    const { root } = projectWithShim();

    // The compiler refuses this too (`extension-mapping-missing`), and the harness has to agree:
    // there is no extension for a substitute to stand in for, and silently skipping the choice
    // would leave the id on the npm path the declaration was written to leave.
    await expect(
      loadedForSubstitutedImport(root, [
        {
          packageName: "not-a-listed-extension",
          mode: "substitute",
          kind: "npm-package",
          resolvesTo: "es-toolkit",
          justification: "fixture: no mapping row covers this package",
        },
      ]),
    ).rejects.toThrow(/does not intercept that package/);
  }, 120_000);
});
