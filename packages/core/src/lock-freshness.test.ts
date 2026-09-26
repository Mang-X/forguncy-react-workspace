import { describe, expect, it } from "vitest";

import { parseFgcLockDocument } from "./index.ts";
import type {
  ArtifactBudgetEvidence,
  ArtifactCompileSnapshot,
  InstallGraphIdentity,
  LockEnvironment,
  LockedDependencyDecision,
  ToolchainIdentity,
} from "./index.ts";
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

/**
 * The toolchain every fixture record and environment shares, so the axes compare *equal* and each
 * case asserts the one input it is about.
 *
 * A shared constant rather than a literal at each site, and that is the point of it existing: a
 * record and an environment that spelled the same identity two different ways would report
 * `toolchain-changed`/`install-graph-changed` on a fixture that means "these agree", and the case
 * under test would pass or fail for a reason it does not name. Every component #94 added is
 * present, because an *absent* one is `unknown` and therefore stale by design.
 */
const FIXTURE_TOOLCHAIN = {
  vitePlus: "0.3.2",
  rolldown: "1.2.9",
  node: "24.21.0",
  installGraph: {
    lockfile: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    patches: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    configuration: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  },
} as const;

/**
 * The same identity with one component replaced, for the cases that move it deliberately.
 *
 * Typed as `ToolchainIdentity` rather than inferred, because the returned object is what a
 * `LockEnvironment` holds: an inferred type would let a caller pass a shape the production type
 * rejects, which is the drift this fixture exists to avoid.
 */
function toolchainWith(overrides: {
  readonly vitePlus?: string | null;
  readonly rolldown?: string | null;
  readonly node?: string | null;
  readonly installGraph?: Partial<InstallGraphIdentity> | null;
}): ToolchainIdentity {
  // `installGraph` is destructured out of the spread rather than left in it: spreading the override
  // object would widen the property to `Partial<…> | null`, which is not what a
  // `ToolchainIdentity` holds, and the whole point of this helper is to hand back that type.
  const { installGraph, ...rest } = overrides;
  return {
    ...FIXTURE_TOOLCHAIN,
    ...rest,
    ...(installGraph === undefined || installGraph === null
      ? { installGraph: installGraph === null ? null : FIXTURE_TOOLCHAIN.installGraph }
      : { installGraph: { ...FIXTURE_TOOLCHAIN.installGraph, ...installGraph } }),
  };
}

/** The Cell a compile-observed rejection is about, and its compile identity. */
const BENCH_CELL = "bench";
const ARTIFACT_FINGERPRINT = 'cell="abc";budget=100000';

/**
 * Compile evidence for a rejection the compiler confirmed.
 *
 * The shape #77 revision 16 settled: an identity over the composed artifact, the subject's
 * pre-rejection decision, and the two compiles a size verdict has to justify. Defaults describe the
 * state a rejection is allowed to rest on — over cap with the subject, under it without.
 */
/**
 * What the environment knows about one record's compile: the artifact identity and the subject's
 * rendered share. One value, because they describe one compile (#77 revision 17).
 */
function artifactCompile(
  fingerprint: string,
  subjectRenderedCharacters: number,
  overrides: { readonly codeCharacters?: number; readonly budgetCharacters?: number } = {},
): ArtifactCompileSnapshot {
  return {
    fingerprint,
    // The fixture's evidence defaults, so a case that only cares about the identity or the share
    // does not have to restate the verdict numbers.
    codeCharacters: overrides.codeCharacters ?? 200_000,
    budgetCharacters: overrides.budgetCharacters ?? 100_000,
    subjectRenderedCharacters,
  };
}

/** The artifact-axis staleness reasons for a record: what this file's cases assert on. */
function artifactReasons(record: LockedDependencyDecision, environment: LockEnvironment): readonly string[] {
  return reasonsFor(record, environment).stalenessReasons.filter((reason: string) => reason.startsWith("artifact-"));
}

