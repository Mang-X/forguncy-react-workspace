/**
 * The generated-artifact error model.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * #6 requires "structured diagnostics" rather than opaque build strings. The
 * reason is who reads them: the caller is an Agent that has to choose a next
 * action, and a thrown `Error("build failed: …")` cannot be branched on. So a
 * diagnostic carries a stable code, the thing it is about, and — this is the
 * part a message alone loses — *whose job the fix is*.
 *
 * Two families of codes live here, and the difference matters when reporting:
 *
 * - The six `issue-6-error-model` codes are the failure modes #6 names. They are
 *   the contract's public vocabulary and must not be renamed casually, because a
 *   downstream Issue, Skill or report branches on them.
 * - The `issue-6-contract` codes are not extra failure modes bolted on. They
 *   exist because #6's *guarantees* are also breakable — an artifact that keeps
 *   a source-level import is not a rejected dependency, it is a produced
 *   artifact that breaks guarantee 2 — and reporting such a case under one of the
 *   six would point the Agent at the wrong fix.
 */

import type { CellArtifactGuaranteeId } from "./guarantees.ts";

/** The failure modes GitHub Issue #6 names explicitly. */
export const REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES = [
  "unresolved-dependency-decision",
  "platform-conflicting-dependency",
  "cell-code-budget-exceeded",
  "unsupported-runtime-asset",
  "missing-extension-mapping",
  "duplicate-host-mapping",
] as const;

export type RequiredCellArtifactDiagnosticCode = (typeof REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES)[number];

/** Codes the public guarantees need in order to be reportable at all. */
export const CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES = [
  "source-level-import-remains",
  "rejected-cell-entry-shape",
  "rejected-cell-source-construct",
  "non-canonical-artifact-metadata",
  "bundler-failure",
] as const;

export type ContractCellArtifactDiagnosticCode = (typeof CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES)[number];

export type CellArtifactDiagnosticCode = RequiredCellArtifactDiagnosticCode | ContractCellArtifactDiagnosticCode;

/** Both families, required first, so a report prints the Spec's vocabulary first. */
export const CELL_ARTIFACT_DIAGNOSTIC_CODES: readonly CellArtifactDiagnosticCode[] = [
  ...REQUIRED_CELL_ARTIFACT_DIAGNOSTIC_CODES,
  ...CONTRACT_CELL_ARTIFACT_DIAGNOSTIC_CODES,
];

/**
 * Whether a code is a failure mode #6 names, or a code a #6 guarantee needs in
 * order to be checkable. Not cosmetic: the first family is the contract's public
 * vocabulary.
 */
export type CellArtifactDiagnosticOrigin = "issue-6-error-model" | "issue-6-contract";

/**
 * Who has to act on a diagnostic.
 *
 * Branching on the code alone tells a caller *what* broke; this tells it whether
 * to go back to the dependency decision, to the bundler configuration, or to the
 * cell source. Without it, "unresolved dependency" and "remaining import" look
 * equally like bundler problems.
 */
export type CellArtifactFixOwner = "dependency-decision" | "bundler-configuration" | "cell-source";

export interface CellArtifactDiagnosticRule {
  readonly code: CellArtifactDiagnosticCode;
  readonly origin: CellArtifactDiagnosticOrigin;
  /** A short human label for a summary line. */
  readonly label: string;
  /** One sentence stating what went wrong, without the offending value. */
  readonly states: string;
  /** What to do about it. Never empty: a diagnostic is not a dead end. */
  readonly remediation: string;
  readonly fixOwner: CellArtifactFixOwner;
  /** The #6 guarantees a violation of this code breaks. */
  readonly breaksGuarantees: readonly CellArtifactGuaranteeId[];
}

/**
 * The rule table.
 *
 * Every diagnostic is created through {@link createCellArtifactDiagnostic}, so a
 * code cannot reach a caller without a remediation and a fix owner — the two
 * fields a message-only error model always ends up missing.
 */
export const CELL_ARTIFACT_DIAGNOSTIC_RULES: Readonly<
  Record<CellArtifactDiagnosticCode, CellArtifactDiagnosticRule>
