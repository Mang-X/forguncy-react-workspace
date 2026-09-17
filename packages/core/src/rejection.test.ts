import { describe, expect, it } from "vitest";

import {
  ARCHITECTURAL_REJECTION_CODES,
  DEPENDENCY_REJECTION_KINDS,
  DEPENDENCY_REJECTION_RESPONSE,
  groupRejectionsByKind,
  isArchitecturalRejection,
  isArchitecturalRejectionCode,
  isTechnicalRejection,
  isTechnicalRejectionCode,
  TECHNICAL_REJECTION_CODES,
} from "./rejection";
import type { DependencyRejection } from "./rejection";

const architectural: DependencyRejection = {
  kind: "architectural",
  code: "application-router-conflict",
  summary: "react-router-dom would create a second browser history.",
  remediation: "Route navigation through the Forguncy host.",
};

const technical: DependencyRejection = {
  kind: "technical",
  code: "amd-umd-branch-mismatch",
  summary: "The vendor UMD bundle takes the AMD branch at runtime.",
  remediation: "Re-bundle from the ESM entry as a single IIFE.",
};

describe("dependency rejection classification", () => {
  it("defines exactly two rejection kinds", () => {
    expect([...DEPENDENCY_REJECTION_KINDS]).toEqual(["architectural", "technical"]);
  });

  it("keeps the two rejection code families disjoint", () => {
    const overlap = ARCHITECTURAL_REJECTION_CODES.filter(code => (TECHNICAL_REJECTION_CODES as readonly string[]).includes(code));
    expect(overlap).toEqual([]);
  });

  it("routes the two families to opposite responses", () => {
    const arch = DEPENDENCY_REJECTION_RESPONSE.architectural;
    const tech = DEPENDENCY_REJECTION_RESPONSE.technical;

    expect(arch.resolutionOwner).toBe("forguncy");
    expect(arch.mayResolveWith).toEqual([]);
    expect(arch.agentAction).toMatch(/route the requirement to the host/);
    expect(arch.mustNot.join(" ")).toMatch(/ownership conflict as a bundling failure/);

    expect(tech.resolutionOwner).toBe("react-cell");
    expect(tech.mayResolveWith).toContain("replace");
    expect(tech.mustNot.join(" ")).toMatch(/adapter before alternatives/);
  });

  it("classifies codes into the right family", () => {
    expect(isArchitecturalRejectionCode("application-router-conflict")).toBe(true);
    expect(isArchitecturalRejectionCode("duplicate-business-data-source")).toBe(true);
    expect(isArchitecturalRejectionCode("cell-code-budget-exceeded")).toBe(false);

    expect(isTechnicalRejectionCode("cell-code-budget-exceeded")).toBe(true);
    expect(isTechnicalRejectionCode("host-module-identity-mismatch")).toBe(true);
    expect(isTechnicalRejectionCode("auth-framework-conflict")).toBe(false);

    for (const code of [...ARCHITECTURAL_REJECTION_CODES, ...TECHNICAL_REJECTION_CODES]) {
      expect(isArchitecturalRejectionCode(code)).toBe(!isTechnicalRejectionCode(code));
    }
  });

  it("distinguishes the two kinds on a rejection record", () => {
    expect(isArchitecturalRejection(architectural)).toBe(true);
    expect(isTechnicalRejection(architectural)).toBe(false);
    expect(isTechnicalRejection(technical)).toBe(true);
    expect(isArchitecturalRejection(technical)).toBe(false);
  });

  it("groups a mixed rejection list into architectural and bundling buckets", () => {
    const grouped = groupRejectionsByKind([architectural, technical, architectural]);

    expect(grouped.architectural).toHaveLength(2);
    expect(grouped.technical).toHaveLength(1);
    expect(grouped.technical[0]).toBe(technical);
  });
});
