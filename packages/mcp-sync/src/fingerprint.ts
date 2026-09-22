/**
 * The generated-artifact fingerprint, and the marker that carries it into the Cell.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19), governed by
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 *
 * #19 asks for two things that turn out to be one mechanism: "generated code should
 * include a recognizable generated marker/fingerprint if the target format allows
 * comments", and "before overwriting a target that does not match the last known
 * generated fingerprint, surface a conflict instead of destroying probable designer
 * edits".
 *
 * A comment is allowed — the artifact already opens with one, and comments are the
 * only thing in the target's acceptance envelope that #5's probe neither rejected
 * nor transformed (`Babel.transform` with `presets: ["react"]` keeps them). So the
 * fingerprint travels *inside* the code, and that is what makes the whole mechanism
 * work without a sidecar:
 *
 * - the designer holds the marker, so the repository never has to remember what it
 *   wrote previously. A local state file would be a second source of truth that goes
 *   stale the moment someone syncs from another machine — and #19's decision puts
 *   the repository on the source side, not in a cache of the designer's contents.
 * - the marker is **self-describing**: it carries a hash of the code it was written
 *   with, so "was this edited after generation?" is answerable from one read of the
 *   Cell, with nothing else available.
 *
 * ## The two hashes, and why there are two
 *
 * - `code` — a hash of the source **with every marker line removed**. This is the
 *   tamper check, and it is recomputable from the Cell alone. It is what makes
 *   "someone edited the generated code" distinguishable from "this is our previous
 *   output".
 * - `artifact` — a hash of #6's canonical serialization of the *whole* artifact,
 *   `code` plus `frontendLibraries`. This is the equality check, and it is what makes
 *   a second sync of the same artifact a no-op: the code can be byte-identical while
 *   the metadata is not, and writing the metadata is then the only reason to touch
 *   the Cell at all.
 *
 * Two hashes rather than one because the two questions have different inputs. A
 * single `artifact` hash cannot answer the tamper question (recomputing it needs the
 * metadata that was written alongside the code, which the code alone does not carry),
 * and a single `code` hash cannot answer the equality question (identical code with
 * different libraries would read as "already synced" and the references would never
 * be corrected).
 *
 * Hashing uses #6's own `serializeCompileCellResult` rather than a second
 * serialization, so "the same artifact" means what it means everywhere else in the
 * repository: canonical key order, canonical library order, byte-identical.
 *
 * ## What the marker deliberately does not carry
 *
 * No machine path, no timestamp, no tool version (#19 forbids the first in
 * persistent project state, and #6 already refuses a non-deterministic banner). It
 * carries no *target* identity either: the repository is the source of truth for
 * which Cell an artifact belongs to (#19's one-way decision), duplicate targets are
 * detected in configuration by #26, and a logical id in the marker would only restate
 * what the project config already owns.
 */

import { createHash } from "node:crypto";

import { CELL_ARTIFACT_BANNER, canonicalizeFrontendLibraries, serializeCompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

/** The marker format's version. Present so a future format change is detectable. */
export const SYNC_MARKER_VERSION = 1;

/**
 * The first characters of every marker line.
 *
 * A prefix rather than a regular expression in the public surface, because the two
 * callers need different strictness: {@link readSyncMarker} decides whether a line
 * is *meant* to be a marker by this prefix and then parses it strictly, so a
 * corrupted marker is reported as corruption rather than being read as ordinary
 * code.
 */
export const SYNC_MARKER_PREFIX = "/* fgc-sync ";

/** The closing text of a marker line. */
export const SYNC_MARKER_SUFFIX = " */";

export const SYNC_FINGERPRINT_ERROR_CODES = ["artifact-not-generated", "marker-not-parseable"] as const;

export type SyncFingerprintErrorCode = (typeof SYNC_FINGERPRINT_ERROR_CODES)[number];

export class SyncFingerprintError extends Error {
  readonly code: SyncFingerprintErrorCode;

  constructor(code: SyncFingerprintErrorCode, message: string) {
    super(message);
    this.name = "SyncFingerprintError";
    this.code = code;
  }
}

/** What a marker records. Field names are short because they live inside the Cell. */
export interface SyncMarker {
  readonly version: number;
  /** Hash of the artifact's canonical serialization. The equality check. */
  readonly artifact: string;
  /** Hash of the source with marker lines removed. The tamper check. */
  readonly code: string;
}

/**
 * What a read of a Cell's marker found.
 *
 * Four states, and the two middle ones are the reason this is not
 * `SyncMarker | undefined`. `absent` and `malformed` are different answers — the
 * first says nothing was generated here, the second says something was generated and
 * then damaged — and collapsing them into one "no usable marker" would let a
 * corrupted Cell be treated as an empty one. `duplicated` is separate again because
 * it is a *contradiction* rather than an absence: two markers cannot both describe
 * the code they sit in.
 */
export type SyncMarkerState =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly line: string; readonly reason: string }
  | { readonly kind: "duplicated"; readonly count: number }
  | { readonly kind: "present"; readonly marker: SyncMarker };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The body of a code string: the source with every marker line removed.
 *
 * Removes *all* matching lines rather than the first, so an artifact that was stamped
 * twice still fingerprints to the same value. Marker placement is therefore not
 * covered by either hash, deliberately: a marker is a comment, moving one does not
 * change what the Cell does, and reporting a moved comment as a probable designer
 * edit would make the conflict signal fire on something that is not a conflict.
 */
export function stripSyncMarker(code: string): string {
  return code
    .split("\n")
    .filter(line => !line.startsWith(SYNC_MARKER_PREFIX))
    .join("\n");
}

