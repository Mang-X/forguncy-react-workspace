import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ArtifactBudgetEvidence,
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockedDependencyDecision,
} from "./index.ts";
import {
  assertFgcLockDocument,
  canonicalizeFgcLock,
  canonicalizeImports,
  citesDecision,
  createEmptyFgcLock,
  DECISION_EVIDENCE_KINDS,
  DEPENDENCY_LOCK_DECISION,
  dependencyDecisionOf,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  FgcLockSchemaVersionError,
  FgcLockValidationError,
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
  LOCK_PROBE_REQUIREMENTS,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
  parseFgcLockDocument,
  requiresRealRuntimeValidation,
  requiresRuntimeValidation,
  requiresTargetIdentity,
  RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES,
  RUNTIME_CONTRACT_TARGET,
  serializeFgcLock,
  SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS,
  validateFgcLockDocument,
} from "./index.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

const SPEC_4 = "https://github.com/Mang-X/forguncy-react-workspace/issues/4";
const SPEC_8 = "https://github.com/Mang-X/forguncy-react-workspace/issues/8";
const SPEC_9 = "https://github.com/Mang-X/forguncy-react-workspace/issues/9";
const SPEC_12 = "https://github.com/Mang-X/forguncy-react-workspace/issues/12";

/** The target the #5 contract verified, rather than a version restated here. */
const TARGET: ForguncyTargetIdentity = forguncyTargetIdentity();
const TOOLCHAIN = { vitePlus: "0.3.2" };
const CELL_FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";
const BUNDLER_FINGERPRINT = "probe=amd-detect;entry=src/cells/orders-table/App.tsx";

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

/**
 * Compile evidence for a rejection that the compiler confirmed.
 *
 * The shape #77 revision 17 settled: an identity over the composed artifact (the verdict, and the
 * part that gets re-proven), the subject's pre-rejection decision (so the measured Cell can be
 * replayed), and the subject's rendered share (advisory evidence a reviewer weighs — *not* a
 * rejection rule; see the interface's header for the counterexample that retired that rule).
 */
