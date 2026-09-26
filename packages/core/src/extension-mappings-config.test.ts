/**
 * The project-level extension mapping input (#85), against its acceptance criteria.
 *
 * Decision source: GitHub Issue #85 — "扩展配置：建立项目级 mappings 输入与统一校验入口"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/85), under Epic #81.
 *
 * #85's acceptance list is what this file is organised around, one block per
 * criterion, because the criteria are the specification and a test file that
 * organised itself by function would leave a reader asking which criterion a test
 * was for:
 *
 * - "一个不在内置表中的扩展可仅通过项目配置获得规范化映射" — {@link describe} "a project row"}.
 * - "确切子路径匹配；未声明子路径不被前缀规则悄悄截获" — the subpath block, which is the one
 *   place a *wider* table could regress an existing exactness guarantee.
 * - "冲突在编译/写入前给出具体配置位置，不静默覆盖" — the conflict block, asserted on the
 *   `path` rather than on the message, because "the location" is the criterion.
 * - "缺省配置保留当前 TanStack Query 用例；显式空配置语义被测试" — the four-state block.
 * - "JSON/TS 配置、目录和 listing 的职责边界在本票和测试中一致" — the boundary block, whose
 *   point is that a listing cannot become a mapping.
 *
 * Every refusal here is asserted to be *reproducible*: the same config normalized
 * twice must give the same diagnostics, because a config diagnostic is read by a
 * person and pasted into a review comment.
 */

import { describe, expect, it } from "vitest";

import {
  assertExtensionExternalMappingsAreUnambiguous,
  EXTENSION_EXTERNAL_MAPPINGS,
  findExtensionExternalMapping,
} from "./index.ts";
import type { ExtensionExternalMapping } from "./index.ts";
import {
  DEFAULT_BUILTIN_MAPPINGS,
  extensionMappingOrigin,
  formatExtensionMappingsConfig,
  normalizeExtensionMappings,
} from "./extension-mappings-config.ts";
import type { NormalizeExtensionMappingsOptions, NormalizedExtensionMappings } from "./extension-mappings-config.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A row that is not in the built-in table, and is shaped exactly like one that is.
 *
 * Every field the built-in TanStack Query row carries is present, because the point
 * of #85 is that a project row is *the same kind of thing* — the reason the built-in
 * table could not be extended from a project before was that no path existed, not
 * that the shape was different.
 */
function projectMapping(overrides: Partial<ExtensionExternalMapping> = {}): ExtensionExternalMapping {
  return {
    packageName: "some-package",
    libraryId: "some-library",
    globalName: "SomeLibrary",
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule: "A catalog entry whose id and global the listing confirms.",
    verifiedBy: ["product-documentation"],
    note: "synthetic project row",
    ...overrides,
  };
}

/** The same row, as a config writes it — a plain object rather than a typed value. */
function projectMappingConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: "some-package",
    libraryId: "some-library",
    globalName: "SomeLibrary",
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule: "A catalog entry whose id and global the listing confirms.",
    verifiedBy: ["product-documentation"],
    note: "synthetic project row",
    ...overrides,
  };
}

