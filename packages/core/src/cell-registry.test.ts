import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertDistinctTargetClaims,
  assertUniqueTargets,
  createCellRegistry,
  ForguncyConfigError,
  isCellRegistry,
  isSecretLikeKey,
  machineSpecificPathProblem,
} from "./cell-registry.ts";
import type { CellRegistry, ConfigDiagnosticCode, RegisteredCell } from "./cell-registry.ts";
import { normalizeExtensionMappings } from "./extension-mappings-config.ts";
import type { NormalizedExtensionMappings } from "./extension-mappings-config.ts";
import { targetLocatorKey } from "./forguncy-config.ts";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const validMultiRoot = join(fixturesRoot, "valid-multi");
const duplicateRoot = join(fixturesRoot, "duplicate-target");
const invalidTargetRoot = join(fixturesRoot, "invalid-target");
const missingEntryRoot = join(fixturesRoot, "missing-entry-file");

interface RegistryOptions {
  readonly root?: string;
  readonly requireEntryFiles?: boolean;
}

/**
 * The normalized extension mapping set for a config, taken from the real normalization.
 *
 * Used by the forged registries below, which skip `createCellRegistry` on purpose to
 * exercise the mutation-boundary guard. Hand-writing the field would be a second copy of
 * a shape the normalizer owns, and `isCellRegistry` would then be checked against a
 * literal rather than against what a real registry carries.
 */
function normalizedMappingsOf(config: unknown): NormalizedExtensionMappings {
  const result = normalizeExtensionMappings(config);
  if (!result.ok) throw new Error("Expected this fixture config's extension mappings to normalize.");
  return result.mappings;
}

