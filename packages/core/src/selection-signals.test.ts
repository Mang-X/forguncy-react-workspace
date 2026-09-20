import { describe, expect, it } from "vitest";

import { PLATFORM_CONFLICT_PACKAGE_NAMES } from "./platform-conflicts";
import { isArchitecturalRejectionCode, isTechnicalRejectionCode } from "./rejection";
import {
  decideFromSignals,
  findReplacementSignalRejection,
  findSelectionSignal,
  isSelectionSignalFamily,
  isSelectionSignalId,
  NON_EVIDENCE_SIGNAL_SOURCES,
  REPLACEMENT_SIGNAL_REJECTIONS,
  SELECTION_SIGNALS,
  SELECTION_SIGNAL_FAMILIES,
  SELECTION_SIGNAL_FAMILY_SEMANTICS,
  SELECTION_SIGNAL_IDS,
  selectionSignal,
  selectionSignalFamilyOf,
  selectionSignalFamilySemantics,
  selectionSignalsObservedFrom,
  SIGNAL_OBSERVATION_CHANNELS,
  signalsInFamily,
  validateSignalFindings,
} from "./selection-signals";

describe("selection signal catalogue", () => {
  it("defines three families", () => {
    expect([...SELECTION_SIGNAL_FAMILIES]).toEqual(["positive", "risk", "replacement"]);
  });

  it("only lets the replacement family reject a candidate", () => {
    // #16 states this asymmetry in prose in two separate places ("risk signals
    // requiring probe (not automatic rejection)" and "ESM is a positive signal,
    // not proof"). Here it is one assertion, so a future edit that promotes a
    // risk into a rejection fails the build rather than shipping quietly.
    expect(SELECTION_SIGNAL_FAMILY_SEMANTICS.replacement.rejectsCandidateOnItsOwn).toBe(true);
    expect(SELECTION_SIGNAL_FAMILY_SEMANTICS.risk.rejectsCandidateOnItsOwn).toBe(false);
    expect(SELECTION_SIGNAL_FAMILY_SEMANTICS.positive.rejectsCandidateOnItsOwn).toBe(false);
  });

  it("lets no family accept a candidate on its own", () => {
    for (const family of SELECTION_SIGNAL_FAMILIES) {
      const semantics = selectionSignalFamilySemantics(family);
      expect(semantics.acceptsCandidateOnItsOwn, family).toBe(false);
      expect(semantics.nextStep.length, family).toBeGreaterThan(0);
    }
  });

  it("gives every signal a unique id in exactly one family", () => {
    const ids = SELECTION_SIGNALS.map(signal => signal.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(SELECTION_SIGNAL_IDS.length);

    const regrouped = SELECTION_SIGNAL_FAMILIES.flatMap(family => signalsInFamily(family).map(signal => signal.id));
    expect([...regrouped].sort()).toEqual([...ids].sort());
  });

  it("resolves a signal id and rejects an unknown one", () => {
    expect(isSelectionSignalId("worker")).toBe(true);
    expect(isSelectionSignalId("not-a-signal")).toBe(false);
    expect(findSelectionSignal("wasm")?.family).toBe("risk");
    expect(findSelectionSignal("not-a-signal")).toBeUndefined();
    expect(selectionSignalFamilyOf("wasm")).toBe("risk");
    expect(() => selectionSignal("not-a-signal" as never)).toThrow(/Unknown dependency-selection signal/);
    expect(isSelectionSignalFamily("replacement")).toBe(true);
    expect(isSelectionSignalFamily("critical")).toBe(false);
  });

  it("covers the risk patterns #16 lists as probe triggers", () => {
    // The list is in the Spec, so it is asserted rather than trusted: a missing
    // entry here is a runtime constraint the probe would never look for.
    for (const id of [
      "worker",
      "shared-worker",
      "wasm",
      "import-meta-url-asset",
      "runtime-fetch-of-package-asset",
      "dynamic-import-or-code-splitting",
      "css-font-or-image-assets",
      "portal-to-document-body",
      "webgl-canvas-lifecycle",
      "global-singleton-assumption",
    ]) {
      expect(selectionSignalFamilyOf(id as never), id).toBe("risk");
    }
  });

  it("covers the rejection/replacement signals #16 lists", () => {
    for (const id of [
      "node-filesystem-process-or-native-addon",
      "ssr-or-server-only-without-browser-build",
      "service-worker-or-special-header-requirement",
      "application-ownership-conflict",
      "cell-artifact-budget-exceeded",
      "runtime-assets-not-embeddable",
    ]) {
      expect(selectionSignalFamilyOf(id as never), id).toBe("replacement");
    }
  });
});

describe("signal observation channels", () => {
  it("observes every signal through a machine artefact", () => {
    expect([...SIGNAL_OBSERVATION_CHANNELS]).toEqual([
      "registry-metadata",
      "package-manifest",
      "package-files",
      "dependency-graph",
      "build-output",
      "artifact-scan",
      "runtime-observation",
    ]);
    for (const signal of SELECTION_SIGNALS) {
      expect(SIGNAL_OBSERVATION_CHANNELS, signal.id).toContain(signal.observedFrom);
    }
  });

  it("offers no channel for prose about a package", () => {
    // "Never declare compatibility from README inspection alone" is enforced by
    // omission: a documentation-derived claim has nowhere to be recorded.
    for (const source of NON_EVIDENCE_SIGNAL_SOURCES) {
      expect(SIGNAL_OBSERVATION_CHANNELS as readonly string[], source).not.toContain(source);
    }
    expect(NON_EVIDENCE_SIGNAL_SOURCES as readonly string[]).toContain("readme");
    expect(NON_EVIDENCE_SIGNAL_SOURCES as readonly string[]).toContain("model-recall");
  });

  it("groups signals by the channel that reveals them", () => {
    expect(selectionSignalsObservedFrom("runtime-observation").map(signal => signal.id)).toContain(
      "portal-to-document-body",
    );
    expect(selectionSignalsObservedFrom("package-manifest")).toHaveLength(
      SELECTION_SIGNALS.filter(signal => signal.observedFrom === "package-manifest").length,
    );
  });

  it("keeps the catalogue free of package names", () => {
    // #16 rejects a package-specific compatibility list. A signal that named a
    // package would be that list growing back, one entry at a time.
    const text = SELECTION_SIGNALS.map(signal => `${signal.id} ${signal.label} ${signal.summary}`).join(" ");
    for (const packageName of PLATFORM_CONFLICT_PACKAGE_NAMES) {
      expect(text, packageName).not.toContain(packageName);
    }
  });
});

describe("replacement signals as rejections", () => {
  it("maps every replacement signal onto a rejection from #4's vocabulary", () => {
    const replacementIds = signalsInFamily("replacement").map(signal => signal.id);
    const mappedIds = REPLACEMENT_SIGNAL_REJECTIONS.map(entry => entry.signal);

    expect([...mappedIds].sort()).toEqual([...replacementIds].sort());

    for (const entry of REPLACEMENT_SIGNAL_REJECTIONS) {
      expect(selectionSignalFamilyOf(entry.signal), entry.signal).toBe("replacement");
      if (entry.kind === "architectural") {
        expect(isArchitecturalRejectionCode(entry.code), entry.signal).toBe(true);
      } else {
        expect(isTechnicalRejectionCode(entry.code), entry.signal).toBe(true);
      }
      expect(entry.remediation.length, entry.signal).toBeGreaterThan(0);
    }
  });

  it("classifies an ownership conflict as architectural and the rest as technical", () => {
    // The split is #4's, not this module's: an ownership conflict is not fixable
    // by choosing a better package, while a bundling failure is.
    expect(findReplacementSignalRejection("application-ownership-conflict")?.kind).toBe("architectural");
    expect(findReplacementSignalRejection("node-filesystem-process-or-native-addon")?.kind).toBe("technical");
    expect(findReplacementSignalRejection("cell-artifact-budget-exceeded")?.kind).toBe("technical");
  });

  it("refuses to build a rejection out of a family that does not reject", () => {
    expect(findReplacementSignalRejection("worker")).toBeUndefined();
    expect(findReplacementSignalRejection("browser-first-esm-distribution")).toBeUndefined();
  });
});

describe("deciding from signals", () => {
  it("never reaches anything better than a probe", () => {
    const verdict = decideFromSignals([
      "browser-first-esm-distribution",
      "shipped-typescript-declarations",
      "no-node-builtins",
      "maintained-and-licensed",
    ]);

    expect(verdict.verdict).toBe("probe-required");
    expect(verdict.positiveSignals).toHaveLength(4);
    expect(verdict.replacementSignals).toEqual([]);
    expect(verdict.reason).toMatch(/a deterministic probe is required/);
  });

  it("treats a risk as a reason to probe, not a reason to reject", () => {
    const verdict = decideFromSignals(["worker", "wasm"]);

    expect(verdict.verdict).toBe("probe-required");
    expect(verdict.risksToProbe).toEqual(["worker", "wasm"]);
    expect(verdict.reason).toMatch(/must be probed/);
  });

  it("rejects when a replacement signal is present, whatever else was observed", () => {
    const verdict = decideFromSignals([
      "browser-first-esm-distribution",
      "shipped-typescript-declarations",
      "wasm",
      "node-filesystem-process-or-native-addon",
    ]);

    expect(verdict.verdict).toBe("reject-candidate");
    expect(verdict.replacementSignals).toEqual(["node-filesystem-process-or-native-addon"]);
    expect(verdict.positiveSignals).toHaveLength(2);
    expect(verdict.reason).toMatch(/Positive signals do not outweigh a replacement signal/);
  });

  it("reports unknown ids instead of ignoring them", () => {
    const verdict = decideFromSignals(["worker", "totally-made-up"]);

    expect(verdict.unknownSignals).toEqual(["totally-made-up"]);
    expect(verdict.verdict).toBe("probe-required");
  });

  it("still demands a probe when nothing was observed", () => {
    const verdict = decideFromSignals([]);
    expect(verdict.verdict).toBe("probe-required");
    expect(verdict.reason).toMatch(/no signal was observed either way/);
  });
});

describe("signal finding validation", () => {
  it("accepts risk-family findings in a risk list", () => {
    expect(validateSignalFindings([{ signal: "worker" }, { signal: "wasm" }], "risk")).toEqual([]);
  });

  it("refuses an unknown signal", () => {
    const problems = validateSignalFindings([{ signal: "nope" }], "risk");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not in the selection catalogue/);
  });

  it("refuses a finding filed in the wrong family", () => {
    const positiveProblem = validateSignalFindings([{ signal: "shipped-typescript-declarations" }], "risk");
    expect(positiveProblem).toHaveLength(1);
    expect(positiveProblem[0]).toMatch(/is a "positive" signal, but this list records "risk" findings/);

    // The case that matters: a rejection tucked into a warning list.
    const replacementProblem = validateSignalFindings([{ signal: "cell-artifact-budget-exceeded" }], "risk");
    expect(replacementProblem).toHaveLength(1);
    expect(replacementProblem[0]).toMatch(/is a "replacement" signal/);
  });
});
