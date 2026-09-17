import { describe, expect, it } from "vitest";

import {
  APPLICATION_OWNERSHIP_INVARIANT,
  assertOwnedBy,
  concernsOwnedBy,
  findOwnershipConcern,
  isApplicationOwned,
  ownerOf,
  OwnershipViolationError,
  OWNERSHIP_CONCERNS,
} from "./ownership";

describe("application ownership boundary", () => {
  it("states the invariant as one sentence", () => {
    expect(APPLICATION_OWNERSHIP_INVARIANT).toBe("Forguncy owns the application. React owns the island.");
  });

  it("assigns every concern listed in Issue #4 to exactly one owner", () => {
    expect(ownerOf("application-navigation")).toBe("forguncy");
    expect(ownerOf("application-state")).toBe("forguncy");
    expect(ownerOf("business-data-source")).toBe("forguncy");
    expect(ownerOf("server-commands")).toBe("forguncy");
    expect(ownerOf("permissions")).toBe("forguncy");
    expect(ownerOf("page-lifecycle")).toBe("forguncy");
    expect(ownerOf("cross-cell-communication")).toBe("forguncy");

    expect(ownerOf("cell-ui")).toBe("react-cell");
    expect(ownerOf("cell-interaction-state")).toBe("react-cell");
    expect(ownerOf("cell-forms")).toBe("react-cell");
    expect(ownerOf("cell-visualization")).toBe("react-cell");
    expect(ownerOf("cell-animation")).toBe("react-cell");
    expect(ownerOf("cell-editors")).toBe("react-cell");
    expect(ownerOf("cell-local-remote-data")).toBe("react-cell");
  });

  it("keeps the ownership partition exhaustive and non-overlapping", () => {
    const forguncyOwned = concernsOwnedBy("forguncy");
    const cellOwned = concernsOwnedBy("react-cell");

    expect(new Set([...forguncyOwned, ...cellOwned]).size).toBe(OWNERSHIP_CONCERNS.length);
    expect(forguncyOwned.filter(id => cellOwned.includes(id))).toEqual([]);
    for (const id of forguncyOwned) {
      expect(isApplicationOwned(id)).toBe(true);
    }
    for (const id of cellOwned) {
      expect(isApplicationOwned(id)).toBe(false);
    }
  });

  it("explains every concern, so a rejection report can quote a reason", () => {
    for (const concern of OWNERSHIP_CONCERNS) {
      expect(concern.rationale.trim().length).toBeGreaterThan(0);
      expect(concern.label.trim().length).toBeGreaterThan(0);
      expect(findOwnershipConcern(concern.id)).toBe(concern);
    }
  });

  it("refuses to guess an owner for an unknown concern", () => {
    expect(() => ownerOf("application-router" as never)).toThrow(/Unknown ownership concern/);
    expect(findOwnershipConcern("nope" as never)).toBeUndefined();
  });

  it("throws a violation error naming the expected and actual owner", () => {
    expect(() => assertOwnedBy("application-state", "forguncy")).not.toThrow();

    let caught: unknown;
    try {
      assertOwnedBy("application-state", "react-cell");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OwnershipViolationError);
    const violation = caught as OwnershipViolationError;
    expect(violation.concern).toBe("application-state");
    expect(violation.expectedOwner).toBe("forguncy");
    expect(violation.actualOwner).toBe("react-cell");
    expect(violation.message).toContain(APPLICATION_OWNERSHIP_INVARIANT);
  });
});
