/**
 * The sync error model.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), governed by
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 * - #12 "`extension` dependencies as external modules + `frontendLibraries` metadata"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/12
 *
 * #19 asks for "a structured missing-extension diagnostic", and its whole Safety
 * section is a list of conditions that must be *surfaced* rather than resolved
 * silently. The reader of a sync diagnostic is an Agent choosing a next action, and
 * the action differs per condition in a way no message string carries — a missing
 * extension has to be built elsewhere, a diverged Cell has to be looked at by a
 * person, an unestablished capability has to be probed. So a diagnostic carries a
 * stable code, what it is about, and whose job the fix is.
 *
 * ## Why the extension half is translated rather than re-detected
 *
 * #12's `auditExtensionLibraryMetadata` already answers "does this project's listing
 * agree with the mapping", and re-deriving it here would be a second implementation
 * of a rule that has one. So the detection is `core`'s and this module owns the
 * *translation*: {@link EXTENSION_AUDIT_TRANSLATION} maps every
 * `ExtensionExternalDiagnosticCode` onto a sync code, and it is typed as a total
 * `Record` so a new code in `core` fails this package's type check instead of being
 * dropped on the floor.
 *
 * The translation is two-way rather than one-to-one because the *fix route* is what
 * differs, and `fixOwner` exists precisely to say it: an id the project's listing does
 * not know has to be built and uploaded elsewhere (delegated, per #19), while a
 * library that exists with the wrong global or a missing bundle is a broken install
 * in this project. Collapsing them into one code would send an Agent to the wrong
 * place for one of the two.
 */

import { EXTENSION_EXTERNAL_DIAGNOSTIC_CODES, extensionExternalDiagnosticRule } from "@forguncy-react-workspace/core";
import type {
  ExtensionExternalDiagnostic,
  ExtensionExternalDiagnosticCode,
} from "@forguncy-react-workspace/core";

import type { SyncGuaranteeId } from "./guarantees.ts";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** Codes for the conditions #19's own flow and Safety sections name. */
export const REQUIRED_SYNC_DIAGNOSTIC_CODES = [
  "missing-extension",
  "extension-metadata-unverified",
  "project-errors-after-sync",
  "runtime-generation-failed",
  "cell-diverged",
  "cell-state-unverifiable",
] as const;

export type RequiredSyncDiagnosticCode = (typeof REQUIRED_SYNC_DIAGNOSTIC_CODES)[number];

/**
 * Codes this contract needs in order to be reportable at all.
 *
 * Not extra failure modes bolted on: writing the contract surfaced conditions that
 * #19's sentences imply but do not name — an artifact that is not generated output,
 * references that disagree with the decisions they came from, a required designer
 * operation with no established call. Reporting any of them under one of the required
 * codes would point an Agent at the wrong fix, which is the same reasoning #6 records
 * for its own second family.
 */
export const CONTRACT_SYNC_DIAGNOSTIC_CODES = [
  "artifact-not-generated",
  "extension-identity-mismatch",
  "extension-decision-unusable",
  "library-reference-mismatch",
  "sync-capability-unestablished",
] as const;

export type ContractSyncDiagnosticCode = (typeof CONTRACT_SYNC_DIAGNOSTIC_CODES)[number];

export type SyncDiagnosticCode = RequiredSyncDiagnosticCode | ContractSyncDiagnosticCode;

/** Both families, required first, so a report prints #19's own vocabulary first. */
export const SYNC_DIAGNOSTIC_CODES: readonly SyncDiagnosticCode[] = [
  ...REQUIRED_SYNC_DIAGNOSTIC_CODES,
  ...CONTRACT_SYNC_DIAGNOSTIC_CODES,
];

/**
 * Where a code came from: a sentence in #19, or a condition writing the contract
 * down made unavoidable.
 */
export type SyncDiagnosticOrigin = "issue-19-flow" | "issue-19-safety" | "sync-contract";

/**
 * Who has to act on a diagnostic.
 *
 * `dependency-decision` is #6's own owner name, reused rather than renamed: an
 * `extension` decision the mapping table cannot bind is the same wrong decision
 * whichever boundary notices it, and two names for one owner would make a reader
 * wonder whether they were two places to look.
 */
export type SyncFixOwner =
  | "dependency-decision"
  | "extension-package"
  | "project-config"
  | "project-state"
  | "generated-output"
  | "sync-tooling";

