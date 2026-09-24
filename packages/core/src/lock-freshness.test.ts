import { describe, expect, it } from "vitest";

import type { LockEnvironment, LockedDependencyDecision } from "./index.ts";
import {
  assessLockDecision,
  findLockDecision,
  forguncyTargetIdentity,
  LOCK_STALENESS_REASONS,
  lockDecisionBlockers,
  lockEvidenceProfileOf,
  requiresRuntimeValidation,
  resolveLockDecision,
  RUNTIME_CONTRACT_TARGET,
} from "./index.ts";

const SPEC_4 = "https://github.com/Mang-X/forguncy-react-workspace/issues/4";
const SPEC_8 = "https://github.com/Mang-X/forguncy-react-workspace/issues/8";
const SPEC_9 = "https://github.com/Mang-X/forguncy-react-workspace/issues/9";
const SPEC_12 = "https://github.com/Mang-X/forguncy-react-workspace/issues/12";

// A fingerprint covers only the probe inputs no other field models — the entry,
// the probe id, the probe configuration. The version, target and toolchain are
// recorded separately, so a real recomputation after any of them moves leaves
// this value unchanged and the change is reported once, by its own reason.
const CELL_FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";
const BUNDLER_FINGERPRINT = "probe=amd-detect;entry=src/cells/orders-table/App.tsx";
const EXTENSION_IDENTITY = "sha256:9f1c2b7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091";

/** What a record stores: the identity derived from the verified contract. */
const RECORD_TARGET = forguncyTargetIdentity();

/** The same product one build later, so a runtime change is detectable. */
function futureTarget() {
  return {
    ...RUNTIME_CONTRACT_TARGET,
    productVersion: "12.0.200.0",
    productBuild: "12.0.200.0+2f7c19aa",
  };
}

/** The default: every current input agrees with the records below. */
function lockEnvironment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    resolvedVersions: {
      "@tanstack/react-query": "5.90.2",
      "es-toolkit": "1.39.8",
      react: "19.2.7",
      "some-amd-package": "2.4.0",
    },
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: { vitePlus: "0.3.2" },
    probeFingerprints: { "@tanstack/react-query": CELL_FINGERPRINT, "es-toolkit": CELL_FINGERPRINT, react: CELL_FINGERPRINT, "some-amd-package": BUNDLER_FINGERPRINT },
    extensionVersions: { "tanstack-query": "5.90.2" },
    extensionIdentities: { "tanstack-query": EXTENSION_IDENTITY },
    ...overrides,
  };
}

/** An environment that knows nothing beyond the package versions. */
function bareEnvironment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    resolvedVersions: {},
    target: null,
    toolchain: null,
    probeFingerprints: {},
    extensionVersions: {},
    extensionIdentities: {},
    ...overrides,
  };
}

const inlineRecord: LockedDependencyDecision = {
  strategy: "inline",
  packageName: "es-toolkit",
  cellTarget: null,
  resolvedVersion: "1.39.8",
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: RECORD_TARGET,
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [
    { kind: "spec-issue", reference: SPEC_8 },
    { kind: "probe", reference: "docs/probes/inline-es-toolkit.md" },
  ],
};

const hostRecord: LockedDependencyDecision = {
  strategy: "host",
  packageName: "react",
  globalName: "React",
  cellTarget: null,
  resolvedVersion: "19.2.7",
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: RECORD_TARGET,
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [
    { kind: "spec-issue", reference: SPEC_9 },
    { kind: "runtime-observation", reference: "docs/probes/host-react.md" },
  ],
};

const extensionRecord: LockedDependencyDecision = {
  strategy: "extension",
  packageName: "@tanstack/react-query",
  libraryId: "tanstack-query",
  globalName: "TanStackQuery",
  cellTarget: null,
  resolvedVersion: "5.90.2",
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: RECORD_TARGET,
  probedWith: { vitePlus: "0.3.2" },
  extension: { version: "5.90.2", identity: EXTENSION_IDENTITY },
  rejectedCandidate: null,
  rationale: "A bundled copy would give every cell its own query cache, so the shared extension global is required.",
  evidence: [
    { kind: "spec-issue", reference: SPEC_12 },
    { kind: "runtime-observation", reference: "docs/probes/extension-tanstack-query.md" },
  ],
};