/** The normalization, or a failure that prints the diagnostics instead of an empty diff. */
function normalizeOrThrow(
  config: unknown,
  options: NormalizeExtensionMappingsOptions = {},
): NormalizedExtensionMappings {
  const result = normalizeExtensionMappings(config, options);
  if (!result.ok) {
    throw new Error(
      `Expected this config to normalize:\n${result.diagnostics
        .map(diagnostic => `${diagnostic.path}: [${diagnostic.code}] ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return result.mappings;
}

/** The diagnostics of a config that must fail to normalize. */
function diagnosticsOf(config: unknown): readonly { readonly code: string; readonly path: string; readonly message: string }[] {
  const result = normalizeExtensionMappings(config);
  if (result.ok) {
    throw new Error("Expected this config to be refused, and it normalized instead.");
  }
  return result.diagnostics;
}

const tanStackQueryRow = EXTENSION_EXTERNAL_MAPPINGS.find(row => row.packageName === "@tanstack/react-query");

/**
 * Whether a normalized set contains a row for a package, by value.
 *
 * A helper rather than `toContain(row)`, and the difference is the point of the freeze
 * work: the normalized rows are *copies* of the table's, so an identity comparison against
 * a row read from `EXTENSION_EXTERNAL_MAPPINGS` would fail while the content is right.
 * Comparing by value is also the stronger assertion — it pins what the row says rather
 * than which object it is.
 */
function hasRowFor(mappings: NormalizedExtensionMappings, packageName: string): boolean {
  return mappings.mappings.some(row => row.packageName === packageName);
}

// ---------------------------------------------------------------------------
// The four states, and the TanStack Query default
// ---------------------------------------------------------------------------

describe("the four states of the `extensions` block", () => {
  it("keeps the built-in table when the config says nothing about extensions", () => {
    // #85's criterion: a config that declares no extensions keeps today's behaviour.
    const normalized = normalizeOrThrow({ cells: {} });

    expect(normalized.source).toBe("builtin-default");
    expect(normalized.includesBuiltinMappings).toBe(true);
    expect(normalized.projectMappings).toEqual([]);
    expect(normalized.mappings).toEqual(EXTENSION_EXTERNAL_MAPPINGS);
    expect(tanStackQueryRow).toBeDefined();
    expect(hasRowFor(normalized, "@tanstack/react-query")).toBe(true);
  });

  it("adds a project's rows to the built-in table rather than replacing it", () => {
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { mappings: [projectMappingConfig()] },
    });

    expect(normalized.source).toBe("project-extended");
    expect(normalized.includesBuiltinMappings).toBe(true);
    // The built-ins first, then the project's, so a reader of a report can see which
    // half a row came from without comparing against two lists.
    expect(normalized.mappings.slice(0, EXTENSION_EXTERNAL_MAPPINGS.length)).toEqual(EXTENSION_EXTERNAL_MAPPINGS);
    expect(normalized.mappings.at(-1)?.packageName).toBe("some-package");
    expect(hasRowFor(normalized, "@tanstack/react-query")).toBe(true);
  });

  it("treats an explicit opt-out as a stated empty set, not as an unstated one", () => {
    // The distinction the whole object shape exists for. `builtinMappings: false`
    // with no rows is a project *saying* it uses no built-in mappings — reading that
    // as "unspecified" would put the TanStack Query row back into a config that
    // deliberately removed it.
    const normalized = normalizeOrThrow({ cells: {}, extensions: { builtinMappings: false } });

    expect(normalized.source).toBe("project-only");
    expect(normalized.includesBuiltinMappings).toBe(false);
    expect(normalized.mappings).toEqual([]);
    expect(normalized.projectMappings).toEqual([]);
  });

  it("normalizes an opted-out project's own rows to exactly those rows", () => {
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { builtinMappings: false, mappings: [projectMappingConfig()] },
    });

    expect(normalized.source).toBe("project-only");
    expect(normalized.mappings).toHaveLength(1);
    expect(normalized.mappings[0]?.packageName).toBe("some-package");
  });

  it("defaults `builtinMappings` to true rather than to false", () => {
    // Asserted as a constant rather than only through behaviour, because the direction
    // is the criterion: a misspelled value keeps the built-ins, so the default has to
    // be the direction that cannot silently drop a row.
    expect(DEFAULT_BUILTIN_MAPPINGS).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A project row reaches the compiler's plan
// ---------------------------------------------------------------------------

describe("a project row that is not in the built-in table", () => {
  it("becomes an interceptable row without any change to `core`'s table", () => {
    // #85's first criterion. The *plan* half of it — that the compiler generates a
    // module and a library reference from this row — is asserted in
    // `cell-compiler`'s `extension-mappings-config.test.ts`, because that is the package
    // that owns the plan and `core` may not import it. What is asserted here is the half
    // `core` owns: the row is in the normalized set and the table's own lookup finds it.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [
          projectMappingConfig({ packageName: "@acme/widgets", libraryId: "acme-widgets", globalName: "AcmeWidgets" }),
        ],
      },
    });

    // The built-in table is untouched — the assertion that makes "without modifying the
    // built-in table" falsifiable rather than a claim about which file was edited.
    expect(EXTENSION_EXTERNAL_MAPPINGS.map(row => row.packageName)).not.toContain("@acme/widgets");
    expect(normalized.mappings.map(row => row.packageName)).toContain("@acme/widgets");
    expect(findExtensionExternalMapping("@acme/widgets", normalized.mappings)?.libraryId).toBe("acme-widgets");
    expect(findExtensionExternalMapping("@acme/widgets")).toBeUndefined();
  });

  it("carries a declared moduleIds list through to the normalized row", () => {
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [projectMappingConfig({ packageName: "@acme/widgets", moduleIds: ["@acme/widgets-core"] })],
      },
    });

    // Two module ids, one library: #12's "one extension stands in for more than one
    // package", which a project row inherits rather than re-implementing.
    expect(normalized.mappings.find(row => row.packageName === "@acme/widgets")?.moduleIds).toEqual([
      "@acme/widgets-core",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Subpath exactness
// ---------------------------------------------------------------------------

describe("a project row intercepts exactly the module ids it lists", () => {
  it("leaves an undeclared subpath of a project row unbridged", () => {
    // #85's second criterion. The mapping table's exactness is a property of
    // `findExtensionExternalMapping`, and this asserts the property survives a table a
    // project supplied — a normalization that folded ids, or a caller that compared by
    // prefix, would be the regression this pins.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ packageName: "@acme/widgets" })] },
    });

    expect(findExtensionExternalMapping("@acme/widgets", normalized.mappings)).toBeDefined();
    expect(findExtensionExternalMapping("@acme/widgets/subpath", normalized.mappings)).toBeUndefined();
    expect(findExtensionExternalMapping("@acme/widgets-extra", normalized.mappings)).toBeUndefined();
  });

  it("bridges a subpath only when the row declares it as its own module id", () => {
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ packageName: "@acme/widgets", moduleIds: ["@acme/widgets/extra"] })] },
    });

    expect(findExtensionExternalMapping("@acme/widgets/extra", normalized.mappings)).toBeDefined();
    expect(findExtensionExternalMapping("@acme/widgets/other", normalized.mappings)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conflicts, located
// ---------------------------------------------------------------------------

describe("a project row that collides with the built-in table", () => {
  it("refuses a second row for a module id the built-in table already claims, naming the config path", () => {
    // #85's third criterion: the location, before a compile or a write, and no silent
    // override. The `path` is asserted rather than only the code, because "给出具体配置
    // 位置" is the criterion and a code alone does not meet it.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ packageName: "@tanstack/react-query" })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings");
    expect(diagnostics[0]?.message).toContain("@tanstack/react-query");
    expect(diagnostics[0]?.message).toContain("claimed by both");
  });

  it("refuses a row whose library the built-in table binds to a different global", () => {
    // One library under two globals is a state the platform's own validation refuses,
    // so this is not a preference the project may hold — and it is caught here, before
    // anything compiles, rather than by the compiler's plan audit.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: {
        mappings: [projectMappingConfig({ packageName: "@acme/widgets", libraryId: "tanstack-query", globalName: "AcmeWidgets" })],
      },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
    expect(diagnostics[0]?.message).toContain("one global name");
  });

  it("refuses a row whose global another row already claims", () => {
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: {
        mappings: [projectMappingConfig({ packageName: "@acme/widgets", libraryId: "acme-widgets", globalName: "TanStackQuery" })],
      },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
    expect(diagnostics[0]?.message).toContain("A global holds one object");
  });

  it("refuses a project row that collides with a module id the host bridge already binds", () => {
    // The conflict is *across* two tables rather than within one, which is why the
    // contract option exists — and why this is checked against a table a test states
    // rather than against the shipped one, whose host ids cannot collide.
    const result = normalizeExtensionMappings(
      { cells: {}, extensions: { mappings: [projectMappingConfig({ packageName: "react" })] } },
      { contract: { hostModuleIds: ["react"] } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("extension-mapping-conflict");
    expect(result.diagnostics[0]?.message).toContain("two different identities");
  });

  it("does not refuse two rows that legitimately share one library", () => {
    // The inverse, and the reason the collision check is on the *set* of ids rather
    // than on a row's key: one extension standing in for two packages is exactly what a
    // row means, so a check that refused it would make a supported configuration
    // unwritable.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [projectMappingConfig({ packageName: "@acme/widgets", moduleIds: ["@acme/widgets-core"] })],
      },
    });

    expect(normalized.mappings.filter(row => row.libraryId === "some-library")).toHaveLength(1);
  });

  it("reports a malformed row and a collision together, rather than stopping at the first", () => {
    // The repository's convention, from `cell-registry`: "a config with three mistakes
    // should cost one round trip, not three". The first version gated the collision check
    // on `diagnostics.length === 0`, which halved the report for exactly the configs that
    // were most wrong — a row both incomplete *and* colliding reported only the first.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: {
        mappings: [
          { packageName: "@acme/widgets" },
          projectMappingConfig({ packageName: "@tanstack/react-query" }),
        ],
      },
    });

    // The incomplete row is reported at its own index; the collision by the row that
    // *did* read. Both are actionable, and neither depends on fixing the other first.
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "invalid-extension-mapping",
      "extension-mapping-conflict",
    ]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings[0]");
    expect(diagnostics[1]?.path).toBe("extensions.mappings");
  });

  it("reports the same diagnostics on a second normalization of the same config", () => {
    // A config diagnostic is read by a person and pasted into a review comment, so it
    // has to be reproducible rather than merely present.
    const config = { cells: {}, extensions: { mappings: [projectMappingConfig({ packageName: "@tanstack/react-query" })] } };
    expect(diagnosticsOf(config)).toEqual(diagnosticsOf(config));
  });
});

