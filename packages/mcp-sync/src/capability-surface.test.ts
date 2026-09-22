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
} from "./capability-surface";
import type { McpSyncStep, SyncCapability } from "./capability-surface";
import { FORGUNCY_SYNC_PORT_METHODS } from "./port";

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
    expect(report).toContain("no established call name");
  });
});

describe("what the evidence establishes", () => {
  /**
   * The exact call names, pinned.
   *
   * This is the test that makes a guessed call name fail a check instead of shipping: the
   * five names below are the ones #5's executed designer evidence and the product's own
   * guide record, and there is no sixth. A change to any of them has to come with the
   * evidence that established it, because inventing one is precisely the failure #19's
   * "or the exact supported equivalent" hedge invites.
   */
  it("quotes the observed designer calls verbatim", () => {
    const established = SYNC_CAPABILITIES.filter(capability => capability.confirmation === "established").map(
      capability => capability.method,
    );
    expect(established.sort()).toEqual([
      "api.app.checkProjectErrors",
      "api.app.generatePageAsync",
      "api.app.getProjectSaveStatus",
      "api.app.listFrontendLibraries",
      "api.page.setCells",
    ]);
  });

  it("is explicit that two required operations have no recorded call name", () => {
    const unestablished = unestablishedSyncCapabilities();
    expect(unestablished.map(capability => capability.id)).toEqual(["read-cell-source", "save-project"]);

    for (const capability of unestablished) {
      expect(capability.method).toBeUndefined();
      expect(capability.portMethod).toBeUndefined();
      expect(capability.blockedBy?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // The reason `project-save-status` is recorded at all: it is the one save-adjacent call the
  // probe ran, and leaving it out is how a reader concludes that it saves a project.
  it("records the observed save-status call without letting it stand in for saving", () => {
    const status = findSyncCapability("project-save-status");
    expect(status.method).toBe("api.app.getProjectSaveStatus");
    expect(status.usedByStepIds).toEqual([]);
    expect(status.portMethod).toBeUndefined();
    expect(findMcpSyncStep("save-project-if-required").capabilityIds).toEqual(["save-project"]);
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
});

describe("the port is the evidence boundary", () => {
  it("exposes exactly the established capabilities the flow needs", () => {
    expect(establishedSyncPortMethods()).toEqual([...FORGUNCY_SYNC_PORT_METHODS]);
    expect([...FORGUNCY_SYNC_PORT_METHODS]).toEqual([
      "listFrontendLibraries",
      "setCells",
      "checkProjectErrors",
      "generatePageAsync",
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

  // The failure this axis exists for: an unestablished operation that acquires a plausible
  // name, which would make "we verified nothing" unreportable.
  it("refuses a capability with no established call that carries a name anyway", () => {
    expect(() =>
      assertSyncCapabilityCoherent({
        ...findSyncCapability("read-cell-source"),
        method: "api.page.getCells",
      } as SyncCapability),
    ).toThrow(/the guess the confirmation axis exists to prevent/);
  });

  it("refuses an unestablished capability on the port", () => {
    expect(() =>
      assertSyncCapabilityCoherent({
        ...findSyncCapability("save-project"),
        portMethod: "setCells",
      } as SyncCapability),
    ).toThrow(/evidence boundary/);
  });

  it("refuses an unestablished capability that does not say what would settle it", () => {
    expect(() =>
      assertSyncCapabilityCoherent({ ...findSyncCapability("save-project"), blockedBy: undefined } as SyncCapability),
    ).toThrow(/without naming the evidence/);
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
