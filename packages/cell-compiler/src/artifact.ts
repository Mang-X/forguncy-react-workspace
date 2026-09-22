/**
 * The compiler boundary: a normal module entry in, a platform artifact out.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * #6 describes the boundary as "input is a normal module entry plus resolved
 * dependency decisions" and "output is a platform artifact, not a generic web
 * bundle", and then says the compiler should "use Vite+/Rolldown/tsdown
 * capabilities rather than inventing a separate module resolver". Those two
 * sentences together are why `CellBundlerPort` exists: the actual module
 * resolution and code generation are a bundler's job, and this package's job is
 * everything that makes the result a *Cell artifact* rather than a web bundle —
 * assembly, the entry wrapper, the metadata, the guarantees and the error model.
 *
 * So `compileCell` does not name a bundler, and this module contains no resolver.
 * It takes the bundler's report and decides whether it produced a legal artifact,
 * which is a different question from whether it produced a working bundle:
 *
 * - a bundler can succeed and leave an `import` behind, and only the decisions
 *   say whether that import should have been inlined or mapped to a host global;
 * - a bundler can succeed and emit a sibling chunk, which is a legitimate web
 *   bundle and an illegal Cell artifact;
 * - a bundler can succeed after inlining a package that implements a
 *   Forguncy-owned capability, which is a platform conflict no bundler can see.
 *
 * The real Forguncy confirmation of the result is deliberately *not* claimed
 * here. #7's validation plan performs it downstream, and AGENTS.md rule 7 forbids
 * reporting a local green build as runtime compatibility. See
 * `guarantees.ts` for which promises that leaves outstanding.
 */

import { CELL_USER_SCOPE_BINDINGS, validateDependencyDecisionShape } from "@forguncy-react-workspace/core";
import type {
  CellEntryKind,
  CellUserScopeBinding,
  DependencyDecision,
  FrontendLibraryReference,
} from "@forguncy-react-workspace/core";

import type { CellArtifactDiagnostic } from "./diagnostics";
import {
  createCellArtifactDiagnostic,
  dedupeCellArtifactDiagnostics,
  formatCellArtifactDiagnostics,
} from "./diagnostics";
import { CELL_ENTRY_COMPONENT_BINDING, renderCellEntryWrapper } from "./entry";
import {
  auditFrontendLibraries,
  collectFrontendLibraries,
  FRONTEND_LIBRARIES_FIELD_NAME,
  frontendLibraryIds,
} from "./frontend-libraries";
import { auditCellSource } from "./source-guard";

// ---------------------------------------------------------------------------
// The finalized public interfaces
// ---------------------------------------------------------------------------

/**
 * The compiler's output.
 *
 * `frontendLibraries` is the only metadata it carries, which is #6's decision
 * rather than an omission: everything else a consumer needs is either in the code
 * or already known to the platform. It is also the reason `mcp-sync` can take the
 * artifact without a translation step — there is nothing to translate.
 */
export interface CompileCellResult {
  /** The single logical Cell artifact: one script, no runtime chunk loading. */
  readonly code: string;
  /** The frontend libraries ReactCellType must resolve before this cell's entry runs. */
  readonly frontendLibraries: readonly FrontendLibraryReference[];
}

/**
 * What a bundler hands back.
 *
 * Deliberately a *report* as much as a payload. A bundle is opaque once it is a
 * string, so the three facts that decide whether it is a legal Cell artifact
 * cannot be recovered from `code` afterwards without re-parsing it — and #6's
 * acceptance criteria explicitly require the artifact to be passable to
 * `mcp-sync` "without additional semantic transformation".
 *
 * One obligation is not written in this type because it cannot be: `code` must
 * bind the entry's component to `CELL_ENTRY_COMPONENT_BINDING`. That is what
 * `CellBundlingRequest.componentBinding` is for, and the two are the same value by
 * construction.
 */
export interface BundledCellModule {
  /** The artifact body: one script, no runtime chunk loading. */
  readonly code: string;
  /** Specifiers the bundler left external rather than flattening. Every one is a violation. */
  readonly externalImports?: readonly string[];
  /** Packages the bundler flattened into `code`. */
  readonly inlinedPackages?: readonly string[];
  /** Files the bundler emitted next to `code`. Any entry breaks the single-artifact contract. */
  readonly emittedAssets?: readonly string[];
  /**
   * Findings in #6's vocabulary that only the build could observe.
   *
   * Optional because the report fields above cover most artifact violations on
   * their own, and a fixture port has nothing to add. The real port uses it for
   * the conditions no output field can express — a decision that contradicts a
   * mapping table, an artifact reading an extension module no decision declares
   * — reported here rather than smuggled in from the plans' own vocabularies,
   * which are about mappings rather than artifacts and stay separate (#7's
   * bundler documents which plan codes translate and which do not).
   */
  readonly diagnostics?: readonly CellArtifactDiagnostic[];
}

