/**
 * The `size` step in isolation: measured size, its band, and an optional cap.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 — only this step may observe
 * `cell-artifact-budget-exceeded`, and a step that measured successfully still
 * *passes* when the measurement is over the cap (the rejection carries the
 * disqualification). #21 — the bands the step classifies against, and the unit
 * (characters) it now compares. #77 — which separated the advisory band from the
 * project's cap and settled that only the cap may reject; and then, on review,
 * settled that only a **lower** bound may: a namespace probe measures an upper
 * bound on what a Cell carries, so an over-cap namespace bundle is a measurement
 * rather than a verdict. The `bound` argument carries that distinction, and its
 * default is the non-rejecting direction.
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

function factValue(observation: { readonly facts: readonly { name: string; value: unknown }[] }, name: string) {
  return observation.facts.find(fact => fact.name === name)?.value;
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

  it("counts characters of code separately from bytes, because they are different quantities", () => {
    // The #77 contract in one assertion: bytes are what the artifact weighs as served,
    // characters are what the product prices and the bands classify. For CJK source the
    // two differ by roughly 3x, which is why one number cannot serve both.
    const code = "const 名称 = '订单列表';";
    const size = measureArtifactSize([chunk(code)]);

    expect(size.codeCharacters).toBe(code.length);
    expect(size.codeBytes).toBe(Buffer.byteLength(code, "utf8"));
    expect(size.codeCharacters).toBeLessThan(size.codeBytes);
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

  it("excludes assets from the character count, because a band is about generated source", () => {
    // A string asset contributes bytes and no characters, so the band classifies the
    // same code identically whether or not a stylesheet sits beside it. That is the
    // compiler's own exclusion, and matching it is what makes the two paths' numbers
    // the same quantity rather than two numbers that happen to be close.
    const code = "var a = 1;";
    const withoutAsset = measureArtifactSize([chunk(code)]);
    const withAsset = measureArtifactSize([chunk(code), asset("style.css", ".a{color:red}".repeat(100))]);

    expect(withAsset.codeCharacters).toBe(withoutAsset.codeCharacters);
    expect(withAsset.totalBytes).toBeGreaterThan(withoutAsset.totalBytes);
  });
});

describe("observeSize", () => {
  it("skips when the build produced no artifact", () => {
    const observation = observeSize(undefined, null);

    expect(observation.validation.outcome).toBe("skipped");
    expect(observation.validation.diagnostics).toEqual([]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("passes with measured facts and no cap applied", () => {
    const observation = observeSize([chunk("var a = 1;")], null);

    expect(observation.validation.outcome).toBe("passed");
    expect(factValue(observation, "size.codeBytes")).toBe(Buffer.byteLength("var a = 1;", "utf8"));
    expect(factValue(observation, "size.codeCharacters")).toBe("var a = 1;".length);
    expect(factValue(observation, "artifact.budgetCharacters")).toBeUndefined();
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.detail).toContain("no cell cap applies");
  });

  it("records the measured band as evidence, with provenance to #21", () => {
    // #77's second acceptance criterion: an Agent can obtain a candidate artifact's band
    // as probe evidence, and the evidence says where the band came from rather than
    // asking the reader to take this report's word for it.
    const observation = observeSize([chunk("var a = 1;")], null);

    expect(factValue(observation, "size.band")).toBe("inline");
    expect(factValue(observation, "size.band.decision")).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/21",
    );
    expect(factValue(observation, "size.band.basis")).toBe("characters of emitted code");
  });

  it("does not reject on a band alone, however large the artifact", () => {
    // The third acceptance criterion, and the one that makes the bands advisory rather
    // than a limit: #21 found no hard product limit, so an artifact in the top band with
    // no cap configured is measured and reported, never refused. `extension-recommended`
    // is a recommendation and must not be reported as a failure.
    const observation = observeSize([chunk("x".repeat(4 * 1024 * 1024))], null);

    expect(factValue(observation, "size.band")).toBe("extension-recommended");
    expect(observation.validation.outcome).toBe("passed");
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("does not reject an at-or-above-review size when no cap is configured", () => {
    // The boundary case the acceptance criteria name explicitly: at the review band and
    // with nothing configured, the answer is "measured, band recorded, nothing refused".
    const observation = observeSize([chunk("x".repeat(512 * 1024 + 1))], null);

    expect(factValue(observation, "size.band")).toBe("review");
    expect(observation.rejectionFindings).toEqual([]);
  });

  // The report's central separation: measuring succeeded; the rejection finding
  // carries "it does not qualify".
  it("passes the step while filing cell-artifact-budget-exceeded when a lower bound is over the cap", () => {
    // `"lower-bound"` is not decoration: it is the argument that makes this rejection sound.
    // The build declared a named import surface, so the Cell certainly carries at least these
    // characters and the composed artifact cannot come in under the cap. See the module header.
    const observation = observeSize([chunk("var a = 12345;")], 4, "lower-bound");

    expect(observation.validation.outcome).toBe("passed");
    expect(factValue(observation, "artifact.budgetCharacters")).toBe(4);
    const finding = observation.rejectionFindings[0];
    expect(finding?.signal).toBe("cell-artifact-budget-exceeded");
    expect(finding?.step).toBe("size");
    expect(finding?.evidence).toContain(`characters:${String("var a = 12345;".length)}`);
    expect(finding?.evidence).toContain("band:inline");
    expect(finding?.evidence).toContain("budgetCharacters:4");
    expect(finding?.evidence).toContain("bound:lower-bound");
  });

  it("blames the cap, not the measurement, when a tight cap rejects an ordinary artifact", () => {
    // The trap the acceptance criteria name: a size inside the measured ordinary range
    // with a tight configured cap. The rejection is real, but it is the *cap's* — the
    // measurement says this artifact is fine, and a summary that read "over budget"
    // without saying so would send the reader looking for a cost problem #21 says is
    // not there. This is the same split `cell-compiler`'s diagnostic makes.
    const observation = observeSize([chunk("var a = 1;")], 4, "lower-bound");

    expect(factValue(observation, "size.band")).toBe("inline");
    const finding = observation.rejectionFindings[0];
    expect(finding?.signal).toBe("cell-artifact-budget-exceeded");
    expect(finding?.summary).toContain("configured cap");
    expect(finding?.summary).toMatch(/rejection is the cap's rather than a cost the measurement found/);
  });

  it("records which way the measurement bounds the Cell, on every run", () => {
    // The fact that makes the other size facts interpretable: a reader seeing a number over a
    // cap needs to know whether that is a verdict or an upper bound, and it must not have to
    // infer it from the entry shape or from the absence of a finding.
    expect(factValue(observeSize([chunk("var a = 1;")], null), "size.bound")).toBe("upper-bound");
    expect(factValue(observeSize([chunk("var a = 1;")], null, "lower-bound"), "size.bound")).toBe("lower-bound");
    expect(factValue(observeSize([chunk("var a = 1;")], 4), "size.bound")).toBe("upper-bound");
  });

  it("defaults to the upper bound, so a caller that declared no surface cannot reject by omission", () => {
    // The direction that matters for safety. A namespace probe is the default entry shape, so a
    // caller who passes no `bound` has declared no import surface — and the default must be the
    // one that files nothing, not the one that files a rejection on evidence the run lacks.
    // Falsified against the old behaviour: before #77's review the default was the rejection.
    const observation = observeSize([chunk("x".repeat(10_000))], 4);

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.outcome).toBe("passed");
  });

  it("reports an over-cap upper bound as a measurement and names the way to get a verdict", () => {
    // The P1-c case in one assertion. A namespace bundle over the cap is NOT a rejection: the
    // Cell may import a fraction of it. Measured on `es-toolkit`, the namespace bundles to
    // 249,750 characters against 2,865 for the single named binding `debounce` — an 87x gap,
    // which is exactly the false rejection this branch exists to refuse.
    const observation = observeSize([chunk("x".repeat(10_000))], 4);

    expect(factValue(observation, "artifact.budgetCharacters")).toBe(4);
    expect(factValue(observation, "size.bound")).toBe("upper-bound");
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.outcome).toBe("passed");
    expect(observation.validation.detail).toContain("upper bound");
    expect(observation.validation.detail).toContain("Re-probe with a declared import surface");
  });

  it("files no rejection when the artifact fits the cap", () => {
    const observation = observeSize([chunk("var a = 1;")], 1_000_000);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("compares the cap against characters, so a CJK artifact is not rejected for its byte weight", () => {
    // The #77 unit trap, at the step that used to get it wrong. 200 CJK characters occupy
    // 600 bytes; a cap of 300 characters admits it, while the old byte comparison against
    // `totalBytes` would have rejected it at roughly a third of its real cost.
    const code = "订".repeat(200);
    const size = measureArtifactSize([chunk(code)]);
    expect(size.codeCharacters).toBe(200);
    expect(size.totalBytes).toBe(600);

    const observation = observeSize([chunk(code)], 300);

    expect(factValue(observation, "size.band")).toBe("inline");
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.detail).toContain("200 character(s) of emitted code");
  });
});
