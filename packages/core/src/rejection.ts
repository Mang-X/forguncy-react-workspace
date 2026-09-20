/**
 * Why a dependency was rejected — and the fact that there are two different
 * answers to "why".
 *
 * Decision source: GitHub Issue #4, acceptance criterion
 * "The dependency Skill can explain an architectural rejection separately from a
 * technical bundling failure".
 *
 * A free-text `reason` cannot carry that distinction, so a rejection is a
 * structured record. The distinction is not cosmetic: the two kinds need
 * opposite responses.
 *
 * - `technical` — the package is the right shape but the wrong artifact. A
 *   browser-first alternative usually exists and should be evaluated.
 * - `architectural` — the package works fine; the capability it implements is
 *   owned by Forguncy. No replacement package can fix it, because the fix is to
 *   route the capability to the owning side.
 */

import type { ApplicationOwner } from "./ownership";

export const DEPENDENCY_REJECTION_KINDS = ["architectural", "technical"] as const;
export type DependencyRejectionKind = (typeof DEPENDENCY_REJECTION_KINDS)[number];

/**
 * Platform conflicts: the package is adoptable in general, but not in the role
 * it was requested for, because that role is owned by the application shell.
 */
export type ArchitecturalRejectionCode =
  | "application-router-conflict"
  | "application-state-conflict"
  | "auth-framework-conflict"
  | "duplicate-business-data-source"
  | "ownership-boundary-violation";

/**
 * Bundling/runtime failures: the role is fine, the artifact is not. These are
 * the failure modes a bundler or a real Forguncy runtime actually reports.
 *
 * `platform-api-unavailable` and `runtime-api-unavailable` are deliberately two
 * codes rather than one. "The package needs an API that is not there" is true of two
 * different runtimes, and the difference decides *when* the rejection can be known
 * and therefore what evidence it needs:
 *
 * - `platform-api-unavailable` — the **browser platform** cannot provide it. A Node
 *   builtin or a native addon is statically absent from any browser, so this is
 *   decided before deployment, by inspection of the dependency graph, with no
 *   Forguncy target involved. #17 requires exactly this to be found before a
 *   deployment is attempted.
 * - `runtime-api-unavailable` — the **target runtime** does not expose it. That is a
 *   fact about a specific Forguncy host, so it can only be observed against one; #8
 *   consequently lists it under `RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES` and
 *   requires the record to name the target it was observed under.
 *
 * Collapsing them made one of the two answers unwritable: a statically-known platform
 * absence could only be recorded under a code whose evidence contract demands a
 * runtime observation, so the writer either could not persist it or had to invent a
 * target it never saw.
 *
 * `browser-build-unavailable` is a third, separate failure and not a flavour of either:
 * the package may use no Node-only API at all and simply never publish a browser entry.
 * The browser is not missing a capability — there is no browser artifact to run. Sharing
 * a code would put two different failure conditions, with different upgrade diagnoses,
 * behind one reason.
 */
export type TechnicalRejectionCode =
  | "host-module-identity-mismatch"
  | "amd-umd-branch-mismatch"
  | "non-inlineable-asset"
  | "dynamic-module-loading"
  | "global-namespace-collision"
  | "cell-code-budget-exceeded"
  | "platform-api-unavailable"
  | "browser-build-unavailable"
  | "runtime-api-unavailable";

export type DependencyRejectionCode = ArchitecturalRejectionCode | TechnicalRejectionCode;

/**
 * An ownership conflict. The capability belongs to Forguncy, so the code can
 * only ever come from the architectural family.
 */
export interface ArchitecturalDependencyRejection {
  readonly kind: "architectural";
  readonly code: ArchitecturalRejectionCode;
  /** One sentence a human reads in a report. Free text, but never the whole story. */
  readonly summary: string;
  /** Why we believe this: probe output, runtime observation, ownership concern id. */
  readonly evidence?: readonly string[];
  /** What to do instead. Required, so a rejection is never a dead end. */
  readonly remediation: string;
}

/**
 * A bundling/runtime failure. The role is correct, so the code can only ever
 * come from the technical family.
 */
export interface TechnicalDependencyRejection {
  readonly kind: "technical";
  readonly code: TechnicalRejectionCode;
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly remediation: string;
}

