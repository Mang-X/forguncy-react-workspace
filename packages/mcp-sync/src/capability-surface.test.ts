import { describe, expect, it } from "vitest";

import {
  assertMcpSyncFlowIsCoherent,
  assertMcpSyncStepCoherent,
  assertSyncCapabilityCoherent,
  assertSyncPortMatchesCapabilities,
  establishedSyncPortMethods,
  findMcpSyncStep,
  findSyncCapability,
  findSyncEvidenceSource,
  formatMcpSyncFlow,
  MCP_SYNC_STEPS,
  requiredSyncCapabilities,
  SyncCapabilityContractError,
  SYNC_CAPABILITIES,
  syncMutationStep,
  unestablishedSyncCapabilities,
} from "./capability-surface.ts";
import type { McpSyncStep, SyncCapability } from "./capability-surface.ts";
import { FORGUNCY_SYNC_PORT_METHODS } from "./port.ts";

describe("the MCP sync flow", () => {
  it("is internally coherent", () => {
    expect(() => assertMcpSyncFlowIsCoherent()).not.toThrow();
  });

  it("has exactly one mutating step, and it is the Cell write", () => {
    const mutating = MCP_SYNC_STEPS.filter(step => step.phase === "mutation");
    expect(mutating).toHaveLength(1);
    expect(syncMutationStep().id).toBe("write-cell-source");
  });

  // #19's order, asserted rather than described: a project with errors must be reported
  // before the page is generated, or a broken sync looks like a successful one.
  it("checks project errors after the write and before generating the page", () => {
    const mutation = syncMutationStep();
    const errors = findMcpSyncStep("check-project-errors");
    const generate = findMcpSyncStep("generate-page");

    expect(errors.order).toBeGreaterThan(mutation.order);
    expect(errors.order).toBeLessThan(generate.order);
    expect(errors.phase).toBe("after-mutation");
    expect(generate.phase).toBe("after-mutation");
  });

  it("verifies extensions and reads the target before the write", () => {
    const mutation = syncMutationStep();
    for (const id of ["verify-extension-metadata", "read-target-state"] as const) {
      const step = findMcpSyncStep(id);
      expect(step.order).toBeLessThan(mutation.order);
      expect(step.phase).toBe("before-mutation");
    }
  });

  it("resolves the target on the repository side rather than as a designer call", () => {
    const resolve = findMcpSyncStep("resolve-cell-target");
    expect(resolve.transport).toBe("repository-config");
    expect(resolve.capabilityIds).toEqual([]);
    expect(resolve.carriedOutBy).toBeDefined();
  });

  it("names only designer capabilities that some step needs, and vice versa", () => {
    for (const step of MCP_SYNC_STEPS) {
      for (const capabilityId of step.capabilityIds) {
        expect(findSyncCapability(capabilityId).usedByStepIds).toContain(step.id);
      }
    }
    for (const capability of SYNC_CAPABILITIES) {
      for (const stepId of capability.usedByStepIds) {
        expect(findMcpSyncStep(stepId).capabilityIds).toContain(capability.id);
      }
    }
  });

  it("reports itself as a report block", () => {
    const report = formatMcpSyncFlow();
    expect(report).toContain("write-cell-source [mutation]");
    expect(report).toContain("api.page.setCells");
    expect(report).toContain("Every required designer operation has an established call name.");
  });
});