export interface CellBundlingRequest {
  readonly entry: string;
  readonly dependencies: readonly DependencyDecision[];
  /**
   * The identifier the bundle must bind the entry's component to, so the generated
   * wrapper can reference it.
   *
   * Carried in the request rather than left implicit on purpose. The wrapper and
   * the bundle are produced by different halves of the pipeline, and the one thing
   * that must agree between them is this name; a bundler that has to go and read a
   * constant to discover it is one refactor away from disagreeing. For an IIFE
   * output this is the `output.name` — literally "bind the entry to this
   * identifier".
   */
  readonly componentBinding: string;
}

/**
 * The module-resolution and code-generation half of the pipeline.
 *
 * A port rather than a concrete dependency because #6 mandates Vite+/Rolldown
 * while forbidding this package from becoming a second resolver. #7 supplies the
 * implementation; the contract tests supply a fixture, which is what makes the
 * boundary testable before the bundler exists.
 */
export interface CellBundlerPort {
  readonly bundle: (request: CellBundlingRequest) => Promise<BundledCellModule>;
}

/**
 * The compiler's input, exactly as #6 pins it: "a normal module entry plus
 * resolved dependency decisions".
 *
 * Deliberately not widened. Every extra field the compiler needs in order to
 * *run* — the bundler, the entry shape, the metric budget — lives in
 * {@link CompileCellOptions} instead, so this interface keeps meaning what the
 * Spec says it means and adding a knob cannot quietly change the boundary.
 */
export interface CompileCellInput {
  /** A normal module entry. Ordinary React/TypeScript; the artifact is the compiler's problem. */
  readonly entry: string;
  /** One resolved decision per non-source dependency. */
  readonly dependencies: readonly DependencyDecision[];
}

export interface CompileCellOptions {
  /**
   * The module-resolution and code-generation half of the pipeline.
   *
   * Required, not optional: without it there is nothing to compile, and making it
   * optional would leave the caller to discover at run time that compilation
   * cannot happen.
   */
  readonly bundler: CellBundlerPort;
  /** Which #5 entry shape to expose. Defaults to a function `App` binding. */
  readonly entryKind?: CellEntryKind;
  /**
   * The caller's cell code budget, in characters, measured on the composed
   * artifact. No default is applied: #5 found no hard platform limit, so the
   * compiler refusing a size on its own authority would be inventing policy that
   * belongs to the budget Issue.
   */
  readonly codeBudgetCharacters?: number;
}

/**
 * Compilation either produced an artifact or did not.
 *
 * Not `CompileCellResult | diagnostics`: a caller that has to test whether
 * `code` is present will eventually forget, and the failure mode of forgetting is
 * writing an empty cell.
 */
export type CompileCellOutcome =
  | { readonly status: "compiled"; readonly artifact: CompileCellResult; readonly entryKind: CellEntryKind }
  | { readonly status: "rejected"; readonly diagnostics: readonly CellArtifactDiagnostic[] };

/**
 * The first line of every artifact.
 *
 * Fixed text, no timestamp and no tool version: #6 permits a non-deterministic
 * banner only if it is documented, and documenting one that does not exist would
 * be worse than emitting none. It states #6's source-of-truth rule because the
 * banner is the one place a person reading designer-held code will see it.
 */
export const CELL_ARTIFACT_BANNER =
  "/* Generated by @forguncy-react-workspace/cell-compiler. Do not edit: repository source is authoritative, this is deployment output. */";

/** The package a bare or scoped specifier resolves to, so decisions can be matched by package. */
export function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return specifier;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? specifier;
}

