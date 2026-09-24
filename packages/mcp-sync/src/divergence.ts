/**
 * What the target Cell already holds, and what to do about it.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19).
 *
 * #19's Safety section is one sentence with a large consequence: "Before overwriting
 * a target that does not match the last known generated fingerprint, surface a
 * conflict instead of destroying probable designer edits." That sentence contains
 * three separable questions and this module keeps them separate, because answering
 * them together is how a conflict check becomes a rubber stamp:
 *
 * 1. **What is there?** {@link classifyCellDivergence} — a pure function of the
 *    target's observed state and the artifact about to be written. It reports one of
 *    eight states and never decides anything.
 * 2. **What may be done about it?** {@link resolveCellWriteAction} — a pure function
 *    of the state and the caller's policy. Separate because the classification is
 *    worth reporting even when the action is "write", and because a caller that
 *    overrides a conflict should still be able to say what it overrode.
 * 3. **Was that a deliberate override?** {@link cellDivergenceOverride} — so a forced
 *    write carries the conflict it overrode instead of erasing the record of it.
 *
 * ## Why "unread" is a refusal and not an empty Cell
 *
 * The state is a discriminated union rather than `string | undefined`, because
 * "nothing is there" and "we could not look" have opposite consequences: the first is
 * the normal case for a fresh Cell and the second is the case #19's safety rule exists
 * for. Collapsing them into an empty string would silently convert every unreadable
 * target into an overwrite. The three reasons are distinct for the same purpose — the
 * third is a transport problem, the first two are the sync's own limitation, and the
 * diagnostic's remediation differs. `occupied` is the third state and the same
 * argument taken one step further: #20 measured that the designer reports a Cell
 * holding a value or another cell type *without* a `code` property, and mapping that
 * onto an empty string would classify a designer's text cell as `vacant` and overwrite
 * it. The read that establishes these states is `api.page.getCells` (#20's evidence),
 * and the adapter maps the product's three spellings onto these three states.
 *
 * ## The asymmetric metadata comparison
 *
 * Sync *writes* `frontendLibraries` in #6's canonical order (#19: "Extension reference
 * order must be stable"), and compares what it reads as a set. That asymmetry is
 * deliberate: an order difference in the Cell is not a divergence — the page loads the
 * same libraries either way — and reporting one would fire the conflict signal on
 * something no one needs to decide about. A *membership* difference is a divergence.
 *
 * `identical` additionally requires the metadata to have been read at all. A marker
 * whose code hash matches proves the code is ours; it does not prove the library list
 * still is, because the designer's cell properties panel can change that list without
 * touching the code. So a verified skip is only claimed when both halves were checked —
 * otherwise the state is `previous-generation` and the write simply re-asserts both.
 */

import { frontendLibraryIds } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import type { FrontendLibraryReference } from "@forguncy-react-workspace/core";

import { fingerprintArtifact, fingerprintArtifactCode, readSyncMarker } from "./fingerprint.ts";

// ---------------------------------------------------------------------------
// The observed state
// ---------------------------------------------------------------------------

/**
 * Why a target's current source is not available.
 *
 * Three reasons, and they are not interchangeable: the first is this contract's own
 * limitation, the second is a caller that chose not to look, and the third is the
 * environment's.
 *
 * `no-established-read-capability` is retained although #20 established the read
 * (`api.page.getCells`), because the *state* still exists: a caller running the plan
 * without the port — a dry run, a review, a test that only assembles a payload —
 * genuinely has no read, and this is the honest name for why. It is separate from
 * `not-attempted`, which is a caller that had the capability and skipped the read.
 * Collapsing them would make the two look like the same failure.
 */
export const CELL_READ_UNAVAILABLE_REASONS = [
  "no-established-read-capability",
  "not-attempted",
  "read-failed",
] as const;

export type CellReadUnavailableReason = (typeof CELL_READ_UNAVAILABLE_REASONS)[number];

/**
 * What the target Cell currently holds, as far as the caller could see.
 *
 * Three states, and the middle one is why this is not a boolean: `blank` and
 * `occupied` are both "not our generated output", but they call for different
 * answers. #20 measured that the designer reports a Cell holding a plain value or a
 * different cell type *without* a `code` property, so a reader that mapped it onto
 * an empty string would classify a designer's text cell as `vacant` and overwrite
 * it — the exact silent destruction #19's safety rule forbids. `occupied` says what
 * the product reported instead of pretending the Cell was empty.
 *
 * `frontendLibraries` is optional on `read` because whether a read reports the
 * Cell's whole properties or only its source is not established either. Omitting it
 * is "not stated", never "empty": see the module docstring for why that distinction
 * decides whether a skip may be claimed.
 */
