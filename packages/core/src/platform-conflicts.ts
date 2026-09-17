/**
 * Platform conflicts: packages that are not "unsupported", but requested for a
 * role the application shell already owns.
 *
 * Decision source: GitHub Issue #4, acceptance criterion "React Router
 * BrowserRouter and application-wide duplicate business stores are treated as
 * platform conflicts rather than ordinary packages to adapt".
 *
 * Key design decision: classification is *role-sensitive*, not package-sensitive.
 * `zustand` used for a single cell's wizard state is fine; the same package used
 * as the cross-cell business-state source of truth is a platform conflict. A
 * package-name denylist would be wrong in both directions, so every rule is
 * evaluated against the role the dependency is being asked to fill.
 */

import type { ApplicationOwner, OwnershipConcernId } from "./ownership";
import type { ArchitecturalRejectionCode, DependencyRejection } from "./rejection";

export type DependencyRole =
  // Application-owned roles: may not be filled by a React cell.
  | "application-navigation"
  | "application-state"
  | "application-auth"
  | "business-data-source"
  // Cell-local roles: legitimate inside one cell.
  | "cell-local-ui"
  | "cell-local-state"
  | "cell-local-data-access";

export const APPLICATION_OWNED_ROLES: readonly DependencyRole[] = [
  "application-navigation",
  "application-state",
  "application-auth",
  "business-data-source",
];

export interface PlatformConflictRule {
  readonly id: string;
  readonly label: string;
  readonly code: ArchitecturalRejectionCode;
  /** The Forguncy-owned concern that makes this role a conflict. */
  readonly concern: OwnershipConcernId;
  readonly owner: ApplicationOwner;
  /**
   * Concrete package names implementing the capability. A subpath import of a
   * listed package (`react-router-dom/server`) matches its parent.
   */
  readonly packages: readonly string[];
  /**
   * Roles that are still legitimate for this package inside a single cell. An
   * empty list means no cell-local role exists, so any in-cell use conflicts.
   */
  readonly allowedCellLocalRoles: readonly DependencyRole[];
  readonly guidance: string;
}

export const PLATFORM_CONFLICT_RULES: readonly PlatformConflictRule[] = [
  {
    id: "application-router",
    label: "Application router / browser history",
    code: "application-router-conflict",
    concern: "application-navigation",
    owner: "forguncy",
    packages: ["react-router", "react-router-dom", "@tanstack/react-router", "@reach/router", "wouter", "history"],
    allowedCellLocalRoles: [],
    guidance:
      "Navigation and browser-history semantics belong to the Forguncy application shell. Use host page navigation instead of mounting a router inside a cell; there is no cell-local role for a router.",
  },
  {
    id: "application-business-store",
    label: "Application-wide business state store",
    code: "application-state-conflict",
    concern: "application-state",
    owner: "forguncy",
    packages: [
      "redux",
      "@reduxjs/toolkit",
      "react-redux",
      "zustand",
      "jotai",
      "recoil",
      "valtio",
      "effector",
      "@xstate/react",
      "mobx",
      "mobx-react",
      "mobx-react-lite",
    ],
    allowedCellLocalRoles: ["cell-local-state", "cell-local-ui", "cell-local-data-access"],
    guidance:
      "As an application-wide business-state source of truth this duplicates Forguncy page state. Keep it strictly cell-local, or move the state to the host.",
  },
  {
    id: "application-auth",
    label: "Authentication / authorization framework",
    code: "auth-framework-conflict",
    concern: "permissions",
    owner: "forguncy",
    packages: ["@auth0/auth0-react", "@clerk/clerk-react", "@okta/okta-react", "@azure/msal-react", "next-auth"],
    allowedCellLocalRoles: [],
    guidance:
      "The host has already resolved the user's permissions before the page renders. Consume the host-provided permission context; a second auth stack cannot be the page's authority.",
  },
  {
    id: "duplicate-business-data-source",
    label: "Duplicate business data source of truth",
    code: "duplicate-business-data-source",
    concern: "business-data-source",
    owner: "forguncy",
    packages: ["@tanstack/react-query", "swr", "@apollo/client", "urql", "@trpc/client"],
    allowedCellLocalRoles: ["cell-local-data-access"],
    guidance:
      "A cell may cache the remote data only it depends on. The moment a data client becomes the business-data source of truth it conflicts with Forguncy DataSources; share it through a verified extension instead of a second source of truth.",
  },
];

/** Flat list of every package name that has a platform-conflict rule. */
export const PLATFORM_CONFLICT_PACKAGE_NAMES: readonly string[] = PLATFORM_CONFLICT_RULES.flatMap(rule => rule.packages);

function packageMatches(rule: PlatformConflictRule, packageName: string): boolean {
  return rule.packages.some(entry => packageName === entry || packageName.startsWith(`${entry}/`));
}

/** The rule for a package, ignoring the requested role. */
export function findPlatformConflictRule(packageName: string): PlatformConflictRule | undefined {
  return PLATFORM_CONFLICT_RULES.find(rule => packageMatches(rule, packageName));
}

export type PlatformConflictAssessment =
  | {
      readonly status: "allowed";
      readonly packageName: string;
      readonly role: DependencyRole;
      readonly rule: PlatformConflictRule;
      readonly reason: string;
    }
  | {
      readonly status: "platform-conflict";
      readonly packageName: string;
      readonly role: DependencyRole;
      readonly rule: PlatformConflictRule;
      readonly rejection: DependencyRejection;
    }
  | {
      /** No platform rule matched; the decision falls through to bundling. */
      readonly status: "unclassified";
      readonly packageName: string;
      readonly role: DependencyRole;
      readonly reason: string;
    };

/**
 * Assesses whether a package may be used in a role inside a React cell.
 *
 * Returns `platform-conflict` when the role belongs to Forguncy, or when the
 * package has no legitimate cell-local role at all.
 */
export function assessDependencyRole(input: {
  readonly packageName: string;
  readonly role: DependencyRole;
}): PlatformConflictAssessment {
  const { packageName, role } = input;
  const rule = findPlatformConflictRule(packageName);

  if (!rule) {
    return {
      status: "unclassified",
      packageName,
      role,
      reason: `"${packageName}" is not known to implement a Forguncy-owned capability; decide it through the normal strategy evaluation.`,
    };
  }

  if (rule.allowedCellLocalRoles.includes(role)) {
    return {
      status: "allowed",
      packageName,
      role,
      rule,
      reason: `"${packageName}" may be used for "${role}" inside one cell; only the application-owned role "${rule.concern}" conflicts.`,
    };
  }

  return {
    status: "platform-conflict",
    packageName,
    role,
    rule,
    rejection: {
      kind: "architectural",
      code: rule.code,
      summary:
        rule.allowedCellLocalRoles.length === 0
          ? `"${packageName}" has no legitimate cell-local role: "${role}" is the Forguncy-owned concern "${rule.concern}".`
          : `"${packageName}" was requested for "${role}", which duplicates the Forguncy-owned concern "${rule.concern}".`,
      evidence: [`platform-rule:${rule.id}`, `ownership-concern:${rule.concern}`, `requested-role:${role}`],
      remediation: rule.guidance,
    },
  };
}

export function isPlatformConflict(assessment: PlatformConflictAssessment): boolean {
  return assessment.status === "platform-conflict";
}
