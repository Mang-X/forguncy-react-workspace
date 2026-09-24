import { describe, expect, it } from "vitest";

import { RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES } from "./lock.ts";
import { assessDependencyRole, isPlatformConflict, PLATFORM_CONFLICT_PACKAGE_NAMES } from "./platform-conflicts.ts";
import { isTechnicalRejectionCode, TECHNICAL_REJECTION_CODES } from "./rejection.ts";
import {
  decideFromSignals,
  findReplacementSignalRejection,
  findSelectionSignal,
  isSelectionSignalFamily,
  isSelectionSignalId,
  MACHINE_OBSERVED_SIGNAL_INVARIANT,
  NON_EVIDENCE_SIGNAL_SOURCES,
  REPLACEMENT_SIGNAL_REJECTIONS,
  replacementRejectionFor,
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
} from "./selection-signals.ts";

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
      "cell-artifact-budget-exceeded",
      "runtime-assets-not-embeddable",
      "dynamic-module-loading-cannot-be-eliminated",
      "amd-umd-branch-observed-in-artifact",
      "host-module-identity-mismatch-observed",
      "global-namespace-collision-observed",
    ]) {
      expect(selectionSignalFamilyOf(id as never), id).toBe("replacement");
    }
  });
});

describe("ownership is not a machine-observed signal", () => {
  it("states the invariant", () => {
    expect(MACHINE_OBSERVED_SIGNAL_INVARIANT).toMatch(/never a verdict about which side of the #4 ownership boundary/);
  });

  it("keeps no ownership signal in the catalogue", () => {
    // The tempting entries are "does not implement an application-owned concern"
    // and "implements a Forguncy-owned capability". Both are conclusions of #4's
    // capability-ownership decision, and neither is observable in a manifest or a
    // registry entry, so neither may appear here as a signal.
    for (const signal of SELECTION_SIGNALS) {
      expect(signal.id, signal.id).not.toMatch(/ownership|application-owned/);
      expect(signal.summary, signal.id).not.toMatch(/Forguncy-owned/);
    }
  });

  it("routes the ownership question to the #4 role assessment instead", () => {
    // The answer the catalogue refuses to give is available from the module that
    // owns it, which is where the flow's first stage has to get it.
    const assessment = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
    expect(isPlatformConflict(assessment)).toBe(true);
    if (isPlatformConflict(assessment)) {
      expect(assessment.rejection.kind).toBe("architectural");
      expect(assessment.rejection.code).toBe("application-router-conflict");
    }

    // And the same package in a cell-local role is *not* a dependency signal either
    // way — it is an assessment result with its own status.
    expect(assessDependencyRole({ packageName: "zustand", role: "cell-local-state" }).status).toBe("allowed");
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
      "browser-runtime-observation",
      "target-runtime-observation",
    ]);
    for (const signal of SELECTION_SIGNALS) {
      expect(SIGNAL_OBSERVATION_CHANNELS, signal.id).toContain(signal.observedFrom);
    }
  });

  it("separates a plain browser observation from a target-runtime one", () => {
    // They have different evidence lifetimes: a Playwright fixture says nothing about
    // Forguncy, whereas "the host global has the wrong identity" only makes sense
    // against a named target. Collapsing them forced #17 either to drop real browser
    // risks or to attach a Forguncy target to a fixture it never ran against.
    expect(selectionSignalFamilyOf("portal-to-document-body")).toBe("risk");
    expect(selectionSignal("portal-to-document-body").observedFrom).toBe("browser-runtime-observation");
    expect(selectionSignal("webgl-canvas-lifecycle").observedFrom).toBe("browser-runtime-observation");

    for (const id of [
      "host-module-identity-mismatch-observed",
      "global-namespace-collision-observed",
      "service-worker-or-special-header-requirement",
    ]) {
      expect(selectionSignal(id as never).observedFrom, id).toBe("target-runtime-observation");
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
    expect(selectionSignalsObservedFrom("browser-runtime-observation").map(signal => signal.id)).toContain(
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
      expect(entry.kind, entry.signal).toBe("technical");
      expect(isTechnicalRejectionCode(entry.code), entry.signal).toBe(true);
      expect(entry.remediation.length, entry.signal).toBeGreaterThan(0);
    }
  });

  it("can only ever produce a technical rejection", () => {
    // An architectural rejection says the *capability* belongs to Forguncy, which is
    // established by the role assessment, not by looking at an artifact. So nothing
    // observable here may claim to produce one — otherwise a build log would be
    // reporting an ownership decision.
    for (const entry of REPLACEMENT_SIGNAL_REJECTIONS) {
      expect(entry.kind, entry.signal).toBe("technical");
    }
    expect(replacementRejectionFor("node-filesystem-process-or-native-addon", "node-fetch")?.code).toBe(
      "platform-api-unavailable",
    );
    expect(replacementRejectionFor("cell-artifact-budget-exceeded", "heavy-viewer")?.code).toBe(
      "cell-code-budget-exceeded",
    );
  });

  it("gives every technical rejection code an evidence path", () => {
    // The audit binds a recorded code to the codes the observed findings map to, so a
    // code with no signal here would make a rejection #4 treats as legal permanently
    // unrepresentable.
    const covered = new Set(REPLACEMENT_SIGNAL_REJECTIONS.map(entry => entry.code));
    for (const code of TECHNICAL_REJECTION_CODES) {
      expect(covered.has(code), `${code} has no replacement signal`).toBe(true);
    }
  });

  it("agrees with #8 about which codes only a target runtime can confirm", () => {
    // A runtime-confirmed code means "only the target host can tell", so its evidence
    // has to come from a target-runtime observation and owes a target; anything a
    // browser fixture or a static scan can decide must not claim one, or the record
    // would name a target it never saw. The two contracts are held in step by
    // construction rather than by review.
    for (const entry of REPLACEMENT_SIGNAL_REJECTIONS) {
      const channel = selectionSignal(entry.signal).observedFrom;
      const runtimeConfirmed = RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES.includes(entry.code);
      expect(channel === "target-runtime-observation", `${entry.signal} -> ${entry.code}`).toBe(runtimeConfirmed);
    }

    // And the platform/API and no-browser-build failures are separate reasons, because
    // their upgrade diagnoses differ.
    expect(REPLACEMENT_SIGNAL_REJECTIONS.filter(entry => entry.code === "platform-api-unavailable")).toHaveLength(1);
    expect(REPLACEMENT_SIGNAL_REJECTIONS.filter(entry => entry.code === "browser-build-unavailable")).toHaveLength(1);
    expect(
      replacementRejectionFor("ssr-or-server-only-without-browser-build", "some-ssr-lib")?.code,
    ).toBe("browser-build-unavailable");
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
