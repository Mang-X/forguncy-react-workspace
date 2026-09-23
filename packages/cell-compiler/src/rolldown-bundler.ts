/**
 * The Rolldown-backed implementation of {@link CellBundlerPort}.
 *
 * Decision source: GitHub Issue #7 — "Implement: Cell compiler MVP for a single
 * React entry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7), downstream of
 * #6's compiler boundary (https://github.com/Mang-X/forguncy-react-workspace/issues/6),
 * which names Vite+/Rolldown as the bundler half this package may use rather
 * than becoming a second resolver.
 *
 * Three groups of decisions are load-bearing, each the answer to one acceptance
 * criterion:
 *
 * 1. **A virtual entry shim, not a rewritten entry.** The authored module is
 *    never transformed to add an export. A generated shim imports it as a
 *    namespace and binds `default ?? App` — the `App`-binding entry shape #5
 *    records — so authored source reaches the artifact byte-for-byte and an
 *    entry may use either export style. The shim's `IMPORT_IS_UNDEFINED`
 *    warnings are also the only build-time signal that an entry exports
 *    *neither* name; when both fire, the build refuses rather than shipping a
 *    binding of `void 0`.
 * 2. **One IIFE, no chunk loading.** `format: "iife"` with `codeSplitting: false`
 *    produces exactly one script whose export lands on
 *    `CellBundlingRequest.componentBinding`, the name the generated wrapper
 *    references. `transform.jsx: "react-jsx"` routes authored JSX through
 *    `react/jsx-runtime`, which the host-bridge plan then intercepts, so no
 *    React implementation is bundled; `experimental.attachDebugInfo: "none"`
 *    keeps `//#region` comments — which embed module ids and would make output
 *    machine-dependent — out of the code.
 * 3. **Plans wire the resolver, and the report feeds #6's audits.** Bare
 *    specifiers are consulted against `planHostBridge` first (the page's own
 *    modules win) and `planExtensionExternals` second; an interception is loaded
 *    as a `\0`-virtual CommonJS module, the `moduleType` the platform's own
 *    generated modules are written in. Findings the artifact audits cannot see
 *    from the output report alone are translated into #6's diagnostic
 *    vocabulary and returned in `BundledCellModule.diagnostics`. One such
 *    finding is reported directly here: an installed package (resolved under
 *    `node_modules`) that the bundler inlined with no `DependencyDecision`
 *    covering it. #4 requires every non-workspace dependency to map to
 *    `host | inline | extension | replace`; `auditInlinedPackages` cannot see
 *    this case because a package with no decision is skipped there (workspace
 *    source legitimately has none, #14), so the bundler's own module ids —
 *    which distinguish workspace source from an installed package via
 *    {@link resolvesIntoNodeModules} — are what make the report possible.
 *
 * What is deliberately *not* here: the two plan vocabularies are not collapsed
 * into #6's. A mapping finding ("this table row cannot be honoured") and an
 * artifact finding ("this artifact breaks a guarantee") are two findings, not
 * two spellings of one — `core`'s vocabulary comments pin that split — so only
 * the subset whose statement is literally about the produced artifact is
 * translated, arm by arm, in {@link translateHostFinding} and
 * {@link translateExtensionFinding}.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { DependencyDecision, ExtensionExternalDiagnostic } from "@forguncy-react-workspace/core";
import { rolldown, type OutputAsset, type OutputChunk } from "rolldown";
// `scan` is Rolldown's analysis-only entry: it runs the resolve and transform
// stages and stops, with no `renderChunk` and no `generateBundle`. That is the
// whole point of using it here rather than `rolldown()` + `generate()` — see
// {@link resolveEntrySpecifiersWithRolldown}.
import { scan } from "rolldown/experimental";

import type { BundledCellModule, CellBundlerPort, CellBundlingRequest, CellResolveRequest } from "./artifact";
import { findDependencyDecision, packageNameOfSpecifier } from "./specifier";
import type { CellArtifactDiagnostic } from "./diagnostics";
import { createCellArtifactDiagnostic, dedupeCellArtifactDiagnostics } from "./diagnostics";
import type { ExtensionExternalsPlan } from "./extension-externals";
import { planExtensionExternals } from "./extension-externals";
import type { HostBridgeDiagnostic, HostBridgePlan } from "./host-bridge";
import { planHostBridge } from "./host-bridge";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateRolldownCellBundlerOptions {
  /**
   * The directory relative entries resolve against.
   *
   * One option only: everything else the build needs arrives per call in the
   * {@link CellBundlingRequest}, so a bundler instance is stateless between
   * builds and two of them cannot contaminate each other.
   */
  readonly dir: string;
}