const architecturalRejection: LockedDependencyDecision = {
  strategy: "replace",
  packageName: "react-router-dom",
  rejection: {
    kind: "architectural",
    code: "application-router-conflict",
    summary: "Requested as the application router for the whole page.",
    remediation: "Keep routing in Forguncy and let the cell render the view for the current route.",
  },
  cellTarget: null,
  resolvedVersion: null,
  probe: { status: "not-run", fingerprint: null, versionIndependent: false },
  target: null,
  probedWith: null,
  extension: null,
  rejectedCandidate: null,
  rationale: "Routing is application-owned; the cell renders a route, it does not own the router.",
  evidence: [{ kind: "spec-issue", reference: SPEC_4 }],
};

const technicalRejection: LockedDependencyDecision = {
  strategy: "replace",
  packageName: "some-amd-package",
  rejection: {
    kind: "technical",
    code: "amd-umd-branch-mismatch",
    summary: "The published entry resolves to an AMD branch the cell bundler cannot rewrite.",
    remediation: "Evaluate a browser-first ESM alternative with the same capability.",
  },
  alternatives: ["browser-first-alternative"],
  supersededBy: "inline",
  cellTarget: null,
  resolvedVersion: null,
  probe: { status: "failed", fingerprint: BUNDLER_FINGERPRINT, versionIndependent: false },
  target: RECORD_TARGET,
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: { version: "2.4.0" },
  rationale: "The failure is a property of this published artifact, so the candidate version is recorded to re-open the decision on upgrade.",
  evidence: [
    { kind: "probe", reference: "docs/probes/technical-some-amd-package.md" },
    { kind: "spec-issue", reference: SPEC_8 },
  ],
};

const lock = {
  schemaVersion: 1,
  decisions: [extensionRecord, inlineRecord, hostRecord, architecturalRejection, technicalRejection],
};

function reasonsFor(record: LockedDependencyDecision, environment: LockEnvironment) {
  return assessLockDecision(record, environment);
}

describe("freshness and runtime validation are separate questions", () => {
  it("verifies a resolved dependency that is fresh and runtime-validated", () => {
    for (const record of [inlineRecord, hostRecord, extensionRecord]) {
      const resolution = resolveLockDecision(lock, { packageName: record.packageName }, lockEnvironment());

      expect(resolution.state, record.packageName).toBe("verified");
      expect(resolution.assessment?.freshness, record.packageName).toBe("fresh");
      expect(resolution.assessment?.realRuntimeValidation, record.packageName).toBe("validated");
    }
  });

  // The first draft let `inline` + no target report as verified, which
  // contradicted #4: `strategy.ts` requires a real-runtime check for every
  // strategy, so local evidence alone is never runtime compatibility.
  it("keeps a locally probed inline record fresh but not verified", () => {
    const locallyProbed: LockedDependencyDecision = { ...inlineRecord, target: null };
    const assessment = reasonsFor(locallyProbed, lockEnvironment({ resolvedVersions: { "es-toolkit": "1.39.8" } }));

    expect(assessment.freshness).toBe("fresh");
    expect(assessment.stalenessReasons).toEqual([]);
    expect(assessment.realRuntimeValidation).toBe("not-validated");
    expect(lockDecisionBlockers(assessment)).toEqual(["real-runtime-not-validated"]);
    expect(resolveLockDecision({ decisions: [locallyProbed] }, { packageName: "es-toolkit" }, lockEnvironment()).state).toBe(
      "stale",
    );
  });

  it("does not require a runtime check where the profile compiles nothing", () => {
    expect(reasonsFor(architecturalRejection, bareEnvironment()).realRuntimeValidation).toBe("not-required");
    expect(reasonsFor(technicalRejection, bareEnvironment()).realRuntimeValidation).toBe("not-required");
  });
});