/**
 * Discriminated union, deliberately not `{ kind: Kind; code: Code }`.
 *
 * The whole point of this module is that the two families are not
 * interchangeable, so the type must make a contradictory record such as
 * `{ kind: "architectural", code: "amd-umd-branch-mismatch" }` impossible to
 * write rather than merely discouraged. Callers that switch on `kind` and
 * callers that switch on `code` then agree by construction.
 */
export type DependencyRejection = ArchitecturalDependencyRejection | TechnicalDependencyRejection;

/**
 * Terminal response policy per rejection kind. This is what keeps an Agent from
 * "fixing" a platform conflict by writing another adapter.
 */
export interface DependencyRejectionResponse {
  /** Who must implement the capability once the dependency is rejected. */
  readonly resolutionOwner: ApplicationOwner;
  readonly agentAction: string;
  /** Strategies that can still legally resolve the *same package in this role*. */
  readonly mayResolveWith: readonly ("host" | "inline" | "extension" | "replace")[];
  readonly mustNot: readonly string[];
}

export const DEPENDENCY_REJECTION_RESPONSE: Readonly<Record<DependencyRejectionKind, DependencyRejectionResponse>> = {
  architectural: {
    resolutionOwner: "forguncy",
    agentAction:
      "Report a platform conflict, name the Forguncy-owned concern that owns the capability, and route the requirement to the host instead of adapting the package.",
    // No dependency strategy resolves an ownership conflict: the capability is
    // not a dependency problem, so "just use another router" is not an answer.
    mayResolveWith: [],
    mustNot: [
      "Do not create a package-specific adapter for an application-owned capability.",
      "Do not downgrade an application-owned concern into a cell-local implementation.",
      "Do not report an ownership conflict as a bundling failure or vice versa.",
    ],
  },
  technical: {
    resolutionOwner: "react-cell",
    agentAction:
      "Treat it as a bundling/runtime failure: prefer `replace` with a browser-first alternative, or `extension` when shared module identity is genuinely required.",
    mayResolveWith: ["replace", "extension", "host"],
    mustNot: [
      "Do not build a permanent package-specific adapter before alternatives have been evaluated.",
      "Do not claim the dependency is usable without an executed local or real-runtime check.",
    ],
  },
};

export function isArchitecturalRejection(rejection: DependencyRejection): rejection is ArchitecturalDependencyRejection {
  return rejection.kind === "architectural";
}

export function isTechnicalRejection(rejection: DependencyRejection): rejection is TechnicalDependencyRejection {
  return rejection.kind === "technical";
}

/** True when the rejection code belongs to the architectural family. */
export function isArchitecturalRejectionCode(code: DependencyRejectionCode): code is ArchitecturalRejectionCode {
  return (ARCHITECTURAL_REJECTION_CODES as readonly string[]).includes(code);
}

export function isTechnicalRejectionCode(code: DependencyRejectionCode): code is TechnicalRejectionCode {
  return !isArchitecturalRejectionCode(code);
}

export const ARCHITECTURAL_REJECTION_CODES: readonly ArchitecturalRejectionCode[] = [
  "application-router-conflict",
  "application-state-conflict",
  "auth-framework-conflict",
  "duplicate-business-data-source",
  "ownership-boundary-violation",
];

export const TECHNICAL_REJECTION_CODES: readonly TechnicalRejectionCode[] = [
  "host-module-identity-mismatch",
  "amd-umd-branch-mismatch",
  "non-inlineable-asset",
  "dynamic-module-loading",
  "global-namespace-collision",
  "cell-code-budget-exceeded",
  "platform-api-unavailable",
  "browser-build-unavailable",
  "runtime-api-unavailable",
];

/**
 * Splits a rejection list so a report can say "3 dependencies were rejected for
 * architectural reasons, 2 for bundling reasons" instead of printing five
 * indistinguishable reasons. The two buckets keep their narrow types, so a
 * consumer cannot pass a technical rejection into an ownership-conflict path.
 */
export interface GroupedRejections {
  readonly architectural: readonly ArchitecturalDependencyRejection[];
  readonly technical: readonly TechnicalDependencyRejection[];
}

export function groupRejectionsByKind(rejections: readonly DependencyRejection[]): GroupedRejections {
  return {
    architectural: rejections.filter(isArchitecturalRejection),
    technical: rejections.filter(isTechnicalRejection),
  };
}