function registryOf(config: unknown, options: RegistryOptions = {}): CellRegistry {
  return createCellRegistry(config, {
    root: options.root ?? validMultiRoot,
    requireEntryFiles: options.requireEntryFiles ?? true,
  });
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

function codesOf(run: () => unknown): readonly ConfigDiagnosticCode[] {
  return captureConfigError(run).codes;
}

/** The multi-Cell fixture as data, so the registry can be tested without a loader. */
function multiCellConfig() {
  return {
    runtime: { forguncyVersion: "12.0.100", projectAlias: "sales-portal" },
    cells: {
      orderList: {
        entry: "./cells/order-list/src/index.ts",
        fixture: "./cells/order-list/mock.ts",
        target: { pageName: "销售订单", cell: "A1" },
      },
      orderBoard: {
        entry: "./cells/order-board/src/index.ts",
        // Lower-case column, to exercise A1 normalization rather than reject it.
        target: { pageName: "销售订单", cell: "d4" },
      },
      customerDetail: {
        entry: "./cells/customer-detail/src/index.ts",
        target: { pageName: "客户详情", cell: "B2" },
      },
    },
  };
}

function oneCell(overrides: { entry?: unknown; target?: unknown; output?: unknown; fixture?: unknown } = {}) {
  return {
    cells: {
      orderList: {
        entry: "entry" in overrides ? overrides.entry : "./cells/order-list/src/index.ts",
        target: "target" in overrides ? overrides.target : { pageName: "销售订单", cell: "A1" },
        ...("fixture" in overrides ? { fixture: overrides.fixture } : {}),
        ...("output" in overrides ? { output: overrides.output } : {}),
      },
    },
  };
}

describe("normalized Cell registry", () => {
  it("resolves every declared Cell from one snapshot", () => {
    const registry = registryOf(multiCellConfig());

    expect(registry.cellIds).toEqual(["orderList", "orderBoard", "customerDetail"]);
    expect(registry.root).toBe(validMultiRoot);
    expect(registry.schemaVersion).toBe(1);
    expect(registry.targetLocatorModel).toBe("forguncy-page-cell/v0");
    expect(registry.cells).toHaveLength(3);
  });

  it("binds a logical Cell id to exactly one entry and one normalized target", () => {
    const cell = registryOf(multiCellConfig()).require("orderBoard");

    expect(cell.id).toBe("orderBoard");
    expect(cell.entry).toBe("./cells/order-board/src/index.ts");
    expect(cell.entryPath).toBe(join(validMultiRoot, "cells", "order-board", "src", "index.ts"));
    expect(cell.target.pageName).toBe("销售订单");
    expect(cell.target.cell).toBe("D4");
    expect(cell.target.locatorKey).toBe("销售订单#D4");
  });

  it("resolves the optional dev fixture entry alongside the real entry", () => {
    const registry = registryOf(multiCellConfig());

    expect(registry.require("orderList").fixture).toBe("./cells/order-list/mock.ts");
    expect(registry.require("orderList").fixturePath).toBe(join(validMultiRoot, "cells", "order-list", "mock.ts"));
    expect(registry.require("orderBoard").fixture).toBeUndefined();
  });

  it("applies the documented runtime defaults and honours declared overrides", () => {
    const defaults = registryOf(multiCellConfig()).runtime;

    expect(defaults.codeMarkerNamespace).toBe("fgc");
    expect(defaults.dependencyLockPath).toBe("fgc.lock.json");
    expect(defaults.dependencyLockPathAbsolute).toBe(join(validMultiRoot, "fgc.lock.json"));
    expect(defaults.forguncyVersion).toBe("12.0.100");
    expect(defaults.projectAlias).toBe("sales-portal");

    const declared = registryOf({
      runtime: { codeMarkerNamespace: "sales_fgc", dependencyLockPath: "./locks/fgc.lock.json" },
      cells: { orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "P", cell: "A1" } } },
    }).runtime;

    expect(declared.codeMarkerNamespace).toBe("sales_fgc");
    expect(declared.dependencyLockPath).toBe("./locks/fgc.lock.json");
    expect(declared.dependencyLockPathAbsolute).toBe(join(validMultiRoot, "locks", "fgc.lock.json"));
  });

  it("answers lookups by id and by target", () => {
    const registry = registryOf(multiCellConfig());

    expect(registry.get("orderList")?.id).toBe("orderList");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.byTarget("销售订单#A1")?.id).toBe("orderList");
    expect(registry.byTarget("销售订单#D4")?.id).toBe("orderBoard");
    expect(registry.byTarget("销售订单#Z9")).toBeUndefined();
  });

  it("refuses an unknown Cell id, listing the ids that do exist", () => {
    const error = captureConfigError(() => registryOf(multiCellConfig()).require("ordersList"));

    expect(error.codes).toEqual(["unknown-cell-id"]);
    expect(error.diagnostics[0]?.path).toBe("cells.ordersList");
    expect(error.message).toContain("orderList, orderBoard, customerDetail");
  });

  it("says so plainly when no Cells are declared at all", () => {
    const error = captureConfigError(() => registryOf({ cells: {} }).require("orderList"));

    expect(error.message).toContain("Declared Cells: none");
  });

  it("keeps Cell identity independent of where the entry file lives", () => {
    const moved = registryOf({
      cells: { orderList: { entry: "./cells/order-list/mock.ts", target: { pageName: "销售订单", cell: "A1" } } },
    });

    expect(moved.require("orderList").id).toBe("orderList");
    expect(moved.require("orderList").entry).toBe("./cells/order-list/mock.ts");
  });

  it("accepts an empty cells map, so adopting the contract is not a commitment to Cells", () => {
    const registry = registryOf({ cells: {} });

    expect(registry.cells).toEqual([]);
    expect(registry.cellIds).toEqual([]);
  });

  it("reports every problem in one pass instead of stopping at the first", () => {
    const error = captureConfigError(() =>
      registryOf({
        schemaVersion: 99,
        cells: {
          "order list": { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
          broken: { entry: "./cells/does-not-exist.ts", target: { pageName: "", cell: "0" }, unexpected: true },
        },
      }),
    );

    expect(error.codes).toContain("unsupported-schema-version");
    expect(error.codes).toContain("invalid-cell-id");
    expect(error.codes).toContain("unknown-cell-field");
    expect(error.codes).toContain("missing-entry-file");
    expect(error.codes).toContain("invalid-target-page-name");
    expect(error.codes).toContain("invalid-target-cell");
    expect(error.diagnostics.length).toBeGreaterThanOrEqual(6);
  });
});

