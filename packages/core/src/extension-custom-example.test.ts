/**
 * `examples/extension-custom`'s committed config, loaded the way a project's is.
 *
 * Decision source: GitHub Issue #85 — "扩展配置：建立项目级 mappings 输入与统一校验入口"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/85), under Epic #81.
 *
 * `extension-mappings-config.test.ts` proves the *rules* against hand-written documents.
 * This file proves something the rules' own tests cannot: that the fixture #85 hands to
 * #86/#87/#88 is a config a real project could commit and have loaded — `forguncy.config.ts`
 * on disk, through `loadForguncyConfig`, with the entry it names actually present. That
 * is the difference between "the merge rule is right" and "the handoff works", and a
 * fixture that could not be loaded would be discovered by whichever of those three
 * Tickets picked it up rather than here.
 *
 * It is deliberately in `core` rather than in `cell-compiler`: the config path is #26/#85's
 * (`core` owns loading and normalizing), and the compile seam #86 wires is that package's
 * own test's subject. What is asserted below stops exactly where `core`'s knowledge stops —
 * the normalized row and the registry it belongs to — and names #86 for the half that
 * does not.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadForguncyConfig } from "./config-loader.ts";
import { EXTENSION_EXTERNAL_MAPPINGS, findExtensionExternalMapping } from "./extension-externals.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const exampleRoot = join(repositoryRoot, "examples", "extension-custom");

describe("examples/extension-custom is a loadable handoff for #86/#87/#88", () => {
  it("loads as a real project config, with the Cell entry it declares on disk", async () => {
    // `loadForguncyConfig` verifies declared entries exist, so this passing is also the
    // assertion that the fixture's `entry` is not a path nobody wrote.
    const registry = await loadForguncyConfig({ root: exampleRoot });

    expect(registry.cells.map(cell => cell.id)).toEqual(["chartPanel"]);
    expect(registry.cells[0]?.target).toMatchObject({ pageName: "销售看板", cell: "B2" });
  });

  it("normalizes the fixture's own row alongside the built-in table", async () => {
    const registry = await loadForguncyConfig({ root: exampleRoot });
    const { extensionMappings } = registry;

    expect(extensionMappings.source).toBe("project-extended");
    expect(extensionMappings.includesBuiltinMappings).toBe(true);
    expect(extensionMappings.projectMappings.map(row => row.packageName)).toEqual(["@example/chart-kit"]);
    // The row is the project's, and the built-in TanStack Query row is still present —
    // "a project row adds rather than replaces", asserted on the fixture rather than on a
    // document written for the occasion.
    expect(extensionMappings.mappings).toContain(
      EXTENSION_EXTERNAL_MAPPINGS.find(row => row.packageName === "@tanstack/react-query"),
    );
  });

  it("names a library and global the built-in table does not, and does not touch it", async () => {
    const registry = await loadForguncyConfig({ root: exampleRoot });

    const row = findExtensionExternalMapping("@example/chart-kit", registry.extensionMappings.mappings);
    expect(row?.libraryId).toBe("example-chart-kit");
    expect(row?.globalName).toBe("ExampleChartKit");

    // The built-in table has no such package, which is what makes "without modifying the
    // built-in table" a property of this fixture rather than a claim about which file was
    // edited.
    expect(findExtensionExternalMapping("@example/chart-kit")).toBeUndefined();
  });

  it("intercepts the fixture's package exactly, and no subpath of it", async () => {
    // #85's second criterion, on the fixture: the example imports the bare package, and a
    // subpath nobody declared must stay unbridged — the direction a prefix rule would
    // silently get wrong.
    const registry = await loadForguncyConfig({ root: exampleRoot });

    expect(
      findExtensionExternalMapping("@example/chart-kit", registry.extensionMappings.mappings),
    ).toBeDefined();
    expect(
      findExtensionExternalMapping("@example/chart-kit/deep", registry.extensionMappings.mappings),
    ).toBeUndefined();
  });

  it("keeps the strategy out of the config, so the lock stays the decision's only source", async () => {
    // The example is a `extension` package by *decision*, and this fixture deliberately
    // does not carry one: the source imports the package and the config maps it, and
    // nothing here says the package should be `extension`. Asserted because the tempting
    // simplification for a fixture is to add a `strategy` field, and that would be the
    // defect #26 refuses.
    const registry = await loadForguncyConfig({ root: exampleRoot });

    for (const row of registry.extensionMappings.projectMappings) {
      expect(Object.keys(row)).not.toContain("strategy");
    }
  });
});
