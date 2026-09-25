/**
 * The frozen scanner behaviour of each probe step — the tripwire for
 * `PROBE_ANALYSIS_REVISION`.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe engine".
 *
 * ## What this test is for, and why it is not just another assertion
 *
 * A probe report is cached under a fingerprint composed from the probe's *declared inputs*
 * (`fingerprint.ts`). Those inputs deliberately exclude the package version, the target and the
 * toolchain, because each is modelled separately on the lock record — so nothing in the
 * fingerprint changes when a **scanner's behaviour** changes. `PROBE_ANALYSIS_REVISION` is the
 * declared input that covers that gap, and it is a **manual bump**.
 *
 * That is the hazard this file exists to close. If someone edits a scanner and forgets the bump,
 * every machine with a warm `.fgc/probe-cache/` keeps serving the old report, and **no test
 * fails** — the behaviour changed and the cache key did not. The ten review rounds that produced
 * this engine each found a real defect, and several changed what a scanner reports, so "remember
 * to bump it" is demonstrably not a reliable control.
 *
 * So this test **freezes** the observed facts and findings for a small set of fixtures. Any
 * behavioural change makes it fail, which forces the bump to be a **visible decision** in the
 * diff rather than a remembered one. Updating the expectations below is the intended workflow —
 * the point is that it cannot happen by accident.
 *
 * ## Why the expectations are asserted on the canonical report
 *
 * `canonicalizeProbeReport` sorts facts and risks totally and orders `validation` by
 * `PROBE_STEPS`. Asserting on it rather than on the raw report means incidental churn — a
 * reordered fact, a reworded summary that is not part of the frozen projection — does not fail
 * the test, so a failure here means the *observations* moved rather than the formatting.
 *
 * The projection is deliberately narrow: step outcomes, fact names and values, risk signals with
 * their evidence, and rejection signals. Those are what a decision binds to. It does not freeze
 * `detail` prose or `diagnostics`, which are diagnostics rather than findings and are covered by
 * the step-specific tests.
 *
 * Local checks only: this executes the engine's build step through the workspace Rolldown stack,
 * which is not a Forguncy runtime validation.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { ProbeReport } from "@forguncy-react-workspace/core";
import { canonicalizeProbeReport } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { runDependencyProbe } from "./probe-engine.ts";

const FIXTURES_ROOT = fileURLToPath(new URL("../__fixtures__/probe", import.meta.url));

/**
 * The frozen projection of a report: the observations a decision binds to, and nothing that is
 * formatting.
 */
interface FrozenReport {
  readonly steps: readonly string[];
  readonly facts: readonly string[];
  readonly risks: readonly string[];
  readonly rejections: readonly string[];
}

/**
 * Facts excluded from the projection, and why.
 *
 * A frozen value must move only when a **scanner** changes, or the tripwire fires on unrelated
 * churn and the reader learns to update it without reading. A chunk name is a hash of the whole
 * artifact (so it moves with the bundler or the toolchain, not with a scan) and a size count
 * moves with any bundler release, so all of them are reported by their own step's tests instead.
 *
 * `size.codeCharacters` belongs on this list for exactly the reason the byte counts do, even
 * though it is a *character* count: it is a measurement of a bundler's output, so it moves when
 * Rolldown's codegen does. The band facts below deliberately do **not** — a band is a policy
 * classification rather than a measurement, and freezing which band a fixture lands in is the
 * point: if a scanner change moved a fixture across a band boundary, a reader should see it here.
 */
const VOLATILE_FACT_NAMES: ReadonlySet<string> = new Set([
  "artifact.chunks",
  "size.codeBytes",
  "size.totalBytes",
  "size.codeCharacters",
]);

function freeze(report: ProbeReport): FrozenReport {
  const canonical = canonicalizeProbeReport(report);
  return {
    steps: canonical.validation.map(entry => `${entry.step}=${entry.outcome}`),
    facts: canonical.facts
      .filter(fact => !VOLATILE_FACT_NAMES.has(fact.name))
      .map(fact => `${fact.step}:${fact.name}=${JSON.stringify(fact.value)}`),
    risks: canonical.risks.map(risk => `${risk.signal}@${risk.step}${risk.evidence.length > 0 ? `:${risk.evidence.join("|")}` : ""}`),
    rejections: canonical.rejectionFindings.map(finding => `${finding.signal}@${finding.step}`),
  };
}

/**
 * One fixture whose observations are frozen.
 *
 * Each entry pins the shape a review round found the engine getting wrong, so the freeze covers
 * the behaviour that was actually in question rather than only the happy path. A fixture that
 * exercises nothing is a tripwire that never trips.
 */
interface GoldenCase {
  readonly fixture: string;
  readonly packageName: string;
  readonly expected: FrozenReport;
}