describe("what the evidence establishes", () => {
  /**
   * The exact call names, pinned.
   *
   * This is the test that makes a guessed call name fail a check instead of shipping: the
   * names below are the ones #5's, #20's and #115's executed designer evidence and the
   * product's own guide record, and there is no eighth. A change to any of them has to come
   * with the evidence that established it, because inventing one is precisely the failure
   * #19's "or the exact supported equivalent" hedge invites.
   *
   * `generate-page`'s name moved from `api.app.generatePageAsync` to
   * `api.app.generateProject` under #115, and it is worth being precise about why that is not
   * the thing this test exists to prevent: the rule is "an established capability quotes a
   * call that was *executed*", not "a call name never changes". #115 executed
   * `api.app.generateProject` on 12.0.101.0 (and the product documents it), while
   * `generatePageAsync` is absent there — so the pinned name is the one that was established
   * for the surface the adapter now drives. The older spelling is not deleted: it remains a
   * recognised build difference in `GENERATE_PROJECT_SCRIPT`, with its own 12.0.100.0
   * evidence, and the adapter picks by `typeof` rather than by version.
   */
  it("quotes the observed designer calls verbatim", () => {
    const established = SYNC_CAPABILITIES.filter(capability => capability.confirmation === "established").map(
      capability => capability.method,
    );
    expect(established.sort()).toEqual([
      "api.app.checkProjectErrors",
      "api.app.generateProject",
      "api.app.getProjectSaveStatus",
      "api.app.listFrontendLibraries",
      "api.app.saveProject",
      "api.page.getCells",
      "api.page.setCells",
    ]);
  });

  // The two operations #5 left unnamed, established by #20's execution. This replaced a
  // test asserting they were `unestablished`, and the replacement is the point: the axis
  // did not change, the evidence did.
  it("records that both operations #5 left unnamed are now executed", () => {
    expect(unestablishedSyncCapabilities()).toEqual([]);

    const read = findSyncCapability("read-cell-source");
    expect(read.method).toBe("api.page.getCells");
    expect(read.portMethod).toBe("readCellSource");
    expect(read.evidenceSources).toContain("issue-20-designer-execution");

    const save = findSyncCapability("save-project");
    expect(save.method).toBe("api.app.saveProject");
    expect(save.portMethod).toBe("saveProject");
    expect(save.evidenceSources).toContain("issue-20-designer-execution");
  });

  // The call that was *rejected*, and why. `readCellCode` is real and was executed; it is
  // not on the port because it truncates at 12,000 characters, which would make the marker
  // parse read a generated Cell as damaged. Asserted so the reasoning travels with the code
  // rather than living only in a pull request.
  it("records the read it rejected, and the measurement that rejected it", () => {
    const source = findSyncEvidenceSource("issue-20-designer-execution");
    expect(source.channel).toBe("designer-api");
    expect(source.scope).toContain("12,000");
    expect(source.scope).toContain("readCellCode");
    expect(findSyncCapability("read-cell-source").method).not.toBe("api.page.readCellCode");
  });

  // #115: the two shapes that turned out to be version-sensitive, and the version they were
  // measured on. Asserted rather than left to the note's prose because the load-bearing part
  // is the *boundary*: the source has to say which build it is evidence for, so a later
  // reader cannot mistake it for a claim about the pinned one.
  it("records which build the generation and read-back shapes were probed on", () => {
    const generation = findSyncCapability("generate-page");
    expect(generation.evidenceSources).toContain("issue-115-designer-probe");
    expect(generation.method).toBe("api.app.generateProject");

    const source = findSyncEvidenceSource("issue-115-designer-probe");
    expect(source.channel).toBe("designer-api");
    expect(source.scope).toContain("12.0.101.0");
    expect(source.scope).toContain("ReactCellType");
    expect(source.scope).toContain("generatePageAsync");
    // The boundary that matters: this source is explicit that it did not re-measure the
    // pinned build, so it cannot be read as discharging #20's 12.0.100.0 evidence.
    expect(source.scope).toContain("not");
    expect(source.scope).toContain("12.0.100.0");
  });

  it("keeps the save status as the step's own reason for saving", () => {
    const status = findSyncCapability("project-save-status");
    expect(status.method).toBe("api.app.getProjectSaveStatus");
    expect(status.portMethod).toBe("getProjectSaveStatus");
    // Both halves of the conditional save are on the step: what makes it required, and the
    // call that performs it. A step naming only the second could not decide anything.
    expect(findMcpSyncStep("save-project-if-required").capabilityIds).toEqual(["project-save-status", "save-project"]);
    expect(status.note).toContain("contain");
  });

  it("gives every capability an evidence source that resolves", () => {
    for (const capability of SYNC_CAPABILITIES) {
      expect(capability.evidenceSources.length).toBeGreaterThan(0);
      for (const sourceId of capability.evidenceSources) {
        expect(findSyncEvidenceSource(sourceId).citation.length).toBeGreaterThan(0);
      }
    }
  });

  it("separates the executed evidence from the guide that only documents", () => {
    expect(findSyncEvidenceSource("issue-5-designer-probe").channel).toBe("designer-api");
    expect(findSyncEvidenceSource("forguncy-library-guide").channel).toBe("product-documentation");
    expect(findSyncEvidenceSource("forguncy-library-guide").scope).toContain("documentation, not an execution");
  });

  // #115's evidence has to *reach* the capabilities it is evidence for.
  //
  // Without this, the two edits the change is made of can silently cancel: adding the source
  // record on one line and the `evidenceSources` entry on another are separate edits, and either
  // one alone still compiles, still passes every other test here, and still leaves the two
  // capabilities quoting a name the new source is the only evidence for. The check is over the
  // *registry*, so it fails on the half-edit in either direction.
  it("cites the build the generation and read-back shapes were probed on, where it is evidence", () => {
    const cited = SYNC_CAPABILITIES.filter(capability =>
      capability.evidenceSources.includes("issue-115-designer-probe"),
    ).map(capability => capability.id);

    // Exactly the two shapes #115 measured, and no third: evidence spread by habit over
    // capabilities it says nothing about is how a citation stops meaning anything.
    expect(cited.sort()).toEqual(["generate-page", "read-cell-source"]);

    // And the generation capability's name is the one that source *established* — asserting the
    // pair, because citing #115 while keeping the call name it found absent would be a claim the
    // source itself contradicts.
    expect(findSyncCapability("generate-page").method).toBe("api.app.generateProject");
  });
});

