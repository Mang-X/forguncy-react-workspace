import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  citesDecision,
  DECISION_CITATION_PATTERNS,
  formatDecisionReference,
  GOVERNING_SPEC_REFERENCE_LINE,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE,
  OWNERSHIP_AND_DEPENDENCY_DECISION_REFERENCE,
  PROJECT_CONFIG_CITATION_PATTERNS,
  PROJECT_CONFIG_DECISION,
  PROJECT_CONFIG_DECISION_QUALIFIED_REFERENCE,
  PROJECT_CONFIG_DECISION_REFERENCE,
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
    expect(citesDecision("#4\n")).toBe(true);
    expect(citesDecision("(#4)")).toBe(true);
    expect(citesDecision("Governing architecture Spec Issue(s): #8")).toBe(false);
    expect(DECISION_CITATION_PATTERNS).toHaveLength(3);
  });

  it("records the project configuration contract as its own governing decision (#26)", () => {
    expect(PROJECT_CONFIG_DECISION.issue).toBe(26);
    expect(PROJECT_CONFIG_DECISION.url).toBe(
      "https://github.com/Mang-X/forguncy-react-workspace/issues/26",
    );
    expect(PROJECT_CONFIG_DECISION_REFERENCE).toBe("#26");
    expect(PROJECT_CONFIG_DECISION_QUALIFIED_REFERENCE).toBe("Mang-X/forguncy-react-workspace#26");

    // Same boundary-aware matching as every other decision, generalized through
    // `citationPatternsFor` so #26 inherits the prefix-safe forms.
    expect(PROJECT_CONFIG_CITATION_PATTERNS).toHaveLength(3);
    for (const pattern of PROJECT_CONFIG_CITATION_PATTERNS) {
      expect(citesDecision("#26", PROJECT_CONFIG_DECISION)).toBe(true);
      expect(pattern.test("Mang-X/forguncy-react-workspace#260")).toBe(false);
      expect(pattern.test("https://github.com/other/repo/issues/26")).toBe(false);
    }
  });

  // Both helpers are exported as the canonical provenance API, so they must
  // agree: whatever `formatDecisionReference()` emits has to read back as a
  // citation.
  it("stays consistent with the reference formatter", () => {
    expect(citesDecision(formatDecisionReference())).toBe(true);
    expect(citesDecision(OWNERSHIP_AND_DEPENDENCY_DECISION.url)).toBe(true);
    expect(citesDecision(OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE)).toBe(true);
    expect(citesDecision("see Mang-X/forguncy-react-workspace#4 for the decision")).toBe(true);
    expect(OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE).toBe("Mang-X/forguncy-react-workspace#4");
    expect(formatDecisionReference()).toContain(OWNERSHIP_AND_DEPENDENCY_DECISION_QUALIFIED_REFERENCE);
  });

  it("does not treat a longer issue number as a citation of this one", () => {
    // `#4` is a prefix of `#40`, `#42`, ... so substring matching would report a
    // citation of an unrelated Issue.
    expect(citesDecision("Governing architecture Spec Issue(s): #40")).toBe(false);
    expect(citesDecision("Governing architecture Spec Issue(s): #42")).toBe(false);
    expect(citesDecision("blocked by #44 and #48")).toBe(false);
    expect(citesDecision("#4a")).toBe(false);
    expect(citesDecision("Mang-X/forguncy-react-workspace#40")).toBe(false);
    expect(citesDecision("Mang-X/forguncy-react-workspace#42")).toBe(false);
    expect(citesDecision("https://github.com/Mang-X/forguncy-react-workspace/issues/40")).toBe(false);
  });

  // The check exists to enforce a back-reference to *this* decision, so another
  // repository's Issue #4 must not satisfy it.
  it("does not accept a citation of a different repository", () => {
    expect(citesDecision("https://github.com/other-org/other-repo/issues/4")).toBe(false);
    expect(citesDecision("https://github.com/Mang-X/other-repo/issues/4")).toBe(false);
    expect(citesDecision("other-org/other-repo#4")).toBe(false);
    expect(citesDecision("Mang-X/other-repo#4")).toBe(false);
    // A longer path that merely ends with the repository name is not the
    // repository-qualified reference either.
    expect(citesDecision("foo/Mang-X/forguncy-react-workspace#4")).toBe(false);
    expect(citesDecision("not-Mang-X/forguncy-react-workspace#4")).toBe(false);
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
