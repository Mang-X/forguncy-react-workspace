import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import { cellTargetLabel, SYNC_TARGET_LOCATOR } from "./target.ts";
import type { CellTarget, SyncCellInput } from "./target.ts";

/**
 * #19 splits the target in two sentences — "resolve target page + cell from project
 * configuration" and "write/update ReactCellType using page.setCells" — and the split is
 * the design: resolution is not sync's job. The target arrives as an input, which is the
 * strongest available form of "sync targets must be explicit; do not scan-and-overwrite
 * arbitrary React Cells".
 */

const TARGET: CellTarget = { pageName: "OrderPage", cell: "cell-1" };

describe("locating one target", () => {
  it("uses the platform's own field names, not local spellings", () => {
    expect(SYNC_TARGET_LOCATOR.fields).toEqual(["pageName", "cell"]);
    expect(SYNC_TARGET_LOCATOR.established).toContain("api.page.setCells");
  });

  // #26 asked for the locator model to be updated against #5/#19's evidence before it
  // was finalised; the answer is now data, imported from `core` rather than restated.
  it("carries #26's finalization of the locator, resolved from probe evidence", () => {
    expect(SYNC_TARGET_LOCATOR.resolution.status).toBe("final");
    expect(SYNC_TARGET_LOCATOR.resolution.model).toBe("forguncy-page-cell/v0");
    expect(SYNC_TARGET_LOCATOR.resolution.fields).toEqual(["pageName", "cell"]);
    expect(SYNC_TARGET_LOCATOR.resolution.resolvedOpenQuestion).toMatch(/stable page id/i);
    expect(SYNC_TARGET_LOCATOR.resolution.evidence.join("\n")).toMatch(/rename/i);
  });

  it("labels a target as one token for a diagnostic subject", () => {
    expect(cellTargetLabel(TARGET)).toBe("OrderPage!cell-1");
  });
});

describe("what a sync consumes", () => {
  it("is a target and an artifact, with nothing in between", () => {
    const artifact: CompileCellResult = {
      code: `${CELL_ARTIFACT_BANNER}\nfunction App() { return null; }\n`,
      frontendLibraries: [],
    };
    const input: SyncCellInput = { target: TARGET, artifact };

    // #6's fifth acceptance criterion is about the absence of a conversion step, and this
    // interface is the minimal shape it needs. A widened boundary would let "a sync" mean
    // something different per caller.
    expect(Object.keys(input).sort()).toEqual(["artifact", "target"]);
    expect(input.target).toBe(TARGET);
  });
});
