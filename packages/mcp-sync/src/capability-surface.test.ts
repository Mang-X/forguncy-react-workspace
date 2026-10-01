import { describe, expect, it } from "vitest";

import { SYNC_CAPABILITY_IDS, preferredCallOf } from "./capability-surface.ts";
import { SYNC_MEASURED_VERSIONS, SYNC_SUPPORTED_VERSIONS } from "./guarantees.ts";
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

    // The versioned record is what makes the name a *version difference* rather than a rename
    // applied to every build. Both halves must be present, because dropping the 12.0.100.0 entry
    // would leave the capability claiming `generateProject` as a fact about the pinned build —
    // the promotion #116's review found, and the one thing a flat `method` field cannot prevent.
    expect(generation.calls).toEqual([
      {
        method: "api.app.generatePageAsync",
        version: "12.0.100.0",
        evidenceSourceIds: ["issue-5-designer-probe", "forguncy-library-guide"],
      },
      { method: "api.app.generateProject", version: "12.0.101.0", evidenceSourceIds: ["issue-115-designer-probe"] },
    ]);

    // The note and the adapter have to describe the same fail-closed set, or a reader learns the
    // wrong contract from the registry. #116's second review is why `both present` is named here:
    // the versioned record says one call per build, so the adapter refuses the unmeasured shape
    // rather than picking a winner, and the note has to say so.
    expect(generation.note).toContain("neither");
    expect(generation.note).toContain("both");

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

  // #116's third review: five capabilities carried a `12.0.101.0` call whose evidence sources
  // were all `12.0.100.0` work, and the guard could not see it because `evidenceSources` sits on
  // the capability and cannot say which source established which version. The evidence is now on
  // the call, and this is what makes it a check rather than a convention.
  describe("a versioned call is bound to the evidence for that version", () => {
    it("cites a source that can establish that version, for every call", () => {
      for (const capability of SYNC_CAPABILITIES) {
        for (const call of capability.calls ?? []) {
          expect(call.evidenceSourceIds.length, `${capability.id} ${call.method}`).toBeGreaterThan(0);
          for (const sourceId of call.evidenceSourceIds) {
            // Resolvable, and not tied to a *different* build: `observedVersions` absent means the
            // source is version-neutral (#5's probe record, the product's documentation), which
            // can stand alongside any version; present means it is tied to one.
            const observed = findSyncEvidenceSource(sourceId).observedVersions;
            if (observed === undefined) continue;
            expect(observed, `${capability.id} ${call.method} cites ${sourceId}`).toContain(call.version);
          }
        }
      }
    });

    // And the other half: a version-neutral source is a stated property, not an omission, so the
    // 12.0.100.0 calls #5 and the product guide establish are not refused by the rule above.
    // Which sources are tied to a build is the whole basis of the rule, and #116's fourth review
    // corrected my reading of two of them: #5 is a *probe record executed against 12.0.100.0*
    // (its own citation says so), not a version-neutral fact, and only the product's
    // documentation carries no build at all.
    it("records which build each source observed", () => {
      expect(findSyncEvidenceSource("issue-5-designer-probe").observedVersions).toEqual(["12.0.100.0"]);
      expect(findSyncEvidenceSource("forguncy-library-guide").observedVersions).toBeUndefined();
      expect(findSyncEvidenceSource("issue-20-designer-execution").observedVersions).toEqual(["12.0.100.0"]);
      expect(findSyncEvidenceSource("issue-115-designer-probe").observedVersions).toEqual(["12.0.101.0"]);
    });

    // The counter-examples the review named, asserted so the wildcard cannot come back. Each is a
    // real 12.0.101.0 call backed only by evidence from another build, or by documentation.
    it("refuses a call established only by a source from another build", () => {
      for (const sourceId of [
        ["issue-5-designer-probe", "a 12.0.100.0 probe record"],
        ["forguncy-library-guide", "the product's documentation"],
        ["issue-20-designer-execution", "a 12.0.100.0 run"],
      ] as const) {
        const capability = {
          ...findSyncCapability("write-cell-source"),
          evidenceSources: [sourceId[0]],
          calls: [{ method: "api.page.setCells", version: "12.0.101.0", evidenceSourceIds: [sourceId[0]] }],
        } as unknown as SyncCapability;

        expect(() => assertSyncCapabilityCoherent(capability), sourceId[1]).toThrow(/no cited source .* observed that build/);
      }
    });

    // The build is not the whole of "established by execution": the source must have run *this
    // call* there. #116's fifth review is the case — `api.page.getCells` on 12.0.100.0 was
    // accepted against `issue-5-designer-probe`, whose own `scope` states it never recorded the
    // call it read persisted cell state with. The whole table is asserted so the two halves stay
    // distinguishable rather than one being quietly enough.
    it("requires a source that both observed the build and executed that call", () => {
      const capability = (id: string, method: string, version: string, evidenceSourceIds: readonly string[]) =>
        ({
          ...findSyncCapability(id as never),
          // The top-level list is derived from the calls below it, so a fixture that replaces
          // `calls` has to restate it — which is the point: the two records cannot drift
          // because the guard refuses a capability-level source no call cites.
          evidenceSources: [...evidenceSourceIds],
          calls: [{ method, version, evidenceSourceIds }],
        }) as unknown as SyncCapability;
      const accepted = (c: unknown) => {
        expect(() => assertSyncCapabilityCoherent(c as SyncCapability)).not.toThrow();
      };
      const refused = (c: unknown) => {
        expect(() => assertSyncCapabilityCoherent(c as SyncCapability)).toThrow(
          /both observed that build and executed that call/,
        );
      };

      // #5 ran these on 12.0.100.0 — its own scope enumerates them.
      accepted(capability("write-cell-source", "api.page.setCells", "12.0.100.0", ["issue-5-designer-probe"]));
      // #5's scope says it did **not** record the read call, which is why the operation was
      // `unestablished` until #20 executed it. So the same source must be refused here.
      refused(capability("read-cell-source", "api.page.getCells", "12.0.100.0", ["issue-5-designer-probe"]));
      accepted(capability("read-cell-source", "api.page.getCells", "12.0.100.0", ["issue-20-designer-execution"]));
      // The generation call on 100 was `generatePageAsync`; `generateProject` on 100 is unmeasured.
      refused(capability("generate-page", "api.app.generateProject", "12.0.100.0", ["issue-5-designer-probe"]));
      // #115 drove the whole flow on 12.0.101.0.
      accepted(capability("write-cell-source", "api.page.setCells", "12.0.101.0", ["issue-115-designer-probe"]));
      // A call no source mentions is not established by any of them.
      refused(capability("write-cell-source", "api.app.someFutureCall", "12.0.100.0", ["issue-5-designer-probe"]));
    });

    // And the complement: supplementary sources are still welcome beside one that establishes the
    // call, so the rule does not drive them out of the registry.
    it("accepts a source from another build alongside one that observed this build", () => {
      const capability = {
        ...findSyncCapability("write-cell-source"),
        evidenceSources: ["forguncy-library-guide", "issue-115-designer-probe"],
        calls: [
          {
            method: "api.page.setCells",
            version: "12.0.101.0",
            evidenceSourceIds: ["forguncy-library-guide", "issue-115-designer-probe"],
          },
        ],
      } as unknown as SyncCapability;

      expect(() => assertSyncCapabilityCoherent(capability)).not.toThrow();
    });

    it("refuses a call that cites nothing", () => {
      const capability = {
        ...findSyncCapability("write-cell-source"),
        calls: [{ method: "api.page.setCells", version: "12.0.101.0", evidenceSourceIds: [] }],
      } as unknown as SyncCapability;

      expect(() => assertSyncCapabilityCoherent(capability)).toThrow(/no evidence source/);
    });
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

    // The top-level list is the record's *provenance* — why this capability's evidence is on file
    // at all — not which source established which call; that is per-call (`evidenceSourceIds`).
    // #115's scope now says its adapter-level run drove all seven port methods, so asserting that
    // this source appears on only two capabilities is asserting the *drift* the review named: two
    // provenance semantics, each restated by hand, free to disagree.
    //
    // So the check is the one that must hold: every capability with a 12.0.101.0 call cites
    // #115, and every capability whose calls it established is recorded there.
    const with101 = SYNC_CAPABILITIES.filter(capability =>
      (capability.calls ?? []).some(call => call.version === "12.0.101.0"),
    );
    expect(with101.length).toBeGreaterThan(0);
    for (const capability of with101) {
      for (const call of capability.calls ?? []) {
        if (call.version !== "12.0.101.0") continue;
        expect(call.evidenceSourceIds, `${capability.id} ${call.method}`).toContain("issue-115-designer-probe");
      }
    }
    // And a capability may not claim a 12.0.101.0 call at all without that source behind it.
    expect(cited.every(id => with101.some(capability => capability.id === id))).toBe(true);

    // And the generation capability's name is the one that source *established* — asserting the
    // pair, because citing #115 while keeping the call name it found absent would be a claim the
    // source itself contradicts.
    expect(findSyncCapability("generate-page").method).toBe("api.app.generateProject");
  });

  // The general rule the generation case is the instance of: a capability's recorded calls are
  // the evidence boundary, so every entry must be one a tracked version was actually probed on,
  // and the version list a capability spans must be a subset of the repository's. Asserted over
  // the whole table so the next version-sensitive call cannot be added as a flat name.
  it("records every capability call against a version the repository tracks", () => {
    for (const capability of SYNC_CAPABILITIES) {
      for (const call of capability.calls ?? []) {
        expect(SYNC_MEASURED_VERSIONS, `${capability.id} ${call.method}`).toContain(call.version);
      }
    }
    // Every capability is now version-split, so the shape is exercised rather than merely
    // available: #120 gave each one a 12.0.101.0 entry beside its 12.0.100.0 one, because
    // #115's adapter-level run drove all of them through the shipped port on that build. If this
    // drops back to a single entry anywhere, the versioned record has been flattened and the
    // machinery around it stops being tested.
    const split = SYNC_CAPABILITIES.filter(capability => (capability.calls ?? []).length > 1);
    expect(split.map(capability => capability.id).sort()).toEqual([...SYNC_CAPABILITY_IDS].sort());
    // And the current call for each is the one on the *supported* version, not the historical
    // one — the property `preferredCallOf` exists to provide.
    for (const capability of SYNC_CAPABILITIES) {
      expect(capability.method, capability.id).toBe(
        (capability.calls ?? []).find(call => SYNC_SUPPORTED_VERSIONS.includes(call.version as never))?.method,
      );
    }
  });

  // The rule, on constructed inputs. The shipped table cannot distinguish the two rankings,
  // because support happens to be a suffix of measurement — so a test supplying only today's
  // records passes under either rule and proves nothing about which is intended. These inputs
  // make the two disagree, which is the only way the rule is actually under test.
  describe("which recorded call a capability quotes", () => {
    const call = (method: string, version: string) => ({ method, version }) as never;

    it("prefers a supported version's call over a newer measured-only one", () => {
      // Support is deliberately NOT the tail here: the newest measured build is unsupported.
      const measured = ["12.0.100.0", "12.0.101.0", "12.0.102.0"];
      const supported = ["12.0.101.0"];
      const calls = [
        call("api.page.onOldSupported", "12.0.100.0"),
        call("api.page.onSupported", "12.0.101.0"),
        call("api.page.onNewerUnsupported", "12.0.102.0"),
      ];

      // Ranking by the measured list alone would pick the newest overall; the rule picks the
      // newest *supported* one, which is the claim the capability is making.
      expect(preferredCallOf(calls, supported, measured)).toBe("api.page.onSupported");
      // Position in the record must not matter, or the property is really about array order.
      expect(preferredCallOf([...calls].reverse(), supported, measured)).toBe("api.page.onSupported");
    });

    it("falls back to the newest measured call when nothing is supported", () => {
      const measured = ["12.0.100.0", "12.0.101.0"];
      const calls = [call("api.page.older", "12.0.100.0"), call("api.page.newer", "12.0.101.0")];

      // A capability whose every call is historical still quotes the most recent of them rather
      // than nothing, so the port never loses its name for an established operation.
      expect(preferredCallOf(calls, [], measured)).toBe("api.page.newer");
    });

    it("quotes nothing for an absent or empty record", () => {
      expect(preferredCallOf(undefined)).toBeUndefined();
      expect(preferredCallOf([])).toBeUndefined();
    });
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

  it("refuses an established capability with no recorded call", () => {
    expect(() =>
      assertSyncCapabilityCoherent({ ...findSyncCapability("write-cell-source"), calls: [] } as SyncCapability),
    ).toThrow(/without recording a call/);
  });

  // The versioned record is the authority, and the quoted name is derived from it — so a
  // capability cannot maintain the two separately, in either direction. #116's review is why
  // this pair of checks exists: the previous shape stored one flat name and could assert a fact
  // about a build it had never been probed on.
  it("refuses a quoted name that disagrees with the versioned record", () => {
    const capability = findSyncCapability("write-cell-source");
    expect(() =>
      assertSyncCapabilityCoherent({
        ...capability,
        // A hand-written `method` overriding what `calls` resolves to.
        method: "api.page.setCellValues",
      } as SyncCapability),
    ).toThrow(/derived from the versioned record/);
  });

  it("refuses a call recorded against a version the repository does not track", () => {
    expect(() =>
      assertSyncCapabilityCoherent({
        ...findSyncCapability("write-cell-source"),
        calls: [{ method: "api.page.setCells", version: "13.0.0.0" }],
      } as unknown as SyncCapability),
    ).toThrow(/not a version this repository tracks/);
  });

  it("refuses a capability that cites no evidence", () => {
    expect(() =>
      assertSyncCapabilityCoherent({ ...findSyncCapability("write-cell-source"), evidenceSources: [] } as SyncCapability),
    ).toThrow(/cites no evidence source/);
  });

  // The drift the review found, from the other direction: a capability-level source no call cites.
  // `read-cell-source` carried one, asserting provenance the per-call record denies — and a
  // paragraph saying the two must agree is not a check. The guard refuses it; these assert it.
  it("refuses a capability-level source no call cites", () => {
    const capability = {
      ...findSyncCapability("read-cell-source"),
      evidenceSources: ["issue-5-designer-probe", "issue-20-designer-execution"],
      calls: [
        { method: "api.page.getCells", version: "12.0.100.0", evidenceSourceIds: ["issue-20-designer-execution"] },
      ],
    } as unknown as SyncCapability;

    expect(() => assertSyncCapabilityCoherent(capability)).toThrow(
      /lists "issue-5-designer-probe" as evidence, but none of its recorded calls cites it/,
    );
  });

  it("has no orphaned capability-level source in the shipped table", () => {
    for (const capability of SYNC_CAPABILITIES) {
      const cited = new Set((capability.calls ?? []).flatMap(call => call.evidenceSourceIds));
      for (const sourceId of capability.evidenceSources) {
        expect(cited.has(sourceId), `${capability.id} lists ${sourceId} with no call citing it`).toBe(true);
      }
    }
  });
});