describe("registry validation", () => {
  it("requires an absolute project root", () => {
    expect(codesOf(() => createCellRegistry({ cells: {} }, { root: "" }))).toEqual(["invalid-project-root"]);
    expect(codesOf(() => createCellRegistry({ cells: {} }, { root: "./relative" }))).toEqual(["invalid-project-root"]);
  });

  it("requires a config object and a cells map", () => {
    expect(codesOf(() => registryOf(null))).toEqual(["config-not-an-object"]);
    expect(codesOf(() => registryOf(["cells"]))).toEqual(["config-not-an-object"]);
    expect(codesOf(() => registryOf({}))).toContain("config-missing-cells");
    expect(codesOf(() => registryOf({ cells: [] }))).toContain("cells-not-an-object");
    expect(codesOf(() => registryOf({ cells: "orderList" }))).toContain("cells-not-an-object");
  });

  it("rejects a schema version it does not understand", () => {
    const error = captureConfigError(() => registryOf({ schemaVersion: 2, cells: {} }));

    expect(error.codes).toEqual(["unsupported-schema-version"]);
    expect(error.message).toContain("understands 1");
  });

  it("names the allowed fields when it meets an unknown one", () => {
    const configError = captureConfigError(() => registryOf({ cells: {}, cellz: {} }));

    expect(configError.codes).toEqual(["unknown-config-field"]);
    expect(configError.message).toContain("Allowed fields: schemaVersion, cells, runtime");
  });

  it("rejects unknown fields inside a Cell and inside a target", () => {
    expect(() => registryOf(oneCell())).not.toThrow();

    expect(
      codesOf(() =>
        registryOf(
          { cells: { orderList: { entry: "./cells/a.ts", target: { pageName: "P", cell: "A1" }, targt: {} } } },
          { root: missingEntryRoot, requireEntryFiles: false },
        ),
      ),
    ).toEqual(["unknown-cell-field"]);

    expect(
      codesOf(() =>
        registryOf({
          cells: {
            orderList: {
              entry: "./cells/order-list/src/index.ts",
              target: { pagename: "P", pageName: "销售订单", cell: "A1" },
            },
          },
        }),
      ),
    ).toEqual(["unknown-target-field"]);
  });

  it("refuses to read dependency-strategy decisions out of config", () => {
    for (const field of ["dependencies", "strategy", "dependencyStrategies"]) {
      const error = captureConfigError(() => registryOf({ cells: {}, [field]: { "es-toolkit": "inline" } }));

      expect(error.codes).toEqual(["dependency-decision-in-config"]);
      expect(error.message).toContain("dependency lock");
    }

    // An unrelated unknown field is still an unknown field, not a strategy claim.
    expect(codesOf(() => registryOf({ cells: {}, resolution: {} }))).toEqual(["unknown-config-field"]);
  });

  it("refuses to read dependency-strategy decisions out of a Cell", () => {
    const error = captureConfigError(() =>
      registryOf({
        cells: {
          orderList: {
            entry: "./cells/order-list/src/index.ts",
            target: { pageName: "销售订单", cell: "A1" },
            dependencies: { "es-toolkit": "inline" },
          },
        },
      }),
    );

    expect(error.codes).toEqual(["dependency-decision-in-config"]);
    expect(error.diagnostics[0]?.path).toBe("cells.orderList.dependencies");
  });

  it("rejects secrets and machine-specific paths anywhere in the document", () => {
    const error = captureConfigError(() =>
      registryOf(
        {
          cells: {
            orderList: {
              entry: "C:\\repos\\sales\\cells\\order-list\\src\\index.tsx",
              target: { pageName: "销售订单", cell: "A1" },
            },
          },
          projectSecret: "shh",
        },
        { requireEntryFiles: false },
      ),
    );

    expect(error.codes).toContain("machine-specific-path");
    expect(error.codes).toContain("secret-looking-field");
    expect(error.diagnostics.some(diagnostic => diagnostic.path === "config.projectSecret")).toBe(true);
    expect(error.diagnostics.some(diagnostic => diagnostic.path === "config.cells.orderList.entry")).toBe(true);
  });

  it("flags the machine-specific path shapes that break a clean checkout", () => {
    expect(machineSpecificPathProblem("C:\\repos\\a.ts")).toContain("Windows");
    expect(machineSpecificPathProblem("c:/repos/a.ts")).toContain("Windows");
    expect(machineSpecificPathProblem("\\\\server\\share\\a.ts")).toContain("UNC");
    expect(machineSpecificPathProblem("file:///c:/repos/a.ts")).toContain("file://");
    expect(machineSpecificPathProblem("~/repos/a.ts")).toContain("home-relative");
    expect(machineSpecificPathProblem("/repos/a.ts")).toContain("absolute");
    expect(machineSpecificPathProblem("./cells/a.ts")).toBeUndefined();
  });

  it("flags credential-bearing field names", () => {
    for (const key of ["token", "sessionToken", "apiKey", "api_key", "password", "private-key", "authorization"]) {
      expect(isSecretLikeKey(key), key).toBe(true);
    }
    for (const key of ["entry", "pageName", "codeMarkerNamespace", "projectAlias", "forguncyVersion"]) {
      expect(isSecretLikeKey(key), key).toBe(false);
    }
  });

  it("requires every Cell to declare an entry", () => {
    const error = captureConfigError(() => registryOf({ cells: { orderList: { target: { pageName: "销售订单", cell: "A1" } } } }));

    expect(error.codes).toEqual(["missing-cell-entry"]);
    expect(error.diagnostics[0]?.path).toBe("cells.orderList.entry");
  });

  it("requires every Cell to declare a Forguncy target", () => {
    const error = captureConfigError(() =>
      registryOf({ cells: { orderList: { entry: "./cells/order-list/src/index.ts" } } }),
    );

    expect(error.codes).toEqual(["missing-cell-target"]);
  });

  it("fails a declared entry that is not on disk", () => {
    const error = captureConfigError(() => registryOf(oneCell(), { root: missingEntryRoot }));

    expect(error.codes).toEqual(["missing-entry-file"]);
    expect(error.message).toContain("does not exist");
  });

  it("can normalize without touching the filesystem when a caller asks it not to", () => {
    const registry = registryOf(oneCell(), { root: missingEntryRoot, requireEntryFiles: false });

    expect(registry.cellIds).toEqual(["orderList"]);
  });

  it("rejects entries that resolve outside the project root", () => {
    const error = captureConfigError(() =>
      registryOf(oneCell({ entry: "../valid-multi/cells/order-list/src/index.ts" }), { root: duplicateRoot }),
    );

    expect(error.codes).toEqual(["invalid-entry-path"]);
    expect(error.message).toContain("outside the project root");
  });

  it("rejects an entry that only reaches outside the project through a link", () => {
    // A committed symlink fixture would not survive every checkout, so the link
    // is built per run: project root and outside directory as siblings, one
    // junction between them.
    const base = mkdtempSync(join(tmpdir(), "fgc-registry-"));
    try {
      const root = join(base, "project");
      const outside = join(base, "outside");
      mkdirSync(join(root, "cells"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "index.ts"), "export {};\n");
      writeFileSync(join(root, "cells", "order.ts"), "export {};\n");

      try {
        // `junction` is the one link type Windows permits without developer
        // mode; on POSIX it degrades to an ordinary directory link.
        symlinkSync(outside, join(root, "cells", "linked"), "junction");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          return; // Host forbids links; the lexical containment path is still covered above.
        }
        throw error;
      }

      const outsideEntry = captureConfigError(() =>
        registryOf(oneCell({ entry: "./cells/linked/index.ts" }), { root }),
      );
      expect(outsideEntry.codes).toEqual(["entry-outside-project-root"]);
      expect(outsideEntry.message).toContain("through links");

      const outsideFixture = captureConfigError(() =>
        registryOf(oneCell({ entry: "./cells/order.ts", fixture: "./cells/linked/index.ts" }), { root, requireEntryFiles: true }),
      );
      expect(outsideFixture.codes).toContain("fixture-outside-project-root");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a cell reference and a page name that cannot address a Forguncy Cell", () => {
    const error = captureConfigError(() =>
      registryOf(
        {
          cells: {
            orderList: { entry: "./cells/a.ts", target: { pageName: "销售订单", cell: "0" } },
            orderBoard: { entry: "./cells/a.ts", target: { pageName: "   ", cell: "B4" } },
          },
        },
        { root: invalidTargetRoot },
      ),
    );

    expect(error.codes).toContain("invalid-target-cell");
    expect(error.codes).toContain("invalid-target-page-name");

    expect(
      codesOf(() => registryOf(oneCell({ entry: "./cells/a.ts", target: "销售订单!A1" }), { root: invalidTargetRoot })),
    ).toEqual(["invalid-target"]);
  });

  it("rejects a Cell that is not an object", () => {
    expect(codesOf(() => registryOf({ cells: { orderList: "销售订单!A1" } }))).toEqual(["invalid-cell"]);
  });

  it("rejects a target that is not an object", () => {
    expect(codesOf(() => registryOf(oneCell({ entry: "./cells/a.ts", target: null }), { root: invalidTargetRoot }))).toEqual(
      ["invalid-target"],
    );
  });

  it("rejects a non-identifier logical Cell id before it becomes an identity", () => {
    const error = captureConfigError(() =>
      registryOf({ cells: { "order list": { entry: "./cells/a.ts", target: { pageName: "P", cell: "A1" } } } }, { root: invalidTargetRoot }),
    );

    expect(error.codes).toEqual(["invalid-cell-id"]);
    expect(error.message).toContain("stable identifiers");
  });

  it("fails a fixture entry that is not on disk", () => {
    const error = captureConfigError(() =>
      registryOf({
        cells: {
          orderList: {
            entry: "./cells/order-list/src/index.ts",
            fixture: "./cells/order-list/missing.mock.ts",
            target: { pageName: "销售订单", cell: "A1" },
          },
        },
      }),
    );

    expect(error.codes).toEqual(["missing-fixture-file"]);
  });

  it("detects two Cells claiming the same Forguncy target, before anything runs", () => {
    const error = captureConfigError(() =>
      registryOf({
        cells: {
          orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
          // Same target, differing only by case.
          orderBoard: { entry: "./cells/order-board/src/index.ts", target: { pageName: "销售订单", cell: "a1" } },
        },
      }),
    );

    expect(error.codes).toEqual(["duplicate-target", "duplicate-target"]);
    expect(error.message).toContain("orderBoard, orderList");
    expect(error.diagnostics.map(diagnostic => diagnostic.path)).toEqual([
      "cells.orderList.target",
      "cells.orderBoard.target",
    ]);
  });

  it("keeps two Cells with different targets valid", () => {
    const registry = registryOf({
      cells: {
        orderList: { entry: "./cells/order-list/src/index.ts", target: { pageName: "销售订单", cell: "A1" } },
        orderBoard: { entry: "./cells/order-board/src/index.ts", target: { pageName: "销售订单", cell: "A2" } },
      },
    });

    expect(registry.cellIds).toEqual(["orderList", "orderBoard"]);
  });

  it("requires evidence before granting a code-budget override", () => {
    const withoutJustification = captureConfigError(() =>
      registryOf(oneCell({ output: { codeBudgetCharacters: 600_000, justification: "   " } })),
    );
    expect(withoutJustification.codes).toEqual(["unjustified-output-override"]);

    expect(
      codesOf(() => registryOf(oneCell({ output: { codeBudgetCharacters: 0, justification: "measured" } }))),
    ).toEqual(["invalid-output-override"]);
    expect(
      codesOf(() => registryOf(oneCell({ output: { codeBudgetCharacters: 1024.5, justification: "measured" } }))),
    ).toEqual(["invalid-output-override"]);
    expect(codesOf(() => registryOf(oneCell({ output: "600000" })))).toEqual(["invalid-output-override"]);
    expect(
      codesOf(() => registryOf(oneCell({ output: { codeBudgetCharacters: 1024, justification: "x", extra: 1 } }))),
    ).toEqual(["unknown-output-field"]);

    const justified = registryOf(
      oneCell({ output: { codeBudgetCharacters: 600_000, justification: "Measured in #21: the canvas cell needs it." } }),
    ).require("orderList");

    expect(justified.output).toEqual({
      codeBudgetCharacters: 600_000,
      justification: "Measured in #21: the canvas cell needs it.",
    });
  });

  it("refuses the pre-#77 byte field rather than repricing it as characters", () => {
    // The rename is not convertible: a byte count read as a character count would
    // silently admit an artifact roughly three times larger for CJK source. So the old
    // name is refused with its own diagnostic, and the value is never carried forward.
    const renamed = captureConfigError(() =>
      registryOf(oneCell({ output: { codeBudgetBytes: 600_000, justification: "measured" } })),
    );
    expect(renamed.codes).toEqual(["renamed-output-field"]);
    expect(renamed.diagnostics[0]?.path).toBe("cells.orderList.output.codeBudgetBytes");
    expect(renamed.diagnostics[0]?.message).toContain("codeBudgetCharacters");
    // One mistake, one diagnostic: the generic unknown-field check must not also fire.
    expect(renamed.codes).not.toContain("unknown-output-field");
    // Nor the "must be a positive whole number" complaint, which would send the reader
    // hunting for a value problem when the field itself is the problem.
    expect(renamed.codes).not.toContain("invalid-output-override");

    // Declaring both is still refused, and that is deliberate rather than incidental:
    // the retired field's presence means the config was not migrated, and accepting it
    // because a correct sibling also exists would leave the stale byte number in the
    // file for the next reader to trust. There is no partial credit — the field is
    // removed or the config is rejected.
    const both = captureConfigError(() =>
      registryOf(
        oneCell({
          output: { codeBudgetBytes: 600_000, codeBudgetCharacters: 500_000, justification: "measured" },
        }),
      ),
    );
    expect(both.codes).toEqual(["renamed-output-field"]);
    // The new field is genuinely read when it stands alone, which is what makes the
    // rejection above a migration instruction rather than a dead end.
    const migrated = registryOf(
      oneCell({ output: { codeBudgetCharacters: 500_000, justification: "measured" } }),
    ).require("orderList");
    expect(migrated.output).toEqual({ codeBudgetCharacters: 500_000, justification: "measured" });
  });

  it("validates the runtime block it applies", () => {
    expect(codesOf(() => registryOf({ cells: {}, runtime: "sales-portal" }))).toEqual(["invalid-runtime-target"]);
    expect(codesOf(() => registryOf({ cells: {}, runtime: { markerNamespace: "fgc" } }))).toEqual([
      "unknown-runtime-field",
    ]);
    expect(codesOf(() => registryOf({ cells: {}, runtime: { codeMarkerNamespace: "not a namespace" } }))).toEqual([
      "invalid-runtime-field",
    ]);
    expect(codesOf(() => registryOf({ cells: {}, runtime: { forguncyVersion: "" } }))).toEqual(["invalid-runtime-field"]);
    expect(codesOf(() => registryOf({ cells: {}, runtime: { projectAlias: "  " } }))).toEqual(["invalid-runtime-field"]);
    expect(
      codesOf(() => registryOf({ cells: {}, runtime: { dependencyLockPath: "../../elsewhere/fgc.lock.json" } })),
    ).toEqual(["dependency-lock-outside-project-root"]);
  });
});