/**
 * Creates the bundler half of `compileCell`.
 *
 * Returned by a factory rather than exported as an instance so `compileCell`
 * stays ignorant of Rolldown and the contract tests can keep injecting their
 * fixture port.
 */
export function createRolldownCellBundler(options: CreateRolldownCellBundlerOptions): CellBundlerPort {
  return {
    bundle: request => bundleWithRolldown(options.dir, request),
    resolveEntrySpecifiers: request => resolveEntrySpecifiersWithRolldown(options.dir, request),
  };
}

/**
 * The interception machinery, shared by the pre-bundle pass and the build.
 *
 * Extracted rather than duplicated because the two must agree exactly: the
 * preflight's whole claim is that the specifiers it audits are the specifiers the
 * build resolves. Two copies of this logic would eventually disagree — and the
 * disagreement would be invisible, because each copy is self-consistent.
 *
 * The plan caches and finding maps are per-call state, so one build cannot see
 * another's interceptions. `referencedSpecifiers` is the set the report needs; the
 * caller reads it after the pass that populated it.
 */
function createInterceptionResolver(decisions: readonly DependencyDecision[]): {
  readonly interceptionFor: (specifier: string) => { readonly id: string; readonly source: string } | undefined;
  readonly referencedSpecifiers: Set<string>;
  readonly referencedPackages: Set<string>;
  readonly fallThroughResolutions: Map<string, string>;
  readonly hostFindings: Map<string, HostBridgeDiagnostic>;
  readonly extensionFindings: Map<string, ExtensionExternalDiagnostic>;
  /** Consulted once with no references, so a plan-level finding cannot hide. */
  readonly primeDiagnostics: () => void;
} {
  // Every bare specifier resolved at all, intercepted or not. This is the set #14's
  // workspace audit traces its closure from, so it must include the ones the plans
  // *did* intercept — a workspace package the host bridge claimed is still a module
  // the cell imports, and omitting it would make the closure smaller than reality.
  const referencedSpecifiers = new Set<string>();
  // Every bare specifier that fell through interception, paired with the resolved
  // module id Rolldown would have used anyway. Provenance so the report can name
  // the real bare specifier (`sneaky-dep/subpath`) instead of the folded package
  // root (`sneaky-dep`), preserving exact-subpath decision precedence.
  const fallThroughResolutions = new Map<string, string>();
  const referencedPackages = new Set<string>();
  const hostFindings = new Map<string, HostBridgeDiagnostic>();
  const extensionFindings = new Map<string, ExtensionExternalDiagnostic>();
  const hostPlans = new Map<string, HostBridgePlan>();
  const extensionPlans = new Map<string, ExtensionExternalsPlan>();

  function consultHostPlan(referencedSpecifiers: readonly string[]): HostBridgePlan {
    const plan = planHostBridge({ decisions, referencedSpecifiers });
    for (const finding of plan.diagnostics) hostFindings.set(`${finding.code} ${finding.specifier}`, finding);
    return plan;
  }

  function consultExtensionPlan(referencedSpecifiers: readonly string[]): ExtensionExternalsPlan {
    const plan = planExtensionExternals({ decisions, referencedSpecifiers });
    for (const finding of plan.diagnostics) extensionFindings.set(`${finding.code} ${finding.subject}`, finding);
    return plan;
  }

  function interceptionFor(specifier: string): { readonly id: string; readonly source: string } | undefined {
    referencedPackages.add(packageNameOfSpecifier(specifier));
    referencedSpecifiers.add(specifier);

    let hostPlan = hostPlans.get(specifier);
    if (hostPlan === undefined) {
      hostPlan = consultHostPlan([specifier]);
      hostPlans.set(specifier, hostPlan);
    }
    // The page's own modules first: a host row and an extension row naming the same
    // specifier must resolve to the page object, never to a second copy behind an
    // extension global.
    if (hostPlan.activation === "stated") {
      const host = hostPlan.interceptions.find(candidate => candidate.moduleId === specifier);
      if (host !== undefined) return { id: `${HOST_VIRTUAL_PREFIX}${specifier}`, source: host.source };
    }

    let extensionPlan = extensionPlans.get(specifier);
    if (extensionPlan === undefined) {
      extensionPlan = consultExtensionPlan([specifier]);
      extensionPlans.set(specifier, extensionPlan);
    }
    // `wireable` rather than merely `stated`: a decision that contradicts the mapping
    // row must not be interposed behind a global the row does not agree on — the
    // import stays ordinary, the plan's finding travels through `diagnostics`, and
    // the artifact is refused in the same vocabulary an unwired extension import is.
    if (extensionPlan.activation === "stated" && extensionPlan.wireable) {
      const extension = extensionPlan.interceptions.find(candidate => candidate.moduleId === specifier);
      if (extension !== undefined) return { id: `${EXTENSION_VIRTUAL_PREFIX}${specifier}`, source: extension.source };
    }
    return undefined;
  }

  return {
    interceptionFor,
    referencedSpecifiers,
    referencedPackages,
    fallThroughResolutions,
    hostFindings,
    extensionFindings,
    primeDiagnostics: () => {
      // Consulted once with no references: decision-vs-mapping contradictions are
      // reported even when the entry imports nothing bare, so a broken decision
      // cannot hide behind an entry that never exercises it.
      consultHostPlan([]);
      consultExtensionPlan([]);
    },
  };
}

