import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell, planCellCompile } from "./index";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "tests", "fixtures", "valid-multi");

const inlineDecision: DependencyDecision = { strategy: "inline", packageName: "es-toolkit" };
const hostDecision: DependencyDecision = { strategy: "host", packageName: "react", globalName: "React" };

function registry(): CellRegistry {
  return createCellRegistry(
    {
      runtime: { codeMarkerNamespace: "sales_fgc" },
      cells: {
        orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
        orderBoard: { entry: "./cells/order-board/src/index.ts", target: { pageName: "销售订单", cell: "D4" } },
      },
    },
    { root: fixturesRoot },
  );
}

describe("cell compilation plan", () => {
  it("resolves the Cell from the shared registry rather than from a bare path", () => {
    const plan = planCellCompile({ registry: registry(), cellId: "orderBoard", dependencies: [inlineDecision] });

    expect(plan.cellId).toBe("orderBoard");
    expect(plan.entryPath).toBe(join(fixturesRoot, "cells", "order-board", "src", "index.ts"));
    expect(plan.target.locatorKey).toBe("销售订单#D4");
    expect(plan.codeMarkerNamespace).toBe("sales_fgc");
    expect(plan.dependencyStrategies).toEqual(["inline"]);
  });

  it("keeps declared dependency strategies in order", () => {
    const plan = planCellCompile({
      registry: registry(),
      cellId: "orderList",
      dependencies: [hostDecision, inlineDecision],
    });

    expect(plan.dependencyStrategies).toEqual(["host", "inline"]);
  });

  it("refuses an unknown Cell id with the registry's actionable diagnostic", () => {
    let caught: unknown;
    try {
      planCellCompile({ registry: registry(), cellId: "ordersList", dependencies: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ForguncyConfigError);
    expect((caught as ForguncyConfigError).codes).toEqual(["unknown-cell-id"]);
  });

  it("reports that compilation is still unimplemented rather than pretending otherwise", async () => {
    // Issue #7 owns the compiler. Until it lands, the boundary must resolve its
    // inputs and then refuse, so no caller can mistake a stub for a build.
    await expect(
      compileCell({ registry: registry(), cellId: "orderList", dependencies: [inlineDecision] }),
    ).rejects.toThrow(/not implemented yet/);
    await expect(
      compileCell({ registry: registry(), cellId: "orderList", dependencies: [inlineDecision] }),
    ).rejects.toThrow(/销售订单#A1/);
  });
});
