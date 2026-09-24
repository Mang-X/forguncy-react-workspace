import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCellRegistry, ForguncyConfigError } from "@forguncy-react-workspace/core";
import type { ForguncyConfig } from "@forguncy-react-workspace/core";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cellVirtualModuleId, forguncy } from "./index.ts";

/**
 * The execution-level proof of Issue #28's dev seam: not "the generator emits
 * plausible source", but "a real Vite dev server resolves the virtual id,
 * transforms the entry, and the module's exports are the documented contract".
 *
 * Issue #23's harness is what *mounts* this into a page; here the module is
 * loaded through `ssrLoadModule`, which runs the same resolve/load/transform
 * pipeline without needing a browser. Green here is a local check of this seam,
 * not a claim about Forguncy runtime behavior.
 *
 * The `vite` devDependency in this package exists for this test alone — the
 * plugin itself never imports Vite; it is typed structurally against whatever
 * host hands it the project root (see `index.ts`).
 *
 * The fixture tree below deliberately diverges from `core/tests/fixtures`:
 * those entries only have to exist on disk for registry checks, while seam
 * entries must actually execute — both component-export conventions, a fixture
 * module with a real default export, and an entry exporting no component on
 * purpose. Keeping the trees separate lets each fixture answer one question.
 */
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "dev-seam");

const config: ForguncyConfig = {
  cells: {
    orderList: {
      entry: "./cells/order-list/src/index.ts",
      fixture: "./cells/order-list/mock.ts",
      target: { pageName: "销售订单", cell: "A1" },
    },
    customerDetail: {
      entry: "./cells/customer-detail/src/index.ts",
      target: { pageName: "客户详情", cell: "B2" },
    },
    broken: {
      entry: "./cells/broken/src/index.ts",
      target: { pageName: "客户详情", cell: "C3" },
    },
  },
};

let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    root: fixtureRoot,
    // The fixture project deliberately has no vite config of its own, and the
    // workspace root's config must not leak into this isolated run.
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins: [forguncy({ config })],
    server: { middlewareMode: true, hmr: false, watch: null },
  });
});

afterAll(async () => {
  await server?.close();
});

describe("the dev seam under a real Vite dev server", () => {
  it("loads a Cell: registry target verbatim, named-App entry resolved, fixture default export re-exported", async () => {
    const module = await server.ssrLoadModule(cellVirtualModuleId("orderList"));

    expect(module.cellId).toBe("orderList");
    expect(module.target).toEqual({ pageName: "销售订单", cell: "A1", locatorKey: "销售订单#A1" });
    expect(typeof module.Cell).toBe("function");
    expect(module.Cell()).toBe("order-list-app");
    expect(module.fixture).toEqual({ cellProps: { Permissions: { Orders: "read" } } });
  });

  it("prefers the default export and reports no fixture for a Cell that declares none", async () => {
    const module = await server.ssrLoadModule(cellVirtualModuleId("customerDetail"));

    expect(module.Cell()).toBe("customer-detail-app");
    expect(module.fixture).toBeUndefined();
  });

  it("fails a Cell whose entry exports no component, naming the exports it does have", async () => {
    await expect(server.ssrLoadModule(cellVirtualModuleId("broken"))).rejects.toThrowError(
      /Available exports: helper/,
    );
  });
});

/**
 * The pre-normalized-registry path: Issue #28 lets a host normalize the config
 * itself and hand the registry over, and PR review asked for proof that this
 * path *executes* under a real dev server — and that a registry normalized
 * against a different root is refused instead of being resolved against the
 * Vite root. Green here is a local check of this seam, not a Forguncy runtime
 * claim.
 */
describe("a pre-normalized registry under a real Vite dev server", () => {
  it("serves the seam when the registry was normalized against this root", async () => {
    const registry = createCellRegistry(config, { root: fixtureRoot });
    const own = await createServer({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      plugins: [forguncy({ config: registry })],
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      const module = await own.ssrLoadModule(cellVirtualModuleId("orderList"));

      expect(module.cellId).toBe("orderList");
      expect(typeof module.Cell).toBe("function");
      expect(module.Cell()).toBe("order-list-app");
      expect(module.fixture).toEqual({ cellProps: { Permissions: { Orders: "read" } } });
    } finally {
      await own.close();
    }
  });

  it("refuses a registry normalized against a different root at config resolution, naming both roots", async () => {
    // Normalized one directory up, entries declared but not required on disk:
    // what is being tested is the root agreement, not file existence.
    const registry = createCellRegistry(config, {
      root: join(fixtureRoot, ".."),
      requireEntryFiles: false,
    });
    const failure: unknown = await createServer({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      plugins: [forguncy({ config: registry })],
      server: { middlewareMode: true, hmr: false, watch: null },
    }).then(
      async unexpected => {
        await unexpected.close();
        return undefined;
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ForguncyConfigError);
    const configError = failure as ForguncyConfigError;
    expect(configError.codes).toEqual(["registry-root-mismatch"]);
    // The message names the registry's root exactly as this test built it, and
    // Vite's own root — Vite normalizes `config.root` to forward slashes.
    expect(configError.message).toContain(join(fixtureRoot, ".."));
    expect(configError.message).toContain(fixtureRoot.split("\\").join("/"));
  });
});
