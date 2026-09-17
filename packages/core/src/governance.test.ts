import { existsSync, readFileSync } from "node:fs";
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

  it("keeps the durable boundary rules in the repository agent rules", () => {
    const agents = readRepositoryFile("AGENTS.md");
    expect(agents).toMatch(/Forguncy owns the application\. React owns the island\./);
    expect(agents).toMatch(/architectural rejection/i);
    expect(agents).toMatch(/technical bundling failure/i);
    expect(agents).toMatch(/platform conflict/i);
  });

  it("keeps the repository agent rules free of decision links and transient state", () => {
    const agents = readRepositoryFile("AGENTS.md");
    expect(agents).not.toMatch(/https?:\/\//);
    expect(agents).not.toMatch(/github\.com/);
    expect(agents).not.toMatch(/\/issues\//);
    expect(agents).not.toMatch(/#\d+/);
  });

  it("keeps the Spec template carrying a governing-Spec field", () => {
    const specTemplate = readRepositoryFile(join(".github", "ISSUE_TEMPLATE", "spec.yml"));
    expect(specTemplate).toContain("governing_spec");
    expect(citesDecision(specTemplate)).toBe(true);
  });

  it("keeps the PR template asking for the governing Spec Issue", () => {
    const prTemplate = readRepositoryFile(join(".github", "pull_request_template.md"));
    expect(prTemplate).toMatch(/Governing Spec Issue\(s\)/);
  });

  it("does not introduce a duplicated specs/ or plans/ document tree", () => {
    for (const directory of ["specs", "plans"]) {
      expect(existsSync(join(repositoryRoot, directory)), directory).toBe(false);
    }
  });
});
