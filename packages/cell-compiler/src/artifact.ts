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

import {
  CELL_USER_SCOPE_BINDINGS,
  classifyCellCodeSize,
  validateDependencyDecisionShape,
} from "@forguncy-react-workspace/core";
import type {
  CellEntryKind,
  CellUserScopeBinding,
  DependencyDecision,
  FrontendLibraryReference,
} from "@forguncy-react-workspace/core";

import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import {
  createCellArtifactDiagnostic,
  dedupeCellArtifactDiagnostics,
  formatCellArtifactDiagnostics,
} from "./diagnostics.ts";
import { CELL_ENTRY_COMPONENT_BINDING, renderCellEntryWrapper } from "./entry.ts";
import {
  auditFrontendLibraries,
  collectFrontendLibraries,
  FRONTEND_LIBRARIES_FIELD_NAME,
  frontendLibraryIds,
} from "./frontend-libraries.ts";
import { auditCellSource } from "./source-guard.ts";
// The shared specifier/decision primitives. Imported for this module's own use *and*
// re-exported below: the extraction to a leaf module is an internal restructuring, so
// every existing caller of the boundary keeps working.
import {
  dependencyDecisionsFor,
  findDependencyDecision,
  isSourceSpecifier,
  packageNameOfSpecifier,
} from "./specifier.ts";
import type {
  WorkspaceGraph,
  WorkspaceSourceAudit,
  WorkspaceSourceDiagnostic,
} from "./workspace-source.ts";
import { auditWorkspaceSource, formatWorkspaceSourceAudit } from "./workspace-source.ts";

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
  /**
   * Bare specifiers the bundler actually inlined from installed packages.
   *
   * Package names fold `sneaky-dep` and `sneaky-dep/subpath` into one entry,
   * which destroys the exact-subpath precedence `findDependencyDecision` relies
   * on. Specifier-level provenance lets each decision lookup use the real bare
   * specifier. Optional because fixture bundlers only report package names.
   */
  readonly inlinedSpecifiers?: readonly string[];
  /** Files the bundler emitted next to `code`. Any entry breaks the single-artifact contract. */
  readonly emittedAssets?: readonly string[];
  /**
   * The bare specifiers the build's module graph actually contained.
   *
   * What #14's workspace audit calls the entry's module ids: the set it traces a
   * source closure from. A *superset* of the entry file's own imports is safe and
   * deliberate here — the bundler reports every bare specifier some module in the
   * graph asked for, and every such module is reachable from the entry (otherwise
   * it would not be in the graph), so the closure over this set is the entry's
   * closure. Reporting only the entry file's imports would instead require the
   * bundler to attribute an import to a module, which is a different question the
   * artifact contract has no use for.
   *
   * Optional because a fixture bundler has no module graph to report, and the audit
   * then abstains (`usage: "unstated"`) rather than claiming the cell imports
   * nothing — #14's rule that an absent input is not an empty one.
   */
  readonly referencedSpecifiers?: readonly string[];
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
 * The bare specifiers the entry's module graph contains, without generating code.
 *
 * A separate call from {@link CellBundlerPort.bundle} because of *when* it is needed
 * rather than what it computes: #14 requires a reachable workspace cycle to fail
 * "before bundling rather than to be resolved by whichever traversal happens to run
 * first", and the cycle is only visible once the entry's imports are known. Asking
 * the bundler for the graph first is what lets that refusal happen before any code
 * is generated — a bundler that could only answer after building would make the
 * ordering requirement unsatisfiable, not merely slower.
 *
 * `dependencies` is carried, and that is not a convenience: interception *is* a
 * resolution decision. A `host`- or `extension`-decided package resolves to the
 * plan's virtual module instead of to `node_modules`, which both keeps the local
 * source from being traversed and keeps an uninstalled host package from failing
 * resolution. A pass without the decisions would report a different specifier set
 * than the build — the exact disagreement this preflight exists to avoid.
 *
 * `componentBinding` is the one field genuinely absent, because nothing is bound:
 * binding is what `bundle` does.
 */
