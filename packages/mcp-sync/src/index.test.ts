import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, RegisteredCell } from "@forguncy-react-workspace/core";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import { describe, expect, it } from "vitest";

import { planCellSyncTargets, resolveCellSyncTarget, syncCell } from "./index";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "core",
  "tests",
  "fixtures",
  "valid-multi",
);

const artifact: CompileCellResult = { code: "function App() { return null; }", frontendLibraries: [] };

function registry(): CellRegistry {
  return createCellRegistry(
    {
      cells: {
        orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
        orderBoard: { entry: "./cells/order-board/src/index.ts", target: { pageName: "销售订单", cell: "D4" } },
        customerDetail: { entry: "./cells/customer-detail/src/index.ts", target: { pageName: "客户详情", cell: "B2" } },
      },
    },
    { root: fixturesRoot },
  );
}

/** A registry as a host or a cache might hand one over: two Cells, one locator. */
function collidingRegistry(): CellRegistry {
  const cell = (id: string): RegisteredCell => ({
    id,
    entry: `./cells/${id}.ts`,
    entryPath: join(fixturesRoot, "cells", `${id}.ts`),
    target: { pageName: "销售订单", cell: "A1", locatorKey: "销售订单#A1" },
  });
  const cells = [cell("orderList"), cell("orderBoard")];

  return {
    root: fixturesRoot,
    schemaVersion: 1,
    targetLocatorModel: "forguncy-page-cell/v0",
    runtime: {
      codeMarkerNamespace: "fgc",
      dependencyLockPath: "fgc.lock.json",
      dependencyLockPathAbsolute: join(fixturesRoot, "fgc.lock.json"),
    },
    cells,
    cellIds: cells.map(entry => entry.id),
    get: id => cells.find(entry => entry.id === id),
    require: id => {
      const found = cells.find(entry => entry.id === id);
      if (found === undefined) {
        throw new ForguncyConfigError([{ code: "unknown-cell-id", path: `cells.${id}`, message: "no such Cell" }]);
      }
      return found;
    },
    byTarget: locatorKey => cells.find(entry => entry.target.locatorKey === locatorKey),
  };
}

describe("MCP sync target resolution", () => {
  it("resolves a Cell to the coordinates api.page.setCells consumes", () => {
    expect(resolveCellSyncTarget(registry(), "customerDetail")).toEqual({
      cellId: "customerDetail",
      pageName: "客户详情",
      cell: "B2",
      locatorKey: "客户详情#B2",
      entryPath: join(fixturesRoot, "cells", "customer-detail", "src", "index.ts"),
    });
  });

  it("refuses an unknown Cell id before guessing a page", () => {
    let caught: unknown;
    try {
      resolveCellSyncTarget(registry(), "ordersList");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ForguncyConfigError);
    expect((caught as ForguncyConfigError).codes).toEqual(["unknown-cell-id"]);
  });

  it("plans a whole batch", () => {
    const targets = planCellSyncTargets(registry(), ["orderList", "orderBoard"]);

    expect(targets.map(target => target.locatorKey)).toEqual(["销售订单#A1", "销售订单#D4"]);
  });

  it("refuses a batch that would write one Forguncy target twice", () => {
    let caught: unknown;
    try {
      planCellSyncTargets(collidingRegistry(), ["orderList", "orderBoard"]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ForguncyConfigError);
    expect((caught as ForguncyConfigError).codes).toEqual(["duplicate-target", "duplicate-target"]);
    expect((caught as ForguncyConfigError).message).toContain("before any project mutation");
  });

  it("reports the resolved destination and confirms no mutation was attempted", async () => {
    const input = { registry: registry(), cellId: "orderList", artifact };

    await expect(syncCell(input)).rejects.toThrow(/not implemented yet/);
    await expect(syncCell(input)).rejects.toThrow(/no project mutation was attempted/);
  });

  it("stops a duplicate-target sync before reaching the unimplemented mutation", async () => {
    // The ordering matters: the guard has to fire first, otherwise a later real
    // implementation would already have written the first Cell.
    await expect(
      syncCell({ registry: collidingRegistry(), cellId: "orderList", artifact }),
    ).rejects.toThrow(/duplicate-target|refusing to continue/);
  });
});
