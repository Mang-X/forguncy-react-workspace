import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, verifyCellArtifact } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import {
  fingerprintArtifact,
  fingerprintArtifactCode,
  readSyncMarker,
  stampSyncMarker,
  stripSyncMarker,
  SYNC_MARKER_PREFIX,
  SYNC_MARKER_SUFFIX,
  SYNC_MARKER_VERSION,
  SyncFingerprintError,
  syncMarkerLine,
  verifySyncMarkerSelfConsistency,
} from "./fingerprint";

/**
 * Issue #19 asks for two things that are one mechanism: a "recognizable generated
 * marker/fingerprint", and "before overwriting a target that does not match the last
 * known generated fingerprint, surface a conflict". These tests hold the mechanism to
 * both — the marker has to survive the compiler's own verification (or the deploy step
 * would invalidate its own output), and the two hashes have to answer the two different
 * questions the Safety section needs.
 */

const CODE_BODY = "function App() { return null; }\n";

function generated(overrides: Partial<CompileCellResult> = {}): CompileCellResult {
  return { code: `${CELL_ARTIFACT_BANNER}\n${CODE_BODY}`, frontendLibraries: [], ...overrides };
}

function markerLineOf(code: string): string {
  const line = code.split("\n").find(candidate => candidate.startsWith(SYNC_MARKER_PREFIX));
  if (line === undefined) throw new Error("The code carries no marker line.");
  return line;
}

function payloadOf(code: string): unknown {
  const line = markerLineOf(code);
  return JSON.parse(line.slice(SYNC_MARKER_PREFIX.length, line.length - SYNC_MARKER_SUFFIX.length));
}

/** Runs `run` and returns the typed refusal, failing the test if it did not refuse. */
function expectFingerprintRefusal(run: () => unknown): SyncFingerprintError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncFingerprintError);
    return error as SyncFingerprintError;
  }
  throw new Error("Expected a SyncFingerprintError, but the call returned normally.");
}

describe("the generated-artifact marker", () => {
  it("stamps below the banner, so the compiler still accepts its own output", () => {
    const artifact = generated();
    const stamped = stampSyncMarker(artifact);
    const lines = stamped.split("\n");

    expect(lines[0]).toBe(CELL_ARTIFACT_BANNER);
    expect(lines[1]?.startsWith(SYNC_MARKER_PREFIX)).toBe(true);
    // The trap this asserts against: `verifyCellArtifact` requires the banner first, so a
    // marker placed above it would make a sync's own output fail the compiler's check.
    expect(verifyCellArtifact({ ...artifact, code: stamped })).toEqual([]);
  });

  it("is idempotent: stamping a stamped artifact is byte-identical", () => {
    const artifact = generated();
    const once = stampSyncMarker(artifact);
    const twice = stampSyncMarker({ ...artifact, code: once });

    expect(twice).toBe(once);
    expect(once.split("\n").filter(line => line.startsWith(SYNC_MARKER_PREFIX))).toHaveLength(1);
  });

  it("reads its own marker back with both hashes", () => {
    const artifact = generated({ frontendLibraries: [{ libraryId: "lib-a" }] });
    const state = readSyncMarker(stampSyncMarker(artifact));

    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.marker.version).toBe(SYNC_MARKER_VERSION);
    expect(state.marker.artifact).toBe(fingerprintArtifact(artifact));
    expect(state.marker.code).toBe(fingerprintArtifactCode(artifact.code));
  });

  it("carries the three declared fields and nothing about the machine", () => {
    const stamped = stampSyncMarker(generated());

    expect(Object.keys(payloadOf(stamped) as Record<string, unknown>).sort()).toEqual(["artifact", "code", "v"]);
    // #19 forbids a machine path in persistent project state, and #6 already refuses a
    // non-deterministic banner, so a marker that moved a build artifact across two
    // machines identically is the property here.
    expect(markerLineOf(stamped)).not.toMatch(/\b[A-Za-z]:[\\/]/);
    expect(payloadOf(stamped)).not.toHaveProperty("timestamp");
    expect(payloadOf(stamped)).not.toHaveProperty("tool");
  });

  it("is deterministic", () => {
    const artifact = generated();
    expect(syncMarkerLine(artifact)).toBe(syncMarkerLine(artifact));
    expect((payloadOf(syncMarkerLine(artifact)) as { v: number }).v).toBe(SYNC_MARKER_VERSION);
  });
});