> = {
  "unresolved-dependency-decision": {
    code: "unresolved-dependency-decision",
    origin: "issue-6-error-model",
    label: "Unresolved dependency decision",
    states:
      "A dependency reached the Cell artifact with no single usable decision, so the compiler cannot know whether to inline it, map it to a host global or reference an extension.",
    remediation:
      "Resolve the dependency before compiling: add exactly one decision for the package, or remove the import from the cell source. Resolving it is the dependency resolver's job (#4), not something the compiler may guess.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["no-unresolved-source-imports"],
  },
  "platform-conflicting-dependency": {
    code: "platform-conflicting-dependency",
    origin: "issue-6-error-model",
    label: "Platform-conflicting dependency",
    states: "A package implementing a Forguncy-owned capability reached the Cell artifact.",
    remediation:
      "Treat this as a platform conflict, not a bundling failure: route the capability to the Forguncy host and remove the package from the cell source. Do not add a package-specific adapter — no dependency strategy resolves an ownership conflict (#4).",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["no-unresolved-source-imports"],
  },
  "cell-code-budget-exceeded": {
    code: "cell-code-budget-exceeded",
    origin: "issue-6-error-model",
    label: "Cell code budget exceeded",
    states: "The generated Cell code is larger than the configured cell code budget.",
    remediation:
      "Move the dependency to a verified extension, or split the cell. The budget is supplied by the caller and is not defaulted here: #5 found no hard platform limit, so claiming one would be inventing policy.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: [],
  },
  "unsupported-runtime-asset": {
    code: "unsupported-runtime-asset",
    origin: "issue-6-error-model",
    label: "Unsupported runtime asset or chunk behaviour",
    states: "The artifact depends on runtime asset or chunk loading the target cannot serve.",
    remediation:
      "Inline the asset and remove the dynamic import. The MVP artifact is one logical script with no runtime chunk loading; a call that survives into the artifact is not caught by the platform validator, so this check is the only thing standing between it and production.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: ["inline-dependencies-flattened"],
  },
  "missing-extension-mapping": {
    code: "missing-extension-mapping",
    origin: "issue-6-error-model",
    label: "Missing extension mapping or global",
    states: "An `extension` dependency has no usable extension mapping, so the artifact cannot reference it.",
    remediation:
      "Record the stable `libraryId` returned by `api.app.listFrontendLibraries` and the extension's global in the dependency decision, then reference that global instead of bundling a copy.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["extension-dependencies-reference-extension"],
  },
  "duplicate-host-mapping": {
    code: "duplicate-host-mapping",
    origin: "issue-6-error-model",
    label: "Duplicate or invalid host mapping",
    states:
      "A `host` dependency maps to a global that is not a verified host identity, to one that another package already claims, or to one other than the global its bridge mapping binds.",
    remediation:
      "Map the package to one of the names #5 verified as visible inside a cell, give each package its own global, and make the `globalName` the bridge row binds the one the decision records. Two packages sharing one global, one package bundled alongside its own host mapping, or a decision naming a global its row does not bind, all break the singleton semantics `host` exists to preserve — the last because the artifact reads the row's object while the lock records another.",
    fixOwner: "dependency-decision",
    breaksGuarantees: ["host-dependencies-reference-host-identity"],
  },
  "source-level-import-remains": {
    code: "source-level-import-remains",
    origin: "issue-6-contract",
    label: "Source-level import remains",
    states: "A source-level import survived into the generated artifact.",
    remediation:
      "Inline the dependency, map it to a host global, or reference a verified extension. No import declaration is accepted by the target, so a remaining one fails the platform's write-time validator as well as this contract.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: [
      "no-unresolved-source-imports",
      "inline-dependencies-flattened",
      "host-dependencies-reference-host-identity",
      "workspace-packages-inline-like-source",
    ],
  },
  "rejected-cell-entry-shape": {
    code: "rejected-cell-entry-shape",
    origin: "issue-6-contract",
    label: "Entry shape cannot be emitted",
    states: "The requested Cell entry shape cannot be emitted around a bundled module.",
    remediation:
      "Emit one of the supported shapes: an `App` binding or a `render(value)` call. Two of the platform's accepted shapes are unusable here — the async function declaration is accepted by the write-time validator and then refused by React 19, and a whole-source expression cannot coexist with a bundled body.",
    fixOwner: "cell-source",
    breaksGuarantees: ["accepted-by-react-cell-type"],
  },
  "rejected-cell-source-construct": {
    code: "rejected-cell-source-construct",
    origin: "issue-6-contract",
    label: "Construct the target refuses",
    states: "The generated artifact contains a construct the target refuses in cell source.",
    remediation:
      "Remove the construct from the source, or move the dependency that contains it out of the artifact. The platform rejects these names, so it cannot tell a library that *uses* one from a library that merely defines it — inlining such a library fails, it does not merely warn.",
    fixOwner: "cell-source",
    breaksGuarantees: ["accepted-by-react-cell-type"],
  },
  "non-canonical-artifact-metadata": {
    code: "non-canonical-artifact-metadata",
    origin: "issue-6-contract",
    label: "Non-canonical artifact metadata",
    states: "The artifact's generated banner or `frontendLibraries` metadata is not in its canonical form.",
    remediation:
      "Rebuild through the compiler instead of editing generated code. A non-canonical banner or library order means identical inputs no longer produce identical output, which is the one property that lets a generated artifact be diffed in review.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: ["deterministic-artifact"],
  },
  "bundler-failure": {
    code: "bundler-failure",
    origin: "issue-6-contract",
    label: "Bundler failed",
    states: "The bundler failed before it produced a module for the entry.",
    remediation:
      "Fix the reported bundling failure. The compiler reports it as a structured diagnostic rather than letting it escape as an exception, because a thrown string is exactly the opaque build output the Spec's error model exists to replace.",
    fixOwner: "bundler-configuration",
    breaksGuarantees: [],
  },
};

