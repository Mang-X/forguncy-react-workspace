import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  citesEveryArchitectureDecision,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  RUNTIME_CONTRACT_DECISION,
} from "@forguncy-react-workspace/core";

import {
  ARTIFACT_CONTRACT_CITATION_PATTERNS,
  ARTIFACT_CONTRACT_DECISION,
  ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE,
  ARTIFACT_CONTRACT_DECISION_REFERENCE,
  COMPILER_GOVERNING_DECISIONS,
  COMPILER_GOVERNING_SPEC_REFERENCE_LINE,
  WORKSPACE_GRAPH_CITATION_PATTERNS,
  WORKSPACE_GRAPH_IMPLEMENTATION,
  WORKSPACE_GRAPH_IMPLEMENTATION_REFERENCE,
  WORKSPACE_SOURCE_DECISION,
} from "./provenance.ts";

const packageSourceDirectory = dirname(fileURLToPath(import.meta.url));

/** Every module of this package, so the citation rule is audited by traversal. */
const packageModules = readdirSync(packageSourceDirectory)
  .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

describe("artifact contract provenance", () => {
  it("points at Issue #6 as the decision this package projects", () => {
    expect(ARTIFACT_CONTRACT_DECISION.issue).toBe(6);
    expect(ARTIFACT_CONTRACT_DECISION.title).toBe(
      "Spec: generated ReactCellType artifact and compiler boundary",
    );
    expect(ARTIFACT_CONTRACT_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/6",
    );
    expect(ARTIFACT_CONTRACT_DECISION_REFERENCE).toBe("#6");
    expect(ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE).toBe(
      "Mang-X/forguncy-react-workspace#6",
    );
  });

  it("keeps the architecture Specs as the upstream decisions, not as copies", () => {
    // The records come from `core`, so a second copy of "#4" cannot drift, and
    // the governing list is built from them rather than beside them.
    expect(COMPILER_GOVERNING_DECISIONS).toEqual([
      OWNERSHIP_AND_DEPENDENCY_DECISION,
      RUNTIME_CONTRACT_DECISION,
      ARTIFACT_CONTRACT_DECISION,
    ]);
    expect(COMPILER_GOVERNING_DECISIONS.map(source => source.issue)).toEqual([4, 5, 6]);
    expect(COMPILER_GOVERNING_DECISIONS).toContain(OWNERSHIP_AND_DEPENDENCY_DECISION);
    expect(COMPILER_GOVERNING_DECISIONS).toContain(RUNTIME_CONTRACT_DECISION);
  });

  // The reference line is what a PR body carries, so it has to read back as a
  // citation of every Spec that governs the change.
  it("carries all three governing decisions in one reference line", () => {
    expect(COMPILER_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #6");
    expect(citesEveryArchitectureDecision(COMPILER_GOVERNING_SPEC_REFERENCE_LINE)).toBe(true);
    expect(citesDecision(COMPILER_GOVERNING_SPEC_REFERENCE_LINE, ARTIFACT_CONTRACT_DECISION)).toBe(true);
  });

  it("detects the artifact contract by reference or URL, and nothing longer", () => {
    expect(ARTIFACT_CONTRACT_CITATION_PATTERNS).toHaveLength(3);
    expect(citesDecision("#6", ARTIFACT_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision("(see #6)", ARTIFACT_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision(ARTIFACT_CONTRACT_DECISION.url, ARTIFACT_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision(ARTIFACT_CONTRACT_DECISION_QUALIFIED_REFERENCE, ARTIFACT_CONTRACT_DECISION)).toBe(true);

    // `#6` is a prefix of `#60`, `#61`, … and the runtime contract records error
    // `#482`, so a substring match would report an unrelated citation.
    expect(citesDecision("blocked by #60 and #61", ARTIFACT_CONTRACT_DECISION)).toBe(false);
    expect(citesDecision("#482", ARTIFACT_CONTRACT_DECISION)).toBe(false);
    expect(citesDecision("https://github.com/other-org/other-repo/issues/6", ARTIFACT_CONTRACT_DECISION)).toBe(false);
  });

  // #15's record, checked with the same rigour as #6's above rather than merely
  // exported: `#15` is a prefix of `#150`, `#151`, … so a substring match would read
  // an unrelated Issue as this one, and the loader's citation test depends on these
  // patterns being exact.
  it("detects the workspace graph implementation Issue by reference or URL", () => {
    expect(WORKSPACE_GRAPH_IMPLEMENTATION.issue).toBe(15);
    expect(WORKSPACE_GRAPH_IMPLEMENTATION_REFERENCE).toBe("#15");
    expect(WORKSPACE_GRAPH_CITATION_PATTERNS).toHaveLength(3);
    expect(citesDecision("#15", WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(true);
    expect(citesDecision("(#15)", WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(true);
    expect(citesDecision(WORKSPACE_GRAPH_IMPLEMENTATION.url, WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(true);

    expect(citesDecision("blocked by #150 and #151", WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(false);
    expect(citesDecision("#14", WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(false);
    // The two records are distinct Issues, so neither pattern answers for the other
    // — which is what keeps the loader's citation test from passing on #14 alone.
    expect(citesDecision(WORKSPACE_SOURCE_DECISION.url, WORKSPACE_GRAPH_IMPLEMENTATION)).toBe(false);
  });
});

// AGENTS.md puts Specs in Issues and forbids a duplicated `specs/` tree, so the
// only durable place for a module to state which Spec decides it is its own
// source. This is the traversal that keeps that statement from being lost one
// file at a time: a module added later must cite #6 or fail here.
describe("citation discipline", () => {
  it("has every module of this package cite the Spec that decides it", () => {
    expect(packageModules.length).toBeGreaterThan(4);

    const uncited: string[] = [];
    for (const name of packageModules) {
      const source = readFileSync(join(packageSourceDirectory, name), "utf8");
      if (!citesDecision(source, ARTIFACT_CONTRACT_DECISION)) uncited.push(name);
    }
    expect(uncited).toEqual([]);
  });

  it("has the boundary module cite both architecture Specs it is downstream of", () => {
    const boundary = readFileSync(join(packageSourceDirectory, "artifact.ts"), "utf8");
    expect(citesDecision(boundary, OWNERSHIP_AND_DEPENDENCY_DECISION)).toBe(true);
    expect(citesDecision(boundary, RUNTIME_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision(boundary, ARTIFACT_CONTRACT_DECISION)).toBe(true);
  });

  // The repository's own rule is about durability, and a comment that names an
  // Issue without the URL still travels badly into a PR body.
  it("keeps the canonical decision URL available to a report", () => {
    expect(citesDecision(`Governing Spec Issue(s): ${ARTIFACT_CONTRACT_DECISION.url}`, ARTIFACT_CONTRACT_DECISION)).toBe(
      true,
    );
  });
});
