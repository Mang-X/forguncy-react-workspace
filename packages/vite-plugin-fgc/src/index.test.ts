import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, ForguncyConfig, RegisteredCell } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { FORGUNCY_PLUGIN_NAME, cellVirtualModuleId, forguncy, virtualModuleCellId } from "./index";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "tests", "fixtures");
const validMultiRoot = join(fixturesRoot, "valid-multi");
const duplicateRoot = join(fixturesRoot, "duplicate-target");
const missingEntryRoot = join(fixturesRoot, "missing-entry-file");

function multiCellConfig(): ForguncyConfig {
  return {
    cells: {
      orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
      orderBoard: { entry: "./cells/order-board/src/index.ts", target: { pageName: "销售订单", cell: "D4" } },
    },
  };
}

function captureConfigError(run: () => unknown): ForguncyConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ForguncyConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a ForguncyConfigError, but nothing was thrown.");
}

describe("Vite+ plugin registry wiring", () => {
  it("keeps the plugin name and exposes the registry API", () => {
    const plugin = forguncy();

    expect(plugin.name).toBe(FORGUNCY_PLUGIN_NAME);
    expect(plugin.configResolved).toBeTypeOf("function");
    expect(plugin.api.registry()).toBeUndefined();
  });

  it("says what is missing when no config was supplied", () => {
    const plugin = forguncy();
    const error = captureConfigError(() => plugin.api.resolveCell("orderList"));

    expect(error.codes).toEqual(["config-missing-cells"]);
    expect(error.message).toContain("forguncy.config.ts");
  });

  it("normalizes the config the host loaded, once the project root is known", () => {
    const plugin = forguncy({ config: multiCellConfig() });

    plugin.configResolved({ root: validMultiRoot });

    const registry = plugin.api.registry();
    expect(registry?.cellIds).toEqual(["orderList", "orderBoard"]);
    expect(plugin.api.resolveCell("orderBoard").target.locatorKey).toBe("销售订单#D4");
  });

  it("accepts a registry that was already normalized, without re-resolving it", () => {
    const registry: CellRegistry = createCellRegistry(multiCellConfig(), { root: validMultiRoot });
    const plugin = forguncy({ config: registry });

    // A different root must not silently re-resolve every entry path.
    plugin.configResolved({ root: duplicateRoot });

    expect(plugin.api.registry()).toBe(registry);
  });

  it("fails duplicate targets at config resolution, before any build or sync", () => {
    const plugin = forguncy({
      config: {
        cells: {
          orderList: { entry: "./cells/a.ts", target: { pageName: "销售订单", cell: "A1" } },
          orderBoard: { entry: "./cells/b.ts", target: { pageName: "销售订单", cell: "a1" } },
        },
      },
    });

    const error = captureConfigError(() => plugin.configResolved({ root: duplicateRoot }));

    expect(error.codes).toEqual(["duplicate-target", "duplicate-target"]);
    expect(plugin.api.registry()).toBeUndefined();
  });

  it("verifies declared entries by default and can be told not to", () => {
    const strict = forguncy({ config: multiCellConfig() });
    expect(captureConfigError(() => strict.configResolved({ root: missingEntryRoot })).codes).toEqual([
      "missing-entry-file",
      "missing-entry-file",
    ]);

    const lenient = forguncy({ config: multiCellConfig(), requireEntryFiles: false });
    lenient.configResolved({ root: missingEntryRoot });
    expect(lenient.api.registry()?.cellIds).toEqual(["orderList", "orderBoard"]);
  });

  it("leaves the registry alone when no config was supplied at all", () => {
    const plugin = forguncy({ mode: "cell" });

    plugin.configResolved({ root: validMultiRoot });

    expect(plugin.api.registry()).toBeUndefined();
  });
});

