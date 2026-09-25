/**
 * The `size` step in isolation: measured size, its band, and an optional cap.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 — this step records the generated artifact size, and a step
 * that measured successfully still *passes*. #21 — the bands the step classifies
 * against, and the unit (characters) the comparison uses. #77 — which separated the
 * advisory band from the project's cap, and then (revision 13) settled that this step
 * may not file the cap verdict *at all*: the probe's build and the compiler's do not
 * share a resolution graph, so the probe measures a synthetic candidate that can be
 * larger than the Cell, and no import surface fixes that. The verdict belongs to the
 * compiler's `auditCodeBudget` on the composed source. Every test below asserts a
 * measurement and facts; none asserts a rejection from this step.
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

  // The report's central separation, and revision 13's whole point: measuring succeeded and the
  // step passes, but a probe measurement never carries a disqualification — the verdict is the
  // compiler's. This is the assertion that the step cannot file the signal at all.
  it("files no rejection for an over-cap candidate under ANY import surface", () => {
    // Both bounds, because revision 12 filed on `lower-bound` and revision 13 retracts that: the
    // probe's build and the compiler's do not share a resolution graph, so even a named-surface
    // measurement can exceed the Cell's. See the module header for the `react-library` fixture
    // that falsifies the lower-bound claim (a *named* probe of `DatePicker` inlines npm React).
    for (const bound of ["lower-leaning", "upper-leaning"] as const) {
      const observation = observeSize([chunk("var a = 12345;")], 4, bound);

      expect(observation.validation.outcome, bound).toBe("passed");
      expect(observation.rejectionFindings, bound).toEqual([]);
    }
  });

  it("reports the over-cap comparison as a fact, so the estimate is still visible", () => {
    // Dropping the rejection must not drop the comparison: an Agent still needs to see that the
    // candidate is over the cap, and the detail must say where the verdict comes from so the
    // number is not acted on as a refusal.
    const observation = observeSize([chunk("var a = 12345;")], 4);

    expect(factValue(observation, "artifact.budgetCharacters")).toBe(4);
    expect(factValue(observation, "size.codeCharacters")).toBe("var a = 12345;".length);
    expect(observation.validation.detail).toContain("over this project's configured cap");
    expect(observation.validation.detail).toMatch(/not a cap verdict/);
    expect(observation.validation.detail).toContain("cell-code-budget-exceeded");
  });

  it("records which way the estimate leans, on every run", () => {
    // The fact that makes the number interpretable. It selects between two *estimates*, not
    // between an estimate and a verdict — see `SizeBound` — so its presence must not be read as
    // authorization.
    expect(factValue(observeSize([chunk("var a = 1;")], null), "size.estimateBias")).toBe("upper-leaning");
    expect(factValue(observeSize([chunk("var a = 1;")], null, "lower-leaning"), "size.estimateBias")).toBe("lower-leaning");
    expect(factValue(observeSize([chunk("var a = 1;")], 4), "size.estimateBias")).toBe("upper-leaning");
  });

  it("defaults to the upper bound, which is the direction that leans over", () => {
    // A namespace probe is the default entry shape, so a caller that passes no `bound` declared
    // no import surface. The default leans over — the *less* flattering direction for the
    // candidate — so a caller cannot get a friendlier estimate by omitting the argument. A cap is
    // passed because the leaning is only stated where it is interpretable, i.e. against a cap.
    const observation = observeSize([chunk("x".repeat(10_000))], 4);

    expect(factValue(observation, "size.estimateBias")).toBe("upper-leaning");
    expect(observation.validation.detail).toContain("kept the whole package namespace");
  });

  it("names the resolution-graph gap as the reason the estimate is not a verdict", () => {
    // The load-bearing sentence. Without it a reader sees a number over a cap and no finding and
    // has to guess whether the step declined to reject or simply forgot; with it, the reason is
    // the one that actually holds — host/extension dependencies resolve differently in the real
    // compile.
    const observation = observeSize([chunk("x".repeat(10_000))], 4);

    expect(observation.validation.detail).toMatch(/host\/extension dependencies/);
    expect(observation.validation.detail).toContain("composed Cell");
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
