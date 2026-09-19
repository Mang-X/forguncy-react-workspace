import { describe, expect, it } from "vitest";

import type {
  ConformanceDiagnostic,
  ConformanceProblemCode,
  ExtensionCatalog,
  FgcLockDocument,
  ForguncyTargetIdentity,
  HostBridgeManifest,
  LockedDependencyDecision,
} from "./index";
import {
  auditLockDecisionConformance,
  conformanceErrors,
  DEFAULT_HOST_BRIDGE_MANIFEST,
  FGC_LOCK_SCHEMA_VERSION,
  forguncyTargetIdentity,
  PRESET_PROVIDED_HOST_GLOBALS,
  validateLockDecisionConformance,
} from "./index";

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

  it("refuses mapping a JSX runtime to the React object", () => {
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("react/jsx-runtime", "React")));

    expect(codes(diagnostics)).toContain("host-jsx-runtime-mapped-to-react-object");
    expect(diagnostics[0]?.detail).toContain("jsx(type, props, key)");
  });

  it("accepts a JSX runtime mapped to something other than the React object", () => {
    // #9 requires an explicit adapter, so an adapter global is the correct answer —
    // the finding is specifically about the React object, not about the module id.
    expect(codes(auditLockDecisionConformance(lock(hostRecord("react/jsx-runtime", "ReactJsxRuntime"))))).toEqual([]);
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

  it("refuses a second copy of a page-wide host module", () => {
    // A host global is page-wide, so the inlined copy is a duplicate instance
    // whichever cell each decision was recorded for.
    const diagnostics = auditLockDecisionConformance(lock(hostRecord("react", "React"), inlineRecord("react")));

    expect(codes(diagnostics)).toEqual(["host-inline-conflict"]);
    expect(diagnostics[0]?.detail).toContain("page-wide");
  });

  it("does not invent a conflict from an extension or replace decision", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(hostRecord("react", "React"), extensionRecord("react-query", "tanstack-query", "TanStackQuery")),
    );

    expect(codes(diagnostics)).not.toContain("host-inline-conflict");
  });
});

describe("extension records against #12", () => {
  it("says when there is no catalog to check against", () => {
    const diagnostics = auditLockDecisionConformance(
      lock(extensionRecord("@tanstack/react-query", "tanstack-query", "TanStackQuery")),
    );

    expect(codes(diagnostics)).toEqual(["extension-catalog-missing"]);
    expect(diagnostics[0]?.severity).toBe("warning");
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

  it("does not treat an absent catalog and an empty one alike", () => {
    // Absent is "nothing to check against"; empty is "checked, and nothing is
    // verified" — which makes the decision wrong rather than merely unchecked.
    const absent = auditLockDecisionConformance(lock(extensionRecord("es-toolkit", "es-toolkit", "EsToolkit")));
    const empty = auditLockDecisionConformance(lock(extensionRecord("es-toolkit", "es-toolkit", "EsToolkit")), {
      extensionCatalog: { mappings: [] },
    });

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

  it("ships a default host bridge that is the one #9's table replaces", () => {
    // Asserted so replacing the table with #9's real one is a visible change to a
    // test rather than a silent edit to a constant.
    expect(DEFAULT_HOST_BRIDGE_MANIFEST.mappings.map(mapping => mapping.packageName)).toEqual([
      "react",
      "react-dom",
      "antd",
    ]);
    expect(DEFAULT_HOST_BRIDGE_MANIFEST.mappings.find(mapping => mapping.packageName === "react")?.identityField).toBe(
      "hostReactVersion",
    );
  });
});
