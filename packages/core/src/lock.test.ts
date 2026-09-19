import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { FgcLockDocument, ForguncyTargetIdentity, LockedDependencyDecision } from "./index";
import {
  assertFgcLockDocument,
  canonicalizeFgcLock,
  citesDecision,
  createEmptyFgcLock,
  DECISION_EVIDENCE_KINDS,
  DEPENDENCY_LOCK_DECISION,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockSchemaVersionError,
  findMachineSpecificPaths,
  forguncyTargetIdentity,
  GOVERNING_ARCHITECTURE_DECISIONS,
  inspectFgcLockDocument,
  isCanonicallyOrdered,
  isEvidenceReference,
  isRepositoryRelativeReference,
  isSupportedFgcLockSchemaVersion,
  LOCK_EVIDENCE_POLICY,
  LOCK_EVIDENCE_PROFILES,
  LOCK_GOVERNING_DECISIONS,
  LOCK_GOVERNING_SPEC_REFERENCE_LINE,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  parseFgcLockDocument,
  RUNTIME_CONTRACT_TARGET,
  serializeFgcLock,
  SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS,
  validateFgcLockDocument,
} from "./index";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

const SPEC_4 = "https://github.com/Mang-X/forguncy-react-workspace/issues/4";
const SPEC_8 = "https://github.com/Mang-X/forguncy-react-workspace/issues/8";
const SPEC_9 = "https://github.com/Mang-X/forguncy-react-workspace/issues/9";
const SPEC_12 = "https://github.com/Mang-X/forguncy-react-workspace/issues/12";

/** The target the #5 contract verified, rather than a version restated here. */
const TARGET: ForguncyTargetIdentity = forguncyTargetIdentity();
const TOOLCHAIN = { vitePlus: "0.3.2" };
const CELL_FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx;toolchain=vite-plus@0.3.2";
const BUNDLER_FINGERPRINT = "probe=amd-detect;entry=src/cells/orders-table/App.tsx;toolchain=vite-plus@0.3.2";

const inlineRecord: LockedDependencyDecision = {
  strategy: "inline",
  packageName: "es-toolkit",
  cellTarget: null,
  resolvedVersion: "1.39.8",
  probe: { status: "passed", fingerprint: CELL_FINGERPRINT, versionIndependent: false },
  target: TARGET,
  probedWith: TOOLCHAIN,
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
  target: TARGET,
  probedWith: TOOLCHAIN,
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
  target: TARGET,
  probedWith: TOOLCHAIN,
  extension: { version: "5.90.2", identity: "sha256:9f1c2b7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091" },
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
  target: TARGET,
  probedWith: TOOLCHAIN,
  extension: null,
  rejectedCandidate: { version: "2.4.0" },
  rationale: "The failure is a property of this published artifact, so the candidate version is recorded to re-open the decision on upgrade.",
  evidence: [
    { kind: "probe", reference: "docs/probes/technical-some-amd-package.md" },
    { kind: "spec-issue", reference: SPEC_8 },
  ],
};

/** Canonical order: `@tanstack/react-query` < `es-toolkit` < `react` < `react-router-dom` < `some-amd-package`. */
const fullLock: FgcLockDocument = {
  schemaVersion: FGC_LOCK_SCHEMA_VERSION,
  decisions: [extensionRecord, inlineRecord, hostRecord, architecturalRejection, technicalRejection],
};

function withRecord(record: LockedDependencyDecision): FgcLockDocument {
  return { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [record] };
}

function problemsFor(record: LockedDependencyDecision): string {
  return validateFgcLockDocument(withRecord(record)).join("\n");
}