describe("mutation-boundary target guard", () => {
  function claimOf(id: string, cell: string): RegisteredCell {
    return {
      id,
      entry: `./cells/${id}.ts`,
      entryPath: join(validMultiRoot, "cells", `${id}.ts`),
      target: { pageName: "销售订单", cell, locatorKey: `销售订单#${cell}` },
    };
  }

  function forgeRegistry(cells: readonly RegisteredCell[]): CellRegistry {
    return {
      root: validMultiRoot,
      schemaVersion: 1,
      targetLocatorModel: "forguncy-page-cell/v0",
      runtime: {
        codeMarkerNamespace: "fgc",
        dependencyLockPath: "fgc.lock.json",
        dependencyLockPathAbsolute: join(validMultiRoot, "fgc.lock.json"),
      },
      // The real normalization's answer, not a hand-written literal: `isCellRegistry`
      // requires this field, so a forged registry that omitted it would be re-normalized
      // from the raw config and the mutation-boundary path under test would never run.
      extensionMappings: normalizedMappingsOf({}),
      cells,
      cellIds: cells.map(cell => cell.id),
      get: id => cells.find(cell => cell.id === id),
      require: id => {
        const cell = cells.find(entry => entry.id === id);
        if (cell === undefined) {
          throw new ForguncyConfigError([{ code: "unknown-cell-id", path: `cells.${id}`, message: "no such Cell" }]);
        }
        return cell;
      },
      byTarget: locatorKey => cells.find(cell => cell.target.locatorKey === locatorKey),
    };
  }

  it("accepts a registry whose targets are distinct", () => {
    const registry = registryOf(multiCellConfig());

    expect(() => assertUniqueTargets(registry)).not.toThrow();
    expect(isCellRegistry(registry)).toBe(true);
  });

  it("refuses a deserialized registry with two Cells on one target", () => {
    const error = captureConfigError(() =>
      assertUniqueTargets(forgeRegistry([claimOf("orderList", "A1"), claimOf("orderBoard", "A1")])),
    );

    expect(error.codes).toEqual(["duplicate-target", "duplicate-target"]);
    expect(error.message).toContain("before any project mutation");
  });

  it("applies the same guard to an arbitrary batch of claims", () => {
    expect(() =>
      assertDistinctTargetClaims([
        { cellId: "orderList", pageName: "销售订单", cell: "A1" },
        { cellId: "customerDetail", pageName: "客户详情", cell: "A1" },
      ]),
    ).not.toThrow();

    expect(
      captureConfigError(() =>
        assertDistinctTargetClaims([
          { cellId: "orderList", pageName: "销售订单", cell: "A1" },
          { cellId: "orderBoard", pageName: "销售订单", cell: "A1" },
        ]),
      ).codes,
    ).toEqual(["duplicate-target", "duplicate-target"]);
  });

  it("refuses a claim whose carried locator key contradicts its coordinates", () => {
    const error = captureConfigError(() =>
      assertDistinctTargetClaims([
        { cellId: "orderList", pageName: "销售订单", cell: "A1", locatorKey: "别处#B2" },
      ]),
    );

    expect(error.codes).toEqual(["locator-key-mismatch"]);
    expect(error.message).toContain(targetLocatorKey({ pageName: "销售订单", cell: "A1" }));
  });

  it("refuses two equal destinations smuggled in under different stored keys", () => {
    // The blocker regression: identity must be recomputed from coordinates, so
    // two claims for 销售订单!A1 cannot look distinct just because one of them
    // carries a stale or forged key.
    const error = captureConfigError(() =>
      assertDistinctTargetClaims([
        { cellId: "orderList", pageName: "销售订单", cell: "A1", locatorKey: "销售订单#A1" },
        { cellId: "orderBoard", pageName: "销售订单", cell: "A1", locatorKey: "销售订单#Z9" },
      ]),
    );

    expect(error.codes).toContain("duplicate-target");
    expect(error.codes).toContain("locator-key-mismatch");
  });

  it("recognizes a registry by shape, not by identity", () => {
    expect(isCellRegistry(forgeRegistry([claimOf("orderList", "A1")]))).toBe(true);
    expect(isCellRegistry({ cells: [] })).toBe(false);
    expect(isCellRegistry(null)).toBe(false);
    expect(isCellRegistry("registry")).toBe(false);
  });
});
