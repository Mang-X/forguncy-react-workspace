/**
 * The `artifact-scan` step in isolation: markers in emitted chunks.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — only this step may observe
 * `amd-umd-branch-observed-in-artifact` and
 * `dynamic-module-loading-cannot-be-eliminated`.
 */

import { describe, expect, it } from "vitest";

import type { OutputAsset, OutputChunk } from "rolldown";

import { observeArtifact } from "./artifact-scan";

function chunk(partial: Partial<OutputChunk> & { readonly code: string }): OutputChunk {
  return {
    type: "chunk",
    fileName: "entry.js",
    name: "entry",
    isEntry: true,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    exports: [],
    moduleIds: [],
    ...partial,
  } as OutputChunk;
}

const PROJECT = "/virtual/project";

describe("observeArtifact", () => {
  it("skips with a reason when the build produced no artifact", () => {
    const observation = observeArtifact(undefined, PROJECT);

    expect(observation.validation.outcome).toBe("skipped");
    expect(observation.validation.diagnostics).toEqual([]);
    expect(observation.facts).toEqual([]);
    expect(observation.risks).toEqual([]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("records chunk inventory facts and a self-contained positive signal", () => {
    const observation = observeArtifact([chunk({ code: "var a = 1;" })], PROJECT);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.facts.find(fact => fact.name === "artifact.chunks")?.value).toEqual(["entry.js"]);
    expect(observation.facts.find(fact => fact.name === "artifact.chunk-count")?.value).toBe(1);
    expect(observation.facts.find(fact => fact.name === "signal.self-contained-runtime-assets")?.value).toBe(true);
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.risks).toEqual([]);
  });

  // Tier two of the dynamic-import rule: the bundler's own structured
  // `dynamicImports` is a load it could not eliminate.
  it("files dynamic-module-loading-cannot-be-eliminated for a structured dynamic import", () => {
    const observation = observeArtifact([chunk({ code: "var a = 1;", dynamicImports: ["./lazy.js"] })], PROJECT);

    const finding = observation.rejectionFindings.find(
      entry => entry.signal === "dynamic-module-loading-cannot-be-eliminated",
    );
    expect(finding?.step).toBe("artifact-scan");
    expect(finding?.evidence.some(item => item.includes("lazy.js"))).toBe(true);
  });

  it("files amd-umd-branch-observed-in-artifact for an AMD wrapper branch", () => {
    const observation = observeArtifact(
      [chunk({ code: 'if (typeof define === "function" && define.amd) { define([], factory); }' })],
      PROJECT,
    );

    expect(observation.rejectionFindings.map(finding => finding.signal)).toContain(
      "amd-umd-branch-observed-in-artifact",
    );
  });

  it("files worker as a risk, never a rejection", () => {
    const observation = observeArtifact([chunk({ code: "new Worker(new URL('./w.js', import.meta.url));" })], PROJECT);

    expect(observation.risks.map(risk => risk.signal)).toContain("worker");
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("reports multi-chunk output as the code-splitting risk", () => {
    const observation = observeArtifact(
      [chunk({ code: "var a = 1;", fileName: "a.js" }), chunk({ code: "var b = 2;", fileName: "b.js" })],
      PROJECT,
    );

    const risk = observation.risks.find(entry => entry.signal === "dynamic-import-or-code-splitting");
    expect(risk).toBeDefined();
    expect(risk?.evidence).toEqual(["chunk:a.js", "chunk:b.js"]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("clears the self-contained signal when a risk marker is present", () => {
    const observation = observeArtifact([chunk({ code: "new Worker('w.js');" })], PROJECT);

    expect(observation.facts.find(fact => fact.name === "signal.self-contained-runtime-assets")?.value).toBe(false);
  });

  it("ignores assets when classifying chunks", () => {
    const asset = {
      type: "asset",
      fileName: "logo.svg",
      source: "<svg/>",
    } as unknown as OutputAsset;
    const observation = observeAssetOnly([asset, chunk({ code: "var a = 1;" })], PROJECT);

    expect(observation.facts.find(fact => fact.name === "artifact.assets")?.value).toEqual(["logo.svg"]);
    expect(observation.validation.outcome).toBe("passed");
  });
});

function observeAssetOnly(
  output: readonly (OutputChunk | OutputAsset)[],
  projectRoot: string,
): ReturnType<typeof observeArtifact> {
  return observeArtifact(output, projectRoot);
}
