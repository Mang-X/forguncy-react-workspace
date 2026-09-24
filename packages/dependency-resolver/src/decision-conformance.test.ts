import { describe, expect, it } from "vitest";

import { hostBridgeGlobalMappings, HOST_BRIDGE_MAPPINGS } from "@forguncy-react-workspace/core";

import type {
  ConformanceDiagnostic,
  ConformanceProblemCode,
  ExtensionCatalog,
  FgcLockDocument,
  ForguncyTargetIdentity,
  HostBridgeManifest,
  LockedDependencyDecision,
} from "./index.ts";
import {
  auditLockDecisionConformance,
  conformanceErrors,
  DEFAULT_HOST_BRIDGE_MANIFEST,
  FGC_LOCK_SCHEMA_VERSION,
  forguncyTargetIdentity,
  JSX_RUNTIME_MODULE_IDS,
  PRESET_PROVIDED_HOST_GLOBALS,
  validateFgcLockDocument,
  validateLockDecisionConformance,
} from "./index.ts";

const FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";

const recordBase = {
  cellTarget: null,
  probe: { status: "passed", fingerprint: FINGERPRINT, versionIndependent: false } as const,
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [{ kind: "runtime-observation", reference: "docs/probes/host-react.md" }] as const,
};

interface HostOptions {
  readonly resolvedVersion?: string | null;
  readonly target?: ForguncyTargetIdentity | null;
}

function hostRecord(packageName: string, globalName: string, options: HostOptions = {}): LockedDependencyDecision {
  return {
    ...recordBase,
    strategy: "host",
    packageName,
    globalName,
    resolvedVersion: options.resolvedVersion === undefined ? "19.2.7" : options.resolvedVersion,
    target: options.target === undefined ? forguncyTargetIdentity() : options.target,
  };
}

function inlineRecord(packageName: string): LockedDependencyDecision {
  return { ...recordBase, strategy: "inline", packageName, resolvedVersion: "1.11.13", target: forguncyTargetIdentity() };
}

/**
 * A `replace` record — the strategy that records a refusal rather than a provider.
 *
 * `host-module-identity-mismatch` is #4's own code for "this module's identity has to
 * be the host's", which is the reason the JSX runtime cannot be an ordinary dependency.
 *
 * Legal under `core`'s lock rules, not merely acceptable to the audit, which is what
 * makes it a real fixture: the `technical-rejection` profile requires a probe that did
 * **not** pass, so a `passed` probe carried over from the base record would be refused
 * by `validateProbe` — the positive case would then have proved only that the audit
 * does not object to a record nobody could write.
 */
function replaceRecord(packageName: string): LockedDependencyDecision {
  return {
    ...recordBase,
    strategy: "replace",
    packageName,
    resolvedVersion: null,
    probe: { status: "failed", fingerprint: FINGERPRINT, versionIndependent: false },
    // A `host-module-identity-mismatch` rejection is runtime-confirmed, so #8 requires
    // the record to name the target its evidence is about.
    target: forguncyTargetIdentity(),
    rejectedCandidate: { version: "19.2.7" },
    rationale: "The specifier is not usable as an ordinary dependency; the adapter takes its place.",
    rejection: {
      kind: "technical",
      code: "host-module-identity-mismatch",
      summary: "A JSX runtime has to share the host React's module identity.",
      remediation: "Use the JSX runtime adapter the compiler generates.",
    },
    alternatives: ["jsx-runtime-adapter"],
  };
}

function extensionRecord(
  packageName: string,
  libraryId: string,
  globalName: string,
  options: { readonly extensionVersion?: string | null } = {},
): LockedDependencyDecision {
  return {
    ...recordBase,
    strategy: "extension",
    packageName,
    libraryId,
    globalName,
    resolvedVersion: "5.90.2",
    target: forguncyTargetIdentity(),
    extension: { version: options.extensionVersion === undefined ? "5.90.2" : options.extensionVersion, identity: null },
    rationale: "The shared extension global is required so cells share one query cache.",
  };
}

function lock(...decisions: readonly LockedDependencyDecision[]): FgcLockDocument {
  return { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [...decisions] };
}

const catalog: ExtensionCatalog = {
  mappings: [
    { packageName: "@tanstack/react-query", libraryId: "tanstack-query", globalName: "TanStackQuery" },
    { packageName: "@tanstack/query-core", libraryId: "tanstack-query", globalName: "TanStackQuery" },
  ],
};

