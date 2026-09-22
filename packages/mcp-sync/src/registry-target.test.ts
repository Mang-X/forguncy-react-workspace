import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, frontendLibraryReference } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { CellRegistry } from "@forguncy-react-workspace/core";

import {
  planCellSyncTargets,
  resolveCellSyncTarget,
  resolveCellSyncTargets,
  syncCellInput,
} from "./registry-target";
import type { CellSyncTargetPlan } from "./registry-target";

/**
 * #19 left target resolution outside sync on purpose ("the target arrives as an
 * input"); #26 owns where the explicit target comes from. This module is that
 * seam, so its tests hold three things: resolution goes through the registry
 * and no other spelling, the mutation-boundary guard runs before any target
 * leaves the module, and a batch fails as a whole when two ids claim one
 * destination.
 */

// Absolute on every platform the suite runs on: `createCellRegistry` refuses a
// non-absolute root, so a literal Windows path would make these tests
// Windows-only. No file is ever touched — `requireEntryFiles: false`.
const PROJECT_ROOT = join(tmpdir(), "fgc-sales-portal");

function projectConfig() {
  return {
    cells: {
      orderList: {
        entry: "./cells/order-list.ts",
        target: { pageName: "销售订单", cell: "A1" },
      },
      orderBoard: {
        entry: "./cells/order-board.ts",
        target: { pageName: "销售订单", cell: "d4" },
      },
    },
  };
}

function registryOf(config: unknown = projectConfig()): CellRegistry {
  return createCellRegistry(config, { root: PROJECT_ROOT, requireEntryFiles: false });
}

function generated(): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\nfunction App() { return null; }\n`,
    frontendLibraries: [],
  };
}

function captureConfigError(run: () => unknown): ForguncyConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ForguncyConfigError) return error;
    throw error;
  }
  throw new Error("Expected a ForguncyConfigError, but nothing was thrown.");
}

/**
 * A registry whose two Cells claim one destination.
 *
 * Built by tampering a valid registry rather than by loading a conflicting
 * config: `createCellRegistry` refuses duplicate targets at construction, so
 * the only way to reach the *boundary* guard — the one that runs when a
 * registry arrives from a host, a cache or a deserialized payload — is with a
 * registry that was valid once and no longer is. The carried key is kept
 * consistent with the forged coordinates, so this isolates the duplicate check
 * from the key-mismatch check.
 */
function collidingRegistry(): CellRegistry {
  const valid = registryOf();
  return {
    ...valid,
    cells: valid.cells.map(cell =>
      cell.id === "orderBoard"
        ? { ...cell, target: { pageName: "销售订单", cell: "A1", locatorKey: "销售订单#A1" } }
        : cell,
    ),
  };
}

describe("resolving a declared Cell to a sync target", () => {
  it("returns the registry's normalized coordinates, verbatim", () => {
    const resolved = resolveCellSyncTarget(registryOf(), "orderList");

    // `d4` normalizes to `D4` in the registry; whatever the registry holds is
    // what sync writes, so there is one spelling of the destination.
    expect(resolved.target).toEqual({ pageName: "销售订单", cell: "A1" });
    expect(resolved.locatorKey).toBe("销售订单#A1");
    expect(resolved.cellId).toBe("orderList");
  });

  it("normalizes through the registry rather than at the sync boundary", () => {
    const resolved = resolveCellSyncTarget(registryOf(), "orderBoard");

    expect(resolved.target.cell).toBe("D4");
    expect(resolved.locatorKey).toBe("销售订单#D4");
  });

  it("lets the registry explain an unknown id instead of inventing a target", () => {
    const error = captureConfigError(() => resolveCellSyncTarget(registryOf(), "nope"));

    expect(error.codes).toEqual(["unknown-cell-id"]);
  });

  it("refuses a registry whose two ids claim one destination, before resolving either", () => {
    const error = captureConfigError(() => resolveCellSyncTarget(collidingRegistry(), "orderList"));

    expect(error.codes).toContain("duplicate-target");
    expect(error.message).toContain("before any project mutation");
  });

  it("refuses a registry whose carried locator key contradicts its coordinates", () => {
    // The blocker regression from #41's review: a deserialized registry may carry
    // a forged key, and the guard must recompute identity from coordinates.
    const forged = registryOf();
    const tampered: CellRegistry = {
      ...forged,
      cells: forged.cells.map(cell =>
        cell.id === "orderBoard" ? { ...cell, target: { ...cell.target, locatorKey: "别处#Z9" } } : cell,
      ),
    };

    const error = captureConfigError(() => resolveCellSyncTarget(tampered, "orderList"));

    expect(error.codes).toContain("locator-key-mismatch");
  });

  it("guards the whole batch once, not each cell separately", () => {
    const error = captureConfigError(() => resolveCellSyncTargets(collidingRegistry(), ["orderList"]));

    expect(error.codes).toEqual(["duplicate-target", "duplicate-target"]);
  });

  it("resolves a batch into one entry per requested id, in order", () => {
    const resolved = resolveCellSyncTargets(registryOf(), ["orderBoard", "orderList"]);

    expect(resolved.map(entry => entry.cellId)).toEqual(["orderBoard", "orderList"]);
    expect(resolved.map(entry => entry.target.cell)).toEqual(["D4", "A1"]);
  });
});

describe("assembling the minimal sync input", () => {
  it("is a target and an artifact, with nothing in between", () => {
    const cell = registryOf().require("orderList");
    const input = syncCellInput(cell, generated());

    expect(Object.keys(input).sort()).toEqual(["artifact", "target"]);
    expect(input.target).toEqual({ pageName: "销售订单", cell: "A1" });
  });
});

describe("planning a batch of declared Cells", () => {
  const basePlan: Omit<CellSyncTargetPlan, "cellId"> = {
    artifact: generated(),
    decisions: [],
    deployed: { kind: "read", code: "" },
    listings: [],
  };

  it("plans each declared Cell against the coordinates the config declared", () => {
    const plans = planCellSyncTargets(registryOf(), [
      { cellId: "orderList", ...basePlan },
      { cellId: "orderBoard", ...basePlan },
    ]);

    expect(plans).toHaveLength(2);
    expect(plans[0]?.target).toEqual({ pageName: "销售订单", cell: "A1" });
    expect(plans[1]?.target).toEqual({ pageName: "销售订单", cell: "D4" });
  });

  it("fails the batch as a whole when two ids claim one destination", () => {
    const error = captureConfigError(() =>
      planCellSyncTargets(collidingRegistry(), [
        { cellId: "orderList", ...basePlan },
        { cellId: "orderBoard", ...basePlan },
      ]),
    );

    // No partial batch: the guard runs before any plan is built, so there is no
    // world where one plan exists and the overwrite already happened.
    expect(error.codes).toEqual(["duplicate-target", "duplicate-target"]);
  });

  it("carries the artifact's frontend library references into the plan unchanged", () => {
    const artifact: CompileCellResult = {
      code: `${CELL_ARTIFACT_BANNER}\nfunction App() { return null; }\n`,
      frontendLibraries: [frontendLibraryReference("@tanstack/react-query")],
    };

    const [plan] = planCellSyncTargets(registryOf(), [{ cellId: "orderList", ...basePlan, artifact }]);

    expect(plan?.target).toEqual({ pageName: "销售订单", cell: "A1" });
    expect(plan?.extensionVerification.references).toEqual(["@tanstack/react-query"]);
  });
});
