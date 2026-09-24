import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  EXTENSION_EXTERNALS_DECISION,
  GOVERNING_ARCHITECTURE_DECISIONS,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  RUNTIME_CONTRACT_DECISION,
} from "@forguncy-react-workspace/core";
import { ARTIFACT_CONTRACT_DECISION } from "@forguncy-react-workspace/cell-compiler";

import {
  MCP_SYNC_CITATION_PATTERNS,
  MCP_SYNC_DECISION,
  MCP_SYNC_DECISION_QUALIFIED_REFERENCE,
  MCP_SYNC_DECISION_REFERENCE,
  MCP_SYNC_GOVERNING_DECISIONS,
  MCP_SYNC_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

describe("one-way sync decision provenance", () => {
  it("points at Issue #19 as the governing Spec", () => {
    expect(MCP_SYNC_DECISION.issue).toBe(19);
    expect(MCP_SYNC_DECISION.repository).toBe("Mang-X/forguncy-react-workspace");
    expect(MCP_SYNC_DECISION.title).toBe(
      "Spec: one-way MCP sync from generated artifacts to Forguncy ReactCellType",
    );
    expect(MCP_SYNC_DECISION_REFERENCE).toBe("#19");
    expect(MCP_SYNC_DECISION.url).toBe("https://github.com/Mang-X/forguncy-react-workspace/issues/19");
    expect(MCP_SYNC_DECISION_QUALIFIED_REFERENCE).toBe("Mang-X/forguncy-react-workspace#19");
  });

  // The upstream records are re-exported from the packages that own them rather than
  // re-typed here, so a second copy of "#6" or "#12" cannot drift away from the first.
  it("names its upstream decisions by identity rather than by copy", () => {
    expect(MCP_SYNC_GOVERNING_DECISIONS).toEqual([
      OWNERSHIP_AND_DEPENDENCY_DECISION,
      RUNTIME_CONTRACT_DECISION,
      ARTIFACT_CONTRACT_DECISION,
      EXTENSION_EXTERNALS_DECISION,
      MCP_SYNC_DECISION,
    ]);
    expect(MCP_SYNC_GOVERNING_DECISIONS.slice(0, GOVERNING_ARCHITECTURE_DECISIONS.length)).toEqual([
      ...GOVERNING_ARCHITECTURE_DECISIONS,
    ]);
    // #19 is a deployment Spec downstream of the architecture and artifact decisions, so
    // it must not relabel itself as an architecture decision by joining `core`'s list.
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(MCP_SYNC_DECISION);
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(ARTIFACT_CONTRACT_DECISION);
  });

  it("carries the reference line a PR body or report quotes", () => {
    expect(MCP_SYNC_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #6, #12, #19");
  });

  it("detects a citation by issue reference or URL", () => {
    expect(citesDecision("#19", MCP_SYNC_DECISION)).toBe(true);
    expect(citesDecision("(see #19)", MCP_SYNC_DECISION)).toBe(true);
    expect(citesDecision(MCP_SYNC_DECISION.url, MCP_SYNC_DECISION)).toBe(true);
    expect(citesDecision(MCP_SYNC_DECISION_QUALIFIED_REFERENCE, MCP_SYNC_DECISION)).toBe(true);
    expect(MCP_SYNC_CITATION_PATTERNS).toHaveLength(3);
  });

  // `#1` is a prefix of `#19` and `#19` is a prefix of `#190`, so substring matching would
  // report a citation of the bootstrap Issue, or of an unrelated one, as a citation here.
  it("does not treat a longer or shorter issue number as a citation of this one", () => {
    expect(citesDecision("#190", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("#192", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("#1", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("Mang-X/forguncy-react-workspace#190", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("https://github.com/Mang-X/forguncy-react-workspace/issues/190", MCP_SYNC_DECISION)).toBe(
      false,
    );
  });

  it("does not accept a citation from another repository", () => {
    expect(citesDecision("https://github.com/other-org/other-repo/issues/19", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("other-org/other-repo#19", MCP_SYNC_DECISION)).toBe(false);
    expect(citesDecision("Mang-X/other-repo#19", MCP_SYNC_DECISION)).toBe(false);
  });

  // Repository rules forbid a duplicated `specs/` tree, so the package's own entry point is
  // where the back-reference has to live. This asserts the convention rather than trusting
  // that a comment was remembered.
  it("carries the governing references in the package entry point", () => {
    const index = readPackageFile(join("src", "index.ts"));
    for (const source of MCP_SYNC_GOVERNING_DECISIONS) {
      expect(citesDecision(index, source), `#${source.issue}`).toBe(true);
    }
  });
});
