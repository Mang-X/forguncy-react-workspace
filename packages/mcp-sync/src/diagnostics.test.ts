import { describe, expect, it } from "vitest";

import { EXTENSION_EXTERNAL_DIAGNOSTIC_CODES } from "@forguncy-react-workspace/core";
import type {
  ExtensionExternalDiagnostic,
  ExtensionExternalDiagnosticCode,
} from "@forguncy-react-workspace/core";

import {
  CONTRACT_SYNC_DIAGNOSTIC_CODES,
  createSyncDiagnostic,
  dedupeSyncDiagnostics,
  EXTENSION_AUDIT_DETECTOR,
  EXTENSION_AUDIT_TRANSLATION,
  EXTENSION_CREATION_DELEGATE,
  formatSyncDiagnostic,
  formatSyncDiagnostics,
  isSyncDiagnosticCode,
  REQUIRED_SYNC_DIAGNOSTIC_CODES,
  syncDiagnosticCodes,
  syncDiagnosticFromExtensionAudit,
  syncDiagnosticRule,
  SYNC_DIAGNOSTIC_CODES,
  SYNC_DIAGNOSTIC_RULES,
  translatedExtensionAuditCodes,
} from "./diagnostics.ts";
import type { SyncDiagnostic, SyncDiagnosticCode } from "./diagnostics.ts";
import { SYNC_GUARANTEE_IDS } from "./guarantees.ts";

/**
 * The error model is the part of #19 an Agent reads before choosing a next action. These
 * tests hold three properties: every code #19 names is reportable, every code says who has
 * to fix it and whether it stops the write, and the extension half is a *translation* of
 * #12's audit rather than a second implementation of it.
 */

const BLOCKING_CODES: readonly SyncDiagnosticCode[] = [
  "missing-extension",
  "extension-metadata-unverified",
  "cell-diverged",
  "cell-state-unverifiable",
  "artifact-not-generated",
  "extension-identity-mismatch",
  "extension-decision-unusable",
  "library-reference-mismatch",
  "sync-capability-unestablished",
];

const NON_BLOCKING_CODES: readonly SyncDiagnosticCode[] = [
  "project-errors-after-sync",
  "runtime-generation-failed",
];

const ALL_CODES = [...BLOCKING_CODES, ...NON_BLOCKING_CODES];

describe("the sync diagnostic vocabulary", () => {
  it("carries every condition #19 names, in its own words first", () => {
    expect([...REQUIRED_SYNC_DIAGNOSTIC_CODES]).toEqual([
      "missing-extension",
      "extension-metadata-unverified",
      "project-errors-after-sync",
      "runtime-generation-failed",
      "cell-diverged",
      "cell-state-unverifiable",
    ]);
    expect([...SYNC_DIAGNOSTIC_CODES]).toEqual([
      ...REQUIRED_SYNC_DIAGNOSTIC_CODES,
      ...CONTRACT_SYNC_DIAGNOSTIC_CODES,
    ]);
  });

  it("has a rule for every code, keyed by that code", () => {
    expect(Object.keys(SYNC_DIAGNOSTIC_RULES).sort()).toEqual([...SYNC_DIAGNOSTIC_CODES].sort());
    for (const code of SYNC_DIAGNOSTIC_CODES) {
      const rule = syncDiagnosticRule(code);
      expect(rule.code, code).toBe(code);
      expect(rule.label.length, code).toBeGreaterThan(0);
      expect(rule.states.length, code).toBeGreaterThan(0);
      // A diagnostic is not a dead end: every rule has to say what to do about it.
      expect(rule.remediation.length, code).toBeGreaterThan(0);
      expect(["issue-19-flow", "issue-19-safety", "sync-contract"], code).toContain(rule.origin);
    }
  });

  it("breaks only guarantees that exist", () => {
    for (const code of SYNC_DIAGNOSTIC_CODES) {
      for (const guarantee of syncDiagnosticRule(code).breaksGuarantees) {
        expect(SYNC_GUARANTEE_IDS, `${code} -> ${guarantee}`).toContain(guarantee);
      }
    }
  });

  it("recognises its own codes and nothing else", () => {
    for (const code of SYNC_DIAGNOSTIC_CODES) expect(isSyncDiagnosticCode(code)).toBe(true);
    expect(isSyncDiagnosticCode("extension-not-declared")).toBe(false);
    expect(isSyncDiagnosticCode(19)).toBe(false);
  });
});

