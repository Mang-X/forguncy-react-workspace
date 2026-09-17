import { describe, expect, it } from "vitest";

import { ownerOf } from "./ownership";
import { ARCHITECTURAL_REJECTION_CODES, isArchitecturalRejection } from "./rejection";
import {
  APPLICATION_OWNED_ROLES,
  assessDependencyRole,
  findPlatformConflictRule,
  isApplicationOwnedRole,
  isPlatformConflict,
  isRoleMismatch,
  PLATFORM_CONFLICT_PACKAGE_NAMES,
  PLATFORM_CONFLICT_RULES,
} from "./platform-conflicts";
import type { ApplicationOwnedRole, DependencyRole } from "./platform-conflicts";

/** The application-owned role that duplicates each rule's concern. */
const ROLE_BY_CONCERN: Readonly<Record<string, ApplicationOwnedRole>> = {
  "application-navigation": "application-navigation",
  "application-state": "application-state",
  permissions: "application-auth",
  "business-data-source": "business-data-source",
};

describe("platform conflicts", () => {
  it("treats React Router BrowserRouter as a platform conflict, not a package to adapt", () => {
    const assessment = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });

    expect(isPlatformConflict(assessment)).toBe(true);
    if (assessment.status !== "platform-conflict") return;

    expect(assessment.rule?.id).toBe("application-router");
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

  // A known package used for the wrong cell-local role is a bad pairing, not an
  // ownership violation. Reporting it as architectural misreports "wrong tool"
  // as "duplicates a Forguncy-owned capability".
  describe("role mismatch is not an ownership conflict", () => {
    it.each(["cell-local-state", "cell-local-ui"] as const)(
      "reports a known data client requested for %s as a role mismatch",
      role => {
        const assessment = assessDependencyRole({ packageName: "@tanstack/react-query", role });

        expect(assessment.status, role).toBe("role-mismatch");
        expect(isPlatformConflict(assessment), role).toBe(false);
        expect(isRoleMismatch(assessment), role).toBe(true);
        if (assessment.status !== "role-mismatch") return;

        expect(assessment.rule.id).toBe("duplicate-business-data-source");
        expect(assessment.allowedCellLocalRoles).toEqual(["cell-local-data-access"]);
        expect(assessment.reason).toMatch(/role mismatch, not an ownership conflict/);
      },
    );

    it("still rejects a package that has no legitimate in-cell use at all", () => {
      for (const packageName of ["react-router-dom", "@auth0/auth0-react"]) {
        const assessment = assessDependencyRole({ packageName, role: "cell-local-ui" });

        expect(assessment.status, packageName).toBe("platform-conflict");
        if (assessment.status !== "platform-conflict") continue;
        expect(isArchitecturalRejection(assessment.rejection), packageName).toBe(true);
        expect(assessment.rule?.allowedCellLocalRoles, packageName).toEqual([]);
      }
    });

    it("keeps every rule self-consistent about which side of the line it is on", () => {
      for (const rule of PLATFORM_CONFLICT_RULES) {
        const assessment = assessDependencyRole({ packageName: rule.packages[0]!, role: "cell-local-ui" });
        if (rule.allowedCellLocalRoles.length === 0) {
          // No in-cell use is legitimate, so even an unrelated cell-local role conflicts.
          expect(assessment.status, rule.id).toBe("platform-conflict");
        } else if (!rule.allowedCellLocalRoles.includes("cell-local-ui")) {
          expect(assessment.status, rule.id).toBe("role-mismatch");
        } else {
          expect(assessment.status, rule.id).toBe("allowed");
        }
      }
    });
  });

  it("treats auth frameworks as a platform conflict on the permissions concern", () => {
    const assessment = assessDependencyRole({ packageName: "@auth0/auth0-react", role: "application-auth" });

    expect(assessment.status).toBe("platform-conflict");
    if (assessment.status !== "platform-conflict") return;
    expect(assessment.rule?.concern).toBe("permissions");
    expect(ownerOf("permissions")).toBe("forguncy");
  });

  it("leaves ordinary browser libraries unclassified rather than guessing", () => {
    const assessment = assessDependencyRole({ packageName: "es-toolkit", role: "cell-local-ui" });

    expect(assessment.status).toBe("unclassified");
    expect(isPlatformConflict(assessment)).toBe(false);
    expect(findPlatformConflictRule("es-toolkit")).toBeUndefined();
  });

  // Ownership is the primary decision: the role decides, not the package table.
  describe("ownership is decided before package classification", () => {
    const unknownPackages = ["es-toolkit", "my-in-house-router", "@acme/app-store", "some-unknown-auth-sdk"];

    it.each(APPLICATION_OWNED_ROLES)("rejects an unknown package for the application-owned role %s", role => {
      for (const packageName of unknownPackages) {
        const assessment = assessDependencyRole({ packageName, role });

        expect(assessment.status, `${packageName}/${role}`).toBe("platform-conflict");
        if (assessment.status !== "platform-conflict") continue;

        expect(assessment.rejection.kind, `${packageName}/${role}`).toBe("architectural");
        expect(assessment.rejection.code, `${packageName}/${role}`).toBe("ownership-boundary-violation");
        expect(assessment.rule, `${packageName}/${role}`).toBeUndefined();
        expect(assessment.rejection.evidence).toContain(`requested-role:${role}`);
      }
    });

    it("reports the concern the role duplicates, not the package", () => {
      const assessment = assessDependencyRole({ packageName: "my-in-house-router", role: "application-navigation" });

      expect(assessment.status).toBe("platform-conflict");
      if (assessment.status !== "platform-conflict") return;
      expect(assessment.rejection.evidence).toContain("ownership-concern:application-navigation");
      expect(assessment.rejection.remediation).toMatch(/Implement it through the Forguncy host/);
    });

    it("still leaves an unknown package unclassified for a cell-local role", () => {
      for (const role of ["cell-local-ui", "cell-local-state", "cell-local-data-access"] as const) {
        const assessment = assessDependencyRole({ packageName: "es-toolkit", role });
        expect(assessment.status, role).toBe("unclassified");
      }
    });

    it("prefers the package rule's code when the rule duplicates the same concern", () => {
      const assessment = assessDependencyRole({ packageName: "zustand", role: "application-state" });

      expect(assessment.status).toBe("platform-conflict");
      if (assessment.status !== "platform-conflict") return;
      expect(assessment.rule?.id).toBe("application-business-store");
      expect(assessment.rejection.code).toBe("application-state-conflict");
    });

    it("stays generic when a known package is asked to fill an unrelated application role", () => {
      // zustand's rule covers application-state, not business-data-source.
      const assessment = assessDependencyRole({ packageName: "zustand", role: "business-data-source" });

      expect(assessment.status).toBe("platform-conflict");
      if (assessment.status !== "platform-conflict") return;
      expect(assessment.rejection.code).toBe("ownership-boundary-violation");
      expect(assessment.rejection.evidence).toContain("ownership-concern:business-data-source");
      // The matched rule is still reported, it just does not supply the code.
      expect(assessment.rejection.evidence).toContain("platform-rule:application-business-store");
    });

    it("separates application-owned from cell-local roles", () => {
      for (const role of APPLICATION_OWNED_ROLES) {
        expect(isApplicationOwnedRole(role)).toBe(true);
      }
      for (const role of ["cell-local-ui", "cell-local-state", "cell-local-data-access"] as const) {
        expect(isApplicationOwnedRole(role)).toBe(false);
      }
    });

    it("never lists an application-owned role as an allowed cell-local role", () => {
      for (const rule of PLATFORM_CONFLICT_RULES) {
        for (const role of rule.allowedCellLocalRoles) {
          expect(isApplicationOwnedRole(role), `${rule.id}/${role}`).toBe(false);
        }
      }
    });
  });

  it("keeps every rule consistent with the ownership table and the rejection codes", () => {
    for (const rule of PLATFORM_CONFLICT_RULES) {
      expect(ownerOf(rule.concern), rule.id).toBe(rule.owner);
      expect(ARCHITECTURAL_REJECTION_CODES).toContain(rule.code);
      expect(rule.guidance.trim().length).toBeGreaterThan(0);
      expect(rule.packages.length).toBeGreaterThan(0);

      const role = ROLE_BY_CONCERN[rule.concern] as DependencyRole;
      const sample = assessDependencyRole({ packageName: rule.packages[0]!, role });

      expect(sample.status, rule.id).toBe("platform-conflict");
      if (sample.status === "platform-conflict") {
        expect(isArchitecturalRejection(sample.rejection)).toBe(true);
        expect(sample.rejection.code, rule.id).toBe(rule.code);
      }
    }
  });

  it("exposes the conflicting package names for reporting", () => {
    expect(PLATFORM_CONFLICT_PACKAGE_NAMES).toContain("react-router-dom");
    expect(PLATFORM_CONFLICT_PACKAGE_NAMES).toContain("zustand");
    expect(new Set(PLATFORM_CONFLICT_PACKAGE_NAMES).size).toBe(PLATFORM_CONFLICT_PACKAGE_NAMES.length);
  });
});
