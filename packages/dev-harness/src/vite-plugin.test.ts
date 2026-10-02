import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";

import {
  devHarness,
  HARNESS_ENTRY_URL_PATH,
  HARNESS_MOUNT_ELEMENT_ID,
  normalizeAliasFind,
  projectAliasTarget,
} from "./vite-plugin.ts";
import { hostModuleAliases } from "./host-modules.ts";

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
 *
 * ## Why the non-listening case switches the dependency optimizer off
 *
 * The alias group deliberately points `react` at a path that does not exist (`/project-owned/react`
 * and friends). Those paths are never read — the tests ask the resolver *which id wins* — but the
 * plugin's `config()` hook also puts `react` in `optimizeDeps.include`, and the optimizer scans
 * that include list in the background regardless. It then tries to load the aliased path, fails,
 * and reports the failure as an **unhandled rejection** *after* the test that started the server
 * has already passed. Vitest counts that as an error, so `vp test --run` exits non-zero with every
 * test green.
 *
 * Measured on Windows, where it is deterministic for the whole `dev-harness` package (6 of 6 runs)
 * and makes a full-suite run end `Errors 5 errors` beside `2196 passed`; it did not reproduce on
 * the Linux CI log. A Windows CI leg would therefore have been red — or flaky — from the day it was
 * added, which is the failure mode this repository treats as worse than a missing test.
 *
 * `disabled: true` is the switch the option is *for* ("true or 'dev' disables the optimizer"), and
 * it is scoped to the servers that never serve a module: a server that binds no port and answers no
 * request has no module graph for the optimizer to build, so this removes background work rather
 * than an assertion. Verified to leave `pluginContainer.resolveId` answers and the resolved alias
 * list byte-identical — the probe this reasoning came from compared them with the optimizer on and
 * off.
 */

/** Either alias shape Vite accepts, which is what the tests below vary. */
type UserAlias = Record<string, string> | readonly { find: string | RegExp; replacement: string }[];

