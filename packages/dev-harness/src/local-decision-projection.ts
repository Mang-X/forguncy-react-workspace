/**
 * The compiler's own lock projection, run locally — and the boundary where local stops being able
 * to mirror it.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #8 — "Spec: reproducible dependency decisions and `fgc.lock.json`"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/8), which owns freshness and the
 *   evidence policy
 * - #4 — "Spec: application ownership boundaries and dependency strategy semantics"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/4)
 *
 * ## The defect this module closes, found by review
 *
 * `local-dev-audit.ts` originally read the lock and handed the records to the audit. Review found
 * that this shares neither of the two projections the compiler applies before it will compile a
 * dependency:
 *
 * 1. **target selection** — a decision is keyed by `(packageName, cellTarget)`, so the mounted
 *    Cell's effective record has to be resolved first. (`effectiveDecisionsForCell`, done.)
 * 2. **validity** — `auditLockDecisionConformance` checks the lock against the strategy and mapping
 *    contracts, and `localCompilationDependencies` withholds records whose evidence is stale.
 *
 * Both matter here because of what the *compiler* does with a decision it withholds:
 * `compileCell` rejects the artifact with `unresolved-dependency-decision`. So a harness that
 * applied a record the compiler would withhold could render a Cell locally against a declared
 * substitute while the very same source refuses to compile — a green local render for an artifact
 * that cannot exist.
 *
 * ## The boundary, measured rather than assumed, and why it is a report
 *
 * Running the compiler's pipeline needs a `LockEnvironment`, and two of its axes are not locally
 * observable. Measured on `examples/extension-query`'s real lock, with only what a local process can
 * see:
 *
 * ```
 * localCompilationDependencies(lock, localEnvironment)
 *   deps     = []
 *   withheld = ["@tanstack/react-query:not-verified:
 *               [probe-fingerprint-unknown, extension-version-unknown, extension-identity-unknown]"]
 * ```
 *
 * - **extension version / identity** come from the *page* — `api.app.listFrontendLibraries` is the
 *   only source the repository has (`probe/probe-engine.ts`), and there is no page here.
 * - **probe fingerprints** are recomposable in principle ("a deterministic function of declared
 *   inputs"), but the composer lives in `probe/fingerprint.ts`, whose declared inputs include
 *   `BUILD_CONFIGURATION_FINGERPRINT` from `probe/build.ts` — the module that imports `rolldown`.
 *   Recomputing one locally would pull the bundler back in, which is what
 *   `dependency-resolver/local` exists to avoid.
 *
 * So "withhold everything the compiler withholds" is not available: on a project with any
 * `extension` dependency it would withholds *every* extension record, the harness would see no
 * `extension` strategy, and a Cell importing one would resolve silently through npm — the first
 * defect this whole line of work closed, restored. Refusing to start instead would be a false
 * blocking finding for a project whose lock the compiler accepts.
 *
 * What this module does therefore splits by axis, and the split is the design:
 *
 * - axes a local process **can** judge decide — `conformance`, which the compiler runs before
 *   compiling, and `package-version` freshness, read from the workspace's own install graph;
 * - axes it **cannot** judge are reported as a boundary and do not silently withhold.
 *
 * A conformance error is a *blocking* finding: the compiler refuses those records outright, so the
 * local loop refusing them too is the same answer rather than a stricter one. A locally-judged
 * staleness (`package-version-changed`) is reported and the record is withheld, because a local
 * process genuinely can see that the installed version moved.
 *
 * A boundary axis never withholds, and that is the honest direction rather than the convenient one:
 * this process cannot show the record is still valid, and it equally cannot show it is not. The
 * report says which axis it could not check, so a developer reading a green local render knows
 * exactly what it does not cover — which is the same discipline
 * `formatLocalDevValidationDistinction()` applies to the loop as a whole.
 */

import { dependencyDecisionOf, EXTENSION_EXTERNAL_MAPPINGS, findLockDecision } from "@forguncy-react-workspace/core";
import type { DependencyDecision, FgcLockDocument, LockStalenessReason } from "@forguncy-react-workspace/core";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditLockDecisionConformance,
  localCompilationDependencies,
} from "@forguncy-react-workspace/dependency-resolver/local";
import type { ConformanceDiagnostic, ExtensionCatalog } from "@forguncy-react-workspace/dependency-resolver/local";
import type { LockEnvironment } from "@forguncy-react-workspace/core";

