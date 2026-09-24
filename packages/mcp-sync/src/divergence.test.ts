import { describe, expect, it } from "vitest";

import {
  CELL_ARTIFACT_BANNER,
  frontendLibraryReference,
} from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import {
  CELL_DIVERGENCE_ACTIONS,
  CELL_DIVERGENCE_KINDS,
  CELL_OVERWRITE_POLICIES,
  CELL_READ_UNAVAILABLE_REASONS,
  cellDivergenceOverride,
  classifyCellDivergence,
  DEFAULT_CELL_OVERWRITE_POLICY,
  formatCellDivergence,
  resolveCellWriteAction,
} from "./divergence.ts";
import type { CellDivergenceKind, DeployedCellState } from "./divergence.ts";
import { fingerprintArtifact, stampSyncMarker } from "./fingerprint.ts";

/**
 * #19's safety rule is one sentence — "Before overwriting a target that does not match
 * the last known generated fingerprint, surface a conflict instead of destroying
 * probable designer edits" — and these tests hold the three separable questions it
 * contains apart: what is there, what may be done about it, and whether the answer was
 * an explicit override.
 */

const CODE_BODY = "function App() { return null; }\n";

function generated(code = CODE_BODY, libraryIds: readonly string[] = []): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\n${code}`,
    frontendLibraries: libraryIds.map(frontendLibraryReference),
  };
}

function stampedReadOf(artifact: CompileCellResult, libraries = artifact.frontendLibraries): DeployedCellState {
  return { kind: "read", code: stampSyncMarker(artifact), frontendLibraries: libraries };
}

describe("classifying what the target holds", () => {
  it("reports an unread target as unverifiable, with three distinct reasons", () => {
    const artifact = generated();
    const details = CELL_READ_UNAVAILABLE_REASONS.map(reason => {
      const divergence = classifyCellDivergence({ kind: "unread", reason }, artifact);
      expect(divergence.kind).toBe("unverifiable");
      expect(divergence.metadataComparison).toBe("not-applicable");
      expect(divergence.deployedFingerprint).toBeUndefined();
      return divergence.detail;
    });

    // "we could not look" and "nothing is there" have opposite consequences, so the three
    // ways of not looking must not collapse into one message.
    expect(new Set(details).size).toBe(CELL_READ_UNAVAILABLE_REASONS.length);
  });

  it("reports an empty target as vacant", () => {
    expect(classifyCellDivergence({ kind: "read", code: "" }, generated()).kind).toBe("vacant");
    expect(classifyCellDivergence({ kind: "read", code: "  \n" }, generated()).kind).toBe("vacant");
  });

  it("reports source with no marker as foreign code", () => {
    const divergence = classifyCellDivergence({ kind: "read", code: CODE_BODY }, generated());

    expect(divergence.kind).toBe("foreign-code");
    expect(divergence.metadataComparison).toBe("not-applicable");
  });

  it("reports a marker it cannot parse as damage rather than as a designer edit", () => {
    const damaged = `/* fgc-sync {"v":9} */\n${CODE_BODY}`;
    expect(classifyCellDivergence({ kind: "read", code: damaged }, generated()).kind).toBe("malformed-marker");
  });

  it("reports two markers as damage", () => {
    const artifact = generated();
    const stamped = stampSyncMarker(artifact);
    const marker = stamped.split("\n").find(line => line.startsWith("/* fgc-sync ")) as string;
    const doubled = `${stamped}${marker}\n`;

    expect(classifyCellDivergence({ kind: "read", code: doubled }, artifact).kind).toBe("duplicated-marker");
  });
});

describe("telling its own output from someone else's edit", () => {
  it("reports this artifact, source and references both, as identical", () => {
    const artifact = generated(CODE_BODY, ["lib-a"]);
    const divergence = classifyCellDivergence(stampedReadOf(artifact), artifact);

    expect(divergence.kind).toBe("identical");
    expect(divergence.metadataComparison).toBe("compared");
    expect(divergence.deployedFingerprint).toBe(fingerprintArtifact(artifact));
  });

  it("reports the same source with unconfirmed references as a previous generation", () => {
    const artifact = generated(CODE_BODY, ["lib-a"]);
    const divergence = classifyCellDivergence(
      { kind: "read", code: stampSyncMarker(artifact) },
      artifact,
    );

    // A marker proves the *code* is ours. The designer's cell properties panel can change
    // the library list without touching the code, so a skip may not be claimed on half the
    // evidence.
    expect(divergence.kind).toBe("previous-generation");
    expect(divergence.metadataComparison).toBe("unstated");
  });

  it("reports the same source with different references as a previous generation", () => {
    const artifact = generated(CODE_BODY, ["lib-a"]);
    const divergence = classifyCellDivergence(stampedReadOf(artifact, [frontendLibraryReference("lib-b")]), artifact);

    expect(divergence.kind).toBe("previous-generation");
    expect(divergence.metadataComparison).toBe("compared");
  });

  it("treats a reference order difference as no difference at all", () => {
    const artifact = generated(CODE_BODY, ["lib-a", "lib-b"]);
    const reordered = stampedReadOf(artifact, [frontendLibraryReference("lib-b"), frontendLibraryReference("lib-a")]);

    // The page loads the same libraries either way, so firing the conflict signal on an
    // order difference would be asking a person to decide about nothing.
    expect(classifyCellDivergence(reordered, artifact).kind).toBe("identical");
  });

  it("reports an earlier generation of ours as a previous generation", () => {
    const deployed = generated(CODE_BODY, ["lib-a"]);
    const next = generated("function App() { return 1; }\n", ["lib-a"]);
    const divergence = classifyCellDivergence(stampedReadOf(deployed), next);

    expect(divergence.kind).toBe("previous-generation");
    expect(divergence.deployedFingerprint).toBe(fingerprintArtifact(deployed));
  });

  it("checks the code hash before the artifact hash", () => {
    const artifact = generated(CODE_BODY, ["lib-a"]);
    const edited = stampSyncMarker(artifact).replace(CODE_BODY, "function App() { return 1; }\n");
    const divergence = classifyCellDivergence(
      { kind: "read", code: edited, frontendLibraries: artifact.frontendLibraries },
      artifact,
    );

    // The marker's `artifact` hash still matches this artifact, so an equality check that
    // ran first would report an edited Cell as "already synced" — exactly the case the
    // divergence check exists to catch.
    expect(divergence.deployedFingerprint).toBe(fingerprintArtifact(artifact));
    expect(divergence.kind).toBe("edited-after-generation");
  });
});

describe("what may be done about it", () => {
  it("answers for every state, with no state left to a default", () => {
    expect(Object.keys(CELL_DIVERGENCE_ACTIONS).sort()).toEqual([...CELL_DIVERGENCE_KINDS].sort());
    expect(CELL_DIVERGENCE_ACTIONS.vacant).toBe("write");
    expect(CELL_DIVERGENCE_ACTIONS.identical).toBe("skip");
    expect(CELL_DIVERGENCE_ACTIONS["previous-generation"]).toBe("write");
    for (const kind of ["edited-after-generation", "malformed-marker", "duplicated-marker", "foreign-code", "unverifiable"] as const) {
      expect(CELL_DIVERGENCE_ACTIONS[kind], kind).toBe("conflict");
    }
  });

  it("defaults to preserving designer edits", () => {
    expect(DEFAULT_CELL_OVERWRITE_POLICY).toBe("preserve-designer-edits");
    expect([...CELL_OVERWRITE_POLICIES]).toEqual(["preserve-designer-edits", "force"]);
  });

  it("turns a conflict into a write only under an explicit force", () => {
    const artifact = generated();
    const foreign = classifyCellDivergence({ kind: "read", code: CODE_BODY }, artifact);

    expect(resolveCellWriteAction(foreign)).toBe("conflict");
    expect(resolveCellWriteAction(foreign, "preserve-designer-edits")).toBe("conflict");
    expect(resolveCellWriteAction(foreign, "force")).toBe("write");
  });

  it("does not turn a skip into a write, however it is forced", () => {
    const artifact = generated();
    const identical = classifyCellDivergence(stampedReadOf(artifact), artifact);

    // `force` overrides a *conflict*, not a decision: re-writing an identical target is
    // exactly the change idempotency promises not to make.
    expect(resolveCellWriteAction(identical, "force")).toBe("skip");
  });

  it("carries the conflict an override overrode, and nothing else", () => {
    const artifact = generated();
    const foreign = classifyCellDivergence({ kind: "read", code: CODE_BODY }, artifact);
    const vacant = classifyCellDivergence({ kind: "read", code: "" }, artifact);

    expect(cellDivergenceOverride(foreign)).toBeUndefined();
    expect(cellDivergenceOverride(foreign, "preserve-designer-edits")).toBeUndefined();
    expect(cellDivergenceOverride(foreign, "force")).toBe(foreign);
    expect(cellDivergenceOverride(vacant, "force")).toBeUndefined();
  });

  it("names the fingerprint it found when it reports one", () => {
    const artifact = generated();
    const divergence = classifyCellDivergence(stampedReadOf(artifact), artifact);

    expect(formatCellDivergence(divergence)).toContain(divergence.kind);
    expect(formatCellDivergence(divergence)).toContain(divergence.deployedFingerprint as string);
    expect(formatCellDivergence(classifyCellDivergence({ kind: "read", code: "" }, artifact))).toContain(
      "no readable fingerprint",
    );
  });
});

// The import above is a type-only re-export check: `DeployedCellState` is the reason this
// module can say "unread" at all, and it is the caller-supplied state #19's safety rule is
// about. Asserted here so the package's public name for it cannot drift.
describe("the state a caller supplies", () => {
  it("distinguishes a read Cell from one that was not read", () => {
    const states: readonly DeployedCellState[] = [
      { kind: "read", code: "" },
      { kind: "unread", reason: "no-established-read-capability" },
    ];

    expect(states.map(state => state.kind)).toEqual(["read", "unread"]);
  });
});

// Kept as a list so a ninth state cannot be added without the table above being revisited.
describe("the state vocabulary", () => {
  it("has exactly the eight states the classification reports", () => {
    const kinds: readonly CellDivergenceKind[] = CELL_DIVERGENCE_KINDS;
    expect(kinds).toHaveLength(8);
  });
});