function codes(diagnostics: readonly ConformanceDiagnostic[]): readonly ConformanceProblemCode[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

describe("host records against #9", () => {
  it("accepts a mapping the manifest declares", () => {
    expect(auditLockDecisionConformance(lock(hostRecord("react", "React")))).toEqual([]);
    expect(auditLockDecisionConformance(lock(hostRecord("react-dom", "ReactDOM")))).toEqual([]);
    // A subpath id covered by its package's mapping.
    expect(auditLockDecisionConformance(lock(hostRecord("react-dom/client", "ReactDOM")))).toEqual([]);
  });

  it("reports a decision that renames the global the mapping declares", () => {
    // Rewriting an import to a different global does not fail at build time — it
    // fails at runtime, as a missing or wrong object.
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("react", "ReactDOM")));

    expect(codes(diagnostics)).toEqual(["host-mapping-mismatch"]);
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.detail).toContain('bound to the host global "React"');
  });

  it("reports a global nothing in the target provides", () => {
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("lodash", "_")));

    expect(codes(diagnostics)).toEqual(["host-global-not-provided"]);
    expect(diagnostics[0]?.detail).toContain("not a host-bridge mapping and no preset library chain installs it");
  });

  it("accepts a host bridge supplied by the caller instead of guessing", () => {
    const hostBridge: HostBridgeManifest = { mappings: [{ packageName: "lodash", globalName: "_" }] };

    expect(auditLockDecisionConformance(lock(hostRecord("lodash", "_")), { hostBridge })).toEqual([]);
  });

  // #5 verified which globals the preset chains install, and the audit derives them
  // from those records rather than listing them again.
  it("derives the preset-provided globals from #5's records", () => {
    expect(PRESET_PROVIDED_HOST_GLOBALS).toContainEqual({ globalName: "antd", preset: "AntDesign" });
    expect(PRESET_PROVIDED_HOST_GLOBALS).toContainEqual({ globalName: "dayjs", preset: "AntDesign" });
    expect(PRESET_PROVIDED_HOST_GLOBALS).toContainEqual({ globalName: "echarts", preset: "ECharts" });
  });

  it("reports a preset-provided global as conditional rather than wrong", () => {
    // A legal configuration, and calling it an error would make it unwritable. What
    // the lock cannot say is whether the cell's preset declares it, so the finding is
    // a fact the caller has to confirm.
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("antd", "antd")));

    expect(codes(diagnostics)).toEqual(["host-global-is-preset-provided"]);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.detail).toContain('the "AntDesign" preset library chain');
  });

  it("does not also report a preset-provided global as unprovided", () => {
    expect(codes(auditLockDecisionConformance(lock(hostRecord("dayjs", "dayjs"))))).toEqual([
      "host-global-is-preset-provided",
    ]);
  });

  // Review regression (#44, finding 2). #9 asks for a generated adapter that preserves
  // `jsx(type, props, key)`, not merely for "some global other than React". `ReactDOM`
  // is a verified host identity of kind `page-global`, so the cell compiler's binding
  // check passes it and no other layer can catch the substitution — which is why the
  // refusal cannot be narrowed to the React object.
  it("refuses every page global as the JSX runtime, not just the React object", () => {
    for (const globalName of ["React", "ReactDOM", "ReactJsxRuntime"]) {
      const diagnostics = auditLockDecisionConformance(lock(hostRecord("react/jsx-runtime", globalName)));

      expect(codes(diagnostics), globalName).toEqual(["jsx-runtime-requires-adapter"]);
      expect(diagnostics[0]?.detail, globalName).toContain("jsx(type, props, key)");
    }
  });

  // Review regression (#44, second round). Refusing only `host` left the module id
  // reachable as `inline`, which ships the real JSX runtime into the cell — the same
  // violation of #9 by a different route. The rule is about the module id, so it holds
  // for every strategy that would claim the module is *provided*.
  it("refuses the JSX runtime under every strategy that would provide it", () => {
    for (const moduleId of JSX_RUNTIME_MODULE_IDS) {
      const providing = [hostRecord(moduleId, "React"), inlineRecord(moduleId), extensionRecord(moduleId, "some-ext", "SomeExt")];

      for (const record of providing) {
        const diagnostics = auditLockDecisionConformance(lock(record));

        expect(codes(diagnostics), `${moduleId} as ${record.strategy}`).toEqual(["jsx-runtime-requires-adapter"]);
        expect(diagnostics[0]?.detail, `${moduleId} as ${record.strategy}`).toContain(
          `by a \`${record.strategy}\` decision`,
        );
      }
    }
  });

  it("refuses hosting React while its JSX runtime is inlined", () => {
    // The combination the reviewer asked for. The conflict check cannot see it — with the
    // JSX runtime out of the manifest these two records no longer fold onto one module —
    // so the adapter rule is what has to catch it.
    const diagnostics = auditLockDecisionConformance(
      lock(hostRecord("react", "React"), inlineRecord("react/jsx-runtime")),
    );

    expect(codes(diagnostics)).toEqual(["jsx-runtime-requires-adapter"]);
    // `react` itself is untouched by the finding, so the message points at the record
    // that is wrong rather than at the host decision beside it.
    expect(diagnostics[0]?.subject).toBe("react/jsx-runtime");
  });

  // The deliberate carve-out. `replace` is the strategy #4 provides for recording that a
  // candidate is not usable, and `host-module-identity-mismatch` is the rejection code
  // that already exists for this reason; refusing it too would leave no way to record
  // the refusal, so the question would be re-decided on every run.
  it("allows a replace decision for a JSX runtime module id", () => {
    const recorded = lock(replaceRecord("react/jsx-runtime"));

    // Both layers, so the carve-out is a claim about a writable lock rather than only
    // about what the audit tolerates: `core` has to accept the record and the audit has
    // to stay quiet about it.
    expect(validateFgcLockDocument(recorded)).toEqual([]);
    expect(auditLockDecisionConformance(recorded)).toEqual([]);
  });

  it("does not claim a JSX runtime global is unprovided on top of the refusal", () => {
    // The record is refused as a whole rather than also reported as an unprovided
    // global: these ids have no mapping to satisfy, so a "nothing provides this"
    // finding would describe a rule they are not subject to.
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("react/jsx-dev-runtime", "ReactDOM")));

    expect(codes(diagnostics)).toEqual(["jsx-runtime-requires-adapter"]);
  });

  // Review regression (#44, finding 3). Identity-sensitivity belongs to the mapping,
  // not to every `host` decision: `dayjs` is stateless, the lock is keyed per
  // (package, cell target), and #5 verified that each cell captures preset globals at
  // its own render instant.
  it("does not report a duplicate identity for a host mapping that has none", () => {
    const presetDayjs = { ...hostRecord("dayjs", "dayjs"), cellTarget: "orders-table" };
    const ownDayjs = { ...inlineRecord("dayjs"), cellTarget: "customers-card" };

    const diagnostics = auditLockDecisionConformance(lock(presetDayjs, ownDayjs));

    expect(codes(diagnostics)).not.toContain("host-inline-conflict");
  });

  it("checks that a host React decision carries the host's React version", () => {
    const differing: ForguncyTargetIdentity = { ...forguncyTargetIdentity(), hostReactVersion: "18.3.1" };

    expect(codes(auditLockDecisionConformance(lock(hostRecord("react", "React", { resolvedVersion: "19.2.7" }))))).toEqual(
      [],
    );
    expect(
      codes(auditLockDecisionConformance(lock(hostRecord("react", "React", { target: differing })))),
    ).toEqual(["host-react-version-is-not-host-identity"]);
  });

  it("does not check an identity it has no recorded target for", () => {
    // No target means the decision makes no runtime claim yet, which is a state
    // rather than a mismatch.
    expect(
      codes(
        auditLockDecisionConformance(lock(hostRecord("react", "React", { target: null, resolvedVersion: "0.0.0-dev" }))),
      ),
    ).toEqual([]);
  });

  it("refuses a second copy of a module whose identity is page-wide", () => {
    // Both decisions are under the same cell target here, and the finding is the same
    // when they are not: the page ends up with two React instances either way, which is
    // what `single-react-instance-per-page` makes observable from every cell.
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("react", "React"), inlineRecord("react")));

    expect(codes(diagnostics)).toEqual(["host-inline-conflict"]);
    expect(diagnostics[0]?.detail).toContain("page-wide");
  });

  it("refuses a second copy recorded under a different cell target", () => {
    // A per-cell decision cannot scope away a page-wide duplicate, so the cell target
    // is not an exemption.
    const diagnostics = auditLockDecisionConformance(
      lock(
        { ...hostRecord("react", "React"), cellTarget: "orders-table" },
        { ...inlineRecord("react"), cellTarget: "customers-card" },
      ),
    );

    expect(codes(diagnostics)).toEqual(["host-inline-conflict"]);
  });

  it("folds a subpath id onto the module its mapping covers", () => {
    // `react-dom/client` is an entry point into the ReactDOM that `react-dom` decided
    // `host`, not a module of its own, so keying the conflict on the specifier would
    // hide a real second copy.
    const diagnostics = auditLockDecisionConformance(
      lock(hostRecord("react-dom", "ReactDOM"), inlineRecord("react-dom/client")),
    );

    expect(codes(diagnostics)).toEqual(["host-inline-conflict"]);
    expect(diagnostics[0]?.subject).toBe("react-dom");
    expect(diagnostics[0]?.detail).toContain("react-dom/client");
  });

  it("does not invent a conflict from an extension or replace decision", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(hostRecord("react", "React"), extensionRecord("react-query", "tanstack-query", "TanStackQuery")),
    );

    expect(codes(diagnostics)).not.toContain("host-inline-conflict");
  });
});