/**
 * The staleness reasons no local process can evaluate.
 *
 * Derived from what the environment needs and this process cannot supply, and the two groups are
 * separate sentences in the report rather than one list, because they are two different
 * capabilities:
 *
 * - `extension-*` needs the page's own `listFrontendLibraries` answer;
 * - `probe-fingerprint-*` needs the probe engine's composer, which reaches a bundler.
 *
 * Everything else — `package-version-*`, `forguncy-target-*`, `toolchain-*`, `probe-never-run`,
 * `probe-failed` — is decidable from the lock plus the project's install graph, so a record carrying
 * one of those is withheld for real.
 */
export const LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS: readonly LockStalenessReason[] = [
  "extension-version-unknown",
  "extension-version-changed",
  "extension-identity-unknown",
  "extension-identity-changed",
  "probe-fingerprint-unknown",
  "probe-fingerprint-changed",
];

/**
 * `core`'s verified extension mappings, projected onto the catalog shape this audit reads.
 *
 * Derived rather than listed — the same three fields `extension-query-poc.test.ts` takes — so a row
 * added to the mapping table reaches both callers. `metadataSource`, `verificationRule` and the
 * rest of a mapping row are the compiler's business and are not part of this shape.
 */
export const DEFAULT_LOCAL_EXTENSION_CATALOG: ExtensionCatalog = {
  mappings: EXTENSION_EXTERNAL_MAPPINGS.map(mapping => ({
    packageName: mapping.packageName,
    libraryId: mapping.libraryId,
    globalName: mapping.globalName,
  })),
};

/** The directory this package's own files live in, from the module URL — as `host-modules.ts` does. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Whether every reason on a record is one this process cannot evaluate. */
function isLocallyObservable(reason: LockStalenessReason): boolean {
  return !LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS.includes(reason);
}

/** A record the compiler would refuse, and why, in the compiler's own vocabulary. */
export interface WithheldLocalDecision {
  readonly packageName: string;
  readonly strategy: string;
  /**
   * The compiler's own discriminator, not a boolean: `not-verified` means the record exists but its
   * evidence went stale, while `replace-cache` means rule 4 of #8 keeps a rejection out of the graph
   * — two different statements about a package, which is why they are two members and not one flag.
   */
  readonly reason: "not-verified" | "replace-cache";
  /** The reasons, as `lockDecisionBlockers` and the projection report them. Empty for a rejection. */
  readonly stalenessReasons: readonly LockStalenessReason[];
}

/** The lock's decisions, as far as a local process can validate them. */
export interface LocalDecisionProjection {
  /** The decisions the harness may act on. */
  readonly decisions: readonly DependencyDecision[];
  /**
   * Conformance errors: the compiler refuses these before compiling, so the local loop does too.
   *
   * Blocking, because the compiler's answer is not to compile the dependency at all rather than to
   * compile it differently — a local substitute for such a record would be a render for an artifact
   * that cannot be produced.
   */
  readonly conformanceErrors: readonly ConformanceDiagnostic[];
  /**
   * Records withheld because a locally-judged axis went stale.
   *
   * Reported, not silently dropped: the whole point of the finding is that the developer sees the
   * lock needs attention, rather than seeing a Cell that renders because the harness quietly
   * substituted for a dependency the compiler would refuse.
   */
  readonly withheld: readonly WithheldLocalDecision[];
  /**
   * The records whose only staleness is on an axis this process cannot observe.
   *
   * Kept, not withheld, and named so the report can say what the local render does not cover. A
   * record is only here when *every* one of its reasons is unobservable — a record that is stale for
   * an observable reason as well is withheld by the loop above.
   */
  readonly unobservableEvidence: readonly WithheldLocalDecision[];
}