/**
 * The one delegation #19 names.
 *
 * Typed to that single repository on purpose: #19 says extension creation and upload
 * are outside this repository's path and that sync must delegate rather than invent
 * an extension package here, so there is exactly one place a missing extension can be
 * sent, and a second value would be a second policy.
 */
export interface SyncExtensionDelegate {
  readonly repository: "MangMax/forguncy-frontend-library";
  readonly reason: string;
}

export const EXTENSION_CREATION_DELEGATE: SyncExtensionDelegate = {
  repository: "MangMax/forguncy-frontend-library",
  reason:
    "#19: extension creation/upload is outside this repository's normal path, so an extension a sync needs but the project does not have is reported and delegated rather than invented here.",
};

/** Where a condition another package already detects was read from. */
export interface SyncDiagnosticDerivation {
  readonly detectedBy: string;
  readonly code: ExtensionExternalDiagnosticCode;
}

/**
 * The package that owns the extension-audit vocabulary.
 *
 * `derivedFrom.detectedBy` names the owner of the finding's *code*, not the call site that
 * raised it. That is the only stable answer, because two detectors raise through this
 * vocabulary — `core`'s `auditExtensionLibraryMetadata` reports a library it cannot find or
 * one whose global disagrees, and the compiler's own plan reports a reference it resolved
 * through a library the artifact does not declare — and the same sync code is reached from
 * either. `code` is what distinguishes the findings; `EXTENSION_AUDIT_TRANSLATION` is where
 * each one is mapped.
 */
export const EXTENSION_AUDIT_DETECTOR = "@forguncy-react-workspace/core";

export interface SyncDiagnosticRule {
  readonly code: SyncDiagnosticCode;
  readonly origin: SyncDiagnosticOrigin;
  /** A short human label for a summary line. */
  readonly label: string;
  /** One sentence stating what went wrong, without the offending value. */
  readonly states: string;
  /** What to do about it. Never empty: a diagnostic is not a dead end. */
  readonly remediation: string;
  readonly fixOwner: SyncFixOwner;
  readonly breaksGuarantees: readonly SyncGuaranteeId[];
  /**
   * Whether this finding stops the mutation.
   *
   * Carried on the rule rather than inferred from a set of codes in `sync-plan.ts`, and
   * that is the point: a new diagnostic has to answer the question explicitly, whereas a
   * membership test would make every new code non-blocking by default — a fail-open
   * default on the one axis where being wrong writes over something.
   *
   * `false` is not "unimportant": the two post-mutation gates are consequences of a write
   * that already happened, so they cannot stop it.
   */
  readonly blocksMutation: boolean;
  /**
   * Set when this code is the sync-side name for a condition `core` or the compiler
   * already detects, so the detection has one implementation and this rule only says
   * how sync reports it.
   *
   * A statement about the *code*, not about an instance: a code two detectors can raise
   * (or that sync itself also detects) names one here only when that is the only way it
   * arises. An instance's own origin is {@link SyncDiagnostic.derivedFrom}, which only
   * {@link syncDiagnosticFromExtensionAudit} sets, because only a translation knows which
   * upstream finding it came from.
   */
  readonly derivedFrom?: SyncDiagnosticDerivation;
}

