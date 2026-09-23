/**
 * The `runtime-pattern-scan` step: Worker/WASM/asset patterns in package source.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — this step shares worker/shared-worker/import-meta-url/
 * runtime-fetch with `artifact-scan` and deliberately does **not** observe `wasm`
 * (whose observing steps are the artifact scans alone).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { observeRuntimePatterns } from "./runtime-pattern-scan";

async function packageDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fgc-runtime-patterns-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, "utf8");
  }
  return root;
}

describe("observeRuntimePatterns", () => {
  it("passes with zero patterns for ordinary source", async () => {
    const directory = await packageDir({ "index.js": "export function add(a, b) { return a + b; }\n" });

    const observation = await observeRuntimePatterns(directory);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.risks).toEqual([]);
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(1);
  });

  it("files worker as a risk from source, attributed to this step", async () => {
    const directory = await packageDir({
      "index.js": "export function go() { return new Worker('w.js'); }\n",
    });

    const observation = await observeRuntimePatterns(directory);

    const risk = observation.risks.find(entry => entry.signal === "worker");
    expect(risk?.step).toBe("runtime-pattern-scan");
    expect(risk?.evidence).toEqual(["index.js"]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  // #16's observing-step table: wasm findings belong to artifact-scan and
  // asset-inventory. This step records coverage as a fact, never as a finding.
  it("records wasm source markers as a fact and never as a wasm risk", async () => {
    const directory = await packageDir({
      "index.js": "export async function load() { return WebAssembly.instantiate(bytes); }\n",
    });

    const observation = await observeRuntimePatterns(directory);

    expect(observation.facts.find(fact => fact.name === "runtime.wasm-source-markers")?.value).toEqual(["index.js"]);
    expect(observation.risks.map(risk => risk.signal)).not.toContain("wasm");
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("detects new URL(..., import.meta.url) and shared workers", async () => {
    const directory = await packageDir({
      "index.js": [
        "export const u = new URL('./asset.png', import.meta.url);",
        "export function s() { return new SharedWorker('s.js'); }",
        "",
      ].join("\n"),
    });

    const observation = await observeRuntimePatterns(directory);

    expect(observation.risks.map(risk => risk.signal).sort()).toEqual(["import-meta-url-asset", "shared-worker"]);
  });

  it("detects a runtime fetch of a package-relative data asset", async () => {
    const directory = await packageDir({
      "index.js": "export async function d() { return fetch('./model.json'); }\n",
    });

    const observation = await observeRuntimePatterns(directory);

    expect(observation.risks.map(risk => risk.signal)).toContain("runtime-fetch-of-package-asset");
  });

  it("reports an empty directory as zero files scanned", async () => {
    const directory = await packageDir({});

    const observation = await observeRuntimePatterns(directory);

    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(0);
    expect(observation.risks).toEqual([]);
  });
});