describe("staleness: recorded inputs versus current inputs", () => {
  it("invalidates technical probe evidence on an exact package upgrade", () => {
    const assessment = reasonsFor(inlineRecord, lockEnvironment({ resolvedVersions: { "es-toolkit": "1.40.0" } }));

    expect(assessment.freshness).toBe("stale");
    expect(assessment.stalenessReasons).toEqual(["package-version-changed"]);
  });

  it("keeps a probe that was explicitly proven version-independent", () => {
    const independent: LockedDependencyDecision = {
      ...inlineRecord,
      probe: { ...inlineRecord.probe, versionIndependent: true },
    };

    expect(reasonsFor(independent, lockEnvironment({ resolvedVersions: { "es-toolkit": "1.40.0" } })).freshness).toBe("fresh");
  });

  // The flag only means anything if this holds: a fingerprint that carried the
  // version would move on an upgrade the flag permits, so the record would go
  // stale anyway and `versionIndependent` would be decoration.
  it("lets versionIndependent survive a real fingerprint recomputation", () => {
    const independent: LockedDependencyDecision = {
      ...inlineRecord,
      probe: { ...inlineRecord.probe, versionIndependent: true },
    };
    const upgraded = lockEnvironment({
      resolvedVersions: { "es-toolkit": "1.40.0" },
      // Recomputed from the inputs a fingerprint covers: the entry and probe id
      // have not changed, so the value does not either.
      probeFingerprints: { "es-toolkit": CELL_FINGERPRINT },
    });

    expect(reasonsFor(independent, upgraded).stalenessReasons).toEqual([]);
    expect(reasonsFor(inlineRecord, upgraded).stalenessReasons).toEqual(["package-version-changed"]);
  });

  // Each separately modelled input reports once. Double counting would be the
  // symptom of a fingerprint that repeats what the record already carries.
  it("reports a changed input in the vocabulary of that input, exactly once", () => {
    expect(reasonsFor(inlineRecord, lockEnvironment({ resolvedVersions: { "es-toolkit": "1.40.0" } })).stalenessReasons).toEqual([
      "package-version-changed",
    ]);
    expect(reasonsFor(inlineRecord, lockEnvironment({ target: futureTarget() })).stalenessReasons).toEqual([
      "forguncy-target-changed",
    ]);
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: { vitePlus: "0.4.0" } })).stalenessReasons).toEqual([
      "toolchain-changed",
    ]);
    expect(
      reasonsFor(inlineRecord, lockEnvironment({ probeFingerprints: { "es-toolkit": "probe=inline-bundle;entry=src/other/App.tsx" } }))
        .stalenessReasons,
    ).toEqual(["probe-fingerprint-changed"]);
  });

  it("cannot verify a package whose installed version is unknown", () => {
    expect(reasonsFor(inlineRecord, lockEnvironment({ resolvedVersions: {} })).stalenessReasons).toEqual([
      "package-version-unknown",
    ]);
  });

  // Without this, an entry or probe-configuration change is invisible as long as
  // every version in the record still matches.
  it("invalidates a probe whose declared inputs moved", () => {
    const assessment = reasonsFor(
      inlineRecord,
      lockEnvironment({ probeFingerprints: { "es-toolkit": "probe=inline-bundle;entry=src/cells/other/App.tsx" } }),
    );

    expect(assessment.stalenessReasons).toEqual(["probe-fingerprint-changed"]);
  });

  it("cannot verify a probe whose current inputs are unknown", () => {
    expect(reasonsFor(inlineRecord, lockEnvironment({ probeFingerprints: {} })).stalenessReasons).toEqual([
      "probe-fingerprint-unknown",
    ]);
  });

  it("invalidates runtime-sensitive evidence when the Forguncy target changes", () => {
    const upgraded = lockEnvironment({ target: futureTarget() });

    for (const record of [inlineRecord, hostRecord, extensionRecord, technicalRejection]) {
      const assessment = reasonsFor(record, upgraded);

      expect(assessment.stalenessReasons, record.packageName).toEqual(["forguncy-target-changed"]);
    }
  });

  it("cannot verify against a target it cannot see", () => {
    expect(reasonsFor(inlineRecord, lockEnvironment({ target: null })).stalenessReasons).toEqual([
      "forguncy-target-unknown",
    ]);
    expect(reasonsFor(technicalRejection, lockEnvironment({ target: null })).stalenessReasons).toEqual([
      "forguncy-target-unknown",
    ]);
  });

  it("never invalidates an architectural rejection on a runtime change", () => {
    // The capability belongs to Forguncy whatever the product build is, so the
    // ownership decision survives the upgrade — and a lock that knows nothing
    // else about the project can still verify it.
    expect(reasonsFor(architecturalRejection, lockEnvironment({ target: futureTarget() })).freshness).toBe("fresh");
    expect(reasonsFor(architecturalRejection, bareEnvironment()).freshness).toBe("fresh");
    expect(
      resolveLockDecision(lock, { packageName: "react-router-dom" }, lockEnvironment({ target: futureTarget() })).state,
    ).toBe("verified");
  });

  it("invalidates evidence when the toolchain that produced it moves", () => {
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: { vitePlus: "0.4.0" } })).stalenessReasons).toEqual([
      "toolchain-changed",
    ]);
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: null })).stalenessReasons).toEqual(["toolchain-unknown"]);
    // A bundling failure is a property of the bundler, so a technical rejection
    // is re-opened by a toolchain move as well.
    expect(
      reasonsFor(technicalRejection, lockEnvironment({ toolchain: { vitePlus: "0.4.0" } })).stalenessReasons,
    ).toEqual(["toolchain-changed"]);
  });

  it("keeps the toolchain comparison honest when its version is declared immaterial", () => {
    // #8 records the toolchain "when material": a null version says the upgrade
    // cannot matter for this probe, so there is nothing to compare against.
    const immaterial: LockedDependencyDecision = { ...inlineRecord, probedWith: { vitePlus: null } };

    expect(reasonsFor(immaterial, lockEnvironment()).freshness).toBe("fresh");
    expect(reasonsFor(immaterial, lockEnvironment({ toolchain: { vitePlus: "9.9.9" } })).freshness).toBe("fresh");
  });

  it("re-checks an extension record that records only a content identity", () => {
    const identityOnly: LockedDependencyDecision = {
      ...extensionRecord,
      extension: { version: null, identity: EXTENSION_IDENTITY },
    };
    const withIdentityOnly = (identity: string) =>
      lockEnvironment({ extensionVersions: {}, extensionIdentities: { "tanstack-query": identity } });

    expect(reasonsFor(identityOnly, withIdentityOnly(EXTENSION_IDENTITY)).stalenessReasons).toEqual([]);
    expect(reasonsFor(identityOnly, withIdentityOnly("sha256:other")).stalenessReasons).toEqual([
      "extension-identity-changed",
    ]);
    // A version-only record is checkable the same way, so neither half being
    // known is allowed to slip through.
    expect(reasonsFor(extensionRecord, lockEnvironment({ extensionIdentities: {} })).stalenessReasons).toEqual([
      "extension-identity-unknown",
    ]);
  });

  it("invalidates an extension record when either half of its identity moves", () => {
    expect(
      reasonsFor(extensionRecord, lockEnvironment({ extensionVersions: { "tanstack-query": "5.91.0" } })).stalenessReasons,
    ).toEqual(["extension-version-changed"]);

    expect(
      reasonsFor(extensionRecord, lockEnvironment({ extensionIdentities: { "tanstack-query": "sha256:other" } }))
        .stalenessReasons,
    ).toEqual(["extension-identity-changed"]);
  });

  it("cannot verify an extension whose current identity is unknown", () => {
    const assessment = reasonsFor(extensionRecord, lockEnvironment({ extensionVersions: {}, extensionIdentities: {} }));

    expect(assessment.stalenessReasons).toEqual(["extension-version-unknown", "extension-identity-unknown"]);
  });

  it("reports a never-probed or failed probe as stale rather than verified", () => {
    const notRun: LockedDependencyDecision = {
      ...inlineRecord,
      probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      target: null,
      probedWith: null,
    };
    const failed: LockedDependencyDecision = { ...inlineRecord, probe: { ...inlineRecord.probe, status: "failed" } };

    expect(reasonsFor(notRun, lockEnvironment()).stalenessReasons).toEqual(["probe-never-run"]);
    expect(reasonsFor(failed, lockEnvironment()).stalenessReasons).toEqual(["probe-failed"]);
  });

  it("names every reason it found, not just the first", () => {
    const assessment = reasonsFor(
      inlineRecord,
      lockEnvironment({ resolvedVersions: { "es-toolkit": "1.40.0" }, toolchain: { vitePlus: "0.4.0" } }),
    );

    expect(assessment.stalenessReasons).toEqual(["package-version-changed", "toolchain-changed"]);
  });
});