export const SYNC_DIAGNOSTIC_RULES: Readonly<Record<SyncDiagnosticCode, SyncDiagnosticRule>> = {
  "missing-extension": {
    code: "missing-extension",
    origin: "issue-19-flow",
    label: "Required extension is absent",
    states:
      "The artifact references an extension the project does not have installed, so the generated code would read a global nothing on the page publishes.",
    remediation:
      "Create or upload the extension package before syncing, then re-run. #19 puts extension packaging outside this repository, so the work is delegated rather than done here: report the missing id to the frontend-library repository and do not synthesise an extension package to make the sync pass.",
    fixOwner: "extension-package",
    breaksGuarantees: ["extension-metadata-verified-before-mutation"],
    blocksMutation: true,
    derivedFrom: { detectedBy: EXTENSION_AUDIT_DETECTOR, code: "extension-library-unverified" },
  },
  "extension-metadata-unverified": {
    code: "extension-metadata-unverified",
    origin: "issue-19-flow",
    label: "Extension metadata was never checked",
    states:
      "The artifact references extensions, and no listing of the project's installed libraries was supplied to verify them against.",
    remediation:
      "Call `api.app.listFrontendLibraries` and pass the result, or sync an artifact with no extension references. #19 requires the extension identities to be verified *before* the write, so an unverified reference is not a warning: it is the state in which a guessed or stale `libraryId` reaches the page and fails at render time.",
    fixOwner: "sync-tooling",
    breaksGuarantees: ["extension-metadata-verified-before-mutation"],
    blocksMutation: true,
  },
  "project-errors-after-sync": {
    code: "project-errors-after-sync",
    origin: "issue-19-flow",
    label: "Project has errors after sync",
    states: "The project reports errors after the Cell was written, so the write did not leave the project valid.",
    remediation:
      "Treat the sync as failed and read the project's own error list. A non-zero error count after a mutation is #19's validation gate: reporting success here would deploy a broken page and defer the discovery to whoever opens it.",
    fixOwner: "project-state",
    breaksGuarantees: ["project-errors-checked-after-mutation"],
    blocksMutation: false,
  },
  "runtime-generation-failed": {
    code: "runtime-generation-failed",
    origin: "issue-19-flow",
    label: "Page generation produced no runtime locator",
    states: "The page was not generated, so there is nothing for browser verification to open.",
    remediation:
      "Fix the reported generation failure and re-sync. The locator is the sync's result, so a sync that could not produce one has not finished — returning success with no URL would make the next step verify a page nobody generated.",
    fixOwner: "project-state",
    breaksGuarantees: ["runtime-locator-returned"],
    blocksMutation: false,
  },
  "cell-diverged": {
    code: "cell-diverged",
    origin: "issue-19-safety",
    label: "Target Cell diverged from generated output",
    states:
      "The target Cell holds code that sync did not write last, or code it wrote and that has since been edited, so overwriting it would destroy work the repository cannot reproduce.",
    remediation:
      "Read the Cell and decide: if the change belongs in the repository, move it there and re-sync; if it was an experiment, re-run with the overwrite policy set to force — which records what it overrode — or clear the Cell. Do not widen the policy to `force` by default; the whole point of the check is that a person decides.",
    fixOwner: "project-state",
    breaksGuarantees: ["probable-designer-divergence-detected"],
    blocksMutation: true,
  },
  "cell-state-unverifiable": {
    code: "cell-state-unverifiable",
    origin: "issue-19-safety",
    label: "Target Cell state could not be read",
    states:
      "The target Cell's current source was not available, so sync cannot tell generated output from designer work and cannot check for divergence.",
    remediation:
      "Supply the Cell's current source, or establish the designer operation that reads one. #19 requires divergence to be detected *before* an overwrite, so an unread target is a refusal rather than a reason to write blindly; the overwrite policy can be set to force when that is a deliberate decision.",
    fixOwner: "sync-tooling",
    breaksGuarantees: ["probable-designer-divergence-detected"],
    blocksMutation: true,
  },
  "artifact-not-generated": {
    code: "artifact-not-generated",
    origin: "issue-19-safety",
    label: "Artifact is not compiler output",
    states:
      "The code about to be deployed does not open with the compiler's banner, so it cannot be recognised as generated output later.",
    remediation:
      "Compile the Cell through the compiler and sync its result. A fingerprint stamped onto code the compiler did not produce would claim a provenance the Cell does not have, which is what breaks the divergence check for every following sync.",
    fixOwner: "generated-output",
    breaksGuarantees: ["sync-is-idempotent", "probable-designer-divergence-detected"],
    blocksMutation: true,
  },
  "extension-identity-mismatch": {
    code: "extension-identity-mismatch",
    origin: "sync-contract",
    label: "Installed extension does not match the mapping",
    states:
      "The project has a library with the referenced id, but the global it publishes, its runtime bundle or its type definitions do not agree with what the artifact was compiled against.",
    remediation:
      "Fix the project's extension install: re-upload the package at the version the mapping describes, or correct the mapping. This is not a missing extension — the id resolves — so delegating the creation of a new package would replace a fixable install with a second package.",
    fixOwner: "project-state",
    breaksGuarantees: ["extension-metadata-verified-before-mutation"],
    blocksMutation: true,
  },
  "extension-decision-unusable": {
    code: "extension-decision-unusable",
    origin: "sync-contract",
    label: "Extension decision cannot be bound",
    states:
      "A dependency is decided `extension` but the mapping information cannot bind it, or contradicts itself, so there is no single extension the artifact can be verified against.",
    remediation:
      "Resolve the decision before syncing: give the package exactly one mapping row, or change the strategy. Syncing a decision the resolver itself reports as unresolved would deploy code whose library reference nothing can verify.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["extension-metadata-verified-before-mutation"],
    blocksMutation: true,
    derivedFrom: { detectedBy: EXTENSION_AUDIT_DETECTOR, code: "extension-mapping-missing" },
  },
  "library-reference-mismatch": {
    code: "library-reference-mismatch",
    origin: "sync-contract",
    label: "Library references disagree with the decisions",
    states:
      "The artifact's `frontendLibraries` references are not the set its own dependency decisions imply, so what the page is told to load and what the code was compiled against differ.",
    remediation:
      "Recompile the artifact from the current decisions rather than editing the metadata in the Cell. The references are derived, so a hand-corrected list would be overwritten by the next sync and would keep the page loading a library the code does not use — or missing one it does.",
    fixOwner: "generated-output",
    breaksGuarantees: ["extension-metadata-verified-before-mutation", "sync-is-idempotent"],
    blocksMutation: true,
    // Deliberately no rule-level `derivedFrom`: this code has two detectors — sync's own
    // comparison of references against decisions, and the compiler's `extension-not-declared`
    // — so a single rule-level origin would be wrong for the other one.
  },
  "sync-capability-unestablished": {
    code: "sync-capability-unestablished",
    origin: "sync-contract",
    label: "Required designer operation has no established call",
    states:
      "A step the flow needs has no designer call name recorded in the evidence, so the sync cannot be executed end to end without guessing one.",
    remediation:
      "Establish the operation before executing the flow: enumerate the designer session's surface for it, or run a probe that performs it once and records the exact call. Every required operation is established as of #20 — `api.page.getCells` to read a target and `api.app.saveProject` to persist — so this diagnostic no longer arises from the shipped flow; it is kept because the guard that raises it is what stops a future operation from acquiring a plausible name without evidence, and that guard is exercised against supplied records in `capability-surface.test.ts`.",
    fixOwner: "sync-tooling",
    breaksGuarantees: ["probable-designer-divergence-detected", "project-errors-checked-after-mutation"],
    blocksMutation: true,
  },
};

