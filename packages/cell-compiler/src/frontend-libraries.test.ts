import { describe, expect, it } from "vitest";

import { FRONTEND_LIBRARY_REFERENCE_EXAMPLE } from "@forguncy-react-workspace/core";
import type { DependencyDecision, FrontendLibraryReference } from "@forguncy-react-workspace/core";

import {
  FRONTEND_LIBRARIES_FIELD_NAME,
  FRONTEND_LIBRARY_REFERENCE_FIELD_NAME,
  FRONTEND_LIBRARY_REFERENCE_KEYS,
  auditFrontendLibraries,
  canonicalizeFrontendLibraries,
  collectFrontendLibraries,
  compareFrontendLibraries,
  frontendLibraryIds,
  frontendLibraryReference,
  isCanonicalFrontendLibraries,
} from "./frontend-libraries.ts";

const extensionDecision = (packageName: string, libraryId: string, globalName: string): DependencyDecision => ({
  strategy: "extension",
  packageName,
  libraryId,
  globalName,
});

describe("the reference shape", () => {
  it("takes its field names from the runtime contract rather than restating them", () => {
    expect(FRONTEND_LIBRARY_REFERENCE_FIELD_NAME).toBe("libraryId");
    expect(FRONTEND_LIBRARY_REFERENCE_KEYS).toEqual(Object.keys(FRONTEND_LIBRARY_REFERENCE_EXAMPLE));
    expect(FRONTEND_LIBRARIES_FIELD_NAME).toBe("frontendLibraries");
  });

  it("builds a reference carrying only the id", () => {
    const reference = frontendLibraryReference("lib-echarts");
    expect(reference).toEqual({ libraryId: "lib-echarts" });
    expect(Object.keys(reference)).toEqual(FRONTEND_LIBRARY_REFERENCE_KEYS);
  });
});

describe("canonical form", () => {
  // Code-point order, not `localeCompare`: the artifact has to be byte-stable
  // across machines, and a locale-sensitive order is not.
  it("orders by code point, so a different locale cannot reorder an artifact", () => {
    const libraries = [frontendLibraryReference("a"), frontendLibraryReference("B")];
    const canonical = canonicalizeFrontendLibraries(libraries);

    expect(frontendLibraryIds(canonical)).toEqual(["B", "a"]);
    expect(compareFrontendLibraries(frontendLibraryReference("B"), frontendLibraryReference("a"))).toBe(-1);
    expect(compareFrontendLibraries(frontendLibraryReference("a"), frontendLibraryReference("a"))).toBe(0);
    // The contrast that makes the assertion above meaningful.
    expect(["B", "a"].sort((left, right) => left.localeCompare(right))).toEqual(["a", "B"]);
  });

  it("sorts and deduplicates, and drops references with no usable id", () => {
    const canonical = canonicalizeFrontendLibraries([
      frontendLibraryReference("zeta"),
      frontendLibraryReference("  "),
      frontendLibraryReference("alpha"),
      frontendLibraryReference("alpha"),
    ]);

    expect(frontendLibraryIds(canonical)).toEqual(["alpha", "zeta"]);
  });

  it("recognises the canonical form", () => {
    expect(isCanonicalFrontendLibraries([])).toBe(true);
    expect(isCanonicalFrontendLibraries([frontendLibraryReference("a"), frontendLibraryReference("b")])).toBe(true);

    expect(isCanonicalFrontendLibraries([frontendLibraryReference("b"), frontendLibraryReference("a")])).toBe(false);
    expect(isCanonicalFrontendLibraries([frontendLibraryReference("a"), frontendLibraryReference("a")])).toBe(false);
    expect(isCanonicalFrontendLibraries([frontendLibraryReference("")])).toBe(false);
  });

  it("rejects a reference carrying a field the persisted shape does not allow", () => {
    const widened = { libraryId: "lib-echarts", name: "ECharts" } as unknown as FrontendLibraryReference;
    expect(isCanonicalFrontendLibraries([widened])).toBe(false);
  });
});

describe("collecting metadata from decisions", () => {
  it("takes one reference per extension library and nothing else", () => {
    const collection = collectFrontendLibraries([
      { strategy: "inline", packageName: "es-toolkit" },
      { strategy: "host", packageName: "react", globalName: "React" },
      extensionDecision("echarts", "lib-echarts", "echarts"),
      {
        strategy: "replace",
        packageName: "react-router-dom",
        rejection: {
          kind: "architectural",
          code: "application-router-conflict",
          summary: "navigation is host-owned",
          remediation: "use host navigation",
        },
      },
    ]);

    expect(frontendLibraryIds(collection.libraries)).toEqual(["lib-echarts"]);
    expect(collection.diagnostics).toEqual([]);
  });

  // Sharing one extension across packages is the reuse `extension` exists for, so
  // it must collapse silently rather than read as a duplicate.
  it("collapses two packages sharing one extension library", () => {
    const collection = collectFrontendLibraries([
      extensionDecision("echarts", "lib-echarts", "echarts"),
      extensionDecision("echarts-for-react", "lib-echarts", "echarts"),
    ]);

    expect(frontendLibraryIds(collection.libraries)).toEqual(["lib-echarts"]);
    expect(collection.diagnostics).toEqual([]);
  });

  it("reports an extension decision with no usable id or global", () => {
    const noId = collectFrontendLibraries([extensionDecision("echarts", "   ", "echarts")]);
    expect(noId.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["missing-extension-mapping"]);
    expect(noId.diagnostics[0]?.subject).toBe("echarts");

    const noGlobal = collectFrontendLibraries([extensionDecision("echarts", "lib-echarts", "")]);
    expect(noGlobal.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["missing-extension-mapping"]);
  });
});

describe("auditing metadata that was assembled elsewhere", () => {
  it("accepts the canonical form", () => {
    expect(auditFrontendLibraries([])).toEqual([]);
    expect(auditFrontendLibraries([frontendLibraryReference("a"), frontendLibraryReference("b")])).toEqual([]);
  });

  it("reports an unsorted list, because order is what determinism rests on", () => {
    const diagnostics = auditFrontendLibraries([frontendLibraryReference("b"), frontendLibraryReference("a")]);
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["non-canonical-artifact-metadata"]);
    expect(diagnostics[0]?.message).toMatch(/not ordered/);
  });

  it("reports a repeated library id", () => {
    const diagnostics = auditFrontendLibraries([frontendLibraryReference("a"), frontendLibraryReference("a")]);
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["non-canonical-artifact-metadata"]);
    expect(diagnostics[0]?.message).toMatch(/more than once/);
  });

  it("reports a reference with no id under the extension-mapping code", () => {
    const diagnostics = auditFrontendLibraries([frontendLibraryReference("")]);
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["missing-extension-mapping"]);
  });

  it("reports a reference carrying extra fields", () => {
    const widened = { libraryId: "a", name: "A" } as unknown as FrontendLibraryReference;
    const diagnostics = auditFrontendLibraries([widened]);
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["non-canonical-artifact-metadata"]);
    expect(diagnostics[0]?.message).toMatch(/also carries name/);
  });
});
