import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createServer } from "vite";

import { devHarness, HARNESS_ENTRY_URL_PATH, HARNESS_MOUNT_ELEMENT_ID, normalizeAliasFind } from "./vite-plugin.ts";

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
 *    result *over* the user's. A project pointing `react` at a patched build got the plugin's path
 *    and no diagnostic. The plugin now emits only the ids the project has not claimed.
 *
 *    **A second review round found the fix was incomplete**, and the shape of that mistake is the
 *    most instructive thing in this file: the filter tested ids for equality, while Vite matches
 *    an alias pattern as `importee === pattern || importee.startsWith(pattern + "/")`. So naming
 *    `react` claims `react/jsx-runtime` as well, and the harness's own subpath entries survived to
 *    win a race — but only in the array form, because Vite's merge order differs by form (the
 *    project's entry comes first for an object, the plugin's for an array). The object-form test
 *    below passes either way; the array-form one is the guard. The general lesson: assert at the
 *    level the defect lives at, and the defect lived in *resolution*, not in the alias list.
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

/**
 * Where a module id *actually resolves*, through the real resolver.
 *
 * The helper the second review round turned out to need. The tests above inspect the alias
 * entries in the resolved config, which answers "which entries exist" — and that is not the same
 * question as "which entry wins for this import". The prefix bug lived exactly in the gap: the
 * harness's own `react/jsx-dev-runtime` entry existed *beside* the project's `react` pattern,
 * and because Vite evaluates the plugin's aliases first, the harness's won. Nothing about the
 * entry list looked wrong.
 *
 * So this asks `pluginContainer.resolveId`, which is Vite's own resolution — aliases, optimizer
 * and all — with no knowledge of how the plugin arranged its config.
 */
