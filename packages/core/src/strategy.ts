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

import type { DependencyRejection } from "./rejection.ts";
import { DEPENDENCY_REJECTION_RESPONSE, isArtifactObservedRejectionCode } from "./rejection.ts";

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

/**
 * The composed Cell's measured size, the cap it was compiled under, and the subject's share of it.
 *
 * The evidence for a `cell-code-budget-exceeded` rejection, and the **only** admissible one
 * (#77 revisions 14-16). Revision 13 established that no probe can file that rejection. The
 * authority is `compileCell`'s `auditCodeBudget` over the composed Cell, and this is what it
 * reported together with the attribution that makes the rejection about *this* package.
 *
 * ## Why attribution is recorded, and how it is obtained
 *
 * A size verdict has to answer two questions, and "the Cell is over its cap" answers only the first:
 *
 * 1. **Is the Cell over its cap?** — `codeCharacters > budgetCharacters`.
 * 2. **Is *this package* why?** — `subjectRenderedCharacters`, the characters the subject's own
 *    modules contributed to the artifact.
 *
 * Revision 15 checked only that the package had a record in the Cell, which certifies attribution
 * from mere presence: tiny package B could be rejected on package A's excess. The obvious repair —
 * recompile without the subject and subtract — **does not work**, and the measurement is worth
 * recording: dropping a decision does not remove the package's code, because the bundler still
 * resolves the bare import from `node_modules` (measured on `es-toolkit`: 14,971 characters with
 * the `inline` decision and 14,971 with it dropped, delta zero). What a package contributes is a
 * fact about the module graph, so it has to be read from the bundler's own per-module accounting —
 * `CompileCellResult.inlinedPackageSizes`.
 *
 * The attribution requirement is therefore: removing the subject's share would bring the Cell under
 * its cap (`codeCharacters - subjectRenderedCharacters <= budgetCharacters`). A subject that merely
 * happens to be present does not satisfy it.
 */
export interface ArtifactBudgetEvidence {
  /**
   * The identity of the compile these numbers came from — `composeCellCompileFingerprint` over the
   * composed artifact and the cap.
   *
   * This is what makes the evidence **checkable** rather than self-attested, and it is what
   * `status` invalidates on. It hashes the *artifact bytes*, so an edit to any module the entry
   * reaches, a dependency's resolved version, or a decision moving between strategies all move it —
   * the three stale paths revision 15's entry-source hash left open.
   */
  readonly compileFingerprint: string;
  /**
   * The subject package's decision **as it was when the Cell was measured**.
   *
   * Recording it is what makes the measurement replayable. Recording the rejection overwrites the
   * subject's decision with `replace`, so a later reader looking at the lock sees a Cell the subject
   * is *not* part of — and re-recording would then renew the rejection from a compile that never
   * contained the package. With this, the pre-rejection compile can be reproduced from the record.
   *
   * A strategy name and its parameters, not a full decision: it is an input to a compile, not a
   * second copy of the lock's record. See {@link SubjectCompileDecision}.
   */
  readonly subjectDecision: SubjectCompileDecision;
  /**
   * Characters the subject's own modules contributed to the composed artifact, as the bundler
   * accounted them.
   *
   * The attribution figure. Zero for a subject the bundler did not flatten into this Cell, which is
   * the honest reading — a package whose code is not in the artifact did not make it too large.
   */
  readonly subjectRenderedCharacters: number;
  /** Characters in the composed Cell, as `compileCell` measured it. */
  readonly codeCharacters: number;
  /** The `codeBudgetCharacters` that compile was given, from the Cell's own config. */
  readonly budgetCharacters: number;
}

/**
 * The subject package's compile-facing decision, as the measurement saw it.
 *
 * Deliberately the compiler's vocabulary (`DependencyStrategy` plus the strategy's own fields)
 * rather than a lock record: this is an input to a recompile, and carrying lock metadata here
 * would make the evidence a second, divergent copy of the record it belongs to.
 */