function artifactEvidenceFixture(overrides: {
  readonly subjectRenderedCharacters?: number;
  readonly codeCharacters?: number;
  readonly budgetCharacters?: number;
  readonly compileFingerprint?: string;
} = {}): ArtifactBudgetEvidence {
  return {
    compileFingerprint: overrides.compileFingerprint ?? ARTIFACT_FINGERPRINT,
    subjectDecision: { strategy: "inline" },
    // Over cap with the subject's contribution counted, under it without: the state a rejection is
    // allowed to rest on.
    subjectRenderedCharacters: overrides.subjectRenderedCharacters ?? 190_000,
    codeCharacters: overrides.codeCharacters ?? 200_000,
    budgetCharacters: overrides.budgetCharacters ?? 100_000,
  };
}

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
      "date-fns": "4.1.0",
      "es-toolkit": "1.39.8",
      react: "19.2.7",
      "some-amd-package": "2.4.0",
    },
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: FIXTURE_TOOLCHAIN,
    probeFingerprints: { "@tanstack/react-query": CELL_FINGERPRINT, "date-fns": CELL_FINGERPRINT, "es-toolkit": CELL_FINGERPRINT, react: CELL_FINGERPRINT, "some-amd-package": BUNDLER_FINGERPRINT },
    // Keyed by *record* identity, not by Cell (#77 round 7): two artifact rejections in one
    // Cell may come from different compile states, so the identity must vary on the same key.
    artifactFingerprints: { ["date-fns\u0000" + BENCH_CELL]: artifactCompile(ARTIFACT_FINGERPRINT, 190_000) },
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
  probedWith: FIXTURE_TOOLCHAIN,
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
  probedWith: FIXTURE_TOOLCHAIN,
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
  probedWith: FIXTURE_TOOLCHAIN,
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
  probedWith: FIXTURE_TOOLCHAIN,
  extension: null,
  rejectedCandidate: { version: "2.4.0" },
  rationale: "The failure is a property of this published artifact, so the candidate version is recorded to re-open the decision on upgrade.",
  evidence: [
    { kind: "probe", reference: "docs/probes/technical-some-amd-package.md" },
    { kind: "spec-issue", reference: SPEC_8 },
  ],
};

/**
 * A compile-observed rejection: the package's own probe **passed**, and what failed is the
 * composed Cell (#77 revision 14). Its `artifactEvidence` is the measurement that makes the
 * rejection checkable, and its profile is `artifact-rejection` — the one technical rejection whose
 * evidence is a *passing* probe.
 */
const artifactRejection: LockedDependencyDecision = {
  strategy: "replace",
  packageName: "date-fns",
  rejection: {
    kind: "technical",
    code: "cell-code-budget-exceeded",
    summary: "The composed Cell is 200,000 characters against this Cell's cap of 100,000.",
    remediation: "Evaluate a lighter alternative or raise the Cell's declared cap.",
  },
  artifactEvidence: artifactEvidenceFixture(),
  alternatives: ["a lighter date utility"],
  supersededBy: "host",
  // A concrete Cell: a size verdict belongs to one composed Cell and one Cell's cap, which is why
  // revision 15 requires the target for any record carrying compile evidence.
  cellTarget: BENCH_CELL,
  resolvedVersion: null,
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: RECORD_TARGET,
  probedWith: FIXTURE_TOOLCHAIN,
  extension: null,
  rejectedCandidate: { version: "4.1.0" },
  rationale: "The package builds cleanly; the composed Cell is what exceeds the Cell's declared cap.",
  evidence: [
    { kind: "probe", reference: "docs/probes/inline-es-toolkit.md" },
    { kind: "spec-issue", reference: SPEC_8 },
  ],
};

