/**
 * Locating an installed package by identity, under the conditions the install
 * graph actually has (#89).
 *
 * Decision source: GitHub Issue #89 — "修复 Probe：正确定位 import-only ESM 与隐藏
 * package.json 的包"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/89
 *
 * Governing Specs: #16 (the evidence must be about one artifact), #8 (the same
 * identity the lock's `resolvedVersion` records).
 *
 * **These tests exist because the defect was invisible to every assertion the
 * repository already had.** The old two-attempt `require.resolve` loop was not
 * *wrong* about any package the fixtures contained — every committed fixture
 * publishes a `require`-visible entry, so both attempts succeeded and the suite
 * stayed green while the probe reported real import-only packages as
 * not-installed. The fixture this file drives (`import-only-esm`) is the missing
 * input, and each assertion below names the resolver call it replaces so a future
 * reader can see which spelling of a package the old code could not answer.
 *
 * Local checks only. Node 24 is the version the repository requires
 * (`engines.node >= 24`); the resolver behaviour asserted here is Node's, not
 * Forguncy's, and this is not a runtime-compatibility claim.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { locatePackage } from "./package-locator.ts";

const FIXTURES_ROOT = fileURLToPath(new URL("./__fixtures__/probe", import.meta.url));

function fixture(name: string): string {
  return join(FIXTURES_ROOT, name);
}

/** The base every probe resolves from: the consuming project's own manifest. */
function baseOf(name: string): string {
  return join(fixture(name), "package.json");
}

async function located(name: string, request: string): Promise<Awaited<ReturnType<typeof locatePackage>>> {
  return locatePackage(baseOf(name), request);
}

describe("locatePackage: identity is not the entry question", () => {
  it("locates a package whose exports publishes only an `import` branch", async () => {
    // The defect: `require.resolve("import-only-lib")` and
    // `require.resolve("import-only-lib/package.json")` both answer
    // ERR_PACKAGE_PATH_NOT_EXPORTED, because a `require` resolver does not activate
    // the `import` condition — while `import(...)` and rolldown both load it.
    const result = await located("import-only-esm", "import-only-lib");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.name).toBe("import-only-lib");
    expect(result.package.version).toBe("3.2.1");
    expect(result.package.directory).toBe(join(fixture("import-only-esm"), "node_modules", "import-only-lib"));
  });

  it("locates a package whose exports has no `.` entry at all", async () => {
    // `subpath-only-lib` publishes only `./only`, so there is no root entry for any
    // resolver to return and both old attempts failed. The artifact is installed and
    // identifiable regardless — which is the whole reason identity and entry are
    // separate questions.
    const result = await located("import-only-esm", "subpath-only-lib");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.name).toBe("subpath-only-lib");
    expect(result.package.version).toBe("4.0.0");
  });

  it("locates a subpath request as the package that provides it", async () => {
    // `react/jsx-runtime` is not a package; its version is React's. The locator
    // answers for the owning package, and the *specifier* is what the build step
    // resolves — see the build test below, which is where a non-exported subpath
    // must fail.
    const result = await located("import-only-esm", "subpath-only-lib/only");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.name).toBe("subpath-only-lib");
    expect(result.package.version).toBe("4.0.0");
  });

  it("returns the package root when the entry sits behind a nameless nested manifest", async () => {
    // `nested-marker`'s entry is `dist/esm/index.js`, beside a `{"type":"module"}`
    // marker that declares no `name`. Both consumers used to hand-roll a
    // climb-to-the-first-named-manifest for this; the host primitive answers the
    // root directly, so the climb is gone rather than duplicated.
    const result = await located("import-only-esm", "nested-marker");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.directory).toBe(join(fixture("import-only-esm"), "node_modules", "nested-marker"));
    expect(result.package.version).toBe("15.0.3");
  });

  it("locates a strict exports map that hides its own package.json", async () => {
    const result = await located("import-only-esm", "sealed-root");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.name).toBe("sealed-root");
    expect(result.package.version).toBe("5.1.0");
  });
});

describe("locatePackage: failure stays a specific failure", () => {
  it("reports a name nothing answers as not-installed", async () => {
    const result = await located("import-only-esm", "definitely-not-installed");

    expect(result).toEqual({ outcome: "failed", reason: "not-installed" });
  });

  it("reports a manifest that is not readable JSON as manifest-unreadable, not not-installed", async () => {
    // Reachable for the first time. The climb this replaced swallowed a JSON parse
    // failure and kept walking, so a corrupt package root was reported as
    // not-installed — the install graph blamed for a file that is present and
    // broken. Those are different fixes and must not be one answer.
    const result = await located("import-only-esm", "unreadable-manifest");

    expect(result).toEqual({ outcome: "failed", reason: "manifest-unreadable" });
  });

  it("reports a directory that is not a package as not-installed, as Node does", async () => {
    // Node itself refuses a manifestless directory (`import("some-dir")` answers
    // ERR_MODULE_NOT_FOUND), so this is the host's own answer rather than a
    // locally-invented reason.
    const root = await mkdtemp(join(tmpdir(), "fgc-locator-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", version: "0.0.0" }), "utf8");
    await mkdir(join(root, "node_modules", "not-a-package"), { recursive: true });

    const result = await locatePackage(join(root, "package.json"), "not-a-package");

    expect(result).toEqual({ outcome: "failed", reason: "not-installed" });
  });
});

