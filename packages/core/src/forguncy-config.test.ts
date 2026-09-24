import { describe, expect, it } from "vitest";

import {
  CELL_REFERENCE_PATTERN,
  DEFAULT_CODE_MARKER_NAMESPACE,
  DEFAULT_DEPENDENCY_LOCK_PATH,
  DEFAULT_FORGUNCY_CONFIG_FILE,
  FORGUNCY_CONFIG_FILE_CANDIDATES,
  FORGUNCY_CONFIG_SCHEMA_VERSION,
  TARGET_LOCATOR_FINALIZATION,
  TARGET_LOCATOR_MODEL,
  defineForguncyConfig,
  isConfigRecord,
  normalizeCellReference,
  targetLocatorKey,
} from "./forguncy-config.ts";

describe("project config contract", () => {
  it("declares the revision this toolchain understands", () => {
    expect(FORGUNCY_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_FORGUNCY_CONFIG_FILE).toBe("forguncy.config.ts");
    expect(FORGUNCY_CONFIG_FILE_CANDIDATES[0]).toBe(DEFAULT_FORGUNCY_CONFIG_FILE);
    expect(FORGUNCY_CONFIG_FILE_CANDIDATES).toHaveLength(4);
    expect(new Set(FORGUNCY_CONFIG_FILE_CANDIDATES).size).toBe(FORGUNCY_CONFIG_FILE_CANDIDATES.length);
  });

  it("marks the target locator model as a reviewable revision", () => {
    // Spec #26 requires the locator model to be re-derived from #5/#19 evidence
    // before it is final, so the revision has to be visible rather than implied.
    expect(TARGET_LOCATOR_MODEL).toBe("forguncy-page-cell/v0");
  });

  it("finalizes the locator from probe evidence and answers #19's open question", () => {
    // #26's finalization acceptance criterion: the model is final only because a
    // read-only probe established that no stable page id exists to upgrade to.
    expect(TARGET_LOCATOR_FINALIZATION.model).toBe(TARGET_LOCATOR_MODEL);
    expect(TARGET_LOCATOR_FINALIZATION.status).toBe("final");
    expect(TARGET_LOCATOR_FINALIZATION.fields).toEqual(["pageName", "cell"]);
    expect(TARGET_LOCATOR_FINALIZATION.evidence.length).toBeGreaterThanOrEqual(3);
    expect(TARGET_LOCATOR_FINALIZATION.resolvedOpenQuestion).toContain("No stable page id");
    // Rename semantics must keep logical Cell identity in the config key, not in
    // the locator — the rename rule is #26's, independent of the locator model.
    expect(TARGET_LOCATOR_FINALIZATION.renameSemantics).toContain("cells.<id>");
  });

  it("keeps the documented defaults for the runtime target", () => {
    expect(DEFAULT_CODE_MARKER_NAMESPACE).toBe("fgc");
    expect(DEFAULT_DEPENDENCY_LOCK_PATH).toBe("fgc.lock.json");
  });

  it("returns the config it was given, so it is a typing aid and not a transform", () => {
    const config = defineForguncyConfig({
      cells: {
        orderList: {
          entry: "./cells/order-list/src/index.ts",
          target: { pageName: "销售订单", cell: "A1" },
        },
      },
    });

    expect(config.cells.orderList.entry).toBe("./cells/order-list/src/index.ts");
    expect(Object.keys(config)).toEqual(["cells"]);
  });

  it("accepts an empty cells map so a project can adopt the contract early", () => {
    expect(defineForguncyConfig({ cells: {} }).cells).toEqual({});
  });

  it("recognizes A1-style anchors and rejects everything that is not one", () => {
    for (const accepted of ["A1", "a1", "B4", "AB12", "AAA9999999"]) {
      expect(CELL_REFERENCE_PATTERN.test(accepted), accepted).toBe(true);
    }
    for (const rejected of ["", "0", "A0", "1A", "A", "A1:B2", "A 1", "$A$1", "A1 ", "AAAA1"]) {
      expect(CELL_REFERENCE_PATTERN.test(rejected), rejected).toBe(false);
    }
  });

  it("normalizes a cell reference without touching the page name", () => {
    expect(normalizeCellReference("  a1  ")).toBe("A1");
    expect(normalizeCellReference("Ab12")).toBe("AB12");
  });

  it("gives two targets that differ only by case or padding one identity", () => {
    const canonical = targetLocatorKey({ pageName: "销售订单", cell: "A1" });

    expect(targetLocatorKey({ pageName: " 销售订单 ", cell: "a1" })).toBe(canonical);
    expect(targetLocatorKey({ pageName: "销售订单", cell: "D4" })).not.toBe(canonical);
    expect(targetLocatorKey({ pageName: "客户详情", cell: "A1" })).not.toBe(canonical);
    expect(canonical).toBe("销售订单#A1");
  });

  it("distinguishes records from arrays, null and primitives", () => {
    expect(isConfigRecord({})).toBe(true);
    expect(isConfigRecord([])).toBe(false);
    expect(isConfigRecord(null)).toBe(false);
    expect(isConfigRecord("cells")).toBe(false);
    expect(isConfigRecord(1)).toBe(false);
  });
});
