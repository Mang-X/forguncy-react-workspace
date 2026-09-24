import { describe, expect, it } from "vitest";

import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import type { SyncCellInput } from "./index.ts";

/**
 * Issue #6's fifth acceptance criterion is that "a generated artifact can be
 * passed directly to the MCP sync layer without additional semantic
 * transformation".
 *
 * That criterion is about the *absence* of a conversion step, which is why it is
 * asserted here rather than in the compiler: the compiler can prove it emits the
 * right shape, but only the consumer's own type can prove that nothing in
 * between has to translate it. A future adapter would have to change this file.
 */
describe("consuming a compiled artifact", () => {
  it("takes a CompileCellResult as-is, with no translation step", () => {
    const artifact: CompileCellResult = {
      code: "/* generated */\nfunction App() { return null; }\n",
      frontendLibraries: [{ libraryId: "lib-echarts" }],
    };

    const input: SyncCellInput = { target: { pageName: "OrderPage", cell: "A1" }, artifact };

    expect(input.artifact).toBe(artifact);
    expect(input.artifact.frontendLibraries.map(library => library.libraryId)).toEqual(["lib-echarts"]);
  });

  // The failure this pins down is the one an adapter would introduce: a second
  // name for the metadata field, accepted silently because it type-checks as
  // `any`-ish JSON rather than as the contract.
  it("refuses an artifact whose metadata field is named differently", () => {
    const wrong = { code: "x", libraries: [] };

    // @ts-expect-error a second metadata field name is exactly the adapter this contract forbids
    const input: SyncCellInput = { target: { pageName: "OrderPage", cell: "A1" }, artifact: wrong };

    expect(input).toBeDefined();
  });
});
