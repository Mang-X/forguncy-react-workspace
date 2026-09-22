import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ForguncyConfigError } from "./cell-registry";
import {
  findForguncyConfigFile,
  importForguncyConfigModule,
  loadForguncyConfig,
} from "./config-loader";
import type { ForguncyConfigModuleLoader } from "./config-loader";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const validMultiRoot = join(fixturesRoot, "valid-multi");
const untypedRoot = join(fixturesRoot, "untyped");
const invalidTargetRoot = join(fixturesRoot, "invalid-target");
const missingEntryRoot = join(fixturesRoot, "missing-entry-file");

const scratchDirs: string[] = [];

function scratchDir(): string {
  const path = mkdtempSync(join(tmpdir(), "fgc-config-"));
  scratchDirs.push(path);
  return path;
}

afterAll(() => {
  for (const path of scratchDirs) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function captureLoadError(run: () => Promise<unknown>): Promise<ForguncyConfigError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ForguncyConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a ForguncyConfigError, but nothing was thrown.");
}

describe("finding the config file", () => {
  it("prefers forguncy.config.ts in the project root", () => {
    expect(findForguncyConfigFile({ root: validMultiRoot })).toBe(join(validMultiRoot, "forguncy.config.ts"));
  });

  it("falls back to the other candidate extensions", () => {
    expect(findForguncyConfigFile({ root: untypedRoot })).toBe(join(untypedRoot, "forguncy.config.mjs"));
  });

  it("accepts an explicitly requested file, absolute or root-relative", () => {
    const relative = findForguncyConfigFile({ root: validMultiRoot, configFile: "forguncy.config.ts" });
    const absolute = findForguncyConfigFile({
      root: validMultiRoot,
      configFile: join(validMultiRoot, "forguncy.config.ts"),
    });

    expect(relative).toBe(absolute);
  });

  it("reports nothing when the project has no config yet", () => {
    expect(findForguncyConfigFile({ root: scratchDir() })).toBeUndefined();
    expect(findForguncyConfigFile({ root: validMultiRoot, configFile: "missing.config.ts" })).toBeUndefined();
  });
});

describe("loading a project config", () => {
  // This is the end-to-end path: a real forguncy.config.ts on disk, imported by the
  // runtime's own ESM loader, normalized into the registry every consumer shares.
  it("loads the default forguncy.config.ts and normalizes it into a registry", async () => {
    const registry = await loadForguncyConfig({ root: validMultiRoot });

    expect(registry.configPath).toBe(join(validMultiRoot, "forguncy.config.ts"));
    expect(registry.cellIds).toEqual(["orderList", "orderBoard", "customerDetail"]);
    expect(registry.require("orderBoard").target.cell).toBe("D4");
    expect(registry.require("orderBoard").target.locatorKey).toBe("销售订单#D4");
    expect(registry.require("customerDetail").target.pageName).toBe("客户详情");
    expect(registry.root).toBe(validMultiRoot);
  });

  it("does not trust a config just because a .ts config would have been typed", async () => {
    // The fixture is a .mjs module containing an absolute entry, a secret-bearing
    // field and a dependency-strategy decision. All three must be reported.
    const error = await captureLoadError(() => loadForguncyConfig({ root: untypedRoot }));

    expect(error.codes).toContain("machine-specific-path");
    expect(error.codes).toContain("secret-looking-field");
    expect(error.codes).toContain("dependency-decision-in-config");
    expect(error.message).toContain(join(untypedRoot, "forguncy.config.mjs"));
  });

  it("normalizes through the same path as every other consumer", async () => {
    // Reading from disk and being handed the document by a host loader must not be
    // two implementations that can drift: both have to produce one registry.
    const document = await import(pathToFileURL(join(validMultiRoot, "forguncy.config.ts")).href);
    const fromFile = await loadForguncyConfig({ root: validMultiRoot });
    const fromHostLoader = await loadForguncyConfig({ root: validMultiRoot, loadModule: () => document });

    expect(fromHostLoader.cells).toEqual(fromFile.cells);
    expect(fromHostLoader.runtime).toEqual(fromFile.runtime);
    expect(fromHostLoader.targetLocatorModel).toBe(fromFile.targetLocatorModel);
  });

  it("fails a declared entry that does not exist, before anything is compiled", async () => {
    const error = await captureLoadError(() => loadForguncyConfig({ root: missingEntryRoot }));

    expect(error.codes).toEqual(["missing-entry-file"]);
  });

  it("surfaces target-validation failures with the config path as context", async () => {
    const error = await captureLoadError(() => loadForguncyConfig({ root: invalidTargetRoot }));

    expect(error.codes).toContain("invalid-target-cell");
    expect(error.message).toContain(join(invalidTargetRoot, "forguncy.config.ts"));
  });

  it("reports a missing config file together with the names it searched", async () => {
    const root = scratchDir();
    const error = await captureLoadError(() => loadForguncyConfig({ root }));

    expect(error.codes).toEqual(["config-file-not-found"]);
    expect(error.message).toContain("forguncy.config.ts");
    expect(error.message).toContain("forguncy.config.mjs");
    expect(error.message).toContain(root);
  });

  it("says which file it looked for when the request was explicit", async () => {
    const error = await captureLoadError(() => loadForguncyConfig({ root: validMultiRoot, configFile: "nope.ts" }));

    expect(error.codes).toEqual(["config-file-not-found"]);
    expect(error.message).toContain("explicitly requested");
  });

  it("requires an absolute project root", async () => {
    const error = await captureLoadError(() => loadForguncyConfig({ root: "./relative" }));

    expect(error.codes).toEqual(["invalid-project-root"]);
  });

  it("does not validate the filesystem when the caller opts out", async () => {
    const registry = await loadForguncyConfig({ root: missingEntryRoot, requireEntryFiles: false });

    expect(registry.cellIds).toEqual(["orderList"]);
    expect(registry.require("orderList").entryPath).toBe(
      join(missingEntryRoot, "cells", "order-list", "src", "index.ts"),
    );
  });
});

describe("loading through a host-supplied module loader", () => {
  it("hands the resolved absolute path to the loader", async () => {
    const seen: string[] = [];
    const loadModule: ForguncyConfigModuleLoader = configFile => {
      seen.push(configFile);
      return { default: { cells: {} } };
    };

    await loadForguncyConfig({ root: validMultiRoot, loadModule });

    // The seam is the point: a host with its own config loader (Vite+'s
    // loadConfigFromFile, say) supplies it instead of this package inventing one.
    expect(seen).toEqual([join(validMultiRoot, "forguncy.config.ts")]);
    expect(importForguncyConfigModule).toBeTypeOf("function");
  });

  it("reports a config module that throws, instead of a bare stack trace", async () => {
    const error = await captureLoadError(() =>
      loadForguncyConfig({
        root: validMultiRoot,
        loadModule: () => {
          throw new Error("boom");
        },
      }),
    );

    expect(error.codes).toEqual(["config-load-failed"]);
    expect(error.message).toContain("boom");
  });

  it("requires a default export", async () => {
    const error = await captureLoadError(() =>
      loadForguncyConfig({ root: validMultiRoot, loadModule: () => ({ cells: {} }) }),
    );

    expect(error.codes).toEqual(["config-missing-default-export"]);
    expect(error.message).toContain("default export");
  });

  it("rejects a function default export rather than guessing an environment", async () => {
    const error = await captureLoadError(() =>
      loadForguncyConfig({ root: validMultiRoot, loadModule: () => ({ default: () => ({ cells: {} }) }) }),
    );

    expect(error.codes).toEqual(["config-not-an-object"]);
    expect(error.message).toContain("vite.config.ts");
  });

  it("reports a module that exports nothing usable", async () => {
    const error = await captureLoadError(() =>
      loadForguncyConfig({ root: validMultiRoot, loadModule: () => null }),
    );

    expect(error.codes).toEqual(["config-missing-default-export"]);
  });
});

describe("scratch config directories", () => {
  it("loads a config written at test time, with entries relative to the root", async () => {
    const root = scratchDir();
    writeFileSync(join(root, "cell.ts"), "export const cell = 1;\n");
    writeFileSync(
      join(root, "forguncy.config.mjs"),
      ['export default { cells: { scratch: { entry: "./cell.ts", target: { pageName: "临时页", cell: "C3" } } } };'].join(
        "\n",
      ),
    );

    const registry = await loadForguncyConfig({ root });

    expect(registry.require("scratch").entryPath).toBe(resolve(root, "cell.ts"));
    expect(registry.require("scratch").target.locatorKey).toBe("临时页#C3");
  });

  it("sees an edited config on the next load, even in one long-lived process", async () => {
    // The freshness contract: native `import()` caches by URL, so without
    // content-stamped loading a watch-mode CLI or the MCP server would keep
    // syncing to the target the config had on first load.
    const root = scratchDir();
    writeFileSync(join(root, "cell.ts"), "export const cell = 1;\n");
    const configPath = join(root, "forguncy.config.mjs");
    writeFileSync(
      configPath,
      'export default { cells: { scratch: { entry: "./cell.ts", target: { pageName: "旧页", cell: "A1" } } } };\n',
    );

    const first = await loadForguncyConfig({ root });
    expect(first.require("scratch").target.locatorKey).toBe("旧页#A1");

    writeFileSync(
      configPath,
      'export default { cells: { scratch: { entry: "./cell.ts", target: { pageName: "新页", cell: "B2" } } } };\n',
    );

    const second = await loadForguncyConfig({ root });
    expect(second.require("scratch").target.locatorKey).toBe("新页#B2");
  });

  it("reuses the cached module when the config's bytes have not changed", async () => {
    // The other half of the freshness contract: stamping must not turn every
    // load into a fresh evaluation, or an unchanged config would re-run its
    // module body on every call.
    const global = globalThis as { __fgcLoadCount?: number };
    delete global.__fgcLoadCount;
    const source =
      'globalThis.__fgcLoadCount = (globalThis.__fgcLoadCount ?? 0) + 1;\nexport default { cells: {} };\n';
    const root = scratchDir();
    writeFileSync(join(root, "forguncy.config.mjs"), source);

    await loadForguncyConfig({ root });
    const countAfterFirst = global.__fgcLoadCount;
    await loadForguncyConfig({ root });

    expect(countAfterFirst).toBe(1);
    expect(global.__fgcLoadCount).toBe(1);
    delete global.__fgcLoadCount;
  });
});

describe("the freshness boundary: what the default loader does not cover", () => {
  // The default loader stamps the config file's own bytes. A module the config
  // *imports* keeps its own URL, so native ESM caching means an edit to that
  // module is invisible: the config's hash has not changed, and the child is
  // reused from cache. This pair of tests pins both halves of the narrowed
  // contract — the default loader's scope stops at the config file, and a host
  // that supplies a graph-reloading `loadModule` observes the whole graph.
  function writeSplitProject(root: string): void {
    writeFileSync(join(root, "cell.ts"), "export const cell = 1;\n");
    writeFileSync(
      join(root, "cells.mjs"),
      'export const cells = { scratch: { entry: "./cell.ts", target: { pageName: "旧页", cell: "A1" } } };\n',
    );
    writeFileSync(
      join(root, "forguncy.config.mjs"),
      'import { cells } from "./cells.mjs";\nexport default { cells };\n',
    );
  }

  it("does not observe an edit to a module the config imports — the documented default scope", async () => {
    const root = scratchDir();
    writeSplitProject(root);

    const first = await loadForguncyConfig({ root });
    expect(first.require("scratch").target.locatorKey).toBe("旧页#A1");

    writeFileSync(
      join(root, "cells.mjs"),
      'export const cells = { scratch: { entry: "./cell.ts", target: { pageName: "新页", cell: "B2" } } };\n',
    );

    // Stale on purpose: this is exactly why the contract says a long-lived host
    // whose config imports project files must pass its own `loadModule`. If
    // this assertion ever flips, Node's caching model changed and the contract
    // should be revisited — not the assertion deleted.
    const second = await loadForguncyConfig({ root });
    expect(second.require("scratch").target.locatorKey).toBe("旧页#A1");
  });

  it("observes an edit to an imported module when the host supplies a graph-reloading loader", async () => {
    // A stand-in for a host with a real config loader (Vite+'s
    // `loadConfigFromFile` bundles its graph this way): rewrite each relative
    // import with a content stamp of the file it points at, evaluate the result
    // from a content-addressed sibling, and the whole one-level graph reloads
    // when any of its files change — while an unchanged graph stays cached.
    const graphReloadingLoader: ForguncyConfigModuleLoader = configFile => {
      const dir = dirname(configFile);
      const source = readFileSync(configFile, "utf8").replace(
        /(from\s+["'])(\.[^"']+)(["'])/g,
        (match, prefix: string, spec: string, suffix: string) => {
          try {
            const stamp = createHash("sha256")
              .update(readFileSync(resolve(dir, spec)))
              .digest("hex")
              .slice(0, 16);
            return `${prefix}${spec}?t=${stamp}${suffix}`;
          } catch {
            return match;
          }
        },
      );
      const contentAddressed = join(
        dir,
        `.graph-${createHash("sha256").update(source).digest("hex").slice(0, 16)}-${basename(configFile)}`,
      );
      writeFileSync(contentAddressed, source);
      return import(pathToFileURL(contentAddressed).href);
    };

    const root = scratchDir();
    writeSplitProject(root);

    const first = await loadForguncyConfig({ root, loadModule: graphReloadingLoader });
    expect(first.require("scratch").target.locatorKey).toBe("旧页#A1");

    writeFileSync(
      join(root, "cells.mjs"),
      'export const cells = { scratch: { entry: "./cell.ts", target: { pageName: "新页", cell: "B2" } } };\n',
    );

    const second = await loadForguncyConfig({ root, loadModule: graphReloadingLoader });
    expect(second.require("scratch").target.locatorKey).toBe("新页#B2");

    // …and the other half: an unchanged graph must not re-evaluate either.
    const third = await loadForguncyConfig({ root, loadModule: graphReloadingLoader });
    expect(third.require("scratch").target.locatorKey).toBe("新页#B2");
  });
});