export interface SubjectCompileDecision {
  readonly strategy: DependencyStrategy;
  /** Set for `host` and `extension`, which resolve the package to a page global. */
  readonly globalName?: string;
  /** Set for `extension`. */
  readonly libraryId?: string;
}

export interface ReplaceDependencyDecision {
  readonly strategy: "replace";
  readonly packageName: string;
  /**
   * Structured, because an architectural rejection and a bundling failure are
   * different answers. See `rejection.ts`.
   */
  readonly rejection: DependencyRejection;
  /**
   * Required exactly when the rejection code is `cell-code-budget-exceeded`, refused otherwise.
   *
   * The pairing is the point: that code's answer comes from a compile, so a record citing it
   * without compile evidence would be claiming the one thing a probe cannot show. See
   * {@link ArtifactBudgetEvidence}.
   */
  readonly artifactEvidence?: ArtifactBudgetEvidence;
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
 * Static self-consistency of a decision record — and nothing more.
 *
 * Shape-only on purpose: a record can be perfectly well formed and still
 * completely unverified against a real Forguncy runtime. Use
 * `validateDependencyDecision` when the runtime claim matters.
 */
export function validateDependencyDecisionShape(decision: DependencyDecision): readonly string[] {
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

    // The compile-evidence pairing (#77 revision 14), stated as the two things a *shape* check can
    // settle. The requirement that a compile-observed code **carry** the evidence is deliberately
    // not here: this validator runs on the parse path too, and a lock written before revision 14
    // holds such a rejection with no `artifactEvidence`. Refusing it here would make an existing
    // lock unreadable instead of stale — the opposite of the migration contract in
    // `lock-migration.ts`. So the requirement lives on the two paths that can act on it:
    // `auditSelectionDecision` refuses to *record* such a rejection without evidence, and freshness
    // reports an existing one as `artifact-evidence-missing`. Both directions below are safe here
    // because they can only fire on a record that *has* the field.
    const { artifactEvidence } = decision;
    const observedByCompile = rejection.kind === "technical" && isArtifactObservedRejectionCode(rejection.code);
    if (artifactEvidence !== undefined) {
      if (!observedByCompile) {
        problems.push(
          `Rejection of "${decision.packageName}" records \`artifactEvidence\`, which is the evidence for a compile-observed code; "${rejection.kind === "technical" ? rejection.code : rejection.kind}" is not one. A probe observes that code, so compile numbers there would let a writer bypass the probe path.`,
        );
      } else {
        // The identity, then each measurement's own consistency (#77 revisions 15-16). The shape is
        // the parser's job (see `inspectLockRecord`); what is checked here is that the numbers
        // *say* what they are cited for.
        const { compileFingerprint, subjectDecision, subjectRenderedCharacters, codeCharacters, budgetCharacters } =
          artifactEvidence;
        if (typeof compileFingerprint !== "string" || compileFingerprint.trim().length === 0) {
          problems.push(
            `Rejection of "${decision.packageName}" records \`artifactEvidence\` without a usable \`compileFingerprint\`. The identity of the compile is what ties these numbers to an artifact a reader can reproduce; record it from \`composeCellCompileFingerprint\`.`,
          );
        }
        if (subjectDecision === undefined || subjectDecision.strategy === undefined) {
          problems.push(
            `Rejection of "${decision.packageName}" records \`artifactEvidence\` without the subject's pre-rejection \`subjectDecision\`. Recording the rejection overwrites that decision, so without it the measured Cell cannot be reproduced — and a later re-record would renew the rejection from a compile the package was not part of.`,
          );
        }
        for (const [name, value] of [
          ["subjectRenderedCharacters", subjectRenderedCharacters],
          ["codeCharacters", codeCharacters],
          ["budgetCharacters", budgetCharacters],
        ] as const) {
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            problems.push(
              `Rejection of "${decision.packageName}" records \`artifactEvidence.${name}\` as ${String(value)}; it must be a non-negative finite character count.`,
            );
          }
        }
        if (Number.isFinite(codeCharacters) && Number.isFinite(budgetCharacters)) {
          if (codeCharacters <= budgetCharacters) {
            problems.push(
              `Rejection of "${decision.packageName}" cites "${rejection.code}" but its \`artifactEvidence\` measures ${String(codeCharacters)} characters against a cap of ${String(budgetCharacters)} — within the cap, so the evidence does not support the rejection.`,
            );
          }
          // The attribution requirement: a rejection says this package is what puts the Cell over
          // its cap, so the Cell without the subject's own contribution has to fit. Revision 15
          // checked only that the package was *present*, which could not tell the package that
          // caused the excess from one that merely happened to be alongside it.
          //
          // The comparison is against the subject's rendered share rather than a second compile,
          // because a second compile cannot isolate it: dropping a decision leaves the package's
          // code in the artifact (see `ArtifactBudgetEvidence` for the measurement).
          if (
            Number.isFinite(subjectRenderedCharacters) &&
            codeCharacters - subjectRenderedCharacters > budgetCharacters
          ) {
            problems.push(
              `Rejection of "${decision.packageName}" cites "${rejection.code}", but the Cell would still measure ${String(codeCharacters - subjectRenderedCharacters)} characters against its cap of ${String(budgetCharacters)} without this package's ${String(subjectRenderedCharacters)} — so the excess is not this package's and the rejection cannot rest on the size it measured.`,
            );
          }
        }
      }
    }
  }

  if (decision.strategy === "extension") {
    if (decision.libraryId.trim().length === 0 || decision.globalName.trim().length === 0) {
      problems.push(`Extension decision for "${decision.packageName}" must name both the library id and the global.`);
    }
  }

  if (decision.strategy === "host" && decision.globalName.trim().length === 0) {
    problems.push(`Host decision for "${decision.packageName}" must name the host global it maps to.`);
  }

  return problems;
}

