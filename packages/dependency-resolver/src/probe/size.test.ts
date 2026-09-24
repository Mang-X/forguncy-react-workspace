/**
 * The `size` step in isolation: measured bytes against an optional budget.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — only this step may observe
 * `cell-artifact-budget-exceeded`, and a step that measured successfully still
 * *passes* when the measurement is over budget (the rejection carries the
 * disqualification).
 */

import { describe, expect, it } from "vitest";

import type { OutputAsset, OutputChunk } from "rolldown";

import { measureArtifactSize, observeSize } from "./size.ts";

function chunk(code: string, fileName = "entry.js"): OutputChunk {
  return {
    type: "chunk",
    fileName,
    name: "entry",
    isEntry: true,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    exports: [],
    moduleIds: [],
    code,
  } as unknown as OutputChunk;
}

function asset(fileName: string, source: string | Uint8Array): OutputAsset {
  return { type: "asset", fileName, source } as unknown as OutputAsset;
}

describe("measureArtifactSize", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is one code unit and two UTF-8 bytes; String.length would under-count.
    const size = measureArtifactSize([chunk("var s = 'é';")]);

    expect(size.codeBytes).toBe(Buffer.byteLength("var s = 'é';", "utf8"));
    expect(size.codeBytes).toBeGreaterThan("var s = 'é';".length);
    expect(size.assetBytes).toBe(0);
    expect(size.totalBytes).toBe(size.codeBytes);
  });

  it("adds asset payloads and treats a missing payload as zero", () => {
    const size = measureArtifactSize([
      chunk("var a = 1;"),
      asset("logo.svg", "<svg/>"),
      asset("ghost.bin", undefined as unknown as string),
    ]);

    expect(size.assetBytes).toBe(Buffer.byteLength("<svg/>", "utf8"));
    expect(size.totalBytes).toBe(size.codeBytes + size.assetBytes);
  });
});

describe("observeSize", () => {
  it("skips when the build produced no artifact", () => {
    const observation = observeSize(undefined, null);

    expect(observation.validation.outcome).toBe("skipped");
    expect(observation.validation.diagnostics).toEqual([]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("passes with measured facts and no budget applied", () => {
    const observation = observeSize([chunk("var a = 1;")], null);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.facts.find(fact => fact.name === "size.codeBytes")?.value).toBe(
      Buffer.byteLength("var a = 1;", "utf8"),
    );
    expect(observation.facts.find(fact => fact.name === "artifact.budgetBytes")).toBeUndefined();
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.detail).toContain("no cell budget applies");
  });

  // The report's central separation: measuring succeeded; the rejection finding
  // carries "it does not qualify".
  it("passes the step while filing cell-artifact-budget-exceeded when over budget", () => {
    const observation = observeSize([chunk("var a = 12345;")], 4);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.facts.find(fact => fact.name === "artifact.budgetBytes")?.value).toBe(4);
    const finding = observation.rejectionFindings[0];
    expect(finding?.signal).toBe("cell-artifact-budget-exceeded");
    expect(finding?.step).toBe("size");
    expect(finding?.evidence).toEqual([`total:${String(Buffer.byteLength("var a = 12345;", "utf8"))}`, "budget:4"]);
  });

  it("files no rejection when the artifact fits the budget", () => {
    const observation = observeSize([chunk("var a = 1;")], 1_000_000);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.rejectionFindings).toEqual([]);
  });
});