/**
 * True when a specifier names a file rather than a module id.
 *
 * Exported because two layers have to give the same answer: this one decides between
 * "a leftover import" and "an unresolved decision" with it, and the workspace
 * contract (#14) decides between "workspace source" and "a published dependency"
 * with the same test. Restating it in the second place would be two answers to one
 * question, which is the shape #9's fourth review round found in `findDecision`.
 *
 * Exact for relative and absolute paths, which is the whole claim: a *named*
 * workspace package (`@scope/ui`) is indistinguishable here from a published one,
 * because the artifact layer has no workspace manifest — #14's workspace contract
 * asks that question with `workspacePackageFor` instead, which is what holding a
 * manifest buys. A specifier the bundler resolves through an alias (`#internal`, a
 * `resolve.alias` target) is outside this test in either direction: it is not a
 * path, so both layers treat it as a module id, which is why a graph that carries
 * one has to carry the id the bundler actually resolves rather than the alias.
 */
export function isSourceSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * The bindings a `host` dependency may be mapped onto.
 *
 * `injected-parameter` are the `new Function` arguments the runtime passes, and
 * `page-global` are page-level names such as `ReactDOM` the runtime itself uses.
 * `wrapper-local` and `extension-global` are deliberately absent: the first is
 * created inside the cell's own generated closure, the second belongs to the
 * `extension` strategy and reaching it as `host` would skip both the
 * `libraryId` reference and the readiness guarantee.
 */
const HOST_IDENTITY_KINDS: readonly CellUserScopeBinding["kind"][] = ["injected-parameter", "page-global"];

function subjectOf(decision: DependencyDecision): string {
  return decision.packageName.trim().length > 0 ? decision.packageName : "<unnamed package>";
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleCellArtifactInput {
  /** The bundler's single-artifact report. */
  readonly module: BundledCellModule;
  readonly dependencies: readonly DependencyDecision[];
  readonly entryKind?: CellEntryKind;
  readonly codeBudgetCharacters?: number;
}

/**
 * Turns a bundler report into a Cell artifact, or refuses it with diagnostics.
 *
 * Checks run in a fixed order so the diagnostic list is itself deterministic —
 * two runs over the same input cannot report the same problems in a different
 * order, which matters because the list ends up in CI logs that get diffed.
 */
export function assembleCellArtifact(input: AssembleCellArtifactInput): CompileCellOutcome {
  const { module, dependencies } = input;

  const decisionDiagnostics = auditDependencyDecisions(dependencies);
  const importDiagnostics = auditExternalImports(module.externalImports ?? [], dependencies);
  const inlinedDiagnostics = auditInlinedPackages(module.inlinedPackages ?? [], dependencies);
  const assetDiagnostics = auditEmittedAssets(module.emittedAssets ?? []);
  const collection = collectFrontendLibraries(dependencies);

  const wrapper = renderCellEntryWrapper(
    input.entryKind === undefined ? {} : { entryKind: input.entryKind },
  );

  const wrapperSource = wrapper.status === "emitted" ? wrapper.source : "";
  const code = `${CELL_ARTIFACT_BANNER}\n${module.code}\n${wrapperSource}\n`;

  const sourceDiagnostics = auditArtifactSource(code, artifactOriginOf(module.code));
  const budgetDiagnostics = auditCodeBudget(code, input.codeBudgetCharacters);
  const metadataDiagnostics = auditFrontendLibraries(collection.libraries);

  const diagnostics = dedupeCellArtifactDiagnostics([
    // The bundler's own findings first: when one of them names the same
    // condition an audit below also reports (an unmapped extension decision is
    // visible both in the plan and in the output report), the build's more
    // specific explanation — which can say *why* the mapping is unusable — is
    // the one a reader keeps after deduplication.
    ...(module.diagnostics ?? []),
    ...decisionDiagnostics,
    ...importDiagnostics,
    ...inlinedDiagnostics,
    ...assetDiagnostics,
    ...collection.diagnostics,
    ...(wrapper.status === "emitted" ? [] : wrapper.diagnostics),
    ...sourceDiagnostics,
    ...budgetDiagnostics,
    ...metadataDiagnostics,
  ]);

  // A wrapper that could not be emitted always contributes a diagnostic, so the
  // second half of this test is redundant at runtime and present for the type
  // system: it is what narrows `wrapper` to the emitted case below.
  if (diagnostics.length > 0 || wrapper.status !== "emitted") {
    return { status: "rejected", diagnostics };
  }

  return {
    status: "compiled",
    artifact: { code, frontendLibraries: collection.libraries },
    entryKind: wrapper.kind,
  };
}

// ---------------------------------------------------------------------------
// Decision audit
// ---------------------------------------------------------------------------

/**
 * Audits the decision list itself.
 *
 * The shape checks come from `core` rather than being reimplemented: a decision
 * record that is internally inconsistent is #4's problem, and the compiler's only
 * job is to translate that verdict into a code the artifact-level report can
 * branch on. The translation is per strategy because the fix differs — an
 * extension with no global is a mapping problem, a host with no global is a
 * mapping problem of a different kind, and a replacement with no recorded
 * rejection is an unresolved decision.
 */
function auditDependencyDecisions(dependencies: readonly DependencyDecision[]): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const byPackage = new Map<string, DependencyDecision[]>();

  for (const decision of dependencies) {
    const name = decision.packageName;
    const existing = byPackage.get(name);
    if (existing === undefined) byPackage.set(name, [decision]);
    else existing.push(decision);
  }

  for (const [packageName, decisions] of byPackage) {
    if (decisions.length > 1 && packageName.trim().length > 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("unresolved-dependency-decision", packageName, {
          detail: `${decisions.length} decisions target this package (${decisions.map(item => item.strategy).join(", ")}), so there is no single strategy to compile against.`,
        }),
      );
    }
  }

  for (const decision of dependencies) {
    const subject = subjectOf(decision);

    for (const problem of validateDependencyDecisionShape(decision)) {
      diagnostics.push(
        createCellArtifactDiagnostic(diagnosticCodeForStrategy(decision.strategy), subject, { detail: problem }),
      );
    }

    if (decision.strategy === "host") {
      const binding = CELL_USER_SCOPE_BINDINGS.find(candidate => candidate.name === decision.globalName);
      if (binding === undefined) {
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", subject, {
            detail: `The global "${decision.globalName}" is not one of the names the runtime contract verified as visible inside a cell, so the artifact would reference a global that may never exist.`,
          }),
        );
      } else if (!HOST_IDENTITY_KINDS.includes(binding.kind)) {
        // Being a verified *name* is not the same as being a runtime *identity*.
        // `props`, `useState` and `render` are wrapper-locals the generated
        // function creates per render, so mapping a dependency onto one would
        // replace a module with something that does not exist outside this cell's
        // own closure.
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", subject, {
            detail: `The global "${decision.globalName}" is verified inside a cell, but it is a "${binding.kind}" rather than a host runtime identity a dependency can be mapped onto.`,
          }),
        );
      }
    }
  }

  diagnostics.push(...auditHostGlobalClaims(dependencies));
  return diagnostics;
}

