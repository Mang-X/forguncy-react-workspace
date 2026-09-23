/**
 * The probe input fingerprint — the value `fgc.lock.json` stores and #8's
 * freshness rules compare.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #8 (rule 2's invalidation: `LockProbeEvidence.fingerprint`
 * must be "a deterministic function of the declared inputs" and "recomputable
 * without re-running the probe"; `LockEnvironment.probeFingerprints` compares it),
 * #16 (the probe protocol whose steps the fingerprint covers).
 *
 * The composition is deliberately **excludes** three things the record models
 * separately: the resolved package version (`resolvedVersion` has its own
 * staleness reason — `package-version-changed`), the Forguncy target
 * (`target`/`forguncy-target-changed`) and the toolchain (`probedWith`/
 * `toolchain-changed`). Folding any of them in here would report one change twice
 * and silently defeat `LockProbeEvidence.versionIndependent`: an upgrade that flag
 * permits would still move a fingerprint containing the version, so the record
 * would go stale anyway. What remains is exactly what the lock's comment lists as
 * this fingerprint's job — the probe id, the entry, the probe configuration (with
 * the budget folded in as a declared input, since a budget change alters what the
 * `size` step concludes) and the bundler input no other field captures.
 *
 * The format (`probe=…;entry=…;config=…;bundler=…`) is stable and human-readable
 * on purpose: a fingerprint appears in lock diffs and in
 * `probe-fingerprint-changed` diagnostics, and an opaque hash would make both
 * unreadable. Sorted JSON for the maps keeps the same inputs composing the same
 * bytes across machines and Node versions.
 */

import { BUILD_CONFIGURATION_FINGERPRINT } from "./build";

/** Sorted-key JSON: `JSON.stringify` preserves insertion order, which would differ per caller. */
function stableJson(value: Readonly<Record<string, unknown>>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

export interface ComposeProbeFingerprintInput {
  /** Which probe ran, e.g. `inline-bundle`. */
  readonly probeId: string;
  /** The entry the synthetic build imports. */
  readonly entry: string;
  /** Probe configuration; the cell budget is folded in as `budget` when present. */
  readonly probeConfig?: Readonly<Record<string, unknown>>;
  /** Bundler input; defaults to the build module's declared configuration. */
  readonly bundlerInput?: Readonly<Record<string, string>>;
  /** Cell artifact budget in bytes, when one applies to this run. */
  readonly budget?: number | null;
}

export interface ComposedProbeFingerprint {
  readonly fingerprint: string;
  /** The exact maps that composed it — the cache key and the diagnostics quote this. */
  readonly probeConfig: Readonly<Record<string, unknown>>;
  readonly bundlerInput: Readonly<Record<string, string>>;
}

/**
 * Composes the fingerprint from the declared inputs, with no package version,
 * target or toolchain in it (see the module header for why each is excluded).
 */
export function composeProbeFingerprint(input: ComposeProbeFingerprintInput): ComposedProbeFingerprint {
  const probeConfig: Record<string, unknown> = { ...input.probeConfig };
  if (input.budget !== undefined && input.budget !== null) {
    probeConfig["budget"] = input.budget;
  }
  const bundlerInput = { ...(input.bundlerInput ?? BUILD_CONFIGURATION_FINGERPRINT) };

  const fingerprint = [
    `probe=${input.probeId}`,
    `entry=${input.entry}`,
    `config=${stableJson(probeConfig)}`,
    `bundler=${stableJson(bundlerInput)}`,
  ].join(";");

  return { fingerprint, probeConfig, bundlerInput };
}