// ---------------------------------------------------------------------------
// The translation from `core`'s extension audit
// ---------------------------------------------------------------------------

/**
 * How each of `core`'s extension-audit codes is reported at the sync boundary.
 *
 * Total over `ExtensionExternalDiagnosticCode`, and that is the point: adding a code
 * to `core` makes this map incomplete, which is a type error here rather than a
 * finding that silently never appears in a sync report. The grouping is by fix route,
 * not by wording — see the module docstring.
 */
export const EXTENSION_AUDIT_TRANSLATION: Readonly<
  Record<ExtensionExternalDiagnosticCode, SyncDiagnosticCode>
> = {
  "extension-library-unverified": "missing-extension",
  "extension-global-mismatch": "extension-identity-mismatch",
  "extension-bundle-missing": "extension-identity-mismatch",
  "extension-types-missing": "extension-identity-mismatch",
  "extension-global-missing": "extension-identity-mismatch",
  "extension-mapping-missing": "extension-decision-unusable",
  "extension-mapping-conflict": "extension-decision-unusable",
  "extension-not-declared": "library-reference-mismatch",
};

/** True when a code is one this package translates from the extension audit. */
export function translatedExtensionAuditCodes(): readonly ExtensionExternalDiagnosticCode[] {
  return [...EXTENSION_EXTERNAL_DIAGNOSTIC_CODES];
}

// ---------------------------------------------------------------------------
// Building and reporting
// ---------------------------------------------------------------------------

export interface SyncDiagnostic {
  readonly code: SyncDiagnosticCode;
  /** What the diagnostic is about: a library id, a module id, a Cell, a step. */
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixOwner: SyncFixOwner;
  readonly breaksGuarantees: readonly SyncGuaranteeId[];
  /** Present on every `missing-extension`, so a caller does not have to read the rule. */
  readonly delegate?: SyncExtensionDelegate;
  /** Present when another package detected the condition. */
  readonly derivedFrom?: SyncDiagnosticDerivation;
}