describe("extension records against #12", () => {
  it("blocks an extension decision that has no catalog to check against", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery")),
    );

    expect(codes(diagnostics)).toEqual(["extension-catalog-missing"]);
    // An error rather than a warning: #12 makes the catalog a precondition for
    // accepting the decision, so "nothing checked this" is not a milder verdict than
    // "this is wrong".
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.detail).toContain("cannot be accepted");
  });

  it("accepts a mapping the catalog verifies", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery")),
      { extensionCatalog: catalog },
    );

    expect(diagnostics).toEqual([]);
  });

  it("accepts two packages sharing one extension", () => {
    // #12's reuse case, and the reason the catalog is keyed by package: one
    // extension standing in for several npm packages is supported, not a conflict.
    const diagnostics = auditLockDecisionConformance(
      lock(
        extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery"),
        extensionRecord("@tanstack/query-core", "tanstack-query", "TanStackQuery"),
      ),
      { extensionCatalog: catalog },
    );

    expect(diagnostics).toEqual([]);
  });

  it("refuses a library id nothing verifies", () => {
    const diagnostics = auditLockDecisionConformance(lock(extensionRecord("left-pad", "left-pad-ext", "LeftPad")), {
      extensionCatalog: catalog,
    });

    expect(codes(diagnostics)).toEqual(["extension-library-not-verified"]);
    expect(diagnostics[0]?.detail).toContain("never from a display name");
  });

  it("refuses a library id the catalog does not verify for this package", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(extensionRecord("@tanstack/react-query", "dayjs-ext", "Dayjs")),
      { extensionCatalog: catalog },
    );

    expect(codes(diagnostics)).toEqual(["extension-library-mismatch"]);
    expect(diagnostics[0]?.detail).toContain("tanstack-query/TanStackQuery");
  });

  it("refuses a global the verified library does not publish", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(extensionRecord("@tanstack/react-query", "tanstack-query", "ReactQuery")),
      { extensionCatalog: catalog },
    );

    expect(codes(diagnostics)).toEqual(["extension-global-mismatch"]);
    expect(diagnostics[0]?.detail).toContain('publishes "TanStackQuery"');
  });

  it("refuses one library recorded against two globals", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(
        extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery"),
        extensionRecord("@tanstack/query-core", "tanstack-query", "QueryCore"),
      ),
      { extensionCatalog: catalog },
    );

    // Both findings are real and both are reported: `QueryCore` is not the global the
    // catalog verifies for that library, *and* the lock as a whole now has one
    // library under two names. Collapsing them would hide the second behind the
    // first, and the second is the one a compiler cannot resolve.
    expect(codes(diagnostics)).toEqual(["extension-global-mismatch", "extension-library-global-conflict"]);
    expect(diagnostics[1]?.detail).toContain("One library publishes one global name");
  });

  it("refuses one global claimed by two libraries", () => {
    // A global holds one object, so at most one of these can be what the page
    // publishes.
    const diagnostics = auditLockDecisionConformance(
      lock(
        extensionRecord("@tanstack/react-query", "tanstack-query", "Shared"),
        extensionRecord("@tanstack/query-core", "query-core", "Shared"),
      ),
      { extensionCatalog: catalog },
    );

    expect(codes(diagnostics)).toContain("extension-global-library-conflict");
    expect(diagnostics.find(diagnostic => diagnostic.code === "extension-global-library-conflict")?.detail).toContain(
      "A global holds one object",
    );
  });

  // Review regression (#44, finding 1). #12 makes a verified catalog a
  // *precondition* for accepting an `extension` decision — "must come from
  // listFrontendLibraries or a verified catalog artifact" — so "there was nothing to
  // check against" and "there is nothing wrong" must not be the same answer.
  it("cannot validate an extension decision that was never checked against a catalog", () => {
    const neverChecked = lock(extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery"));

    expect(validateLockDecisionConformance(neverChecked)).not.toEqual([]);
  });

  it("does not treat an absent catalog and an empty one alike", () => {
    // Absent is "nothing to check against"; empty is "checked, and nothing is
    // verified" — which makes the decision wrong rather than merely unchecked.
    const absent = auditLockDecisionConformance(lock(extensionRecord("es-toolkit", "es-toolkit", "EsToolkit")));
    const empty = auditLockDecisionConformance(lock(extensionRecord("es-toolkit", "es-toolkit", "EsToolkit")), {
      extensionCatalog: { mappings: [] },
    });

    // Both block, by different routes, and the codes are what tell them apart:
    // absent is "the verification did not happen", empty is "it happened and this id
    // is not real".
    expect(codes(absent)).toEqual(["extension-catalog-missing"]);
    expect(codes(empty)).toEqual(["extension-library-not-verified"]);
  });
});