export type DeployedCellState =
  | {
      readonly kind: "read";
      readonly code: string;
      readonly frontendLibraries?: readonly FrontendLibraryReference[];
    }
  /**
   * The Cell holds something that is not a managed ReactCellType.
   *
   * `detail` names what the product reported — a value, another cell type — so the
   * conflict message is actionable rather than a generic "not ours".
   */
  | { readonly kind: "occupied"; readonly detail: string }
  | { readonly kind: "unread"; readonly reason: CellReadUnavailableReason };

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

/**
 * The states a target can be in, each one a different answer to "what is there".
 *
 * `foreign-code` and `edited-after-generation` are the two #19 names ("probable
 * designer edits"); the rest exist because the *reason* a target does not match
 * changes what a person should do about it. A malformed or duplicated marker is not a
 * designer edit — it is damage — and telling the two apart is what keeps the conflict
 * message actionable.
 */
export const CELL_DIVERGENCE_KINDS = [
  "vacant",
  "identical",
  "previous-generation",
  "edited-after-generation",
  "malformed-marker",
  "duplicated-marker",
  "foreign-code",
  "unverifiable",
] as const;

export type CellDivergenceKind = (typeof CELL_DIVERGENCE_KINDS)[number];

/**
 * Whether the metadata half could be compared.
 *
 * `not-applicable` is not a failure: with no marker to trust and no generated code in
 * the Cell, there is no metadata question to answer.
 */
export type CellMetadataComparison = "compared" | "unstated" | "not-applicable";

export interface CellDivergence {
  readonly kind: CellDivergenceKind;
  /** One sentence naming what was found, for a report or a review comment. */
  readonly detail: string;
  readonly metadataComparison: CellMetadataComparison;
  /**
   * The fingerprint the Cell's marker recorded, when one was readable.
   *
   * Carried because it is the value an Agent needs to answer "which artifact is in
   * there", and recomputing it downstream would mean re-reading the Cell.
   */
  readonly deployedFingerprint?: string;
}