// ---------------------------------------------------------------------------
// Per-row admissibility, at the config path
// ---------------------------------------------------------------------------

describe("a project row that cannot be honoured", () => {
  it("reports an incomplete row at its own index, and says which field is missing", () => {
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ packageName: "@acme/widgets" }), { packageName: "@acme/other" }] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings[1]");
    expect(diagnostics[0]?.message).toContain("libraryId");
    expect(diagnostics[0]?.message).toContain("globalName");
  });

  it("refuses a library id the platform's manifest validation would refuse, in the contract's words", () => {
    // The per-row guard's own message is reused rather than re-worded, so a project and
    // the compiler's plan audit cannot describe one defect two ways.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ libraryId: "con" })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings[0]");
    expect(diagnostics[0]?.message).toContain("manifest validation would refuse");
  });

  it("refuses a global the platform reserves, naming the reservation", () => {
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ globalName: "antd" })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.message).toContain("manifest validation reserves this name");
  });

  it("refuses a row that names no provenance for its library id, as a shape failure", () => {
    // #12's rule, reached through a project row: an id that cannot say where it came
    // from is one that cannot be told apart from a guessed display name. A blank
    // `metadataReference` is caught by the reader's own non-empty check rather than by
    // the contract's "guessed from a display name" message, and that is the intended
    // layering rather than an accident: every required field is shape-checked in one
    // place, so "you left this blank" reads the same whichever field it was. The
    // contract's check is not redundant — it is what refuses a *built-in* row with an
    // empty reference, which no reader sees.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ metadataReference: "   " })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.message).toContain("`metadataReference` must be a non-empty string");
    expect(diagnostics[0]?.message).toContain("where that identity came from");
  });

  it("refuses a row with no evidence channel, rather than defaulting one in", () => {
    // The default is deliberately *not* an empty list at the read step, so one place
    // states this condition instead of two that could word it differently.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ verifiedBy: [] })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.message).toContain("no evidence channel");
  });

  it("refuses a row that invents an evidence channel, which is what a raw config could do", () => {
    // Review of #110, finding 1, through the path that produced it. A `.ts` config is
    // type-checked, so `verifiedBy: ["assumption"]` would not compile — but the reader
    // takes a *loaded module*, and a `.mjs`/JSON config never meets a type checker. The
    // reader used to cast the array to `RuntimeEvidenceChannel[]` and let the contract
    // guard see a list of length 1, so the forgery was accepted end to end.
    //
    // The guard now lives in the contract, so this is refused wherever a row comes from —
    // and the message names the vocabulary rather than saying "unknown value".
    for (const forged of [["assumption"], [""], ["likely"], ["designer-api", "expected"]]) {
      const diagnostics = diagnosticsOf({
        cells: {},
        extensions: { mappings: [projectMappingConfig({ verifiedBy: forged })] },
      });

      expect(diagnostics.map(diagnostic => diagnostic.code), JSON.stringify(forged)).toEqual([
        "invalid-extension-mapping",
      ]);
      expect(diagnostics[0]?.message).toContain("not one of the four the runtime contract observes through");
    }
  });

  it("accepts the channels the runtime contract does name, so the check is not vacuous", () => {
    // The bound on the refusal above: a check that refused everything would pass it. Read
    // from the vocabulary rather than listed, so a channel added to
    // `RUNTIME_EVIDENCE_CHANNELS` is accepted without an edit here.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ verifiedBy: ["product-runtime-source", "generated-runtime-browser"] })] },
    });

    expect(normalized.projectMappings[0]?.verifiedBy).toEqual([
      "product-runtime-source",
      "generated-runtime-browser",
    ]);
  });

  it("requires `note`, so a typed config and a raw one accept the same rows", () => {
    // Review of #110, finding 3. `note` is required on `ExtensionExternalMapping`, so
    // `defineForguncyConfig` rejected a row without one while the reader defaulted it to
    // `""` — two schemas for one row. #85 asks the JSON/TS boundary to be consistent; the
    // direction that leaves #12's contract alone is to require it in the reader.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ note: undefined })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
    expect(diagnostics[0]?.message).toContain("`note` must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// The strategy boundary
// ---------------------------------------------------------------------------

describe("a mapping is not a strategy", () => {
  it("refuses a row that tries to decide a dependency strategy", () => {
    // #26's rule, applied one level down: reading a strategy from config would make the
    // loader a second, unreviewed source of dependency strategy. The field is refused
    // *by name* so the diagnostic points at the lock rather than saying "unknown field".
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ strategy: "extension" })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-extension-mapping-field"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings[0].strategy");
    expect(diagnostics[0]?.message).toContain("dependency lock");
  });

  it("refuses an unknown field on the `extensions` block itself", () => {
    const diagnostics = diagnosticsOf({ cells: {}, extensions: { mapping: [] } });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-extensions-field"]);
    expect(diagnostics[0]?.path).toBe("extensions.mapping");
    expect(diagnostics[0]?.message).toContain("builtinMappings, mappings");
  });

  it("refuses a non-array `mappings`, rather than reading it as no rows", () => {
    // "declared a malformed list" and "declared no rows" are different answers, and
    // reading the first as the second would drop a project's rows silently.
    const diagnostics = diagnosticsOf({ cells: {}, extensions: { mappings: {} } });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mappings"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings");
  });

  it("keeps the built-in table when `builtinMappings` is misspelled, and says so", () => {
    // The direction that cannot silently drop a row: reading a typo as `false` would
    // remove every built-in mapping on the strength of a value nobody wrote.
    const diagnostics = diagnosticsOf({ cells: {}, extensions: { builtinMappings: "no" } });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mappings"]);
    expect(diagnostics[0]?.path).toBe("extensions.builtinMappings");
  });
});