function diagnosticCodeForStrategy(
  strategy: DependencyDecision["strategy"],
): "unresolved-dependency-decision" | "missing-extension-mapping" | "duplicate-host-mapping" {
  switch (strategy) {
    case "extension":
      return "missing-extension-mapping";
    case "host":
      return "duplicate-host-mapping";
    case "replace":
    case "inline":
      return "unresolved-dependency-decision";
  }
}

/**
 * Reports two packages claiming one host global.
 *
 * Separate from the single-decision check because the problem is only visible
 * across decisions: each record is valid on its own, and the artifact still ends
 * up with one global serving two module identities.
 */
function auditHostGlobalClaims(dependencies: readonly DependencyDecision[]): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const claimants = new Map<string, string[]>();

  for (const decision of dependencies) {
    if (decision.strategy !== "host") continue;
    const globalName = decision.globalName.trim();
    if (globalName.length === 0) continue;
    const existing = claimants.get(globalName);
    if (existing === undefined) claimants.set(globalName, [decision.packageName]);
    else if (!existing.includes(decision.packageName)) existing.push(decision.packageName);
  }

  for (const [globalName, packages] of claimants) {
    if (packages.length > 1) {
      diagnostics.push(
        createCellArtifactDiagnostic("duplicate-host-mapping", globalName, {
          detail: `${packages.length} packages map to this host global (${packages.join(", ")}), so they would share one module identity.`,
        }),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Bundler report audit
// ---------------------------------------------------------------------------

/**
 * Every decision at the level that governs a specifier: the exact records, else the
 * package's.
 *
 * The whole point of returning a list rather than one record: a lock can hold more
 * than one record for one module, and a caller that needs to know whether there is a
 * *single* provider has to be able to see the conflict instead of being handed
 * whichever record came first. `auditDependencyDecisions` above already refuses such a
 * list as `unresolved-dependency-decision`; this is how a downstream audit asks the
 * same question without restating the precedence.
 *
 * The precedence is structural, not positional. A package id and one of its subpath ids
 * are distinct records that can both be present with *different* strategies, and the
 * lock's canonical order puts the package first — so a single pass matching "either"
 * would let canonical ordering select the package record and silently ignore an explicit
 * subpath decision. Exact first, then the package fallback, never "whichever comes
 * first".
 */
export function dependencyDecisionsFor(
  dependencies: readonly DependencyDecision[],
  specifier: string,
): readonly DependencyDecision[] {
  const exact = dependencies.filter(decision => decision.packageName === specifier);
  if (exact.length > 0) return exact;

  const packageName = packageNameOfSpecifier(specifier);
  // A bare package name or a source path is its own package name, so there is no
  // fallback record left to look for.
  if (packageName === specifier) return [];

  return dependencies.filter(decision => decision.packageName === packageName);
}

/**
 * The decision that governs a specifier: the first of the exact ones, else the first of
 * the package's.
 *
 * Defined through {@link dependencyDecisionsFor} so there is one implementation of the
 * precedence. For a caller that only needs the record, and for a caller auditing a lock
 * whose records are known to be unique; a caller that has to be sure there is *one*
 * provider uses the list.
 */
export function findDependencyDecision(
  dependencies: readonly DependencyDecision[],
  specifier: string,
): DependencyDecision | undefined {
  return dependencyDecisionsFor(dependencies, specifier)[0];
}

/**
 * Reports every specifier the bundler left external.
 *
 * The decision, not the bundler, says what should have happened instead, so the
 * diagnostic code is chosen from the strategy. This is the mapping that makes the
 * difference between "your bundler is misconfigured" and "your dependency
 * decision is wrong" visible in the report.
 */
function auditExternalImports(
  externalImports: readonly string[],
  dependencies: readonly DependencyDecision[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  for (const specifier of externalImports) {
    const decision = findDependencyDecision(dependencies, specifier);

    if (decision === undefined) {
      // A file path left external is not a missing decision; it is workspace
      // source the bundler failed to flatten, so sending the caller to the
      // dependency layer would point at the wrong fix. The check is exact for
      // relative and absolute specifiers; see `isSourceSpecifier`.
      diagnostics.push(
        isSourceSpecifier(specifier)
          ? createCellArtifactDiagnostic("source-level-import-remains", specifier, {
              detail: `"${specifier}" is workspace source, which is inlined like any other source file, but the bundler left it external.`,
            })
          : createCellArtifactDiagnostic("unresolved-dependency-decision", specifier, {
              detail: `The bundler could not flatten "${specifier}" and no decision covers it.`,
            }),
      );
      continue;
    }

    switch (decision.strategy) {
      case "extension":
        diagnostics.push(
          createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
            detail: `"${specifier}" is decided \`extension\` but reached the artifact as a source import, so no extension global was referenced in its place.`,
          }),
        );
        break;
      case "replace":
        if (decision.rejection.kind === "architectural") {
          diagnostics.push(
            createCellArtifactDiagnostic("platform-conflicting-dependency", decision.packageName, {
              detail: `"${specifier}" was architecturally rejected (${decision.rejection.code}) and still reaches the artifact. ${decision.rejection.remediation}`,
            }),
          );
        } else {
          diagnostics.push(
            createCellArtifactDiagnostic("source-level-import-remains", specifier, {
              detail: `"${specifier}" was rejected as a technical bundling failure (${decision.rejection.code}) but is still imported. ${decision.rejection.remediation}`,
            }),
          );
        }
        break;
      case "host":
        diagnostics.push(
          createCellArtifactDiagnostic("source-level-import-remains", specifier, {
            detail: `"${specifier}" is decided \`host\` and must be referenced through the global "${decision.globalName}"; a surviving import is resolved by nothing at runtime.`,
          }),
        );
        break;
      case "inline":
        diagnostics.push(
          createCellArtifactDiagnostic("source-level-import-remains", specifier, {
            detail: `"${specifier}" is decided \`inline\` but was left external instead of being flattened into the Cell code.`,
          }),
        );
        break;
    }
  }

  return diagnostics;
}

/**
 * Reports packages flattened into the artifact that should not have been.
 *
 * The bundled set is the only place these failures are visible: a bundle that
 * works looks identical to one that carries a second React, an inlined copy of a
 * library the page is also about to load as an extension, or a package the
 * resolver rejected. All three only become real at runtime, which is why they are
 * checked here rather than left to the platform.
 */
function auditInlinedPackages(
  inlinedPackages: readonly string[],
  dependencies: readonly DependencyDecision[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  for (const packageName of inlinedPackages) {
    const decision = findDependencyDecision(dependencies, packageName);
    if (decision === undefined) continue;

    switch (decision.strategy) {
      case "host":
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", decision.packageName, {
            detail: `The bundle contains its own copy of a package decided \`host\`, so the artifact carries a second module identity for the global "${decision.globalName}".`,
          }),
        );
        break;
      case "extension":
        diagnostics.push(
          createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
            detail: `The bundle contains its own copy of a package decided \`extension\`, so the artifact ignores the extension global "${decision.globalName}" the page is told to load and carries a duplicate instead.`,
          }),
        );
        break;
      case "replace":
        if (decision.rejection.kind === "architectural") {
          diagnostics.push(
            createCellArtifactDiagnostic("platform-conflicting-dependency", decision.packageName, {
              detail: `The package was architecturally rejected (${decision.rejection.code}) and was bundled anyway. ${decision.rejection.remediation}`,
            }),
          );
        } else {
          diagnostics.push(
            createCellArtifactDiagnostic("unresolved-dependency-decision", decision.packageName, {
              detail: `The decision for "${decision.packageName}" is \`replace\` because it failed as an artifact (${decision.rejection.code}), yet the bundle contains it. There is no usable decision for the package as it appears here. ${decision.rejection.remediation}`,
            }),
          );
        }
        break;
      case "inline":
        // Exactly what should have happened.
        break;
    }
  }

  return diagnostics;
}

