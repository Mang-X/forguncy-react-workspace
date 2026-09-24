import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  GOVERNING_ARCHITECTURE_DECISIONS,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  RUNTIME_CONTRACT_DECISION,
} from "@forguncy-react-workspace/core";

import {
  RUNTIME_FACADE_CITATION_PATTERNS,
  RUNTIME_FACADE_DECISION,
  RUNTIME_FACADE_DECISION_QUALIFIED_REFERENCE,
  RUNTIME_FACADE_DECISION_REFERENCE,
  RUNTIME_GOVERNING_DECISIONS,
  RUNTIME_GOVERNING_SPEC_REFERENCE_LINE,
} from "./provenance.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

describe("façade decision provenance", () => {
  it("points at Issue #27 as the governing Spec", () => {
    expect(RUNTIME_FACADE_DECISION.issue).toBe(27);
    expect(RUNTIME_FACADE_DECISION.repository).toBe("Mang-X/forguncy-react-workspace");
    expect(RUNTIME_FACADE_DECISION.title).toBe(
      "Spec: typed Forguncy runtime facade for application-owned capabilities",
    );
    expect(RUNTIME_FACADE_DECISION_REFERENCE).toBe("#27");
    expect(RUNTIME_FACADE_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/27",
    );
    expect(RUNTIME_FACADE_DECISION_QUALIFIED_REFERENCE).toBe("Mang-X/forguncy-react-workspace#27");
  });

  // The upstream records are re-exported from `core`, not re-typed here, so a
  // second copy of "#4" cannot drift away from the first.
  it("names its upstream decisions by identity rather than by copy", () => {
    expect(RUNTIME_GOVERNING_DECISIONS).toEqual([
      OWNERSHIP_AND_DEPENDENCY_DECISION,
      RUNTIME_CONTRACT_DECISION,
      RUNTIME_FACADE_DECISION,
    ]);
    expect(RUNTIME_GOVERNING_DECISIONS.slice(0, GOVERNING_ARCHITECTURE_DECISIONS.length)).toEqual([
      ...GOVERNING_ARCHITECTURE_DECISIONS,
    ]);
    // #27 is a downstream façade Spec, so it must not relabel itself as an
    // architecture decision by joining `core`'s list.
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(RUNTIME_FACADE_DECISION);
  });

  it("carries the reference line a PR body or report quotes", () => {
    expect(RUNTIME_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #27");
  });

  it("detects a citation by issue reference or URL", () => {
    expect(citesDecision("#27", RUNTIME_FACADE_DECISION)).toBe(true);
    expect(citesDecision("(see #27)", RUNTIME_FACADE_DECISION)).toBe(true);
    expect(citesDecision(RUNTIME_FACADE_DECISION.url, RUNTIME_FACADE_DECISION)).toBe(true);
    expect(citesDecision(RUNTIME_FACADE_DECISION_QUALIFIED_REFERENCE, RUNTIME_FACADE_DECISION)).toBe(true);
    expect(RUNTIME_FACADE_CITATION_PATTERNS).toHaveLength(3);
  });

  // `#2` is a prefix of `#27` and `#27` is a prefix of `#270`, so a substring
  // match would report a citation of the bootstrap Issue as a citation of this
  // one — and the reverse in the other direction.
  it("does not treat a longer or shorter issue number as a citation of this one", () => {
    expect(citesDecision("#270", RUNTIME_FACADE_DECISION)).toBe(false);
    expect(citesDecision("#272", RUNTIME_FACADE_DECISION)).toBe(false);
    expect(citesDecision("#2", RUNTIME_FACADE_DECISION)).toBe(false);
    expect(citesDecision("Mang-X/forguncy-react-workspace#270", RUNTIME_FACADE_DECISION)).toBe(false);
    expect(
      citesDecision("https://github.com/Mang-X/forguncy-react-workspace/issues/270", RUNTIME_FACADE_DECISION),
    ).toBe(false);
  });

  it("does not accept a citation from another repository", () => {
    expect(citesDecision("https://github.com/other-org/other-repo/issues/27", RUNTIME_FACADE_DECISION)).toBe(
      false,
    );
    expect(citesDecision("other-org/other-repo#27", RUNTIME_FACADE_DECISION)).toBe(false);
    expect(citesDecision("Mang-X/other-repo#27", RUNTIME_FACADE_DECISION)).toBe(false);
  });

  // Repository rules forbid a duplicated `specs/` tree, so the package's own
  // entry point is where the back-reference has to live. This asserts the
  // convention rather than trusting that a comment was remembered.
  it("carries the governing references in the package entry point", () => {
    const index = readPackageFile(join("src", "index.ts"));
    for (const source of RUNTIME_GOVERNING_DECISIONS) {
      expect(citesDecision(index, source), `#${source.issue}`).toBe(true);
    }
  });
});