export interface DependencyVerificationEvidence {
  /**
   * True only after the selected strategy's `real-runtime` checks actually ran
   * inside a real Forguncy project. Local build success does not set this.
   */
  readonly realRuntimeValidated: boolean;
}

/**
 * The runtime evidence the strategy's own semantics require.
 *
 * Every strategy in `DEPENDENCY_STRATEGY_SEMANTICS` declares
 * `realRuntimeRequired: true`, so this applies uniformly: a `host` decision is
 * no more self-certifying than an `extension` decision is.
 */
export function validateDependencyVerification(
  decision: DependencyDecision,
  evidence: DependencyVerificationEvidence,
): readonly string[] {
  if (!requiresRealRuntimeValidation(decision.strategy) || evidence.realRuntimeValidated === true) {
    return [];
  }
  return [
    `"${decision.packageName}" cannot be reported as verified: strategy "${decision.strategy}" requires real-runtime validation that has not been provided. Run its real-runtime checks in a real Forguncy project and pass realRuntimeValidated: true.`,
  ];
}

/**
 * Shape problems plus the runtime-evidence problem.
 *
 * `evidence` is a required argument rather than an optional default, so a
 * caller cannot silently omit the runtime claim and still look validated.
 */
export function validateDependencyDecision(
  decision: DependencyDecision,
  evidence: DependencyVerificationEvidence,
): readonly string[] {
  return [...validateDependencyDecisionShape(decision), ...validateDependencyVerification(decision, evidence)];
}

export function assertDependencyDecision(decision: DependencyDecision, evidence: DependencyVerificationEvidence): void {
  const problems = validateDependencyDecision(decision, evidence);
  if (problems.length > 0) {
    throw new Error(`Invalid dependency decision for "${decision.packageName}":\n- ${problems.join("\n- ")}`);
  }
}
