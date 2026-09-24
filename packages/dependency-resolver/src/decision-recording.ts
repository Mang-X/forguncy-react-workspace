/**
 * Recording what a probe or an Agent observed, without erasing what a human
 * decided.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" — https://github.com/Mang-X/forguncy-react-workspace/issues/8
 * — plan item 6 of #24: "Provide an update API consumed by Agent/probe flow;
 * preserve human-reviewable reason/evidence metadata."
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * `upsertLockDecision` already replaces a record by (package, cell target), which
 * is the right primitive and not a usable API for a probe. A probe re-runs many
 * times against the same decision, and every one of those runs carries only a
 * measurement — so an API that replaced the whole record would, on each re-run,
 * delete the rationale that justified the strategy and the evidence links that
 * let a reviewer re-check it. That is the failure #8's "human-reviewable"
 * requirement is aimed at, and it is invisible in a diff, because the record's
 * keys all still exist.
 *
 * So the update is a *merge*, and the merge rule is stated once, per field class:
 *
 * - **The measurement wins.** `probe`, `resolvedVersion`, `target`, `probedWith`,
 *   `extension` and `rejectedCandidate` are taken from the update. Keeping a
 *   previous measurement when a new one arrives would report a state nobody
 *   observed, which is the exact opposite of what a probe is for.
 * - **The strategy's reason survives a re-probe.** `rationale` is kept when the
 *   update does not carry one, so re-probing an `extension` decision does not cost
 *   the paragraph #4 required for choosing `extension`.
 * - **A strategy change does not inherit the old reason.** When the update changes
 *   the strategy, the previous rationale is dropped rather than carried over: it
 *   justified a different decision, and leaving it in place would attach a written
 *   justification to a strategy nobody justified. If the new strategy needs one —
 *   `extension` and `replace` do — the update has to supply it, and the write
 *   fails loudly if it does not.
 * - **Evidence accumulates.** Links are unioned, not replaced, because a re-probe
 *   *adds* to the review trail. Removal is deliberately not expressible here: an
 *   update that could silently drop evidence would make the lock's history
 *   unfalsifiable in a review. A caller that genuinely means to remove a record
 *   removes the record.
 *
 * `rationale: ""` is not "no rationale" — it is supplied, and empty, which
 * validation rejects for every strategy. Omit the field to keep the recorded one.
 */

import type {
  DecisionEvidenceLink,
  DependencyDecision,
  ExtensionEvidence,
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockDecisionQuery,
  LockedDependencyDecision,
  LockProbeEvidence,
  RejectedCandidateEvidence,
  ToolchainIdentity,
} from "@forguncy-react-workspace/core";
import { compareEvidenceLinks } from "@forguncy-react-workspace/core";

import { findExactLockDecision, readFgcLock, upsertLockDecision, writeFgcLock } from "./lock-store.ts";

/**
 * One observation, expressed as a change to the lock.
 *
 * The decision itself is #4's `DependencyDecision` rather than a set of flat
 * fields, so this module re-states no strategy semantics: which strategies need a
 * global, which need a library id, which need a written reason are all answered
 * where they are already answered. The update adds only what a probe knows.
 */
export interface DependencyDecisionUpdate {
  /**
   * The decision this observation supports.
   *
   * Carries `packageName`, so the record's identity is not stated twice and
   * cannot disagree with itself.
   */
  readonly decision: DependencyDecision;
  /** The cell target the decision applies to; defaults to null, i.e. every target. */
  readonly cellTarget?: string | null;
  /** The measurement being recorded. */
  readonly probe: LockProbeEvidence;
  readonly resolvedVersion?: string | null;
  readonly target?: ForguncyTargetIdentity | null;
  readonly probedWith?: ToolchainIdentity | null;
  readonly extension?: ExtensionEvidence | null;
  readonly rejectedCandidate?: RejectedCandidateEvidence | null;
  /** Replaces the recorded rationale. Omit to keep the existing one. */
  readonly rationale?: string;
  /** Links to add. Merged with the record's existing links; never removes one. */
  readonly evidence?: readonly DecisionEvidenceLink[];
}

function evidenceKey(link: DecisionEvidenceLink): string {
  return `${link.kind}\u0000${link.reference}`;
}