/**
 * Project a conformance-audited, freshness-checked lock onto what this process may act on.
 *
 * The compiler's own functions do the work — `auditLockDecisionConformance` and
 * `localCompilationDependencies`, through the `dependency-resolver/local` subpath so no bundler is
 * pulled into a `vite.config.ts` graph. What this function adds is the *split*: it decides which
 * staleness this process may judge, and it moves the unobservable axes out of the withholding path
 * so they are reported instead of silently dropping decisions.
 *
 * It is worth being explicit about what it does **not** do: it does not weaken the compiler's rule
 * for the axes it keeps. A record withheld for `package-version-changed` is withheld exactly as
 * `localCompilationDependencies` withheld it, with the same reasons, so the harness and the compiler
 * agree wherever agreement is possible.
 *
 * `extensionCatalog` is passed through rather than omitted. Omitting it is not the same as an empty
 * one — the contract says an absent catalog means the verification step did not happen
 * (`extension-catalog-missing`) while an empty one means it happened and verified nothing — so the
 * caller supplies what the compiler supplies, and the harness does not invent a third state.
 */
export function projectLocalDecisions(input: {
  readonly lock: FgcLockDocument;
  readonly cellTarget: string | null;
  readonly resolvedVersions: Readonly<Record<string, string>>;
  readonly target: LockEnvironment["target"];
  readonly toolchain: LockEnvironment["toolchain"];
  /**
   * The verified extension catalog.
   *
   * Defaults to `core`'s own mapping table projected onto this shape — the same derivation
   * `extension-query-poc.test.ts` uses for the compiler, so the harness and the compiler audit
   * against the same catalog rather than one of them auditing against none.
   *
   * The default matters more than it looks. `auditLockDecisionConformance` reports an **error**
   * (`extension-catalog-missing`) when the catalog is absent, because "the verification step did not
   * happen" is not the same as "it happened and verified nothing" — both block acceptance. A harness
   * that omitted it would therefore see a blocking conformance error on *every* project with an
   * `extension` dependency, which is the false-refusal failure this module's docstring warns about,
   * arriving through the audit rather than through staleness.
   */
  readonly extensionCatalog?: ExtensionCatalog;
}): LocalDecisionProjection {
  const lock = input.lock;

  const conformance = auditLockDecisionConformance(lock, {
    extensionCatalog: input.extensionCatalog ?? DEFAULT_LOCAL_EXTENSION_CATALOG,
  });
  const conformanceErrors = conformance.filter(diagnostic => diagnostic.severity === "error");

  // The environment the compiler's projection needs, with the two unobservable axes left **absent**
  // rather than filled with a plausible-looking value. Absent is what makes the projection report
  // them as `*-unknown`, which is the truth — and the loop below is what stops that truth from
  // silently removing a decision.
  const environment: LockEnvironment = {
    resolvedVersions: input.resolvedVersions,
    target: input.target,
    toolchain: input.toolchain,
    probeFingerprints: {},
    extensionVersions: {},
    extensionIdentities: {},
  };

  const projected = localCompilationDependencies(lock, environment, { cellTarget: input.cellTarget });

  const decisions: DependencyDecision[] = [];
  const withheld: WithheldLocalDecision[] = [];
  const unobservableEvidence: WithheldLocalDecision[] = [];

  // The kept decisions come from the projection itself, not from a re-scan of the lock, and that is
  // a correction rather than a style choice. The first version iterated `input.lock.decisions` and
  // looked each record up in the withheld maps — which silently discarded *target selection*, since
  // the raw lock holds every Cell's records. Measured: with a `cellTarget: null` `extension` record
  // and a `probe`-scoped `inline` record, all three of `probe`, `other` and `null` came back with
  // both records, so the audit saw an `extension` decision for a Cell that had decided `inline` —
  // the exact defect the previous review round found, reintroduced by reading the wrong list.
  //
  // `localCompilationDependencies` already answers "which records does this Cell have", so this
  // consumes its answer instead of reproducing the selection.
  const keptPackages = new Set(projected.dependencies.map(decision => decision.packageName));
  for (const decision of projected.dependencies) {
    decisions.push(decision);
  }

  // Everything the projection withheld, classified by whether this process could have judged it.
  for (const entry of projected.withheld) {
    // The *selected* record, through the same precedence the projection used — not
    // `input.lock.decisions.find(...)`, which returns the first record for the package and so would
    // report (and, on the boundary path below, act on) a different Cell's decision. Measured: with a
    // target-independent `extension` record listed first and a `probe`-scoped `inline` record second,
    // `find` returned `extension` for a Cell whose own decision is `inline`.
    const selected = findLockDecision(lock, { packageName: entry.packageName, cellTarget: input.cellTarget });
    const strategy = selected?.strategy ?? entry.strategy;
    const reasons = entry.reason === "not-verified" ? entry.stalenessReasons : [];
    const classified: WithheldLocalDecision = {
      packageName: entry.packageName,
      strategy,
      stalenessReasons: reasons,
      reason: entry.reason === "not-verified" ? "not-verified" : "replace-cache",
    };

    // A record is reported as a local *boundary* only when every reason is one this process cannot
    // evaluate. Then the compiler has not refused it on evidence this loop can see, so the decision
    // is kept and the axes are named in the report; a Cell must not stop resolving a dependency
    // merely because its extension identity is only checkable on a page.
    //
    // One observable reason among them is different: the local loop genuinely can see the lock has
    // moved past this record, and it is withheld — the compiler's answer, unchanged.
    //
    // The first version of this check was written `reasons.every(isLocallyObservable) === false`,
    // which is true when *any* reason is unobservable — the opposite of the sentence above it, and
    // `tsc` could not catch it because both readings are boolean. The tests pin a record carrying one
    // observable and one unobservable reason so the two cannot be confused again.
    const allUnobservable = reasons.length > 0 && reasons.every(reason => !isLocallyObservable(reason));

    if (allUnobservable) {
      unobservableEvidence.push(classified);
      if (!keptPackages.has(entry.packageName) && selected !== null) {
        decisions.push(dependencyDecisionOf(selected));
      }
      continue;
    }
    withheld.push(classified);
  }

  return { decisions, conformanceErrors, withheld, unobservableEvidence };
}