describe("whether a finding stops the write", () => {
  it("says so explicitly on every rule, never by omission", () => {
    for (const code of SYNC_DIAGNOSTIC_CODES) {
      expect(typeof syncDiagnosticRule(code).blocksMutation, code).toBe("boolean");
    }
  });

  it("blocks on everything that can still prevent the mutation", () => {
    for (const code of BLOCKING_CODES) expect(syncDiagnosticRule(code).blocksMutation, code).toBe(true);
  });

  // A consequence of a write that already happened cannot stop it. The distinction is the
  // reason the field is on the rule rather than inferred from a set of codes: a new code
  // would otherwise be non-blocking by default, which is a fail-open default on the one
  // axis where being wrong writes over something.
  it("does not pretend to block on the two post-mutation gates", () => {
    for (const code of NON_BLOCKING_CODES) expect(syncDiagnosticRule(code).blocksMutation, code).toBe(false);
    expect([...ALL_CODES].sort()).toEqual([...SYNC_DIAGNOSTIC_CODES].sort());
  });
});

describe("translating #12's extension audit", () => {
  it("covers every code the audit can produce, and only those", () => {
    expect(Object.keys(EXTENSION_AUDIT_TRANSLATION).sort()).toEqual([...EXTENSION_EXTERNAL_DIAGNOSTIC_CODES].sort());
    expect([...translatedExtensionAuditCodes()].sort()).toEqual([...EXTENSION_EXTERNAL_DIAGNOSTIC_CODES].sort());
  });

  // The type, not this assertion, is the guard: a total `Record` over the union means a new
  // code in `core` fails this package's type check rather than being silently dropped.
  it("is total over the audit's codes as a type", () => {
    const translation: Readonly<Record<ExtensionExternalDiagnosticCode, SyncDiagnosticCode>> =
      EXTENSION_AUDIT_TRANSLATION;
    expect(Object.keys(translation)).toHaveLength(EXTENSION_EXTERNAL_DIAGNOSTIC_CODES.length);
  });

  it("groups by fix route rather than by wording", () => {
    // Absent from the project: the fix is to build and upload an extension elsewhere.
    expect(EXTENSION_AUDIT_TRANSLATION["extension-library-unverified"]).toBe("missing-extension");
    // Present but broken: the fix is this project's install, so delegating would replace a
    // fixable install with a second package.
    for (const code of [
      "extension-global-mismatch",
      "extension-bundle-missing",
      "extension-types-missing",
      "extension-global-missing",
    ] as const) {
      expect(EXTENSION_AUDIT_TRANSLATION[code], code).toBe("extension-identity-mismatch");
    }
    expect(EXTENSION_AUDIT_TRANSLATION["extension-mapping-missing"]).toBe("extension-decision-unusable");
    expect(EXTENSION_AUDIT_TRANSLATION["extension-mapping-conflict"]).toBe("extension-decision-unusable");
    expect(EXTENSION_AUDIT_TRANSLATION["extension-not-declared"]).toBe("library-reference-mismatch");
  });

  it("sends a missing extension to the one repository #19 delegates to", () => {
    expect(EXTENSION_CREATION_DELEGATE.repository).toBe("MangMax/forguncy-frontend-library");

    const diagnostic = createSyncDiagnostic("missing-extension", "@tanstack/react-query");
    expect(diagnostic.delegate).toBe(EXTENSION_CREATION_DELEGATE);
    expect(diagnostic.fixOwner).toBe("extension-package");
    // Only that one code delegates: everything else has a fix inside this project.
    expect(createSyncDiagnostic("cell-diverged", "Page!cell").delegate).toBeUndefined();
  });

  it("reports an audit finding in the sync vocabulary, keeping the origin visible", () => {
    const finding: ExtensionExternalDiagnostic = {
      code: "extension-global-mismatch",
      subject: "@tanstack/react-query",
      detail: "Library \"tanstack-query\" publishes \"SomethingElse\".",
    };
    const translated = syncDiagnosticFromExtensionAudit(finding);

    expect(translated.code).toBe("extension-identity-mismatch");
    expect(translated.subject).toBe(finding.subject);
    expect(translated.message).toContain(finding.detail);
    expect(translated.derivedFrom).toEqual({
      detectedBy: EXTENSION_AUDIT_DETECTOR,
      code: "extension-global-mismatch",
    });
    // The sync-side fix is the project's install, not a new package: an id that resolves is
    // not a missing extension.
    expect(translated.fixOwner).toBe("project-state");
    expect(translated.delegate).toBeUndefined();
  });

  it("names the upstream code, which four audit codes can reach one sync code through", () => {
    // The reason `derivedFrom` is set by the translation rather than on the rule: a single
    // rule-level origin could name only one of these.
    const codes = ["extension-global-mismatch", "extension-bundle-missing", "extension-types-missing"] as const;
    const translated = codes.map(code =>
      syncDiagnosticFromExtensionAudit({ code, subject: "@tanstack/react-query", detail: "…" }),
    );

    expect(translated.map(diagnostic => diagnostic.code)).toEqual([
      "extension-identity-mismatch",
      "extension-identity-mismatch",
      "extension-identity-mismatch",
    ]);
    expect(translated.map(diagnostic => diagnostic.derivedFrom?.code)).toEqual([...codes]);
  });

  it("translates every code the audit produces without throwing", () => {
    for (const code of EXTENSION_EXTERNAL_DIAGNOSTIC_CODES) {
      const translated = syncDiagnosticFromExtensionAudit({ code, subject: "subject", detail: "detail" });
      expect(translated.code, code).toBe(EXTENSION_AUDIT_TRANSLATION[code]);
      expect(translated.message, code).toContain("detail");
    }
  });
});

