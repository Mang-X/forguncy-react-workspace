/**
 * #19's step 2: verify the extensions an artifact references, from the project.
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
 * #19 writes this step as: "For `extension` dependencies, call
 * `listFrontendLibraries` and verify stable `libraryId`, existence, type definitions,
 * and expected `globalName` before writing." Two of those four questions are already
 * answered by a function in this repository — #12's `auditExtensionLibraryMetadata`
 * compares a mapping against a real listing, and `planExtensionExternals` runs it and
 * reports the verdict — so this module **calls** that rather than re-deriving it. The
 * one question it adds is the one no build-time audit can ask, because a build-time
 * audit never sees an artifact:
 *
 *   *does what the artifact says the page must load match what its own decisions say
 *   it needs?*
 *
 * That comparison is the reason this module exists. `CompileCellResult.frontendLibraries`
 * is the only metadata the artifact carries (#6), and it is *derived* — so it can be
 * wrong in the two directions that matter: a reference nothing explains (the page is
 * told to load a library no decision selected) and a reference the decisions imply but
 * the artifact does not carry (the generated code reads a global nothing loads). #12
 * detects the second inside the compiler's own plan; neither is detectable from the
 * listing, because the listing knows what the project *has*, not what the artifact
 * *needs*.
 *
 * The verdict on whether verification happened at all is #12's own axis (`stated` /
 * `unstated`), re-exported rather than re-invented: supplying a listing and supplying
 * an empty one are different answers, and reading "we were not given a listing" as "the
 * project has no extensions" is how a guessed library id would pass a check.
 */

import { planExtensionExternals } from "@forguncy-react-workspace/cell-compiler";
import { frontendLibraryIds } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import type {
  DependencyDecision,
  ExtensionExternalMapping,
  ExtensionLibraryListing,
} from "@forguncy-react-workspace/core";

import { createSyncDiagnostic, syncDiagnosticFromExtensionAudit } from "./diagnostics";
import type { SyncDiagnostic } from "./diagnostics";

/**
 * Whether the project's extension metadata was available to check against.
 *
 * `unstated` is not "clean". It means the verification step has not happened, which
 * #19's flow requires before any write, so the plan refuses when the artifact has
 * references to verify and this is `unstated`.
 */
export type ExtensionVerificationStatus = "stated" | "unstated";

export interface VerifyExtensionReferencesOptions {
  /** The artifact about to be written. Its references are half of the comparison. */
  readonly artifact: CompileCellResult;
  /** The decisions the artifact was compiled against. The other half. */
  readonly decisions: readonly DependencyDecision[];
  /**
   * What `api.app.listFrontendLibraries` returned.
   *
   * Optional, and omitting it is a *different state* from supplying an empty list: see
   * {@link ExtensionVerificationStatus}.
   */
  readonly listings?: readonly ExtensionLibraryListing[];
  /** The mapping table to audit against. Defaults to `core`'s shipped table. */
  readonly mappings?: readonly ExtensionExternalMapping[];
}

export interface ExtensionReferenceVerification {
  readonly verification: ExtensionVerificationStatus;
  /** The library ids the artifact declares, in the order it declares them. */
  readonly references: readonly string[];
  /** The library ids the artifact's own decisions imply, canonically ordered. */
  readonly expected: readonly string[];
  /**
   * The ids that disagree, in the direction that says which is wrong.
   *
   * Carried as data as well as in diagnostics because a caller summarising a sync —
   * a PR comment, a CI line — wants to print it without parsing a message string.
   */
  readonly unbackedReferences: readonly string[];
  readonly missingReferences: readonly string[];
  readonly diagnostics: readonly SyncDiagnostic[];
}

/**
 * Compare an artifact's library references against its own decisions, and audit both
 * against the project's extension listing.
 *
 * The two comparisons are independent and both are reported: an artifact can carry the
 * right ids while the project has none of them installed, and it can carry ids the
 * project has while disagreeing with its decisions about which ones it needs.
 */
export function verifyExtensionReferences(
  options: VerifyExtensionReferencesOptions,
): ExtensionReferenceVerification {
  // #12's own plan, called rather than restated: it owns which modules an `extension`
  // decision compiles to, which rows the audit covers, and the listing verdict. The
  // alternatives — re-deriving the mappings from the decisions, or re-implementing the
  // listing checks — are what #9's and #14's reviews repeatedly turned back.
  const plan = planExtensionExternals({
    ...(options.mappings === undefined ? {} : { mappings: options.mappings }),
    decisions: options.decisions,
    ...(options.listings === undefined ? {} : { extensionLibraries: options.listings }),
  });

  const references = frontendLibraryIds(options.artifact.frontendLibraries);
  const expected = frontendLibraryIds(plan.libraries);

  const expectedSet = new Set(expected);
  const referenceSet = new Set(references);

  const unbackedReferences = references.filter(id => !expectedSet.has(id));
  const missingReferences = expected.filter(id => !referenceSet.has(id));

  const diagnostics: SyncDiagnostic[] = [];

  for (const libraryId of unbackedReferences) {
    diagnostics.push(
      createSyncDiagnostic("library-reference-mismatch", libraryId, {
        detail: `The artifact declares it, but no decision in this build selects library "${libraryId}", so the page would be told to load a library the code was not compiled against.`,
      }),
    );
  }

  for (const libraryId of missingReferences) {
    diagnostics.push(
      createSyncDiagnostic("library-reference-mismatch", libraryId, {
        detail: `The artifact's decisions put library "${libraryId}" on the page, but the artifact's references do not list it, so the generated code reads a global nothing is told to load.`,
      }),
    );
  }

  for (const diagnostic of plan.diagnostics) {
    diagnostics.push(syncDiagnosticFromExtensionAudit(diagnostic));
  }

  return {
    verification: plan.metadata,
    references,
    expected,
    unbackedReferences,
    missingReferences,
    diagnostics,
  };
}

export function findSyncDiagnosticByCode(
  diagnostics: readonly SyncDiagnostic[],
  code: SyncDiagnostic["code"],
): SyncDiagnostic | undefined {
  return diagnostics.find(diagnostic => diagnostic.code === code);
}

/** A report block for a CI log or a PR body. */
export function formatExtensionReferenceVerification(verification: ExtensionReferenceVerification): string {
  return [
    `Extension verification: ${verification.verification}${
      verification.verification === "unstated"
        ? " (no listing was supplied, so no identity was confirmed for this build)"
        : ""
    }`,
    `Artifact references: ${verification.references.join(", ") || "(none)"}`,
    `Decisions imply: ${verification.expected.join(", ") || "(none)"}`,
    verification.diagnostics.length === 0
      ? "No extension-verification diagnostics."
      : `${verification.diagnostics.length} extension-verification diagnostic(s).`,
  ].join("\n");
}