describe("the audit itself", () => {
  it("reports nothing for an empty lock", () => {
    expect(auditLockDecisionConformance(lock())).toEqual([]);
  });

  it("is deterministic regardless of the lock's record order", () => {
    const decisions = [
      hostRecord("react", "ReactDOM"),
      hostRecord("lodash", "_"),
      extensionRecord("es-toolkit", "es-toolkit", "EsToolkit"),
    ];

    const forward = auditLockDecisionConformance(lock(...decisions));
    const reversed = auditLockDecisionConformance(lock(...[...decisions].reverse()));

    expect(reversed).toEqual(forward);
    // Canonical decision order, not the order the records arrived in.
    expect(codes(forward)).toEqual(["extension-catalog-missing", "host-global-not-provided", "host-mapping-mismatch"]);
  });

  it("never throws, and separates what is wrong from what needs confirming", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(hostRecord("antd", "antd"), hostRecord("lodash", "_"), hostRecord("react", "ReactDOM")),
    );

    expect(codes(diagnostics)).toEqual([
      "host-global-is-preset-provided",
      "host-global-not-provided",
      "host-mapping-mismatch",
    ]);
    expect(conformanceErrors(diagnostics).map(diagnostic => diagnostic.code)).toEqual([
      "host-global-not-provided",
      "host-mapping-mismatch",
    ]);

    // The imperative form a caller composes into a diagnostic stream: errors only,
    // code preserved.
    expect(validateLockDecisionConformance(lock(hostRecord("antd", "antd")))).toEqual([]);
    const problems = validateLockDecisionConformance(lock(hostRecord("lodash", "_")));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("lodash: [host-global-not-provided]");
  });

  it("projects #9's host bridge table instead of shipping a table of its own", () => {
    // The constant used to hold #9's stated candidates with a comment promising
    // that "the real host-bridge table replaces this once #9 lands". #9 landed it
    // in `core`, so the assertion is no longer "these are the three packages" but
    // "this is `core`'s table, projected" — a lock audit that disagreed with the
    // compiler about which global a package maps to would be checking a target
    // nobody compiles against.
    expect(DEFAULT_HOST_BRIDGE_MANIFEST.mappings.map(mapping => mapping.packageName)).toEqual(
      hostBridgeGlobalMappings().map(mapping => mapping.specifier),
    );

    for (const derived of DEFAULT_HOST_BRIDGE_MANIFEST.mappings) {
      const source = HOST_BRIDGE_MAPPINGS.find(mapping => mapping.specifier === derived.packageName);
      expect(source, derived.packageName).toBeDefined();
      expect(source?.kind).toBe("host-global");
      if (source?.kind !== "host-global") continue;
      expect(derived.globalName, derived.packageName).toBe(source.globalName);
      expect(derived.moduleIds, derived.packageName).toEqual(source.moduleIds);
      expect(derived.identityField, derived.packageName).toBe(source.identityField);
      expect(derived.identitySensitive, derived.packageName).toBe(source.identitySensitive);
    }

    // Only the two modules #5 and #9 say must not be duplicated carry the flag.
    expect(
      DEFAULT_HOST_BRIDGE_MANIFEST.mappings.filter(mapping => mapping.identitySensitive === true).map(mapping => mapping.packageName),
    ).toEqual(["react", "react-dom"]);
  });

  // The JSX runtime ids are refused as `host` decisions, so a bridge that mapped one
  // would be describing a mapping the audit never consults.
  it("ships no host mapping for a JSX runtime module id", () => {
    const mapped = DEFAULT_HOST_BRIDGE_MANIFEST.mappings.flatMap(mapping => [
      mapping.packageName,
      ...(mapping.moduleIds ?? []),
    ]);

    for (const moduleId of JSX_RUNTIME_MODULE_IDS) {
      expect(mapped, moduleId).not.toContain(moduleId);
    }
  });
});