export function isCellArtifactDiagnosticCode(value: unknown): value is CellArtifactDiagnosticCode {
  return typeof value === "string" && (CELL_ARTIFACT_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function cellArtifactDiagnosticRule(code: CellArtifactDiagnosticCode): CellArtifactDiagnosticRule {
  return CELL_ARTIFACT_DIAGNOSTIC_RULES[code];
}

export interface CellArtifactDiagnostic {
  readonly code: CellArtifactDiagnosticCode;
  /** What the diagnostic is about: a package name, an import specifier, a file, a metadata field. */
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixOwner: CellArtifactFixOwner;
  /** The #6 guarantees a violation of this code breaks. */
  readonly breaksGuarantees: readonly CellArtifactGuaranteeId[];
  /**
   * Where in the artifact the problem is, when the check knows. Kept separate
   * from `subject` so a report can print one without the other.
   */
  readonly location?: string;
}

/**
 * Builds a diagnostic from the rule table.
 *
 * `detail` is appended to the rule's sentence rather than replacing it, so the
 * generic statement stays reviewable in one place and the per-occurrence facts
 * stay in the diagnostic.
 */
export function createCellArtifactDiagnostic(
  code: CellArtifactDiagnosticCode,
  subject: string,
  options: { readonly detail?: string; readonly location?: string } = {},
): CellArtifactDiagnostic {
  const rule = cellArtifactDiagnosticRule(code);
  const message = options.detail === undefined ? rule.states : `${rule.states} ${options.detail}`;
  return {
    code,
    subject,
    message,
    remediation: rule.remediation,
    fixOwner: rule.fixOwner,
    breaksGuarantees: rule.breaksGuarantees,
    ...(options.location === undefined ? {} : { location: options.location }),
  };
}

/**
 * Collapses diagnostics that say the same thing about the same subject.
 *
 * Several checks deliberately overlap — a bundler can both report a specifier as
 * external *and* leave the import statement in its output — so without this a
 * single problem would be reported once per detector and a caller counting
 * diagnostics would be counting detectors instead.
 */
export function dedupeCellArtifactDiagnostics(
  diagnostics: readonly CellArtifactDiagnostic[],
): readonly CellArtifactDiagnostic[] {
  const seen = new Set<string>();
  const result: CellArtifactDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/** One line, for a PR body, a CLI summary or a test failure message. */
export function formatCellArtifactDiagnostic(diagnostic: CellArtifactDiagnostic): string {
  const where = diagnostic.location === undefined ? "" : ` (${diagnostic.location})`;
  return `[${diagnostic.code}] ${diagnostic.subject}${where}: ${diagnostic.message} Fix (${diagnostic.fixOwner}): ${diagnostic.remediation}`;
}

/** A block a report or a test failure can carry verbatim. */
export function formatCellArtifactDiagnostics(diagnostics: readonly CellArtifactDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No Cell artifact diagnostics.";
  }
  return diagnostics.map(diagnostic => `- ${formatCellArtifactDiagnostic(diagnostic)}`).join("\n");
}

export function cellArtifactDiagnosticCodes(
  diagnostics: readonly CellArtifactDiagnostic[],
): readonly CellArtifactDiagnosticCode[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}
