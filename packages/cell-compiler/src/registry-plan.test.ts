import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry, DependencyDecision } from "@forguncy-react-workspace/core";

import { planCellCompile, planCellCompiles } from "./registry-plan.ts";

/**
 * #6's boundary takes "a normal module entry plus resolved dependency decisions";
 * #26's registry knows which entry which declared Cell is. This adapter is the
 * seam between them, so its tests hold the three properties that keep it thin:
 * the entry is the registry's absolute path, the target is the registry's
 * normalized coordinates (never respelled), and the budget override is copied
 * through without unit conversion — #21 owns that.
 */

// Absolute on every platform the suite runs on (`requireEntryFiles: false`, so
// nothing is touched on disk): a literal Windows path would make these tests
// Windows-only.
const PROJECT_ROOT = join(tmpdir(), "fgc-sales-portal");

function projectConfig() {
  return {
    cells: {
      orderList: {
        entry: "./cells/order-list.ts",
        target: { pageName: "销售订单", cell: "d4" },
      },
      orderBoard: {
        entry: "./cells/order-board.ts",
        target: { pageName: "销售订单", cell: "A1" },
        output: { codeBudgetCharacters: 512, justification: "dashboard tile" },
      },
    },
  };
}

function registryOf(config: unknown = projectConfig()): CellRegistry {
  return createCellRegistry(config, { root: PROJECT_ROOT, requireEntryFiles: false });
}

const DECISIONS: readonly DependencyDecision[] = [];

describe("planning one declared Cell for compilation", () => {
  it("hands the compiler the registry's absolute entry path", () => {
    const plan = planCellCompile({ registry: registryOf(), cellId: "orderList", dependencies: DECISIONS });

    expect(plan.cellId).toBe("orderList");
    expect(plan.input.entry).toBe(resolve(PROJECT_ROOT, "cells", "order-list.ts"));
    expect(plan.input.dependencies).toBe(DECISIONS);
  });

  it("carries the target exactly as the registry normalized it", () => {
    // `d4` is normalized once, in the registry. The plan — and later mcp-sync's
    // `setCells` — must see the same spelling, or compile-time reporting and the
    // write could name different destinations.
    const plan = planCellCompile({ registry: registryOf(), cellId: "orderList", dependencies: DECISIONS });

    expect(plan.target).toEqual({
      pageName: "销售订单",
      cell: "D4",
      locatorKey: "销售订单#D4",
    });
  });

  it("takes the marker namespace from the registry's runtime, not a re-declared default", () => {
    const plan = planCellCompile({ registry: registryOf(), cellId: "orderList", dependencies: DECISIONS });

    expect(plan.codeMarkerNamespace).toBe("fgc");
  });

  it("copies a declared output override through untouched, with no unit conversion", () => {
    // #77 settled the unit as characters, so the declared value is already the
    // quantity `compileCell`'s `codeBudgetCharacters` compares and needs no
    // conversion here. This adapter's job stays "carry the override", not "reprice it".
    const plan = planCellCompile({ registry: registryOf(), cellId: "orderBoard", dependencies: DECISIONS });

    expect(plan.output).toEqual({ codeBudgetCharacters: 512, justification: "dashboard tile" });
  });

  it("omits the output override when the config declares none", () => {
    const plan = planCellCompile({ registry: registryOf(), cellId: "orderList", dependencies: DECISIONS });

    expect("output" in plan).toBe(false);
  });

  it("lets the registry explain an unknown id rather than planning an empty entry", () => {
    let thrown: unknown;
    try {
      planCellCompile({ registry: registryOf(), cellId: "nope", dependencies: DECISIONS });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForguncyConfigError);
    expect((thrown as ForguncyConfigError).codes).toEqual(["unknown-cell-id"]);
  });
});

describe("planning every declared Cell", () => {
  it("returns one plan per declared Cell, in declaration order", () => {
    const plans = planCellCompiles({ registry: registryOf(), dependencies: DECISIONS });

    expect(plans.map(plan => plan.cellId)).toEqual(["orderList", "orderBoard"]);
  });

  it("resolves each plan against its own entry, target and output", () => {
    const plans = planCellCompiles({ registry: registryOf(), dependencies: DECISIONS });
    const [list, board] = plans;

    expect(list?.input.entry).toBe(resolve(PROJECT_ROOT, "cells", "order-list.ts"));
    expect(board?.input.entry).toBe(resolve(PROJECT_ROOT, "cells", "order-board.ts"));
    expect(list?.target.locatorKey).toBe("销售订单#D4");
    expect(board?.target.locatorKey).toBe("销售订单#A1");
    expect(list?.output).toBeUndefined();
    expect(board?.output).toEqual({ codeBudgetCharacters: 512, justification: "dashboard tile" });
  });

  it("shares the dependency list across plans rather than copying it per Cell", () => {
    const plans = planCellCompiles({ registry: registryOf(), dependencies: DECISIONS });

    for (const plan of plans) {
      expect(plan.input.dependencies).toBe(DECISIONS);
    }
  });

  it("plans an empty project as an empty batch", () => {
    expect(planCellCompiles({ registry: registryOf({ cells: {} }), dependencies: DECISIONS })).toEqual([]);
  });
});
