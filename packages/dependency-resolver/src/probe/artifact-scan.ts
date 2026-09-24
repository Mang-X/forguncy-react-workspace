/**
 * The `artifact-scan` step: what survived bundling into the emitted chunks.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "emitted chunks, unresolved dynamic
 * imports, and the markers of runtime asset loading", and is the only step that
 * may observe `amd-umd-branch-observed-in-artifact` and
 * `dynamic-module-loading-cannot-be-eliminated`; it may also observe `worker`,
 * `shared-worker`, `import-meta-url-asset`, `runtime-fetch-of-package-asset`,
 * `dynamic-import-or-code-splitting`, `wasm` and `self-contained-runtime-assets`),
 * #7 (the artifact shape — one IIFE, no chunk loading — this step inspects).
 *
 * What the step sees is only what the build produced. When the build failed there
 * is no artifact, and the step reports that as a skip-with-reason rather than a
 * pass over nothing: a skipped step carries no diagnostics and no findings
 * (`validateProbeReport` enforces both), which is exactly right — the `build`
 * step's failure diagnostics already carry the actionable text, and re-deriving a
 * second failure from an absent artifact would put the same failure in two steps.
 *
 * The dynamic-import rule has two tiers because #16 separates them: a surviving
 * dynamic import in the emitted code, or more than one chunk, is the *risk*
 * `dynamic-import-or-code-splitting` (weighed, never automatic); the bundler's own
 * structured `dynamicImports` on the entry chunk — a load the bundler could not
 * eliminate — is the *rejection* `dynamic-module-loading-cannot-be-eliminated`.
 * Risks are deduplicated by signal with the earliest observing step winning, so a
 * marker seen in both the artifact and the source scan is filed once, by the step
 * that observes it first.
 *
 * **Text patterns match masked code, not raw code.** A bundle preserves the comments of
 * everything folded into it, so an artifact's text contains prose that was never a
 * construct. `es-toolkit`'s emitted chunk names `import('node:fs')` and `import('node:vm')`
 * only inside JSDoc `@example` blocks while the chunk's own `dynamicImports` is empty;
 * matching the raw text reported a runtime module load the artifact does not perform.
 * `module-source.ts` holds the mechanism and the reasoning, and
 * {@link matchableChunkCode} is this step's single point of application.
 */

import type {
  ProbeFact,
  ProbeRejectionFinding,
  ProbeRisk,
  ProbeValidationEntry,
} from "@forguncy-react-workspace/core";
import type { OutputAsset, OutputChunk } from "rolldown";

import { sourceWithoutCommentsLenient } from "./module-source.ts";
import { compareStrings, portableText } from "./scan-utils.ts";