const lock = {
  schemaVersion: 1,
  decisions: [
    extensionRecord,
    inlineRecord,
    hostRecord,
    architecturalRejection,
    technicalRejection,
    artifactRejection,
  ],
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
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: toolchainWith({ vitePlus: "0.4.0" }) })).stalenessReasons).toEqual([
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
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: toolchainWith({ vitePlus: "0.4.0" }) })).stalenessReasons).toEqual([
      "toolchain-changed",
    ]);
    expect(reasonsFor(inlineRecord, lockEnvironment({ toolchain: null })).stalenessReasons).toEqual(["toolchain-unknown"]);
    // A bundling failure is a property of the bundler, so a technical rejection
    // is re-opened by a toolchain move as well.
    expect(
      reasonsFor(technicalRejection, lockEnvironment({ toolchain: toolchainWith({ vitePlus: "0.4.0" }) })).stalenessReasons,
    ).toEqual(["toolchain-changed"]);
  });

  // #94. The three cases below are the user-visible half of the defect the reproduction in
  // `install-identity.ts` records: a record whose root package version has not moved, while the
  // install graph under it has. Before this axis existed, every one of them reported `fresh`.
  it("invalidates evidence when the install graph moves while every recorded version holds", () => {
    // The lockfile digest is what a transitive bump, an `overrides` entry or a re-resolution moves.
    // `inlineRecord`'s `resolvedVersion` is unchanged in this environment — which is the point: the
    // version the record names cannot see this, so the axis has to.
    expect(
      reasonsFor(inlineRecord, lockEnvironment({ toolchain: toolchainWith({ installGraph: { lockfile: "sha256:9999" } }) }))
        .stalenessReasons,
    ).toEqual(["install-graph-changed"]);
  });

  it("invalidates evidence when the patch set moves under an unchanged lockfile", () => {
    expect(
      reasonsFor(inlineRecord, lockEnvironment({ toolchain: toolchainWith({ installGraph: { patches: "sha256:9999" } }) }))
        .stalenessReasons,
    ).toEqual(["install-graph-changed"]);
  });

  it("invalidates evidence when the configuration that affects resolution moves", () => {
    expect(
      reasonsFor(
        inlineRecord,
        lockEnvironment({ toolchain: toolchainWith({ installGraph: { configuration: "sha256:9999" } }) }),
      ).stalenessReasons,
    ).toEqual(["install-graph-changed"]);
  });

  it("cannot verify a record whose install graph is unknown, and never calls it changed", () => {
    // The distinction #94's acceptance requires: "this process cannot say" is a different answer
    // from "it moved", and rendering the first as the second would claim an observation nobody
    // made. Both are stale, which is the property that matters.
    const unknown = reasonsFor(inlineRecord, lockEnvironment({ toolchain: toolchainWith({ installGraph: null }) }));
    expect(unknown.stalenessReasons).toEqual(["install-graph-unknown"]);
    expect(unknown.freshness).toBe("stale");
    expect(unknown.stalenessReasons).not.toContain("install-graph-changed");
  });

  it("reports a pre-#94 record as unknown rather than letting it pass", () => {
    // A record written before this axis existed carries a `probedWith` with no `installGraph`. The
    // tempting shortcut — treat "the record does not state one" as "this axis does not apply" —
    // is exactly the hole: the lock most likely to need re-measuring would stay fresh forever.
    const legacy: LockedDependencyDecision = { ...inlineRecord, probedWith: { vitePlus: "0.3.2" } };

    const assessment = reasonsFor(legacy, lockEnvironment());

    expect(assessment.stalenessReasons).toEqual(["install-graph-unknown"]);
    expect(assessment.freshness).toBe("stale");
  });

  it("does not demand an install graph from a record that never probed", () => {
    // `probedWith: null` means no probe ran, which `probe-never-run` already reports. Stating this
    // axis too would name one absence twice and send the reader looking for a second problem.
    const neverProbed: LockedDependencyDecision = {
      ...inlineRecord,
      probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      target: null,
      probedWith: null,
    };

    expect(reasonsFor(neverProbed, lockEnvironment()).stalenessReasons).toEqual(["probe-never-run"]);
  });

  it("does not demand one from an architectural rejection, whose evidence is the ownership decision", () => {
    // Read off the policy table rather than special-cased: `probeRequirement: "none"` is the profile
    // whose evidence no version of anything in an install graph can move, which is the same reason
    // `invalidatedByTargetChange` is false for it.
    expect(reasonsFor(architecturalRejection, lockEnvironment()).stalenessReasons).toEqual([]);
  });

  it("calls a partly unobservable install graph unknown, never changed", () => {
    // The case the component-wise loop exists for. A composed digest over `{lockfile, patches:
    // null}` is a *value*, so comparing two of them would report `changed` for a component neither
    // side could read — a staleness claim about an observation nobody made. `unknown` is the
    // honest answer, and it is what makes this loop load-bearing rather than decorative.
    const partly = reasonsFor(
      inlineRecord,
      lockEnvironment({ toolchain: toolchainWith({ installGraph: { patches: null } }) }),
    );

    expect(partly.stalenessReasons).toEqual(["install-graph-unknown"]);
    expect(partly.stalenessReasons).not.toContain("install-graph-changed");
  });

  it("reports one toolchain move once, however many components moved with it", () => {
    // `rolldown` and `node` moving together is one event with one fix, so it is one reason. A
    // per-component push would report the same upgrade three times.
    expect(
      reasonsFor(
        inlineRecord,
        lockEnvironment({ toolchain: toolchainWith({ rolldown: "9.9.9", node: "26" }) }),
      ).stalenessReasons,
    ).toEqual(["toolchain-changed"]);
  });

  it("keeps the toolchain comparison honest when its version is declared immaterial", () => {
    // #8 records the toolchain "when material": a null version says the upgrade
    // cannot matter for this probe, so there is nothing to compare against.
    const immaterial: LockedDependencyDecision = { ...inlineRecord, probedWith: { ...FIXTURE_TOOLCHAIN, vitePlus: null } };

    expect(reasonsFor(immaterial, lockEnvironment()).freshness).toBe("fresh");
    expect(reasonsFor(immaterial, lockEnvironment({ toolchain: toolchainWith({ vitePlus: "9.9.9" }) })).freshness).toBe("fresh");
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
      lockEnvironment({ resolvedVersions: { "es-toolkit": "1.40.0" }, toolchain: toolchainWith({ vitePlus: "0.4.0" }) }),
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

  // PR review of #77, P1 (round 4). Round 3 refused a `cell-code-budget-exceeded` record outright
  // in the *shape* validator, which runs on the parse path — so a schema-v1 lock holding one failed
  // to parse and never reached freshness at all. The record now stays readable and goes **stale**
  // here, which is what the migration contract in `lock-migration.ts` requires and what the
  // revision bump exists to produce.
  it("reports a pre-revision-14 budget rejection as missing its compile evidence, not as invalid", () => {
    // Built by removing the field rather than setting it to `undefined`: an explicit `undefined`
    // would still be *present* to the type checker's spread, and the point of the case is a record
    // that predates the field entirely.
    const { artifactEvidence: _dropped, ...rest } = artifactRejection;
    const legacy: LockedDependencyDecision = rest;

    const assessment = reasonsFor(legacy, lockEnvironment());

    expect(assessment.stalenessReasons).toEqual(["artifact-evidence-missing"]);
    expect(assessment.freshness).toBe("stale");
  });

  // PR review of #77, P1 (round 5). Round 4's evidence was two self-attested numbers, so nothing
  // tied the rejection to the compile it described: the Cell source could change, or another
  // dependency's decision could move, and the record kept reporting fresh. The identity in
  // `artifactEvidence.compileFingerprint` is what closes that.
  it("goes stale when the Cell's compile identity moves, so a size verdict cannot outlive its Cell", () => {
    const moved = lockEnvironment({
      artifactFingerprints: { ["date-fns\u0000" + BENCH_CELL]: artifactCompile('cell="moved";budget=100000', 190_000) },
    });

    const assessment = reasonsFor(artifactRejection, moved);

    expect(assessment.stalenessReasons).toEqual(["artifact-compile-changed"]);
    expect(assessment.freshness).toBe("stale");
  });

  it("cannot verify a budget rejection against an environment that compiled nothing", () => {
    // Fail-closed, like an unknown probe fingerprint: an absent compile is not agreement, and a
    // record whose Cell nobody recompiled has not been shown to still hold.
    const assessment = reasonsFor(artifactRejection, lockEnvironment({ artifactFingerprints: {} }));

    expect(assessment.stalenessReasons).toEqual(["artifact-compile-unknown"]);
  });

  // PR review of #77, P1 (round 7). A compile identity describes one composed Cell, but *which*
  // Cell state a rejection was measured from is a property of the record: package A may be measured
  // from one state, the source change, package B be measured from another, and both records stay in
  // the lock. Keyed by Cell, one fingerprint had to answer for both — and could only be right for
  // one of them.
  // PR review of #77, P1 (round 8). Revision 16's `status` compared only the artifact fingerprint,
  // so it discarded the freshly-produced attribution. A record could keep a real fingerprint beside
  // an invented `subjectRenderedCharacters` — even one larger than the artifact — and stay fresh.
  // Reproduced before this was fixed: inflating only that field left `status` reporting `fresh`.
  // PR review of #77, P1 (round 9). The two fields that state the *hard rejection* were still
  // trusted: revision 17 compared the fingerprint and the attribution but not `codeCharacters` or
  // `budgetCharacters`. Reproduced before this was fixed — a record could keep the real fingerprint
  // (the artifact genuinely is the one it names) beside a forged pair saying "over cap" and stay
  // fresh, reporting a rejection the current compiler does not emit. `codeCharacters` is not inside
  // the fingerprint (a fingerprint is a hash, not a size), so nothing else caught it.
  it("goes stale when the recorded verdict numbers no longer match the current compile", () => {
    const recomputed = lockEnvironment({
      artifactFingerprints: {
        ["date-fns\u0000" + BENCH_CELL]: artifactCompile(ARTIFACT_FINGERPRINT, 190_000, {
          // The Cell fits: the current compiler files no budget diagnostic.
          codeCharacters: 5_000,
          budgetCharacters: 100_000,
        }),
      },
    });

    const assessment = reasonsFor(artifactRejection, recomputed);

    expect(assessment.stalenessReasons).toContain("artifact-verdict-changed");
    expect(assessment.freshness).toBe("stale");
  });

  // PR review of #77, P1 (round 9). Revision 16's own `record` persisted
  // `subjectDecision: { strategy: "replace" }` through its normal writer (a second `record` read the
  // `replace` the first write had stored). Refusing it at the read boundary made a schema-v1 lock the
  // previous toolchain could write fail to *parse*, so the record never reached freshness — the
  // migration failure `lock-migration.ts` exists to prevent. It is readable now, and reports why it
  // cannot be replayed rather than pretending otherwise.
  it("reports a legacy subject decision as unreplayable rather than refusing to read the lock", () => {
    // Built through the parser rather than as a typed object, and that is more than convenience:
    // the type forbids this shape (correctly — no *new* record may carry it), so a legacy record can
    // only arrive as parsed JSON, which is exactly how a real reader meets it.
    const [legacy] = parseFgcLockDocument(
      JSON.stringify(
        {
          schemaVersion: 1,
          decisions: [
            {
              ...artifactRejection,
              artifactEvidence: { ...artifactEvidenceFixture(), subjectDecision: { strategy: "replace" } },
            },
          ],
        },
        null,
        2,
      ),
    ).decisions;

    const assessment = reasonsFor(legacy!, lockEnvironment());

    expect(assessment.stalenessReasons).toEqual(["artifact-subject-decision-unreplayable"]);
    expect(assessment.freshness).toBe("stale");
  });

  it("goes stale when the recorded subject share no longer matches the recomputed one", () => {
    // The identity is unchanged, so the artifact is the same compile; only the attribution moved.
    const recomputed = lockEnvironment({
      artifactFingerprints: {
        ["date-fns\u0000" + BENCH_CELL]: artifactCompile(ARTIFACT_FINGERPRINT, 12_345),
      },
    });

    const assessment = reasonsFor(artifactRejection, recomputed);

    expect(assessment.stalenessReasons).toEqual(["artifact-attribution-changed"]);
    expect(assessment.freshness).toBe("stale");
  });

  it("reports a moved identity and a moved share together, rather than one masking the other", () => {
    // Both halves live in one environment entry, so a reader sees every reason the record moved.
    const both = lockEnvironment({
      artifactFingerprints: {
        ["date-fns\u0000" + BENCH_CELL]: artifactCompile('cell="moved";budget=100000', 12_345),
      },
    });

    const reasons = reasonsFor(artifactRejection, both).stalenessReasons;

    expect(reasons).toContain("artifact-compile-changed");
    expect(reasons).toContain("artifact-attribution-changed");
  });

  it("assesses two records in one Cell against their own compile identities", () => {
    const second: LockedDependencyDecision = {
      ...artifactRejection,
      packageName: "es-toolkit",
      cellTarget: BENCH_CELL,
      artifactEvidence: artifactEvidenceFixture({ compileFingerprint: 'cell="second";budget=100000' }),
    };
    // Both records are in one Cell; their identities differ. An environment answering for one
    // fingerprint would leave the other reporting `artifact-compile-changed` for a compile that is
    // in fact its own.
    const environment = lockEnvironment({
      artifactFingerprints: {
        ["date-fns\u0000" + BENCH_CELL]: artifactCompile(ARTIFACT_FINGERPRINT, 190_000),
        ["es-toolkit\u0000" + BENCH_CELL]: artifactCompile('cell="second";budget=100000', 190_000),
      },
    });

    // Asserted on the artifact axis: the fixture's recorded candidate version does not match this
    // environment, which is an unrelated staleness reason and not what this case is about.
    expect(artifactReasons(artifactRejection, environment)).toEqual([]);
    expect(artifactReasons(second, environment)).toEqual([]);
    // And a moved identity still moves exactly one of them, so the keying is not answering "fresh"
    // for everything.
    const moved = lockEnvironment({
      artifactFingerprints: {
        ["date-fns\u0000" + BENCH_CELL]: artifactCompile(ARTIFACT_FINGERPRINT, 190_000),
        ["es-toolkit\u0000" + BENCH_CELL]: artifactCompile('cell="moved";budget=100000', 190_000),
      },
    });
    expect(artifactReasons(artifactRejection, moved)).toEqual([]);
    expect(artifactReasons(second, moved)).toEqual(["artifact-compile-changed"]);
  });

  it("re-checks an unrejected candidate's own version, which an artifact rejection also records", () => {
    // The round-5 hole: `assessPackageVersionFreshness` gated on the `technical-rejection` profile,
    // so an `artifact-rejection` skipped it even though it records `rejectedCandidate.version` —
    // and a candidate upgrade is exactly what can make the Cell small enough to fit.
    const upgraded = lockEnvironment({ resolvedVersions: { "date-fns": "5.0.0", "es-toolkit": "1.39.8", "some-amd-package": "2.4.0", react: "19.2.7" } });

    const assessment = reasonsFor(artifactRejection, upgraded);

    expect(assessment.stalenessReasons).toContain("rejected-candidate-version-changed");
  });

  it("verifies a budget rejection once it carries the compile evidence", () => {
    // The other half: with the evidence, the record is fresh, and its profile is the one whose
    // probe requirement is *passed* — the package is fine, the composed Cell is not.
    const resolution = resolveLockDecision(lock, { packageName: "date-fns", cellTarget: BENCH_CELL }, lockEnvironment());

    expect(resolution.state).toBe("verified");
    expect(resolution.assessment?.profile).toBe("artifact-rejection");
    expect(resolution.assessment?.stalenessReasons).toEqual([]);
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
