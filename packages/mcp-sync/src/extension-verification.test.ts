import { describe, expect, it } from "vitest";

import type { ExtensionDependencyDecision, ExtensionLibraryListing } from "@forguncy-react-workspace/core";
import {
  CELL_ARTIFACT_BANNER,
  frontendLibraryReference,
} from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import { syncDiagnosticCodes } from "./diagnostics";
import {
  findSyncDiagnosticByCode,
  formatExtensionReferenceVerification,
  verifyExtensionReferences,
} from "./extension-verification";

/**
 * #19's step 2 asks sync to verify `libraryId`, existence, type definitions and the
 * expected `globalName` from the project before writing. Two of those are already #12's
 * `auditExtensionLibraryMetadata`, so what these tests hold is that this module *calls*
 * that audit rather than re-deriving it, and that it adds the one comparison no build-time
 * audit can make: an artifact's own references against its own decisions.
 *
 * The fixtures use two of the shipped mappings — `@tanstack/react-query`, the canonical
 * case #12 names — so a change to the table is a change these tests notice.
 */

const TANSTACK_DECISION: ExtensionDependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "tanstack-query",
  globalName: "TanStackQuery",
};

function listing(overrides: Partial<ExtensionLibraryListing> = {}): ExtensionLibraryListing {
  return {
    id: "tanstack-query",
    name: "TanStack Query",
    globalName: "TanStackQuery",
    exists: true,
    typeDefinitionAvailable: true,
    ...overrides,
  };
}

function artifact(libraryIds: readonly string[] = ["tanstack-query"]): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\nfunction App() { return null; }\n`,
    frontendLibraries: libraryIds.map(frontendLibraryReference),
  };
}

describe("verifying an artifact's extension references", () => {
  it("confirms a reference the project's listing and the artifact's decisions agree on", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [listing()],
    });

    expect(verification.verification).toBe("stated");
    expect(verification.references).toEqual(["tanstack-query"]);
    expect(verification.expected).toEqual(["tanstack-query"]);
    expect(verification.unbackedReferences).toEqual([]);
    expect(verification.missingReferences).toEqual([]);
    expect(verification.diagnostics).toEqual([]);
  });

  // The state a guessed library id would pass: no listing means the check has not happened,
  // which #19 requires *before* the write, so it must not read as a clean result.
  it("reports a missing listing as unstated rather than as clean", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
    });

    expect(verification.verification).toBe("unstated");
    expect(verification.diagnostics).toEqual([]);
  });

  it("treats an empty listing as a stated answer, not as an unstated one", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [],
    });

    // "The project has no extensions" is an answer; "nobody looked" is not. Collapsing the
    // two would let an empty listing pass as though it had been checked.
    expect(verification.verification).toBe("stated");
    expect(syncDiagnosticCodes(verification.diagnostics)).toContain("missing-extension");
  });
});

describe("comparing what the artifact declares with what its decisions imply", () => {
  it("reports a reference no decision backs", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(["tanstack-query", "lib-echarts"]),
      decisions: [TANSTACK_DECISION],
      listings: [listing(), { id: "lib-echarts", globalName: "ECharts" }],
    });

    expect(verification.unbackedReferences).toEqual(["lib-echarts"]);
    expect(verification.missingReferences).toEqual([]);
    const diagnostic = findSyncDiagnosticByCode(verification.diagnostics, "library-reference-mismatch");
    expect(diagnostic?.subject).toBe("lib-echarts");
    // The fix belongs to the artifact, not to the project: the metadata is derived, so a
    // hand-corrected Cell would be overwritten by the next sync.
    expect(diagnostic?.fixOwner).toBe("generated-output");
  });

  it("reports a library the decisions imply but the artifact does not declare", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact([]),
      decisions: [TANSTACK_DECISION],
      listings: [listing()],
    });

    expect(verification.references).toEqual([]);
    expect(verification.expected).toEqual(["tanstack-query"]);
    expect(verification.missingReferences).toEqual(["tanstack-query"]);
    expect(verification.unbackedReferences).toEqual([]);
    expect(findSyncDiagnosticByCode(verification.diagnostics, "library-reference-mismatch")?.subject).toBe(
      "tanstack-query",
    );
  });
});

describe("reporting what the project's listing says", () => {
  it("reports a library the project does not have as a missing extension, and delegates it", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [listing({ id: "some-other-library" })],
    });

    const diagnostic = findSyncDiagnosticByCode(verification.diagnostics, "missing-extension");
    expect(diagnostic?.subject).toBe("@tanstack/react-query");
    expect(diagnostic?.delegate?.repository).toBe("MangMax/forguncy-frontend-library");
  });

  it("reports a library the project has with the wrong global as an install problem, not a missing one", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [listing({ globalName: "SomethingElse" })],
    });

    // The id resolves, so delegating the creation of a new package would replace a fixable
    // install with a second package.
    expect(syncDiagnosticCodes(verification.diagnostics)).toEqual(["extension-identity-mismatch"]);
    expect(findSyncDiagnosticByCode(verification.diagnostics, "extension-identity-mismatch")?.delegate).toBeUndefined();
  });

  it("reports a library with no runtime bundle as an identity mismatch", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [listing({ exists: false })],
    });

    expect(syncDiagnosticCodes(verification.diagnostics)).toEqual(["extension-identity-mismatch"]);
  });

  it("reports a library with no type definitions as an identity mismatch", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(),
      decisions: [TANSTACK_DECISION],
      listings: [listing({ typeDefinitionAvailable: false })],
    });

    expect(syncDiagnosticCodes(verification.diagnostics)).toEqual(["extension-identity-mismatch"]);
  });
});

describe("reporting a verification", () => {
  it("says when no listing was supplied", () => {
    const unstated = verifyExtensionReferences({ artifact: artifact(), decisions: [TANSTACK_DECISION] });
    const text = formatExtensionReferenceVerification(unstated);

    expect(text).toContain("Extension verification: unstated");
    expect(text).toContain("no identity was confirmed for this build");
    expect(text).toContain("Artifact references: tanstack-query");
    expect(text).toContain("Decisions imply: tanstack-query");
  });

  it("says when there is nothing to list or report", () => {
    const verification = verifyExtensionReferences({ artifact: artifact([]), decisions: [], listings: [] });
    const text = formatExtensionReferenceVerification(verification);

    expect(text).toContain("Artifact references: (none)");
    expect(text).toContain("Decisions imply: (none)");
    expect(text).toContain("No extension-verification diagnostics.");
  });

  it("finds a diagnostic by code, and refuses to invent one", () => {
    const verification = verifyExtensionReferences({
      artifact: artifact(["lib-echarts"]),
      decisions: [],
      listings: [],
    });

    expect(findSyncDiagnosticByCode(verification.diagnostics, "library-reference-mismatch")).toBeDefined();
    expect(findSyncDiagnosticByCode(verification.diagnostics, "missing-extension")).toBeUndefined();
  });
});
