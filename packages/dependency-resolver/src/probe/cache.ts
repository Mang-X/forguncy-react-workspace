/**
 * The probe report cache: same fingerprint in, same report out, no rebuild.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #8 (staleness is already decided by comparing
 * `LockProbeEvidence.fingerprint` against `LockEnvironment.probeFingerprints`;
 * this cache is the same comparison applied to a stored report), #16 (a report is
 * cacheable precisely because every step is "a function of the lockfile and the
 * toolchain" — determinism is the precondition, the cache is the payoff).
 *
 * The cache key is the SHA-256 of the composed fingerprint, not the fingerprint
 * itself: fingerprints contain `=`/`;`/`{` characters that are hostile in
 * filenames, and two fingerprints are distinct inputs whose stored documents must
 * not collide on a truncated name. The file *content* carries the fingerprint in
 * the clear as `{ fingerprint, report }` so a hit is verified, not assumed — a
 * hash collision (or a hand-edited file) resolves to a miss rather than returning
 * another candidate's evidence, which would make staleness checks lie.
 *
 * Corruption, an unreadable file, a fingerprint mismatch or a report that fails
 * `parseProbeReport`'s validation all resolve the same way: `null`, i.e. re-run.
 * The cache never throws for bad state, because its failure mode must be "probe
 * again", not "the probe cannot start". `.fgc/` is already git-ignored (it is the
 * Cell compiler's scratch space too), so cached reports never reach a commit —
 * evidence in the lock cites the fingerprint and the cache path, not the bytes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProbeReport } from "@forguncy-react-workspace/core";
import { parseProbeReport } from "@forguncy-react-workspace/core";

/** Where cache files live relative to the project root — also what lock evidence links cite. */
export const PROBE_CACHE_DIRECTORY = ".fgc/probe-cache";

interface CacheDocument {
  readonly fingerprint: string;
  readonly report: ProbeReport;
}

export function probeCacheRelativePath(fingerprint: string): string {
  const hash = createHash("sha256").update(fingerprint, "utf8").digest("hex");
  return `${PROBE_CACHE_DIRECTORY}/${hash}.json`;
}

function cacheAbsolutePath(projectRoot: string, fingerprint: string): string {
  return join(projectRoot, ...probeCacheRelativePath(fingerprint).split("/"));
}

export interface ProbeCache {
  /** The report stored under `fingerprint`, or null on miss, mismatch or corruption. */
  get(fingerprint: string): Promise<ProbeReport | null>;
  /** Stores the report under `fingerprint`. Best-effort: a failed write means the next run misses, nothing more. */
  set(fingerprint: string, report: ProbeReport): Promise<void>;
}

/**
 * The default file-backed cache under `<projectRoot>/.fgc/probe-cache/`.
 *
 * Returned by a factory so the engine can also run with `cache: false` (tests
 * asserting determinism re-run on purpose) without this module growing a mode
 * flag.
 */
export function createFileProbeCache(projectRoot: string): ProbeCache {
  return {
    async get(fingerprint: string): Promise<ProbeReport | null> {
      let text: string;
      try {
        text = await readFile(cacheAbsolutePath(projectRoot, fingerprint), "utf8");
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object") {
        return null;
      }
      const document = parsed as Partial<CacheDocument>;
      if (document.fingerprint !== fingerprint) {
        return null;
      }
      if (typeof document.report !== "object" || document.report === null) {
        return null;
      }
      try {
        // Validation, not trust: a cache hit returns a report that satisfies the
        // same contract a fresh run's report must satisfy, or the caller would
        // be handed weaker evidence than the protocol allows.
        return parseProbeReport(
          JSON.stringify(document.report, null, 2),
        );
      } catch {
        return null;
      }
    },

    async set(fingerprint: string, report: ProbeReport): Promise<void> {
      const path = cacheAbsolutePath(projectRoot, fingerprint);
      const document: CacheDocument = { fingerprint, report };
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      } catch {
        // Best-effort: a read-only or full disk degrades to "always re-probe",
        // which is correct, not exceptional.
      }
    },
  };
}
