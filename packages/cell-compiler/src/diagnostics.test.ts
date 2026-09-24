import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_GUARANTEE_IDS } from "./guarantees.ts";
import {
  CELL_ARTIFACT_DIAGNOSTIC_CODES,
  CELL_ARTIFACT_DIAGNOSTIC_RULES,
  CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES,
  REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES,
  cellArtifactDiagnosticCodes,
  cellArtifactDiagnosticRule,
  createCellArtifactDiagnostic,
  dedupeCellArtifactDiagnostics,
  formatCellArtifactDiagnostic,
  formatCellArtifactDiagnostics,
  isCellArtifactDiagnosticCode,
} from "./diagnostics.ts";

describe("the error model's required vocabulary", () => {
  // #6 lists six failure modes the compiler must be able to report. Pinned in
  // order because a downstream Issue, Skill or report branches on these codes,
  // so a rename is a breaking change rather than a tidy-up.
  it("names exactly the six failure modes Issue #6 requires", () => {
    expect([...REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES]).toEqual([
      "unresolved-dependency-decision",
      "platform-conflicting-dependency",
      "cell-code-budget-exceeded",
      "unsupported-runtime-asset",
      "missing-extension-mapping",
      "duplicate-host-mapping",
    ]);
  });

  it("prints the required vocabulary before the contract codes", () => {
    expect(CELL_ARTIFACT_DIAGNOSTIC_CODES.slice(0, 6)).toEqual([...REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES]);
    expect(CELL_ARTIFACT_DIAGNOSTIC_CODES.slice(6)).toEqual([...CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES]);
  });

  it("recognises a known code and refuses an invented one", () => {
    expect(isCellArtifactDiagnosticCode("bundler-failure")).toBe(true);
    expect(isCellArtifactDiagnosticCode("build-failed")).toBe(false);
    expect(isCellArtifactDiagnosticCode(undefined)).toBe(false);
    expect(isCellArtifactDiagnosticCode(42)).toBe(false);
  });
});

// The rule table is what makes a diagnostic actionable rather than merely
// informative, so the invariants below are the contract's substance.
describe("diagnostic rules", () => {
  it("has a rule for every code and no code without a rule", () => {
    const ruleCodes = Object.keys(CELL_ARTIFACT_DIAGNOSTIC_RULES).sort();
    expect(ruleCodes).toEqual([...CELL_ARTIFACT_DIAGNOSTIC_CODES].sort());
    for (const code of CELL_ARTIFACT_DIAGNOSTIC_CODES) {
      expect(cellArtifactDiagnosticRule(code).code).toBe(code);
    }
  });

  it("classifies the six required codes as the Spec's own error model", () => {
    for (const code of REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES) {
      expect(cellArtifactDiagnosticRule(code).origin, code).toBe("issue-6-error-model");
    }
    for (const code of CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES) {
      expect(cellArtifactDiagnosticRule(code).origin, code).toBe("issue-6-contract");
    }
  });

  it("gives every rule a statement, a remediation and a fix owner", () => {
    for (const code of CELL_ARTIFACT_DIAGNOSTIC_CODES) {
      const rule = cellArtifactDiagnosticRule(code);
      expect(rule.label.trim().length, code).toBeGreaterThan(0);
      expect(rule.states.trim().length, code).toBeGreaterThan(20);
      // A diagnostic with no remediation is a dead end, which #6's error model
      // exists to avoid.
      expect(rule.remediation.trim().length, code).toBeGreaterThan(20);
      expect(["dependency-decision", "bundler-configuration", "cell-source"], code).toContain(rule.fixOwner);
    }
  });

  // A guarantee nothing can report is a promise with no enforcement, so the
  // reverse direction is part of the invariant too.
  it("ties every guarantee to at least one code that reports it", () => {
    const reported = new Set(
      CELL_ARTIFACT_DIAGNOSTIC_CODES.flatMap(code => cellArtifactDiagnosticRule(code).breaksGuarantees),
    );
    for (const guarantee of CELL_ARTIFACT_GUARANTEE_IDS) {
      expect(reported.has(guarantee), guarantee).toBe(true);
    }
  });

  it("never names a guarantee that does not exist", () => {
    for (const code of CELL_ARTIFACT_DIAGNOSTIC_CODES) {
      for (const guarantee of cellArtifactDiagnosticRule(code).breaksGuarantees) {
        expect(CELL_ARTIFACT_GUARANTEE_IDS, code).toContain(guarantee);
      }
    }
  });

  // The distinction that keeps an Agent from treating an ownership conflict as a
  // bundling problem: the fix owner has to differ where the failure does.
  it("sends an ownership conflict to the decision, not to the bundler", () => {
    expect(cellArtifactDiagnosticRule("platform-conflicting-dependency").fixOwner).toBe("dependency-decision");
    expect(cellArtifactDiagnosticRule("source-level-import-remains").fixOwner).toBe("bundler-configuration");
    expect(cellArtifactDiagnosticRule("rejected-cell-source-construct").fixOwner).toBe("cell-source");
  });
});