describe("replace decisions expire differently by rejection kind", () => {
  it("re-opens a technical rejection when the rejected candidate moves", () => {
    const assessment = reasonsFor(technicalRejection, lockEnvironment({ resolvedVersions: { "some-amd-package": "2.5.0" } }));

    expect(assessment.freshness).toBe("stale");
    expect(assessment.stalenessReasons).toEqual(["rejected-candidate-version-changed"]);
  });

  it("keeps a technical rejection usable while its evidence still holds", () => {
    const resolution = resolveLockDecision(lock, { packageName: "some-amd-package" }, lockEnvironment());

    expect(resolution.state).toBe("verified");
    expect(resolution.assessment?.profile).toBe("technical-rejection");
    // A failed probe is the evidence here, so it must not read as staleness.
    expect(resolution.assessment?.stalenessReasons).toEqual([]);
  });

  it("still re-checks a technical rejection whose failure was never measured", () => {
    const unmeasured: LockedDependencyDecision = {
      ...technicalRejection,
      probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      target: null,
      probedWith: null,
      rejectedCandidate: { version: "2.4.0" },
    };

    expect(reasonsFor(unmeasured, lockEnvironment()).stalenessReasons).toEqual(["probe-never-run"]);
  });

  it("cannot verify a technical rejection from an environment that knows nothing", () => {
    // Fail-closed: the record observed a candidate under a target and a
    // toolchain, so an environment that cannot supply any of them has not shown
    // the rejection still holds.
    expect(reasonsFor(technicalRejection, bareEnvironment()).stalenessReasons).toEqual([
      "probe-fingerprint-unknown",
      "package-version-unknown",
      "forguncy-target-unknown",
      "toolchain-unknown",
    ]);
  });
});