function artifactEvidenceFixture(overrides: {
  readonly subjectRenderedCharacters?: number;
  readonly codeCharacters?: number;
  readonly budgetCharacters?: number;
} = {}): ArtifactBudgetEvidence {
  return {
    compileFingerprint: 'cell="x";budget=100000',
    subjectDecision: { strategy: "inline" },
    // Over cap with the subject's contribution counted, under it without: the state a rejection is
    // allowed to rest on.
    subjectRenderedCharacters: overrides.subjectRenderedCharacters ?? 190_000,
    codeCharacters: overrides.codeCharacters ?? 200_000,
    budgetCharacters: overrides.budgetCharacters ?? 100_000,
  };
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
      "artifact-rejection",
    ]);
    expect(lockEvidenceProfileOf(inlineRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(hostRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(extensionRecord)).toBe("resolved-dependency");
    expect(lockEvidenceProfileOf(architecturalRejection)).toBe("architectural-rejection");
    expect(lockEvidenceProfileOf(technicalRejection)).toBe("technical-rejection");

    // The split that revision 14 added, and the reason it is a *profile* rather than a validator
    // special-case: a compile-observed rejection wants a **passing** probe (the package is fine,
    // the Cell is over cap), which is the opposite of what `technical-rejection` requires. Routing
    // it through the probe profile would make the expected state unrecordable.
    const artifactRejection: LockedDependencyDecision = {
      ...technicalRejection,
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over the project's cap.",
        remediation: "Evaluate a lighter alternative.",
      },
      artifactEvidence: artifactEvidenceFixture(),
    };
    expect(lockEvidenceProfileOf(artifactRejection)).toBe("artifact-rejection");
    expect(LOCK_EVIDENCE_POLICY["artifact-rejection"].probeRequirement).toBe("passed");
    expect(LOCK_EVIDENCE_POLICY["artifact-rejection"].participatesInCompilation).toBe(false);
  });

  it("owes a runtime check to every profile that produces a dependency", () => {
    expect(LOCK_EVIDENCE_POLICY["resolved-dependency"].probeRequirement).toBe("passed");
    expect(LOCK_EVIDENCE_POLICY["architectural-rejection"].invalidatedByTargetChange).toBe(false);
    // A rejection's evidence is a probe that did not succeed — a passing one
    // beside a technical rejection contradicts the decision.
    expect(LOCK_EVIDENCE_POLICY["technical-rejection"].probeRequirement).toBe("not-passed");
    expect(LOCK_EVIDENCE_POLICY["technical-rejection"].invalidatedByTargetChange).toBe(true);
    expect([...LOCK_PROBE_REQUIREMENTS]).toEqual(["none", "passed", "not-passed"]);
    for (const profile of LOCK_EVIDENCE_PROFILES) {
      const participates = LOCK_EVIDENCE_POLICY[profile].participatesInCompilation;
      expect(participates, profile).toBe(profile === "resolved-dependency");
    }
    expect([...DECISION_EVIDENCE_KINDS]).toEqual(["spec-issue", "probe", "pull-request", "runtime-observation"]);
  });

  it("asks a runtime-only rejection for the target it was observed under", () => {
    // A local bundling failure needs no runtime; a host observation does.
    expect(requiresTargetIdentity(technicalRejection)).toBe(false);
    expect(RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES).toEqual([
      "host-module-identity-mismatch",
      "global-namespace-collision",
      "runtime-api-unavailable",
    ]);

    for (const code of RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES) {
      const runtimeFailure: LockedDependencyDecision = {
        ...technicalRejection,
        rejection: {
          kind: "technical",
          code,
          summary: "The package needs a runtime API the target does not expose.",
          remediation: "Route the capability to Forguncy, or evaluate a browser-first alternative.",
        },
      };

      expect(requiresTargetIdentity(runtimeFailure), code).toBe(true);
      expect(problemsFor(runtimeFailure)).toBe("");
      expect(problemsFor({ ...runtimeFailure, target: null })).toMatch(/must name the target it was observed under/);
    }

    // A resolved dependency names its target when it has a runtime claim to
    // make; a missing target there is a state (`not-validated`), not a shape
    // error — see the persistability test below.
    for (const record of [hostRecord, inlineRecord, extensionRecord]) {
      expect(requiresTargetIdentity(record), record.strategy).toBe(false);
    }
    expect(requiresTargetIdentity(architecturalRejection)).toBe(false);
  });

  // The lock must not be a second place that decides whether a strategy owes a
  // runtime check: #4 already answers that, and two tables answering it is how
  // they drift apart.
  it("takes the runtime-check requirement from #4 instead of restating it", () => {
    for (const record of [hostRecord, inlineRecord, extensionRecord]) {
      expect(requiresRuntimeValidation(record), record.strategy).toBe(requiresRealRuntimeValidation(record.strategy));
      expect(requiresRealRuntimeValidation(record.strategy), record.strategy).toBe(true);
    }

    // The documented divergence: #4's flag for `replace` is a check on the
    // replacement, which carries its own record, not on this one.
    expect(requiresRealRuntimeValidation("replace")).toBe(true);
    expect(requiresRuntimeValidation(architecturalRejection)).toBe(false);
    expect(requiresRuntimeValidation(technicalRejection)).toBe(false);
    expect(lockEvidenceProfileOf(technicalRejection)).toBe("technical-rejection");
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
      "file:///Users/mang/project/App.tsx",
      "probe=x;entry=file:///Users/mang/project/App.tsx",
      "file:///home/ci/project/App.tsx",
      "entry=file:///Volumes/work/App.tsx",
    ];

    for (const value of cases) {
      expect(findMachineSpecificPaths({ value }), value).toContain(value);
    }
  });

  // The scheme guard that keeps `https://` out must not become a hole for the
  // scheme a probe actually produces: `import.meta.url` is a file URL, and it is
  // the most likely way a machine path re-enters the lock through #17.
  it("treats a file URL as machine-specific while still allowing http URLs", () => {
    expect(
      findMachineSpecificPaths({ reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8" }),
    ).toEqual([]);
    expect(findMachineSpecificPaths({ reference: "file:///Users/mang/project/App.tsx" })).toEqual([
      "file:///Users/mang/project/App.tsx",
    ]);
    expect(
      problemsFor({
        ...inlineRecord,
        probe: { ...inlineRecord.probe, fingerprint: "probe=x;entry=file:///Users/mang/project/App.tsx" },
      }),
    ).toMatch(/machine-specific absolute path/);
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

  // PR review of #77, P2. `imports` is set-like — the probe fingerprint already sorts it into one
  // input — so two spellings of one surface must not be two byte sequences in a committed lock,
  // or #8's "deterministic and reviewable" guarantee is false for a document that is otherwise
  // fully ordered.
  it("produces identical bytes whatever order a declared import surface was discovered in", () => {
    const forwards = withRecord({ ...inlineRecord, imports: ["add", "clamp"] });
    const backwards = withRecord({ ...inlineRecord, imports: ["clamp", "add"] });

    expect(serializeFgcLock(forwards)).toBe(serializeFgcLock(backwards));
  });

  it("rejects a non-canonical import surface rather than silently reordering it", () => {
    // Refused, not canonicalized away: the lock treats decision and evidence order the same way,
    // so the writer is told to serialize instead of the document being reordered under a reviewer.
    const unsorted = withRecord({ ...inlineRecord, imports: ["clamp", "add"] });

    expect(validateFgcLockDocument(unsorted).join("\n")).toMatch(/not the canonical spelling/);
    expect(validateFgcLockDocument(withRecord({ ...inlineRecord, imports: ["add", "clamp"] }))).toEqual([]);
  });

  it("rejects a duplicated import surface, which is a second spelling of one set", () => {
    const duplicated = withRecord({ ...inlineRecord, imports: ["add", "add"] });

    expect(validateFgcLockDocument(duplicated).join("\n")).toMatch(/not the canonical spelling/);
  });

  it("folds an empty import surface to null, the spelling this field uses for the namespace", () => {
    // The one form the field must never carry: an empty array would compose a fingerprint naming
    // a surface no build ever used. `canonicalizeImports` returns null for it, so a writer cannot
    // produce it by canonicalizing, and a hand-written one is still refused.
    expect(canonicalizeImports([])).toBeNull();
    expect(canonicalizeImports(["add"])).toEqual(["add"]);
    expect(canonicalizeImports(null)).toBeNull();
    expect(canonicalizeImports(undefined)).toBeNull();
    expect(validateFgcLockDocument(withRecord({ ...inlineRecord, imports: [] })).join("\n")).toMatch(/empty/);
  });

  it("omits the key entirely for the namespace surface, so a pre-#77 lock is untouched", () => {
    // A record written before this field existed has no key, and canonicalizing it must not add
    // one — otherwise the lock's own bytes would change for a reason nothing measured.
    const serialized = serializeFgcLock(withRecord(inlineRecord));

    expect(serialized).not.toContain("imports");
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
  // The first revision checked four fields and then ran the semantic rules over
  // whatever was left, so a record missing `cellTarget` reached
  // `record.cellTarget.trim()` and threw a native TypeError out of the parser.
  it("reports every malformed shape instead of throwing a TypeError", () => {
    const malformed: readonly Record<string, unknown>[] = [
      { ...inlineRecord, cellTarget: undefined },
      { ...inlineRecord, resolvedVersion: undefined },
      { ...inlineRecord, rationale: 7 },
      { ...inlineRecord, probe: { fingerprint: null, versionIndependent: false } },
      { ...inlineRecord, probe: { status: "passed", fingerprint: null } },
      { ...inlineRecord, target: { product: "Forguncy" } },
      { ...inlineRecord, probedWith: {} },
      { ...inlineRecord, evidence: ["docs/probes/inline-es-toolkit.md"] },
      { ...hostRecord, globalName: undefined },
      { ...extensionRecord, libraryId: undefined },
      { ...architecturalRejection, rejection: { kind: "architectural", summary: "Requested as the router." } },
      { ...technicalRejection, rejectedCandidate: { version: 2 } },
      { ...technicalRejection, alternatives: "browser-first-alternative" },
      { ...technicalRejection, supersededBy: "bundle" },
    ];

    for (const record of malformed) {
      const lock = { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [record] };

      expect(validateFgcLockDocument(lock as never).length, JSON.stringify(record)).toBeGreaterThan(0);
      expect(() => parseFgcLockDocument(JSON.stringify(lock))).toThrow(FgcLockValidationError);
    }
  });

  it("says which field is missing rather than reading it as absent-and-fine", () => {
    const problems = inspectFgcLockDocument({
      schemaVersion: 1,
      decisions: [{ packageName: "es-toolkit", strategy: "inline" }],
    }).join("\n");

    expect(problems).toMatch(/must declare `cellTarget` as a string or null/);
    expect(problems).toMatch(/must record probe evidence/);
    expect(problems).toMatch(/must record an `evidence` array/);
  });

  it("refuses a rejection whose code belongs to the other family", () => {
    expect(
      problemsFor({
        ...technicalRejection,
        rejection: {
          kind: "technical",
          code: "application-router-conflict" as never,
          summary: "The published entry resolves to an AMD branch.",
          remediation: "Evaluate a browser-first ESM alternative.",
        },
      }),
    ).toMatch(/must declare a rejection code from the technical family/);
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

  // PR review of #77, P1 (round 4). Round 3's version of this test asserted the code was refused
  // outright; that made a schema-v1 lock holding it *unreadable* rather than stale, which is the
  // opposite of the migration contract. Revision 14 gives the code a real evidence shape instead,
  // and the rules are now: evidence required where it belongs, refused where it does not, and a
  // record without it stays readable (freshness reports `artifact-evidence-missing`).
  it("refuses compile evidence attached to a code a probe observes", () => {
    const misplaced: LockedDependencyDecision = {
      ...technicalRejection,
      artifactEvidence: artifactEvidenceFixture(),
    };

    expect(problemsFor(misplaced)).toMatch(/which is the evidence for a compile-observed code/);
    // The sibling code that a probe *can* observe is untouched when it carries no artifact
    // evidence, so this is a rule about the pairing rather than about `replace`.
    expect(problemsFor(technicalRejection)).toBe("");
  });

  it("refuses compile evidence whose own numbers do not state the rejection", () => {
    // The point of recording both figures is that the claim becomes checkable: an over-cap
    // rejection whose measurement is under the cap is a contradiction.
    const withinCap: LockedDependencyDecision = {
      ...technicalRejection,
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over the project's cap.",
        remediation: "Evaluate a lighter alternative.",
      },
      artifactEvidence: artifactEvidenceFixture({ codeCharacters: 100 }),
    };

    expect(problemsFor(withinCap)).toMatch(/within the cap, so the evidence does not support/);
  });

  // PR review of #77, P1 (round 8). Revision 16 turned the subject's rendered share into a rejection
  // rule — `codeCharacters - subjectRenderedCharacters <= budgetCharacters` — reading the difference
  // as "the Cell without this package". **It is not that**, and the counterexample compiles: with
  // `App -> A` and `App -> B -> A`, marking A as `replace` produces a byte-identical artifact,
  // because B keeps A reachable. The subtraction removes a number, not a dependency.
  //
  // So the share does not reject. What is still checked is the one thing true of a share by
  // definition: it cannot exceed the artifact it is a share of.
  it("does not refuse on the subject's share, which is advisory evidence rather than proof", () => {
    const shareLooksSmall: LockedDependencyDecision = {
      ...technicalRejection,
      cellTarget: "bench",
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over the project's cap.",
        remediation: "Evaluate a lighter alternative.",
      },
      // A sliver of the excess: a reviewer should weigh this as weak evidence, but the compiled
      // verdict is what a `replace` rests on, so the record is accepted.
      artifactEvidence: artifactEvidenceFixture({
        subjectRenderedCharacters: 1_000,
        codeCharacters: 200_000,
        budgetCharacters: 100_000,
      }),
    };

    expect(problemsFor(shareLooksSmall)).toBe("");
  });

  it("refuses a share larger than the artifact it is a share of", () => {
    // The bound that *is* structural: a larger number makes the residual negative and satisfies any
    // comparison trivially, which revision 16 accepted — so the shape check would have let a record
    // carry an impossible attribution.
    const impossible: LockedDependencyDecision = {
      ...technicalRejection,
      cellTarget: "bench",
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over the project's cap.",
        remediation: "Evaluate a lighter alternative.",
      },
      artifactEvidence: artifactEvidenceFixture({ subjectRenderedCharacters: 999_999, codeCharacters: 200_000 }),
    };

    expect(problemsFor(impossible)).toMatch(/cannot be larger than the artifact/);
  });

  // PR review of #77, P1 (round 5). A size verdict is about **one** composed Cell and that Cell's
  // cap, but `cellTarget: null` is the lock's fallback record for *every* Cell — so accepting it
  // here would turn one Cell's measurement into "replace this package everywhere".
  it("refuses compile evidence that names no Cell", () => {
    const everywhere: LockedDependencyDecision = {
      ...technicalRejection,
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over the project's cap.",
        remediation: "Evaluate a lighter alternative.",
      },
      artifactEvidence: artifactEvidenceFixture(),
      cellTarget: null,
    };

    expect(problemsFor(everywhere)).toMatch(/without naming the Cell it measured/);
    // A record with no compile evidence is untouched, so a pre-revision-15 lock stays readable.
    expect(problemsFor(technicalRejection)).toBe("");
  });

  // PR review of #77, P2 (round 5). `inspectLockRecord` runs over untrusted JSON, so a malformed
  // value has to become a validation finding rather than a native throw.
  it("reports a malformed compile-evidence value instead of throwing on it", () => {
    // Reproduced through the *parser*, not the typed validator: the defect was that an explicit
    // `null` passed the structural phase and then blew up when the semantic pass destructured it.
    const text = JSON.stringify(
      {
        schemaVersion: 1,
        decisions: [
          {
            ...technicalRejection,
            rejection: {
              kind: "technical",
              code: "cell-code-budget-exceeded",
              summary: "The composed Cell is over the project's cap.",
              remediation: "Evaluate a lighter alternative.",
            },
            cellTarget: "bench",
            artifactEvidence: null,
          },
        ],
      },
      null,
      2,
    );

    expect(() => parseFgcLockDocument(text)).toThrow(FgcLockValidationError);
    // …and the message says what was wrong rather than surfacing a `TypeError`.
    expect(() => parseFgcLockDocument(text)).toThrow(/artifactEvidence/);
  });

  it("keeps a pre-revision-14 budget rejection readable, so it can go stale instead of unreadable", () => {
    // The migration contract in `lock-migration.ts`: a lock written by a previous toolchain must
    // stay readable, and a migration must not silently delete or re-decide a record it cannot
    // interpret. Round 3 refused this outright, which made such a lock fail to *parse* — the
    // record never reached freshness, so the invalidation the revision bump exists to produce
    // never ran. It is accepted here; `lock-freshness.test.ts` asserts it reports stale.
    const legacy: LockedDependencyDecision = {
      ...technicalRejection,
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The candidate's artifact is over the cell code cap.",
        remediation: "Evaluate a lighter alternative.",
      },
    };

    expect(problemsFor(legacy)).toBe("");
  });

  // PR review of #77, P1 (round 8). The *writer* refused `replace` as a subject decision, but the
  // parser accepted any string for `strategy` — so a hand-edited lock could persist the one state
  // the writer considers unreachable. It is not merely malformed: a `replace` subject replays to a
  // Cell the package is not part of, and if the artifact bytes happen to match (the fall-through
  // measured in round 6), freshness would keep that impossible state fresh.
  it("refuses a persisted subject decision the subject cannot have been compiled under", () => {
    // Asserted on the **structural** pass, which is where this rule is uniquely load-bearing: that
    // pass is public API (`inspectFgcLockDocument`) and is what `lock-migration.ts` runs on a
    // document from an older toolchain, so a hand-edited `replace` has to be caught there. The
    // semantic pass refuses it too — see the sibling case — but a test that only went through
    // `validateFgcLockDocument` would pass with this pass disabled, and would therefore not pin it.
    const inspect = (subjectDecision: unknown): string =>
      inspectFgcLockDocument({
        schemaVersion: 1,
        decisions: [
          {
            ...technicalRejection,
            cellTarget: "bench",
            rejection: {
              kind: "technical",
              code: "cell-code-budget-exceeded",
              summary: "The composed Cell is over the project's cap.",
              remediation: "Evaluate a lighter alternative.",
            },
            artifactEvidence: { ...artifactEvidenceFixture(), subjectDecision },
          },
        ],
      }).join(" ");

    // Each of these is a state the writer cannot produce, and each is refused.
    expect(inspect({ strategy: "replace" })).toMatch(/subjectDecision/);
    expect(inspect({ strategy: "host" })).toMatch(/subjectDecision/);
    expect(inspect({ strategy: "extension", globalName: "X" })).toMatch(/subjectDecision/);
    expect(inspect({ strategy: "nonsense" })).toMatch(/subjectDecision/);
    expect(inspect("inline")).toMatch(/subjectDecision/);
    // A field the strategy does not take is refused too, rather than ignored: a `host` subject
    // carrying a `libraryId` is not a `host` decision.
    expect(inspect({ strategy: "host", globalName: "R", libraryId: "x" })).toMatch(/subjectDecision/);
    // The three legal shapes pass, so the union is not refusing everything.
    expect(inspect({ strategy: "inline" })).toBe("");
    expect(inspect({ strategy: "host", globalName: "R" })).toBe("");
    expect(inspect({ strategy: "extension", globalName: "X", libraryId: "y" })).toBe("");
  });

  it("refuses the same state through the whole document path, so reading a lock cannot accept it", () => {
    // The end-to-end half: a reader loads through `parseFgcLockDocument`, so the refusal has to
    // hold there regardless of which pass catches it.
    const text = JSON.stringify(
      {
        schemaVersion: 1,
        decisions: [
          {
            ...technicalRejection,
            cellTarget: "bench",
            rejection: {
              kind: "technical",
              code: "cell-code-budget-exceeded",
              summary: "The composed Cell is over the project's cap.",
              remediation: "Evaluate a lighter alternative.",
            },
            artifactEvidence: { ...artifactEvidenceFixture(), subjectDecision: { strategy: "replace" } },
          },
        ],
      },
      null,
      2,
    );

    expect(() => parseFgcLockDocument(text)).toThrow(/subjectDecision/);
  });

  it("ties a runtime-compatibility claim to a probe that actually passed", () => {
    // A target *is* the runtime claim, so it cannot be recorded from a probe
    // that failed or never ran.
    expect(problemsFor({ ...inlineRecord, probe: { ...inlineRecord.probe, status: "failed" } })).toMatch(
      /Runtime compatibility cannot be claimed from a probe that has not passed/,
    );
  });

  // A target is a verification claim, not a required field. Without that split,
  // "probed locally, runtime check still owed" and "the probe failed" would be
  // states the model describes but no real lock file can hold.
  it("lets a resolved dependency persist without a runtime claim", () => {
    expect(problemsFor({ ...inlineRecord, target: null })).toBe("");
    expect(problemsFor({ ...inlineRecord, target: null, probe: { ...inlineRecord.probe, status: "failed" } })).toBe("");
    expect(
      problemsFor({
        ...inlineRecord,
        target: null,
        probedWith: null,
        probe: { status: "not-run", fingerprint: null, versionIndependent: false },
      }),
    ).toBe("");
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

  it("refuses a technical rejection whose probe passed", () => {
    // Without this rule the record could be rejected and accepted at once, and
    // `resolveLockDecision` would report it as verified.
    expect(
      problemsFor({ ...technicalRejection, probe: { ...technicalRejection.probe, status: "passed" } }),
    ).toMatch(/status "passed" contradicts the rejection/);

    // Recording a rejection whose failure has not been measured stays possible —
    // it is a decision an Agent can legitimately reach by reading the package's
    // requirements — it just cannot be verified.
    expect(
      problemsFor({
        ...technicalRejection,
        probe: { status: "not-run", fingerprint: null, versionIndependent: false },
        probedWith: null,
        target: null,
      }),
    ).toBe("");
  });

  it("refuses a toolchain recorded for a probe that never ran", () => {
    expect(problemsFor({ ...architecturalRejection, probedWith: TOOLCHAIN })).toMatch(/probe that never ran/);
  });

  // Without the toolchain identity there is nothing to compare, so a Vite+
  // upgrade could never invalidate the evidence: the record would be verified
  // for ever. #8 allows the *version* to be immaterial, not the identity.
  it("makes a record that ran a probe name the toolchain it ran under", () => {
    expect(problemsFor({ ...inlineRecord, probedWith: null })).toMatch(
      /without the toolchain it ran under/,
    );
    expect(problemsFor({ ...inlineRecord, probedWith: { vitePlus: null } })).toBe("");
    expect(problemsFor({ ...technicalRejection, probedWith: null })).toMatch(/without the toolchain it ran under/);
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
