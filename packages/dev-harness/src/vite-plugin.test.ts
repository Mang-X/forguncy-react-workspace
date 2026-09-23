import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createServer } from "vite";

import { devHarness, HARNESS_ENTRY_URL_PATH, HARNESS_MOUNT_ELEMENT_ID } from "./vite-plugin";

/**
 * The harness plugin under a **real Vite dev server**, which is the only place two of its
 * behaviours are decidable.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * ## Why this file exists
 *
 * Both behaviours below were **wrong in the first version of the plugin, and both were found by
 * review rather than by a test** — and each failed in the *green* direction, which is the shape
 * this package exists to prevent. A test is the only thing that keeps them fixed:
 *
 * 1. **Alias precedence.** The plugin returned every host alias from its `config()` hook while
 *    the example also spread `harnessHostModulePlan()` into its own config, so the example's
 *    documented ability to override an entry was illusory — Vite merges a plugin's `config()`
 *    result *over* the user's, key by key, later value winning. A project pointing `react` at a
 *    patched build got the plugin's path and no diagnostic. The plugin now emits only the ids the
 *    project has not claimed.
 * 2. **HTML injection.** The plugin spliced its mount node in with `html.replace("</body>", …)`,
 *    a no-op for a template whose closing body tag is absent, upper-case, or formatted
 *    differently — every one of which is valid HTML. The server started, the page served, and the
 *    Cell never mounted: a blank page with nothing to explain it. The plugin now returns Vite's
 *    `tags`, which needs no insertion point to exist.
 *
 * Both are checked against a real server because neither is visible in the plugin's return value.
 * `config()` returning the right object and Vite *resolving* to the right alias are different
 * statements, and the whole first bug was that they disagreed.
 *
 * ## Why the fixtures are committed, one directory per case
 *
 * Each HTML case needs a *different* `index.html`, and the generated entry imports this package by
 * name — `@forguncy-react-workspace/dev-harness/mount` — which resolves through the workspace
 * link. A project written to a temp directory **outside** the workspace cannot resolve that
 * import, so the entry URL answers 500 and the test would be measuring its own setup instead of
 * the plugin. Committed fixtures keep the module graph resolvable the way a real project's is.
 *
 * One directory per case rather than one shared root with the HTML rewritten between tests: Vite
 * caches the transformed `index.html`, so a shared root leaked the first case's page into the
 * others. One root, one template, no shared state.
 */

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "html-injection");

/** A hand-written config, so the fixtures need no `forguncy.config.ts` of their own. */
const config = {
  cells: {
    probe: {
      entry: "./cells/probe/src/index.ts",
      target: { pageName: "探针", cell: "A1" },
    },
  },
};

/**
 * A server over one fixture directory.
 *
 * `listening` decides whether it binds a port: the alias tests read `server.config`, which a
 * middleware-mode server resolves just as well, while the HTML tests must *fetch* the transformed
 * page and `server.listen()` refuses in middleware mode. The split is the tests' own — one group
 * inspects resolved config, the other needs a real HTTP response.
 */
async function serverFor(
  fixture: string,
  options: { readonly userAlias?: Record<string, string>; readonly listening?: boolean } = {},
) {
  return createServer({
    root: join(fixturesRoot, fixture),
    configFile: false,
    logLevel: "error",
    appType: "spa",
    ...(options.userAlias === undefined ? {} : { resolve: { alias: options.userAlias } }),
    plugins: [devHarness({ config }) as never],
    server:
      options.listening === true
        ? // Port 0 lets the OS pick a free one, so the suite collides neither with a developer's
          // own dev server nor with a second concurrent run of this file.
          { port: 0, strictPort: false, hmr: false, watch: null }
        : { middlewareMode: true, hmr: false, watch: null },
  });
}

/** The resolved replacement for one alias id, or `undefined` when nothing claims it. */
function aliasReplacement(
  server: { config: { resolve: { alias: unknown } } },
  moduleId: string,
): string | undefined {
  const alias = server.config.resolve.alias;
  if (Array.isArray(alias)) {
    const entry = (alias as { find?: unknown; replacement?: string }[]).find(candidate => candidate.find === moduleId);
    return entry?.replacement;
  }
  return Object.entries((alias ?? {}) as Record<string, string>).find(([find]) => find === moduleId)?.[1];
}

/** The local URL a listening server reported, or a failure naming the reason. */
function localUrl(server: { resolvedUrls: { local: string[] } | null }): string {
  const base = server.resolvedUrls?.local[0];
  if (base === undefined) {
    throw new Error("The server reported no local URL, so nothing can be fetched from it.");
  }
  return base;
}

