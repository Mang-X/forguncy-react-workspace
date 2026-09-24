import { describe, expect, it } from "vitest";

import {
  CELL_ARTIFACT_GUARANTEE_IDS,
  CELL_ARTIFACT_GUARANTEES,
  findCellArtifactGuarantee,
  locallyCheckableCellArtifactGuarantees,
  realRuntimeCellArtifactGuarantees,
} from "./guarantees.ts";

describe("cell artifact guarantees", () => {
  // #6 fixes these seven promises. Pinned in order so that adding, removing or
  // reworking one is a deliberate edit against the Spec rather than an
  // incidental tidy-up of a list.
  it("records exactly the seven promises Issue #6 fixes", () => {
    expect([...CELL_ARTIFACT_GUARANTEE_IDS]).toEqual([
      "accepted-by-react-cell-type",
      "no-unresolved-source-imports",
      "inline-dependencies-flattened",
      "host-dependencies-reference-host-identity",
      "extension-dependencies-reference-extension",
      "workspace-packages-inline-like-source",
      "deterministic-artifact",
    ]);
    expect(CELL_ARTIFACT_GUARANTEES.map(guarantee => guarantee.id)).toEqual([...CELL_ARTIFACT_GUARANTEE_IDS]);
  });

  it("gives every guarantee a statement and a way to check it", () => {
    for (const id of CELL_ARTIFACT_GUARANTEE_IDS) {
      const guarantee = findCellArtifactGuarantee(id);
      expect(guarantee.id, id).toBe(id);
      expect(guarantee.statement.trim().length, id).toBeGreaterThan(20);
      // A promise with no executable check is a comment with extra steps.
      expect(guarantee.howToCheck.trim().length, id).toBeGreaterThan(20);
    }
  });

  it("rejects an unknown guarantee id instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellArtifactGuarantee("not-a-guarantee")).toThrow(/Unknown Cell artifact guarantee/);
  });
});

// The split is the repository's rule 7 in executable form: a local green build is
// not runtime compatibility, so which promises a local check can establish is
// recorded rather than assumed.
describe("local versus real-runtime evidence", () => {
  it("keeps exactly the mounting promise out of local reach", () => {
    expect(realRuntimeCellArtifactGuarantees().map(guarantee => guarantee.id)).toEqual([
      "accepted-by-react-cell-type",
    ]);
    // Acceptance is the platform's verdict, so no local check may claim it. The
    // local half of it lives in the entry and source guards, not here.
    expect(locallyCheckableCellArtifactGuarantees().map(guarantee => guarantee.id)).not.toContain(
      "accepted-by-react-cell-type",
    );
  });

  it("accounts for every guarantee in one of the two groups", () => {
    const local = locallyCheckableCellArtifactGuarantees();
    const runtime = realRuntimeCellArtifactGuarantees();
    expect(local.length + runtime.length).toBe(CELL_ARTIFACT_GUARANTEES.length);
    expect(local.filter(guarantee => runtime.includes(guarantee))).toEqual([]);
  });

  // Where a promise is weaker than it reads, the caveat is part of the record —
  // otherwise the next reader takes the statement at face value.
  it("records the caveat wherever the promise is not unconditional", () => {
    expect(findCellArtifactGuarantee("no-unresolved-source-imports").caveat).toMatch(/import.*rejected/i);
    expect(findCellArtifactGuarantee("host-dependencies-reference-host-identity").caveat).toMatch(
      /invisible locally/,
    );
    expect(findCellArtifactGuarantee("extension-dependencies-reference-extension").caveat).toMatch(
      /listFrontendLibraries/,
    );
    expect(findCellArtifactGuarantee("deterministic-artifact").caveat).toMatch(/banner/);
  });

  // Guarantee 1's wording says the artifact exposes "the required `App` entry",
  // but #5 records `render(value)` as an accepted entry that needs no `App` at
  // all, and this contract emits both. Repeating the Spec's sentence without that
  // qualifier would make the record false for one of the shapes it describes.
  it("reads the `App` half of the mounting guarantee through the resolution order", () => {
    const guarantee = findCellArtifactGuarantee("accepted-by-react-cell-type");
    expect(guarantee.statement).toMatch(/exposes the required `App` entry/);
    expect(guarantee.caveat).toMatch(/render\(value\)/);
    expect(guarantee.caveat).toMatch(/no `App` at all/);
  });

  // The two guarantees whose checks are narrower than they sound must say so, or
  // a reader will assume a local gate covers what it cannot.
  it("narrows the guarantees whose positive half is not locally checkable", () => {
    expect(findCellArtifactGuarantee("inline-dependencies-flattened").caveat).toMatch(
      /unused dependency is a legitimate absence/,
    );
    expect(findCellArtifactGuarantee("workspace-packages-inline-like-source").caveat).toMatch(
      /no workspace manifest/,
    );
  });

  // The banner is the one place #6 allows non-determinism, and this contract
  // does not use the allowance — so the guarantee must not carry an exception.
  it("does not exempt a banner this contract never emits", () => {
    expect(findCellArtifactGuarantee("deterministic-artifact").statement).toMatch(/deterministic/);
    expect(findCellArtifactGuarantee("deterministic-artifact").caveat).toMatch(/emits none/);
  });
});