async function serverFor(
  fixture: string,
  options: { readonly userAlias?: UserAlias; readonly listening?: boolean } = {},
) {
  return createServer({
    root: join(fixturesRoot, fixture),
    configFile: false,
    logLevel: "error",
    appType: "spa",
    ...(options.userAlias === undefined ? {} : { resolve: { alias: options.userAlias } }),
    ...(options.listening === true ? {} : { optimizeDeps: { disabled: true } }),
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
    const server = await serverFor("ordinary", {
      userAlias: [
        { find: "react", replacement: "/array-owned/react" },
        { find: /^react-dom$/, replacement: "/array-owned/react-dom" },
      ],
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
    const server = await serverFor("ordinary", {
      userAlias: [{ find: "react", replacement: "/array-owned/react" }],
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
    const server = await serverFor("ordinary", {
      userAlias: [{ find: /^react(?=\/|$)/, replacement: "/regex-owned/react" }],
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
    const server = await serverFor("ordinary", {
      userAlias: [{ find: "react/", replacement: "/slash-owned/react/" }],
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
    const server = await serverFor("ordinary", { userAlias: { "react/": "/patched-react/" } });

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
    const server = await serverFor("ordinary", {
      userAlias: [{ find: pattern, replacement: "/g-owned/react" }],
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

/**
 * Issue #97's dev half: the project's own `resolve.alias` block drives local resolution.
 *
 * ## What was missing, and why it needed a real server
 *
 * The harness had no path from `registry.resolve` into resolution at all — the block did not exist
 * before #97 — so a project alias was a `vite.config.ts` setting whose production behaviour nothing
 * implemented. The whole defect is only visible at resolution: `config()` emitting the right object
 * and Vite *resolving* an import to the right file are different statements, which is the lesson the
 * alias-precedence block above records.
 *
 * ## Why this applies the alias in `resolveId` rather than emitting a Vite alias
 *
 * Three measured reasons, and they are why the implementation is shaped the way it is:
 *
 * - `config()` runs before the registry exists, and when a project does not set `root` it cannot
 *   see one either; normalizing the block there would be a *second* normalization of one config
 *   file, free to disagree with the build's.
 * - Mutating `config.resolve.alias` in `configResolved` is inert — Vite has built its resolver by
 *   then. Measured: neither `unshift` nor replacing the array changes what resolves.
 * - An alias emitted from `config()` lands *before* the project's own `vite.config.ts` aliases, which
 *   is the silent override the precedence block exists to prevent.
 *
 * So the harness reads `registry.resolve.alias` — the one normalized set — and applies it in its own
 * `resolveId`, which is also why a project alias cannot shadow a host-bridged id: `resolve-config.ts`
 * refuses that declaration, because the two engines order the binding oppositely.
 */
describe("the project's alias block resolves under a real dev server", () => {
  const aliasFixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  /** The registry for the alias fixture, normalized the way a project's own config would be. */
  function aliasRegistry() {
    return createCellRegistry(
      {
        cells: {
          probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } },
        },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: aliasFixtureRoot },
    );
  }

  it("resolves an aliased import to the file the project declared", async () => {
    const server = await createServer({
      root: aliasFixtureRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: aliasRegistry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      // The assertion is on the *resolved id* rather than on any config value, because the id is
      // what the module graph loads. This is the same level the alias-precedence tests assert at,
      // and for the same reason.
      //
      // Compared with separators normalized: Vite answers with POSIX ids, so a Windows-authored
      // expectation would fail on the separator alone while resolution was perfectly correct.
      const resolved = await resolveModuleId(server, "@app/shared/thing");
      expect(resolved.replace(/\\/g, "/")).toBe(join(aliasFixtureRoot, "shared", "thing.ts").replace(/\\/g, "/"));
    } finally {
      await server.close();
    }
  });

  it("loads the aliased module's code, so the resolution is real rather than a path string", async () => {
    // The control for the assertion above: a resolver that answered with a plausible path but never
    // loaded the file would pass an id comparison. Reading the transformed module proves the file
    // behind the id was actually read.
    const server = await createServer({
      root: aliasFixtureRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: aliasRegistry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      const resolved = await server.pluginContainer.resolveId("@app/shared/thing");
      expect(resolved, "the alias must resolve before anything can be loaded").not.toBeNull();
      const loaded = await server.transformRequest(resolved!.id);
      expect(loaded?.code).toContain("resolved-via-project-alias");
    } finally {
      await server.close();
    }
  });

  it("resolves a subpath of an aliased directory through the same rule the build uses", async () => {
    // The prefix rule is the one both engines agree on, so this is the case that pins the agreement
    // rather than only the exact id: `@app/shared/thing` and `@app/shared` must both work, or a
    // project would have to name every file.
    const server = await createServer({
      root: aliasFixtureRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: aliasRegistry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      // The directory itself resolves to an existing module, which is what makes the prefix
      // meaningful rather than a coincidence of this fixture's layout.
      expect(await resolveModuleId(server, "@app/shared/thing")).toContain("shared");
      expect(await resolveModuleId(server, "@app/shared/thing")).toContain("thing.ts");
    } finally {
      await server.close();
    }
  });
});

/**
 * The alias-matching rule itself, asserted directly because the *ordering* is not observable
 * through a resolution that has only one candidate key.
 *
 * ## Why this is a unit test when everything else here is a real server
 *
 * The precedence rule needs two keys that both match one id to be exercised at all, and a fixture
 * project can declare that — but the resulting resolution is indistinguishable from a
 * longest-match implementation unless you also vary the *declaration order* and watch the answer
 * move. A pure function over a map tests exactly that, with no server, and the server-level tests
 * above already establish that this function is what the resolver consults.
 *
 * ## The rule, measured rather than reasoned
 *
 * Both engines answer by **declaration order**, first match wins. Measured for `@/lib/deep/x` with
 * `@/lib` and `@/lib/deep` both declared:
 *
 * | order | Vite 8.3.0 | Rolldown 1.2.9 |
 * | --- | --- | --- |
 * | `@/lib` first | `@/lib`'s target | `@/lib`'s target |
 * | `@/lib/deep` first | `@/lib/deep`'s target | `@/lib/deep`'s target |
 *
 * The intuitive answer is "the longest, most specific key wins", and it is wrong. Implementing it
 * here would be a third rule — right in isolation, and a real divergence from both engines the
 * first time a project declared overlapping prefixes. So this test exists as much to record that
 * the naive reading was checked and rejected as to pin the behaviour.
 */
describe("the project alias rule, and its precedence", () => {
  it("matches the bare key and any subpath of it, and nothing else", () => {
    const alias = { "@/lib": "/abs/lib" };

    expect(projectAliasTarget("@/lib", alias)).toBe("/abs/lib");
    expect(projectAliasTarget("@/lib/thing", alias)).toBe("/abs/lib/thing");
    expect(projectAliasTarget("@/lib/deep/x", alias)).toBe("/abs/lib/deep/x");
    // A near-miss prefix must not match: `@/library` is a different id, and Vite's rule is
    // `startsWith(key + "/")` rather than `startsWith(key)`.
    expect(projectAliasTarget("@/library/thing", alias)).toBeUndefined();
    expect(projectAliasTarget("other", alias)).toBeUndefined();
  });

  it("takes the first declaration that matches, as both engines do", () => {
    // The whole point of the test: the same two keys in two orders must give two different
    // answers, and each must be the one the engines produce for that order.
    expect(projectAliasTarget("@/lib/deep/x", { "@/lib": "/A", "@/lib/deep": "/B" })).toBe("/A/deep/x");
    expect(projectAliasTarget("@/lib/deep/x", { "@/lib/deep": "/B", "@/lib": "/A" })).toBe("/B/x");
  });

  it("preserves the remainder verbatim rather than rewriting it", () => {
    // `replace` with a string pattern rewrites an occurrence inside the matched text, so a target
    // containing the key would be mangled. `slice` cannot do that, and this pins it.
    expect(projectAliasTarget("@/lib/@/lib/x", { "@/lib": "@/lib" })).toBe("@/lib/@/lib/x");
  });
});

/**
 * The `vite.config.ts` versus `forguncy.config.ts` alias disagreement, refused at startup.
 *
 * ## The divergence, and why it is refused rather than warned about
 *
 * Vite applies the user's `resolve.alias` **before** a plugin's `resolveId` — the ordering this
 * file's own module docstring records, and the reason a project alias cannot be a Vite alias (#97).
 * The harness applies project aliases in its `resolveId`, so a `vite.config.ts` alias naming the
 * same id rewrites the import first and the project alias never runs. The Cell build reads
 * `registry.resolve.alias` and never sees `vite.config.ts`. Both paths therefore **succeed** and
 * resolve one import to different files, which is the dev/production split #97 exists to remove.
 *
 * ## What is asserted, and the case a first version missed
 *
 * The overlap is symmetric, and the first version asked only one direction (does the user pattern
 * claim the project's key). Measured with a project alias `@/ui -> ./ui`, a user alias **deeper**
 * than the project's also wins — `@/ui/thing -> /sub` resolves `@/ui/thing` to `/sub`, while
 * production uses `./ui/thing`. Both directions are asserted, because the miss was invisible in the
 * one-directional test.
 *
 * Asserted through a real server: the refusal has to happen at *startup*, not at some later import,
 * and only a real `createServer` decides that.
 */
describe("a `vite.config.ts` alias that shadows a project alias refuses the server", () => {
  const shadowRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: shadowRoot },
    );
  }

  async function startWith(userAlias: unknown): Promise<void> {
    const server = await createServer({
      root: shadowRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      ...(userAlias === undefined ? {} : { resolve: { alias: userAlias as Record<string, string> } }),
      plugins: [devHarness({ config: registry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses when the user alias names the same id exactly", async () => {
    await expect(startWith({ "@app/shared": "/local-copy" })).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("refuses when the user alias is deeper than the project's, which is the same shadow", async () => {
    // The direction the first version of the check missed: `@/app/shared/thing` also matches a
    // specifier the project alias `@/app/shared` matches, and Vite consults the user's entry first.
    await expect(startWith({ "@app/shared/thing": "/local-copy" })).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("names the alias and the project target, so the repair needs no second lookup", async () => {
    let thrown: unknown;
    try {
      await startWith({ "@app/shared": "/local-copy" });
    } catch (error) {
      thrown = error;
    }

    const message = String(thrown);
    expect(message).toContain("local-dev-project-alias-shadowed");
    expect(message).toContain("@app/shared");
    expect(message).toContain("shared");
  });

  it("still starts for a Vite-only alias that overlaps nothing in the project config", async () => {
    // The control, and the half that keeps this from being "refuse every user alias": a project's
    // own local concern (a patched build, a stub) is legitimate and production has no opinion about
    // it. Only an *overlap* is a divergence.
    await expect(startWith({ "@something-else": "/x" })).resolves.toBeUndefined();
    await expect(startWith(undefined)).resolves.toBeUndefined();
  });
});

/**
 * A `RegExp` `find` in `vite.config.ts` that would shadow a project alias.
 *
 * ## Why this is its own test and not a variation on the string case
 *
 * The shadowing check is a **blocking correctness gate**: a miss restores the dev/build split #97
 * exists to remove, and it does so silently, because both paths succeed and disagree. An earlier
 * version therefore reduced a `RegExp` `find` to its `source` string and let the string comparison
 * decide — and the comment claimed that "fails in the safe direction". That was wrong. Measured
 * against the reviewer's counter-example:
 *
 * | `vite.config.ts` alias | Vite resolves `@app/shared/thing` to | old check |
 * | --- | --- | --- |
 * | `{ find: /^@app\/shared(?=\/|$)/ }` | `/local-copy/thing` | **allowed** |
 *
 * The source string is `@app/shared(?=/|$)`, which is neither equal to the project key nor a `/`
 * prefix of it, so nothing fired. A lookahead is exactly the spelling someone writes for "this id
 * and its subpaths", so this was not an exotic input.
 *
 * ## What replaced it
 *
 * The pattern is **evaluated** against the specifiers a project alias can match, using the caller's
 * own regex engine, so a detection is a fact rather than an approximation. The residue — patterns
 * the bounded probes miss that are still not provably disjoint — fails closed, and a `^`-anchored
 * pattern whose mandatory literal run excludes the key is exempt on a proof rather than a guess.
 */
describe("a `RegExp` `vite.config.ts` alias cannot evade the shadow check", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function startsWith(userAlias: unknown): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: userAlias as Record<string, string> },
      plugins: [devHarness({ config: registry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses the lookahead pattern Vite really does apply, the counter-example that got through", async () => {
    await expect(
      startsWith([{ find: /^@app\/shared(?=\/|$)/, replacement: "/local-copy" }]),
    ).rejects.toThrowError(/refused to start/);
  });

  it("refuses an unanchored pattern that matches the project key anywhere", async () => {
    await expect(startsWith([{ find: /shared/, replacement: "/local-copy" }])).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("refuses an anchored pattern it cannot prove disjoint, rather than exempting it", async () => {
    // This was the exemption review removed. The reasoning it rested on — "`^` makes the leading
    // run mandatory on every match" — is false in three independent ways (flags, alternation,
    // escapes), each reproduced against a real server before the exemption was deleted. So an
    // anchored pattern carrying metacharacters now fails closed: `/^some-other-lib(\/|$)/` overlaps
    // nothing, and is refused anyway.
    //
    // The cost is deliberate and the remedy is stated: the same declaration as a plain string alias
    // is checked exactly and allowed. That is what a project writes for an id it means literally.
    await expect(
      startsWith([{ find: /^some-other-lib(\/|$)/, replacement: "/x" }]),
    ).rejects.toThrowError(/refused to start/);

    await expect(startsWith({ "some-other-lib": "/x" })).resolves.toBeUndefined();
  });

  it("still allows a RegExp that overlaps nothing at all, in the unanchored form too", async () => {
    // The control for the fail-closed branch: an unanchored pattern is never exempt on a prefix
    // argument, so this one is allowed because the probes actually miss it *and* its source is
    // a literal with no metacharacters — the only case where a probe miss is a true miss.
    await expect(startsWith([{ find: /totally-unrelated-package/, replacement: "/x" }])).resolves.toBeUndefined();
  });
});

/**
 * The three ways the removed prefix exemption was unsound, each reproduced against a real server.
 *
 * All three apply to `@app/shared/thing` and all three were let through by the exemption, which
 * treated a `^`-anchored pattern's leading literal run as mandatory on **every** match. That premise
 * is false whenever flags, alternation or an escape changes what the run means — and each of these is
 * ordinary regex usage rather than an exotic input. Measured against Vite before the exemption was
 * removed: all three resolved `@app/shared/thing` to the local copy while production used the
 * project alias, so each is a silent dev/build split, not a missed warning.
 */
describe("no RegExp form evades the shadow check", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function startsWith(userAlias: unknown): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: userAlias as Record<string, string> },
      plugins: [devHarness({ config: registry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a case-insensitive pattern, which `startsWith` read as disjoint", async () => {
    // `/i` makes matching case-insensitive; the extracted prefix was `@APP/SHARED` and the
    // comparison was case-sensitive, so the key looked unreachable.
    await expect(startsWith([{ find: /^@APP\/SHARED(?=\/|$)/i, replacement: "/local-copy" }])).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("refuses a pattern whose `^` binds only the first alternative", async () => {
    // The extractor took `other` as a prefix required of every match; the second branch matches the
    // project alias without containing it at all.
    await expect(startsWith([{ find: /^other|@app\/shared(?=\/|$)/, replacement: "/local-copy" }])).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("refuses a pattern whose separator is written as a hex escape", async () => {
    // `\x73` is the character `s`. The extractor built the wrong prefix from it, which is the same
    // defect class as reading a `/`-escape as two characters.
    await expect(startsWith([{ find: /^@app\/\x73hared(?=\/|$)/, replacement: "/local-copy" }])).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("names the offending pattern in the diagnostic, not the project key", async () => {
    // The audit quotes its `find` input verbatim, so reporting the project key instead would tell a
    // developer their `vite.config.ts` declares an alias it does not — measured before
    // `userAliasPatterns` existed, where an undecidable pattern produced exactly that message.
    let thrown: unknown;
    try {
      await startsWith([{ find: /^@APP\/SHARED(?=\/|$)/i, replacement: "/local-copy" }]);
    } catch (error) {
      thrown = error;
    }

    const message = String(thrown);
    expect(message).toContain("local-dev-project-alias-shadowed");
    expect(message).toContain("@APP");
    expect(message).toContain("pattern alias");
  });

  it("does not audit Vite's own injected aliases as if the project had written them", async () => {
    // `config.resolve.alias` at `configResolved` is the **merged** list — Vite has already folded in
    // `/^\/?@vite\/env/` and `/^\/?@vite\/client/`. Measured: a project that declared no RegExp alias
    // at all was refused with a finding quoting `/^\/?@vite\/env/`, because that pattern is
    // undecidable and so fails closed. A gate that blames Vite's internals on the developer is worse
    // than no gate, so entries in the `@vite/` scope are excluded.
    await expect(startsWith(undefined)).resolves.toBeUndefined();
    await expect(startsWith({ "@something-else": "/x" })).resolves.toBeUndefined();
  });
});

/**
 * A project pattern that names `@vite/` must not be able to exempt itself.
 *
 * An earlier version identified Vite's own injected entries by asking whether the alias *text*
 * mentioned `@vite/`, so it could tell Vite's `/^\/?@vite\/env/` from something the project wrote.
 * That is inferring origin from content, and the inference is the attack surface: a project alias
 * can mention `@vite/` and match its own project id in the same pattern. Measured before the fix:
 *
 * | `vite.config.ts` alias | Vite resolves `@app/shared/thing` to | old check |
 * | --- | --- | --- |
 * | `{ find: /^\/?@vite\/env\|^@app\/shared(?=\/|$)/ }` | `/local-copy/thing` | **allowed** |
 *
 * The fix is not a better heuristic but the removal of the question. This plugin's `config()` hook
 * sees the user's aliases **before** Vite's and its own are merged in, so the audit reads the
 * project's own declarations and no origin has to be inferred from anything.
 */
describe("a project alias cannot opt itself out by naming `@vite/`", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function startsWith(userAlias: unknown): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: userAlias as Record<string, string> },
      plugins: [devHarness({ config: registry() }) as never],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a pattern that names `@vite/` and also matches the project alias", async () => {
    await expect(
      startsWith([{ find: /^\/?@vite\/env|^@app\/shared(?=\/|$)/, replacement: "/local-copy" }]),
    ).rejects.toThrowError(/refused to start/);
  });

  it("still starts for a project with no alias at all, so Vite's own entries are not audited", async () => {
    // The case the content heuristic existed for, and the one it broke: Vite injects
    // `/^\/?@vite\/env/` and `/^\/?@vite\/client/`, which are undecidable and so fail closed. Reading
    // the project's own declarations in `config()` means they are never candidates at all.
    await expect(startsWith(undefined)).resolves.toBeUndefined();
    await expect(startsWith({ "@something-else": "/x" })).resolves.toBeUndefined();
  });
});

/**
 * A **later** Vite plugin's `config()` can add an alias after this harness read the project's own.
 *
 * ## Why the `config()` snapshot alone is not enough
 *
 * This plugin declares `enforce: "pre"`, and Vite runs `config` hooks sequentially — an ordinary or
 * `post` user plugin still merges into `resolve.alias` **after** the snapshot was taken. Measured
 * with no RegExp involved, using exactly the reviewer's construction:
 *
 * ```ts
 * const lateAlias = { name: "late-project-alias", config() {
 *   return { resolve: { alias: { "@app/shared/thing": "/local-copy" } } };
 * } };
 * plugins: [devHarness({ config: forguncyConfig }), lateAlias]
 * ```
 *
 * Vite resolves `@app/shared/thing` to `/local-copy/thing`, the Cell build keeps using
 * `./shared/thing`, and the snapshot-based audit had nothing to refuse.
 *
 * So the **final** alias set is compared against the contributions that are known — the project's
 * declaration, {@link hostModuleAliases} for this harness's own entries, and Vite's `@vite/` scope —
 * and whatever is left is refused. A plugin that changes local resolution by a route the artifact
 * never sees is the unsupported-Vite-plugin behaviour #97 asks to be reported.
 */
describe("an alias added by a later Vite plugin is refused", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  const lateShadow = {
    name: "late-project-alias",
    config() {
      return { resolve: { alias: { "@app/shared/thing": "/local-copy" } } };
    },
  };

  async function start(extra: readonly unknown[], userAlias?: Record<string, string>): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      ...(userAlias === undefined ? {} : { resolve: { alias: userAlias } }),
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a later plugin whose alias shadows the project alias", async () => {
    await expect(start([lateShadow])).rejects.toThrowError(/refused to start/);
  });

  it("refuses a later plugin's alias even when it overlaps nothing", async () => {
    // Not just the overlap case. The audit cannot account for where the alias came from, and an
    // unaccounted alias is a plugin moving local resolution by a route the artifact never sees.
    const unrelated = {
      name: "late-unrelated",
      config() {
        return { resolve: { alias: { "some-unrelated-id": "/x" } } };
      },
    };

    await expect(start([unrelated])).rejects.toThrowError(/refused to start/);
  });

  it("refuses even when the project declared the same key, because the plugin's target won", async () => {
    // The merge collapses both contributions to one entry, so key identity cannot distinguish them
    // — but the merged **value** can: measured, a plugin contributing the same key with a different
    // target makes Vite resolve to the plugin's, so local resolution really did change and the
    // refusal is right rather than over-cautious.
    await expect(start([lateShadow], { "@app/shared/thing": "/x" })).rejects.toThrowError(/refused to start/);
  });

  it("still starts when only the project and this harness contribute", async () => {
    await expect(start([])).resolves.toBeUndefined();
    await expect(start([], { "@unrelated-id": "/x" })).resolves.toBeUndefined();
  });
});

/**
 * Two bypasses of the final-alias subtraction, both because it identified entries by **key or
 * source** rather than by the whole contribution.
 *
 * ## 1. A later plugin rewriting a key this harness owns
 *
 * `hostModuleAliases()` is a complete `find → replacement` map, but the check consulted only
 * `hasOwnProperty(key)`. Measured: a plugin returning
 * `{ resolve: { alias: { react: "/local-copy/react" } } }` makes Vite resolve `react` to
 * `/local-copy/react` — the plugin's value, because a later value wins — while the artifact keeps
 * the host bridge's `React`; the entry was skipped on its key and nothing was reported.
 *
 * ## 2. A later plugin whose pattern merely *mentions* `@vite/`
 *
 * The subtraction re-introduced exactly the content judgement that produced the two previous
 * bypasses. Measured: a plugin contributing
 * `{ find: /^\/?@vite\/env|^@app\/shared(?=\/|$)/, replacement: "/local-copy" }` had Vite resolve
 * `@app/shared/thing` to `/local-copy/thing` and was accepted as one of Vite's own entries.
 *
 * Both are the same shape as rounds 5–8: a property decided by looking at part of a value when the
 * whole value was available. The fix compares the complete entry — key *and* value for a string,
 * source *and* flags *and* value for a pattern.
 */
describe("the final-alias subtraction compares whole entries, not keys", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function start(extra: readonly unknown[], userAlias?: readonly unknown[]): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      ...(userAlias === undefined ? {} : { resolve: { alias: userAlias as never } }),
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a later plugin that rewrites a host alias the harness owns", async () => {
    const lateReact = {
      name: "late-react-alias",
      config() {
        return { resolve: { alias: { react: "/local-copy/react" } } };
      },
    };

    await expect(start([lateReact])).rejects.toThrowError(/refused to start/);
  });

  it("refuses a later plugin whose pattern only mentions `@vite/`", async () => {
    const lateRegex = {
      name: "late-regexp-alias",
      config() {
        return {
          resolve: {
            alias: [{ find: /^\/?@vite\/env|^@app\/shared(?=\/|$)/, replacement: "/local-copy" }],
          },
        };
      },
    };

    await expect(start([lateRegex])).rejects.toThrowError(/refused to start/);
  });

  it("still accepts a project alias that writes a trailing slash on both sides", async () => {
    // Vite normalizes `find: "react/"` with `replacement: "/x/"` to the stripped spelling, so the
    // final entry does not carry the project's authored text. Comparing values raw refused a
    // correctly-declared project alias in both alias forms (measured, in the two pre-existing
    // trailing-slash tests), so both halves go through the same normalization.
    await expect(
      start([], [{ find: "react/", replacement: "/project-owned/react/" }]),
    ).resolves.toBeUndefined();
  });

  it("still accepts a project alias that overlaps nothing", async () => {
    await expect(start([], [{ find: "@nope", replacement: "/x" }])).resolves.toBeUndefined();
    await expect(start([])).resolves.toBeUndefined();
  });
});

/**
 * Vite's trailing-slash rule is **conditional on both sides**, and comparing the two halves
 * independently is wider than Vite — which merges two genuinely different aliases.
 *
 * The rule, already pinned elsewhere in this file by
 * `does not normalize a slash on find alone, since Vite does not either`: `{ find: "foo/",
 * replacement: "/a" }` is **not** normalized, and is therefore a different pattern from
 * `{ find: "foo", replacement: "/a" }` — the first matches nothing, the second matches `foo/x`.
 *
 * Measured with the project declaring the inert form and a later plugin adding the active one:
 *
 * | alias | Vite resolves `some-unrelated/thing` to |
 * | --- | --- |
 * | project: `{ find: "some-unrelated/", replacement: "/local-copy" }` | unresolved (matches nothing) |
 * | plus a later plugin: `{ "some-unrelated": "/local-copy" }` | `/local-copy/thing` |
 *
 * Trimming each side unconditionally made `some-unrelated/` and `some-unrelated` compare equal, so
 * the plugin's entry was accepted as the project's own and nothing was reported — while dev
 * resolution had in fact changed.
 */
describe("the alias comparison follows Vite's pair-wise slash rule", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function start(
    extra: readonly unknown[],
    userAlias?: unknown,
  ): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      ...(userAlias === undefined ? {} : { resolve: { alias: userAlias as never } }),
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a later plugin that adds the active form of an inert one-sided-slash alias", async () => {
    const inert = [{ find: "some-unrelated/", replacement: "/local-copy" }];
    const latePlugin = {
      name: "late-active-alias",
      config() {
        return { resolve: { alias: { "some-unrelated": "/local-copy" } } };
      },
    };

    await expect(start([latePlugin], inert)).rejects.toThrowError(/refused to start/);
  });

  it("still accepts a project alias that writes a trailing slash on both sides, in either form", async () => {
    // Vite strips both slashes, so the merged entry is `react -> /project-owned/react`; the project's
    // declaration must normalize the same way or a correctly-declared alias is refused. Both alias
    // forms are asserted because the object form was where the key was stripped without the value.
    await expect(
      start([], [{ find: "react/", replacement: "/project-owned/react/" }]),
    ).resolves.toBeUndefined();
    await expect(start([], { "react/": "/project-owned/react/" })).resolves.toBeUndefined();
  });

  it("still accepts a project's inert one-sided-slash alias when nothing else adds to it", async () => {
    // The counterpart: the inert form is a legitimate (if pointless) declaration, and only a
    // *different* entry behind it is a problem.
    await expect(
      start([], [{ find: "some-unrelated/", replacement: "/local-copy" }]),
    ).resolves.toBeUndefined();
  });
});

/**
 * A declaration reaches the final alias list through **two** normalizations, not one.
 *
 * `normalizeSingleAlias` removes a *single* trailing `/` from each side — Vite's rule, copied in
 * `normalizeAliasFind`. But a declaration is normalized once when Vite reads the config and again
 * when `normalizeAlias` normalizes the **merged** array, so a `//` loses both. Measured against
 * Vite 8.3.0:
 *
 * | declaration | appears in `config.resolve.alias` as |
 * | --- | --- |
 * | `{ "nm//": "/x//" }` | `nm -> /x` |
 * | `{ "nm///": "/x///" }` | `nm/ -> /x/` |
 * | `{ "nm//": "/x/" }` | `nm/ -> /x/` |
 * | `{ "nm//": "/x" }` | unchanged — one side has no slash, so neither is stripped |
 *
 * Comparing against a single normalization makes the project's declaration disagree with Vite's own
 * output for it, which is how a later plugin's genuinely different entry gets accepted as the
 * project's own.
 *
 * The **final list is read unnormalized** for the mirror-image reason: Vite already produced it, and
 * normalizing again would move it one step further from what the resolver actually uses.
 */
describe("the declaration is normalized to Vite's merged form, not once", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function start(extra: readonly unknown[], userAlias?: unknown): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      ...(userAlias === undefined ? {} : { resolve: { alias: userAlias as never } }),
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("accepts a repeated-slash declaration when the later plugin adds nothing new", async () => {
    // Measured, and this is the finding's counter-example **not** being a divergence after all.
    // The project's own `{ find: "some-unrelated//", replacement: "/local-copy//" }` already
    // resolves `some-unrelated/thing` to `/local-copy/thing` in Vite — with or without the plugin
    // (both measured to the same id). So a plugin contributing that entry changes nothing, and
    // refusing it would be an over-refusal.
    //
    // It is asserted rather than left implicit because it looks like a bypass and is not: Vite
    // normalizes a declaration twice on its way into the merged list, so `//` is reduced to nothing
    // and the project's entry becomes the same `some-unrelated -> /local-copy` the plugin adds.
    const lateNoop = {
      name: "late-noop-alias",
      config() {
        return { resolve: { alias: { "some-unrelated": "/local-copy" } } };
      },
    };

    await expect(
      start([lateNoop], [{ find: "some-unrelated//", replacement: "/local-copy//" }]),
    ).resolves.toBeUndefined();
  });

  it("still refuses the single-slash declaration beside an active plugin alias", async () => {
    // The contrast that makes the previous test meaningful: with one slash the project's own entry
    // matches nothing, so the plugin's entry *is* the thing that changes dev resolution.
    const lateActive = {
      name: "late-active-alias",
      config() {
        return { resolve: { alias: { "some-unrelated": "/local-copy" } } };
      },
    };

    await expect(
      start([lateActive], [{ find: "some-unrelated/", replacement: "/local-copy" }]),
    ).rejects.toThrowError(/refused to start/);
  });
});

/**
 * The single-slash rule is distinguishable from a trim-all rule only at **three or more** slashes.
 *
 * Vite removes exactly one trailing `/` per normalization pass, and a declaration is normalized
 * twice on its way into the merged list, so the two rules converge for one and two slashes — which
 * is why an earlier version of this fix could not be told apart from the wrong one by those cases.
 * They diverge from three:
 *
 * | declaration | after Vite's two passes |
 * | --- | --- |
 * | `{ "nm/": "/x/" }` | `nm -> /x` |
 * | `{ "nm//": "/x//" }` | `nm -> /x` |
 * | `{ "nm///": "/x///" }` | `nm/ -> /x/` (measured) |
 * | `{ "nm////": "/x////" }` | `nm// -> /x//` (measured) |
 *
 * A trim-all rule collapses the last two to `nm -> /x`, which Vite does not produce — and once the
 * project's entry is collapsed that far it can coincide with a later plugin's genuinely different
 * entry, which is the class of false negative the subtraction exists to prevent.
 */
describe("the alias rule removes exactly one trailing slash, as Vite does", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function start(userAlias: unknown, extra: readonly unknown[] = []): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      resolve: { alias: userAlias as never },
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a later plugin beside a three-slash declaration, which Vite keeps distinct", async () => {
    // The case that separates the two rules. Vite keeps one slash here (`some-unrelated/ ->
    // /local-copy/`), while a trim-all rule would collapse it to `some-unrelated -> /local-copy` —
    // indistinguishable from the plugin's entry, so the plugin's contribution would be accepted as
    // the project's own.
    const lateSameKey = {
      name: "late-same-key",
      config() {
        return { resolve: { alias: { "some-unrelated": "/local-copy" } } };
      },
    };

    // `createServer` itself is where the refusal happens, so the expectation is on that call and
    // there is no server to close — which is also why every other test in this file closes in a
    // `finally` and this one cannot.
    await expect(
      createServer({
        root: reRoot,
        configFile: false,
        logLevel: "error",
        appType: "spa",
        resolve: { alias: [{ find: "some-unrelated///", replacement: "/local-copy///" }] as never },
        plugins: [devHarness({ config: registry() }) as never, lateSameKey as never],
        server: { middlewareMode: true, hmr: false, watch: null },
      }),
    ).rejects.toThrowError(/refused to start/);
  });

  it("accepts one- and two-slash declarations, where the two rules agree", async () => {
    // The cases that cannot tell the rules apart, pinned so a future simplification to trim-all
    // is not mistaken for a behaviour change.
    await expect(start([{ find: "react/", replacement: "/project-owned/react/" }])).resolves.toBeUndefined();
    await expect(start([{ find: "react//", replacement: "/project-owned/react//" }])).resolves.toBeUndefined();
  });
});

/**
 * A declaration reaches the final alias list through **two** normalizations, and getting that
 * count wrong is what round 11 turned on.
 *
 * Vite's `normalizeSingleAlias` removes a single trailing `/` from each side, only when both carry
 * one — and it runs on the config's own alias *and* again on the merged array
 * (`normalizeAlias(mergeAlias(...))`). Measured against Vite 8.3.0:
 *
 * | declaration | appears in `config.resolve.alias` as |
 * | --- | --- |
 * | `{ "nm/": "/x/" }` | `nm -> /x` |
 * | `{ "nm//": "/x//" }` | `nm -> /x` |
 * | `{ "nm///": "/x///" }` | `nm/ -> /x/` |
 * | `{ "nm//": "/x" }` | unchanged — one side has no slash, so neither is stripped |
 *
 * The last row is the rule that round 10 was about and is unchanged: a one-sided slash is inert.
 */

/**
 * "This key is not one of ours" must not be spelled the same way as "ours, with an empty target".
 *
 * The harness-owned comparison reads `harnessOwned[find]` to build the entry it expects. An earlier
 * version wrote `harnessOwned[find] ?? ""`, so a key that is **not** in the map produced a
 * well-formed entry with an empty replacement — and any later plugin whose entry had the same empty
 * replacement matched it exactly and was accepted.
 *
 * The case is not a no-op alias. `@rollup/plugin-alias` applies `importee.replace(find, replacement)`
 * to a match, so `{ "@app/shared": "" }` rewrites `@app/shared/thing` to `/thing` (measured) before
 * the harness's own project-alias `resolveId` runs, while the Cell build keeps `./shared/thing`.
 */
describe("an unknown key is absent, not an empty replacement", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function startWith(extra: readonly unknown[]): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a later plugin that adds an empty replacement for a project alias", async () => {
    const lateEmpty = {
      name: "late-empty-alias",
      config() {
        return { resolve: { alias: { "@app/shared": "" } } };
      },
    };

    await expect(startWith([lateEmpty])).rejects.toThrowError(/refused to start/);
  });

  it("refuses an empty replacement for a key the harness does not own either", async () => {
    // Neither Vite's own entries nor the harness's produce an empty replacement, so there is no
    // legitimate contribution this could be — the check must not depend on the key being a *project*
    // alias to reject it.
    const lateUnrelated = {
      name: "late-empty-unrelated",
      config() {
        return { resolve: { alias: { "never-declared-anywhere": "" } } };
      },
    };

    await expect(startWith([lateUnrelated])).rejects.toThrowError(/refused to start/);
  });

  it("still accepts the harness's own and the project's own entries", async () => {
    await expect(startWith([])).resolves.toBeUndefined();
  });
});

/**
 * `resolve.alias[].customResolver` is a resolver **function**, and `find + replacement` cannot
 * describe it.
 *
 * Vite 8.3.0 (the version this repository pins) still honours it: its alias plugin reads the final
 * `config.resolve.alias`, and an entry carrying a `customResolver` is dispatched to that resolver
 * function instead of continuing through ordinary `replacement` resolution. So an entry is not
 * identified by its two string halves alone.
 *
 * Measured construction — a later plugin repeating the harness's **own** `react` find *and*
 * replacement and adding only a resolver:
 *
 * | | result |
 * | --- | --- |
 * | Vite resolves `react` to | `/local-copy/react` (the resolver's answer) |
 * | the Cell artifact | the host bridge's page `React` |
 * | harness before this change | started, reporting nothing |
 *
 * Two functions cannot be compared for behavioural equality, so the sound answer is to **refuse**
 * rather than to guess — which is also the reviewer's second option and the first one's practical
 * form. The `hasCustomResolver` flag is what lets the check answer; keeping the function would only
 * invite a comparison that cannot be sound.
 */
describe("an alias carrying a `customResolver` is refused", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  async function startWith(extra: readonly unknown[]): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses a resolver that repeats the harness's own find and replacement", async () => {
    // The sharpest form: nothing about the entry's text differs from a known contribution, so only
    // recording that a resolver is present can tell the two apart.
    const harnessReactTarget = hostModuleAliases().react;
    const lateResolver = {
      name: "late-react-resolver",
      config() {
        return {
          resolve: {
            alias: [
              {
                find: "react",
                replacement: harnessReactTarget,
                customResolver() {
                  return "/local-copy/react";
                },
              },
            ],
          },
        };
      },
    };

    await expect(startWith([lateResolver])).rejects.toThrowError(/refused to start/);
  });

  it("refuses a resolver on a project alias too", async () => {
    const lateProjectResolver = {
      name: "late-project-resolver",
      config() {
        return {
          resolve: {
            alias: [
              {
                find: "@app/shared",
                replacement: "/abs/shared",
                customResolver() {
                  return "/local-copy/shared";
                },
              },
            ],
          },
        };
      },
    };

    // `createServer` itself is where the refusal happens, so the expectation is on that call and
    // there is no server left to close.
    await expect(
      createServer({
        root: reRoot,
        configFile: false,
        logLevel: "error",
        appType: "spa",
        resolve: { alias: { "@app/shared": "./shared" } },
        plugins: [devHarness({ config: registry() }) as never, lateProjectResolver as never],
        server: { middlewareMode: true, hmr: false, watch: null },
      }),
    ).rejects.toThrowError(/refused to start/);
  });

  it("still starts for the harness's own entries, which carry no resolver", async () => {
    // The control: `hostModuleAliases()` produces plain find/replacement pairs, and the check must
    // not read "no resolver" as "not one of ours".
    await expect(startWith([])).resolves.toBeUndefined();
  });
});

/**
 * `customResolver` has **two** forms, and round 13 recognised only one.
 *
 * Vite 8.3.0 types the field as `ResolverFunction | ResolverObject | null` and its runtime agrees:
 *
 * ```js
 * function resolveCustomResolver(customResolver) {
 *   if (typeof customResolver === "function") return customResolver;
 *   if (customResolver) return getHookFunction(customResolver.resolveId);
 *   return null;
 * }
 * ```
 *
 * So `{ resolveId() { … } }` is a resolver too, and the round-13 bypass survived by writing the same
 * entry with only the spelling changed. Measured: a later plugin repeating the harness's own `react`
 * find *and* replacement with `customResolver: { resolveId }` added resolved `react` to
 * `/local-copy/react`, while the artifact kept the host bridge's page `React`.
 *
 * Both forms are refused, and the two values Vite itself reduces to "no resolver" — `null` and a
 * `customResolver` with no `resolveId` — stay accepted, because refusing them would be a false
 * positive on a config Vite handles exactly as a plain entry.
 */
describe("both forms of `customResolver` are refused", () => {
  const reRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "project-alias");

  function registry() {
    return createCellRegistry(
      {
        cells: { probe: { entry: "./cells/probe/src/index.ts", target: { pageName: "探针", cell: "A1" } } },
        resolve: { alias: { "@app/shared": "./shared" } },
      },
      { root: reRoot },
    );
  }

  /** A later plugin repeating the harness's own entry with `customResolver` in the given form. */
  function laterResolver(customResolver: unknown) {
    return {
      name: "late-react-resolver",
      config() {
        return {
          resolve: {
            alias: [
              { find: "react", replacement: hostModuleAliases().react, customResolver: customResolver },
            ],
          },
        };
      },
    };
  }

  async function startWith(extra: readonly unknown[]): Promise<void> {
    const server = await createServer({
      root: reRoot,
      configFile: false,
      logLevel: "error",
      appType: "spa",
      plugins: [devHarness({ config: registry() }) as never, ...(extra as never[])],
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    await server.close();
  }

  it("refuses the object form, which the round-13 check read as absent", async () => {
    await expect(
      startWith([laterResolver({ resolveId: () => "/local-copy/react" })]),
    ).rejects.toThrowError(/refused to start/);
  });

  it("refuses the function form, which round 13 already caught", async () => {
    await expect(startWith([laterResolver(() => "/local-copy/react")])).rejects.toThrowError(
      /refused to start/,
    );
  });

  it("still accepts the two values Vite reduces to no resolver", async () => {
    // `resolveCustomResolver` returns `null` for both, so treating them as a resolver would refuse
    // a config Vite handles exactly as a plain entry.
    await expect(startWith([laterResolver(null)])).resolves.toBeUndefined();
    await expect(startWith([laterResolver({})])).resolves.toBeUndefined();
    await expect(startWith([])).resolves.toBeUndefined();
  });
});