function mergeEvidenceLinks(
  existing: LockedDependencyDecision | null,
  update: DependencyDecisionUpdate,
): readonly DecisionEvidenceLink[] {
  const byKey = new Map<string, DecisionEvidenceLink>();
  for (const link of [...(existing?.evidence ?? []), ...(update.evidence ?? [])]) {
    const key = evidenceKey(link);
    if (!byKey.has(key)) {
      byKey.set(key, link);
    }
  }
  // Sorted here so the returned record is already what the canonical serializer
  // will write; `compareEvidenceLinks` is `core`'s, so the two cannot disagree.
  return [...byKey.values()].sort(compareEvidenceLinks);
}

/**
 * Folds an observation into the record it belongs to.
 *
 * Pure, so a caller can inspect what an update would do before writing it — which
 * is what an Agent flow wants when it is about to replace a decision a human
 * reviewed.
 */
export function mergeDependencyDecisionUpdate(
  existing: LockedDependencyDecision | null,
  update: DependencyDecisionUpdate,
): LockedDependencyDecision {
  const strategyChanged = existing !== null && existing.strategy !== update.decision.strategy;
  const rationale = update.rationale ?? (strategyChanged ? null : (existing?.rationale ?? null));

  return {
    // #4's fields, including `packageName` and every strategy-specific one.
    ...update.decision,
    cellTarget: update.cellTarget ?? existing?.cellTarget ?? null,
    resolvedVersion: update.resolvedVersion ?? null,
    probe: update.probe,
    target: update.target ?? null,
    probedWith: update.probedWith ?? null,
    extension: update.extension ?? null,
    rejectedCandidate: update.rejectedCandidate ?? null,
    rationale,
    evidence: mergeEvidenceLinks(existing, update),
  };
}

export interface RecordedDependencyDecision {
  /** The record as written, after the merge. */
  readonly record: LockedDependencyDecision;
  /** The whole canonical lock, so a caller can chain further updates or report them. */
  readonly lock: FgcLockDocument;
  /** True when a decision for this (package, cell target) already existed. */
  readonly replaced: boolean;
}

function exactQuery(update: DependencyDecisionUpdate): LockDecisionQuery {
  return { packageName: update.decision.packageName, cellTarget: update.cellTarget ?? null };
}

/**
 * Records one observation, then writes the lock.
 *
 * The write is what validates: `writeFgcLock` refuses a document the read path
 * would refuse, so an update that leaves out the evidence a probe claims, or
 * changes the strategy to one that owes a rationale, fails here rather than
 * leaving a lock behind that nothing can load. Read-modify-write is therefore
 * deliberate — the alternative is a writer that never sees what it is changing,
 * and the merge rules above need exactly that context.
 *
 * Not safe against two processes recording at once. A single Agent flow is the
 * intended caller, and serialising writers is a deployment concern rather than a
 * lock-format one; recording a batch through {@link recordDependencyDecisions} is
 * the way to keep one flow to one read-modify-write.
 */
export async function recordDependencyDecision(
  projectRoot: string,
  update: DependencyDecisionUpdate,
): Promise<RecordedDependencyDecision> {
  const lock = await readFgcLock(projectRoot);
  const existing = findExactLockDecision(lock, exactQuery(update));
  const record = mergeDependencyDecisionUpdate(existing, update);
  const next = upsertLockDecision(lock, record);

  await writeFgcLock(projectRoot, next);

  return { record, lock: next, replaced: existing !== null };
}

export interface RecordedDependencyDecisions {
  readonly records: readonly LockedDependencyDecision[];
  readonly lock: FgcLockDocument;
}

/**
 * Records several observations as one lock write.
 *
 * Exists so a batch of probes does not read the lock once per package and write
 * it once per package — which is both slower and, if two packages are recorded
 * from stale snapshots of the same file, silently lossy.
 */
export async function recordDependencyDecisions(
  projectRoot: string,
  updates: readonly DependencyDecisionUpdate[],
): Promise<RecordedDependencyDecisions> {
  let lock = await readFgcLock(projectRoot);
  const records: LockedDependencyDecision[] = [];

  for (const update of updates) {
    const query = exactQuery(update);
    const existing = findExactLockDecision(lock, query);
    const record = mergeDependencyDecisionUpdate(existing, update);
    lock = upsertLockDecision(lock, record);
    records.push(record);
  }

  await writeFgcLock(projectRoot, lock);

  return { records, lock };
}
