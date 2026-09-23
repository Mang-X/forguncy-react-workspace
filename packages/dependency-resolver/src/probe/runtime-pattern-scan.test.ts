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

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedPackageIdentity } from "./identity";
import { observeRuntimePatterns } from "./runtime-pattern-scan";

/**
 * A temporary package whose browser entry is `index.js`, so the scan has a real
 * reachability root to walk from. Files other than `index.js` are reachable only if
 * `index.js` imports them — exactly as in a published package.
 */
async function packageWithEntry(files: Record<string, string>): Promise<ResolvedPackageIdentity> {
  const directory = await mkdtemp(join(tmpdir(), "fgc-runtime-patterns-"));
  const manifest = {
    name: "fgc-test-package",
    version: "1.0.0",
    license: "MIT",
    type: "module",
    exports: { ".": "./index.js" },
  };
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    license: manifest.license,
    source: "https://github.com/example/fgc-test-package",
    directory,
    manifest,
  };
}

describe("observeRuntimePatterns", () => {
  it("passes with zero patterns for ordinary source", async () => {
    const identity = await packageWithEntry({ "index.js": "export function add(a, b) { return a + b; }\n" });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.validation.outcome).toBe("passed");
    expect(observation.risks).toEqual([]);
    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(1);
  });

  it("files worker as a risk from source, attributed to this step", async () => {
    const identity = await packageWithEntry({
      "index.js": "export function go() { return new Worker('w.js'); }\n",
    });

    const observation = await observeRuntimePatterns(identity);

    const risk = observation.risks.find(entry => entry.signal === "worker");
    expect(risk?.step).toBe("runtime-pattern-scan");
    expect(risk?.evidence).toEqual(["index.js"]);
    expect(observation.rejectionFindings).toEqual([]);
  });

  // #16's observing-step table: wasm findings belong to artifact-scan and
  // asset-inventory. This step records coverage as a fact, never as a finding.
  it("records wasm source markers as a fact and never as a wasm risk", async () => {
    const identity = await packageWithEntry({
      "index.js": "export async function load() { return WebAssembly.instantiate(bytes); }\n",
    });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.facts.find(fact => fact.name === "runtime.wasm-source-markers")?.value).toEqual(["index.js"]);
    expect(observation.risks.map(risk => risk.signal)).not.toContain("wasm");
    expect(observation.rejectionFindings).toEqual([]);
  });

  it("detects new URL(..., import.meta.url) and shared workers", async () => {
    const identity = await packageWithEntry({
      "index.js": [
        "export const u = new URL('./asset.png', import.meta.url);",
        "export function s() { return new SharedWorker('s.js'); }",
        "",
      ].join("\n"),
    });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.risks.map(risk => risk.signal).sort()).toEqual(["import-meta-url-asset", "shared-worker"]);
  });

  it("detects a runtime fetch of a package-relative data asset", async () => {
    const identity = await packageWithEntry({
      "index.js": "export async function d() { return fetch('./model.json'); }\n",
    });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.risks.map(risk => risk.signal)).toContain("runtime-fetch-of-package-asset");
  });

  it("reports an empty directory as zero files scanned", async () => {
    const identity = await packageWithEntry({});

    const observation = await observeRuntimePatterns(identity);

    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(0);
    expect(observation.risks).toEqual([]);
  });

  // The defect the first real-package probe exposed: `three` ships optional loaders
  // under `examples/jsm/` that each construct a Worker, and none is reachable from
  // `build/three.module.js`. A tree walk reported a Worker cost the shipped artifact
  // never pays.
  it("ignores a Worker in a file the browser entry cannot reach", async () => {
    const identity = await packageWithEntry({
      "index.js": "export function add(a, b) { return a + b; }\n",
      "examples/jsm/DRACOLoader.js": "export function decode() { return new Worker('draco.js'); }\n",
    });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.risks).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(1);
  });

  it("still reports a Worker in a file the browser entry does reach", async () => {
    const identity = await packageWithEntry({
      "index.js": "export { decode } from './decode.js';\n",
      "decode.js": "export function decode() { return new Worker('w.js'); }\n",
    });

    const observation = await observeRuntimePatterns(identity);

    const risk = observation.risks.find(entry => entry.signal === "worker");
    expect(risk?.evidence).toEqual(["decode.js"]);
    expect(observation.facts.find(fact => fact.name === "runtime.filesScanned")?.value).toBe(2);
  });

  // The second defect: `es-toolkit` names `import('node:fs')` and `import('node:vm')`
  // only inside JSDoc `@example` blocks, and a text match cannot tell that from code.
  it("ignores a pattern quoted in a comment", async () => {
    const identity = await packageWithEntry({
      "index.js": [
        "/**",
        " * @example",
        " * const worker = new Worker('w.js');",
        " * const u = new URL('./a.png', import.meta.url);",
        " */",
        "export function add(a, b) { return a + b; }",
        "",
      ].join("\n"),
    });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.risks).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "runtime.wasm-source-markers")?.value).toEqual([]);
  });

  it("records the resolved entry paths as a coverage fact", async () => {
    const identity = await packageWithEntry({ "index.js": "export const a = 1;\n" });

    const observation = await observeRuntimePatterns(identity);

    expect(observation.facts.find(fact => fact.name === "runtime.entry-paths")?.value).toEqual(["index.js"]);
  });
});
