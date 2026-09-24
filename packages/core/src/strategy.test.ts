import { describe, expect, it } from "vitest";

import type { DependencyDecision, DependencyRejection, DependencyStrategy } from "./index.ts";
import {
  assertDependencyDecision,
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_STRATEGY_SEMANTICS,
  isDependencyStrategy,
  requiresRealRuntimeValidation,
  strategySemantics,
  validateDependencyDecision,
  validateDependencyDecisionShape,
  validateDependencyVerification,
} from "./index.ts";

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

  const verified = { realRuntimeValidated: true } as const;
  const unverified = { realRuntimeValidated: false } as const;

  it("accepts well-formed decisions", () => {
    expect(validateDependencyDecision(inline, verified)).toEqual([]);
    expect(validateDependencyDecision(host, verified)).toEqual([]);
    expect(validateDependencyDecision(replaceTechnical, verified)).toEqual([]);
    expect(validateDependencyDecision(replaceArchitectural, verified)).toEqual([]);
    expect(() => assertDependencyDecision(inline, verified)).not.toThrow();
  });

  it("demands an evaluated alternative before a technical rejection becomes a repair", () => {
    const problems = validateDependencyDecision(
      {
        strategy: "replace",
        packageName: "heavy-chart-lib",
        rejection: technicalRejection,
      },
      verified,
    );
    expect(problems.join(" ")).toMatch(/at least one evaluated alternative/);
  });

  it("refuses a package alternative list for an architectural rejection", () => {
    const problems = validateDependencyDecision(
      {
        strategy: "replace",
        packageName: "react-router-dom",
        rejection: architecturalRejection,
        alternatives: ["wouter"],
      },
      verified,
    );
    expect(problems.join(" ")).toMatch(/ownership conflict/);
  });

  it("refuses to supersede an architectural rejection with another strategy", () => {
    const problems = validateDependencyDecision(
      {
        strategy: "replace",
        packageName: "react-router-dom",
        rejection: architecturalRejection,
        supersededBy: "inline",
      },
      verified,
    );
    expect(problems.join(" ")).toMatch(/cannot be superseded/);
  });

  // Shape and verification are separate questions, and the API must not let a
  // caller confuse "well formed" with "verified".
  describe("shape versus runtime verification", () => {
    it("reports shape problems without claiming anything about verification", () => {
      const problems = validateDependencyDecisionShape({ strategy: "inline", packageName: "  " });

      expect(problems.join(" ")).toMatch(/must name the package/);
      expect(problems.join(" ")).not.toMatch(/verified/);
    });

    it("reports no shape problem for a decision that is merely unverified", () => {
      expect(validateDependencyDecisionShape(inline)).toEqual([]);
      expect(validateDependencyVerification(inline, unverified).join(" ")).toMatch(/requires real-runtime validation/);
    });

    it("applies the runtime-evidence requirement to every strategy, not only extension", () => {
      for (const strategy of DEPENDENCY_STRATEGIES) {
        expect(requiresRealRuntimeValidation(strategy), strategy).toBe(true);
        const decision: DependencyDecision =
          strategy === "host"
            ? host
            : strategy === "extension"
              ? extension
              : strategy === "replace"
                ? replaceTechnical
                : inline;

        expect(validateDependencyVerification(decision, unverified).length, strategy).toBeGreaterThan(0);
        expect(validateDependencyVerification(decision, verified), strategy).toEqual([]);
      }
    });

    it("keeps a host decision unverified until its global is confirmed in a real runtime", () => {
      // The previous behaviour only gated `extension`, which contradicted
      // `host` semantics declaring realRuntimeRequired: true.
      expect(validateDependencyDecision(host, unverified).join(" ")).toMatch(/"react" cannot be reported as verified/);
      expect(validateDependencyDecision(extension, unverified).join(" ")).toMatch(/real Forguncy project/);
    });

    it("reports shape and verification problems together, and throws on both", () => {
      const problems = validateDependencyDecision({ strategy: "extension", packageName: "apollo", libraryId: "", globalName: "" }, unverified);

      expect(problems.join(" ")).toMatch(/library id and the global/);
      expect(problems.join(" ")).toMatch(/cannot be reported as verified/);
      expect(() =>
        assertDependencyDecision({ strategy: "extension", packageName: "apollo", libraryId: "", globalName: "" }, unverified),
      ).toThrow(/Invalid dependency decision for "apollo"/);
    });
  });

  it("rejects incomplete decisions", () => {
    expect(validateDependencyDecisionShape({ strategy: "host", packageName: "react", globalName: "" }).join(" ")).toMatch(
      /host global/,
    );
    expect(validateDependencyDecisionShape({ strategy: "inline", packageName: "  " }).join(" ")).toMatch(
      /must name the package/,
    );
  });

  it("types the strategy set as a closed union", () => {
    const allowed: readonly DependencyStrategy[] = ["host", "inline", "extension", "replace"];
    expect(allowed).toHaveLength(4);
  });
});