/**
 * The entry's bare specifiers, analysed through the same resolver the build uses
 * and **without generating any code**.
 *
 * This is a preflight, and both halves of that sentence are load-bearing.
 *
 * **No code generation.** `rolldown()` + `generate()` was the first implementation
 * and it was wrong: `generate()` renders chunks and bundles them, which is exactly
 * the work the preflight exists to avoid. A stage probe makes the difference
 * explicit — `scan` runs `resolve` and `transform`; `generate` additionally runs
 * `renderChunk` and `generateBundle`. So a `generate()`-based pass would mean the
 * cycle was still discovered *after* Rolldown had bundled once, and a failure from
 * that pass would return `bundler-failure` before the structured cycle diagnostic
 * could be emitted. `scan` is the analysis-only entry, and it is what makes the
 * refusal genuinely pre-bundling rather than merely pre-`bundle()`.
 *
 * **The same resolver.** Correctness depends on running the same interception
 * machinery as the build — see {@link createInterceptionResolver}. With the
 * decisions applied, a `host`-decided package resolves to the plan's virtual module,
 * so the local source is not traversed and an uninstalled host package does not fail
 * resolution. Without them the pass would walk real `node_modules`, report a
 * superset, and refuse compiles the build would have completed.
 *
 * `scan` returns nothing, so the specifiers are collected from the plugin hooks it
 * does run. `resolveId` sees every specifier the graph asks for, bare ones
 * included, which is the set #14's audit traces its closure from.
 */
async function resolveEntrySpecifiersWithRolldown(
  dir: string,
  request: CellResolveRequest,
): Promise<readonly string[]> {
  const resolvedEntry = path.resolve(dir, request.entry);
  if (!isRegularFile(resolvedEntry)) {
    throw new Error(`The entry "${request.entry}" does not exist at ${resolvedEntry}.`);
  }

  const resolver = createInterceptionResolver(request.dependencies);
  const virtualModules = new Map<string, string>();

  try {
    await scan({
      input: resolvedEntry,
      transform: { jsx: "react-jsx" },
      experimental: { attachDebugInfo: "none" },
      plugins: [
        {
          name: "cell-compiler-entry-specifier-scan",
          async resolveId(source, importer, options) {
            if (!isBareSpecifier(source)) return null;
            const interception = resolver.interceptionFor(source);
            if (interception === undefined) {
              // Record where Rolldown's own resolution lands, so a specifier that
              // simply is not installed is still reported as referenced rather than
              // dropped — the audit decides what that means, not this pass.
              const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
              if (resolved !== null && resolved.external !== true) {
                resolver.fallThroughResolutions.set(source, resolved.id);
              }
              return null;
            }
            virtualModules.set(interception.id, interception.source);
            return { id: interception.id, moduleType: "commonjs" };
          },
          load(id) {
            const source = virtualModules.get(id);
            return source === undefined ? null : source;
          },
        },
      ],
    });
  } catch (error) {
    // The same reduction the build path applies, and for the same reason: this
    // message becomes a `bundler-failure` diagnostic's `detail`, which lands in CI
    // logs that get diffed, so Rolldown's ANSI framing and source frames must not
    // travel with it.
    throw new Error(describeBuildFailure(error));
  }

  // Sorted so the audit's input is deterministic like every other report field.
  return [...resolver.referencedSpecifiers].sort();
}

