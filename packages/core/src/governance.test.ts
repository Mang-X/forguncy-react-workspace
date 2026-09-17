import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  DECISION_CITATION_TOKENS,
  formatDecisionReference,
  GOVERNING_SPEC_REFERENCE_LINE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
} from "./governance";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

describe("decision provenance", () => {
  it("points at Issue #4 as the governing decision", () => {
    expect(OWNERSHIP_AND_DEPENDENCY_DECISION.issue).toBe(4);
    expect(OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE).toBe("#4");
    expect(OWNERSHIP_AND_DEPENDENCY_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/4",
    );
    expect(GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4");
    expect(formatDecisionReference()).toContain("Mang-X/forguncy-react-workspace#4");
  });

  it("detects a citation by issue reference or URL", () => {
    expect(citesDecision("Governing architecture Spec Issue(s): #4")).toBe(true);
    expect(citesDecision("see https://github.com/Mang-X/forguncy-react-workspace/issues/4")).toBe(true);
    expect(citesDecision("Governing architecture Spec Issue(s): #8")).toBe(false);
    expect(DECISION_CITATION_TOKENS).toContain("#4");
  });

  it("keeps the repository agent rules citing the decision", () => {
    const agents = readRepositoryFile("AGENTS.md");
    expect(citesDecision(agents)).toBe(true);
    expect(agents).toMatch(/platform conflict/i);
  });

  it("keeps the Spec template carrying a governing-Spec field", () => {
    const specTemplate = readRepositoryFile(join(".github", "ISSUE_TEMPLATE", "spec.yml"));
    expect(specTemplate).toContain("governing_spec");
    expect(citesDecision(specTemplate)).toBe(true);
  });

  it("does not introduce a duplicated specs/ or plans/ document tree", () => {
    const prTemplate = readRepositoryFile(join(".github", "pull_request_template.md"));
    expect(prTemplate).toMatch(/Governing Spec Issue\(s\)/);
  });
});
