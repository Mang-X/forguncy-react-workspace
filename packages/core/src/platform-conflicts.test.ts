import { describe, expect, it } from "vitest";

import { ownerOf } from "./ownership";
import { ARCHITECTURAL_REJECTION_CODES, isArchitecturalRejection } from "./rejection";
import {
  assessDependencyRole,
  findPlatformConflictRule,
  isPlatformConflict,
  PLATFORM_CONFLICT_PACKAGE_NAMES,
  PLATFORM_CONFLICT_RULES,
} from "./platform-conflicts";

describe("platform conflicts", () => {
  it("treats React Router BrowserRouter as a platform conflict, not a package to adapt", () => {
    const assessment = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });

    expect(isPlatformConflict(assessment)).toBe(true);
    if (assessment.status !== "platform-conflict") return;

    expect(assessment.rule.id).toBe("application-router");
    expect(assessment.rejection.kind).toBe("architectural");
    expect(assessment.rejection.code).toBe("application-router-conflict");
    expect(assessment.rejection.remediation).toMatch(/Forguncy application shell/);
  });

  it("recognises routers on subpaths and alternative router packages", () => {
    for (const packageName of ["react-router-dom/server", "react-router", "@tanstack/react-router", "wouter"]) {
      const assessment = assessDependencyRole({ packageName, role: "application-navigation" });
      expect(assessment.status, packageName).toBe("platform-conflict");
    }
  });

  it("has no cell-local role for a router, so no role smuggles one into a cell", () => {
    for (const role of ["cell-local-state", "cell-local-ui", "cell-local-data-access"] as const) {
      const assessment = assessDependencyRole({ packageName: "react-router-dom", role });
      expect(assessment.status, role).toBe("platform-conflict");
    }
  });

  it("treats an application-wide business store as a platform conflict", () => {
    const assessment = assessDependencyRole({ packageName: "zustand", role: "application-state" });

    expect(assessment.status).toBe("platform-conflict");
    if (assessment.status !== "platform-conflict") return;

    expect(assessment.rejection.code).toBe("application-state-conflict");
    expect(assessment.rejection.evidence).toContain("ownership-concern:application-state");
  });

  it("still allows the same store package for cell-local state", () => {
    const assessment = assessDependencyRole({ packageName: "zustand", role: "cell-local-state" });

    expect(assessment.status).toBe("allowed");
    if (assessment.status !== "allowed") return;
    expect(assessment.rule.id).toBe("application-business-store");
    expect(assessment.reason).toMatch(/inside one cell/);
  });

  it("separates a cell-local data client from a duplicate business data source", () => {
    const local = assessDependencyRole({ packageName: "@tanstack/react-query", role: "cell-local-data-access" });
    const duplicate = assessDependencyRole({ packageName: "@tanstack/react-query", role: "business-data-source" });

    expect(local.status).toBe("allowed");
    expect(duplicate.status).toBe("platform-conflict");
    if (duplicate.status === "platform-conflict") {
      expect(duplicate.rejection.code).toBe("duplicate-business-data-source");
    }
  });

  it("treats auth frameworks as a platform conflict on the permissions concern", () => {
    const assessment = assessDependencyRole({ packageName: "@auth0/auth0-react", role: "application-auth" });

    expect(assessment.status).toBe("platform-conflict");
    if (assessment.status !== "platform-conflict") return;
    expect(assessment.rule.concern).toBe("permissions");
    expect(ownerOf(assessment.rule.concern)).toBe("forguncy");
  });

  it("leaves ordinary browser libraries unclassified rather than guessing", () => {
    const assessment = assessDependencyRole({ packageName: "es-toolkit", role: "cell-local-ui" });

    expect(assessment.status).toBe("unclassified");
    expect(isPlatformConflict(assessment)).toBe(false);
    expect(findPlatformConflictRule("es-toolkit")).toBeUndefined();
  });

  it("keeps every rule consistent with the ownership table and the rejection codes", () => {
    for (const rule of PLATFORM_CONFLICT_RULES) {
      expect(ownerOf(rule.concern), rule.id).toBe(rule.owner);
      expect(ARCHITECTURAL_REJECTION_CODES).toContain(rule.code);
      expect(rule.guidance.trim().length).toBeGreaterThan(0);
      expect(rule.packages.length).toBeGreaterThan(0);

      const sample = assessDependencyRole({ packageName: rule.packages[0]!, role: rule.concern as never });
      expect(sample.status, rule.id).toBe("platform-conflict");
      if (sample.status === "platform-conflict") {
        expect(isArchitecturalRejection(sample.rejection)).toBe(true);
      }
    }
  });

  it("exposes the conflicting package names for reporting", () => {
    expect(PLATFORM_CONFLICT_PACKAGE_NAMES).toContain("react-router-dom");
    expect(PLATFORM_CONFLICT_PACKAGE_NAMES).toContain("zustand");
    expect(new Set(PLATFORM_CONFLICT_PACKAGE_NAMES).size).toBe(PLATFORM_CONFLICT_PACKAGE_NAMES.length);
  });
});