describe("lock provenance", () => {
  it("is governed by #4, #5 and #8, in that order", () => {
    expect(LOCK_GOVERNING_DECISIONS.map(source => source.issue)).toEqual([4, 5, 8]);
    expect(LOCK_GOVERNING_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5, #8");
    expect(citesDecision(LOCK_GOVERNING_SPEC_REFERENCE_LINE, DEPENDENCY_LOCK_DECISION)).toBe(true);
  });

  // #8 is a dependency Spec built on #4, not an architecture decision. Adding it
  // to the architecture list would relabel it and change what that list means.
  it("keeps the lock Spec out of the architecture decision list", () => {
    expect(GOVERNING_ARCHITECTURE_DECISIONS.map(source => source.issue)).toEqual([4, 5]);
    expect(GOVERNING_ARCHITECTURE_DECISIONS).not.toContain(DEPENDENCY_LOCK_DECISION);
    expect(fullLock.decisions.length).toBeGreaterThan(0);
  });

  it("makes each lock module cite the decisions it is downstream of", () => {
    for (const file of ["lock.ts", "lock-freshness.ts"]) {
      const source = readFileSync(join(sourceDirectory, file), "utf8");
      for (const decision of LOCK_GOVERNING_DECISIONS) {
        expect(citesDecision(source, decision), `${file} should cite #${decision.issue}`).toBe(true);
      }
    }
  });
});

describe("fgc.lock.json model", () => {
  it("accepts a lock covering every strategy and both rejection kinds", () => {
    expect(validateFgcLockDocument(fullLock)).toEqual([]);
    expect(() => assertFgcLockDocument(fullLock)).not.toThrow();
  });

  it("takes its target identity from the verified contract (#5)", () => {
    expect(forguncyTargetIdentity()).toEqual({
      product: RUNTIME_CONTRACT_TARGET.product,
      productVersion: RUNTIME_CONTRACT_TARGET.productVersion,
      productBuild: RUNTIME_CONTRACT_TARGET.productBuild,
      hostReactVersion: RUNTIME_CONTRACT_TARGET.hostReactVersion,
    });
    expect(matchesForguncyTargetIdentity(TARGET, forguncyTargetIdentity())).toBe(true);
    expect(matchesForguncyTargetIdentity(TARGET, { ...TARGET, productBuild: "other" })).toBe(false);
    expect(matchesForguncyTargetIdentity(TARGET, { ...TARGET, hostReactVersion: "19.2.8" })).toBe(false);
  });

  it("keys evidence policy by profile, not by strategy alone", () => {
    expect(LOCK_EVIDENCE_PROFILES).toEqual([
      "resolved-dependency",
      "architectural-rejection",
      "technical-rejection",
    ]);
    expect(lockEvidenceProfileOf(inlineRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(hostRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(extensionRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(architecturalRejection)).toBe("architectural-rejection");
    expect(lockEvidenceProfileOf(technicalRejection)).toBe("technical-rejection");
  });

  it("owes a runtime check to every profile that produces a dependency", () => {
    // #4 declares realRuntimeRequired for every strategy, so an inlined bundle is
    // not verified by a local probe alone either.
    expect(LOCK_EVIDENCE_POLICY["resolved-dependency"].requiresRuntimeValidation).toBe(true);
    expect(LOCK_EVIDENCE_POLICY["resolved-dependency"].requiresTargetIdentity).toBe(true);
    expect(LOCK_EVIDENCE_POLICY["resolved-dependency"].probeRequirement).toBe("passed");
    expect(LOCK_EVIDENCE_POLICY["architectural-rejection"].invalidatedByTargetChange).toBe(false);
    expect(LOCK_EVIDENCE_POLICY["technical-rejection"].probeRequirement).toBe("measured");
    expect(LOCK_EVIDENCE_POLICY["technical-rejection"].invalidatedByTargetChange).toBe(true);
    for (const profile of LOCK_EVIDENCE_PROFILES) {
      const participates = LOCK_EVIDENCE_POLICY[profile].participatesInCompilation;
      expect(participates, profile).toBe(profile === "resolved-dependency");
    }
    expect([...DECISION_EVIDENCE_KINDS]).toEqual(["spec-issue", "probe", "pull-request", "runtime-observation"]);
  });

  it("projects a record onto #4's decision model without the lock metadata", () => {
    expect(Object.keys(dependencyDecisionOf(inlineRecord)).sort()).toEqual(["packageName", "strategy"]);
    expect(Object.keys(dependencyDecisionOf(hostRecord)).sort()).toEqual(["globalName", "packageName", "strategy"]);
    expect(Object.keys(dependencyDecisionOf(extensionRecord)).sort()).toEqual([
      "globalName",
      "libraryId",
      "packageName",
      "strategy",
    ]);
    expect(Object.keys(dependencyDecisionOf(technicalRejection)).sort()).toEqual([
      "alternatives",
      "packageName",
      "rejection",
      "strategy",
      "supersededBy",
    ]);
    expect(dependencyDecisionOf(extensionRecord)).toEqual({
      strategy: "extension",
      packageName: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    });
  });

  it("starts empty at the current schema version", () => {
    expect(FGC_LOCK_FILE_NAME).toBe("fgc.lock.json");
    expect(SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS).toContain(FGC_LOCK_SCHEMA_VERSION);
    expect(isSupportedFgcLockSchemaVersion(FGC_LOCK_SCHEMA_VERSION)).toBe(true);
    expect(isSupportedFgcLockSchemaVersion(99)).toBe(false);
    expect(createEmptyFgcLock()).toEqual({ schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [] });
  });
});

describe("portability", () => {
  it("finds an absolute path embedded inside a fingerprint, not just a bare one", () => {
    // The first draft only caught values that *were* an absolute path, so this
    // one — the shape a real fingerprint has — passed validation.
    const leaky = `entry=C:/Users/mang/project/src/App.tsx;toolchain=vite-plus@0.3.2`;
    const record: LockedDependencyDecision = {
      ...inlineRecord,
      probe: { ...inlineRecord.probe, fingerprint: leaky },
    };

    expect(problemsFor(record)).toMatch(/machine-specific absolute path/);
    expect(findMachineSpecificPaths(record)).toContain(leaky);
  });

  it("finds every absolute form wherever it appears in the document", () => {
    const cases = [
      "/Users/mang/project/App.tsx",
      "entry=/Users/mang/project/App.tsx",
      "entry=/home/ci/App.tsx",
      "C:\\Users\\mang\\App.tsx",
      "entry=C:/Users/mang/App.tsx",
      "\\\\build-server\\share\\App.tsx",
      "file at ~/project/App.tsx",
      "notes: see /var/tmp/probe.json",
    ];

    for (const value of cases) {
      expect(findMachineSpecificPaths({ value }), value).toContain(value);
    }
  });

  it("does not mistake a URL or a relative path for an absolute one", () => {
    const portable = [
      SPEC_4,
      "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
      "docs/probes/inline-es-toolkit.md",
      "packages/core/src/lock.ts",
      "sha256:9f1c2b7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091",
      "vite-plus@0.3.2;entry=src/cells/orders-table/App.tsx",
    ];

    expect(findMachineSpecificPaths(portable)).toEqual([]);
  });

  it("accepts URLs and repository-relative references only", () => {
    expect(isEvidenceReference(SPEC_4)).toBe(true);
    expect(isEvidenceReference("docs/probes/es-toolkit.md")).toBe(true);

    expect(isEvidenceReference("C:/Users/hp/x.json")).toBe(false);
    expect(isEvidenceReference("\\\\build-server\\share\\x.json")).toBe(false);
    expect(isEvidenceReference("/home/ci/x.json")).toBe(false);
    expect(isRepositoryRelativeReference("../outside-repo.json")).toBe(false);
    expect(isRepositoryRelativeReference("~/probe.json")).toBe(false);
    expect(isRepositoryRelativeReference("docs/probes/../../etc/passwd")).toBe(false);
  });

  it("flags a reference that is neither a URL nor a relative path", () => {
    expect(problemsFor({ ...inlineRecord, evidence: [{ kind: "probe", reference: "/var/tmp/probe.json" }] })).toMatch(
      /neither an http\(s\) URL nor a repository-relative path/,
    );
  });
});

describe("determinism", () => {
  it("produces identical bytes whatever order decisions were discovered in", () => {
    const shuffled: FgcLockDocument = {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [...fullLock.decisions].reverse(),
    };

    expect(serializeFgcLock(shuffled)).toBe(serializeFgcLock(fullLock));
  });

  it("produces identical bytes whatever order evidence was discovered in", () => {
    const reordered = withRecord({ ...inlineRecord, evidence: [...inlineRecord.evidence].reverse() });

    expect(serializeFgcLock(reordered)).toBe(serializeFgcLock(withRecord(inlineRecord)));
  });

  it("round-trips through the parser without changing a byte", () => {
    const text = serializeFgcLock(fullLock);

    expect(text.endsWith("\n")).toBe(true);
    expect(serializeFgcLock(parseFgcLockDocument(text))).toBe(text);
    expect(parseFgcLockDocument(text)).toEqual(canonicalizeFgcLock(fullLock));
  });

  it("records no timestamps, so re-running a resolver step cannot produce a diff", () => {
    const text = serializeFgcLock(fullLock);

    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toMatch(/"(createdAt|updatedAt|generatedAt)"/);
  });

  it("reports a non-canonical order rather than accepting a noisy diff", () => {
    const reversed: FgcLockDocument = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [...fullLock.decisions].reverse() };

    expect(isCanonicallyOrdered(fullLock.decisions)).toBe(true);
    expect(isCanonicallyOrdered(reversed.decisions)).toBe(false);
    expect(validateFgcLockDocument(reversed).join("\n")).toMatch(/not in canonical order/);
  });

  it("sorts the target-independent record before a target-specific one", () => {
    const lock: FgcLockDocument = {
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [{ ...inlineRecord, cellTarget: "orders-table" }, inlineRecord],
    };

    expect(canonicalizeFgcLock(lock).decisions.map(record => record.cellTarget)).toEqual([null, "orders-table"]);
  });
});

describe("schema versioning", () => {
  it("fails explicitly on an unknown schema version", () => {
    const future = JSON.stringify({ schemaVersion: 99, decisions: [] });

    expect(() => parseFgcLockDocument(future)).toThrow(FgcLockSchemaVersionError);
    expect(() => parseFgcLockDocument(future)).toThrow(/unsupported schema version 99/i);
  });

  it("fails explicitly on a document that declares no version at all", () => {
    expect(() => parseFgcLockDocument(JSON.stringify({ decisions: [] }))).toThrow(/numeric `schemaVersion`/);
  });

  it("reports malformed input instead of crashing while reading a field", () => {
    expect(inspectFgcLockDocument(null).join(" ")).toMatch(/must contain a JSON object/);
    expect(inspectFgcLockDocument({ schemaVersion: 1, decisions: [42] }).join(" ")).toMatch(/decisions\[0\] must be an object/);
    expect(inspectFgcLockDocument({ schemaVersion: 1, decisions: [{ packageName: "x" }] }).join(" ")).toMatch(
      /must record probe evidence/,
    );
    expect(() => parseFgcLockDocument("{ not json")).toThrow(/not valid JSON/);
  });
});

describe("lock metadata validation", () => {
  it("demands the exact resolved version for anything that reaches the graph", () => {
    expect(problemsFor({ ...inlineRecord, resolvedVersion: null })).toMatch(/without the exact resolved version/);
  });

  it("refuses a resolved version on a replace decision", () => {
    expect(problemsFor({ ...architecturalRejection, resolvedVersion: "7.1.0" })).toMatch(
      /keeps no dependency for the compiled cell/,
    );
  });

  it("ties a runtime-compatibility claim to a probe that actually passed", () => {
    // For a resolved dependency the target *is* the runtime claim, so it cannot
    // be recorded from a probe that failed or never ran.
    expect(problemsFor({ ...inlineRecord, probe: { ...inlineRecord.probe, status: "failed" } })).toMatch(
      /Runtime compatibility cannot be claimed from a probe that has not passed/,
    );
    expect(problemsFor({ ...inlineRecord, target: null })).toMatch(/must name the target it was validated against/);
  });

  // A technical rejection records the target the failure was observed under, and
  // a failed probe is exactly its evidence — so the rule above must not apply.
  it("lets a technical rejection record the target its failure was observed under", () => {
    expect(problemsFor(technicalRejection)).toBe("");
    expect(technicalRejection.probe.status).toBe("failed");
    expect(technicalRejection.target).not.toBeNull();
  });

  it("refuses a target on a profile that observes no runtime at all", () => {
    expect(
      problemsFor({
        ...architecturalRejection,
        target: TARGET,
        probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      }),
    ).toMatch(/cannot name a runtime it was observed under/);
  });

  it("requires a probe fingerprint once a probe has run, and forbids one when it has not", () => {
    expect(
      problemsFor({ ...inlineRecord, probe: { status: "passed", fingerprint: null, versionIndependent: false } }),
    ).toMatch(/without a fingerprint/);

    expect(
      problemsFor({
        ...inlineRecord,
        probe: { status: "not-run", fingerprint: "stale-fingerprint", versionIndependent: false },
      }),
    ).toMatch(/must not carry a probe fingerprint/);
  });

  it("refuses a version-independent claim without a probe", () => {
    expect(
      problemsFor({
        ...inlineRecord,
        probe: { status: "not-run", fingerprint: null, versionIndependent: true },
      }),
    ).toMatch(/Version independence is a property of a measured probe/);
  });

  it("refuses probe evidence on a profile whose evidence is the decision itself", () => {
    expect(
      problemsFor({
        ...architecturalRejection,
        probe: { status: "failed", fingerprint: BUNDLER_FINGERPRINT, versionIndependent: false },
        target: null,
      }),
    ).toMatch(/a probe run here would claim a measurement that this profile does not make/);
  });

  it("refuses a toolchain recorded for a probe that never ran", () => {
    expect(problemsFor({ ...architecturalRejection, probedWith: TOOLCHAIN })).toMatch(/probe that never ran/);
  });

  it("makes a technical rejection name the candidate it rejected", () => {
    expect(problemsFor({ ...technicalRejection, rejectedCandidate: null })).toMatch(
      /must record the exact version of the candidate that failed/,
    );
  });

  it("refuses a rejected candidate on an architectural rejection", () => {
    expect(problemsFor({ ...architecturalRejection, rejectedCandidate: { version: "7.1.0" } })).toMatch(
      /would tie an ownership conflict to a release/,
    );
    expect(problemsFor({ ...inlineRecord, rejectedCandidate: { version: "1.39.8" } })).toMatch(/only a rejection has one/);
  });

  it("requires extension identity on extension records and only on them", () => {
    expect(problemsFor({ ...extensionRecord, extension: null })).toMatch(/must record the extension version or identity/);
    expect(problemsFor({ ...extensionRecord, extension: { version: null, identity: null } })).toMatch(/names neither/);
    expect(problemsFor({ ...inlineRecord, extension: { version: "1.0.0", identity: null } })).toMatch(
      /extension identity belongs to `extension` records only/,
    );
  });

  it("requires a rationale exactly where #4 requires a justification", () => {
    expect(problemsFor({ ...extensionRecord, rationale: null })).toMatch(/requires a written justification/);
    expect(problemsFor({ ...architecturalRejection, rationale: "  " })).toMatch(/requires a written justification/);
    expect(problemsFor({ ...inlineRecord, rationale: null })).toEqual("");
  });

  it("requires evidence, and a probe link once a probe has run", () => {
    expect(problemsFor({ ...inlineRecord, evidence: [] })).toMatch(/records no evidence/);
    expect(problemsFor({ ...inlineRecord, evidence: [{ kind: "spec-issue", reference: SPEC_8 }] })).toMatch(
      /links no `probe` or `runtime-observation` evidence/,
    );
  });

  it("makes an architectural rejection name the ownership decision", () => {
    // Rule 5 of #8: these conflicts route to #4, so evidence citing only the lock
    // Spec is not enough to show where the rejection came from.
    expect(problemsFor({ ...architecturalRejection, evidence: [{ kind: "spec-issue", reference: SPEC_8 }] })).toMatch(
      /links no evidence citing https:\/\/github.com\/Mang-X\/forguncy-react-workspace\/issues\/4/,
    );
    expect(problemsFor({ ...architecturalRejection, evidence: [{ kind: "spec-issue", reference: SPEC_4 }] })).toBe("");
  });

  it("rejects two records for the same package and cell target", () => {
    const problems = validateFgcLockDocument({
      schemaVersion: FGC_LOCK_SCHEMA_VERSION,
      decisions: [inlineRecord, { ...inlineRecord, strategy: "host", globalName: "EsToolkit" }],
    }).join("\n");

    expect(problems).toMatch(/duplicates an existing decision/);
  });

  it("reuses #4's decision-shape rules instead of restating them", () => {
    expect(problemsFor({ ...hostRecord, globalName: "  " })).toMatch(/must name the host global/);
  });
});