/**
 * The toolchain the loop is running on, in the shape a lock record compares against.
 *
 * `vite-plus`'s own version, read through this package's resolution so it is the tool that is
 * actually driving the loop rather than whatever a caller's tree has. `null` when it cannot be read,
 * which the freshness rule reports as `toolchain-unknown` — the honest answer, and the same
 * asymmetry as the other axes: absent means "this process cannot say", not "do not check".
 *
 * The field name is the record's (`probedWith.vitePlus`), not a second vocabulary invented here.
 */
export function installedVitePlusToolchain(): LockEnvironment["toolchain"] {
  const require = createRequire(join(packageRoot, "package.json"));
  try {
    const manifest = require("vite-plus/package.json") as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim().length > 0
      ? { vitePlus: manifest.version }
      : null;
  } catch {
    return null;
  }
}

/**
 * The projection's findings, as report lines.
 *
 * Three blocks, and the split is what a reader needs: the **conformance errors**, which the compiler
 * refuses before compiling and which therefore refuse this server too; the **withheld** records,
 * which the local loop does not act on because this process could see what went stale; and the
 * **local boundary**, which is not a defect and is reported so that a green local render is not
 * mistaken for a validated lock.
 *
 * The boundary block names the axes rather than saying "some evidence could not be checked", which
 * is the shape of warning this repository keeps deleting: a reader who is told which two things
 * were not examined can decide whether they matter to the Cell in front of them.
 */
export function formatLocalDecisionProjection(projection: LocalDecisionProjection): string {
  const lines: string[] = [];

  for (const diagnostic of projection.conformanceErrors) {
    lines.push(
      `  ${diagnostic.subject}: [lock-conformance-${diagnostic.code}] ${diagnostic.detail} (fix owner: dependency-decision, blocks local development)`,
    );
  }

  for (const entry of projection.withheld) {
    const because =
      entry.reason === "replace-cache"
        ? "the record is a rejection this lock keeps as a decision cache, so it contributes no dependency"
        : `its evidence went stale for ${entry.stalenessReasons.join(", ")}, all of which this process can see for itself`;
    lines.push(
      `  ${entry.packageName}: [lock-decision-withheld] The compiler withholds this ${entry.strategy} decision because ${because}. The local loop does not act on it either, so the import resolves the way the artifact resolves it. (fix owner: dependency-decision)`,
    );
  }

  for (const entry of projection.unobservableEvidence) {
    lines.push(
      `  ${entry.packageName}: [lock-evidence-locally-unobservable] This ${entry.strategy} decision is kept, and its evidence on ${entry.stalenessReasons.join(", ")} cannot be checked here: an extension's version and identity come from a page, and a probe fingerprint's composer reaches a bundler. The compiler applies those checks and will refuse the decision if it has gone stale, so a green local render is not evidence about this record. (fix owner: real-runtime validation)`,
    );
  }

  return lines.join("\n");
}
