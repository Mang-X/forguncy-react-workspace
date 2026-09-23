/**
 * The `runtime-pattern-scan` step: runtime-requirement patterns in the package's
 * **source**.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "Worker, SharedWorker, WASM,
 * `new URL(..., import.meta.url)` and runtime `fetch()` of package-relative
 * assets"; it shares `worker`, `shared-worker`, `import-meta-url-asset` and
 * `runtime-fetch-of-package-asset` with `artifact-scan` — and deliberately does
 * **not** observe `wasm`, whose observing steps are `artifact-scan` and
 * `asset-inventory` alone).
 *
 * Why source at all, when the artifact was already scanned: the two see different
 * things. Bundling can inline, rename or drop a pattern the source still declares,
 * and it can fail before any of that happens — in which case the artifact scan is
 * skipped while the package's requirements are still knowable. A pattern found
 * only in source is filed with this step as its `step`, which is what keeps the
 * report's observing-step rule (`validateProbeReport` refuses a finding attributed
 * to a step that cannot see it) honest under both outcomes.
 *
 * WASM is excluded here for the same reason: its catalogue entry observes from
 * `artifact-scan`/`asset-inventory`, and a `WebAssembly.instantiate` call in
 * source that the bundler rewrote away is not an observation about the artifact
 * this step never scanned. The marker still contributes a fact — the scan's job is
 * to *see* — but a fact is not a finding, and only the observing steps may file
 * one.
 *
 * Every pattern here maps to a **risk** signal. None of them rejects: #16 is
 * explicit that Worker/WASM/asset-loading findings are investigated, not assumed
 * broken, and the Agent weighs them against alternatives.
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";

import { compareStrings, relativePortablePath, walkPackageSourceFiles } from "./scan-utils";
import { readFile } from "node:fs/promises";

/**
 * Patterns this step observes. `wasm` is intentionally absent — see the module
 * header: its observing steps are the artifact scans, and this step's catalogue
 * entry does not include it.
 */
const SOURCE_PATTERNS: readonly { readonly signal: ProbeRisk["signal"]; readonly pattern: RegExp; readonly label: string }[] = [
  { signal: "worker", pattern: /\bnew\s+Worker\s*\(/, label: "new Worker(" },
  { signal: "shared-worker", pattern: /\bnew\s+SharedWorker\s*\(/, label: "new SharedWorker(" },
  {
    signal: "import-meta-url-asset",
    pattern: /new\s+URL\s*\([^)]*import\.meta\.url/,
    label: "new URL(..., import.meta.url)",
  },
  {
    signal: "runtime-fetch-of-package-asset",
    pattern: /\bfetch\s*\(\s*["'`][^"'`]+\.(?:json|wasm|data|bin|model)["'`]/,
    label: "fetch of a package-relative data asset",
  },
];

/** Not filed as a finding here (see header); recorded so the scan's coverage is visible. */
const WASM_SOURCE_PATTERN = /\.wasm\b|\bWebAssembly\s*\.\s*(?:instantiate|compile|Module)\b/;

export interface RuntimePatternObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

export async function observeRuntimePatterns(directory: string): Promise<RuntimePatternObservation> {
  const files = await walkPackageSourceFiles(directory);
  const hits = new Map<ProbeRisk["signal"], { readonly label: string; readonly evidence: string[] }>();
  const wasmEvidence: string[] = [];
  let filesScanned = 0;

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    filesScanned += 1;
    const relative = relativePortablePath(directory, file);
    for (const entry of SOURCE_PATTERNS) {
      if (!entry.pattern.test(source)) {
        continue;
      }
      let hit = hits.get(entry.signal);
      if (hit === undefined) {
        hit = { label: entry.label, evidence: [] };
        hits.set(entry.signal, hit);
      }
      if (!hit.evidence.includes(relative)) {
        hit.evidence.push(relative);
      }
    }
    if (WASM_SOURCE_PATTERN.test(source)) {
      wasmEvidence.push(relative);
    }
  }

  const facts: ProbeFact[] = [
    {
      step: "runtime-pattern-scan",
      name: "runtime.filesScanned",
      value: filesScanned,
    },
    {
      step: "runtime-pattern-scan",
      name: "runtime.patterns",
      value: [...hits.keys()].sort(compareStrings),
    },
    {
      step: "runtime-pattern-scan",
      name: "runtime.wasm-source-markers",
      value: [...new Set(wasmEvidence)].sort(compareStrings),
    },
  ];

  const risks: ProbeRisk[] = [...hits.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([signal, hit]) => ({
      signal,
      step: "runtime-pattern-scan" as const,
      summary: `Package source declares ${hit.label}; the deployment path has to be shown handling it.`,
      evidence: [...hit.evidence].sort(compareStrings),
    }));

  return {
    facts,
    risks,
    rejectionFindings: [],
    validation: {
      step: "runtime-pattern-scan",
      outcome: "passed",
      detail: `Scanned ${String(filesScanned)} source file(s); found ${String(risks.length)} runtime-requirement pattern(s).`,
      diagnostics: [],
    } satisfies ProbeValidationEntry,
  };
}
