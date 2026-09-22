/**
 * Where a sync writes: the target locator, and what is still open about it.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), governed by
 * #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/5).
 *
 * #19 splits this in two sentences, and the split is the design:
 *
 * - "Resolve target page + cell from project configuration" — resolution is **not**
 *   sync's job. The target arrives as an input, which is the strongest available form
 *   of #19's own safety rule, "sync targets must be explicit; do not scan-and-overwrite
 *   arbitrary React Cells": there is no code path here that could take a target from
 *   anywhere else.
 * - "Write/update ReactCellType using `page.setCells`" — the locator's *shape* is the
 *   platform's, and it was measured rather than chosen. #5's probe wrote every one of
 *   its cells through `api.page.setCells` with a `pageName` and a `cells[].cell`, so
 *   the two fields here are the two fields that call takes.
 *
 * The interface is the one #6's fifth acceptance criterion is asserted against —
 * "a generated artifact can be passed directly to the MCP sync layer without
 * additional semantic transformation" — because `SyncCellInput` is the minimal shape
 * that criterion needs: a target and an artifact, with nothing in between. It is
 * declared here rather than in the package entry point so the modules that consume it
 * do not have to import the barrel; the barrel re-exports it, so the original import
 * path keeps working.
 *
 * {@link SYNC_TARGET_LOCATOR} records what #5 established about the locator and what
 * it did not, because #26's acceptance criteria include "the target locator model is
 * updated to match evidence from #5/#19 before implementation is finalized" — that
 * question needs a place to live, and this is it.
 */

import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

/**
 * One ReactCellType Cell, located the way the designer API locates one.
 *
 * `pageName` and `cell` are the platform's field names, quoted rather than renamed:
 * these two strings are passed straight into `api.page.setCells`, and a local
 * spelling would have to be translated somewhere.
 */
export interface CellTarget {
  readonly pageName: string;
  readonly cell: string;
}

/**
 * The minimum a sync consumes: where to write, and what to write.
 *
 * Deliberately not widened. Every other input a *plan* needs — the decisions, the
 * observed target state, the extension listing, the overwrite policy — is optional
 * context that changes what the plan may do rather than what a sync is, and adding
 * one here would let the boundary mean something different per caller.
 */
export interface SyncCellInput {
  readonly target: CellTarget;
  readonly artifact: CompileCellResult;
}

/** A target as a single token, for a diagnostic subject or a log line. */
export function cellTargetLabel(target: CellTarget): string {
  return `${target.pageName}!${target.cell}`;
}

/**
 * What is established about the target locator, and what is still open.
 *
 * Recorded as data for the same reason `core` records its decisions as data: #26 asks
 * for the locator model to be updated against #5/#19's evidence before it is
 * finalised, and an open question that only exists in a comment cannot be found by
 * whoever finalises it.
 */
export const SYNC_TARGET_LOCATOR = {
  /** The fields, in the order the designer call takes them. */
  fields: ["pageName", "cell"] as const,
  /**
   * Which half is measured. #5 wrote cells through `api.page.setCells` on probe pages
   * it created and named, so both fields are the platform's own names for the position
   * it writes to.
   */
  established: "Both fields are the ones `api.page.setCells` accepts, and both were used by #5's probe.",
  /**
   * The open question, stated so it is not mistaken for a settled answer.
   *
   * A page name is user-visible and renamable, so it is not obviously stable identity
   * across a rename — while #26's own rules ask that renaming a source file not change
   * a Cell's logical identity. Whether the designer API exposes a page id that is
   * stable across renames was not probed, and choosing a name over an id is a decision
   * that belongs to #5's evidence or to a fresh probe, not to this package.
   */
  openQuestion:
    "Whether a stable page id exists that a rename does not change. Until it is probed, the locator uses the page name, and #26/#28 must resolve or accept that before the target model is finalised.",
} as const;