describe("the port is the evidence boundary", () => {
  it("exposes exactly the established capabilities the flow needs", () => {
    expect(establishedSyncPortMethods()).toEqual([...FORGUNCY_SYNC_PORT_METHODS]);
    expect([...FORGUNCY_SYNC_PORT_METHODS]).toEqual([
      "listFrontendLibraries",
      "readCellSource",
      "setCells",
      "saveProject",
      "checkProjectErrors",
      "generatePageAsync",
      "getProjectSaveStatus",
    ]);
    expect(() => assertSyncPortMatchesCapabilities(establishedSyncPortMethods())).not.toThrow();
  });

  // The dangerous direction: a port method with no established capability behind it is an
  // unverified call wearing a verified call's shape, and only a real project would find out.
  it("refuses a port method with no capability behind it", () => {
    expect(() =>
      assertSyncPortMatchesCapabilities(["listFrontendLibraries"], [
        "listFrontendLibraries",
        "readCellSource",
      ] as never),
    ).toThrow(SyncCapabilityContractError);
  });

  it("refuses when an established capability is missing from the port", () => {
    expect(() =>
      assertSyncPortMatchesCapabilities(["listFrontendLibraries", "setCells"], [
        "listFrontendLibraries",
      ] as never),
    ).toThrow(/established but not on the port/);
  });

  it("requires the flow to need every capability it puts on the port", () => {
    const required = new Set(requiredSyncCapabilities().map(capability => capability.id));
    for (const method of FORGUNCY_SYNC_PORT_METHODS) {
      const capability = SYNC_CAPABILITIES.find(candidate => candidate.portMethod === method);
      expect(capability, method).toBeDefined();
      expect(required.has(capability?.id as never), method).toBe(true);
    }
  });
});