function auditEmittedAssets(emittedAssets: readonly string[]): readonly CellArtifactDiagnostic[] {
  return emittedAssets.map(asset =>
    createCellArtifactDiagnostic("unsupported-runtime-asset", asset, {
      detail: `The bundler emitted "${asset}" beside the Cell code. A ReactCellType cell is one script, so there is nowhere for a sibling asset to be loaded from.`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Source and budget audit
// ---------------------------------------------------------------------------

/**
 * Runs both source checks over a composed artifact.
 *
 * Shared by assembly and verification on purpose. The two callers differ only in
 * what they can say about *where* a construct came from — assembly knows which
 * part of the artifact it composed, verification only has the finished string —
 * so the origin is a function of the offset rather than a reason to write the
 * checks twice. Two copies would be two places for the wording or the code to
 * drift, which is exactly what makes a report disagree with itself.
 *
 * One audit call, not two, because both checks need the same parse and an artifact
 * can be megabytes of minified bundle.
 */
function auditArtifactSource(
  composedCode: string,
  originOf: (index: number) => string,
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const audit = auditCellSource(composedCode);

  for (const finding of audit.findings) {
    diagnostics.push(
      createCellArtifactDiagnostic("rejected-cell-source-construct", finding.specifier ?? finding.match, {
        detail: `Found ${finding.occurrences} time(s) in ${originOf(finding.index)}, at line ${finding.line}. ReactCellType rejects it with: "${finding.platformMessage}"`,
        location: `line ${finding.line}`,
      }),
    );
  }

  for (const dynamicImport of audit.dynamicImports) {
    diagnostics.push(
      createCellArtifactDiagnostic("unsupported-runtime-asset", dynamicImport.match, {
        detail: `Found ${dynamicImport.occurrences} dynamic import call(s) in ${originOf(dynamicImport.index)}, at line ${dynamicImport.line}. The platform validator does not reject these, so nothing downstream will catch one that survives into production.`,
        location: `line ${dynamicImport.line}`,
      }),
    );
  }

  return diagnostics;
}

/**
 * Attributes an offset in a composed artifact to the part it came from.
 *
 * By offset rather than by comparing line counts: the composed source has a
 * header line before the bundle, so line arithmetic would be off by one in
 * exactly the case the origin matters most. A test covers it by asserting that a
 * construct near the bundle's end is still attributed to the bundle.
 */
function artifactOriginOf(bundledCode: string): (index: number) => string {
  const bundleStart = CELL_ARTIFACT_BANNER.length + 1;
  const bundleEnd = bundleStart + bundledCode.length;
  return index => {
    if (index < bundleStart) return "the generated artifact header";
    if (index < bundleEnd) return "bundled dependency code";
    return "the generated entry wrapper";
  };
}

function auditCodeBudget(code: string, budget: number | undefined): readonly CellArtifactDiagnostic[] {
  if (budget === undefined || code.length <= budget) return [];
  return [
    createCellArtifactDiagnostic("cell-code-budget-exceeded", "Cell artifact", {
      detail: `The composed artifact is ${code.length} characters against a configured budget of ${budget}. The measurement is taken on the composed artifact because that is what is written into the cell.`,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Verification and serialization
// ---------------------------------------------------------------------------

/**
 * Re-checks an artifact that was assembled somewhere else, or read back out.
 *
 * This is the weaker half of the contract and it is important not to oversell it:
 * `CompileCellResult` carries no entry metadata, so nothing here can confirm which
 * entry shape the code exposes. What it can confirm is that the artifact is
 * canonical and carries no refused construct — the two properties a diff and a
 * reviewer depend on.
 */
export function verifyCellArtifact(artifact: CompileCellResult): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  if (!artifact.code.startsWith(CELL_ARTIFACT_BANNER)) {
    diagnostics.push(
      createCellArtifactDiagnostic("non-canonical-artifact-metadata", "code", {
        detail:
          "The artifact does not begin with the generated-artifact banner, so it was edited after generation or produced by something other than this compiler.",
      }),
    );
  }

  diagnostics.push(...auditFrontendLibraries(artifact.frontendLibraries));

  // Nothing here can say which part of the artifact a construct came from: the
  // result carries no provenance. The wording is one sentence rather than two
  // because the honest answer for this caller is "the artifact".
  diagnostics.push(...auditArtifactSource(artifact.code, () => "the artifact"));

  return dedupeCellArtifactDiagnostics(diagnostics);
}

/**
 * The canonical serialization of a result.
 *
 * Exists so "deterministic" is a property a test can assert rather than a word in
 * a guarantee. Key order is written out instead of relied upon, and the trailing
 * newline makes the string a well-formed file.
 */
export function serializeCompileCellResult(artifact: CompileCellResult): string {
  const canonical = {
    code: artifact.code,
    [FRONTEND_LIBRARIES_FIELD_NAME]: artifact.frontendLibraries.map(library => ({
      libraryId: library.libraryId,
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** A report block for a CI log or a PR body, including which promises remain unproven. */
export function formatCompileCellOutcome(outcome: CompileCellOutcome): string {
  if (outcome.status === "compiled") {
    const ids = frontendLibraryIds(outcome.artifact.frontendLibraries);
    return [
      `Compiled Cell artifact: ${outcome.artifact.code.length} characters, entry shape "${outcome.entryKind}".`,
      `${FRONTEND_LIBRARIES_FIELD_NAME}: ${ids.join(", ") || "(none)"}`,
      "Real Forguncy runtime validation is not established by a local compile.",
    ].join("\n");
  }
  return `Compilation rejected with ${outcome.diagnostics.length} diagnostic(s):\n${formatCellArtifactDiagnostics(outcome.diagnostics)}`;
}

// ---------------------------------------------------------------------------
// The boundary function
// ---------------------------------------------------------------------------

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The public entry point.
 *
 * Bundler failure is converted into a diagnostic rather than rethrown: #6's error
 * model exists so a caller never has to interpret an opaque build string, and an
 * escaping exception is exactly that string.
 */
export async function compileCell(
  input: CompileCellInput,
  options: CompileCellOptions,
): Promise<CompileCellOutcome> {
  let module: BundledCellModule;
  try {
    module = await options.bundler.bundle({
      entry: input.entry,
      dependencies: input.dependencies,
      // The one thing the two halves of the pipeline must agree on, handed over
      // rather than assumed.
      componentBinding: CELL_ENTRY_COMPONENT_BINDING,
    });
  } catch (error) {
    return {
      status: "rejected",
      diagnostics: [
        createCellArtifactDiagnostic("bundler-failure", input.entry, {
          detail: `The bundler reported: ${describeThrown(error)}`,
        }),
      ],
    };
  }

  return assembleCellArtifact({
    module,
    dependencies: input.dependencies,
    ...(options.entryKind === undefined ? {} : { entryKind: options.entryKind }),
    ...(options.codeBudgetCharacters === undefined
      ? {}
      : { codeBudgetCharacters: options.codeBudgetCharacters }),
  });
}