describe("diagnostic records", () => {
  it("keeps the rule's statement and appends the per-occurrence detail", () => {
    const diagnostic = createCellArtifactDiagnostic("source-level-import-remains", "es-toolkit", {
      detail: 'The bundler left "es-toolkit" external.',
    });

    expect(diagnostic.subject).toBe("es-toolkit");
    expect(diagnostic.message).toBe(
      `${cellArtifactDiagnosticRule("source-level-import-remains").states} The bundler left "es-toolkit" external.`,
    );
    expect(diagnostic.remediation).toBe(cellArtifactDiagnosticRule("source-level-import-remains").remediation);
    expect(diagnostic.breaksGuarantees.length).toBeGreaterThan(0);
    expect(diagnostic.location).toBeUndefined();
  });

  it("carries a location when one is known, without folding it into the subject", () => {
    const diagnostic = createCellArtifactDiagnostic("unsupported-runtime-asset", "chunk.js", {
      detail: "Emitted beside the Cell code.",
      location: "line 42",
    });
    expect(diagnostic.location).toBe("line 42");
    expect(diagnostic.subject).toBe("chunk.js");
  });

  // Overlapping detectors are deliberate, so a single problem must not be
  // reported once per detector.
  it("collapses duplicates by code and subject while keeping order and distinctness", () => {
    const first = createCellArtifactDiagnostic("source-level-import-remains", "a");
    const duplicate = createCellArtifactDiagnostic("source-level-import-remains", "a", { detail: "again" });
    const otherSubject = createCellArtifactDiagnostic("source-level-import-remains", "b");
    const otherCode = createCellArtifactDiagnostic("unsupported-runtime-asset", "a");

    const deduped = dedupeCellArtifactDiagnostics([first, duplicate, otherSubject, otherCode]);
    expect(deduped).toHaveLength(3);
    expect(deduped[0]).toBe(first);
    expect(cellArtifactDiagnosticCodes(deduped)).toEqual([
      "source-level-import-remains",
      "source-level-import-remains",
      "unsupported-runtime-asset",
    ]);
  });

  it("formats as a report line that names the code, subject and fix owner", () => {
    const diagnostic = createCellArtifactDiagnostic("bundler-failure", "src/App.tsx", {
      detail: "The bundler reported: ENOENT",
    });
    const line = formatCellArtifactDiagnostic(diagnostic);

    expect(line).toContain("[bundler-failure]");
    expect(line).toContain("src/App.tsx");
    expect(line).toContain("ENOENT");
    expect(line).toContain("Fix (bundler-configuration):");
  });

  it("formats a whole block, and says so when there is nothing to report", () => {
    expect(formatCellArtifactDiagnostics([])).toBe("No Cell artifact diagnostics.");
    const block = formatCellArtifactDiagnostics([
      createCellArtifactDiagnostic("missing-extension-mapping", "echarts"),
      createCellArtifactDiagnostic("duplicate-host-mapping", "React"),
    ]);
    expect(block.split("\n")).toHaveLength(2);
    expect(block.startsWith("- [")).toBe(true);
  });
});
