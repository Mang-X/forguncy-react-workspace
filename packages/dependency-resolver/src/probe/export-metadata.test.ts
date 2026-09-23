/**
 * The `export-metadata` step in isolation: browser entry resolution from the
 * manifest alone.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — only this step may observe
 * `ssr-or-server-only-without-browser-build`.
 */

import { describe, expect, it } from "vitest";

import type { ResolvedPackageIdentity } from "./identity";
import { observeExportMetadata } from "./export-metadata";

function identity(manifest: Record<string, unknown>): ResolvedPackageIdentity {
  return {
    packageName: typeof manifest["name"] === "string" ? manifest["name"] : "candidate",
    packageVersion: "1.0.0",
    license: "MIT",
    source: "https://github.com/example/candidate",
    directory: "/virtual/package",
    manifest,
  };
}

describe("observeExportMetadata", () => {
  it("accepts a browser-resolvable exports map without filing a rejection", () => {
    const observation = observeExportMetadata(
      identity({
        name: "browser-lib",
        exports: { ".": { browser: "./index.js", default: "./index.js" } },
        types: "index.d.ts",
      }),
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.outcome).toBe("passed");
    expect(observation.facts.find(fact => fact.name === "exports.map.present")?.value).toBe(true);
    expect(observation.facts.find(fact => fact.name === "exports.types-present")?.value).toBe(true);
  });

  it("falls back to browser → module → main when exports is absent", () => {
    const observation = observeExportMetadata(
      identity({ name: "classic-lib", module: "./esm.js", main: "./cjs.js" }),
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "exports.fallback-fields")?.value).toEqual([
      "module",
      "main",
    ]);
  });

  // The one rejection this step may file: no browser entry means no browser
  // artifact, and that is decidable from the manifest alone.
  it("files ssr-or-server-only-without-browser-build for a Node-only entry", () => {
    const observation = observeExportMetadata(
      identity({ name: "server-only", main: "./server.js", exports: { ".": { node: "./server.js" } } }),
    );

    expect(observation.rejectionFindings).toHaveLength(1);
    const finding = observation.rejectionFindings[0]!;
    expect(finding.signal).toBe("ssr-or-server-only-without-browser-build");
    expect(finding.step).toBe("export-metadata");
    expect(finding.evidence).toContain("exports-map-does-not-resolve-for-browser");
    // The step succeeded at observing the absence — a rejection is not a step failure.
    expect(observation.validation.outcome).toBe("passed");
  });

  it("treats a .node-only entry as not browser-resolvable", () => {
    const observation = observeExportMetadata(identity({ name: "native-only", main: "./addon.node" }));

    expect(observation.rejectionFindings.map(finding => finding.signal)).toContain(
      "ssr-or-server-only-without-browser-build",
    );
  });

  it("records peer ranges as a fact when present", () => {
    const observation = observeExportMetadata(
      identity({ name: "peer-lib", main: "./index.js", peerDependencies: { react: ">=18" } }),
    );

    expect(observation.facts.find(fact => fact.name === "peerDependencies.ranges")?.value).toEqual(["react@>=18"]);
  });
});