const GOLDEN: readonly GoldenCase[] = [
  {
    // The ordinary path: a pure ESM utility builds, nothing is refused, nothing is weighed.
    fixture: "pure-esm-utility",
    packageName: "tiny-math",
    expected: {
      steps: [
        "package-identity=passed",
        "export-metadata=passed",
        "node-builtin-scan=passed",
        "build=passed",
        "artifact-scan=passed",
        "asset-inventory=passed",
        "runtime-pattern-scan=passed",
        "size=passed",
        "runtime-smoke=skipped",
      ],
      facts: [
        "export-metadata:exports.browser-field-present=false",
        "export-metadata:exports.browser-resolvable=true",
        "export-metadata:exports.map.present=true",
        "export-metadata:exports.types-present=false",
        "node-builtin-scan:graph.entry-resolutions=[]",
        "node-builtin-scan:graph.files-shaken-out=0",
        "node-builtin-scan:graph.native-indicators=[]",
        "node-builtin-scan:graph.node-only-specifiers=[]",
        "node-builtin-scan:graph.packages-scanned=[\"tiny-math@1.0.0\"]",
        "node-builtin-scan:graph.reachable-file-count=1",
        "node-builtin-scan:signal.no-node-builtins=true",
        "build:build.entry-specifier=\"tiny-math\"",
        "build:build.warning-codes=[]",
        "artifact-scan:artifact.assets=[]",
        "artifact-scan:artifact.chunk-count=1",
        "artifact-scan:signal.self-contained-runtime-assets=true",
        "asset-inventory:assets.by-class=[]",
        "asset-inventory:assets.emitted-count=0",
        "asset-inventory:assets.inlinedDataUrlCount=0",
        "asset-inventory:signal.self-contained-runtime-assets=true",
        "runtime-pattern-scan:runtime.entry-paths=[\"index.js\"]",
        "runtime-pattern-scan:runtime.files-shaken-out=0",
        "runtime-pattern-scan:runtime.filesScanned=1",
        "runtime-pattern-scan:runtime.patterns=[]",
        "runtime-pattern-scan:runtime.wasm-source-markers=[]",
        "size:size.assetBytes=0",
        "size:size.band=\"inline\"",
        "size:size.band.basis=\"characters of emitted code\"",
        "size:size.band.decision=\"https://github.com/Mang-X/forguncy-react-workspace/issues/21\"",
      ],
      risks: [],
      rejections: [],
    },
  },
  {
    // The Worker/WASM case: risks are surfaced and weighed, never turned into a rejection.
    fixture: "worker-wasm-risk",
    packageName: "heavy-parser",
    expected: {
      steps: [
        "package-identity=passed",
        "export-metadata=passed",
        "node-builtin-scan=passed",
        "build=passed",
        "artifact-scan=passed",
        "asset-inventory=passed",
        "runtime-pattern-scan=passed",
        "size=passed",
        "runtime-smoke=skipped",
      ],
      facts: [
        "export-metadata:exports.browser-field-present=false",
        "export-metadata:exports.browser-resolvable=true",
        "export-metadata:exports.map.present=true",
        "export-metadata:exports.types-present=false",
        "node-builtin-scan:graph.entry-resolutions=[]",
        "node-builtin-scan:graph.files-shaken-out=0",
        "node-builtin-scan:graph.native-indicators=[]",
        "node-builtin-scan:graph.node-only-specifiers=[]",
        "node-builtin-scan:graph.packages-scanned=[\"heavy-parser@3.4.1\"]",
        "node-builtin-scan:graph.reachable-file-count=1",
        "node-builtin-scan:signal.no-node-builtins=true",
        "build:build.entry-specifier=\"heavy-parser\"",
        "build:build.warning-codes=[\"EMPTY_IMPORT_META\"]",
        "artifact-scan:artifact.assets=[]",
        "artifact-scan:artifact.chunk-count=1",
        "artifact-scan:signal.self-contained-runtime-assets=false",
        "asset-inventory:assets.by-class=[]",
        "asset-inventory:assets.emitted-count=0",
        "asset-inventory:assets.inlinedDataUrlCount=0",
        "asset-inventory:signal.self-contained-runtime-assets=true",
        "runtime-pattern-scan:runtime.entry-paths=[\"index.js\"]",
        "runtime-pattern-scan:runtime.files-shaken-out=0",
        "runtime-pattern-scan:runtime.filesScanned=1",
        "runtime-pattern-scan:runtime.patterns=[\"import-meta-url-asset\",\"worker\"]",
        "runtime-pattern-scan:runtime.wasm-source-markers=[\"index.js\"]",
        "size:size.assetBytes=0",
        "size:size.band=\"inline\"",
        "size:size.band.basis=\"characters of emitted code\"",
        "size:size.band.decision=\"https://github.com/Mang-X/forguncy-react-workspace/issues/21\"",
      ],
      risks: [
        "import-meta-url-asset@runtime-pattern-scan:index.js",
        "wasm@artifact-scan:chunk:d3e691df42eb0498.js",
        "worker@artifact-scan:chunk:d3e691df42eb0498.js",
      ],
      rejections: [],
    },
  },
  {
    // The case the whole change exists for: a Node-only package is refused, and the refusal
    // cites the builtin it was refused for.
    fixture: "node-only",
    packageName: "config-from-disk",
    expected: {
      steps: [
        "package-identity=passed",
        "export-metadata=passed",
        "node-builtin-scan=passed",
        "build=failed",
        "artifact-scan=skipped",
        "asset-inventory=skipped",
        "runtime-pattern-scan=passed",
        "size=skipped",
        "runtime-smoke=skipped",
      ],
      facts: [
        "export-metadata:exports.browser-field-present=false",
        "export-metadata:exports.browser-resolvable=true",
        "export-metadata:exports.map.present=true",
        "export-metadata:exports.types-present=false",
        "node-builtin-scan:graph.entry-resolutions=[]",
        "node-builtin-scan:graph.files-shaken-out=0",
        "node-builtin-scan:graph.native-indicators=[]",
        "node-builtin-scan:graph.node-only-specifiers=[\"node:fs\",\"node:os\"]",
        "node-builtin-scan:graph.packages-scanned=[\"config-from-disk@0.9.0\"]",
        "node-builtin-scan:graph.reachable-file-count=1",
        "runtime-pattern-scan:runtime.entry-paths=[\"index.js\"]",
        "runtime-pattern-scan:runtime.files-shaken-out=0",
        "runtime-pattern-scan:runtime.filesScanned=1",
        "runtime-pattern-scan:runtime.patterns=[]",
        "runtime-pattern-scan:runtime.wasm-source-markers=[]",
      ],
      risks: [],
      rejections: [
        "node-filesystem-process-or-native-addon@node-builtin-scan",
      ],
    },
  },
  {
    // The artifact bound: a finding may not be drawn from a file the build shook out, and the
    // fact recording the exclusion has to stay honest.
    fixture: "shaken-out-native",
    packageName: "shaken-native",
    expected: {
      steps: [
        "package-identity=passed",
        "export-metadata=passed",
        "node-builtin-scan=passed",
        "build=passed",
        "artifact-scan=passed",
        "asset-inventory=passed",
        "runtime-pattern-scan=passed",
        "size=passed",
        "runtime-smoke=skipped",
      ],
      facts: [
        "export-metadata:exports.browser-field-present=false",
        "export-metadata:exports.browser-resolvable=true",
        "export-metadata:exports.map.present=true",
        "export-metadata:exports.types-present=false",
        "node-builtin-scan:graph.entry-resolutions=[]",
        "node-builtin-scan:graph.files-shaken-out=1",
        "node-builtin-scan:graph.native-indicators=[]",
        "node-builtin-scan:graph.node-only-specifiers=[]",
        "node-builtin-scan:graph.packages-scanned=[\"shaken-native@1.0.0\"]",
        "node-builtin-scan:graph.reachable-file-count=2",
        "node-builtin-scan:signal.no-node-builtins=true",
        "build:build.entry-specifier=\"shaken-native\"",
        "build:build.warning-codes=[]",
        "artifact-scan:artifact.assets=[]",
        "artifact-scan:artifact.chunk-count=1",
        "artifact-scan:signal.self-contained-runtime-assets=true",
        "asset-inventory:assets.by-class=[]",
        "asset-inventory:assets.emitted-count=0",
        "asset-inventory:assets.inlinedDataUrlCount=0",
        "asset-inventory:signal.self-contained-runtime-assets=true",
        "runtime-pattern-scan:runtime.entry-paths=[\"index.js\"]",
        "runtime-pattern-scan:runtime.files-shaken-out=1",
        "runtime-pattern-scan:runtime.filesScanned=2",
        "runtime-pattern-scan:runtime.patterns=[]",
        "runtime-pattern-scan:runtime.wasm-source-markers=[]",
        "size:size.assetBytes=0",
        "size:size.band=\"inline\"",
        "size:size.band.basis=\"characters of emitted code\"",
        "size:size.band.decision=\"https://github.com/Mang-X/forguncy-react-workspace/issues/21\"",
      ],
      risks: [],
      rejections: [],
    },
  },
];

describe("frozen scanner behaviour", () => {
  for (const golden of GOLDEN) {
    it(`observes what the frozen projection records: ${golden.fixture}`, async () => {
      const { report } = await runDependencyProbe({
        projectRoot: join(FIXTURES_ROOT, golden.fixture),
        packageName: golden.packageName,
        cache: false,
      });

      // A single deep comparison, so a failure prints the whole projection and the diff names
      // every observation that moved rather than only the first.
      expect(freeze(report)).toEqual(golden.expected);
    });
  }

  it("keeps `PROBE_ANALYSIS_REVISION` in step with the frozen behaviour", async () => {
    // The tie between this file and the revision. The assertion is intentionally weak — it
    // cannot compare a number to a diff — but it fails loudly if the constant is ever removed
    // or reverted while these expectations still encode post-revision behaviour, which is the
    // shape a "bumped it back by accident" edit takes.
    const { PROBE_ANALYSIS_REVISION } = await import("./fingerprint.ts");

    expect(PROBE_ANALYSIS_REVISION).toBeGreaterThanOrEqual(6);
  });
});