// ---------------------------------------------------------------------------
// The listing boundary
// ---------------------------------------------------------------------------

describe("a listing confirms an identity and cannot become a mapping", () => {
  it("has no field a listing could be read through, so a display name cannot become a package", () => {
    // #12 refuses a `libraryId` inferred from a display name, and the mechanical reason
    // that cannot happen here is that a row requires `packageName` — the one field
    // `api.app.listFrontendLibraries` does not have. A listing row therefore fails
    // rather than being silently read as a mapping, and every field of it that is not a
    // mapping field is reported *by name* rather than ignored: `id`, `name`, `exists` and
    // `typeDefinitionAvailable` are each named as unknown, so a caller pasting a listing
    // is told which of its columns have no meaning here instead of being left to guess
    // why one of them was silently dropped.
    const listingRow = {
      id: "tanstack-query",
      name: "TanStack Query for ReactCellType",
      globalName: "TanStackQuery",
      exists: true,
      typeDefinitionAvailable: true,
    };

    const diagnostics = diagnosticsOf({ cells: {}, extensions: { mappings: [listingRow] } });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "unknown-extension-mapping-field",
      "unknown-extension-mapping-field",
      "unknown-extension-mapping-field",
      "unknown-extension-mapping-field",
      "invalid-extension-mapping",
    ]);
    expect(diagnostics.map(diagnostic => diagnostic.path)).toEqual([
      "extensions.mappings[0].id",
      "extensions.mappings[0].name",
      "extensions.mappings[0].exists",
      "extensions.mappings[0].typeDefinitionAvailable",
      "extensions.mappings[0]",
    ]);
    // The row is refused for the missing `packageName`, which is the field that decides
    // whether a mapping can exist at all — `globalName` happens to be shared with a
    // mapping row, which is exactly why one matching column cannot be read as "this is
    // a mapping".
    expect(diagnostics.at(-1)?.message).toContain("packageName");
  });

  it("records which source a row's identity came from, and does not claim to have checked it", () => {
    // The normalized row carries `metadataSource`/`metadataReference` verbatim: a config
    // file is neither `listFrontendLibraries` nor a verified catalog artifact, so the
    // normalization records where the claim came from and leaves confirming it to
    // `auditExtensionLibraryMetadata`, which needs a live listing.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [
          projectMappingConfig({
            metadataSource: "list-frontend-libraries",
            metadataReference: "api.app.listFrontendLibraries on 2026-09-26",
          }),
        ],
      },
    });

    const row = normalized.projectMappings[0];
    expect(row?.metadataSource).toBe("list-frontend-libraries");
    expect(row?.metadataReference).toBe("api.app.listFrontendLibraries on 2026-09-26");
  });
});