describe("locatePackage: the located directory is the one the bundler reports", () => {
  /**
   * A realistic pnpm layout: the package lives under `node_modules/.pnpm/<id>/node_modules/`
   * and a link at `node_modules/<name>` points at it.
   *
   * The link is created as a **junction**, which is the one type Windows allows without
   * elevation; Node ignores the type argument on POSIX, where it is an ordinary directory
   * symlink. So this is one code path on both platforms rather than a Windows-only branch.
   */
  async function pnpmProject(): Promise<{ root: string; store: string }> {
    const root = await mkdtemp(join(tmpdir(), "fgc-locator-pnpm-"));
    const store = join(root, "node_modules", ".pnpm", "linked-lib@2.0.0", "node_modules", "linked-lib");
    await mkdir(store, { recursive: true });
    await writeFile(
      join(store, "package.json"),
      JSON.stringify({ name: "linked-lib", version: "2.0.0", type: "module", exports: { ".": { import: "./index.js" } } }),
      "utf8",
    );
    await writeFile(join(store, "index.js"), "export const x = 1;\n", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pnpm-proj", version: "0.0.0" }), "utf8");
    await symlink(store, join(root, "node_modules", "linked-lib"), "junction");
    return { root, store };
  }

  it("reports the realpath of a linked package, not the link", async () => {
    // Load-bearing, and measured rather than assumed. `findPackageJSON` answers through
    // the link, while rolldown reports module ids as **realpaths** — measured on this
    // layout, the bundler's id was the `.pnpm` store path. The probe's scanners bound
    // their work by `isInside(identity.directory, moduleId)`, so a link-shaped directory
    // matches nothing: every file is skipped, and a package calling `process.dlopen`
    // reported `signal.no-node-builtins: true` with **no rejection filed**. A false
    // negative drawn from an empty set, which is the failure class #16 exists to remove.
    const { root, store } = await pnpmProject();

    const result = await locatePackage(join(root, "package.json"), "linked-lib");

    expect(result.outcome).toBe("located");
    if (result.outcome !== "located") return;
    expect(result.package.name).toBe("linked-lib");
    expect(result.package.directory).toBe(await realpath(store));
  });

  it("resolves a linked package's own dependency from the link, as Node does", async () => {
    // Node resolves a package's dependencies from the package's location, and for a
    // pnpm install that means *through the link* — the store directory's sibling
    // `node_modules`. The locator answers the same way, so the transitive walk sees the
    // graph the bundler sees rather than the store's own tree.
    const { root, store } = await pnpmProject();
    const inner = join(root, "node_modules", ".pnpm", "inner@1.0.0", "node_modules", "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(
      join(inner, "package.json"),
      JSON.stringify({ name: "inner", version: "1.0.0", type: "module", exports: { ".": { import: "./i.js" } } }),
      "utf8",
    );
    await writeFile(join(inner, "i.js"), "export const i = 1;\n", "utf8");
    await symlink(inner, join(dirname(store), "inner"), "junction");

    // The base is the linked package's *manifest as located* — its realpath — which is
    // exactly what the transitive walk passes.
    const located = await locatePackage(join(root, "package.json"), "linked-lib");
    expect(located.outcome).toBe("located");
    if (located.outcome !== "located") return;

    const dep = await locatePackage(join(located.package.directory, "package.json"), "inner");

    expect(dep.outcome).toBe("located");
    if (dep.outcome !== "located") return;
    expect(dep.package.version).toBe("1.0.0");
  });
});

describe("locatePackage: identity is not faked from outside the consuming project", () => {
  it("does not answer for a package that is not installed anywhere in scope", async () => {
    // The property #89 states as "不读取消费项目外无关目录来伪造包身份". A package that
    // exists only in *this* workspace must not be reported as installed in the
    // fixture project that does not install it — the fixture's ancestor
    // `node_modules` walk does reach this repository's own tree, so the assertion
    // that matters is that a name this repository installs is still refused when
    // the fixture does not have it.
    //
    // The old code leaked exactly here: `require.resolve` appends every
    // `Module.globalPaths` entry, and the test runner injects `NODE_PATH` entries
    // pointing into this workspace's pnpm store — measured, `resolveInstalledVersions`
    // of a temp project answered `vitest@4.1.11`. `findPackageJSON` never consults
    // `NODE_PATH`, so the answer is now the scope's own.
    const root = await mkdtemp(join(tmpdir(), "fgc-locator-scope-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "scoped", version: "0.0.0" }), "utf8");

    const result = await locatePackage(join(root, "package.json"), "vitest");

    expect(result).toEqual({ outcome: "failed", reason: "not-installed" });
  });
});