async function resolveModuleId(
  server: { pluginContainer: { resolveId(id: string): Promise<{ id: string } | null> } },
  moduleId: string,
): Promise<string> {
  const resolved = await server.pluginContainer.resolveId(moduleId);
  return resolved?.id ?? "(unresolved)";
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
   * A `find` that is a `RegExp` is matched with `test`, which is what Vite itself does with it.
   * The question is not what the expression *means* but whether it matches each of the finite host
   * ids, and `test` answers that exactly. An earlier version ignored RegExps as "unreadable",
   * reasoning that which ids they match is undecidable — but a project's `find: /^react$/`
   * override was then beaten by the harness in precisely the way the string case was, so ignoring
   * them was wrong in the direction that matters.
   */
  it("reads the array form for both string and RegExp finds", async () => {
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
      // The `RegExp` `find` anchors to `react-dom` exactly, so it does *not* claim
      // `react-dom/client` — the harness's own alias for that subpath must therefore survive.
      expect(aliasReplacement(server, "react-dom/client")).toBeDefined();
    } finally {
      await server.close();
    }
  });

  /**
   * **The bug the second review round found, and the reason the tests above were not enough.**
   *
   * Vite's alias rule is `importee === pattern || importee.startsWith(pattern + "/")`, so a
   * project naming `react` claims `react/jsx-runtime` and `react/jsx-dev-runtime` as well.
   * Filtering by exact equality left the harness's own subpath entries in place, and since Vite
   * merges the plugin's aliases *in front of* the project's, those entries were evaluated first
   * and won: the project got its patched React for the bare import and the harness's stock React
   * for every JSX runtime import.
   *
   * Asserted through `pluginContainer.resolveId` rather than against the alias list, because the
   * alias list looked correct in the broken version — the entries simply lost a race the list
   * could not show.
   *
   * **This case would have passed even with the exact-equality bug**, and the reason is worth
   * keeping: Vite's object-form merge puts the project's `react` entry first, so its prefix match
   * wins the subpaths on its own. It is kept as the regression test for the *object* form (a
   * project must keep every id its pattern covers) and as an executable record of which form was
   * actually broken. The array test below is the one that fails under the bug — see the module
   * docstring for the merge-order table.
   */
  it("lets a project's object-form `react` claim its subpaths, at resolution time", async () => {
    const server = await serverFor("ordinary", { userAlias: { react: "/project-owned/react" } });

    try {
      // The bare id is served by the project...
      expect(await resolveModuleId(server, "react")).toBe("/project-owned/react");
      // ...and so are the subpaths, which the project's own prefix match covers.
      expect(await resolveModuleId(server, "react/jsx-runtime")).toBe("/project-owned/react/jsx-runtime");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe(
        "/project-owned/react/jsx-dev-runtime",
      );
    } finally {
      await server.close();
    }
  });

  /**
   * **The case the second review round found.** The array form is where the bug bit: Vite merges
   * the harness's entries *before* the project's here, so the harness's exact
   * `react/jsx-dev-runtime` alias was evaluated first and won the subpath — the project's patched
   * React applied to the bare import and the harness's stock React to every JSX runtime import.
   *
   * Confirmed to fail under the exact-equality filter and to pass under the prefix rule, which is
   * what makes it a real guard rather than a restatement.
   */
  it("lets an array-form `react` find claim its subpaths, at resolution time", async () => {
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: [{ find: "react", replacement: "/array-owned/react" }] },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      expect(await resolveModuleId(server, "react")).toBe("/array-owned/react");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe("/array-owned/react/jsx-dev-runtime");
    } finally {
      await server.close();
    }
  });

  /**
   * A RegExp that matches a host subpath claims it too, by Vite's `test`.
   *
   * The pattern is written with a lookahead rather than `^react(?:\/.*)?$`, because Vite applies
   * the alias as `importee.replace(pattern, replacement)` — a pattern that swallows the subpath
   * produces `/regex-owned/react` for both ids, which would make the assertion below pass without
   * showing that the subpath survived. The lookahead matches the prefix while leaving the `/...`
   * tail in place, so the two ids resolve to visibly different paths and the prefix rule is what
   * the test actually measures.
   */
  it("lets a RegExp find that matches a host id claim it, at resolution time", async () => {
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: [{ find: /^react(?=\/|$)/, replacement: "/regex-owned/react" }] },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      expect(await resolveModuleId(server, "react")).toBe("/regex-owned/react");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe("/regex-owned/react/jsx-dev-runtime");
    } finally {
      await server.close();
    }
  });

  /**
   * **The case the third review round found.** A trailing slash on both `find` and `replacement`
   * is a valid Vite alias, and Vite strips it from both before matching. Filtering the `find` *as
   * written* therefore saw `"react/"`, which claims neither `react` nor its subpaths, so the
   * harness kept its own aliases and the project's override did nothing at all — a worse failure
   * than the previous round's subpath-only one, since even the bare import went to the harness.
   *
   * Asserted at resolution, like the others: at filter time the alias list contains the harness's
   * entries either way, which is exactly why this defect survived two rounds of list inspection.
   */
  it("honours an array alias whose find and replacement both end in a slash", async () => {
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: [{ find: "react/", replacement: "/slash-owned/react/" }] },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      // Vite normalizes both sides, so the bare id and the subpaths all go to the project.
      expect(await resolveModuleId(server, "react")).toBe("/slash-owned/react");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe("/slash-owned/react/jsx-dev-runtime");
    } finally {
      await server.close();
    }
  });

  /**
   * The negative half, and the reason the normalization is conditional rather than a plain strip.
   *
   * `{ find: "react/", replacement: "/patched-react" }` has a slash on `find` only, so Vite does
   * **not** normalize it: the entry keeps `find: "react/"`, whose prefix rule (`=== "react/"` or
   * `startsWith("react//")`) matches no real import. The project has therefore claimed nothing,
   * and the harness must keep substituting — stripping the slash anyway would decline to alias on
   * behalf of an entry that resolves nothing, leaving the project with no React at all.
   *
   * **Asserted on the normalization itself, not through resolution, and that distinction was
   * learned the hard way.** The first version of this test resolved `react` and required it not to
   * be `/patched-react` — which passed under *both* the correct and the unconditional-strip
   * implementation, because either way the user's entry claims nothing and the harness's own
   * `react` alias ends up serving the id. A test that passes for both the right and the wrong
   * behaviour guards nothing; it just looks like it does. The observable that actually differs is
   * whether the pattern is claimed, so that is what is asserted.
   */
  it("does not normalize a slash on find alone, since Vite does not either", () => {
    // Slash on find only: Vite leaves it alone, so the pattern still carries its slash...
    expect(normalizeAliasFind("react/", "/patched-react")).toBe("react/");
    // ...and a pattern with that slash claims no real module id.
    expect(normalizeAliasFind("react/", "/patched-react")).not.toBe("react");

    // Both slashed: Vite strips both, so the pattern becomes the plain package id.
    expect(normalizeAliasFind("react/", "/patched-react/")).toBe("react");
    // No slashes: unchanged, which is the ordinary case.
    expect(normalizeAliasFind("react", "/patched-react")).toBe("react");
    // A slash on replacement only: still not Vite's condition, so still unchanged.
    expect(normalizeAliasFind("react", "/patched-react/")).toBe("react");
    // A non-string replacement (a function resolver) cannot satisfy Vite's condition either.
    expect(normalizeAliasFind("react/", undefined)).toBe("react/");
  });

  /**
   * The object form of the same case, asserted on the **entry set** rather than on a resolved id.
   *
   * The fourth review round caught a documentation error here — object entries *are* normalized by
   * Vite, contrary to what an earlier comment claimed — and fixing it exposed a latent defect
   * rather than a mere wording problem. With `{ "react/": "/patched-react/" }` the filter judged
   * the project as having claimed nothing, so the harness kept its own `react` entry beside the
   * project's. The resolution still came out right, because object-form merge order puts the
   * project's entry first — so a test asserting on the resolved id passes either way and would
   * have been the third non-guard in this file.
   *
   * The observable that distinguishes them is that **two entries exist for one id**. That is a
   * latent failure rather than a working state: whichever wins today, the duplicate means the
   * harness is substituting for an id the project has taken, which is exactly what the filter
   * exists to prevent. Asserted on the entry set, where the difference is visible.
   */
  it("does not leave a duplicate host alias for an object-form key with trailing slashes", async () => {
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: { "react/": "/patched-react/" } },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      const entries = (server.config.resolve.alias as { find?: unknown }[]).filter(
        entry => String(entry.find) === "react",
      );

      // Exactly one entry claims `react`: the project's. A second one would be the harness's,
      // meaning it declined to yield an id the project had taken.
      expect(entries).toHaveLength(1);
      expect(await resolveModuleId(server, "react")).toBe("/patched-react");
      // And the subpaths, which the project's prefix match now covers without a rival entry.
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe("/patched-react/jsx-dev-runtime");
    } finally {
      await server.close();
    }
  });

  /**
   * A `/g` pattern must not be left mutated.
   *
   * `test` on a global pattern advances `lastIndex`, so a probe that called it would make this
   * filter's *call count* decide what Vite's later resolution sees — a project writing `find:
   * /react/g` would get an override that applied on every other import. The filter restores
   * `lastIndex`; this asserts the expression arrives back exactly as it was handed over.
   */
  it("leaves a global RegExp pattern's lastIndex untouched", async () => {
    const pattern = /react/g;
    const server = await createServer({
      root: join(fixturesRoot, "ordinary"),
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: [{ find: pattern, replacement: "/g-owned/react" }] },
      plugins: [devHarness({ config }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      expect(pattern.lastIndex).toBe(0);
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
