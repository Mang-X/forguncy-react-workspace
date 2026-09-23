/**
 * The `asset-inventory` step: every stylesheet, font, image and data file the
 * artifact references, and whether it is inlined.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "every stylesheet, font, image and data
 * file the artifact references, and whether it is inlined", and is the only step
 * that may observe `css-font-or-image-assets`; it may also observe `wasm` and
 * `self-contained-runtime-assets`), #6 (the artifact shape whose embeddability
 * this measures).
 *
 * Every inventory entry is a **risk**, never a rejection: #16 says Worker/WASM/
 * runtime-asset findings are investigated, not assumed broken, and the rejection
 * `runtime-assets-not-embeddable` is reserved for an observation that the chosen
 * target path can neither inline nor serve — a judgement no static inventory can
 * make on its own. The `inlinedDataUrlCount` fact is the other half of the
 * picture: assets already folded into the code as `data:` URIs are self-contained
 * by construction, and reporting them alongside the emitted files keeps "this
 * package ships a font" from reading as "this package needs a sibling file".
 *
 * When the build failed there is nothing to inventory, and the step records that
 * as a skip-with-reason (no diagnostics, no findings — the `build` failure owns
 * the actionable text).
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";
import type { OutputAsset, OutputChunk } from "rolldown";

import { compareStrings, portableText } from "./scan-utils";

interface AssetClass {
  readonly id: string;
  readonly extensions: readonly string[];
}

/** Classification groups match the signal: one risk per group, not one per file. */
const ASSET_CLASSES: readonly AssetClass[] = [
  { id: "stylesheet", extensions: [".css", ".scss", ".sass", ".less"] },
  { id: "font", extensions: [".woff", ".woff2", ".ttf", ".otf", ".eot"] },
  {
    id: "image",
    extensions: [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp"],
  },
  { id: "wasm", extensions: [".wasm"] },
];

const DATA_URL_PATTERN = /data:[^;)]+;base64,/g;

function classify(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  const hit = ASSET_CLASSES.find(assetClass => assetClass.extensions.some(extension => lower.endsWith(extension)));
  return hit?.id;
}

function countInlineDataUrls(chunks: readonly OutputChunk[]): number {
  let count = 0;
  for (const chunk of chunks) {
    DATA_URL_PATTERN.lastIndex = 0;
    while (DATA_URL_PATTERN.exec(chunk.code) !== null) {
      count += 1;
    }
  }
  return count;
}

export interface AssetInventoryObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

export function observeAssets(
  output: readonly (OutputChunk | OutputAsset)[] | undefined,
  projectRoot: string,
): AssetInventoryObservation {
  if (output === undefined) {
    return {
      facts: [],
      risks: [],
      rejectionFindings: [],
      validation: {
        step: "asset-inventory",
        outcome: "skipped",
        detail: "The build did not produce an artifact to inventory; see the `build` step's diagnostics.",
        diagnostics: [],
      },
    };
  }

  const assets = output.filter((item): item is OutputAsset => item.type === "asset");
  const chunks = output.filter((item): item is OutputChunk => item.type === "chunk");

  const byClass = new Map<string, string[]>();
  for (const asset of assets) {
    const assetClass = classify(asset.fileName);
    if (assetClass === undefined) {
      continue;
    }
    let list = byClass.get(assetClass);
    if (list === undefined) {
      list = [];
      byClass.set(assetClass, list);
    }
    list.push(portableText(`asset:${asset.fileName}`, projectRoot));
  }
  for (const [assetClass, list] of byClass) {
    byClass.set(assetClass, [...new Set(list)].sort(compareStrings));
  }

  const inlinedDataUrlCount = countInlineDataUrls(chunks);

  const facts: ProbeFact[] = [
    {
      step: "asset-inventory",
      name: "assets.by-class",
      // Flattened to `class:path` strings so one fact carries the whole
      // inventory in the report's canonical string-array form.
      value: [...byClass.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .flatMap(([assetClass, files]) => files.map(file => `${assetClass}:${file}`)),
    },
    {
      step: "asset-inventory",
      name: "assets.emitted-count",
      value: assets.length,
    },
    {
      step: "asset-inventory",
      name: "assets.inlinedDataUrlCount",
      value: inlinedDataUrlCount,
    },
  ];

  const risks: ProbeRisk[] = [];
  const rejectionFindings: ProbeRejectionFinding[] = [];

  // Group stylesheet/font/image into the one combined signal they map to, with
  // one finding carrying every file as evidence.
  const combinedFiles = ["stylesheet", "font", "image"]
    .flatMap(assetClass => byClass.get(assetClass) ?? [])
    .sort(compareStrings);
  if (combinedFiles.length > 0) {
    risks.push({
      signal: "css-font-or-image-assets",
      step: "asset-inventory",
      summary: `The artifact emits ${String(combinedFiles.length)} stylesheet, font or image file(s) that the deployment path has to inline or otherwise represent.`,
      evidence: combinedFiles,
    });
  }

  const wasmFiles = (byClass.get("wasm") ?? []).sort(compareStrings);
  if (wasmFiles.length > 0) {
    risks.push({
      signal: "wasm",
      step: "asset-inventory",
      summary: `The artifact emits ${String(wasmFiles.length)} WASM file(s), an extra asset with its own loading and MIME behaviour.`,
      evidence: wasmFiles,
    });
  }

  // `runtime-assets-not-embeddable` is deliberately absent: a static inventory
  // sees what exists, not whether the chosen target can represent it. That
  // judgement needs the deployment path, and filing it here would turn "ships a
  // font" into a rejection — exactly the risk/failure conflation #16 forbids.
  const selfContained = combinedFiles.length === 0 && wasmFiles.length === 0;
  facts.push({
    step: "asset-inventory",
    name: "signal.self-contained-runtime-assets",
    value: selfContained,
  });

  const validation: ProbeValidationEntry = {
    step: "asset-inventory",
    outcome: "passed",
    detail: `Inventoried ${String(assets.length)} emitted asset(s); ${String(inlinedDataUrlCount)} data URL(s) are already inlined in chunk code.`,
    diagnostics: [],
  };

  return { facts, risks, rejectionFindings, validation };
}
