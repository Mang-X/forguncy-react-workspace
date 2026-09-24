/**
 * The `frontendLibraries` metadata the artifact carries.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6), guarantee 5:
 * "`extension` dependencies reference the corresponding extension global and add
 * the stable `libraryId` to `frontendLibraries`".
 *
 * This is the only metadata `CompileCellResult` carries, so it is the only place
 * the artifact can be wrong in a way the code itself does not show. Two things
 * follow, and both are implemented here rather than left to the caller:
 *
 * - The *shape* is #5's, not this module's. A reference carries exactly one field,
 *   `libraryId`, and its value comes from `api.app.listFrontendLibraries[].id` —
 *   the stable id, never a display name or file name. The reference is therefore
 *   built from `core`'s record instead of being written out again.
 * - The *order* is part of determinism. #6 promise 7 is byte-stability for
 *   identical inputs, and an array whose order depends on which dependency the
 *   bundler happened to walk first is not byte-stable. Sorting by code point
 *   rather than with `localeCompare` is deliberate: a locale-sensitive comparison
 *   would order the same artifact differently on a different machine.
 */

import { FRONTEND_LIBRARY_REFERENCE_CONTRACT, FRONTEND_LIBRARY_REFERENCE_EXAMPLE } from "@forguncy-react-workspace/core";
import type { DependencyDecision, FrontendLibraryReference } from "@forguncy-react-workspace/core";

import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import { createCellArtifactDiagnostic } from "./diagnostics.ts";

/** The persisted field name this metadata is written to. */
export const FRONTEND_LIBRARIES_FIELD_NAME = "frontendLibraries";

/** The single field a reference carries, read from #5's record. */
export const FRONTEND_LIBRARY_REFERENCE_FIELD_NAME = FRONTEND_LIBRARY_REFERENCE_CONTRACT.fieldName;

/** The reference keys the persisted shape allows, read from #5's example. */
export const FRONTEND_LIBRARY_REFERENCE_KEYS: readonly string[] = Object.keys(FRONTEND_LIBRARY_REFERENCE_EXAMPLE);

/**
 * Builds a reference from a library id.
 *
 * Deliberately not a spread of the caller's object: passing a reference through
 * would let an extra field travel into persisted designer state, and #5 records
 * that the only field a reference carries is `libraryId`.
 */
export function frontendLibraryReference(libraryId: string): FrontendLibraryReference {
  return { libraryId };
}

/**
 * Orders references by code point.
 *
 * Not `localeCompare`: the artifact has to be byte-stable across machines, and a
 * locale-sensitive order is not.
 */
export function compareFrontendLibraries(a: FrontendLibraryReference, b: FrontendLibraryReference): number {
  if (a.libraryId < b.libraryId) return -1;
  if (a.libraryId > b.libraryId) return 1;
  return 0;
}

/** Deduplicates and sorts, dropping entries with no usable id. */
export function canonicalizeFrontendLibraries(
  libraries: readonly FrontendLibraryReference[],
): readonly FrontendLibraryReference[] {
  const byId = new Map<string, FrontendLibraryReference>();
  for (const library of libraries) {
    const libraryId = library.libraryId.trim();
    if (libraryId.length === 0) continue;
    if (!byId.has(libraryId)) byId.set(libraryId, frontendLibraryReference(libraryId));
  }
  return [...byId.values()].sort(compareFrontendLibraries);
}

/** True when `libraries` is already the canonical form, so `code` can be diffed. */
export function isCanonicalFrontendLibraries(libraries: readonly FrontendLibraryReference[]): boolean {
  if (libraries.length === 0) return true;
  const canonical = canonicalizeFrontendLibraries(libraries);
  if (canonical.length !== libraries.length) return false;
  return libraries.every((library, index) => {
    const expected = canonical[index];
    if (expected === undefined) return false;
    if (library.libraryId !== expected.libraryId) return false;
    return Object.keys(library).length === FRONTEND_LIBRARY_REFERENCE_KEYS.length;
  });
}

export function frontendLibraryIds(libraries: readonly FrontendLibraryReference[]): readonly string[] {
  return libraries.map(library => library.libraryId);
}