describe("alias precedence between the project and the plugin's config() hook", () => {
  /**
   * The regression: a project that names an id keeps its own value.
   *
   * Asserted on `server.config.resolve.alias` — the *resolved* config — rather than on what the
   * hook returns, because the bug was precisely that those two disagreed.
   */
  it("lets a project override a host alias it named itself", async () => {
    const server = await serverFor("ordinary", { userAlias: { react: "/project-owned/react" } });

    try {
      expect(aliasReplacement(server, "react")).toBe("/project-owned/react");
    } finally {
      await server.close();
    }
  });

  /**
   * The other half, and the reason the plugin still emits aliases at all: an id the project did
   * *not* name is filled in by the harness, so a bare `devHarness({ config })` is a working
   * harness rather than one whose first `import ... from "react"` fails.
   *
   * Without this, the fix for the case above would have been "delete the aliases", which trades a
   * silent override for a silent breakage.
   */
  it("supplies the host aliases the project did not name", async () => {
    const server = await serverFor("ordinary");

    try {
      // `react` is bridged, installed and unclaimed, so the harness must supply it — and the two
      // ids below are *subpaths* of a bridge row, which a row-keyed lookup would miss entirely.
      expect(aliasReplacement(server, "react")).toBeDefined();
      expect(aliasReplacement(server, "react/jsx-dev-runtime")).toBeDefined();
      expect(aliasReplacement(server, "react-dom/client")).toBeDefined();
    } finally {
      await server.close();
    }
  });

  /** Both halves at once, which is the realistic case: one override must not suppress the rest. */
  it("keeps the project's override and the harness's remaining aliases side by side", async () => {
    const server = await serverFor("ordinary", { userAlias: { react: "/project-owned/react" } });

    try {
      expect(aliasReplacement(server, "react")).toBe("/project-owned/react");
      expect(aliasReplacement(server, "react-dom/client")).toBeDefined();
    } finally {
      await server.close();
    }
  });

  /**
   * The array alias form, because Vite accepts either shape and a project may use whichever.
   *
   * A `find` that is a `RegExp` is deliberately *not* treated as claiming the id: from here it is
   * impossible to say which ids it matches, and guessing would drop a substitution the harness
   * needs. An unreadable claim therefore leaves the harness's alias in place — the conservative
   * direction, and the second assertion below.
   */
  it("reads the array form, and treats a RegExp find as claiming nothing", async () => {
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: {
        alias: [
          { find: "react", replacement: "/array-owned/react" },
          { find: /^react-dom$/, replacement: "/array-owned/react-dom" },
        ],
      },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      // A string `find`: the project claims the id, so the harness defers.
      expect(aliasReplacement(server, "react")).toBe("/array-owned/react");
      // A `RegExp` `find`: unreadable as a claim, so the harness's own alias survives rather than
      // being assumed to cover `react-dom/client` — which the regex does not match anyway.
      expect(aliasReplacement(server, "react-dom/client")).toBeDefined();
    } finally {
      await server.close();
    }
  });
});

describe("the mount node is injected without depending on a closing body tag", () => {
  /**
   * The regression, and the reason the string-replace form was indefensible: `</body>` is
   * optional in HTML, so a valid template may legitimately lack it.
   *
   * The original implementation served this template happily and injected nothing — no mount node,
   * no entry script, a blank page, and no diagnostic anywhere. This is what turns that into a
   * failure instead of a mystery.
   */
  it("injects both tags into a template with no closing body tag", async () => {
    const server = await serverFor("no-body", { listening: true });
    await server.listen();

    try {
      const html = await (await fetch(localUrl(server))).text();
      expect(html).toContain(`id="${HARNESS_MOUNT_ELEMENT_ID}"`);
      expect(html).toContain(HARNESS_ENTRY_URL_PATH);
    } finally {
      await server.close();
    }
  });

  /**
   * Upper case, because HTML tag names are case-insensitive and a hand-written or generated
   * template may use any casing — the string form matched `</body>` exactly and missed this.
   */
  it("injects both tags into a template with an upper-case closing body tag", async () => {
    const server = await serverFor("uppercase-body", { listening: true });
    await server.listen();

    try {
      const html = await (await fetch(localUrl(server))).text();
      expect(html).toContain(`id="${HARNESS_MOUNT_ELEMENT_ID}"`);
      expect(html).toContain(HARNESS_ENTRY_URL_PATH);
    } finally {
      await server.close();
    }
  });

  /**
   * The ordinary template, so the fixed mechanism is asserted on the case it replaced as well as
   * on the cases that broke it — otherwise "it works now" would be evidence only about edge cases
   * and the common path could regress unnoticed.
   *
   * The mount node must precede the script: the generated entry looks the node up by id at import
   * time, so a reversed order would throw the harness's own "no mount node" error.
   */
  it("puts the mount node before the entry script, and leaves the template's content alone", async () => {
    const server = await serverFor("ordinary", { listening: true });
    await server.listen();

    try {
      const html = await (await fetch(localUrl(server))).text();
      const nodeAt = html.indexOf(`id="${HARNESS_MOUNT_ELEMENT_ID}"`);
      const scriptAt = html.indexOf(HARNESS_ENTRY_URL_PATH);

      expect(nodeAt).toBeGreaterThan(-1);
      expect(scriptAt).toBeGreaterThan(-1);
      expect(nodeAt).toBeLessThan(scriptAt);
      // Vite appends rather than splicing, so the project's own markup survives.
      expect(html).toContain("keep me");
    } finally {
      await server.close();
    }
  });

  /**
   * The entry the injected script points at must actually be *served*, or the injection is a
   * script tag pointing at nothing — which is exactly how the earlier `@id/` virtual-id bug
   * presented: Vite's SPA fallback answered with the page's HTML and the browser tried to parse
   * markup as JavaScript.
   */
  it("serves the entry module the injected script points at", async () => {
    const server = await serverFor("ordinary", { listening: true });
    await server.listen();

    try {
      const response = await fetch(new URL(HARNESS_ENTRY_URL_PATH.replace(/^\//, ""), localUrl(server)));

      expect(response.status).toBe(200);
      const source = await response.text();
      expect(source).toContain("mountCell");
      // Not the fallback's markup — the two are indistinguishable by status code alone.
      expect(source).not.toContain("<!doctype html>");
    } finally {
      await server.close();
    }
  });
});