export interface CellResolveRequest {
  readonly entry: string;
  readonly dependencies: readonly DependencyDecision[];
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
  /**
   * The entry's bare specifiers, resolved but not built. **Optional.**
   *
   * It exists for one caller: a compile that was given a workspace graph, where
   * #14's two fatal findings have to be observable *before* anything is built — see
   * {@link compileCell}. Without a graph there is no workspace audit to run, so a
   * port that only implements `bundle` is complete for every #6 caller, and
   * requiring the method would have changed that public boundary for no runtime
   * benefit.
   *
   * Optional is not a licence to fall back silently. When a graph *is* supplied and
   * this method is absent, {@link compileCell} refuses the compile with
   * `bundler-failure` rather than auditing after the build: the pre-bundle guarantee
   * is mandatory exactly when a workspace graph makes it meaningful, and a quiet
   * fallback would reintroduce the defect the split exists to prevent.
   */
  readonly resolveEntrySpecifiers?: (request: CellResolveRequest) => Promise<readonly string[]>;
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
  /**
   * The workspace graph this compile resolves against, when the project has one.
   *
   * Take it from {@link loadPnpmWorkspaceGraph} — `(await loadPnpmWorkspaceGraph({ root })).graph` —
   * which reads it from the project's own `pnpm-workspace.yaml` and member manifests.
   * The parameter's whole point is that the compiler is handed the *real* Vite+/pnpm
   * graph rather than a hand-written one, which is the criterion #14 moved to #15.
   *
   * Pass the **raw graph**, not the loader's index: the audit indexes it itself, so
   * a graph whose own coherence is broken (a duplicated name, a machine-specific
   * directory) reports that finding as part of the same result instead of having it
   * silently dropped. The loader returns both together for exactly this reason.
   *
   * Absent means "the caller did not state a graph", and the workspace audit then
   * abstains exactly as #14 requires — no claim is made about workspace packages,
   * which is the #6 behaviour rather than a claim that none are involved. Passing
   * the graph does **not** change how modules resolve: the bundler still resolves
   * through `node_modules`, and this option adds an *audit* of the result, never a
   * second resolver (#6 forbids one).
   */
  readonly workspace?: WorkspaceGraph;
}

/**
 * Compilation either produced an artifact or did not.
 *
 * Not `CompileCellResult | diagnostics`: a caller that has to test whether
 * `code` is present will eventually forget, and the failure mode of forgetting is
 * writing an empty cell.
 *
 * `workspace` is present only when the caller supplied a graph *and* the audit ran
 * to completion. It is a separate field rather than more `CellArtifactDiagnostic`s
 * because #14's vocabulary is a different one and the two must not be collapsed:
 * `workspace-source.ts` states that wiring the audit into artifact assembly would
 * "decide by accident" how the two vocabularies compose, and the answer chosen here
 * is that they do not — an artifact diagnostic says the *artifact* breaks a #6
 * guarantee, while a workspace diagnostic says something about the *project's*
 * declarations. A caller reading one report sees both without one being restated in
 * the other's terms.
 */
export type CompileCellOutcome =
  | {
      readonly status: "compiled";
      readonly artifact: CompileCellResult;
      readonly entryKind: CellEntryKind;
      /** #14's audit of the graph this compile was given, when one was given. */
      readonly workspace?: WorkspaceSourceAudit;
    }
  | {
      readonly status: "rejected";
      readonly diagnostics: readonly CellArtifactDiagnostic[];
      /**
       * The workspace audit that caused the rejection, when one did.
       *
       * Set on the paths #14 requires to fail *before* bundling. Present so a caller
       * does not have to re-run the audit to read the finding that stopped the
       * build; absent when the rejection came from the artifact audits, which keep
       * using the artifact vocabulary alone.
       */
      readonly workspace?: WorkspaceSourceAudit;
    };

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

/**
 * The specifier and decision-lookup primitives, re-exported from their own module.
 *
 * They live in `specifier.ts` because this boundary now *consumes* #14's workspace
 * audit, and the workspace contract imports these same four functions — importing
 * the audit here while they stayed defined here would have made the two modules a
 * cycle. See that module's header for why a cycle was not acceptable even though it
 * turned out to be survivable.
 *
 * Re-exported rather than merely moved so this package's public surface and every
 * existing caller are unchanged: the extraction is an internal restructuring, and a
 * caller that imported `packageNameOfSpecifier` from here keeps working.
 */