// ---------------------------------------------------------------------------
// The normalized result
// ---------------------------------------------------------------------------

describe("the normalized mapping set", () => {
  it("is frozen, so one consumer cannot edit the set every other consumer reads", () => {
    const normalized = normalizeOrThrow({ cells: {}, extensions: { mappings: [projectMappingConfig()] } });

    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.mappings)).toBe(true);
    expect(Object.isFrozen(normalized.projectMappings)).toBe(true);
    expect(() => {
      (normalized.mappings as ExtensionExternalMapping[]).push(projectMapping({ packageName: "sneaky" }));
    }).toThrow();
  });

  it("freezes each row and its nested arrays, not only the lists", () => {
    // Review of #110, finding 2. Freezing the three containers left `row.libraryId = …`
    // and `row.verifiedBy.push(…)` working, and `verifiedBy` is the field that decides
    // whether a claim has an observation behind it — so editing it after normalization is
    // exactly the forgery the contract's channel check exists to refuse.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ moduleIds: ["some-package-core"] })] },
    });
    const row = normalized.projectMappings[0]!;

    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.moduleIds)).toBe(true);
    expect(Object.isFrozen(row.verifiedBy)).toBe(true);
    expect(() => {
      (row as { libraryId: string }).libraryId = "changed";
    }).toThrow();
    expect(() => {
      (row.verifiedBy as string[]).push("assumption");
    }).toThrow();
    expect(() => {
      (row.moduleIds as string[]).push("sneaky-package");
    }).toThrow();
  });

  it("owns its rows, so editing the config afterwards cannot change the normalized result", () => {
    // The other half of the same finding: a row that is not copied is shared with the
    // caller's document, so the set every stage reads could be edited *through* it — and a
    // config object is a live thing in a watch-mode host.
    const config = { cells: {}, extensions: { mappings: [projectMappingConfig({ moduleIds: ["some-package-core"] })] } };
    const normalized = normalizeOrThrow(config);

    const rowBefore = JSON.stringify(normalized.projectMappings[0]);
    (config.extensions.mappings[0] as { libraryId: string }).libraryId = "hijacked";
    (config.extensions.mappings[0] as { moduleIds: string[] }).moduleIds.push("@hijacked/extra");
    (config.extensions.mappings[0] as { verifiedBy: string[] }).verifiedBy.push("assumption");

    expect(JSON.stringify(normalized.projectMappings[0])).toBe(rowBefore);
  });

  it("does not freeze a caller-supplied built-in table in place", () => {
    // The side effect freezing instead of copying would have introduced: `builtinMappings`
    // is the *caller's* array, and a function asked to read a config may not leave it
    // frozen. Asserted on both the array and the row, because freezing only the array
    // would still mutate the caller's row objects.
    const callerOwned: readonly ExtensionExternalMapping[] = [projectMapping({ packageName: "pinned-package" })];
    const callerRow = callerOwned[0]!;

    normalizeOrThrow({ cells: {} }, { builtinMappings: callerOwned });

    expect(Object.isFrozen(callerOwned)).toBe(false);
    expect(Object.isFrozen(callerRow)).toBe(false);
    // And the caller's row is still usable, which is what "not frozen" has to mean.
    expect(() => {
      (callerRow as { libraryId: string }).libraryId = "still-writable";
    }).not.toThrow();
  });

  it("shares one clone between `mappings` and the subset a row belongs to", () => {
    // Why the clone is memoized rather than applied twice: `extensionMappingOrigin` and the
    // plan's activation predicate both compare rows by identity *within one result*, so two
    // clones of one row would make those comparisons fail while every printed field matched.
    const normalized = normalizeOrThrow({ cells: {}, extensions: { mappings: [projectMappingConfig()] } });

    expect(normalized.mappings).toContain(normalized.projectMappings[0]);
    expect(extensionMappingOrigin(normalized, normalized.projectMappings[0]!)).toBe("project");
  });

  it("says which rows are the project's and which are the repository's", () => {
    // The rows are read off the *result*, not from `EXTENSION_EXTERNAL_MAPPINGS`: the
    // result clones its rows, so the table's own objects are foreign to it. The earlier
    // version of this test passed `tanStackQueryRow` (a table row) and expected
    // `"builtin"`, which the old implementation answered by defaulting — the test could
    // not tell a correct answer from a fallback. Review of #110, non-blocking item.
    const normalized = normalizeOrThrow({ cells: {}, extensions: { mappings: [projectMappingConfig()] } });

    expect(extensionMappingOrigin(normalized, normalized.projectMappings[0]!)).toBe("project");
    expect(extensionMappingOrigin(normalized, normalized.builtinMappings[0]!)).toBe("builtin");
  });

  it("says it does not know, rather than calling a foreign row the repository's", () => {
    // A row that belongs to neither list has no origin in this result. Answering
    // `"builtin"` for it is a confident wrong answer, and it is the *common* case rather
    // than an edge: every row outside a result is foreign to it, including the shipped
    // table's own rows and another result's rows.
    const normalized = normalizeOrThrow({ cells: {}, extensions: { mappings: [projectMappingConfig()] } });
    const other = normalizeOrThrow({ cells: {} });

    expect(extensionMappingOrigin(normalized, tanStackQueryRow!)).toBeUndefined();
    expect(extensionMappingOrigin(normalized, other.builtinMappings[0]!)).toBeUndefined();
    expect(extensionMappingOrigin(normalized, projectMapping({ packageName: "never-normalized" }))).toBeUndefined();
    // And the two answers that *are* knowable still come back, so the `undefined` above is
    // not a check that refuses everything.
    expect(extensionMappingOrigin(other, other.builtinMappings[0]!)).toBe("builtin");
  });

  it("reports its source, its rows and its project-row count in one block", () => {
    const normalized = normalizeOrThrow({ cells: {}, extensions: { mappings: [projectMappingConfig()] } });
    const report = formatExtensionMappingsConfig(normalized);

    expect(report).toContain("project-extended");
    expect(report).toContain("some-package -> some-library/SomeLibrary");
    expect(report).toContain("@tanstack/react-query -> tanstack-query/TanStackQuery");
    expect(report).toContain("Project rows: 1");
  });

  it("checks the shipped table against its own guards, so a project row is measured against a sound table", () => {
    // Not a test of this module, and deliberately here anyway: the collision rule is
    // only meaningful if the table a project's rows merge with is itself unambiguous.
    // If this ever fails, every conflict diagnostic above is measuring against a
    // broken baseline.
    expect(() => assertExtensionExternalMappingsAreUnambiguous(EXTENSION_EXTERNAL_MAPPINGS)).not.toThrow();
  });

  it("checks the built-in table even when the config declares no `extensions` block", () => {
    // Review of #110, finding 1. The absent state used to return before the guards, so the
    // set's *validation* depended on whether a semantically empty `extensions: {}` was
    // written — two configs producing the same mapping set disagreed about admissibility.
    // Measured on the first version, with one pinned contract:
    //
    //   { cells: {} }                    -> ok: true
    //   { cells: {}, extensions: {} }    -> ok: false
    const contract = { hostModuleIds: ["@tanstack/react-query"] };

    const absent = normalizeExtensionMappings({ cells: {} }, { contract });
    const declared = normalizeExtensionMappings({ cells: {}, extensions: {} }, { contract });

    expect(absent.ok).toBe(false);
    expect(declared.ok).toBe(false);
    if (absent.ok || declared.ok) return;
    // The same finding, not merely the same verdict: a config that says nothing and one
    // that declares an empty block have to be told the same thing.
    expect(absent.diagnostics).toEqual(declared.diagnostics);
    expect(absent.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
  });

  it("refuses a caller-pinned built-in table that is inadmissible, with no `extensions` declared", () => {
    // The other half of the same finding: the option is public, so a pinned table can be
    // wrong — and it used to be returned as a normalized result whenever the config was
    // silent. Three ways, each a check that was skipped.
    const base = {
      packageName: "pinned-package",
      libraryId: "pinned-library",
      globalName: "PinnedLibrary",
      metadataSource: "verified-catalog" as const,
      metadataReference: "some/catalog",
      verificationRule: "A pinned row.",
      verifiedBy: ["designer-api"] as const,
      note: "pinned",
    };

    // A forged evidence channel.
    const forged = normalizeExtensionMappings(
      { cells: {} },
      { builtinMappings: [projectMapping({ ...base, verifiedBy: ["assumption"] as never })] },
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-extension-mapping"]);
      // The path names the pinned table rather than the module the caller never consulted.
      expect(forged.diagnostics[0]?.path).toBe("options.builtinMappings");
    }

    // A reserved global.
    const reserved = normalizeExtensionMappings(
      { cells: {} },
      { builtinMappings: [projectMapping({ ...base, globalName: "antd" })] },
    );
    expect(reserved.ok).toBe(false);

    // Two rows claiming one module id.
    const ambiguous = normalizeExtensionMappings(
      { cells: {} },
      {
        builtinMappings: [
          projectMapping({ ...base }),
          projectMapping({ ...base, libraryId: "other-library", globalName: "OtherLibrary" }),
        ],
      },
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
      expect(ambiguous.diagnostics[0]?.path).toBe("options.builtinMappings");
    }
  });

  it("locates an ambiguous pinned built-in table in that table, even when an unrelated project row exists", () => {
    // Review of #110, round 3. The path used to be decided by `projectRows.length > 0`
    // alone, which is sound only while the built-in half is coherent by itself — true of
    // the shipped table and not of a caller-pinned one. Measured with one ambiguous table:
    //
    //   no project rows                     -> @options.builtinMappings
    //   plus one unrelated valid project row -> @extensions.mappings
    //
    // One table, one defect, two locations — and the second pointed at a row with nothing
    // to do with it. The built-in table's own coherence is now checked first, so a
    // collision inside it is reported against it whatever the project declared.
    const ambiguousBuiltins: readonly ExtensionExternalMapping[] = [
      projectMapping({ packageName: "dup-package" }),
      projectMapping({ packageName: "dup-package", libraryId: "other-library", globalName: "OtherLibrary" }),
    ];
    const unrelatedProjectRow = projectMappingConfig({
      packageName: "@acme/widgets",
      libraryId: "acme-widgets",
      globalName: "AcmeWidgets",
    });

    const withProjectRow = normalizeExtensionMappings(
      { cells: {}, extensions: { mappings: [unrelatedProjectRow] } },
      { builtinMappings: ambiguousBuiltins },
    );
    const withoutProjectRow = normalizeExtensionMappings({ cells: {} }, { builtinMappings: ambiguousBuiltins });

    expect(withProjectRow.ok).toBe(false);
    expect(withoutProjectRow.ok).toBe(false);
    if (withProjectRow.ok || withoutProjectRow.ok) return;
    // The same finding and the same path: an unrelated project row cannot move it.
    expect(withProjectRow.diagnostics).toEqual(withoutProjectRow.diagnostics);
    expect(withProjectRow.diagnostics[0]?.path).toBe("options.builtinMappings");
    expect(withProjectRow.diagnostics[0]?.message).toContain("dup-package");
  });

  it("still attributes a genuine project collision to the project's rows", () => {
    // The bound on the test above, and the property the ordering has to preserve: when the
    // built-in half is coherent, a combined failure can only be the project's addition — so
    // the project's path is the right answer and not a fallback. The project row claims a
    // package the shipped table already maps, which is a collision only the project can fix.
    const diagnostics = diagnosticsOf({
      cells: {},
      extensions: { mappings: [projectMappingConfig({ packageName: "@tanstack/react-query" })] },
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
    expect(diagnostics[0]?.path).toBe("extensions.mappings");
  });

  it("reports nothing about a pinned table the config has opted out of", () => {
    // `builtinMappings: false` leaves the pinned table unused, and a finding about a table
    // the artifact never touches is the false positive the per-row loop already declines to
    // report. The built-in half's coherence check is skipped for the same reason.
    const normalized = normalizeOrThrow(
      {
        cells: {},
        extensions: { builtinMappings: false, mappings: [projectMappingConfig()] },
      },
      {
        builtinMappings: [
          projectMapping({ packageName: "dup-package" }),
          projectMapping({ packageName: "dup-package", libraryId: "other-library", globalName: "OtherLibrary" }),
        ],
      },
    );

    expect(normalized.source).toBe("project-only");
    expect(normalized.mappings).toHaveLength(1);
  });

  it("still normalizes an absent block against the shipped table, which the guards accept", () => {
    // The bound on the two tests above: running the guards on the absent path must not turn
    // the default into a refusal. The shipped table passes its own contract, so the
    // documented default behaviour is unchanged.
    const normalized = normalizeOrThrow({ cells: {} });

    expect(normalized.source).toBe("builtin-default");
    expect(normalized.mappings).toEqual(EXTENSION_EXTERNAL_MAPPINGS);
  });

  it("normalizes a pinned built-in table, so a caller checks against the table it named", () => {
    // The option exists so the merge rule is exercisable and so a caller auditing a
    // config against a pinned table is not silently measured against the shipped one.
    const pinned: readonly ExtensionExternalMapping[] = [projectMapping({ packageName: "pinned-package" })];
    const normalized = normalizeOrThrow({ cells: {} }, { builtinMappings: pinned });

    expect(normalized.builtinMappings).toEqual(pinned);
    expect(normalized.mappings).toEqual(pinned);
    expect(hasRowFor(normalized, "@tanstack/react-query")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Declaration order
// ---------------------------------------------------------------------------

describe("row order", () => {
  it("keeps the project's declaration order rather than sorting it", () => {
    // Order is not cosmetic: the plan's `catalog` is built by walking the table, and
    // #12's canonical `frontendLibraries` ordering is a *separate* sort applied to the
    // references. Sorting here would be a second ordering rule that could disagree with
    // the plan's, so the project's order is carried through and the plan decides.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [
          projectMappingConfig({ packageName: "zeta-package", libraryId: "zeta-library", globalName: "ZetaLibrary" }),
          projectMappingConfig({ packageName: "alpha-package", libraryId: "alpha-library", globalName: "AlphaLibrary" }),
        ],
      },
    });

    expect(normalized.projectMappings.map(row => row.packageName)).toEqual(["zeta-package", "alpha-package"]);
    expect(normalized.mappings.map(row => row.packageName).slice(-2)).toEqual(["zeta-package", "alpha-package"]);
  });
});

// ---------------------------------------------------------------------------
// Through the registry (#85's integration point)
// ---------------------------------------------------------------------------

describe("the registry carries the normalized set", () => {
  it("is where the compiler, the harness and the sync read one mapping answer from", async () => {
    // The seam #86/#87 consume: the registry is the one place the config is normalized,
    // so a stage that reads `registry.extensionMappings` reads what every other stage
    // reads rather than re-reading `core`'s shipped table.
    const { createCellRegistry } = await import("./cell-registry.ts");

    const registry = createCellRegistry(
      { cells: {}, extensions: { mappings: [projectMappingConfig()] } },
      { root: process.cwd(), requireEntryFiles: false },
    );

    expect(registry.extensionMappings.source).toBe("project-extended");
    expect(hasRowFor(registry.extensionMappings, "@tanstack/react-query")).toBe(true);
    expect(registry.extensionMappings.projectMappings.map(row => row.packageName)).toEqual(["some-package"]);
  });

  it("fails the whole config with the mapping diagnostic's own code and path", async () => {
    // A mapping conflict is a config error like any other, so it arrives through the
    // registry's single error type and its `codes` accessor — a caller branching on the
    // failure class does not have to know which sub-module found it.
    const { createCellRegistry, ForguncyConfigError } = await import("./cell-registry.ts");

    try {
      createCellRegistry(
        { cells: {}, extensions: { mappings: [projectMappingConfig({ packageName: "@tanstack/react-query" })] } },
        { root: process.cwd(), requireEntryFiles: false },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ForguncyConfigError);
      const configError = error as InstanceType<typeof ForguncyConfigError>;
      expect(configError.codes).toContain("extension-mapping-conflict");
      expect(configError.diagnostics.map(d => d.path)).toContain("extensions.mappings");
      return;
    }
    throw new Error("Expected the registry to refuse a conflicting mapping row.");
  });
});