describe("the virtual Cell module seam", () => {
  function pluginWithRegistry(extra: { fixture?: string } = {}): ReturnType<typeof forguncy> {
    const plugin = forguncy({
      config: {
        cells: {
          orderList: {
            entry: "./cells/order-list/src/index.ts",
            fixture: extra.fixture,
            target: { pageName: "销售订单", cell: "A1" },
          },
          orderBoard: {
            entry: "./cells/order-board/src/index.ts",
            target: { pageName: "销售订单", cell: "D4" },
          },
        },
      },
    });
    plugin.configResolved({ root: validMultiRoot });
    return plugin;
  }

  it("resolves only Cell virtual ids, marker-prefixed, and leaves everything else alone", () => {
    const plugin = pluginWithRegistry();

    // The literal pin: helpers elsewhere derive from this prefix, so any drift
    // in the public specifier shows up here first.
    expect(cellVirtualModuleId("orderList")).toBe("virtual:forguncy/cell/orderList");
    expect(plugin.resolveId(cellVirtualModuleId("orderList"))).toBe("\0virtual:forguncy/cell/orderList");
    expect(virtualModuleCellId("\0virtual:forguncy/cell/orderList")).toBe("orderList");

    expect(plugin.resolveId("./src/main.ts")).toBeNull();
    expect(plugin.resolveId("virtual:forguncy/other")).toBeNull();
    expect(plugin.load("/src/main.ts")).toBeNull();
  });

  it("generates a module with the target verbatim and root-relative import specifiers", () => {
    const plugin = pluginWithRegistry({ fixture: "./cells/order-list/mock.ts" });
    const registry = plugin.api.registry();
    const cell = registry?.require("orderList");

    const source = plugin.load(`\0${cellVirtualModuleId("orderList")}`);

    expect(source).not.toBeNull();
    expect(source).toContain(`export const cellId = "orderList"`);
    expect(source).toContain(`export const target = ${JSON.stringify(cell?.target)}`);
    expect(source).toContain(`import * as __entry from "/cells/order-list/src/index.ts"`);
    expect(source).toContain(`import * as __fixture from "/cells/order-list/mock.ts"`);
    expect(source).toContain(`export const fixture = __fixture.default;`);
    // Never a machine path: the module is generated from the registry's
    // absolute paths but must only ever contain root-relative POSIX specifiers.
    expect(source).not.toContain(validMultiRoot);
    expect(source).not.toMatch(/[A-Za-z]:\\/);
    // Stronger than "the root string doesn't appear": every specifier the
    // module actually emits must be bare or `/`-prefixed POSIX — no drive
    // letter, no backslash, no `.`/`..` path segment. (A null `source` already
    // failed the assertion above; `?? ""` keeps this line's failure readable.)
    const specifiers = [...(source ?? "").matchAll(/from "([^"]*)"/g)].map(([, specifier]) => specifier);
    expect(specifiers).toEqual(["/cells/order-list/src/index.ts", "/cells/order-list/mock.ts"]);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("/") || !specifier.includes("/")).toBe(true);
      expect(specifier).not.toMatch(/^[A-Za-z]:|\\|\/\.\.?\//);
    }
  });

  it("exports an undefined fixture for a Cell that declares none", () => {
    const plugin = pluginWithRegistry();

    const source = plugin.load(`\0${cellVirtualModuleId("orderBoard")}`);

    expect(source).toContain(`export const fixture = undefined;`);
    expect(source).not.toContain("__fixture");
  });

  it("fails an unknown Cell id at the first hook that sees it, naming the ids that exist", () => {
    const plugin = pluginWithRegistry();

    const error = captureConfigError(() => plugin.resolveId(cellVirtualModuleId("nope")));

    expect(error.codes).toEqual(["unknown-cell-id"]);
    expect(error.message).toContain("orderList, orderBoard");
    expect(captureConfigError(() => plugin.load(`\0${cellVirtualModuleId("nope")}`)).codes).toEqual([
      "unknown-cell-id",
    ]);
  });

  it("fails before config resolution when the plugin has no registry", () => {
    const plugin = forguncy();

    expect(captureConfigError(() => plugin.resolveId(cellVirtualModuleId("orderList"))).codes).toEqual([
      "config-missing-cells",
    ]);
    expect(captureConfigError(() => plugin.load(`\0${cellVirtualModuleId("orderList")}`)).codes).toEqual([
      "config-missing-cells",
    ]);
  });

  it("refuses an out-of-root entry or fixture at the first hook that sees it, not only at load", () => {
    /** A registry that skipped `createCellRegistry`, so the plugin's own belt-and-braces containment check is what runs. */
    function registryWithStrayPaths(cell: RegisteredCell): CellRegistry {
      return {
        root: validMultiRoot,
        schemaVersion: 1,
        targetLocatorModel: "forguncy-page-cell/v0",
        runtime: {
          codeMarkerNamespace: "fgc",
          dependencyLockPath: "fgc.lock.json",
          dependencyLockPathAbsolute: join(validMultiRoot, "fgc.lock.json"),
        },
        cells: [cell],
        cellIds: [cell.id],
        get: id => (id === cell.id ? cell : undefined),
        require: id => {
          if (id !== cell.id) {
            throw new ForguncyConfigError([
              { code: "unknown-cell-id", path: `cells.${id}`, message: "no such Cell" },
            ]);
          }
          return cell;
        },
        byTarget: locatorKey => (locatorKey === cell.target.locatorKey ? cell : undefined),
      };
    }

    const strayEntry: RegisteredCell = {
      id: "strayEntry",
      entry: "../stray.ts",
      entryPath: join(validMultiRoot, "..", "stray.ts"),
      target: { pageName: "销售订单", cell: "Z9", locatorKey: "销售订单#Z9" },
    };
    const strayFixture: RegisteredCell = {
      id: "strayFixture",
      entry: "./cells/ok.ts",
      entryPath: join(validMultiRoot, "cells", "ok.ts"),
      fixture: "../stray-mock.ts",
      fixturePath: join(validMultiRoot, "..", "stray-mock.ts"),
      target: { pageName: "销售订单", cell: "Z10", locatorKey: "销售订单#Z10" },
    };

    for (const cell of [strayEntry, strayFixture]) {
      const expectedField = cell.id === "strayEntry" ? "entry" : "fixture";
      const plugin = forguncy({ config: registryWithStrayPaths(cell) });
      plugin.configResolved({ root: validMultiRoot });

      const atResolve = captureConfigError(() => plugin.resolveId(cellVirtualModuleId(cell.id)));
      expect(atResolve.codes).toEqual(["entry-outside-project-root"]);
      expect(atResolve.message).toContain(expectedField);

      const atLoad = captureConfigError(() => plugin.load(`\0${cellVirtualModuleId(cell.id)}`));
      expect(atLoad.codes).toEqual(["entry-outside-project-root"]);
      expect(atLoad.message).toContain(expectedField);
    }
  });
});