export {
  dependencyDecisionsFor,
  findDependencyDecision,
  isSourceSpecifier,
  packageNameOfSpecifier,
} from "./specifier.ts";

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
  const inlinedDiagnostics = auditInlinedPackages(module.inlinedPackages ?? [], dependencies, module.inlinedSpecifiers);
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
  inlinedSpecifiers?: readonly string[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  // Specifier-level provenance when present: each bare specifier keeps its
  // exact-subpath identity so `findDependencyDecision` can apply exact-first
  // precedence. Package names fall back for fixture bundlers that only report
  // package roots, and for packages in the set that no specifier covers.
  const specifierPackageNames = new Set(
    (inlinedSpecifiers ?? []).map(specifier => packageNameOfSpecifier(specifier)),
  );
  const leftoverPackages = inlinedPackages.filter(name => !specifierPackageNames.has(name));
  const subjects = [...(inlinedSpecifiers ?? []), ...leftoverPackages];

  for (const subject of subjects) {
    const decision = findDependencyDecision(dependencies, subject);
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

/**
 * Checks a composed artifact against the caller's budget, saying *which measured
 * band* the size falls in.
 *
 * Decision source: GitHub Issue #21 —
 * "Research: measure ReactCellType generated-code budget and performance envelope"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/21). Before #21 this
 * function reported only "over budget", which is the one thing a caller can act on
 * and the least useful thing it could say: a 600 KiB artifact and a 4 MiB one are
 * both "over" a 512 KiB budget and are not remotely the same decision.
 *
 * The band comes from `core`'s measured record rather than from a second table
 * here. `core` owns the measurement (#21) and `cell-compiler` takes it as
 * configuration — the same division the package's other Specs use, and the reason
 * the measurement is not restated: two copies would drift, and the drift would be
 * invisible because both would look plausible.
 *
 * The code stays `cell-code-budget-exceeded`, because that is #6's public
 * vocabulary and a downstream consumer branches on it. What changed is that the
 * detail now names the band and the measured cost, so a caller that sees this
 * diagnostic can tell "worth a look" from "get an extension" without re-deriving
 * the thresholds.
 */
function auditCodeBudget(code: string, budget: number | undefined): readonly CellArtifactDiagnostic[] {
  if (budget === undefined) return [];

  // The budget is validated, not trusted. An unvalidated one fails in the most
  // confusing direction available: `code.length <= Number.NaN` is `false`, so a
  // NaN budget rejects *every* artifact with "against a configured budget of NaN",
  // which reads like a size problem and is a caller's typo. Refusing it here puts
  // the report on the field that is actually wrong. `classifyCellCodeSize` guards
  // the size for the same reason; the two guards are deliberately symmetric.
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(
      `A cell code budget must be a non-negative finite number of characters, received ${String(budget)}.`,
    );
  }

  if (code.length <= budget) return [];

  const verdict = classifyCellCodeSize(code.length);
  const { write, browserEntry } = verdict.definition.representativeMeasurements;

  // Two different situations produce this diagnostic and they need different
  // advice, which is why the guidance is chosen rather than copied from the band:
  //
  // - The artifact is large by measurement (`review` or above). The band's own
  //   guidance is the right advice.
  // - The artifact is inside the measured ordinary range and the *budget* is what
  //   is tight. Printing the inline band's "no review needed" next to a hard
  //   rejection would have the diagnostic contradict itself, and would send the
  //   caller looking for a problem in an artifact the measurement says is fine.
  //
  // The second case is the one where the two concepts must not be conflated, so it
  // says what is actually true of this rejection: the budget is a hard cap, and the
  // band is an advisory classification that a raised cap does not start reporting.
  //
  // The claim is scoped to *this* check, and that scoping is load-bearing. This
  // function returns one diagnostic among several that `assembleCellArtifact`
  // collects, so an artifact can carry a budget rejection beside an unrelated one —
  // reproduced with an unflattened inline import: a tight budget yields
  // `[source-level-import-remains, cell-code-budget-exceeded]`, and raising the
  // budget yields `[source-level-import-remains]` and the compile is *still*
  // rejected. Saying a raised budget "accepts the artifact outright" would be false
  // in exactly that case, and would send the caller away believing the build is
  // clean. Nothing here knows whether other diagnostics exist, so the honest form is
  // conditional: this rejection goes, anything else stands.
  const guidance = verdict.withinInlineBand
    ? `The artifact is inside the measured ordinary range (${verdict.band}, ceiling ` +
      `${String(verdict.definition.maxCharacters)} characters), so this rejection is the configured budget's ` +
      `rather than a cost the measurement found. Raising the budget removes this budget rejection; any other ` +
      `artifact diagnostic still applies. Bands are an advisory classification, not a severity this diagnostic ` +
      `re-reports once a size is allowed.`
    : verdict.definition.guidance;

  return [
    createCellArtifactDiagnostic("cell-code-budget-exceeded", "Cell artifact", {
      detail:
        `The composed artifact is ${code.length} characters against a configured budget of ${budget}. ` +
        `The measurement is taken on the composed artifact because that is what is written into the cell. ` +
        `Measured band: ${verdict.band} (#21). At this band's own measured points the designer write took ` +
        `${String(write.ms)} ms at ${String(write.characters)} characters (${write.artifact}) and the ` +
        `browser's first cell entry took ${String(browserEntry.ms)} ms at ` +
        `${String(browserEntry.characters)} characters (${browserEntry.artifact}). ${guidance}`,
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

/**
 * A report block for a CI log or a PR body, including which promises remain unproven.
 *
 * ## Why the workspace audit is printed here
 *
 * A workspace rejection carries `diagnostics: []` **by design** — #14's vocabulary is
 * not #6's, so a cycle or an intercepting decision is reported through `workspace`
 * rather than restated as a `CellArtifactDiagnostic`. That decision is only useful if
 * the finding reaches a reader, and this function is the package's standard reporting
 * path. Formatting `outcome.diagnostics` alone printed
 * `Compilation rejected with 0 diagnostic(s):` — the structured diagnostic existed in
 * memory and reached nobody, which would have undermined the very path this seam
 * adds.
 *
 * So whenever a workspace audit is present it is printed in full, on both outcomes.
 * On a *compiled* outcome that is the point rather than a bonus: the non-fatal
 * findings (`workspace-package-in-frontend-libraries`, a transitive dependency with
 * no decision) are exactly the ones a reader has to act on, and an artifact that
 * compiles is where they are easiest to miss.
 *
 * A `WorkspaceSourceAudit` with nothing wrong still prints its summary lines, which is
 * `formatWorkspaceSourceAudit`'s own contract — "no diagnostics" must not be readable
 * as "the declared sharing was verified".
 */
export function formatCompileCellOutcome(outcome: CompileCellOutcome): string {
  const workspace = outcome.workspace === undefined ? [] : ["", formatWorkspaceSourceAudit(outcome.workspace)];

  if (outcome.status === "compiled") {
    const ids = frontendLibraryIds(outcome.artifact.frontendLibraries);
    return [
      `Compiled Cell artifact: ${outcome.artifact.code.length} characters, entry shape "${outcome.entryKind}".`,
      `${FRONTEND_LIBRARIES_FIELD_NAME}: ${ids.join(", ") || "(none)"}`,
      "Real Forguncy runtime validation is not established by a local compile.",
      ...workspace,
    ].join("\n");
  }

  // The counts are reported per vocabulary rather than summed, because they are not
  // the same kind of finding and a caller branching on either needs to see which one
  // stopped the build. #6's diagnostics are empty on a pre-bundle rejection by design.
  const artifactDiagnostics = `Compilation rejected with ${outcome.diagnostics.length} diagnostic(s):\n${formatCellArtifactDiagnostics(outcome.diagnostics)}`;
  return [artifactDiagnostics, ...workspace].join("\n");
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
 *
 * ## The workspace seam (#14 / #15)
 *
 * When the caller supplies `options.workspace`, `#14`'s audit runs over this compile
 * and its result rides on the outcome as `workspace`. The seam has three parts, and
 * the *order* is the part that matters.
 *
 * **1. A pre-bundle pass establishes what the cell imports.** The entry's specifiers
 * are resolved but not built (`CellBundlerPort.resolveEntrySpecifiers`), and the
 * audit's user-facing checks run against them. This happens *first* because two of
 * the findings below have to stop the compile before any code is generated.
 *
 * **2. Two findings are fatal, and both are fatal before bundling.**
 *
 * - *A reachable workspace cycle.* #14 requires it to fail "before bundling rather
 *   than to be resolved by whichever traversal happens to run first". The bundler
 *   will happily inline a cyclic graph — ESM permits cycles — so the output looks
 *   fine and the ordering it picked is invisible in the result. Nothing downstream
 *   can catch it, and a bundler failure racing it could hide the structured
 *   diagnostic entirely.
 * - *A dependency decision that can intercept workspace source.* This one is
 *   subtle enough to spell out. The bundler consults the host-bridge and
 *   extension-externals plans *during resolution*, so a decision naming a module id
 *   that a mapping also claims lets `interceptionFor` replace the import with a
 *   virtual runtime module **before** Rolldown ever resolves the local source. The
 *   artifact then contains no workspace import and no inlined workspace package, so
 *   every artifact-side audit passes — while the local package the cell actually
 *   imported was silently discarded. A local package named `antd` beside a `host`
 *   decision for `antd` is the working example. #14's output semantics are exactly
 *   what that violates, and only a check made *before* resolution can see it.
 *
 * **3. Everything else is reported, not fatal.** The remaining workspace findings
 * that mean "this artifact has a runtime dependency on another workspace package"
 * are already fatal from the output side: a workspace import the bundler left
 * external reaches `auditExternalImports` as an unresolved decision, and a workspace
 * package named in `frontendLibraries` trips that audit directly. Reporting those
 * twice as two rejections would state one condition in two vocabularies, which is
 * what `workspace-source.ts` records as the thing to avoid.
 *
 * **The audit still never resolves anything.** The graph is an *input to an audit*,
 * not a second resolver: modules resolve through the bundler and `node_modules`, and
 * removing the option changes no artifact byte. #6 forbids a second module resolver,
 * and a graph that quietly redirected resolution would be exactly that.
 */
export async function compileCell(
  input: CompileCellInput,
  options: CompileCellOptions,
): Promise<CompileCellOutcome> {
  // The pre-bundle pass runs **only** when a graph was supplied, because it exists
  // for one purpose: making #14's two fatal findings observable before anything is
  // built. With no graph there is no workspace audit to run and nothing for the
  // preflight to decide — so a graph-less #6 compile takes exactly the path it took
  // before this seam existed: one `bundle()` and no analysis pass.
  let entrySpecifiers: readonly string[] | undefined;
  if (options.workspace !== undefined) {
    const resolveEntrySpecifiers = options.bundler.resolveEntrySpecifiers;
    // A graph was supplied, so the pre-bundle guarantee is mandatory — and a port
    // without the capability is refused rather than quietly audited after the build.
    // That is the bound on the method being optional: optional preserves the
    // graph-less boundary, and this makes the guarantee binding exactly when a
    // workspace graph makes it meaningful. Falling back here would restore the defect
    // the split exists to prevent — a cycle discovered only after Rolldown bundled.
    if (resolveEntrySpecifiers === undefined) {
      return {
        status: "rejected",
        diagnostics: [
          createCellArtifactDiagnostic("bundler-failure", input.entry, {
            detail:
              "A workspace graph was supplied, so the entry's specifiers must be resolved before bundling — but this bundler port implements no `resolveEntrySpecifiers`. #14 requires a reachable workspace cycle to fail before bundling, which cannot be decided without it. Use a port that provides the method, or omit `workspace`.",
          }),
        ],
      };
    }

    try {
      entrySpecifiers = await resolveEntrySpecifiers({
        entry: input.entry,
        dependencies: input.dependencies,
      });
    } catch (error) {
      return {
        status: "rejected",
        diagnostics: [
          createCellArtifactDiagnostic("bundler-failure", input.entry, {
            detail: `The bundler could not resolve the entry: ${describeThrown(error)}`,
          }),
        ],
      };
    }

    const preflight = auditWorkspaceSource({
      workspace: options.workspace,
      dependencies: input.dependencies,
      entryModuleIds: entrySpecifiers,
      frontendLibraries: collectFrontendLibraries(input.dependencies).libraries,
    });

    if (preflight.diagnostics.some(isPreBundleFatalWorkspaceDiagnostic)) {
      return {
        status: "rejected",
        // Empty on purpose: #14's vocabulary is not #6's, so a workspace finding is
        // reported through `workspace` rather than restated as a
        // `CellArtifactDiagnostic` whose `breaksGuarantees` would have to name a #6
        // guarantee it is not about. Nothing was built, so there is nothing for the
        // artifact vocabulary to describe either.
        diagnostics: [],
        // The whole audit, not only the fatal findings: a caller reading a rejection
        // should see everything wrong with the graph, not just the one thing that
        // stopped it. This is the audit the post-build step would have produced, minus
        // the two inputs only the output can supply.
        workspace: preflight,
      };
    }
  }

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

  // The post-build audit, over the same graph, now with what the build actually
  // produced. It re-runs the preflight checks (they cannot newly fail) and adds the
  // two that need the output: what the bundler left external, and the metadata that
  // will be written.
  //
  // `entrySpecifiers` is defined whenever `options.workspace` is — the pre-bundle
  // block above sets both together — so the pair is read from one narrowing rather
  // than two independent `undefined` checks that could drift apart.
  const workspace =
    options.workspace === undefined || entrySpecifiers === undefined
      ? undefined
      : auditWorkspaceForCompile(input, options.workspace, module, entrySpecifiers);

  const outcome = assembleCellArtifact({
    module,
    dependencies: input.dependencies,
    ...(options.entryKind === undefined ? {} : { entryKind: options.entryKind }),
    ...(options.codeBudgetCharacters === undefined
      ? {}
      : { codeBudgetCharacters: options.codeBudgetCharacters }),
  });

  return workspace === undefined ? outcome : { ...outcome, workspace };
}

/**
 * The workspace findings that stop a compile *before* any code is generated.
 *
 * Two codes, and each is here because nothing downstream can catch it — see
 * `compileCell`'s header for the full argument. `circular-workspace-dependency` is
 * #14's own "fail before bundling" requirement; a decision that can intercept
 * workspace source is invisible the moment resolution replaces the import, so the
 * artifact audits that would otherwise be the safety net cannot see it at all.
 *
 * A named predicate rather than an inline list so a future fatal code has one place
 * to be added, and so the *reason* each is fatal is documented where it is enforced.
 */
function isPreBundleFatalWorkspaceDiagnostic(diagnostic: WorkspaceSourceDiagnostic): boolean {
  return (
    diagnostic.code === "circular-workspace-dependency" ||
    diagnostic.code === "workspace-package-decided-as-dependency"
  );
}

/**
 * `#14`'s audit, with this compile's inputs.
 *
 * Every input is taken from something the build already established rather than
 * asked of the caller a second time:
 *
 * - the graph is the caller's `options.workspace`, read from the project's own
 *   manifest by `loadPnpmWorkspaceGraph`;
 * - the entry's module ids are the bundler's, from the pre-bundle pass;
 * - the external imports are the bundler's own report, so the audit sees what
 *   actually survived rather than what was authored;
 * - `frontendLibraries` is derived from the decisions by the same function assembly
 *   uses, so the metadata the audit checks and the metadata the artifact carries are
 *   one computation.
 *
 * The graph is handed over *raw* rather than pre-indexed, which is deliberate: the
 * audit indexes it itself, so a graph whose own coherence is broken (a duplicated
 * name, a machine-specific directory) reports that as part of this same result.
 * Passing an already-indexed graph would silently drop exactly those findings.
 */
function auditWorkspaceForCompile(
  input: CompileCellInput,
  workspace: WorkspaceGraph,
  module: BundledCellModule,
  entrySpecifiers: readonly string[],
): WorkspaceSourceAudit {
  return auditWorkspaceSource({
    workspace,
    dependencies: input.dependencies,
    externalImports: module.externalImports ?? [],
    frontendLibraries: collectFrontendLibraries(input.dependencies).libraries,
    entryModuleIds: entrySpecifiers,
  });
}
