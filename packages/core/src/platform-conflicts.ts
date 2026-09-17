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

import { findOwnershipConcern } from "./ownership";
import type { ApplicationOwner, OwnershipConcernId } from "./ownership";
import type { ArchitecturalRejectionCode, DependencyRejection } from "./rejection";

export type DependencyRole =
  // Application-owned roles: may not be filled by a React cell.
  | ApplicationOwnedRole
  // Cell-local roles: legitimate inside one cell.
  | "cell-local-ui"
  | "cell-local-state"
  | "cell-local-data-access";

export type ApplicationOwnedRole =
  | "application-navigation"
  | "application-state"
  | "application-auth"
  | "business-data-source";

export const APPLICATION_OWNED_ROLES: readonly ApplicationOwnedRole[] = [
  "application-navigation",
  "application-state",
  "application-auth",
  "business-data-source",
];

export function isApplicationOwnedRole(role: DependencyRole): role is ApplicationOwnedRole {
  return (APPLICATION_OWNED_ROLES as readonly string[]).includes(role);
}

/**
 * Which Forguncy-owned concern an application role duplicates. Role is the
 * primary key of the boundary, so this mapping — not the package name — decides
 * whether a request crosses it.
 */
const CONCERN_BY_APPLICATION_ROLE: Readonly<Record<ApplicationOwnedRole, OwnershipConcernId>> = {
  "application-navigation": "application-navigation",
  "application-state": "application-state",
  "application-auth": "permissions",
  "business-data-source": "business-data-source",
};

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

export interface PlatformConflictAllowed {
  readonly status: "allowed";
  readonly packageName: string;
  readonly role: DependencyRole;
  readonly rule: PlatformConflictRule;
  readonly reason: string;
}

export interface PlatformConflict {
  readonly status: "platform-conflict";
  readonly packageName: string;
  readonly role: DependencyRole;
  /**
   * Present when a package-specific rule refines the conflict. An
   * application-owned role conflicts even with no rule at all, so this is
   * optional on purpose.
   */
  readonly rule?: PlatformConflictRule;
  readonly rejection: DependencyRejection;
}

export interface PlatformConflictUnclassified {
  /** No platform rule matched and the role is cell-local; falls through to bundling. */
  readonly status: "unclassified";
  readonly packageName: string;
  readonly role: DependencyRole;
  readonly reason: string;
}

export interface PlatformConflictRoleMismatch {
  /**
   * The package is known and may legitimately be used inside a cell, but not for
   * the requested cell-local role.
   *
   * Deliberately *not* a platform conflict. The requested role does not cross
   * the ownership boundary, so reporting it as an architectural rejection would
   * misreport "this package is the wrong tool for this local role" as "this
   * duplicates a Forguncy-owned capability". Compare `react-router-dom` +
   * `cell-local-ui`, where the package has no legitimate in-cell use at all and
   * the conflict is genuine.
   */
  readonly status: "role-mismatch";
  readonly packageName: string;
  readonly role: DependencyRole;
  readonly rule: PlatformConflictRule;
  readonly allowedCellLocalRoles: readonly DependencyRole[];
  readonly reason: string;
}

export type PlatformConflictAssessment =
  | PlatformConflictAllowed
  | PlatformConflict
  | PlatformConflictUnclassified
  | PlatformConflictRoleMismatch;

/**
 * Assesses whether a package may be used in a role inside a React cell.
 *
 * Decision order matters and is deliberate:
 *
 * 1. **Ownership first.** If the requested role is application-owned, the
 *    request crosses the boundary no matter which package is named. An unknown
 *    or in-house package filling `application-navigation` is exactly as
 *    conflicting as React Router is.
 * 2. **Package rules refine cell-local cases.** Only for cell-local roles does
 *    the package rule decide anything:
 *    - an empty `allowedCellLocalRoles` means the package has no legitimate
 *      in-cell use at all (routers, auth frameworks), so any in-cell use is a
 *      real architectural conflict;
 *    - a non-empty list means the package *is* usable in a cell, just for those
 *      roles. A different cell-local role is then a role mismatch, not an
 *      ownership conflict, and is reported as such.
 *
 * Reversing step 1 (classify the package first) lets any package outside the
 * rule table fill an application-owned role as `unclassified`. Collapsing
 * step 2's two cases turns every wrong-tool pairing into a false architectural
 * rejection.
 */