describe("decision lookup", () => {
  it("reports a package with no decision as missing, with nothing to assess", () => {
    const resolution = resolveLockDecision(lock, { packageName: "lodash-es" }, lockEnvironment());

    expect(resolution.state).toBe("missing");
    expect(resolution.record).toBeNull();
    expect(resolution.assessment).toBeNull();
  });

  it("prefers a decision declared for the cell target over the target-independent one", () => {
    const perTarget = {
      schemaVersion: 1,
      decisions: [
        inlineRecord,
        { ...hostRecord, packageName: "es-toolkit", globalName: "EsToolkit", cellTarget: "orders-table" },
      ],
    };

    expect(findLockDecision(perTarget, { packageName: "es-toolkit", cellTarget: "orders-table" })?.strategy).toBe("host");
    expect(findLockDecision(perTarget, { packageName: "es-toolkit", cellTarget: null })?.strategy).toBe("inline");
    // An unlisted target falls back to the target-independent record.
    expect(findLockDecision(perTarget, { packageName: "es-toolkit", cellTarget: "customers" })?.strategy).toBe("inline");
    expect(findLockDecision(perTarget, { packageName: "es-toolkit" })?.strategy).toBe("inline");
  });

  it("keeps the reason vocabulary closed and the profiles aligned", () => {
    expect([...LOCK_STALENESS_REASONS]).toHaveLength(new Set(LOCK_STALENESS_REASONS).size);
    expect(lockEvidenceProfileOf(inlineRecord)).toBe("resolved-dependency");
    expect(requiresRuntimeValidation(inlineRecord)).toBe(true);
    expect(requiresRuntimeValidation(architecturalRejection)).toBe(false);
  });
});
