import { describe, expect, it } from "vitest";

import type { DependencyDecision, DependencyRejection, DependencyStrategy } from "./index";
import {
  assertDependencyDecision,
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_STRATEGY_SEMANTICS,
  isDependencyStrategy,
  requiresRealRuntimeValidation,
  strategySemantics,
  validateDependencyDecision,
} from "./index";

const technicalRejection: DependencyRejection = {
  kind: "technical",
  code: "non-inlineable-asset",
  summary: "The package requires a sibling worker file that cannot be inlined.",
  remediation: "Prefer a browser-first alternative without a worker.",
};

const architecturalRejection: DependencyRejection = {
  kind: "architectural",
  code: "application-state-conflict",
  summary: "Requested as the application-wide business store.",
  remediation: "Move the state to the Forguncy page or keep it cell-local.",
};

describe("dependency strategy semantics", () => {
  it("covers exactly the four strategies named by Issue #4", () => {
    expect([...DEPENDENCY_STRATEGIES]).toEqual(["host", "inline", "extension", "replace"]);
    for (const strategy of DEPENDENCY_STRATEGIES) {
      expect(DEPENDENCY_STRATEGY_SEMANTICS[strategy].strategy).toBe(strategy);
    }
    expect(isDependencyStrategy("inline")).toBe(true);
    expect(isDependencyStrategy("bundle")).toBe(false);
  });

  it("gives every strategy a meaning, not just a label", () => {
    for (const strategy of DEPENDENCY_STRATEGIES) {
      const semantics = strategySemantics(strategy);
      expect(semantics.effect.trim().length, strategy).toBeGreaterThan(0);
      expect(semantics.decides.trim().length, strategy).toBeGreaterThan(0);
      expect(semantics.requirements.length, strategy).toBeGreaterThan(0);
      expect(semantics.selectedWhen.length, strategy).toBeGreaterThan(0);
      expect(semantics.checks.length, strategy).toBeGreaterThan(0);
    }
  });

  it("marks `inline` as the default and nothing else", () => {
    const defaults = DEPENDENCY_STRATEGIES.filter(s => strategySemantics(s).isDefaultForCompatibleLibraries);
    expect(defaults).toEqual(["inline"]);
  });

  it("requires justification for `extension` and `replace`", () => {
    expect(strategySemantics("extension").requiresJustification).toBe(true);
    expect(strategySemantics("replace").requiresJustification).toBe(true);
    expect(strategySemantics("inline").requiresJustification).toBe(false);
    expect(strategySemantics("host").requiresJustification).toBe(false);
  });

  it("only `extension` depends on a verified host capability", () => {
    expect(strategySemantics("extension").requiresVerifiedHostCapability).toBe(true);
    for (const strategy of ["host", "inline", "replace"] as const) {
      expect(strategySemantics(strategy).requiresVerifiedHostCapability, strategy).toBe(false);
    }
  });

  it("never lets a local check alone confirm any strategy", () => {
    for (const strategy of DEPENDENCY_STRATEGIES) {
      expect(requiresRealRuntimeValidation(strategy), strategy).toBe(true);
      expect(checksForLevel(strategy, "real-runtime").length, strategy).toBeGreaterThan(0);
      expect(checksForLevel(strategy, "local").length, strategy).toBeGreaterThan(0);
      expect(checksForLevel(strategy, "local").every(check => check.level === "local"), strategy).toBe(true);
    }
  });
});

describe("dependency decision validation", () => {
  const inline: DependencyDecision = { strategy: "inline", packageName: "es-toolkit" };
  const host: DependencyDecision = { strategy: "host", packageName: "react", globalName: "React" };
  const extension: DependencyDecision = {
    strategy: "extension",
    packageName: "@tanstack/react-query",
    libraryId: "tanstack-query",
    globalName: "TanStackQuery",
  };
  const replaceTechnical: DependencyDecision = {
    strategy: "replace",
    packageName: "heavy-chart-lib",
    rejection: technicalRejection,
    alternatives: ["lightweight-charts"],
    supersededBy: "inline",
  };
  const replaceArchitectural: DependencyDecision = {
    strategy: "replace",
    packageName: "react-router-dom",
    rejection: architecturalRejection,
  };

  it("accepts well-formed decisions", () => {
    expect(validateDependencyDecision(inline)).toEqual([]);
    expect(validateDependencyDecision(host)).toEqual([]);
    expect(validateDependencyDecision(replaceTechnical)).toEqual([]);
    expect(validateDependencyDecision(replaceArchitectural)).toEqual([]);
    expect(() => assertDependencyDecision(inline)).not.toThrow();
  });

  it("demands an evaluated alternative before a technical rejection becomes a repair", () => {
    const problems = validateDependencyDecision({
      strategy: "replace",
      packageName: "heavy-chart-lib",
      rejection: technicalRejection,
    });
    expect(problems.join(" ")).toMatch(/at least one evaluated alternative/);
  });

  it("refuses a package alternative list for an architectural rejection", () => {
    const problems = validateDependencyDecision({
      strategy: "replace",
      packageName: "react-router-dom",
      rejection: architecturalRejection,
      alternatives: ["wouter"],
    });
    expect(problems.join(" ")).toMatch(/ownership conflict/);
  });

  it("refuses to supersede an architectural rejection with another strategy", () => {
    const problems = validateDependencyDecision({
      strategy: "replace",
      packageName: "react-router-dom",
      rejection: architecturalRejection,
      supersededBy: "inline",
    });
    expect(problems.join(" ")).toMatch(/cannot be superseded/);
  });

  it("treats an extension as unverified until a real runtime confirms it", () => {
    expect(validateDependencyDecision(extension).join(" ")).toMatch(/real Forguncy project/);
    expect(validateDependencyDecision(extension, { realRuntimeValidated: true })).toEqual([]);
  });

  it("rejects incomplete decisions", () => {
    expect(
      validateDependencyDecision({ strategy: "host", packageName: "react", globalName: "" }).join(" "),
    ).toMatch(/host global/);
    expect(validateDependencyDecision({ strategy: "inline", packageName: "  " }).join(" ")).toMatch(/must name the package/);
  });

  it("throws a message naming the package and every problem", () => {
    expect(() =>
      assertDependencyDecision({ strategy: "extension", packageName: "apollo", libraryId: "", globalName: "" }),
    ).toThrow(/Invalid dependency decision for "apollo"/);
  });

  it("types the strategy set as a closed union", () => {
    const allowed: readonly DependencyStrategy[] = ["host", "inline", "extension", "replace"];
    expect(allowed).toHaveLength(4);
  });
});