describe("why there are two hashes", () => {
  it("separates 'the same artifact' from 'the same source'", () => {
    const withA = generated({ frontendLibraries: [{ libraryId: "lib-a" }] });
    const withB = generated({ frontendLibraries: [{ libraryId: "lib-b" }] });

    // The equality check has to see the difference, or a second sync would read identical
    // code as "already synced" and the library references would never be corrected.
    expect(fingerprintArtifact(withA)).not.toBe(fingerprintArtifact(withB));
    // The tamper check has to *not* see it, or changing a reference would look like an
    // edit to the code and fire the conflict signal.
    expect(fingerprintArtifactCode(withA.code)).toBe(fingerprintArtifactCode(withB.code));
  });

  it("ignores the order two library references were written in", () => {
    const ascending = generated({ frontendLibraries: [{ libraryId: "a" }, { libraryId: "b" }] });
    const descending = generated({ frontendLibraries: [{ libraryId: "b" }, { libraryId: "a" }] });

    expect(fingerprintArtifact(ascending)).toBe(fingerprintArtifact(descending));
  });

  it("ignores where the marker sits, because a moved comment changes no behaviour", () => {
    const artifact = generated();
    const stamped = stampSyncMarker(artifact);
    const marker = markerLineOf(stamped);
    const movedToEnd = `${stripSyncMarker(stamped)}${marker}\n`;

    expect(readSyncMarker(movedToEnd).kind).toBe("present");
    expect(fingerprintArtifactCode(movedToEnd)).toBe(fingerprintArtifactCode(stamped));
    expect(fingerprintArtifact({ ...artifact, code: movedToEnd })).toBe(fingerprintArtifact(artifact));
  });
});

describe("reading a marker off a Cell", () => {
  it("reports no marker as absent", () => {
    expect(readSyncMarker(CODE_BODY).kind).toBe("absent");
  });

  it("reports damage as malformed rather than as ordinary code", () => {
    const cases: readonly string[] = [
      `${SYNC_MARKER_PREFIX}{"v":1,"artifact":"aa","code":"bb"}`, // no suffix
      `${SYNC_MARKER_PREFIX}not json${SYNC_MARKER_SUFFIX}`,
      `${SYNC_MARKER_PREFIX}["v",1]${SYNC_MARKER_SUFFIX}`, // not an object
      `${SYNC_MARKER_PREFIX}{"v":2,"artifact":"${"a".repeat(64)}","code":"${"b".repeat(64)}"}${SYNC_MARKER_SUFFIX}`,
      `${SYNC_MARKER_PREFIX}{"v":1,"artifact":"not-hex","code":"${"b".repeat(64)}"}${SYNC_MARKER_SUFFIX}`,
      `${SYNC_MARKER_PREFIX}{"v":1,"artifact":"${"a".repeat(64)}"}${SYNC_MARKER_SUFFIX}`,
    ];

    for (const line of cases) {
      const state = readSyncMarker(line);
      expect(state.kind, line).toBe("malformed");
      if (state.kind !== "malformed") continue;
      expect(state.line).toBe(line);
      expect(state.reason.length).toBeGreaterThan(0);
    }
  });

  it("reports two markers as a contradiction, not as an absence", () => {
    const stamped = stampSyncMarker(generated());
    const state = readSyncMarker(`${stamped}${markerLineOf(stamped)}\n`);

    expect(state.kind).toBe("duplicated");
    if (state.kind !== "duplicated") return;
    expect(state.count).toBe(2);
  });

  it("strips every marker line, so a doubled marker still fingerprints once", () => {
    const artifact = generated();
    const stamped = stampSyncMarker(artifact);
    const doubled = `${stamped}${markerLineOf(stamped)}\n`;

    expect(stripSyncMarker(stamped)).toBe(artifact.code);
    expect(stripSyncMarker(doubled)).toBe(stripSyncMarker(stamped));
  });

  it("calls out the half that disagrees when the code was edited after generation", () => {
    const stamped = stampSyncMarker(generated());

    expect(verifySyncMarkerSelfConsistency(stamped)).toBeUndefined();
    const edited = stamped.replace(CODE_BODY, "function App() { return 1; }\n");
    expect(verifySyncMarkerSelfConsistency(edited)).toMatch(/code hash/);
  });

  // Absence is the caller's question, asked with `readSyncMarker`: this function answers
  // "do the hashes agree", and a Cell with no hashes has nothing to disagree with.
  it("says nothing about a code that carries no marker", () => {
    expect(verifySyncMarkerSelfConsistency(CODE_BODY)).toBeUndefined();
  });
});

describe("refusing to stamp what the compiler did not produce", () => {
  it("refuses code with no artifact banner", () => {
    const plain: CompileCellResult = { code: CODE_BODY, frontendLibraries: [] };
    const refusal = expectFingerprintRefusal(() => stampSyncMarker(plain));

    expect(refusal.code).toBe("artifact-not-generated");
    expect(refusal.name).toBe("SyncFingerprintError");
  });

  it("refuses code whose banner was removed from an otherwise stamped artifact", () => {
    // Stripping is what makes the check about the compiler's banner rather than about a
    // marker that happens to be present: a marker is not evidence of generation.
    const stamped = stampSyncMarker(generated());
    const deBannered = stamped.replace(`${CELL_ARTIFACT_BANNER}\n`, "");

    expect(readSyncMarker(deBannered).kind).toBe("present");
    expectFingerprintRefusal(() => stampSyncMarker({ code: deBannered, frontendLibraries: [] }));
  });
});