describe("building a diagnostic from its rule", () => {
  it("appends the per-occurrence fact to the rule's own sentence", () => {
    const rule = syncDiagnosticRule("cell-diverged");
    const diagnostic = createSyncDiagnostic("cell-diverged", "OrderPage!cell-1", { detail: "…" });

    expect(diagnostic.message.startsWith(rule.states)).toBe(true);
    expect(diagnostic.message.endsWith("…")).toBe(true);
    expect(diagnostic.remediation).toBe(rule.remediation);
    expect(diagnostic.fixOwner).toBe(rule.fixOwner);
  });

  // A rule-level derivation would be wrong here: sync reaches this code both by comparing
  // references against decisions itself, and by translating the compiler's
  // `extension-not-declared`. Only the translation knows which one it was.
  it("keeps the origin off a diagnostic sync detected itself", () => {
    expect(createSyncDiagnostic("library-reference-mismatch", "lib-a").derivedFrom).toBeUndefined();
    expect(
      syncDiagnosticFromExtensionAudit({ code: "extension-not-declared", subject: "lib-a", detail: "…" }).derivedFrom,
    ).toEqual({ detectedBy: EXTENSION_AUDIT_DETECTOR, code: "extension-not-declared" });
  });

  it("names the package that owns the vocabulary, not the call site", () => {
    // Two detectors raise through `core`'s vocabulary — its own metadata audit and the
    // compiler's plan — so the code is the only thing that distinguishes them.
    expect(EXTENSION_AUDIT_DETECTOR).toBe("@forguncy-react-workspace/core");
  });

  it("uses the rule's sentence alone when there is no detail", () => {
    expect(createSyncDiagnostic("cell-diverged", "OrderPage!cell-1").message).toBe(
      syncDiagnosticRule("cell-diverged").states,
    );
  });
});

describe("collapsing the same finding from overlapping detectors", () => {
  it("keeps one diagnostic per code and subject", () => {
    const diagnostics: readonly SyncDiagnostic[] = [
      createSyncDiagnostic("missing-extension", "lib-a"),
      createSyncDiagnostic("missing-extension", "lib-a", { detail: "second detector" }),
      createSyncDiagnostic("missing-extension", "lib-b"),
      createSyncDiagnostic("cell-diverged", "lib-a"),
    ];

    const deduped = dedupeSyncDiagnostics(diagnostics);

    expect(syncDiagnosticCodes(deduped)).toEqual([
      "missing-extension",
      "missing-extension",
      "cell-diverged",
    ]);
    expect(deduped[1]?.subject).toBe("lib-b");
  });
});

describe("reporting", () => {
  it("prints the code, the subject, the fix owner and the routing it needs", () => {
    const line = formatSyncDiagnostic(createSyncDiagnostic("missing-extension", "lib-a"));

    expect(line).toContain("[missing-extension] lib-a:");
    expect(line).toContain("Fix (extension-package):");
    expect(line).toContain(EXTENSION_CREATION_DELEGATE.repository);

    const derived = formatSyncDiagnostic(
      syncDiagnosticFromExtensionAudit({ code: "extension-not-declared", subject: "lib-a", detail: "…" }),
    );
    expect(derived).toContain('Detected by @forguncy-react-workspace/core as "extension-not-declared"');
  });

  it("says so when there is nothing to report", () => {
    expect(formatSyncDiagnostics([])).toBe("No sync diagnostics.");
    expect(formatSyncDiagnostics([createSyncDiagnostic("cell-diverged", "OrderPage!cell-1")])).toMatch(/^- \[/);
  });
});
