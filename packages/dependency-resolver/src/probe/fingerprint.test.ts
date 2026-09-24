/**
 * Fingerprint composition: the declared inputs of a probe, and nothing else.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #8 — `LockProbeEvidence.fingerprint` must be "a deterministic
 * function of the declared inputs", recomputable without re-running the probe,
 * and must not fold in the package version, target or toolchain (each has its own
 * staleness reason).
 */

import { describe, expect, it } from "vitest";

import { BUILD_CONFIGURATION_FINGERPRINT } from "./build";
import { composeProbeFingerprint, PROBE_ANALYSIS_REVISION } from "./fingerprint";

describe("composeProbeFingerprint", () => {
  it("composes the documented format from the declared inputs", () => {
    const composed = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { format: "iife" },
      bundlerInput: { format: "iife", platform: "browser" },
    });

    expect(composed.fingerprint).toBe(
      'probe="inline-bundle";entry="es-toolkit";analysis=10;config={"format":"iife"};bundler={"format":"iife","platform":"browser"}',
    );
    expect(composed.probeConfig).toEqual({ format: "iife" });
    expect(composed.bundlerInput).toEqual({ format: "iife", platform: "browser" });
  });

  // The analysis revision is a declared input because nothing else on a lock record
  // can express "the scanner now reads what a browser build reaches". Without it in
  // the fingerprint, a report cached under the old scanning behaviour is served
  // forever and the staleness rules never see the change.
  it("carries the analysis revision, so a scanner change invalidates cached evidence", () => {
    const composed = composeProbeFingerprint({ probeId: "inline-bundle", entry: "es-toolkit" });

    expect(composed.fingerprint).toContain(`analysis=${String(PROBE_ANALYSIS_REVISION)}`);
    // Greater than the revision every pre-fix report was composed under, so no
    // existing cache entry can be mistaken for current evidence.
    expect(PROBE_ANALYSIS_REVISION).toBeGreaterThan(1);
  });

  it("defaults the bundler input to the build module's configuration", () => {
    const composed = composeProbeFingerprint({ probeId: "inline-bundle", entry: "es-toolkit" });

    expect(composed.bundlerInput).toEqual(BUILD_CONFIGURATION_FINGERPRINT);
    // The fingerprint embeds sorted-key JSON (stable across machines), so the
    // assertion sorts the declaration rather than depending on insertion order.
    const sorted = Object.fromEntries(
      Object.entries(BUILD_CONFIGURATION_FINGERPRINT).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(composed.fingerprint).toContain(`bundler=${JSON.stringify(sorted)}`);
  });

  // Sorted-key JSON: `JSON.stringify` preserves insertion order, so two callers
  // supplying the same map in different orders must still compose the same bytes.
  it("is independent of map key insertion order", () => {
    const a = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { a: 1, b: 2 },
      bundlerInput: { x: "1", y: "2" },
    });
    const b = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { b: 2, a: 1 },
      bundlerInput: { y: "2", x: "1" },
    });

    expect(a.fingerprint).toBe(b.fingerprint);
  });

  // Nested maps matter as much as top-level ones: a shallow sort left nested
  // `probeConfig` objects in caller insertion order, so semantically identical
  // configs composed different fingerprints.
  it("is independent of nested object key insertion order", () => {
    const a = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { resolve: { alias: { a: "x", b: "y" } }, jsx: "react-jsx" },
    });
    const b = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { jsx: "react-jsx", resolve: { alias: { b: "y", a: "x" } } },
    });

    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("keeps array order significant (arrays are ordered data)", () => {
    const ab = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { plugins: ["a", "b"] },
    });
    const ba = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { plugins: ["b", "a"] },
    });

    expect(ab.fingerprint).not.toBe(ba.fingerprint);
  });

  it("JSON-encodes probeId and entry so `;`/`=` cannot forge or collide with segments", () => {
    const craftedId = composeProbeFingerprint({
      probeId: 'x";entry="y',
      entry: "plain",
    });
    const plain = composeProbeFingerprint({
      probeId: "x",
      entry: "y",
    });
    const forged = composeProbeFingerprint({
      probeId: "a",
      entry: 'b";config={}',
    });
    const different = composeProbeFingerprint({
      probeId: "a;entry=b",
      entry: '"{}',
    });

    expect(craftedId.fingerprint).not.toBe(plain.fingerprint);
    expect(forged.fingerprint).not.toBe(different.fingerprint);
    expect(craftedId.fingerprint.startsWith('probe="x\\";entry=\\"y"')).toBe(true);
    expect(different.fingerprint).not.toContain(";config={};config=");
  });

  it("folds a non-null budget into the probe configuration", () => {
    const withBudget = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { format: "iife" },
      budget: 4096,
    });
    const withoutBudget = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { format: "iife" },
      budget: null,
    });

    expect(withBudget.probeConfig).toEqual({ format: "iife", budget: 4096 });
    expect(withBudget.fingerprint).toContain('"budget":4096');
    expect(withoutBudget.fingerprint).not.toContain("budget");
    expect(withoutBudget.fingerprint).toBe(
      composeProbeFingerprint({ probeId: "inline-bundle", entry: "es-toolkit", probeConfig: { format: "iife" } })
        .fingerprint,
    );
  });

  it("changes when any declared input changes", () => {
    const base = composeProbeFingerprint({ probeId: "inline-bundle", entry: "es-toolkit" });
    const otherProbe = composeProbeFingerprint({ probeId: "amd-detect", entry: "es-toolkit" });
    const otherEntry = composeProbeFingerprint({ probeId: "inline-bundle", entry: "dayjs" });
    const otherConfig = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { jsx: "react-jsx" },
    });
    const otherBudget = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      budget: 1,
    });

    const fingerprints = [base, otherProbe, otherEntry, otherConfig, otherBudget].map(composed => composed.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  // The exclusion that keeps `LockProbeEvidence.versionIndependent` honest: an
  // upgrade that flag permits must not move the fingerprint, or the record would
  // go stale anyway and report one change twice.
  it("never mentions package version, target or toolchain", () => {
    const fingerprint = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: "es-toolkit",
      probeConfig: { version: undefined },
    }).fingerprint;

    expect(fingerprint).not.toMatch(/version=/);
    expect(fingerprint).not.toMatch(/target=/);
    expect(fingerprint).not.toMatch(/toolchain=/);
    expect(fingerprint).not.toMatch(/vitePlus/i);
  });
});