function sameLibrarySet(
  left: readonly FrontendLibraryReference[],
  right: readonly FrontendLibraryReference[],
): boolean {
  const a = [...frontendLibraryIds(left)].sort();
  const b = [...frontendLibraryIds(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function describeUnreadReason(reason: CellReadUnavailableReason): string {
  switch (reason) {
    case "no-established-read-capability":
      return "no read of the target was performed, so nothing about its current state is known";
    case "not-attempted":
      return "the target was not read before this plan was made";
    case "read-failed":
      return "the read of the target failed";
  }
}

/**
 * Classify what the target holds against the artifact about to be written.
 *
 * The tamper check runs before the equality check, and that order is the whole
 * difference between the two kinds it separates: a Cell whose marker still claims a
 * code hash its source no longer has was generated and then edited, while a Cell whose
 * marker is internally consistent is simply an earlier generation of ours. Checking
 * equality first would report an edited Cell as "stale, overwrite it" whenever the
 * edit happened to leave the artifact hash matching, which is precisely the case the
 * check exists to catch.
 */
export function classifyCellDivergence(state: DeployedCellState, artifact: CompileCellResult): CellDivergence {
  if (state.kind === "unread") {
    return {
      kind: "unverifiable",
      detail: `The target's current source is unknown: ${describeUnreadReason(state.reason)}.`,
      metadataComparison: "not-applicable",
    };
  }

  if (state.kind === "occupied") {
    // Not `vacant`, and the distinction is the whole point: the product reported a cell
    // that holds something — a value, another cell type — which is designer work or a
    // cell this flow never wrote. Reporting it as empty would let a sync overwrite it.
    return {
      kind: "foreign-code",
      detail: `The target Cell holds something this flow did not write and that is not a managed React Cell (${state.detail}), so overwriting it would destroy work the repository cannot reproduce.`,
      metadataComparison: "not-applicable",
    };
  }

  const code = state.code;
  if (code.trim().length === 0) {
    return {
      kind: "vacant",
      detail: "The target Cell holds no source, so there is nothing to preserve.",
      metadataComparison: "not-applicable",
    };
  }

  const markerState = readSyncMarker(code);
  if (markerState.kind === "absent") {
    return {
      kind: "foreign-code",
      detail:
        "The target Cell holds source that carries no sync marker, so it was not written by this flow — it is designer-authored or came from somewhere this repository does not know.",
      metadataComparison: "not-applicable",
    };
  }
  if (markerState.kind === "malformed") {
    return {
      kind: "malformed-marker",
      detail: `The target Cell carries a sync marker that cannot be read (${markerState.reason}), so its provenance cannot be established.`,
      metadataComparison: "not-applicable",
    };
  }
  if (markerState.kind === "duplicated") {
    return {
      kind: "duplicated-marker",
      detail: `The target Cell carries ${markerState.count} sync markers, which cannot all describe the same source.`,
      metadataComparison: "not-applicable",
    };
  }

  const marker = markerState.marker;
  const deployedFingerprint = marker.artifact;
  const actualCodeHash = fingerprintArtifactCode(code);

  if (marker.code !== actualCodeHash) {
    return {
      kind: "edited-after-generation",
      detail:
        "The target Cell carries a valid marker whose recorded source hash no longer matches its source, so the generated code was edited after it was written.",
      metadataComparison: "not-applicable",
      deployedFingerprint,
    };
  }

  const metadataStated = state.frontendLibraries !== undefined;
  const metadataComparison: CellMetadataComparison = metadataStated ? "compared" : "unstated";
  const metadataMatches = metadataStated && sameLibrarySet(state.frontendLibraries ?? [], artifact.frontendLibraries);

  if (deployedFingerprint === fingerprintArtifact(artifact) && metadataMatches) {
    return {
      kind: "identical",
      detail: "The target Cell already holds this artifact, source and library references both.",
      metadataComparison,
      deployedFingerprint,
    };
  }

  return {
    kind: "previous-generation",
    detail:
      deployedFingerprint === fingerprintArtifact(artifact)
        ? "The target Cell holds this artifact's source, but its library references could not be confirmed as the same, so the write re-asserts both."
        : "The target Cell holds generated output from an earlier artifact, which this sync replaces.",
    metadataComparison,
    deployedFingerprint,
  };
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * What a caller may do with a diverged target.
 *
 * `preserve-designer-edits` is the default and the only policy #19 sanctions as
 * automatic: a conflict stops the sync. `force` exists because the alternative is
 * worse — a Cell the designer created with a placeholder template would be permanently
 * unsyncable, and the practical response to that is a person deleting the Cell rather
 * than a rule being relaxed. So the override is explicit, available, and *recorded*:
 * {@link cellDivergenceOverride} makes a forced write carry the conflict it overrode,
 * which is what keeps "force" from being a way to make the check invisible.
 */
export const CELL_OVERWRITE_POLICIES = ["preserve-designer-edits", "force"] as const;

export type CellOverwritePolicy = (typeof CELL_OVERWRITE_POLICIES)[number];

export const DEFAULT_CELL_OVERWRITE_POLICY: CellOverwritePolicy = "preserve-designer-edits";

export type CellWriteAction = "write" | "skip" | "conflict";

/**
 * What each state calls for, absent an override.
 *
 * A total `Record` rather than a switch, so a new state cannot be added without
 * deciding what it means — the failure mode of a `default:` branch here is a state
 * that quietly writes over something.
 */
export const CELL_DIVERGENCE_ACTIONS: Readonly<Record<CellDivergenceKind, CellWriteAction>> = {
  vacant: "write",
  identical: "skip",
  "previous-generation": "write",
  "edited-after-generation": "conflict",
  "malformed-marker": "conflict",
  "duplicated-marker": "conflict",
  "foreign-code": "conflict",
  unverifiable: "conflict",
};

export function resolveCellWriteAction(
  divergence: CellDivergence,
  policy: CellOverwritePolicy = DEFAULT_CELL_OVERWRITE_POLICY,
): CellWriteAction {
  const action = CELL_DIVERGENCE_ACTIONS[divergence.kind];
  return policy === "force" && action === "conflict" ? "write" : action;
}

/**
 * The conflict a policy overrode, or `undefined` when nothing was overridden.
 *
 * Returned rather than logged, so the plan can carry it: a forced sync's report has to
 * say what it overwrote, and a value that only reaches a log file is a value nobody
 * reads before the next sync.
 */
export function cellDivergenceOverride(
  divergence: CellDivergence,
  policy: CellOverwritePolicy = DEFAULT_CELL_OVERWRITE_POLICY,
): CellDivergence | undefined {
  if (policy !== "force") return undefined;
  return CELL_DIVERGENCE_ACTIONS[divergence.kind] === "conflict" ? divergence : undefined;
}

/** A report block for a CI log or a PR body. */
export function formatCellDivergence(divergence: CellDivergence): string {
  const fingerprint =
    divergence.deployedFingerprint === undefined ? "no readable fingerprint" : divergence.deployedFingerprint;
  return `Target state: ${divergence.kind} (${fingerprint}; metadata ${divergence.metadataComparison}). ${divergence.detail}`;
}
