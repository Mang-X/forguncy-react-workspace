/**
 * The four dependency strategies, expressed as semantics rather than as a label.
 *
 * Decision source: GitHub Issue #4. A strategy is a *deployment* decision made
 * per (package, cell target) pair — not a property of the package and not a
 * global compatibility verdict. That is why the type lives next to a descriptor
 * that states when the strategy is legal, what it requires, and which of its
 * checks are local versus real-runtime.
 *
 * Deliberately absent: a normative precedence ranking and a package
 * compatibility database. Both are non-goals of #4.
 */

import type { DependencyRejection } from "./rejection";
import { DEPENDENCY_REJECTION_RESPONSE } from "./rejection";

export const DEPENDENCY_STRATEGIES = ["host", "inline", "extension", "replace"] as const;
export type DependencyStrategy = (typeof DEPENDENCY_STRATEGIES)[number];

/**
 * Which evidence a claim about a strategy needs.
 *
 * `local` checks run in this repository (typecheck, lint, bundling, jsdom/vm
 * smoke). `real-runtime` checks can only run inside a real Forguncy project.
 * Keeping them apart is what stops a green local build from being reported as
 * Forguncy runtime compatibility.
 */
export type DependencyCheckLevel = "local" | "real-runtime";

export interface DependencyCheck {
  readonly level: DependencyCheckLevel;
  readonly description: string;
}

export interface DependencyStrategySemantics {
  readonly strategy: DependencyStrategy;
  /** What the strategy does to the generated cell artifact. */
  readonly effect: string;
  /** The question this strategy answers. */
  readonly decides: string;
  /** Conditions that must hold for the strategy to be valid at all. */
  readonly requirements: readonly string[];
  /** Why this strategy would be chosen over the others. */
  readonly selectedWhen: readonly string[];
  /** Default for compatible browser-first libraries (`inline` only). */
  readonly isDefaultForCompatibleLibraries: boolean;
  /** Choosing it requires a written justification (extension / replace). */
  readonly requiresJustification: boolean;
  /** The backing capability must be verified, not assumed (extension only). */
  readonly requiresVerifiedHostCapability: boolean;
  /** Does a real Forguncy runtime necessarily confirm this strategy? */
  readonly realRuntimeRequired: boolean;
  readonly checks: readonly DependencyCheck[];
}

export const DEPENDENCY_STRATEGY_SEMANTICS: Readonly<Record<DependencyStrategy, DependencyStrategySemantics>> = {
  host: {
    strategy: "host",
    effect: "Standard source imports are mapped to a global already provided by the Forguncy/ReactCellType host; nothing is bundled.",
    decides: "Does the capability already exist in the page at runtime, with the module identity the cell needs?",
    requirements: [
      "The host actually exposes the module as a global in the target Forguncy version.",
      "Module identity is shared with the host, so singleton state (React, Context) stays single.",
      "The dependency's peer ranges are compatible with the host-provided version.",
    ],
    selectedWhen: [
      "The package is React/ReactDOM or another documented host global.",
      "A second bundled copy would break identity (hooks, Context, instanceof).",
    ],
    isDefaultForCompatibleLibraries: false,
    requiresJustification: false,
    requiresVerifiedHostCapability: false,
    realRuntimeRequired: true,
    checks: [
      { level: "local", description: "All host-provided imports resolve through the host mapping rather than a bundled copy." },
      { level: "real-runtime", description: "The declared global exists and is the expected object after the cell script runs." },
      { level: "real-runtime", description: "A consumer of the mapped module behaves identically to the host's own usage." },
    ],
  },
  inline: {
    strategy: "inline",
    effect: "The dependency is bundled into the generated cell artifact and is self-contained.",
    decides: "Can this package be reduced to a single browser-executable script with no external runtime fetches?",
    requirements: [
      "Browser-first / ESM-compatible, or reducible to a single IIFE without code splitting.",
      "No runtime module loading, and no required sibling chunk, Worker, WASM, font or image that cannot be inlined.",
      "No second copy of a host-owned module identity.",
      "Stays inside the measured cell code budget.",
    ],
    selectedWhen: [
      "The dependency is only used by this cell and nothing else needs to share it.",
      "No host global or verified extension provides it.",
      "The default choice for compatible browser-first libraries.",
    ],
    isDefaultForCompatibleLibraries: true,
    requiresJustification: false,
    requiresVerifiedHostCapability: false,
    realRuntimeRequired: true,
    checks: [
      { level: "local", description: "Bundling succeeds with code splitting and dynamic import eliminated." },
      { level: "local", description: "The artifact is a single self-contained script with no external asset references." },
      { level: "local", description: "Generated size is measured against the cell code budget." },
      { level: "real-runtime", description: "The bundle executes in a real Forguncy page and the cell renders." },
    ],
  },
  extension: {
    strategy: "extension",
    effect: "The dependency is supplied by a Forguncy frontend extension referenced from `frontendLibraries`; the cell imports its global.",
    decides: "Is there a verified extension that provides this capability, and is sharing it genuinely worth a deployment dependency?",
    requirements: [
      "The backing extension exists and has been verified in a real Forguncy project, not merely packaged.",
      "The extension's global name and declared types match what the cell imports.",
      "The cell does not depend on another extension loading first.",
    ],
    selectedWhen: [
      "Shared module identity or a cross-cell singleton is required.",
      "Deliberate project-wide reuse across many cells, or measured size economics justify it.",
    ],
    isDefaultForCompatibleLibraries: false,
    requiresJustification: true,
    requiresVerifiedHostCapability: true,
    realRuntimeRequired: true,
    checks: [
      { level: "local", description: "The extension global is declared correctly and the cell resolves it by name." },
      { level: "local", description: "No second copy of the same library is bundled alongside the extension." },
      { level: "real-runtime", description: "The extension is referenced by the ReactCellType and its global is available at cell load time." },
      { level: "real-runtime", description: "Singleton behaviour holds (one instance, shared cache/context) across cells." },
    ],
  },
  replace: {
    strategy: "replace",
    effect: "The requested package is not used for this target; a different package or a host-owned capability takes its place.",
    decides: "Given a concrete rejection, what is the cheapest correct alternative?",
    requirements: [
      "A structured rejection record explains why the original package was rejected.",
      "Alternatives were actually evaluated rather than assumed.",
      "The replacement keeps the capability on its correct side of the ownership boundary.",
    ],
    selectedWhen: [
      "A browser-first / ESM / low-runtime-complexity alternative exists and fits the same role.",
      "The capability is application-owned, so the correct replacement is the Forguncy-hosted equivalent rather than another package.",
    ],
    isDefaultForCompatibleLibraries: false,
    requiresJustification: true,
    requiresVerifiedHostCapability: false,
    realRuntimeRequired: true,
    checks: [
      { level: "local", description: "The rejection is classified as architectural or technical, not left as free text." },
      { level: "local", description: "For technical rejections, at least one evaluated alternative is recorded." },
      { level: "real-runtime", description: "The replacement satisfies the original requirement in a real Forguncy page." },
    ],
  },
};