/**
 * Read the marker state of a code string.
 *
 * Parses strictly once a line has been recognised by {@link SYNC_MARKER_PREFIX}: the
 * payload has to be an object with the three expected fields of the expected types,
 * or the state is `malformed`. A marker is machine-written, so any deviation is
 * evidence about the Cell rather than a format to be tolerated.
 */
export function readSyncMarker(code: string): SyncMarkerState {
  const lines = code.split("\n").filter(line => line.startsWith(SYNC_MARKER_PREFIX));

  if (lines.length === 0) return { kind: "absent" };
  if (lines.length > 1) return { kind: "duplicated", count: lines.length };

  const line = lines[0] as string;
  if (!line.endsWith(SYNC_MARKER_SUFFIX)) {
    return { kind: "malformed", line, reason: `the line does not end with "${SYNC_MARKER_SUFFIX}"` };
  }

  const payload = line.slice(SYNC_MARKER_PREFIX.length, line.length - SYNC_MARKER_SUFFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "malformed",
      line,
      reason: `the payload is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed", line, reason: "the payload is not an object" };
  }

  const record = parsed as Record<string, unknown>;
  const version = record.v;
  const artifact = record.artifact;
  const codeHash = record.code;

  if (version !== SYNC_MARKER_VERSION) {
    return { kind: "malformed", line, reason: `the marker version is ${String(version)}, not ${SYNC_MARKER_VERSION}` };
  }
  if (typeof artifact !== "string" || !/^[0-9a-f]{64}$/.test(artifact)) {
    return { kind: "malformed", line, reason: "the artifact hash is missing or is not a sha-256 digest" };
  }
  if (typeof codeHash !== "string" || !/^[0-9a-f]{64}$/.test(codeHash)) {
    return { kind: "malformed", line, reason: "the code hash is missing or is not a sha-256 digest" };
  }

  return { kind: "present", marker: { version, artifact, code: codeHash } };
}

/**
 * The artifact's identity: the hash a marker's `artifact` field carries.
 *
 * Computed over the artifact with any marker stripped **and its references in #6's
 * canonical order**, so stamping an already-stamped artifact does not change its
 * fingerprint and neither does a reference order the artifact happened to carry. Without
 * the first, a second sync would compute a different fingerprint from the first and never
 * recognise its own previous output; without the second, reordering two library
 * references would look like a new artifact and every following sync would rewrite a Cell
 * whose content is identical — including the order, because the mutation is normalized
 * the same way (#19: "Extension reference order must be stable").
 */
export function fingerprintArtifact(artifact: CompileCellResult): string {
  const body: CompileCellResult = {
    code: stripSyncMarker(artifact.code),
    frontendLibraries: canonicalizeFrontendLibraries(artifact.frontendLibraries),
  };
  return sha256(serializeCompileCellResult(body));
}

/** The hash a marker's `code` field carries: the source, marker lines removed. */
export function fingerprintArtifactCode(code: string): string {
  return sha256(stripSyncMarker(code));
}

/** The marker line for an artifact, without writing it into anything. */
export function syncMarkerLine(artifact: CompileCellResult): string {
  const payload = JSON.stringify({
    v: SYNC_MARKER_VERSION,
    artifact: fingerprintArtifact(artifact),
    code: fingerprintArtifactCode(artifact.code),
  });
  return `${SYNC_MARKER_PREFIX}${payload}${SYNC_MARKER_SUFFIX}`;
}

/**
 * The artifact's code with its marker stamped in.
 *
 * The marker goes on the line **after** the artifact banner rather than above it:
 * `verifyCellArtifact` requires the banner to be the first line (#6), and a deploy
 * step that made its own output fail the compiler's own verification would be a
 * trap. Normalising first — strip then re-insert — is what makes `stamp` idempotent,
 * which is the property the idempotency acceptance criterion rests on.
 *
 * Refuses a code that does not open with the artifact banner. That is not a
 * formatting preference: a fingerprint claiming "the compiler produced this" on
 * something the compiler did not produce is worse than no fingerprint at all, and the
 * refusal is what keeps the marker's meaning true. Callers reach here only after
 * `planCellSync`'s own `artifact-not-generated` gate, so the throw is a programming
 * error in this package rather than a routine outcome.
 */
export function stampSyncMarker(artifact: CompileCellResult): string {
  const body = stripSyncMarker(artifact.code);
  if (!body.startsWith(CELL_ARTIFACT_BANNER)) {
    throw new SyncFingerprintError(
      "artifact-not-generated",
      "The artifact does not open with the compiler's banner, so it is not generated output and must not be stamped with a generated-artifact fingerprint.",
    );
  }

  const firstBreak = body.indexOf("\n");
  if (firstBreak === -1) {
    return `${body}\n${syncMarkerLine(artifact)}\n`;
  }

  return `${body.slice(0, firstBreak)}\n${syncMarkerLine(artifact)}${body.slice(firstBreak)}`;
}

/**
 * Whether a stamped code's own hashes agree with its content.
 *
 * The tamper check, as a function of the code alone: `undefined` means the marker is
 * present and consistent with the source it sits in; a string says which half
 * disagrees. Kept separate from `divergence.ts`'s classification because that
 * classification also has to consider the *expected* artifact, while this question
 * needs only the Cell.
 */
export function verifySyncMarkerSelfConsistency(code: string): string | undefined {
  const state = readSyncMarker(code);
  if (state.kind !== "present") return undefined;

  const actual = fingerprintArtifactCode(code);
  if (state.marker.code === actual) return undefined;
  return `the marker records code hash ${state.marker.code} but the source hashes to ${actual}`;
}
