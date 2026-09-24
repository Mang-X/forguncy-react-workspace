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
 *
 * **The scan is bounded by browser-entry reachability**, for the same reason
 * `node-builtin-scan` is (see `module-source.ts` for the full account). The first
 * real-package probe showed why: `three` published optional loaders under
 * `examples/jsm/` (`DRACOLoader`, `KTX2Loader`, a bundled `fflate`, a lottie canvas)
 * that each construct a Worker, and none of them is reachable from
 * `build/three.module.js` — so a plain tree walk reported a Worker risk for a package
 * whose actual entry contains no `new Worker(` at all. A risk is a claim that a cost
 * has to be weighed, and a cost the shipped artifact does not pay is not a cost.
 *
 * Files are matched through the same masked source `node-builtin-scan` uses, so a
 * pattern quoted in a comment is documentation rather than a declaration.
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";

import { applyBrowserField, resolveBrowserEntryPaths, selfReferenceResolver } from "./browser-entry";
import type { ResolvedPackageIdentity } from "./identity";
import { collectReachableSourceFiles } from "./module-source";
import { compareStrings } from "./scan-utils";

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

/**
 * Runs the source scan against the files a browser build reaches.
 *
 * `bundledFiles` is the set of package-relative files the **build actually included**, when a
 * build ran. It exists because reachability and bundling are not the same set, and the
 * difference is reported: rolldown tree-shakes a module whose bindings are unused, while the
 * walk — which applies no tree-shaking — still reaches it. Measured on a package with an
 * unused named import, `new Worker(` in the unused module, and *no* `sideEffects` field:
 * rolldown shook the file out and produced an artifact containing no such call, while this step
 * reported `worker` with that file as evidence. A risk a consumer has to weigh is a claim about
 * the artifact, so a file outside the artifact cannot support one — the same rule the
 * reachability bound applies, one level further in.
 *
 * When the build failed there is no artifact and therefore no set to bound by; the step still
 * runs (it reads source, which is meaningful either way) and reports what it finds, which is
 * the documented reason it does not cascade into a skip.
 */
export async function observeRuntimePatterns(
  identity: ResolvedPackageIdentity,
  bundledFiles?: ReadonlySet<string>,
): Promise<RuntimePatternObservation> {
  const { entries } = resolveBrowserEntryPaths(identity.manifest);
  const reachable = await collectReachableSourceFiles(
    identity.directory,
    entries,
    selfReferenceResolver(identity.manifest),
    request => applyBrowserField(identity.manifest, request),
  );
  const files = reachable.files;

  // When a build ran, only files the artifact contains can support a finding. The walk reaches
  // more than the bundler keeps (see the doc comment), and a risk drawn from a shaken-out file
  // describes an artifact that does not exist.
  const inArtifact: ReadonlySet<string> | null = bundledFiles ?? null;

  const hits = new Map<ProbeRisk["signal"], { readonly label: string; readonly evidence: string[] }>();
  const wasmEvidence: string[] = [];
  let filesScanned = 0;
  let filesShakenOut = 0;

  for (const file of files) {
    filesScanned += 1;
    const relative = file.relativePath;
    if (inArtifact !== null && !inArtifact.has(file.absolutePath)) {
      // Reached but not bundled: recorded in `runtime.files-shaken-out` below so the exclusion
      // is visible rather than an unexplained absence.
      filesShakenOut += 1;
      continue;
    }
    // `masked`: a pattern quoted in a comment is documentation about the code, not
    // a declaration of a runtime requirement.
    for (const entry of SOURCE_PATTERNS) {
      if (!entry.pattern.test(file.masked)) {
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
    if (WASM_SOURCE_PATTERN.test(file.masked)) {
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
      name: "runtime.files-shaken-out",
      value: filesShakenOut,
    },
    {
      step: "runtime-pattern-scan",
      name: "runtime.entry-paths",
      value: [...entries],
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