/** Marker patterns matched against emitted chunk code. Order does not matter; findings dedupe by signal. */
const RISK_MARKERS: readonly { readonly signal: ProbeRisk["signal"]; readonly pattern: RegExp; readonly label: string }[] = [
  { signal: "worker", pattern: /\bnew\s+Worker\s*\(/, label: "new Worker(" },
  { signal: "shared-worker", pattern: /\bnew\s+SharedWorker\s*\(/, label: "new SharedWorker(" },
  {
    signal: "import-meta-url-asset",
    pattern: /new\s+URL\s*\([^)]*import\.meta\.url/,
    label: "new URL(..., import.meta.url)",
  },
  {
    signal: "runtime-fetch-of-package-asset",
    pattern: /\bfetch\s*\(\s*["'`][^"'`]+\.(?:json|wasm|data|bin|model|bin\.gz)["'`]/,
    label: "fetch of a package-relative data asset",
  },
  {
    signal: "wasm",
    pattern: /\.wasm\b|\bWebAssembly\s*\.\s*(?:instantiate|compile|Module)\b/,
    label: "wasm module reference",
  },
];

/** The AMD/UMD branch marker: only meaningful in the *artifact*, where a wrapper would take it. */
const AMD_UMD_PATTERN = /typeof\s+define\s*===\s*["']function["']|\bdefine\s*\.\s*amd\b/;

const DYNAMIC_IMPORT_CALL_PATTERN = /\bimport\s*\(/;

/**
 * A chunk's code with comments blanked — what every text pattern above matches against.
 *
 * A bundler preserves the license comments and JSDoc of the sources it folds in, so an
 * artifact's text contains plenty of prose that was never code. `es-toolkit`'s emitted
 * chunk names `import('node:fs')` and `import('node:vm')` **only** inside JSDoc
 * `@example` blocks, and matching the raw text reported a surviving dynamic import for
 * a chunk whose bundler-reported `dynamicImports` is empty — a risk the artifact does
 * not carry. The same rule as the source scans, applied to the output: text is not a
 * construct, and a pattern that cannot tell a comment from code is looking at prose.
 *
 * An unparseable chunk keeps its raw text, fail-open: dropping it would turn a false
 * positive into a false negative, which is the worse error.
 *
 * Memoized per chunk by {@link chunkCodeAccessor}: parsing is the expensive half, and
 * an artifact can be megabytes while the marker table has five patterns to try.
 */
function matchableChunkCode(chunk: OutputChunk): string {
  return sourceWithoutCommentsLenient(chunk.code);
}

/** Reads each chunk's matchable code once, however many patterns ask for it. */
function chunkCodeAccessor(): (chunk: OutputChunk) => string {
  const cache = new Map<OutputChunk, string>();
  return chunk => {
    let cached = cache.get(chunk);
    if (cached === undefined) {
      cached = matchableChunkCode(chunk);
      cache.set(chunk, cached);
    }
    return cached;
  };
}

function chunksOf(output: readonly (OutputChunk | OutputAsset)[]): readonly OutputChunk[] {
  return output.filter((item): item is OutputChunk => item.type === "chunk");
}

function assetsOf(output: readonly (OutputChunk | OutputAsset)[]): readonly OutputAsset[] {
  return output.filter((item): item is OutputAsset => item.type === "asset");
}

function summarizeMarkerMatches(
  signal: ProbeRisk["signal"],
  label: string,
  chunks: readonly OutputChunk[],
  projectRoot: string,
  matchableCode: (chunk: OutputChunk) => string,
): { readonly found: boolean; readonly evidence: readonly string[] } {
  const evidence: string[] = [];
  for (const chunk of chunks) {
    if (RISK_MARKERS.find(marker => marker.signal === signal)?.pattern.test(matchableCode(chunk)) === true) {
      evidence.push(`chunk:${chunk.fileName}`);
    }
  }
  // Portable: fileNames are bundler-relative already; belt-and-braces relativize.
  const portable = evidence.map(item => portableText(item, projectRoot)).sort(compareStrings);
  return { found: portable.length > 0, evidence: portable };
}

export interface ArtifactScanObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

export function observeArtifact(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  projectRoot: string,
): ArtifactScanObservation {
  if (output === undefined) {
    // Build did not produce an artifact. The failure already lives in the
    // `build` step's diagnostics; this step records its absence honestly.
    return {
      facts: [],
      risks: [],
      rejectionFindings: [],
      validation: {
        step: "artifact-scan",
        outcome: "skipped",
        detail: "The build did not produce an artifact to scan; see the `build` step's diagnostics.",
        diagnostics: [],
      },
    };
  }

  const chunks = chunksOf(output);
  const assets = assetsOf(output);
  const entry = chunks.find(chunk => chunk.isEntry);
  const matchableCode = chunkCodeAccessor();

  const facts: ProbeFact[] = [
    {
      step: "artifact-scan",
      name: "artifact.chunks",
      value: chunks.map(chunk => chunk.fileName).sort(compareStrings),
    },
    {
      step: "artifact-scan",
      name: "artifact.assets",
      value: assets.map(asset => asset.fileName).sort(compareStrings),
    },
    {
      step: "artifact-scan",
      name: "artifact.chunk-count",
      value: chunks.length,
    },
  ];

  const risks: ProbeRisk[] = [];
  const rejectionFindings: ProbeRejectionFinding[] = [];

  // Tier two first: a load the bundler could not eliminate is the rejection, and
  // filing it before the risk keeps the report's narrative ordered by severity
  // when both apply to the same import.
  const structuredDynamicImports = entry?.dynamicImports ?? [];
  if (structuredDynamicImports.length > 0) {
    rejectionFindings.push({
      signal: "dynamic-module-loading-cannot-be-eliminated",
      step: "artifact-scan",
      summary: `The bundler could not eliminate ${String(structuredDynamicImports.length)} dynamic module load(s); a single-script cell artifact cannot resolve them at runtime.`,
      evidence: structuredDynamicImports.map(id => portableText(`import:${id}`, projectRoot)).sort(compareStrings),
    });
  }

  const survivingDynamicCall = chunks.some(chunk => DYNAMIC_IMPORT_CALL_PATTERN.test(matchableCode(chunk)));
  if (chunks.length > 1 || survivingDynamicCall) {
    risks.push({
      signal: "dynamic-import-or-code-splitting",
      step: "artifact-scan",
      summary:
        chunks.length > 1
          ? `The build emitted ${String(chunks.length)} chunks, so the cell would depend on sibling files being served alongside it.`
          : "The emitted code contains a dynamic import expression, which may cause a runtime module load.",
      evidence:
        chunks.length > 1
          ? chunks.map(chunk => `chunk:${chunk.fileName}`).sort(compareStrings)
          : chunks
              .filter(chunk => DYNAMIC_IMPORT_CALL_PATTERN.test(matchableCode(chunk)))
              .map(chunk => `chunk:${chunk.fileName}`)
              .sort(compareStrings),
    });
  }

  for (const marker of RISK_MARKERS) {
    const match = summarizeMarkerMatches(marker.signal, marker.label, chunks, projectRoot, matchableCode);
    if (match.found) {
      risks.push({
        signal: marker.signal,
        step: "artifact-scan",
        summary: `The artifact references ${marker.label}; the deployment path has to be shown handling it, not assumed to.`,
        evidence: match.evidence,
      });
    }
  }

  if (entry !== undefined && AMD_UMD_PATTERN.test(matchableCode(entry))) {
    rejectionFindings.push({
      signal: "amd-umd-branch-observed-in-artifact",
      step: "artifact-scan",
      summary: "The emitted entry chunk carries an AMD/UMD wrapper branch, which would register against `define` instead of the expected global.",
      evidence: [`chunk:${entry.fileName}`],
    });
  }

  // The positive signal, when nothing external is referenced: everything the
  // artifact needs is inside it. Recorded as a fact (a preference cannot accept).
  const referencesExternal = risks.length > 0 || rejectionFindings.length > 0;
  facts.push({
    step: "artifact-scan",
    name: "signal.self-contained-runtime-assets",
    value: !referencesExternal,
  });

  const validation: ProbeValidationEntry = {
    step: "artifact-scan",
    outcome: "passed",
    detail: `Scanned ${String(chunks.length)} chunk(s) and ${String(assets.length)} asset(s); found ${String(risks.length)} risk marker(s) and ${String(rejectionFindings.length)} disqualifying observation(s).`,
    diagnostics: [],
  };

  return { facts, risks, rejectionFindings, validation };
}
