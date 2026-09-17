import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, ForguncyConfig } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { FORGUNCY_PLUGIN_NAME, forguncy } from "./index";

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