export function isSyncDiagnosticCode(value: unknown): value is SyncDiagnosticCode {
  return typeof value === "string" && (SYNC_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function syncDiagnosticRule(code: SyncDiagnosticCode): SyncDiagnosticRule {
  return SYNC_DIAGNOSTIC_RULES[code];
}

/**
 * Builds a diagnostic from the rule table.
 *
 * `detail` is appended to the rule's sentence rather than replacing it, so the generic
 * statement stays reviewable in one place and the per-occurrence facts stay in the
 * diagnostic. The delegate is copied onto a `missing-extension` instance so a caller
 * branching on the case does not have to look up the rule.
 *
 * `derivedFrom` is deliberately **not** copied from the rule: a rule saying "this code
 * names an upstream finding" is a statement about the code, and this function is also how
 * sync reports conditions *it* detected under a code that usually comes from upstream. The
 * instance-level field is set only by {@link syncDiagnosticFromExtensionAudit}, which knows
 * which upstream finding it translated.
 */
export function createSyncDiagnostic(
  code: SyncDiagnosticCode,
  subject: string,
  options: { readonly detail?: string } = {},
): SyncDiagnostic {
  const rule = syncDiagnosticRule(code);
  const message = options.detail === undefined ? rule.states : `${rule.states} ${options.detail}`;
  return {
    code,
    subject,
    message,
    remediation: rule.remediation,
    fixOwner: rule.fixOwner,
    breaksGuarantees: rule.breaksGuarantees,
    ...(code === "missing-extension" ? { delegate: EXTENSION_CREATION_DELEGATE } : {}),
  };
}

/**
 * Reports a finding `core`'s extension audit produced, in the sync's own vocabulary.
 *
 * The message is the sync rule's sentence plus `core`'s own `detail`, and deliberately
 * *not* `core`'s `states` as well: that sentence describes the same condition at a
 * different boundary, and printing both would read as two problems. The `derivedFrom` field
 * is what keeps the origin visible, and it names the code this translation came *from* —
 * which is why it is set here rather than on the rule: four audit codes map to
 * `extension-identity-mismatch`, and a rule-level origin could name only one of them.
 */
export function syncDiagnosticFromExtensionAudit(diagnostic: ExtensionExternalDiagnostic): SyncDiagnostic {
  const code = EXTENSION_AUDIT_TRANSLATION[diagnostic.code];
  // Read, not assumed: the rule table is where `core` records that it knows the code at
  // all, so an unrecognised code fails here instead of producing a message-less diagnostic.
  extensionExternalDiagnosticRule(diagnostic.code);
  return {
    ...createSyncDiagnostic(code, diagnostic.subject, { detail: diagnostic.detail }),
    derivedFrom: { detectedBy: EXTENSION_AUDIT_DETECTOR, code: diagnostic.code },
  };
}

/**
 * Collapses diagnostics that say the same thing about the same subject.
 *
 * Several checks overlap by construction — the artifact's references are compared to
 * the decisions and the audit compares the mapping to the listing, and both can speak
 * about one library — so without this a caller counting diagnostics would be counting
 * detectors.
 */
export function dedupeSyncDiagnostics(diagnostics: readonly SyncDiagnostic[]): readonly SyncDiagnostic[] {
  const seen = new Set<string>();
  const result: SyncDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/** One line, for a PR body, a CLI summary or a test failure message. */
export function formatSyncDiagnostic(diagnostic: SyncDiagnostic): string {
  const delegate = diagnostic.delegate === undefined ? "" : ` Delegate: ${diagnostic.delegate.repository}.`;
  const derived =
    diagnostic.derivedFrom === undefined
      ? ""
      : ` Detected by ${diagnostic.derivedFrom.detectedBy} as "${diagnostic.derivedFrom.code}".`;
  return `[${diagnostic.code}] ${diagnostic.subject}: ${diagnostic.message} Fix (${diagnostic.fixOwner}): ${diagnostic.remediation}${delegate}${derived}`;
}

/** A block a report or a test failure can carry verbatim. */
export function formatSyncDiagnostics(diagnostics: readonly SyncDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No sync diagnostics.";
  }
  return diagnostics.map(diagnostic => `- ${formatSyncDiagnostic(diagnostic)}`).join("\n");
}

export function syncDiagnosticCodes(diagnostics: readonly SyncDiagnostic[]): readonly SyncDiagnosticCode[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}