// ---------------------------------------------------------------------------
// Virtual module ids
// ---------------------------------------------------------------------------

/**
 * The id the generated entry shim is registered under.
 *
 * Fixed and path-free: the shim exists per build, is never read from disk, and
 * warnings attributed to this exact id are how {@link assertEntryComponentBinding}
 * tells "this entry has no component" apart from "this entry's own imports are
 * mistyped" — the latter names the authored file, not the shim.
 */
const CELL_ENTRY_SHIM_ID = "cell-entry-shim.js";

const HOST_VIRTUAL_PREFIX = "\0cell-host:";
const EXTENSION_VIRTUAL_PREFIX = "\0cell-ext:";

/**
 * The shim source: default-export-first, else the named `App` #5's resolution
 * order falls back to.
 *
 * Both names are read deliberately. #5 established that entries use either
 * style, and a shim that picked one would silently compile the other into
 * `undefined`; reading both lets the missing-name warnings distinguish "neither
 * exists" from either normal case.
 */
function renderEntryShim(resolvedEntry: string): string {
  // Forward slashes on purpose: the specifier is embedded in a generated
  // import, and every rolldown resolver accepts `/` on Windows while `\` is
  // not universally read as a path separator inside a specifier.
  const entrySpecifier = resolvedEntry.split(path.sep).join("/");
  return [
    `import * as __fgcCellEntryModule from ${JSON.stringify(entrySpecifier)};`,
    `const __fgcCellEntryComponent = __fgcCellEntryModule.default ?? __fgcCellEntryModule.App;`,
    `export default __fgcCellEntryComponent;`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Specifier classification
// ---------------------------------------------------------------------------

/**
 * Whether a specifier names a package the mapping tables could know.
 *
 * Path-like specifiers are never consulted against the plans: a table row is a
 * package name, so the answer for `./App` is already decided by ordinary
 * resolution, and asking the plans would only collect findings about decisions
 * the specifier cannot have.
 */
function isBareSpecifier(source: string): boolean {
  if (source.startsWith("\0")) return false;
  if (source.startsWith(".") || source.startsWith("/")) return false;
  if (source.startsWith("data:") || source.startsWith("file:")) return false;
  return !path.isAbsolute(source);
}

// ---------------------------------------------------------------------------
// Failure descriptions
// ---------------------------------------------------------------------------

/**
 * Removes colour and cursor codes.
 *
 * Rolldown frames every message with ANSI styling; #6's diagnostics land in CI
 * logs that get diffed, and an escape sequence inside a message makes two
 * identical failures compare unequal. Stripped at the point of escape so no
 * downstream consumer has to know that bundlers paint their text.
 */
function stripAnsi(text: string): string {
  // SGR parameters and the cursor-letter they terminate; every sequence
  // observed from rolldown's frames is of this shape.
  // eslint-disable-next-line no-control-regex -- matching the escape byte is the entire point of this pattern.
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

interface ReportedBuildError {
  readonly message?: unknown;
  readonly id?: unknown;
  readonly loc?: Readonly<{ file?: unknown; line?: unknown; column?: unknown }> | null;
}

function hasReportedErrors(value: unknown): value is { readonly errors: readonly unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "errors" in value &&
    Array.isArray((value as { readonly errors?: unknown }).errors)
  );
}

/**
 * One reported error as one line: message first, location pulled out of the
 * structured `loc` rather than scraped from the painted frame.
 *
 * The frame itself — the source excerpt with its box-drawing characters — is
 * dropped on purpose. `compileCell` embeds this text in a diagnostic's `detail`;
 * the message and `file:line:column` are what a reader needs to act on, and the
 * excerpt would carry the entry's absolute path into a log artifact.
 */
function describeReportedError(value: unknown): string {
  if (typeof value !== "object" || value === null) return stripAnsi(String(value));
  const error = value as ReportedBuildError;
  const message =
    typeof error.message === "string"
      ? firstLine(stripAnsi(error.message))
      : stripAnsi(String(error.message ?? ""));
  const loc = error.loc ?? undefined;
  const file = typeof loc?.file === "string" ? loc.file : typeof error.id === "string" ? error.id : undefined;
  const line = typeof loc?.line === "number" ? loc.line : undefined;
  const column = typeof loc?.column === "number" ? loc.column : undefined;
  if (file === undefined) return message;
  if (line === undefined) return `${message} (${file})`;
  if (column === undefined) return `${message} (${file}:${line})`;
  return `${message} (${file}:${line}:${column})`;
}

/**
 * Turns an escaped bundler failure into one clean message.
 *
 * `compileCell`'s catch builds the `bundler-failure` diagnostic from whatever
 * the thrown error says, so this message *is* the structured diagnostic's
 * content: reported errors reduce to `message (file:line:column)` lines, and
 * anything unstructured passes through stripped rather than raw.
 */
function describeBuildFailure(error: unknown): string {
  if (hasReportedErrors(error) && error.errors.length > 0) {
    return error.errors.map(describeReportedError).join("\n");
  }
  if (error instanceof Error) return stripAnsi(error.message);
  return stripAnsi(String(error));
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const NODE_MODULES_MARKER = "node_modules/";

/**
 * The package a module id was flattened from, or `undefined` for anything that
 * did not come from an installed dependency.
 *
 * The *last* `node_modules/` segment wins, which is what makes pnpm's layout
 * (`…/.pnpm/react@19.2.7/node_modules/react/index.js`) and a hoisted layout
 * (`…/node_modules/react/index.js`) answer the same, and what keeps a virtual
 * interception id (`\0cell-host:react/jsx-runtime`) from answering at all.
 */
function packageNameOfModuleId(moduleId: string): string | undefined {
  const normalized = moduleId.replace(/\\/g, "/");
  const at = normalized.lastIndexOf(NODE_MODULES_MARKER);
  if (at < 0) return undefined;
  const segments = normalized.slice(at + NODE_MODULES_MARKER.length).split("/");
  const [first, second] = segments;
  if (first === undefined || first.length === 0) return undefined;
  if (first.startsWith("@")) {
    return second === undefined || second.length === 0 ? first : `${first}/${second}`;
  }
  return first;
}

function inlinedPackageNames(moduleIds: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const moduleId of moduleIds) {
    const packageName = packageNameOfModuleId(moduleId);
    if (packageName !== undefined) packages.add(packageName);
  }
  // Sorted so the report is byte-stable like the code is: #7's determinism
  // criterion covers the whole compile result, not only its largest field.
  return [...packages].sort();
}

/**
 * Whether a module id resolves, after following symlinks, to a real path under
 * `node_modules`.
 *
 * The line between "installed package" and "workspace source reached through a
 * `node_modules` symlink": #14's workspace packages are source and need no
 * `DependencyDecision`, while an installed package without one must be refused
 * (#4). Rolldown normally resolves symlinks to real paths — so workspace source
 * already answers `false` here — but the `realpathSync` call is deliberate
 * defence against a `preserveSymlinks` configuration that would leave the
 * module id under `node_modules` while the real file lives elsewhere.
 */
function resolvesIntoNodeModules(moduleId: string): boolean {
  try {
    return realpathSync(moduleId).split(path.sep).join("/").includes(NODE_MODULES_MARKER);
  } catch {
    // A module id that cannot be resolved to a real path is judged on its own
    // text: if it says `node_modules`, treat it as installed rather than
    // silently accepting a package the decision layer never saw.
    return moduleId.split(path.sep).join("/").includes(NODE_MODULES_MARKER);
  }
}

// ---------------------------------------------------------------------------
// Plan consultation and translation
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly code: string;
  readonly id: string;
  readonly message: string;
}

/**
 * The bridge's findings, translated into the artifact's vocabulary — or
 * dropped, with the reason written at the arm.
 *
 * The split core insists on is visible here: a bridge diagnostic is about a
 * mapping, and `duplicate-host-mapping` is about a produced artifact, so an arm
 * may only translate when the finding's statement is literally true of the
 * artifact. `host-module-duplicated` is the clearest case — "the decision
 * contradicts the table" is the mapping's finding, but "this artifact carries a
 * second copy of an identity-sensitive module" is the artifact's, and it is
 * only reportable when the copy is actually in `inlinedPackages`.
 */
function translateHostFinding(
  finding: HostBridgeDiagnostic,
  inlinedPackages: readonly string[],
  referencedPackages: ReadonlySet<string>,
): CellArtifactDiagnostic | undefined {
  // Whether the artifact actually carries the package the finding names —
  // imported (and so bound into the artifact) or inlined. This is the line
  // between an artifact-true statement and a decision-layer one for the arms
  // below: a conflict between decisions the entry never imports binds none of
  // this artifact's globals, so reporting it here would claim a guarantee
  // break the artifact does not commit.
  const packageInArtifact =
    referencedPackages.has(packageNameOfSpecifier(finding.specifier)) ||
    inlinedPackages.includes(finding.specifier);
  switch (finding.code) {
    case "host-module-duplicated":
      if (!inlinedPackages.includes(finding.specifier)) return undefined;
      return createCellArtifactDiagnostic("duplicate-host-mapping", finding.specifier, {
        detail: finding.detail,
      });
    case "host-mapping-conflict":
      // An incoherent table cannot vouch for any identity it binds — but only
      // for the identities this artifact binds: see `packageInArtifact` above
      // and the vocabulary rule in this function's header comment.
      if (!packageInArtifact) return undefined;
      return createCellArtifactDiagnostic("duplicate-host-mapping", finding.specifier, {
        detail: finding.detail,
      });
    case "host-mapping-missing":
    case "host-adapter-not-used":
      // Mapping-level findings whose artifact-visible consequences — a
      // surviving import, an inlined copy — #6's report-field audits already
      // report when they occur. Translating them here as well would state one
      // condition twice under two codes, which is the confusion core's
      // vocabulary comment warns about; an *unused* bad decision breaks no
      // guarantee of the artifact.
      return undefined;
    case "host-global-missing":
    case "host-global-incompatible":
    case "host-member-not-verified":
      // Runtime codes: they describe a page evaluated without the global, not
      // a built artifact, and no plan emits them for a build. The arms exist
      // so a future code cannot silently fall through an implicit `undefined`.
      return undefined;
  }
}

/**
 * The extension plan's findings, translated the same way and by the same rule.
 *
 * `extension-mapping-missing` and `extension-mapping-conflict` are both
 * artifact-level statements of "this `extension` decision has no usable
 * mapping" — the artifact would reference a library identity the table does
 * not verify — which is exactly #12's `missing-extension-mapping`.
 * `extension-not-declared` is the artifact reading a mapped extension module
 * that no decision declares: the generated module would read a global
 * `frontendLibraries` never names, so from the artifact's side the dependency
 * arrived without a usable decision.
 */
function translateExtensionFinding(finding: ExtensionExternalDiagnostic): CellArtifactDiagnostic | undefined {
  switch (finding.code) {
    case "extension-mapping-missing":
    case "extension-mapping-conflict":
    case "extension-library-unverified":
    case "extension-global-mismatch":
      return createCellArtifactDiagnostic("missing-extension-mapping", finding.subject, {
        detail: finding.detail,
      });
    case "extension-not-declared":
      return createCellArtifactDiagnostic("unresolved-dependency-decision", finding.subject, {
        detail: finding.detail,
      });
    case "extension-bundle-missing":
    case "extension-types-missing":
    case "extension-global-missing":
      // Runtime codes about a page that did not load the extension; no plan
      // emits them for a build. Kept explicit so the switch stays exhaustive.
      return undefined;
  }
}

function byCodeThenSubject(
  a: { readonly code: string; readonly subject: string },
  b: { readonly code: string; readonly subject: string },
): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.subject === b.subject ? 0 : a.subject < b.subject ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuses an entry that offers no component for the shim to bind.
 *
 * Detection runs on the shim's own warnings rather than on parsed exports: the
 * two `IMPORT_IS_UNDEFINED` warnings are rolldown telling us it evaluated both
 * `default` and `App` against the entry's namespace and found nothing — the
 * authoritative answer to "does a component exist", from the same resolution
 * the artifact will run at, with no second parser to disagree with it. One
 * warning is normal (entries legitimately use either export style); both mean
 * the build would succeed and hand the cell a binding of `void 0`, which #6's
 * error model asks to refuse structurally instead.
 */
function assertEntryComponentBinding(logs: readonly CapturedLog[], entry: string): void {
  const missing = new Set<string>();
  for (const log of logs) {
    if (log.code !== "IMPORT_IS_UNDEFINED" || log.id !== CELL_ENTRY_SHIM_ID) continue;
    const match = /Import `([^`]+)`/.exec(stripAnsi(log.message));
    if (match?.[1] !== undefined) missing.add(match[1]);
  }
  if (missing.has("default") && missing.has("App")) {
    throw new Error(
      `The entry "${entry}" exports neither a default export nor a named "App" export, so there is no component for the ReactCellType entry to bind.`,
    );
  }
}

async function bundleWithRolldown(dir: string, request: CellBundlingRequest): Promise<BundledCellModule> {
  const resolvedEntry = path.resolve(dir, request.entry);
  if (!isRegularFile(resolvedEntry)) {
    // Refused before the build rather than left to the bundler's
    // UNRESOLVED_ENTRY wording: the caller gets the entry as authored and the
    // path it was resolved to, with no frame to strip.
    throw new Error(`The entry "${request.entry}" does not exist at ${resolvedEntry}.`);
  }

  const decisions = request.dependencies;
  const shimSource = renderEntryShim(resolvedEntry);
  const logs: CapturedLog[] = [];
  const virtualModules = new Map<string, string>();
  // One resolver, shared with the pre-bundle specifier pass, so the two cannot
  // disagree about what the entry imports — see `createInterceptionResolver`.
  const resolver = createInterceptionResolver(request.dependencies);
  const fallThroughResolutions = resolver.fallThroughResolutions;
  const referencedPackages = resolver.referencedPackages;
  const hostFindings = resolver.hostFindings;
  const extensionFindings = resolver.extensionFindings;
  resolver.primeDiagnostics();

  let build: Awaited<ReturnType<typeof rolldown>> | undefined;
  let output: (OutputChunk | OutputAsset)[];
  try {
    build = await rolldown({
      input: CELL_ENTRY_SHIM_ID,
      onLog: (_level, log) => {
        // Collected, not forwarded: the build's warnings are read here (entry
        // shape); the report and the audits speak for everything else.
        logs.push({ code: log.code ?? "", id: log.id ?? "", message: log.message });
      },
      transform: { jsx: "react-jsx" },
      experimental: { attachDebugInfo: "none" },
      plugins: [
        {
          name: "cell-compiler-rolldown-bundler",
          async resolveId(source, importer, options) {
            if (source === CELL_ENTRY_SHIM_ID) return CELL_ENTRY_SHIM_ID;
            if (!isBareSpecifier(source)) return null;
            const interception = resolver.interceptionFor(source);
            if (interception === undefined) {
              // Not intercepted: record where Rolldown's own resolution lands
              // so the report can attribute the bundled module to this exact
              // bare specifier. `skipSelf: true` keeps this probe from re-entering
              // this hook; the subsequent `return null` lets the normal
              // resolution pass run once for the real build.
              const resolved = await this.resolve(source, importer, {
                ...options,
                skipSelf: true,
              });
              if (resolved !== null && resolved.external !== true) {
                fallThroughResolutions.set(source, resolved.id);
              }
              return null;
            }
            virtualModules.set(interception.id, interception.source);
            // `moduleType: "commonjs"` because both plans' generated sources
            // are `module.exports = …` — the same interop the extension unit
            // tests exercise through a real build, so an authored
            // `import { x }` and a namespace import each enumerate the
            // interposed module correctly.
            return { id: interception.id, moduleType: "commonjs" };
          },
          load(id) {
            if (id === CELL_ENTRY_SHIM_ID) return shimSource;
            const source = virtualModules.get(id);
            return source === undefined ? null : source;
          },
        },
      ],
    });
    ({ output } = await build.generate({
      format: "iife",
      name: request.componentBinding,
      codeSplitting: false,
    }));
  } catch (error) {
    throw new Error(describeBuildFailure(error));
  } finally {
    await build?.close();
  }

  assertEntryComponentBinding(logs, request.entry);

  const entryChunk = output.find(candidate => candidate.type === "chunk" && candidate.isEntry);
  if (entryChunk === undefined || entryChunk.type !== "chunk") {
    throw new Error(`The bundler produced no entry chunk for "${request.entry}".`);
  }

  const emittedAssets = output
    .filter(candidate => candidate !== entryChunk)
    .map(candidate => candidate.fileName)
    .sort();
  const externalImports = [...entryChunk.imports].sort();
  const moduleIds = Object.keys(entryChunk.modules);
  const inlinedPackages = inlinedPackageNames(moduleIds);
  // Bare specifiers whose resolved module actually landed in the entry chunk
  // and whose id sits under `node_modules` after symlink resolution. Sorted for
  // byte-stable reports; the decision loop and `auditInlinedPackages` both read
  // this list so exact-subpath precedence survives the fold into package names.
  // Keys are compared with both separators normalized: on Windows the chunk
  // reports backslash paths while `this.resolve` may hand back either form.
  const moduleIdSet = new Set(moduleIds.flatMap(id => [id, id.replace(/\\/g, "/")]));
  const inlinedSpecifiers = [...fallThroughResolutions.entries()]
    .filter(([, resolvedId]) => {
      const normalized = resolvedId.replace(/\\/g, "/");
      return moduleIdSet.has(normalized) && resolvesIntoNodeModules(resolvedId);
    })
    .map(([specifier]) => specifier)
    .sort();

  const translated: (CellArtifactDiagnostic | undefined)[] = [];
  for (const finding of [...hostFindings.values()].sort((a, b) =>
    byCodeThenSubject({ code: a.code, subject: a.specifier }, { code: b.code, subject: b.specifier }),
  )) {
    translated.push(translateHostFinding(finding, inlinedPackages, referencedPackages));
  }
  for (const finding of [...extensionFindings.values()].sort(byCodeThenSubject)) {
    translated.push(translateExtensionFinding(finding));
  }
  // Every installed bare specifier the bundler inlined must have a decision
  // that covers *that specifier*. Looking up the folded package root would
  // lose exact-subpath precedence: `{ inline, "sneaky-dep/subpath" }` covers
  // `sneaky-dep/subpath` but not `sneaky-dep`, and vice versa. Workspace
  // source legitimately has no decision (#14); `inlinedSpecifiers` already
  // excludes it because its resolved id sits outside `node_modules`.
  for (const specifier of inlinedSpecifiers) {
    if (findDependencyDecision(decisions, specifier) !== undefined) continue;
    translated.push(
      createCellArtifactDiagnostic("unresolved-dependency-decision", specifier, {
        detail: `The bundle inlined "${specifier}" from an installed dependency, but no dependency decision covers it.`,
      }),
    );
  }
  const diagnostics = dedupeCellArtifactDiagnostics(
    translated.filter((diagnostic): diagnostic is CellArtifactDiagnostic => diagnostic !== undefined),
  );

  return {
    code: entryChunk.code,
    externalImports,
    inlinedPackages,
    inlinedSpecifiers,
    emittedAssets,
    // Sorted for a byte-stable report, like every other list here: #7's determinism
    // criterion covers the whole result, and #14's audit orders a closure from this
    // set, so an unordered report would not change the verdict while an unordered
    // *list* would still be a report that differs between runs.
    referencedSpecifiers: [...resolver.referencedSpecifiers].sort(),
    diagnostics,
  };
}
