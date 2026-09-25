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
 * The evidence for a `cell-code-budget-exceeded` rejection (#77 revisions 14-17). Revision 13
 * established that no probe can file that rejection; the authority is `compileCell`'s
 * `auditCodeBudget` over the composed Cell, and this is what that call reported.
 *
 * ## What is *proven* here, and what is only reported
 *
 * Two questions a size verdict raises, answered to different strengths — and conflating them is
 * what revision 17 corrects:
 *
 * 1. **Is the Cell over its cap?** — `codeCharacters > budgetCharacters`. This is the verdict, and
 *    `compileFingerprint` makes it reproducible: a reader recompiles and compares the artifact's
 *    bytes, so an edited source or a moved decision cannot leave a stale record reporting `fresh`.
 * 2. **Is *this package* why?** — `subjectRenderedCharacters`, the characters the subject's own
 *    modules contributed. **Advisory evidence, never a proof.**
 *
 * ## Why attribution is advisory rather than a rejection rule
 *
 * Revision 16 required `codeCharacters - subjectRenderedCharacters <= budgetCharacters`, reading
 * the difference as "the Cell without this package". **It is not that**, and the counterexample
 * compiles: with `App -> chain-a` and `App -> chain-b -> chain-a`, marking `chain-a` as `replace`
 * produces a **byte-identical artifact** (measured: 4335 characters either way) because `chain-b`
 * keeps it reachable. The subtraction removes a number, not a dependency.
 *
 * Nor can "the amount that disappears" be derived from the module graph as cheaply as the share:
 * `renderedLength` answers *how much code belongs to this package*, while the removable amount is
 * a question about exclusive reachability, which needs importer information and a second
 * traversal — with its own edge cases (dynamic imports, cycles). Rather than dress a share up as a
 * proof, this field says what it is.
 *
 * So a `replace` rests on the compiled verdict, and this number is what a reviewer weighs: a
 * subject contributing most of the excess is a far better reason than one contributing a sliver. It
 * is reported, reproducible, and explicitly not the thing that authorizes the rejection.
 */
export interface ArtifactBudgetEvidence {
  /**
   * The identity of the compile these numbers came from — `composeCellCompileFingerprint` over the
   * composed artifact and the cap.
   *
   * This is what makes the verdict **checkable** rather than self-attested, and it is what `status`
   * invalidates on. It hashes the *artifact bytes*, so an edit to any module the entry reaches, a
   * dependency's resolved version, or a decision moving between strategies all move it.
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
   * Advisory, and reproducible: `status` recomputes it from its own compile and reports
   * `artifact-attribution-mismatch` if it has moved, so a hand-edited number cannot survive a
   * freshness check the way revision 16 allowed. It is still not a proof of causation — see the
   * interface's header — and nothing rejects on it.
   *
   * Zero for a subject the bundler did not flatten into this Cell, which is the honest reading: a
   * package whose code is not in the artifact did not make it too large.
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
export type SubjectCompileDecision =
  | { readonly strategy: "inline" }
  | { readonly strategy: "host"; readonly globalName: string }
  | { readonly strategy: "extension"; readonly globalName: string; readonly libraryId: string };

/** Whether a value is one of the strategies a subject can have been compiled under. */
export function isSubjectCompileDecision(value: unknown): value is SubjectCompileDecision {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.strategy) {
    case "inline":
      return Object.keys(candidate).every(key => key === "strategy");
    case "host":
      return (
        typeof candidate.globalName === "string" &&
        candidate.globalName.trim().length > 0 &&
        Object.keys(candidate).every(key => key === "strategy" || key === "globalName")
      );
    case "extension":
      return (
        typeof candidate.globalName === "string" &&
        candidate.globalName.trim().length > 0 &&
        typeof candidate.libraryId === "string" &&
        candidate.libraryId.trim().length > 0 &&
        Object.keys(candidate).every(key => key === "strategy" || key === "globalName" || key === "libraryId")
      );
    default:
      // `replace` is deliberately absent, not an oversight: it keeps the package out of the compiled
      // graph (rule 4 of #8), so a Cell can never have been measured with the subject in it under
      // `replace`. The writer refuses to produce one; this refuses to accept one.
      return false;
  }
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
        if (!isSubjectCompileDecision(subjectDecision)) {
          // The union, not a `strategy` string (#77 revision 17). A persisted `replace` is the one
          // state the writer refuses to produce because it cannot be replayed — the package is not
          // in that Cell — and accepting it here would let a hand-edited lock renew a rejection from
          // a compile that never contained the subject. `host`/`extension` missing their globals are
          // refused for the same reason: replaying them would not reproduce the measured Cell.
          problems.push(
            `Rejection of "${decision.packageName}" records \`artifactEvidence.subjectDecision\` as ${JSON.stringify(subjectDecision)}, which is not a decision the subject can have been compiled under. It must be \`{"strategy":"inline"}\`, or \`host\`/\`extension\` with the global (and library) those strategies resolve the package to — never \`replace\`, which keeps the package out of the compiled Cell and so cannot describe the Cell that was measured.`,
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
          // A local bound, and the only thing checked about the attribution (#77 revision 17).
          // The share cannot exceed the artifact it is a share *of*: a larger number would make the
          // residual negative and satisfy any comparison trivially, which revision 16 accepted.
          //
          // The share is deliberately **not** a rejection rule — `codeCharacters -
          // subjectRenderedCharacters` is not "the Cell without this package" (see
          // `ArtifactBudgetEvidence` for the counterexample that compiles) — so nothing here refuses
          // on it. A reviewer weighs it; `status` recomputes it.
          if (Number.isFinite(subjectRenderedCharacters) && subjectRenderedCharacters > codeCharacters) {
            problems.push(
              `Rejection of "${decision.packageName}" records \`artifactEvidence.subjectRenderedCharacters: ${String(subjectRenderedCharacters)}\`, which exceeds the whole artifact's ${String(codeCharacters)} characters. A share of the artifact cannot be larger than the artifact.`,
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