/**
 * Reports every way `libraries` departs from the canonical form.
 *
 * Exported because an artifact assembled elsewhere — or read back out of
 * designer state — still has to be checkable, and "the metadata is canonical" is
 * exactly the property a reviewer cannot see by reading a diff.
 */
export function auditFrontendLibraries(
  libraries: readonly FrontendLibraryReference[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const seen = new Set<string>();

  for (const library of libraries) {
    const libraryId = library.libraryId;

    if (libraryId.trim().length === 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("missing-extension-mapping", `${FRONTEND_LIBRARIES_FIELD_NAME}[]`, {
          detail: `A reference carries no ${FRONTEND_LIBRARY_REFERENCE_FIELD_NAME}, so the runtime cannot resolve it.`,
        }),
      );
      continue;
    }

    if (seen.has(libraryId)) {
      diagnostics.push(
        createCellArtifactDiagnostic("non-canonical-artifact-metadata", libraryId, {
          detail: `"${libraryId}" appears more than once in ${FRONTEND_LIBRARIES_FIELD_NAME}; the canonical form carries each ${FRONTEND_LIBRARY_REFERENCE_FIELD_NAME} once.`,
        }),
      );
      continue;
    }
    seen.add(libraryId);

    const extraKeys = Object.keys(library).filter(key => !FRONTEND_LIBRARY_REFERENCE_KEYS.includes(key));
    if (extraKeys.length > 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("non-canonical-artifact-metadata", libraryId, {
          detail: `A ${FRONTEND_LIBRARIES_FIELD_NAME} reference carries only ${FRONTEND_LIBRARY_REFERENCE_KEYS.join(", ")}, but this one also carries ${extraKeys.join(", ")}.`,
        }),
      );
    }
  }

  if (!isSorted(libraries)) {
    diagnostics.push(
      createCellArtifactDiagnostic("non-canonical-artifact-metadata", FRONTEND_LIBRARIES_FIELD_NAME, {
        detail: `The list is not ordered by ${FRONTEND_LIBRARY_REFERENCE_FIELD_NAME}, so two runs over the same inputs could produce different bytes.`,
      }),
    );
  }

  return diagnostics;
}

function isSorted(libraries: readonly FrontendLibraryReference[]): boolean {
  for (let index = 1; index < libraries.length; index += 1) {
    const previous = libraries[index - 1];
    const current = libraries[index];
    if (previous === undefined || current === undefined) continue;
    if (compareFrontendLibraries(previous, current) > 0) return false;
  }
  return true;
}

export interface FrontendLibrariesCollection {
  /** The canonical metadata for the artifact. */
  readonly libraries: readonly FrontendLibraryReference[];
  readonly diagnostics: readonly CellArtifactDiagnostic[];
}

/**
 * Derives `frontendLibraries` from the dependency decisions.
 *
 * Only `extension` decisions contribute: `inline` code has no library the page
 * has to load, a `host` global is already on the page by definition, and a
 * workspace package is source. Two packages sharing one extension library
 * collapse to one reference without a diagnostic — that is the reuse `extension`
 * exists for — while an extension decision with no usable id is reported,
 * because the artifact would otherwise reference a global nothing ever loads.
 */
export function collectFrontendLibraries(
  dependencies: readonly DependencyDecision[],
): FrontendLibrariesCollection {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const libraries: FrontendLibraryReference[] = [];

  for (const decision of dependencies) {
    if (decision.strategy !== "extension") continue;

    if (decision.libraryId.trim().length === 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
          detail: `The decision for "${decision.packageName}" names no ${FRONTEND_LIBRARY_REFERENCE_FIELD_NAME}, so nothing can be added to ${FRONTEND_LIBRARIES_FIELD_NAME} for it.`,
        }),
      );
      continue;
    }

    if (decision.globalName.trim().length === 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
          detail: `The decision for "${decision.packageName}" names no extension global, so the artifact has nothing to reference in place of a bundled copy.`,
        }),
      );
      continue;
    }

    libraries.push(frontendLibraryReference(decision.libraryId.trim()));
  }

  return { libraries: canonicalizeFrontendLibraries(libraries), diagnostics };
}