describe("the guards refuse an incoherent registry", () => {
  const step = (overrides: Partial<McpSyncStep>): McpSyncStep =>
    ({ ...(MCP_SYNC_STEPS[3] as McpSyncStep), ...overrides }) as McpSyncStep;

  it("refuses a step whose declared order disagrees with its position", () => {
    expect(() => assertMcpSyncStepCoherent(step({ order: 3 }), 3)).toThrow(/declares order/);
  });

  it("refuses a repository-side step that claims designer capabilities", () => {
    expect(() =>
      assertMcpSyncStepCoherent(
        step({ transport: "repository-config", capabilityIds: ["write-cell-source"], carriedOutBy: "the caller" }),
        3,
      ),
    ).toThrow(/repository side/);
  });

  it("refuses a designer step that names no capability", () => {
    expect(() => assertMcpSyncStepCoherent(step({ capabilityIds: [] }), 3)).toThrow(/names no capability/);
  });

  it("refuses a step whose capability does not list it back", () => {
    expect(() => assertMcpSyncStepCoherent(step({ capabilityIds: ["generate-page"] }), 3)).toThrow(
      /does not list it back/,
    );
  });

  /**
   * A capability in the state #20 retired from the shipped registry.
   *
   * Every required capability is `established` now, which would leave the guards' whole
   * `unestablished` half with no input — and a guard whose failure branch never runs is a
   * guard that has quietly stopped checking anything. So the branch is exercised against a
   * *supplied* record, built from the shape the registry used to hold: the call that lost
   * its evidence, which is the state the next such operation will be in.
   */
  const unestablished = (overrides: Partial<SyncCapability> = {}): SyncCapability =>
    ({
      id: "save-project",
      summary: "Persist the project after a mutation.",
      evidenceSources: ["issue-5-designer-probe"],
      confirmation: "unestablished",
      usedByStepIds: ["save-project-if-required"],
      blockedBy: "Recording the exact call name.",
      ...overrides,
    }) as SyncCapability;

  // The failure this axis exists for: an unestablished operation that acquires a plausible
  // name, which would make "we verified nothing" unreportable.
  it("refuses a capability with no established call that carries a name anyway", () => {
    expect(() => assertSyncCapabilityCoherent(unestablished({ method: "api.page.getCells" }))).toThrow(
      /the guess the confirmation axis exists to prevent/,
    );
  });

  it("refuses an unestablished capability on the port", () => {
    expect(() => assertSyncCapabilityCoherent(unestablished({ portMethod: "setCells" }))).toThrow(
      /evidence boundary/,
    );
  });

  it("refuses an unestablished capability that does not say what would settle it", () => {
    expect(() => assertSyncCapabilityCoherent(unestablished({ blockedBy: undefined }))).toThrow(
      /without naming the evidence/,
    );
  });

  it("refuses an unestablished capability no step needs", () => {
    expect(() => assertSyncCapabilityCoherent(unestablished({ usedByStepIds: [] }))).toThrow(
      /no step needs it/,
    );
  });

  // The shipped registry, asserted in the state the guards would otherwise hide: a port
  // method that is established, required, and named by exactly one capability.
  it("accepts every shipped capability as coherent", () => {
    for (const capability of SYNC_CAPABILITIES) {
      expect(() => assertSyncCapabilityCoherent(capability), capability.id).not.toThrow();
    }
  });

  it("refuses an established capability with no call name", () => {
    expect(() =>
      assertSyncCapabilityCoherent({ ...findSyncCapability("write-cell-source"), method: undefined } as SyncCapability),
    ).toThrow(/never paraphrases it/);
  });

  it("refuses a capability that cites no evidence", () => {
    expect(() =>
      assertSyncCapabilityCoherent({ ...findSyncCapability("write-cell-source"), evidenceSources: [] } as SyncCapability),
    ).toThrow(/cites no evidence source/);
  });
});