export function assessDependencyRole(input: {
  readonly packageName: string;
  readonly role: DependencyRole;
}): PlatformConflictAssessment {
  const { packageName, role } = input;
  const rule = findPlatformConflictRule(packageName);

  if (isApplicationOwnedRole(role)) {
    const concern = CONCERN_BY_APPLICATION_ROLE[role];

    // A rule that duplicates this very concern supplies the precise code and
    // guidance. A rule for a different concern, or no rule at all, does not
    // excuse the request — it just makes the rejection generic.
    if (rule && rule.concern === concern) {
      return {
        status: "platform-conflict",
        packageName,
        role,
        rule,
        rejection: rejectionForRole(rule, role, packageName),
      };
    }

    const concernEntry = findOwnershipConcern(concern);
    return {
      status: "platform-conflict",
      packageName,
      role,
      ...(rule ? { rule } : {}),
      rejection: {
        kind: "architectural",
        code: "ownership-boundary-violation",
        summary: `"${packageName}" was requested for "${role}", which is the Forguncy-owned concern "${concern}" regardless of the package used.`,
        evidence: [
          `ownership-concern:${concern}`,
          `requested-role:${role}`,
          ...(rule ? [`platform-rule:${rule.id}`] : []),
        ],
        remediation: `${concernEntry ? `${concernEntry.rationale} ` : ""}Implement it through the Forguncy host instead of "${packageName}".`,
      },
    };
  }

  if (!rule) {
    return {
      status: "unclassified",
      packageName,
      role,
      reason: `"${packageName}" is not known to implement a Forguncy-owned capability, and "${role}" is cell-local; decide it through the normal strategy evaluation.`,
    };
  }

  if (rule.allowedCellLocalRoles.length === 0) {
    // No legitimate in-cell use exists for this package, so an in-cell request
    // is a genuine boundary crossing rather than a mismatch.
    return {
      status: "platform-conflict",
      packageName,
      role,
      rule,
      rejection: rejectionForRole(rule, role, packageName),
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

  // The package is usable in a cell, the requested role is cell-local, but the
  // two do not pair up. This is a role mismatch: the declared role is wrong, not
  // the architecture.
  return {
    status: "role-mismatch",
    packageName,
    role,
    rule,
    allowedCellLocalRoles: rule.allowedCellLocalRoles,
    reason: `"${packageName}" is a "${rule.label}" package and is usable inside a cell, but not for "${role}". The declared role does not match the package; this is a role mismatch, not an ownership conflict. Cell-local roles this package may fill: ${rule.allowedCellLocalRoles.join(", ")}.`,
  };
}

/**
 * Builds the architectural rejection for a package/role pair that genuinely
 * crosses the ownership boundary: either the role is application-owned, or the
 * package has no legitimate in-cell use at all. A cell-local role mismatch does
 * not reach here — see `PlatformConflictRoleMismatch`.
 */
function rejectionForRole(rule: PlatformConflictRule, role: DependencyRole, packageName: string): DependencyRejection {
  return {
    kind: "architectural",
    code: rule.code,
    summary:
      rule.allowedCellLocalRoles.length === 0
        ? `"${packageName}" has no legitimate cell-local role: "${role}" is the Forguncy-owned concern "${rule.concern}".`
        : `"${packageName}" was requested for "${role}", which duplicates the Forguncy-owned concern "${rule.concern}".`,
    evidence: [`platform-rule:${rule.id}`, `ownership-concern:${rule.concern}`, `requested-role:${role}`],
    remediation: rule.guidance,
  };
}

export function isPlatformConflict(assessment: PlatformConflictAssessment): assessment is PlatformConflict {
  return assessment.status === "platform-conflict";
}

export function isRoleMismatch(assessment: PlatformConflictAssessment): assessment is PlatformConflictRoleMismatch {
  return assessment.status === "role-mismatch";
}