export function isDependencyStrategy(value: unknown): value is DependencyStrategy {
  return typeof value === "string" && (DEPENDENCY_STRATEGIES as readonly string[]).includes(value);
}

export function strategySemantics(strategy: DependencyStrategy): DependencyStrategySemantics {
  return DEPENDENCY_STRATEGY_SEMANTICS[strategy];
}

export function checksForLevel(strategy: DependencyStrategy, level: DependencyCheckLevel): readonly DependencyCheck[] {
  return strategySemantics(strategy).checks.filter(check => check.level === level);
}

/** A strategy is not "verified" on local evidence alone when it needs a real runtime. */
export function requiresRealRuntimeValidation(strategy: DependencyStrategy): boolean {
  return strategySemantics(strategy).realRuntimeRequired;
}

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

export interface HostDependencyDecision {
  readonly strategy: "host";
  readonly packageName: string;
  /** The host global the imports are mapped to, e.g. `React`. */
  readonly globalName: string;
}

export interface InlineDependencyDecision {
  readonly strategy: "inline";
  readonly packageName: string;
}

export interface ExtensionDependencyDecision {
  readonly strategy: "extension";
  readonly packageName: string;
  readonly libraryId: string;
  readonly globalName: string;
}

export interface ReplaceDependencyDecision {
  readonly strategy: "replace";
  readonly packageName: string;
  /**
   * Structured, because an architectural rejection and a bundling failure are
   * different answers. See `rejection.ts`.
   */
  readonly rejection: DependencyRejection;
  /** Alternatives that were evaluated, not merely proposed. */
  readonly alternatives?: readonly string[];
  /** The strategy that actually replaces it, when one exists. */
  readonly supersededBy?: DependencyStrategy;
}

export type DependencyDecision =
  | HostDependencyDecision
  | InlineDependencyDecision
  | ExtensionDependencyDecision
  | ReplaceDependencyDecision;

/**
 * Checks a decision against the semantics above. Returns every problem instead
 * of throwing on the first one so a report can list all of them.
 */
export function validateDependencyDecision(
  decision: DependencyDecision,
  options: { readonly realRuntimeValidated?: boolean } = {},
): readonly string[] {
  const problems: string[] = [];

  if (decision.packageName.trim().length === 0) {
    problems.push("A dependency decision must name the package it decides about.");
  }

  if (decision.strategy === "replace") {
    const { rejection } = decision;
    if (rejection.kind === "technical" && (decision.alternatives ?? []).length === 0) {
      problems.push(
        `Technical rejection of "${decision.packageName}" must record at least one evaluated alternative before falling back to a project-local repair.`,
      );
    }
    if (rejection.kind === "architectural" && (decision.alternatives ?? []).length > 0) {
      problems.push(
        `Architectural rejection of "${decision.packageName}" is an ownership conflict; alternatives are capability owners, not packages, so a package alternative list is misleading.`,
      );
    }
    if (rejection.kind === "architectural" && decision.supersededBy !== undefined) {
      problems.push(
        `Architectural rejection of "${decision.packageName}" cannot be superseded by another dependency strategy; the capability belongs to ${DEPENDENCY_REJECTION_RESPONSE.architectural.resolutionOwner}.`,
      );
    }
    if (rejection.remediation.trim().length === 0) {
      problems.push(`Rejection of "${decision.packageName}" must state a remediation; a rejection is never a dead end.`);
    }
  }

  if (decision.strategy === "extension") {
    if (decision.libraryId.trim().length === 0 || decision.globalName.trim().length === 0) {
      problems.push(`Extension decision for "${decision.packageName}" must name both the library id and the global.`);
    }
    if (options.realRuntimeValidated !== true) {
      problems.push(
        `Extension decision for "${decision.packageName}" depends on a host capability that can only be verified in a real Forguncy project.`,
      );
    }
  }

  if (decision.strategy === "host" && decision.globalName.trim().length === 0) {
    problems.push(`Host decision for "${decision.packageName}" must name the host global it maps to.`);
  }

  return problems;
}

export function assertDependencyDecision(
  decision: DependencyDecision,
  options: { readonly realRuntimeValidated?: boolean } = {},
): void {
  const problems = validateDependencyDecision(decision, options);
  if (problems.length > 0) {
    throw new Error(`Invalid dependency decision for "${decision.packageName}":\n- ${problems.join("\n- ")}`);
  }
}
