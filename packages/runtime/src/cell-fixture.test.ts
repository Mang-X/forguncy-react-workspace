import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCellRegistry } from "@forguncy-react-workspace/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CELL_FIXTURE_ERROR_CODES,
  CELL_FIXTURE_OPTION_FIELDS,
  CellFixtureError,
  createCellFixtureProvider,
  resolveCellFixtureOptions,
} from "./cell-fixture.ts";
import type { CellFixtureContext } from "./cell-fixture.ts";
import type { MockRuntimeFacadeOptions } from "./mock-provider.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "cell-fixture");

function captureFixtureError(run: () => unknown): CellFixtureError {
  try {
    run();
  } catch (error) {
    if (error instanceof CellFixtureError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a CellFixtureError, but nothing was thrown.");
}

describe("the fixture module export contract", () => {
  it("admits exactly the option fields the mock provider takes", () => {
    expect([...CELL_FIXTURE_ERROR_CODES]).toEqual([
      "fixture-absent",
      "fixture-not-consumable",
      "fixture-factory-failed",
      "fixture-unknown-field",
      "fixture-invalid-field",
    ]);
    expect([...CELL_FIXTURE_OPTION_FIELDS]).toEqual([
      "forguncyMembers",
      "cellProps",
      "serverCommands",
      "dataSources",
    ]);
    // Both directions, checked by `tsc`: adding an option field without
    // admitting it here (or admitting a field that no longer exists) fails the
    // type check instead of making a valid fixture unresolvable at runtime.
    expectTypeOf<keyof MockRuntimeFacadeOptions>().toEqualTypeOf<(typeof CELL_FIXTURE_OPTION_FIELDS)[number]>();
  });

  it("takes an options object as-is, without cloning or rewriting it", () => {
    const options: MockRuntimeFacadeOptions = {
      forguncyMembers: { getCurrentUser: () => "用户" },
      cellProps: { Permissions: { Orders: "read" } },
      serverCommands: { SaveOrder: async () => ({ ok: true }) },
      dataSources: { Orders: () => ({ data: [], totalCount: 0, loading: false, error: null }) },
    };

    expect(resolveCellFixtureOptions(options)).toBe(options);
  });

  it("calls a factory default export and takes what it returns", () => {
    const context = { cellId: "orderList", fixturePath: "/project/cells/order-list/mock.ts" };
    const options: MockRuntimeFacadeOptions = { cellProps: { ImageContext: {} } };
    let received: unknown;

    const resolved = resolveCellFixtureOptions((factoryContext: CellFixtureContext) => {
      received = factoryContext;
      return options;
    }, context);

    expect(resolved).toBe(options);
    expect(received).toEqual(context);
  });

  it("treats an explicitly undefined known field as not supplied", () => {
    // `{ ...spread }` routinely produces `undefined` values; refusing them would
    // punish the common case while the unknown-name guard already catches typos.
    const options = { cellProps: undefined, dataSources: undefined };

    expect(resolveCellFixtureOptions(options)).toBe(options);
  });

  it("reports a missing default export as fixture-absent", () => {
    const error = captureFixtureError(() => resolveCellFixtureOptions(undefined, { cellId: "orderBoard" }));

    expect(error.code).toBe("fixture-absent");
    expect(error.context.cellId).toBe("orderBoard");
    expect(error.message).toContain("default export");
  });

  it("reports a null default export as present-but-unconsumable, not as absent", () => {
    // `export default null` *declares* a default export — absent is `undefined`.
    // Folding it into `fixture-absent` would send the reader to "declare a
    // fixture" when the fixture exists and is simply the wrong shape.
    const error = captureFixtureError(() => resolveCellFixtureOptions(null, { cellId: "orderList" }));

    expect(error.code).toBe("fixture-not-consumable");
    expect(error.message).toContain("null");
  });

  it("reports a default export that is neither options nor factory", () => {
    const error = captureFixtureError(() => resolveCellFixtureOptions("not a fixture", { cellId: "orderList" }));

    expect(error.code).toBe("fixture-not-consumable");
    expect(error.message).toContain("options object or a factory");
    expect(error.message).toContain("string");
  });

  it("refuses an async factory instead of installing a provider a render later", () => {
    const error = captureFixtureError(() => resolveCellFixtureOptions(async () => ({ cellProps: {} })));

    // The async function itself is invoked (it *is* the factory); its Promise
    // result is what the contract refuses.
    expect(error.code).toBe("fixture-not-consumable");
    expect(error.message).toContain("Promise");
    expect(error.message).toContain("synchronously");
  });

  it("consumes a rejected factory promise so the refusal is the only error channel", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // An async factory that throws: the throw lands *inside* the promise, not
      // inside the try/catch around the factory call, so the rejection would
      // otherwise reach the next tick with no handler — a second, uncontrolled
      // error channel beside the named diagnostic.
      const fromAsync = captureFixtureError(() =>
        resolveCellFixtureOptions(async () => {
          throw new Error("fixture failed");
        }),
      );
      expect(fromAsync.code).toBe("fixture-not-consumable");
      expect(fromAsync.message).toContain("Promise");

      // A plain factory returning an already-rejected promise takes the same
      // branch — pre-checking `AsyncFunction` alone would miss this one.
      const fromPlain = captureFixtureError(() =>
        resolveCellFixtureOptions(() => Promise.reject(new Error("factory rejected"))),
      );
      expect(fromPlain.code).toBe("fixture-not-consumable");

      // `unhandledRejection` is raised once the microtask queue drains, so one
      // macrotask later a stray rejection would already have fired.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the original error as the cause of a throwing factory", () => {
    const boom = new Error("factory exploded");
    const error = captureFixtureError(() =>
      resolveCellFixtureOptions(() => {
        throw boom;
      }, { fixturePath: "/project/cells/x/mock.ts" }),
    );

    expect(error.code).toBe("fixture-factory-failed");
    expect(error.cause).toBe(boom);
    expect(error.message).toContain("factory exploded");
    expect(error.message).toContain("/project/cells/x/mock.ts");
  });

  it("rejects an unknown top-level field, naming what is allowed", () => {
    const error = captureFixtureError(() => resolveCellFixtureOptions({ serverCommand: {} }));

    expect(error.code).toBe("fixture-unknown-field");
    expect(error.message).toContain('"serverCommand"');
    expect(error.message).toContain("forguncyMembers, cellProps, serverCommands, dataSources");
    // The reason is part of the contract: silently ignoring the field would let
    // the fixture stand in for less than the page does.
    expect(error.message).toContain("silently ignored");
  });

  it("rejects a known field of the wrong shape", () => {
    expect(captureFixtureError(() => resolveCellFixtureOptions({ cellProps: "nope" })).code).toBe(
      "fixture-invalid-field",
    );
    expect(captureFixtureError(() => resolveCellFixtureOptions({ forguncyMembers: [] })).code).toBe(
      "fixture-invalid-field",
    );
    expect(captureFixtureError(() => resolveCellFixtureOptions({ serverCommands: { Save: 1 } })).message).toContain(
      'entry "Save" must be a function',
    );
    expect(captureFixtureError(() => resolveCellFixtureOptions({ dataSources: { Orders: "rows" } })).message).toContain(
      'entry "Orders" must be a function',
    );
  });
});

describe("consuming a fixture declared in project config", () => {
  // The end-to-end consumption path of Issue #28: config data → registry →
  // resolved fixturePath → dynamic import of the real file on disk → mock
  // provider. The dynamic import mirrors `config-loader.test.ts`, which already
  // proves this runtime can import a `.ts` module by absolute path.
  it("resolves the registry's fixturePath, imports it, and supplies the mock provider", async () => {
    const registry = createCellRegistry(
      {
        cells: {
          orderList: {
            entry: "./cells/order-list/src/index.ts",
            fixture: "./cells/order-list/mock.ts",
            target: { pageName: "销售订单", cell: "A1" },
          },
        },
      },
      { root: fixtureRoot },
    );

    const cell = registry.require("orderList");
    expect(cell.fixture).toBe("./cells/order-list/mock.ts");
    const fixturePath = cell.fixturePath;
    expect(fixturePath).toBe(join(fixtureRoot, "cells", "order-list", "mock.ts"));
    if (fixturePath === undefined) {
      throw new Error("The registry resolved no fixturePath for a declared fixture.");
    }

    const module = await import(pathToFileURL(fixturePath).href);
    const provider = createCellFixtureProvider(module.default, { cellId: cell.id, fixturePath });

    expect(provider.kind).toBe("mock");
    expect(provider.bindings.cellProps.Permissions).toEqual({ Orders: "read" });
    expect(provider.bindings.useDataSource("Orders")).toEqual({
      data: [{ id: "SO-1" }],
      totalCount: 1,
      loading: false,
      error: null,
    });
    // A source the fixture did not stand in for keeps the host's own absence —
    // an error *state* containing the name, not a throw.
    expect(provider.bindings.useDataSource("Missing").error).toContain("Missing");
  });

  it("reports fixture-absent for a Cell that declares none, against the registry's own silence", () => {
    const registry = createCellRegistry(
      {
        cells: {
          orderBoard: {
            entry: "./cells/order-list/src/index.ts",
            target: { pageName: "销售订单", cell: "D4" },
          },
        },
      },
      { root: fixtureRoot },
    );

    const cell = registry.require("orderBoard");
    expect(cell.fixture).toBeUndefined();
    expect(cell.fixturePath).toBeUndefined();

    const error = captureFixtureError(() =>
      createCellFixtureProvider(undefined, { cellId: cell.id, fixturePath: cell.fixturePath }),
    );
    expect(error.code).toBe("fixture-absent");
    expect(error.message).toContain('Cell "orderBoard"');
  });
});
