/**
 * The local Vite+ development runtime's contract: what a local dev loop may do,
 * what it may claim, and how it stays wired to the same host decisions the
 * compile path uses.
 *
 * Decision source: GitHub Issue #22 — "Spec: local Vite+ development runtime for
 * React Cells"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which is
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 * - #27 "typed Forguncy runtime facade for application-owned capabilities"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/27
 *
 * #22's Problem section states the tension this module has to resolve: requiring
 * a full Forguncy sync/generate cycle for every UI change "would keep the
 * feedback loop much slower than a normal React project", and then, in the same
 * breath, "without pretending a simulator can fully replace real Forguncy
 * validation". A local harness is therefore useful exactly to the extent that it
 * is *honest about what it is not* — and the honesty has to be structural rather
 * than a paragraph, because the failure mode is silent: a cell that renders
 * locally and breaks on the page looks identical, during development, to a cell
 * that renders locally and works.
 *
 * So this module's subject is not the harness. It is the boundary and the wiring:
 *
 * 1. **Which half of #22's workflow may claim anything, and at what level.** The
 *    loop is recorded stage by stage, each stage carrying `core`'s own
 *    `DependencyCheckLevel` and a required statement of what it does *not*
 *    establish. Exactly the last stage is `real-runtime`. That is AGENTS.md's
 *    "a green local build is not runtime compatibility" turned into a data
 *    shape rather than a rule someone has to remember.
 * 2. **What the local runtime is not allowed to reproduce** (#22's
 *    Non-responsibilities), each entry naming either the #4 concern it protects
 *    or the contract that actually owns the behaviour locally replaced.
 * 3. **How the host surface is derived rather than duplicated.** #22 requires
 *    that "host dependency mapping is reusable between compiler and dev runtime
 *    instead of maintaining two unrelated maps", so this module holds a
 *    *projection* of #9's `HOST_BRIDGE_MAPPINGS`: one row per bridge row, none
 *    invented, none silently missing, and nothing that runs the generated bridge
 *    module — because that module's whole job is to bind a page global, and
 *    locally there is no page.
 * 4. **What a mock may and may not be.** The project-supplied surface is #27's
 *    `RuntimeFacadeHostBindings`, so there is one vocabulary for "what a cell can
 *    reach" rather than a second mock-only one; and a mock narrower than the host
 *    is refused as loudly as a mock wider than it.
 *
 * Scope note: this module decides what the local loop *is allowed to be and to
 * claim*, and audits a local configuration for the gaps. It does not implement
 * the harness or mount anything (#23), generate a Cell artifact (#6/#7), choose a
 * dependency strategy (#4/#16), or synchronise through MCP (#19/#20). Every
 * record below is either a citation of an upstream decision or an explicit
 * statement about this local process; the two are kept visually apart on purpose.
 */

import {
  CELL_PROPS_BASE_KEYS,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_MAPPINGS,
  hostBridgeInterceptedModuleIds,
  hostBridgeModuleIds,
  isApplicationOwned,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";
import type {
  ArchitectureDecisionSource,
  DependencyCheckLevel,
  DependencyDecision,
  DependencyStrategy,
  HostBridgeDeferredModule,
  HostBridgeMapping,
  OwnershipConcernId,
} from "@forguncy-react-workspace/core";

import { LOCAL_DEV_RUNTIME_DECISION, RUNTIME_FACADE_DECISION } from "./provenance";
import type { RuntimeFacadeHostBindings, RuntimeFacadeProvider } from "./contract";

// ---------------------------------------------------------------------------
// The loop, and which half of it may claim anything
// ---------------------------------------------------------------------------

export const LOCAL_DEV_LOOP_STAGE_IDS = [
  "edit-cell-source",
  "local-dev-server",
  "local-ui-feedback",
  "compile-artifact",
  "mcp-sync",
  "forguncy-page-validation",
] as const;

export type LocalDevLoopStageId = (typeof LOCAL_DEV_LOOP_STAGE_IDS)[number];

export interface LocalDevLoopStage {
  readonly id: LocalDevLoopStageId;
  /** The step, in #22's own workflow wording. */
  readonly step: string;
  /** The command that performs it, when this repository already has one. */
  readonly command?: string;
  /**
   * The level of evidence this stage produces.
   *
   * `core`'s `DependencyCheckLevel`, reused rather than re-spelled: #4 already
   * decided that a check is `local` or `real-runtime`, and a second vocabulary
   * for the same distinction is precisely how a green local build gets reported
   * as runtime compatibility (#4's own docstring says so).
   */
  readonly claimLevel: DependencyCheckLevel;
  /** What running this stage does establish. */
  readonly establishes: string;
  /**
   * What it does not, stated per stage.
   *
   * Required and non-empty for every stage, including the `local` ones. The
   * interesting omissions are not the real-runtime stage's; they are the local
   * ones' — a dev server that renders a cell says nothing about whether the
   * platform will accept the source, and a stage record that only lists what it
   * proves is the one that gets over-read.
   */
  readonly doesNotEstablish: string;
  /** Who owns the evidence this stage cannot produce, when it cannot. Required when `claimLevel` is `real-runtime`. */
  readonly evidenceOwner?: string;
}

/**
 * #22's developer workflow, as six stages and two levels.
 *
 * `edit-cell-source` and `local-ui-feedback` are separate stages rather than one
 * because the edit is where #22's "reuse the same authored source" requirement
 * bites: a stage list that fused them would leave no place to say that the source
 * being edited is the artifact's source and not a harness copy.
 */
export const LOCAL_DEV_LOOP_STAGES: readonly LocalDevLoopStage[] = [
  {
    id: "edit-cell-source",
    step: "edit React/TS source",
    claimLevel: "local",
    establishes: "That a change was made to the file the Cell artifact is generated from.",
    doesNotEstablish:
      "That the edited source is acceptable to the platform. #5 records the designer refusing `import` and `export` declarations outright, so the ordinary shape of an authored module is not the shape the designer will write.",
  },
  {
    id: "local-dev-server",
    step: "start the local dev server",
    command: "vp dev",
    claimLevel: "local",
    establishes: "That the Cell entry mounts as a normal React tree in a normal Vite process.",
    doesNotEstablish:
      "Anything about the host. There is no page, no ReactCellType runtime and no frontend-library loader in this process, so a served module graph says nothing about what the page will have.",
  },
  {
    id: "local-ui-feedback",
    step: "HMR / local UI feedback",
    claimLevel: "local",
    establishes:
      "That the Cell's own UI, local interaction state, forms and visualisation behave as the source says they should, against the versions the project installed.",
    doesNotEstablish:
      "That the same UI behaves that way on the page. The substituted host modules are the published packages at #5's recorded versions where a version was recorded at all, and a preset-conditional global may legitimately be absent on a real cell.",
  },
  {
    id: "compile-artifact",
    step: "compile the Cell artifact",
    command: "vp run -r build",
    claimLevel: "local",
    establishes:
      "#4's `local` checks for the artifact: bundling succeeds, no second copy of a host-owned identity is carried, and the artifact's own guarantees hold against the generated output.",
    doesNotEstablish:
      "That the artifact runs on the target. AGENTS.md requires these to be reported separately, and every strategy in #4 carries at least one `real-runtime` check that no local build can discharge.",
  },
  {
    id: "mcp-sync",
    step: "MCP sync",
    claimLevel: "local",
    establishes: "That the sync call was made and what it wrote, whichever surface #19/#20 settles on.",
    doesNotEstablish:
      "That the Forguncy project accepted it. The zero-project-errors check exists only inside a real project, which is why #20 carries `status:needs-validation` and why the clean-checkout gate is #25's rather than a local step.",
    evidenceOwner: "#19 / #20 (one-way MCP sync contract and implementation)",
  },
  {
    id: "forguncy-page-validation",
    step: "real Forguncy validation at integration checkpoints",
    claimLevel: "real-runtime",
    establishes:
      "The evidence this repository treats as compatibility: the cell renders in a real page, its declared libraries resolve, and its dependency strategy's `real-runtime` checks are exercised.",
    doesNotEstablish:
      "That a *different* cell on a different page behaves the same way — #5 records that preset globals are captured per render instant and that cell entry order is not layout order, so each page is its own observation.",
    evidenceOwner: "#20 / #25 (MCP sync and the clean-checkout end-to-end gate)",
  },
];

/**
 * Refuse a stage list that lets the local half of the loop close on a real claim.
 *
 * Four checks, and the third is the one worth having: a list that marked an early
 * stage `real-runtime` would be claiming that a local process produced page
 * evidence, which is the single reporting error this repository spends the most
 * words preventing.
 *
 * 1. every stage states something it establishes and something it does not;
 * 2. every `real-runtime` stage names the Issue that owns that evidence;
 * 3. exactly one stage is `real-runtime`, and it is the last — so the loop cannot
 *    terminate in a local claim and have that read as validation;
 * 4. the local dev server stage is present and is `local`.
 */
export function assertLocalDevLoopStagesAreAdmissible(
  stages: readonly LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES,
): void {
  if (stages.length === 0) {
    throw new LocalDevRuntimeContractError("loop-stage-not-admissible", "The local dev loop has no stages.");
  }

  for (const stage of stages) {
    if (stage.establishes.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" establishes nothing, so it is not a stage.`,
      );
    }
    if (stage.doesNotEstablish.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" states nothing it fails to establish. A stage record that only lists what it proves is the one that gets over-read.`,
      );
    }
    if (stage.claimLevel === "real-runtime" && stage.evidenceOwner === undefined) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" produces real-runtime evidence and names no owner for it, so nothing says where that evidence comes from.`,
      );
    }
  }

  const realRuntime = stages.filter(stage => stage.claimLevel === "real-runtime");
  if (realRuntime.length !== 1 || stages[stages.length - 1]?.claimLevel !== "real-runtime") {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      `Exactly one loop stage may produce real-runtime evidence and it must be the last; this list has ${realRuntime.length} (${realRuntime.map(stage => stage.id).join(", ") || "none"}).`,
    );
  }

  const devServer = stages.find(stage => stage.id === "local-dev-server");
  if (devServer === undefined || devServer.claimLevel !== "local") {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      "The local dev server stage is missing or is not marked `local`, so the loop's fastest stage is claiming more than a local process can.",
    );
  }
}

/** The one stage in the loop that can produce compatibility evidence. */
export function localDevRealRuntimeStage(stages: readonly LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES): LocalDevLoopStage {
  const stage = stages.find(candidate => candidate.claimLevel === "real-runtime");
  if (stage === undefined) {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      "The local dev loop records no real-runtime stage, so nothing in it produces compatibility evidence.",
    );
  }
  return stage;
}

// ---------------------------------------------------------------------------
// The emulator boundary
// ---------------------------------------------------------------------------

export const LOCAL_DEV_BOUNDARY_IDS = [
  "no-project-routing-semantics",
  "no-page-lifecycle-fidelity",
  "no-permission-semantics",
  "no-extension-loader-fidelity",
  "no-designer-write-time-validation",
  "no-cross-cell-isolation-model",
] as const;

export type LocalDevBoundaryId = (typeof LOCAL_DEV_BOUNDARY_IDS)[number];

/**
 * What the harness does instead of the behaviour it must not reproduce.
 *
 * Enumerated so that "it is out of scope" and "the project has to supply
 * something" are visibly different answers. #22's Non-responsibilities forbid the
 * harness from claiming five behaviours, but it still has to *do* something about
 * each, and `out-of-scope` is a much stronger statement than an omission.
 */
export const LOCAL_DEV_BOUNDARY_BEHAVIOURS = [
  "out-of-scope",
  "mock-value-only",
  "substitute-or-diagnostic",
  "not-validated-locally",
  "single-cell-only",
] as const;

export type LocalDevBoundaryBehaviour = (typeof LOCAL_DEV_BOUNDARY_BEHAVIOURS)[number];

export interface LocalDevBoundary {
  readonly id: LocalDevBoundaryId;
  /** #22's Non-responsibility, in its own wording. */
  readonly statement: string;
  /**
   * The #4 concerns this boundary protects.
   *
   * Every entry must be Forguncy-owned: a boundary whose job is to stop the
   * harness from impersonating the platform cannot be about a capability the cell
   * owns. May be empty — but only when {@link ownedBy} names the contract that
   * actually owns the behaviour, because "there is no #4 concern for this" and
   * "nobody owns this" are very different statements.
   */
  readonly protects: readonly OwnershipConcernId[];
  /** The contract that owns the real behaviour, when no #4 concern covers it. */
  readonly ownedBy?: string;
  readonly why: string;
  readonly localBehaviour: LocalDevBoundaryBehaviour;
}

/**
 * #22's Non-responsibilities, one entry per bullet.
 *
 * Two of the six are the ones a reviewer is least likely to predict, and they are
 * recorded at length for that reason:
 *
 * - `no-designer-write-time-validation` runs the *opposite* way to the intuitive
 *   expectation. It is not that the local loop is weaker than the designer; it is
 *   that the two accept different source shapes, so a local pass is not weak
 *   evidence about designer acceptance, it is *no* evidence.
 * - `no-cross-cell-isolation-model` is a modelling hazard rather than a missing
 *   feature: mounting two cells into one local React tree would make React Context
 *   cross them, which is the exact opposite of what #5 measured on a page.
 */
export const LOCAL_DEV_BOUNDARIES: readonly LocalDevBoundary[] = [
  {
    id: "no-project-routing-semantics",
    statement: "Project routing/navigation semantics.",
    protects: ["application-navigation"],
    why: "#4 assigns navigation to Forguncy because the host owns the history and the page graph, and #5 recorded no navigation bridge a cell could delegate to. A local Vite process has neither a history the host can observe nor a page graph, so any navigation a harness offered would be a second, differently-behaving implementation of an application-owned concern — which is #4's definition of a platform conflict, not a convenience.",
    localBehaviour: "out-of-scope",
  },
  {
    id: "no-page-lifecycle-fidelity",
    statement: "Real page lifecycle details not proven by #5.",
    protects: ["page-lifecycle"],
    why: "#5 leaves the property-change re-render question open (`property-change-re-render`, owned by #6) and records that teardown renders `null` into the cell's own root from the runtime source rather than by observation. A harness that mounted and disposed a cell on a lifecycle of its own invention would be encoding a guess as a contract — the same refusal #27 makes when it declines to build a lifecycle API at all.",
    localBehaviour: "out-of-scope",
  },
  {
    id: "no-permission-semantics",
    statement: "Permissions/auth behavior.",
    protects: ["permissions"],
    why: "#4 puts the permission snapshot on the host's side precisely because the host resolved it before the page rendered. Locally the snapshot is a value the project typed in, so a cell can be made to pass or fail a permission check by editing the mock: the local process never authorises anything, and a cell that branches on a permission is exercising the branch, not the permission.",
    localBehaviour: "mock-value-only",
  },
  {
    id: "no-extension-loader-fidelity",
    statement: "MCP/extension loader behavior.",
    protects: [],
    ownedBy: "#12 (extension externals) / #19 / #20 (MCP sync)",
    why: "#5 records that page-level frontend-library load order is not guaranteed (`loadOrderGuaranteed: false`) and that a cell can render while another cell's declared libraries are still in flight (`crossCellReadinessGuaranteed: false`). Neither has an npm analogue: locally a dependency is simply present when the module graph says so, which is a *stronger* readiness guarantee than the page gives. A harness that resolved an extension-backed package to npm would therefore be presenting a guarantee the page does not make, and the failure it hides only appears once two cells race.",
    localBehaviour: "substitute-or-diagnostic",
  },
  {
    id: "no-designer-write-time-validation",
    statement: "Exact designer/CodeEditor behavior.",
    protects: [],
    ownedBy: "#5 (the recorded validation mechanism); #6 / #7 own its projection",
    why: "This is the sharpest local-versus-real gap in the whole loop, and it runs the opposite way to what a developer expects. #5 records the platform's write-time validator refusing `import` and `export` declarations outright — `ReactCellType does not support import statements` — and `CELL_SOURCE_VALIDATION_MECHANISM` records that those checks walk syntax nodes, with comments and tokens skipped. A local Vite project is made of `import` declarations. Source that compiles and renders perfectly under `vp dev` can therefore be refused by the designer before it is ever written, so a local pass is not weak evidence about designer acceptance — it is no evidence, and the harness must not present it as any.",
    localBehaviour: "not-validated-locally",
  },
  {
    id: "no-cross-cell-isolation-model",
    statement: "True cross-Cell deployment isolation unless explicitly simulated for a targeted test.",
    protects: ["cross-cell-communication", "application-state"],
    why: "#5 verified that all cells on a page share one `globalThis` and that component state, hooks and React Context stay local per cell *because* each cell is its own React root (`context-does-not-cross-cells`). A local process mounts whatever roots the harness creates, so mounting two cells into one tree would make Context cross them — a local model of the exact opposite of the page. The default is therefore one Cell per root; simulating two cells is a targeted test that has to say so.",
    localBehaviour: "single-cell-only",
  },
];

/**
 * Refuse a boundary that is not actually a boundary.
 *
 * Two failure shapes, both easy to write:
 *
 * - a boundary that protects a concern the *cell* owns — "the harness does not
 *   manage animation" reads like a boundary but is only a scope note, and
 *   inverting it is exactly what #27's equivalent guard exists to catch;
 * - a boundary that protects nothing and names nobody, which is an omission
 *   dressed as a decision.
 */
export function assertLocalDevBoundariesAreAdmissible(
  boundaries: readonly LocalDevBoundary[] = LOCAL_DEV_BOUNDARIES,
): void {
  for (const boundary of boundaries) {
    if (boundary.why.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" gives no reason, so a reader cannot tell which decision it implements.`,
      );
    }

    if (boundary.protects.length === 0 && boundary.ownedBy === undefined) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" protects no #4 concern and names no owner, so it records an omission rather than a boundary.`,
      );
    }

    if (!LOCAL_DEV_BOUNDARY_BEHAVIOURS.includes(boundary.localBehaviour)) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" declares behaviour "${boundary.localBehaviour}", which is not one of the recorded handlings.`,
      );
    }

    for (const concern of boundary.protects) {
      if (!isApplicationOwned(concern)) {
        throw new LocalDevRuntimeContractError(
          "boundary-not-admissible",
          `Local dev boundary "${boundary.id}" protects "${concern}", which #4 assigns to the cell. A harness declining to duplicate a capability the cell owns is a scope note, not a boundary.`,
        );
      }
    }
  }
}

/** The boundary that keeps a harness from impersonating a concern, when one exists. */
export function findLocalDevBoundaryForConcern(concern: OwnershipConcernId): LocalDevBoundary | undefined {
  return LOCAL_DEV_BOUNDARIES.find(boundary => boundary.protects.includes(concern));
}

/** Every #4 concern at least one local dev boundary refuses to model. */
export function localDevProtectedConcerns(): readonly OwnershipConcernId[] {
  return [...new Set(LOCAL_DEV_BOUNDARIES.flatMap(boundary => boundary.protects))];
}

// ---------------------------------------------------------------------------
// Host module resolution in local mode
// ---------------------------------------------------------------------------

/**
 * The table the local resolutions derive from.
 *
 * Recorded as the *name* rather than as a copy, so a reader can check the claim
 * "one table, two projections" by following one identifier.
 */
export const LOCAL_DEV_HOST_MAPPING_SOURCE = "HOST_BRIDGE_MAPPINGS";

/**
 * How a locally-resolved module id is supplied.
 *
 * `unsupported` exists so that "we have no local stand-in" is a value rather than
 * an absence. A module id that simply has no entry would be indistinguishable
 * from one nobody thought about, and #9's own deferred-module list exists for the
 * same reason.
 */
export const LOCAL_DEV_LOCAL_RESOLUTION_KINDS = ["npm-package", "project-shim", "unsupported"] as const;

export type LocalDevLocalResolutionKind = (typeof LOCAL_DEV_LOCAL_RESOLUTION_KINDS)[number];

/**
 * The recorded version fields the local process may be checked against.
 *
 * Both are `#5`'s, read off the pinned target rather than stored again:
 * `localDevRecordedVersion` is the only way to obtain a value here, which means a
 * version cannot be typed into a resolution row and drift away from the contract
 * it is supposed to be equal to.
 */
export const LOCAL_DEV_VERSION_FIELDS = ["hostReactVersion", "hostReactDomVersion"] as const;

export type LocalDevVersionField = (typeof LOCAL_DEV_VERSION_FIELDS)[number];

/** The value #5 recorded for a version field. The only source of an expected version. */
export function localDevRecordedVersion(field: LocalDevVersionField): string {
  return RUNTIME_CONTRACT_TARGET[field];
}

export interface LocalDevModuleResolution {
  /**
   * The `#9` mapping row this projects.
   *
   * Must be a row `HOST_BRIDGE_MAPPINGS` actually contains. The row's module ids
   * are taken from the table (see `localDevModuleIdsOf`) rather than repeated
   * here, so a row that grows a subpath grows in this projection too, and the
   * coverage guard only has to police the direction a derivation cannot: a
   * resolution naming a row that does not exist.
   */
  readonly specifier: string;
  readonly resolution: LocalDevLocalResolutionKind;
  /**
   * The package or shim path the ids resolve to locally. Required unless
   * `unsupported`.
   *
   * A `project-shim` names the module or file the project supplies instead of a
   * package, which is why this is one field rather than a package name beside a
   * path: the harness resolves both the same way, and `localDevAlignmentChecks`
   * simply finds no installed version to compare for a shim.
   */
  readonly localPackage?: string;
  /**
   * The recorded field the local package's version is checked against, when one
   * exists.
   *
   * Absent is a statement rather than an oversight, which is why
   * {@link alignmentUnchecked} becomes required when it is: for `react-dom` the
   * bridge's lock has no field (see the row's note), and for `antd` no version was
   * ever recorded.
   */
  readonly checkedVersionField?: LocalDevVersionField;
  /** Required whenever no field can check this row's alignment. */
  readonly alignmentUnchecked?: string;
  readonly note: string;
}

/**
 * The local resolution for each of #9's host mappings.
 *
 * One row per bridge row. The `react-dom` row is the one worth reading in full:
 * it projects a row whose subpath #9 narrows to a `verified-member-view`, and
 * locally that narrowing does not happen — which makes the local loop *more
 * permissive* than the page in one specific place. Recording it is the point;
 * a harness that quietly reproduced the narrowing would be testing generated code
 * that #23 is not responsible for, and a harness that ignored the difference would
 * let a cell call `hydrateRoot` successfully forever.
 */
export const LOCAL_DEV_MODULE_RESOLUTIONS: readonly LocalDevModuleResolution[] = [
  {
    specifier: "react",
    resolution: "npm-package",
    localPackage: "react",
    checkedVersionField: "hostReactVersion",
    note: "The substitution that makes the local loop meaningful at all: cell UI running against React 19.2.7 locally is exercising the same hooks and the same JSX semantics the page will run. It is not evidence that the page's React object is the one the cell gets — #5 owns that, and only a page can show it.",
  },
  {
    specifier: "react-dom",
    resolution: "npm-package",
    localPackage: "react-dom",
    checkedVersionField: "hostReactDomVersion",
    note: "`react-dom/client` rides on this row exactly as it does in #9's table, and the version field is deliberately not the one #9's lock uses. The two questions differ: #9 asks whether the *page's* object is the one the artifact was compiled against, and `ForguncyTargetIdentity` carries only `hostReactVersion` for that; this row asks whether the package installed locally is the version the target ships, and #5's target record answers that for ReactDOM too. So the local check is one field richer than the lock's, and the reason is that no lock is involved. The narrowing #9 generates for the subpath has no local analogue and is deliberately not reproduced: locally `hydrateRoot` is simply present, while on the page it is refused with `host-member-not-verified` until #5 observes it. A local render is therefore *more permissive* here than the page, and must never be read as a stronger result.",
  },
  {
    specifier: "antd",
    resolution: "npm-package",
    localPackage: "antd",
    alignmentUnchecked:
      "#5 established that the `antd` global exists (`typeof antd === \"object\"`) and recorded no version for it, so there is no field to compare against. A local render therefore establishes that the cell's own use of the antd API is well formed, and nothing about the version, the theme, or the component set the page ships. Adding a version check would mean inventing the number to compare with.",
    note: "This is also the one bridge row whose global #5 measured as *conditionally* present — a cell that did not declare the AntDesign preset saw `antd === undefined` on the same page as a cell that did. Locally the package is always there, so the absent-antd branch of a cell is the branch the local loop will never take.",
  },
  {
    specifier: "react/jsx-runtime",
    resolution: "npm-package",
    localPackage: "react",
    alignmentUnchecked:
      "The JSX runtime ships inside the React package and has no version field of its own; it is the same substitution as the `react` row, and the alignment check for that row covers it.",
    note: "The published JSX runtime, never #9's generated adapter. The adapter exists because no page object has `react/jsx-runtime`'s shape; locally the published module does, and using it is what makes `vp dev` exercise the *cell's* keyed lists against a real runtime — which is the only way a keyed-list mistake in cell source surfaces during development. It follows, and this is the sentence to keep, that `vp dev` says nothing about the adapter: the adapter's evidence is its own regression suite plus a real page, and a green local render must not be read as adapter validation.",
  },
];

/**
 * The model the rows above are an instance of.
 *
 * The two `false`/`true` members are the ones a reviewer has to be able to check,
 * which is why they are data rather than a comment. `runsGeneratedBridgeModules`
 * is the load-bearing one: the generated module for a mapped import exists to bind
 * a page global, or to run the adapter that stands in for one, and locally there
 * is no page — so wiring the compiler's interpositions into Vite would not be a
 * resolution at all, it would be a failure deferred to the first import. The same
 * reasoning is why the mapping is reused as a *table* and not as generated source.
 */
export const LOCAL_DEV_HOST_RESOLUTION_MODEL = {
  mapsFrom: LOCAL_DEV_HOST_MAPPING_SOURCE,
  reusesTheHostBridgeMappingTable: true,
  secondMappingTable: false,
  runsGeneratedBridgeModules: false,
  resolvesToPublishedPackages: true,
  note: "The compile path and the dev path ask the same question of the same row — which module id is host-provided — and then answer it differently on purpose: the artifact binds the page's object, and the dev harness resolves the published package. Keeping one table is what stops a row being added for one path and forgotten in the other.",
} as const;

/**
 * Whether a member of a caller-supplied list can be read, and why not when it cannot.
 *
 * The lists a caller supplies reach this module through a cast from a JSON config,
 * so a member can be anything at all.
 *
 * These are **plain booleans, not `value is HostBridgeMapping` predicates**, and that
 * distinction is the whole point. A `value is X` guard is a promise about the complete
 * declared type, and checking one field does not make one: an earlier version of these
 * helpers tested `specifier` and then returned `value is LocalDevModuleResolution`, so
 * the compiler stopped objecting about fields nothing had looked at, and
 * `{ specifier: "react", moduleIds: 42 }` sailed past a guard whose name said the
 * whole row was sound. A boolean claims nothing beyond itself, so a reader that has
 * been through one still has to say which fields it uses — which is the honest
 * position, because these checks cover what the readers touch and not the whole type.
 *
 * Each check therefore covers exactly the fields its readers use, **and every reason a
 * member can fail one is also a reason the loud path reports it** — the guard for
 * resolution rows, `localDevModuleIdsOf` for bridge rows. Otherwise a member the
 * derivations skip would go missing with nothing saying so, which is worse than the
 * crash it replaced.
 */
function localDevBridgeRowProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "it is not a row at all";
  const row = value as { specifier?: unknown; moduleIds?: unknown };

  if (!isNonEmptyString(row.specifier)) return "it names no specifier";

  // `hostBridgeModuleIds` spreads this, so a non-list is a throw and a list holding
  // something that is not a module id is a worklist entry no module can match.
  if (row.moduleIds === undefined) return undefined;
  if (!Array.isArray(row.moduleIds)) return "its moduleIds is not a list";
  if (!row.moduleIds.every(entry => isNonEmptyString(entry))) {
    return "its moduleIds carries something that is not a module id";
  }
  return undefined;
}

/** The tolerant half of the check above, for the derivations that have to survive a broken table. */
function canReadBridgeRow(value: unknown): boolean {
  return localDevBridgeRowProblem(value) === undefined;
}

function localDevResolutionRowProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "it is not a row at all";
  const row = value as Record<string, unknown>;

  if (!isNonEmptyString(row.specifier)) return "it names no specifier";

  // The kind decides which set the row lands in, so an unrecognised one cannot be
  // treated as resolvable: every value except `unsupported` used to be, which is how a
  // row that resolved by nothing at all came back with a clean audit.
  const kind = row.resolution;
  if (!isNonEmptyString(kind) || !(LOCAL_DEV_LOCAL_RESOLUTION_KINDS as readonly string[]).includes(kind)) {
    return `its resolution "${String(kind)}" is not one of ${LOCAL_DEV_LOCAL_RESOLUTION_KINDS.join(", ")}`;
  }

  if (row.localPackage !== undefined && !isNonEmptyString(row.localPackage)) {
    return "its localPackage is not a package name";
  }

  // `localDevRecordedVersion` indexes the pinned target with this, so an unrecognised
  // field yields `undefined` where the type promises a version — a comparison that
  // silently never matches.
  if (row.checkedVersionField !== undefined) {
    if (
      !isNonEmptyString(row.checkedVersionField) ||
      !(LOCAL_DEV_VERSION_FIELDS as readonly string[]).includes(row.checkedVersionField)
    ) {
      return `its checkedVersionField "${String(row.checkedVersionField)}" is not one of ${LOCAL_DEV_VERSION_FIELDS.join(", ")}`;
    }
  }

  if (row.alignmentUnchecked !== undefined && !isNonEmptyString(row.alignmentUnchecked)) {
    return "its alignmentUnchecked is not an explanation";
  }

  return undefined;
}

/** The tolerant half of the check above. */
function canReadResolutionRow(value: unknown): boolean {
  return localDevResolutionRowProblem(value) === undefined;
}

/** What to call a resolution row in a finding, or `undefined` when its name is not usable either. */
function localDevResolutionSubject(resolution: unknown): string | undefined {
  if (typeof resolution === "object" && resolution !== null) {
    const specifier = (resolution as { specifier?: unknown }).specifier;
    if (isNonEmptyString(specifier)) return `"${specifier}"`;
  }
  return undefined;
}

/**
 * The package or shim path a row resolves to, or `undefined` when it names none.
 *
 * One accessor for the field that turns a declared kind into an actual stand-in, because
 * `localPackage` is `unknown` in a table that arrived by cast: a reader that reached for it
 * directly would be assuming a shape nothing had checked, which is what
 * {@link localDevResolutionRowProblem} exists to prevent.
 */
function localDevResolutionTarget(resolution: LocalDevModuleResolution): string | undefined {
  const target = resolution.localPackage;
  return isNonEmptyString(target) ? target : undefined;
}

/**
 * Whether a row makes the claim {@link localDevResolvableModuleIds} is a list of.
 *
 * Two conditions, and the second is the one this exists for. A row has to declare a
 * stand-in — `unsupported` is the kind whose whole content is that it declares none — *and*
 * name the thing it resolves to. Being readable is not the same as resolving: the guard
 * refuses a row that declares a stand-in and names none ("there is nothing to resolve"), so
 * a worklist built out of readability alone listed a module id beside a finding that said
 * nothing resolves it. The claim and the list are now the same statement.
 */
function standsInForModuleId(resolution: LocalDevModuleResolution): boolean {
  return resolution.resolution !== "unsupported" && localDevResolutionTarget(resolution) !== undefined;
}

/**
 * Why a row that declares a stand-in cannot name one, or `undefined` when it names it.
 *
 * The guard's half of {@link standsInForModuleId}, spelled with the same accessor so the
 * refusal and the worklist cannot answer one question two ways.
 */
function localDevMissingTargetProblem(resolution: LocalDevModuleResolution): string | undefined {
  return localDevResolutionTarget(resolution) === undefined
    ? `is "${resolution.resolution}" and names no package, so there is nothing to resolve`
    : undefined;
}

/**
 * Whether the audit can read a decision's strategy and the package it names.
 *
 * Those are the two members the audit uses: `strategy` to find the `extension` rows,
 * and `packageName` as the key that matches a decision to its choice — and as the
 * subject of any finding about it. A member failing this is left out of the coverage
 * question in both directions rather than read anyway, because a decision that names no
 * package would otherwise reach the report as a finding about `undefined`, and one whose
 * strategy is not a strategy cannot be classified at all.
 *
 * What is deliberately *not* duplicated here is the record's own shape: `core` owns that
 * (`validateDependencyDecisionShape`), and a local finding about it would report one
 * mistake twice. This module validates the vocabulary it invents — the extension choices
 * are #22's own, so `local-dev-extension-choice-malformed` is theirs — and for a record
 * another module owns it checks only that its own two reads are safe. That is the same
 * boundary the audit declares for containers, applied to a member: the reader says what
 * it used and stops, rather than re-deriving a verdict it is not the owner of.
 */
function canReadDecision(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as { strategy?: unknown; packageName?: unknown };
  return (
    isNonEmptyString(decision.strategy) &&
    (DEPENDENCY_STRATEGIES as readonly string[]).includes(decision.strategy) &&
    isNonEmptyString(decision.packageName)
  );
}

/**
 * The bridge row a local resolution projects, or `undefined`.
 *
 * The non-throwing half of {@link localDevModuleIdsOf}, and the split is the
 * point rather than an accident: a **guard** has to fail loudly on a row that does
 * not exist, while a **report** has to survive the same input long enough to
 * describe it. Anything derived after the coverage guard therefore goes through
 * here, or an orphan resolution row turns into an exception and takes the rest of
 * the audit with it.
 *
 * `undefined` rather than a default, for the reason
 * {@link findLocalDevModuleIdResolution} returns one: a specifier the table does
 * not carry has no bridge row, and inventing one would make an orphan look
 * covered.
 *
 * A row that cannot be read is also not returned — {@link canReadBridgeRow} says
 * which rows those are — so `undefined` covers two situations, "no row names this
 * specifier" and "a row names it and is not readable", and this return type does not
 * distinguish them. {@link localDevModuleIdsOf} is where the difference is said in
 * words, because a reader sent to look for a missing row that is right there is no
 * closer to a fix than one sent to repair a row it was told is missing.
 */
export function findLocalDevBridgeRow(
  specifier: string,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): HostBridgeMapping | undefined {
  return mappings.find(candidate => canReadBridgeRow(candidate) && candidate.specifier === specifier);
}

/**
 * Why no usable bridge row was found for a specifier, in words.
 *
 * The two situations above call for different sentences, so the guard asks for one of
 * them by name instead of reporting both as absence. Which rows are unreadable is read
 * off {@link localDevBridgeRowProblem}, the same check the derivations filter with, so
 * a row cannot be refused by one and accepted by the other.
 *
 * A row that is neither absent nor unreadable cannot reach here, because
 * {@link findLocalDevBridgeRow} would have returned it. Rows that share a specifier are
 * read in table order and the first readable one decides, which is the same row the
 * lookup would have returned.
 */
function localDevNoUsableBridgeRow(specifier: string, mappings: readonly HostBridgeMapping[]): string {
  const named = (mappings as readonly unknown[]).filter(
    candidate =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { specifier?: unknown }).specifier === specifier,
  );
  const problem = named.map(localDevBridgeRowProblem).find(reason => reason !== undefined);
  if (problem === undefined) {
    return `The local resolution rows name "${specifier}", which is not a row of the host bridge mapping table.`;
  }
  return `The local resolution rows name "${specifier}", and the host bridge row that carries it cannot be read: ${problem}. Every module id that row intercepts is unaccounted for while it stays that way, so its module ids cannot be taken from it.`;
}

/**
 * Every module id a resolution row covers, read from the bridge table.
 *
 * The loud reader: `undefined` from {@link findLocalDevBridgeRow} stops the run, and
 * the message says which of the two reasons it stopped for. A row whose `moduleIds` is
 * not a list is refused here by name rather than by `hostBridgeModuleIds` spreading a
 * number, which is what the refusal has to say to be about the table instead of about
 * the run.
 */
export function localDevModuleIdsOf(
  specifier: string,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  const mapping = findLocalDevBridgeRow(specifier, mappings);
  if (mapping === undefined) {
    throw new LocalDevRuntimeContractError("mapping-coverage", localDevNoUsableBridgeRow(specifier, mappings));
  }
  return hostBridgeModuleIds(mapping);
}

/**
 * The module ids of a row, or none when the row does not exist.
 *
 * The tolerant form, used by every derivation the audit performs *after* the
 * coverage guard. An orphan row contributes no module ids rather than a fabricated
 * one: the guard is what reports that the row exists, and these lists are the
 * harness's worklist, which cannot contain a module id nothing resolves.
 *
 * A row that cannot be read contributes nothing either, and for the same reason
 * rather than by accident. The guard refuses a table containing one — that refusal is
 * what `local-dev-mapping-coverage` carries — and the audit continues past it with the
 * finding recorded, so a derivation reached with a broken row in hand is one whose
 * caller has already been told. Throwing here would replace that finding with a stack
 * trace in the middle of a list, which is the failure this pair was split to prevent.
 */
function moduleIdsOfExistingRow(
  specifier: string,
  mappings: readonly HostBridgeMapping[],
): readonly string[] {
  const mapping = findLocalDevBridgeRow(specifier, mappings);
  return mapping === undefined ? [] : hostBridgeModuleIds(mapping);
}

/**
 * Refuse a projection that does not cover the bridge table exactly.
 *
 * Both directions, because "not in the set" is not "is its complement" (#14's
 * first review finding): a module id the table intercepts and this projection
 * omits is a module the dev harness would silently leave to the ordinary npm path
 * while the artifact binds it to a page global; a module id this projection names
 * and the table does not intercept is a resolution that promises to stand in for
 * something that was never decided.
 *
 * The guard takes the table as a parameter for the reason #9's guards do: a
 * project that extends the table has to extend the projection in the same change,
 * and that has to fail loudly rather than at the first unresolved import.
 *
 * Both tables arrive through a cast from a JSON config, so a member can be anything
 * at all, and each member is checked before anything is read off it. That ordering is
 * the check's own value: `hostBridgeModuleIds` spreads `moduleIds`, so a row carrying
 * `42` there would end the run in a `TypeError` from inside the spread, and a
 * resolution row whose `resolution` is not one of the three kinds would pass every
 * question below it — it neither says `unsupported` nor names no package nor lacks a
 * version field — and then drop out of both the resolvable and the unsupported list,
 * leaving a clean audit with nothing to say the row existed. A member that cannot be
 * read is refused here, where there is one check to change, rather than read around.
 */
export function assertLocalDevResolutionsCoverHostBridge(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): void {
  for (const mapping of mappings) {
    const problem = localDevBridgeRowProblem(mapping);
    if (problem !== undefined) {
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `A row of the host bridge mapping table cannot be read: ${problem}, so the module ids it intercepts are unaccounted for. The table is refused rather than read around.`,
      );
    }
  }

  for (const resolution of resolutions) {
    const problem = localDevResolutionRowProblem(resolution);
    if (problem !== undefined) {
      const named = localDevResolutionSubject(resolution);
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `${named === undefined ? "A local resolution row" : `The local resolution row ${named}`} cannot be read: ${problem}. Its kind is what decides which module ids it stands in for, so a row like that would resolve by nothing and say nothing about it.`,
      );
    }
  }

  const intercepted = new Set(hostBridgeInterceptedModuleIds(mappings));
  const covered = new Set<string>();

  for (const resolution of resolutions) {
    // Throws when the row does not exist, which is the other half of the check.
    const moduleIds = localDevModuleIdsOf(resolution.specifier, mappings);
    for (const moduleId of moduleIds) {
      if (covered.has(moduleId)) {
        throw new LocalDevRuntimeContractError(
          "mapping-coverage",
          `Module id "${moduleId}" is resolved by more than one local resolution row, so which package it loads would depend on row order.`,
        );
      }
      covered.add(moduleId);
    }

    if (resolution.resolution !== "unsupported") {
      const noTarget = localDevMissingTargetProblem(resolution);
      if (noTarget !== undefined) {
        throw new LocalDevRuntimeContractError(
          "mapping-coverage",
          `Local resolution "${resolution.specifier}" ${noTarget}.`,
        );
      }
    }

    if (resolution.checkedVersionField === undefined && resolution.alignmentUnchecked === undefined) {
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `Local resolution "${resolution.specifier}" neither checks a version field nor says why none can check it, so its alignment reads as verified while nothing verified it.`,
      );
    }
  }

  const missing = [...intercepted].filter(moduleId => !covered.has(moduleId));
  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mapping-coverage",
      `The host bridge intercepts ${missing.join(", ")}, and the local resolution table has no row for it. A module the artifact binds to a page global must say what the dev harness resolves instead, or the local loop silently tests a different module.`,
    );
  }

  const orphans = [...covered].filter(moduleId => !intercepted.has(moduleId));
  if (orphans.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mapping-coverage",
      `The local resolution table resolves ${orphans.join(", ")}, which the host bridge does not intercept, so it stands in for a module no decision covers.`,
    );
  }
}

/**
 * A module id the dev harness can stand in for.
 *
 * Tolerant of an orphan resolution row, because this is one of the lists the
 * audit derives after the coverage guard has run: a row whose specifier the table
 * does not carry contributes nothing here, and
 * `local-dev-mapping-coverage` is what says so. Reporting the orphan *and* handing
 * back a worklist the harness cannot act on are different jobs.
 *
 * A row whose kind is not one of the three is left out for the same reason: which list
 * it belongs in is decided by that kind, and nothing here may decide "resolvable" for a
 * row that resolved by nothing. The guard refuses such a row by name, so leaving it out
 * here is not the last word about it.
 *
 * A row that declares a stand-in and names none is left out too, and this is the list
 * where that matters most: {@link standsInForModuleId} is the same condition the guard
 * refuses such a row with, so the worklist cannot claim a stand-in beside a finding that
 * says there is nothing to resolve. It is the second reading of one rule, not a second
 * rule — the row is refused by name and reported as `local-dev-mapping-coverage`, and this
 * list simply does not claim what that finding denies. It is deliberately in *neither*
 * list rather than moved to {@link localDevUnsupportedModuleIds}: "nothing stands in for
 * this" is a statement the row did not make, and reporting it as one would be a second
 * finding about one mistake, in a different code, with different advice.
 */
export function localDevResolvableModuleIds(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  return resolutions
    .filter(canReadResolutionRow)
    .filter(standsInForModuleId)
    .flatMap(resolution => moduleIdsOfExistingRow(resolution.specifier, mappings));
}

/** A module id the table intercepts and no local resolution covers. Tolerant, for the reason above. */
export function localDevUnsupportedModuleIds(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  return resolutions
    .filter(canReadResolutionRow)
    .filter(resolution => resolution.resolution === "unsupported")
    .flatMap(resolution => moduleIdsOfExistingRow(resolution.specifier, mappings));
}

/** The bridge rows whose local substitution carries a version check. */
export function localDevAlignmentChecks(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
): readonly LocalDevAlignmentExpectation[] {
  return resolutions.filter(canReadResolutionRow).flatMap(resolution =>
    resolution.checkedVersionField === undefined || resolution.localPackage === undefined
      ? []
      : [
          {
            specifier: resolution.specifier,
            localPackage: resolution.localPackage,
            field: resolution.checkedVersionField,
            expected: localDevRecordedVersion(resolution.checkedVersionField),
          },
        ],
  );
}

export interface LocalDevAlignmentExpectation {
  readonly specifier: string;
  readonly localPackage: string;
  readonly field: LocalDevVersionField;
  /** #5's recorded value, obtained through {@link localDevRecordedVersion} and never stored. */
  readonly expected: string;
}

/** The bridge rows the local resolution table covers, in table order. */
export function localDevResolvedBridgeRows(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly HostBridgeMapping[] {
  return mappings.filter(mapping =>
    LOCAL_DEV_MODULE_RESOLUTIONS.some(resolution => resolution.specifier === mapping.specifier),
  );
}

export interface LocalDevModuleIdResolution {
  /** The exact module id asked about, which is not necessarily a row's specifier. */
  readonly moduleId: string;
  /** The row that intercepts it. */
  readonly specifier: string;
  readonly resolution: LocalDevModuleResolution;
}

/**
 * How one module id resolves locally, by exact id.
 *
 * The lookup a caller actually needs, and the reason it exists is visible in #9's
 * own table: `react-dom/client` and `react/jsx-dev-runtime` are module ids that are
 * *not* row specifiers, so a row-keyed lookup answers "no row" for two ids the
 * bridge does intercept. Asking by module id is what makes the projection usable
 * per import.
 *
 * `undefined` rather than a default, and that is the load-bearing part: an id the
 * bridge does not intercept has no local resolution, and returning "the ordinary
 * npm path will handle it" would be exactly the assumption that hides a bridged
 * import — the two cases look identical from inside a module graph and are not the
 * same statement.
 *
 * Two members are asked, and each is asked only after the check that covers what is
 * read off it: {@link canReadBridgeRow} decides whether a row can say which ids it
 * intercepts at all, and {@link canReadResolutionRow} whether a row can say what stands
 * in for the one it names. So `undefined` here also covers "a row that could not be
 * read", and this return type does not distinguish it from "no row" — which is the
 * deliberate boundary, because the answer that would matter, "the ordinary npm path
 * will handle it", must not be handed out on the strength of a row nobody could read.
 * {@link assertLocalDevResolutionsCoverHostBridge} is what refuses such a table; a
 * caller that needs the two told apart has to have run it.
 */
export function findLocalDevModuleIdResolution(
  moduleId: string,
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): LocalDevModuleIdResolution | undefined {
  const mapping = mappings.find(
    candidate => canReadBridgeRow(candidate) && hostBridgeModuleIds(candidate).includes(moduleId),
  );
  if (mapping === undefined) return undefined;

  const resolution = resolutions.find(
    candidate => canReadResolutionRow(candidate) && candidate.specifier === mapping.specifier,
  );
  if (resolution === undefined) return undefined;

  return { moduleId, specifier: mapping.specifier, resolution };
}

/**
 * #9's deferred modules, surfaced because the local loop has a specific blind spot
 * about them.
 *
 * They are absent from the mapping table, so they are absent from the resolution
 * projection too — and that is correct. What is not obvious is the *consequence*:
 * locally an `import dayjs from "dayjs"` simply resolves through the ordinary npm
 * path and works, because nothing has told Vite otherwise. On the page, no bridge
 * row binds that import either, and #9 deferred the row rather than deciding it.
 * So the import works in both places for different reasons, and a local render
 * establishes nothing about which way #9 will eventually resolve it.
 */
export function localDevDeferredHostModules(): readonly HostBridgeDeferredModule[] {
  return HOST_BRIDGE_DEFERRED_MODULES;
}

// ---------------------------------------------------------------------------
// The mock host surface
// ---------------------------------------------------------------------------

/**
 * The type a project supplies as its mock host surface.
 *
 * #27's `RuntimeFacadeHostBindings`, named rather than described, because #27 says
 * its mock/provider boundary exists so that "#22/#23 can supply mocks for the same
 * surface" — and a second, harness-only mock vocabulary would be exactly the
 * "second code path" #27's `host-branching` pattern refuses.
 */
export const LOCAL_DEV_MOCK_SURFACE_SOURCE = "RuntimeFacadeHostBindings";

export const LOCAL_DEV_MOCK_SURFACE = {
  source: LOCAL_DEV_MOCK_SURFACE_SOURCE,
  /**
   * The only provider kind a local harness may install.
   *
   * A `host` provider reads the bindings a live ReactCellType runtime injects, and
   * `vp dev` is by definition the process that does not have one. So a `host`
   * provider here is not a stricter configuration, it is a category error — which
   * is why the guard refuses it by name rather than failing later on a missing key.
   */
  providerKind: "mock",
  /** Every base prop key #5 injects on every cell, in its recorded order. */
  requiredCellPropKeys: CELL_PROPS_BASE_KEYS,
  /** Where the parameter knowledge for `props.ServerCommands` lives. */
  serverCommandParametersDeclaredBy: "the project, as ServerCommandBindings<Commands>",
  /** Whether the surface is checked by the type system rather than by convention. */
  typedByTypeScript: true,
  note: "A mock is required to be neither narrower nor wider than the host. Narrower means a cell reads a base prop locally that nothing injected, so the local pass depends on the mock's convenience; wider means a cell calls a capability the page does not have. Presence covers the first half — the keys #5 always injects are required to exist, with `undefined` as a legitimate value because the value is the project's claim, not this contract's.",
} as const;

/**
 * Refuse a mock narrower than the host.
 *
 * Presence only, deliberately. #5 records that `Permissions` can come back empty
 * and that a configured permission has been observed as an empty snapshot, so
 * requiring a *value* here would make legal host states unrepresentable locally.
 * What is not legal is a missing key: the runtime injects all four on every cell,
 * so a mock without one would let a cell read `undefined` locally and a real value
 * on the page.
 */
export function assertLocalDevMockSuppliesEveryBaseProp(
  bindings: RuntimeFacadeHostBindings,
  requiredKeys: readonly string[] = CELL_PROPS_BASE_KEYS,
): void {
  const supplied = new Set(Object.keys(bindings.cellProps));
  const missing = requiredKeys.filter(key => !supplied.has(key));

  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mock-surface-incomplete",
      `The mock host surface omits ${missing.join(", ")}, which #5 records the runtime injecting on every cell. A cell reading one of them would see \`undefined\` locally and a value on the page.`,
    );
  }
}

/**
 * Refuse a provider that is not a mock.
 *
 * The check is on the discriminant rather than on the shape, because both provider
 * kinds satisfy the same `bindings` type by design — that is #27's
 * substitutability requirement — so nothing else can distinguish them.
 */
export function assertLocalDevProviderIsMock(provider: RuntimeFacadeProvider): void {
  if (provider.kind !== LOCAL_DEV_MOCK_SURFACE.providerKind) {
    throw new LocalDevRuntimeContractError(
      "provider-is-not-a-mock",
      `The local harness was handed a "${provider.kind}" provider. A host provider reads bindings a live ReactCellType runtime injects, and the local dev process does not have one — so this is a configuration error rather than a stricter setup.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dependency decisions under local development
// ---------------------------------------------------------------------------

export const LOCAL_DEV_DECISION_HANDLINGS = [
  "host-substitution",
  "bundled-verbatim",
  "local-substitute-required",
  "no-stand-in-needed",
] as const;

export type LocalDevDecisionHandling = (typeof LOCAL_DEV_DECISION_HANDLINGS)[number];

export interface LocalDevStrategyHandling {
  readonly strategy: DependencyStrategy;
  readonly localHandling: LocalDevDecisionHandling;
  /** What the project has to declare for this strategy to resolve locally. */
  readonly requiresFromTheProject?: string;
  /** What a local run of this strategy's dependency does establish. */
  readonly localClaim: string;
  /** What it does not, and where that evidence lives. */
  readonly realRuntimeClaimedBy: string;
}

/**
 * One handling per strategy, and the list is derived from `core`'s tuple rather
 * than written out, so a fifth strategy cannot be added without someone having to
 * answer "what does this do locally".
 *
 * `extension` is the entry #22 names explicitly ("surface dependency decisions so
 * `extension` packages can either use an explicit local shim/npm source or be
 * marked as requiring real-runtime validation"). Both halves of that sentence are a
 * `LocalDevExtensionChoice`, and it is the only entry that can leave a local
 * configuration *incomplete* rather than merely inexact: the harness cannot invent
 * a substitute, because the reason the package is an `extension` in the first place
 * is that its module identity or its cross-cell singleton semantics matter. So the
 * project declares one of the two branches, and an undeclared package is reported as
 * an omission — which is a different finding from a declared `real-runtime-only`, and
 * has to stay different or the report teaches people to ignore it.
 */
export const LOCAL_DEV_STRATEGY_HANDLINGS: readonly LocalDevStrategyHandling[] = [
  {
    strategy: "host",
    localHandling: "host-substitution",
    localClaim:
      "That the cell's own code is well formed against the published module, at the version #5 recorded where a version was recorded.",
    realRuntimeClaimedBy: "The page, through #5's evidence and #4's `real-runtime` checks for `host`.",
  },
  {
    strategy: "inline",
    localHandling: "bundled-verbatim",
    localClaim:
      "The strongest of the four: the dev server loads the very package the artifact will inline, so a local render exercises the real dependency rather than a substitute.",
    realRuntimeClaimedBy:
      "The page, where the inlined copy actually executes — #4's `real-runtime` check for `inline` is exactly that the bundle runs in a real cell.",
  },
  {
    strategy: "extension",
    localHandling: "local-substitute-required",
    requiresFromTheProject:
      "Exactly one of two recorded choices per package (`LocalDevExtensionChoice`): a local substitute — the published package or a project shim — with its justification, or a `real-runtime-only` acknowledgement saying why no stand-in is used and what stays unexercised. Exactly one, because the two are exclusive readings of the same decision.",
    localClaim:
      "Only that the cell compiles and renders against whatever the substitute is. Nothing about the extension: not its global name in this project, not its version, and not whether the ReactCellType reference resolves at load time. Under `real-runtime-only` the local claim is narrower still — the dependency is not exercised at all.",
    realRuntimeClaimedBy:
      "#13 (the extension PoC) and #12's contract, which own the `frontendLibraries` reference and the load-time global.",
  },
  {
    strategy: "replace",
    localHandling: "no-stand-in-needed",
    localClaim:
      "That the rejection record is well formed. What resolves locally is the replacement's own decision, which carries its own handling from this table.",
    realRuntimeClaimedBy:
      "The page, for whichever strategy the replacement took; #16 owns the selection and #4's `real-runtime` check for `replace` is that the replacement satisfies the original requirement in a real page.",
  },
];

/**
 * Refuse a handling list that does not answer for every strategy, exactly once.
 *
 * Derived coverage both ways: a strategy with no handling is a local configuration
 * nobody has thought about, and two handlings for one strategy would make the
 * answer depend on list order.
 */
export function assertLocalDevStrategyHandlingsCoverStrategies(
  handlings: readonly LocalDevStrategyHandling[] = LOCAL_DEV_STRATEGY_HANDLINGS,
): void {
  const seen = new Set<DependencyStrategy>();

  for (const handling of handlings) {
    if (seen.has(handling.strategy)) {
      throw new LocalDevRuntimeContractError(
        "strategy-handling-coverage",
        `Strategy "${handling.strategy}" has more than one local handling, so what a local run establishes for it would depend on list order.`,
      );
    }
    seen.add(handling.strategy);
  }

  const missing = DEPENDENCY_STRATEGIES.filter(strategy => !seen.has(strategy));
  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `Strategies ${missing.join(", ")} have no local handling, so nothing says what a local run of one establishes.`,
    );
  }

  const extra = [...seen].filter(strategy => !(DEPENDENCY_STRATEGIES as readonly string[]).includes(strategy));
  if (extra.length > 0) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `The local handling table answers for ${extra.join(", ")}, which is not one of #4's strategies.`,
    );
  }
}

/** The handling for a strategy. */
export function localDevHandlingForStrategy(strategy: DependencyStrategy): LocalDevStrategyHandling {
  const handling = LOCAL_DEV_STRATEGY_HANDLINGS.find(candidate => candidate.strategy === strategy);
  if (handling === undefined) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `Strategy "${strategy}" has no local handling.`,
    );
  }
  return handling;
}

/**
 * What the project decided about an `extension` dependency in local development.
 *
 * #22 asks for exactly two outcomes, and the type is the pair rather than a single
 * record because the second outcome is a *decision* and not a missing field:
 * "an `extension` package can either use an explicit local shim/npm source or be
 * marked as requiring real-runtime validation". A model with only a substitute
 * makes the second branch unrepresentable, and the consequence is specific — every
 * project that deliberately left the dependency to real-runtime validation would be
 * reported as if it had forgotten to configure something, and a diagnostic that
 * cannot tell a decision from an omission teaches people to ignore it.
 *
 * Both members carry prose the harness cannot supply on the project's behalf. A
 * bare "use npm instead" would be the harness deciding that a deployment difference
 * does not matter, and the project is the only party that knows whether the
 * singleton semantics its cell relies on are exercised locally.
 *
 * A package appears in this list at most once. Two entries for one package are not
 * two decisions — they are two mutually exclusive readings of one, and keeping
 * either would make the audit's answer depend on the order of the array: reversing
 * the list would move the package between `substitute` and `real-runtime-only`
 * without anyone editing a decision. A duplicate is refused rather than resolved,
 * because resolving it would be the harness picking one of two things the project
 * stated.
 */
export const LOCAL_DEV_EXTENSION_CHOICE_MODES = ["substitute", "real-runtime-only"] as const;

export type LocalDevExtensionChoiceMode = (typeof LOCAL_DEV_EXTENSION_CHOICE_MODES)[number];

/**
 * The two ways a project can stand in for an extension global locally.
 *
 * A const tuple rather than a union written out in one place only, for the same
 * reason the modes are one: the validator has to be able to name the set at
 * runtime, and a union that exists only in the type checker cannot be checked
 * against a JSON project config.
 */
export const LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS = ["npm-package", "project-shim"] as const;

export type LocalDevExtensionSubstituteKind = (typeof LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS)[number];

/** The project stands the extension global in for locally. */
export interface LocalDevExtensionSubstitute {
  /** The package whose decision is `extension`. */
  readonly packageName: string;
  readonly mode: "substitute";
  readonly kind: LocalDevExtensionSubstituteKind;
  /** What the substitute resolves to locally. */
  readonly resolvesTo: string;
  /** Why this is an acceptable stand-in for local UI work. */
  readonly justification: string;
}

/**
 * The project accepts that this dependency cannot be exercised locally.
 *
 * `consequence` is required and separate from `reason` because the two answer
 * different questions: *why* the extension has no local equivalent, and *what the
 * developer will not be able to see*. The second is what a teammate needs, and it is
 * the one an acknowledgement written in a hurry leaves out.
 */
export interface LocalDevExtensionRealRuntimeOnly {
  readonly packageName: string;
  readonly mode: "real-runtime-only";
  /** Why no local stand-in is used. */
  readonly reason: string;
  /** What this leaves unexercised, stated for whoever reads the audit next. */
  readonly consequence: string;
}

export type LocalDevExtensionChoice = LocalDevExtensionSubstitute | LocalDevExtensionRealRuntimeOnly;

/**
 * A string with content, read without touching the value.
 *
 * Every string member of a choice goes through this rather than being compared
 * directly, because the input reaches the validator from `unknown`: a JSON project
 * config is parsed before it is typed, so a field the type calls `string` can be a
 * number at runtime, and `.trim()` on a number is a throw. Checking the type before
 * reading the value is what makes the validator total.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * What to call a choice in a finding, when its own name may not be usable.
 *
 * A malformed entry is exactly the one whose `packageName` cannot be trusted — it
 * may be missing, a number, or the entry may be `null` — so a finding about it
 * cannot be keyed on the name it was supposed to have. The placeholder keeps the
 * finding addressable without naming a package that was never named.
 */
function localDevChoiceSubject(choice: unknown): string {
  if (typeof choice === "object" && choice !== null) {
    const packageName = (choice as { packageName?: unknown }).packageName;
    if (isNonEmptyString(packageName)) return packageName;
  }
  return "(an unnamed extension choice)";
}

/**
 * What is missing from an `extension` choice, or `undefined` when it is a decision.
 *
 * A validator rather than a boolean, so the audit can say *which* part of the
 * declaration is absent. An acknowledgement with an empty `reason` is not a
 * decision with a terse author, it is an omission that has learned the vocabulary.
 *
 * Takes `unknown` on purpose, and inspects before it reads. The declared type on
 * {@link LocalDevAuditInput} is the contract, but a config read from JSON is
 * `unknown` until something has checked it, and the cast that turns it into
 * `LocalDevExtensionChoice` belongs to the caller. Trusting that cast is how "the
 * audit never throws" gets broken by a number where a string was expected, so the
 * two members that select the branch — `packageName` and `mode` — are checked as
 * strings first, and the branch is taken on the checked value rather than on the
 * union, because falling off a `switch` reads as "no problem", which is the exact
 * silent pass this validator exists to prevent.
 */
export function localDevExtensionChoiceProblem(choice: unknown): string | undefined {
  if (typeof choice !== "object" || choice === null) return "it is not a choice at all";
  const declared = choice as Record<string, unknown>;

  if (!isNonEmptyString(declared.packageName)) return "it names no package";

  const mode = declared.mode;
  if (!isNonEmptyString(mode)) return "it selects neither branch";
  if (!(LOCAL_DEV_EXTENSION_CHOICE_MODES as readonly string[]).includes(mode)) {
    return `the mode "${mode}" is not one of the two branches #22 allows`;
  }

  // Past this point the branch is known, so only its own fields remain — and each
  // is still checked before it is touched, for the same reason.
  if (mode === "substitute") {
    const kind = declared.kind;
    if (!isNonEmptyString(kind) || !(LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS as readonly string[]).includes(kind)) {
      return `the substitute kind "${String(kind)}" is not one of the two #22 allows`;
    }
    if (!isNonEmptyString(declared.resolvesTo)) return "the substitute names nothing to resolve to";
    if (!isNonEmptyString(declared.justification)) return "the substitute gives no justification";
    return undefined;
  }

  if (!isNonEmptyString(declared.reason)) return "the acknowledgement gives no reason";
  if (!isNonEmptyString(declared.consequence)) {
    return "the acknowledgement states no consequence, so nothing says what it leaves unexercised";
  }
  return undefined;
}

/**
 * Refuse an `extension` choice that is not a decision, or a package that has two.
 *
 * The structural defence behind #22's two valid branches: without the first check,
 * `real-runtime-only` could be reached by writing the mode and nothing else, and the
 * repository would have traded one unrepresentable state for one that is
 * representable but empty. The second check is the same argument one level up — two
 * entries for one package make the branch depend on the order of the list, so the
 * pair is refused rather than resolved.
 */
export function assertLocalDevExtensionChoicesAreDeclared(
  choices: readonly LocalDevExtensionChoice[] = [],
): void {
  const declared = new Set<string>();
  for (const choice of choices) {
    const problem = localDevExtensionChoiceProblem(choice);
    if (problem !== undefined) {
      throw new LocalDevRuntimeContractError(
        "extension-choice-not-declared",
        `The local choice for "${localDevChoiceSubject(choice)}" is not a decision: ${problem}.`,
      );
    }

    if (declared.has(choice.packageName)) {
      throw new LocalDevRuntimeContractError(
        "extension-choice-duplicated",
        `The package "${choice.packageName}" carries more than one local choice. A package has one decision, so a second entry is not a second decision — with both present, which branch applies would depend on the order of the list. Declare exactly one.`,
      );
    }
    declared.add(choice.packageName);
  }
}

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

/** Where a cell's failure appears while developing locally. */
export const LOCAL_DEV_ERROR_SURFACES = [
  "uncaught-render-error",
  "vite-hmr-overlay",
  "typecheck",
  "terminal",
] as const;

export type LocalDevErrorSurface = (typeof LOCAL_DEV_ERROR_SURFACES)[number];

/**
 * What the harness may and may not do about a cell's failures.
 *
 * The record is a pair on purpose. #22's fourth acceptance criterion asks that UI
 * errors be "visible through normal browser/Vite tooling", and the way to violate
 * it while looking helpful is to add an error boundary that renders a fallback: the
 * failure stops being an uncaught error anyone notices and becomes a cell that
 * renders the wrong thing. The contrast with production is what makes the choice
 * legible rather than a matter of taste — #5 records that on the page a failing
 * cell renders `null` into its own root and writes to `console.error`, so the
 * local loop's job is to be *louder* than production, not to model it.
 *
 * `forguncyBehaviour` is read off `core` rather than paraphrased, so the contrast
 * cannot be restated incorrectly in one place and correctly in another.
 */
export const LOCAL_DEV_ERROR_SURFACING = {
  surfaces: LOCAL_DEV_ERROR_SURFACES,
  installsErrorBoundary: false,
  catchesCellErrors: false,
  /** Production behaviour the local loop deliberately does not reproduce. */
  forguncyBehaviour: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior,
  forguncyRendersErrorTextInCell: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.rendersErrorTextInCell,
  note: "Modeling production would mean rendering `null` and writing to `console.error`, which is precisely the outcome a development loop exists to avoid. A harness that installed a boundary would reproduce the silence without reproducing the reason for it.",
} as const;

/** The local and production failure behaviours side by side, for a report or a doc. */
export function localDevFailureContrast(): { readonly local: string; readonly forguncy: string } {
  return {
    local:
      "A cell's failure is left to propagate: the error reaches the browser console, the Vite HMR overlay and the terminal, and it is never converted into a rendered fallback.",
    forguncy: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior,
  };
}

// ---------------------------------------------------------------------------
// What the local loop establishes, and what stays owed
// ---------------------------------------------------------------------------

export const LOCAL_DEV_CLAIM_IDS = [
  "cell-source-mounts-unmodified",
  "cell-ui-renders",
  "hmr-round-trip",
  "repo-checks-pass",
  "dependency-substitutions-resolve",
] as const;

export type LocalDevClaimId = (typeof LOCAL_DEV_CLAIM_IDS)[number];

export interface LocalDevClaim {
  readonly id: LocalDevClaimId;
  readonly statement: string;
  /**
   * Always `local`, and typed as the literal rather than as `DependencyCheckLevel`.
   *
   * That is the whole mechanism: a claim that carried the general level type could
   * be written as `real-runtime` and would then type-check. #22's Problem section
   * asks for a local loop that does not pretend, and the type is where that stops
   * being a promise.
   */
  readonly level: "local";
  /** What the local loop does not establish by doing this. */
  readonly doesNotEstablish: string;
  /** The Issue or contract that owns the real evidence for it. */
  readonly realRuntimeOwner: string;
}

export const LOCAL_DEV_CLAIMS: readonly LocalDevClaim[] = [
  {
    id: "cell-source-mounts-unmodified",
    statement: "The Cell entry runs locally without any change to the source the artifact is generated from.",
    level: "local",
    doesNotEstablish:
      "That the same source is accepted by the platform's write-time validator — see `no-designer-write-time-validation`, which is the boundary this claim most often gets read past.",
    realRuntimeOwner: "#5 (the recorded validation mechanism); #6 / #7 project it",
  },
  {
    id: "cell-ui-renders",
    statement:
      "The Cell's own UI — components, interaction state, forms, visualisation — renders and behaves as authored.",
    level: "local",
    doesNotEstablish:
      "That it renders that way in a cell. Substituted host modules are the published packages, and #5 measured a cell in which a preset-conditional global is legitimately absent.",
    realRuntimeOwner: "#20 / #25 (real page and clean-checkout gate)",
  },
  {
    id: "hmr-round-trip",
    statement: "A source edit reaches the running UI through Vite's normal HMR path.",
    level: "local",
    doesNotEstablish:
      "Anything about the product. HMR is a property of the local bundler and has no counterpart in the designer or in a deployed cell.",
    realRuntimeOwner: "#20 / #25 (real page and clean-checkout gate)",
  },
  {
    id: "repo-checks-pass",
    statement: "Type checking, linting and the repository's test suite pass over this source.",
    level: "local",
    doesNotEstablish:
      "That the artifact is within budget or that it runs. Both are AGENTS.md's separate concerns: #21 measures the size envelope and only a page executes.",
    realRuntimeOwner: "#21 (measured budget) and #20 / #25 (execution)",
  },
  {
    id: "dependency-substitutions-resolve",
    statement:
      "Every module id #9's bridge intercepts resolves locally, and the ones with a recorded version resolve at that version.",
    level: "local",
    doesNotEstablish:
      "That the page provides the corresponding global, or that a narrowed bridged surface behaves the same way. Locally `react-dom/client` is the whole published module; on the page it is the members #5 observed and nothing else.",
    realRuntimeOwner: "#4's `real-runtime` checks per strategy, exercised through #20 / #25",
  },
];

/**
 * Refuse a claim that the local loop produced real-runtime evidence.
 *
 * The literal type on {@link LocalDevClaim.level} already makes this unrepresentable
 * for the shipped list. The guard exists for the same reason `core`'s table guards
 * exist: a project or a future caller can build its own list, and the one mistake
 * worth catching is the one that reads as success.
 */
export function assertLocalDevClaimsAreLocalOnly(claims: readonly LocalDevClaim[] = LOCAL_DEV_CLAIMS): void {
  for (const claim of claims) {
    if ((claim.level as DependencyCheckLevel) !== "local") {
      throw new LocalDevRuntimeContractError(
        "claim-not-local",
        `Claim "${claim.id}" is marked "${claim.level}". The local dev loop produces local evidence only; a claim at another level would report a local process as having validated the target.`,
      );
    }
  }
}

export interface LocalDevOwedCheck {
  readonly strategy: DependencyStrategy;
  /** #4's own wording for the check, not a restatement. */
  readonly check: string;
  readonly owner: string;
}

/**
 * Every check the local loop cannot discharge, read from `#4`'s strategy table.
 *
 * Derived from `checksForLevel` rather than listed, for the reason #14's review
 * established: a second copy of a rule is a second place for it to be wrong. A
 * strategy whose `real-runtime` checks are empty would produce nothing here, which
 * is the answer `#4` gives rather than an omission this module decided on.
 */
export function localDevRealRuntimeOwedChecks(): readonly LocalDevOwedCheck[] {
  return DEPENDENCY_STRATEGIES.flatMap(strategy =>
    checksForLevel(strategy, "real-runtime").map(check => ({
      strategy,
      check: check.description,
      owner: localDevHandlingForStrategy(strategy).realRuntimeClaimedBy,
    })),
  );
}

/** The local checks #4 allows for a strategy — what a local build *is* allowed to report. */
export function localDevDischargeableChecks(strategy: DependencyStrategy): readonly string[] {
  return checksForLevel(strategy, "local").map(check => check.description);
}

/**
 * The distinction #22's fifth acceptance criterion asks documentation to make,
 * in the form a report can print.
 *
 * Built from #4's tables and the records above, so it cannot drift: a strategy
 * whose `real-runtime` checks change changes this text, and a stage list that
 * gained a second real-runtime stage would fail
 * {@link assertLocalDevLoopStagesAreAdmissible} before any document was written.
 */
export function formatLocalDevValidationDistinction(): string {
  const owed = localDevRealRuntimeOwedChecks();
  return [
    "Local Vite+ development produces `local` evidence only.",
    "It establishes:",
    ...LOCAL_DEV_CLAIMS.map(claim => `- ${claim.statement}`),
    "It does not establish any real-runtime check. Still owed to a real Forguncy page:",
    ...owed.map(entry => `- [${entry.strategy}] ${entry.check} (owner: ${entry.owner})`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const LOCAL_DEV_DIAGNOSTIC_CODES = [
  "local-dev-mapping-coverage",
  "local-dev-no-local-stand-in",
  "local-dev-deferred-host-module",
  "local-dev-extension-choice-malformed",
  "local-dev-extension-choice-duplicated",
  "local-dev-extension-choice-unmatched",
  "local-dev-extension-needs-substitute",
  "local-dev-extension-real-runtime-only",
  "local-dev-host-version-mismatch",
  "local-dev-mock-surface-incomplete",
] as const;

export type LocalDevDiagnosticCode = (typeof LOCAL_DEV_DIAGNOSTIC_CODES)[number];

/** Which side of the local configuration has to act. Never omitted: a code is not a dead end. */
export type LocalDevFixOwner = "host-bridge-mapping" | "project-configuration" | "local-install" | "dependency-decision";

export interface LocalDevDiagnosticRule {
  readonly code: LocalDevDiagnosticCode;
  readonly label: string;
  /** One sentence stating the condition, without the offending value. */
  readonly states: string;
  readonly remediation: string;
  readonly fixOwner: LocalDevFixOwner;
  /**
   * Whether the condition blocks local development.
   *
   * `false` for the ones a local loop can carry on around — a deferred module
   * resolves either way, and a version mismatch is worth knowing about but does
   * not stop a render. The distinction is what lets the harness warn instead of
   * refusing, and a report say which of the two a code is.
   */
  readonly blocksLocalDevelopment: boolean;
}

export const LOCAL_DEV_DIAGNOSTIC_RULES: Readonly<Record<LocalDevDiagnosticCode, LocalDevDiagnosticRule>> = {
  "local-dev-mapping-coverage": {
    code: "local-dev-mapping-coverage",
    label: "The local resolution table and the host bridge table disagree",
    states: "A module id one table covers and the other does not.",
    remediation:
      "Add the missing row, or remove the extra one. Either table moving without the other means the dev harness and the artifact resolve the same import differently, which is the drift #22's third acceptance criterion exists to prevent.",
    fixOwner: "host-bridge-mapping",
    blocksLocalDevelopment: true,
  },
  "local-dev-no-local-stand-in": {
    code: "local-dev-no-local-stand-in",
    label: "A bridged module has no local stand-in",
    states: "A bridge row is marked `unsupported` for local development.",
    remediation:
      "Supply a substitute, or accept that this import cannot be exercised locally. The one option that is not available is approximating it: a stand-in nobody declared is a local-only pass waiting to happen.",
    fixOwner: "project-configuration",
    blocksLocalDevelopment: false,
  },
  "local-dev-deferred-host-module": {
    code: "local-dev-deferred-host-module",
    label: "A referenced module is a host global whose bridge row is deferred",
    states: "The cell references a module #9 named as a future built-in and did not map.",
    remediation:
      "Expect it to resolve locally through the ordinary npm path and to be undecided on the page. Adding the row requires the evidence #9 recorded as missing — a version, and an answer for a cell that did not declare the preset — so this is not a diagnostic a local change can close.",
    fixOwner: "host-bridge-mapping",
    blocksLocalDevelopment: false,
  },
  "local-dev-extension-choice-malformed": {
    code: "local-dev-extension-choice-malformed",
    label: "A declared `extension` choice is not a decision",
    states: "A choice in the project's list is missing a part its branch requires.",
    remediation:
      "Fill in the part the finding names — the two branches ask for different fields, so the fix is to complete the one that was chosen. A choice that has learned the vocabulary but not the content is still an omission: an acknowledgement with a `consequence` left empty does not say what the local loop cannot exercise, and a substitute with no `resolvesTo` does not say what it stands in. The list is inspected without trusting its declared type, so a value that is not a choice at all reaches the same finding rather than a stack trace.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-choice-duplicated": {
    code: "local-dev-extension-choice-duplicated",
    label: "One `extension` package carries more than one local choice",
    states: "Two or more well-formed choices name the same package.",
    remediation:
      "Keep exactly one entry and delete the rest. A package has one decision, so a second entry is not a second decision: with both present, the branch that applies would depend on their order in the list, and reversing the list would move the package between `substitute` and `real-runtime-only` without anyone editing a decision. Neither entry is used, because picking one would be the harness deciding something the project stated twice.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-choice-unmatched": {
    code: "local-dev-extension-choice-unmatched",
    label: "A declared `extension` choice matches no `extension` decision",
    states: "A choice names a package the supplied decision list does not carry as `extension`.",
    remediation:
      "Delete the entry, or restore the decision it described. A choice is the local half of a dependency decision, so when a package moves to another strategy — `extension` to `inline`, say — its choice is left describing a decision that no longer exists. Both directions are checked for the same reason the local resolution table is: `every extension decision has a choice` and `every choice has an extension decision` are different statements, and a check that asks only the first reports a pass for a record that disagrees with itself. Only asked when the caller supplied the decisions; with none, the audit has nothing to match against and abstains.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: false,
  },
  "local-dev-extension-needs-substitute": {
    code: "local-dev-extension-needs-substitute",
    label: "An `extension` dependency has no declared local choice",
    states: "A dependency decision is `extension` and the project declared no choice for it.",
    remediation:
      "Declare one of the two branches: a substitute with its justification, or a `real-runtime-only` acknowledgement with its reason and its consequence. A harness cannot choose for the project — whether the singleton semantics the cell relies on are exercised locally is not a fact it can observe — but silence is not a choice either. A choice that was declared and is incomplete is reported as `local-dev-extension-choice-malformed` instead, because the fix there is to complete the branch rather than to pick one.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-real-runtime-only": {
    code: "local-dev-extension-real-runtime-only",
    label: "An `extension` dependency is deliberately left to real-runtime validation",
    states: "The project recorded a `real-runtime-only` choice for this package.",
    remediation:
      "Nothing to fix — this is the second of the two branches #22 allows, and it is deliberately non-blocking. It is reported rather than dropped so the audit's output distinguishes a decision from an omission, and so whoever reads it knows which dependency the local loop cannot exercise at all.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: false,
  },
  "local-dev-host-version-mismatch": {
    code: "local-dev-host-version-mismatch",
    label: "The locally installed package is not the recorded host version",
    states: "The resolved version of a substituted package differs from the one #5 recorded.",
    remediation:
      "Align the local install with the recorded version, or re-probe the target (#5) if the page has moved. Do not relax the comparison: the check exists because a cell developed against a different React version is not evidence about this target, and the two failures — a stale lock and a newer host — have different fixes.",
    fixOwner: "local-install",
    blocksLocalDevelopment: false,
  },
  "local-dev-mock-surface-incomplete": {
    code: "local-dev-mock-surface-incomplete",
    label: "The mock host surface omits a prop the host always injects",
    states: "A base prop key #5 records on every cell is missing from the mock.",
    remediation:
      "Declare the key, with `undefined` as its value if that is the truth. #5 records all four keys present on every cell, so a cell that reads one locally would be reading something the mock invented by omission.",
    fixOwner: "project-configuration",
    blocksLocalDevelopment: true,
  },
};

export interface LocalDevDiagnostic {
  readonly code: LocalDevDiagnosticCode;
  /** What the finding is about: a module id, a package name, or a configuration area. */
  readonly subject: string;
  readonly detail: string;
}

export function createLocalDevDiagnostic(
  code: LocalDevDiagnosticCode,
  subject: string,
  detail: string,
): LocalDevDiagnostic {
  return { code, subject, detail };
}

/** One line per diagnostic, including what to do about it and whether it blocks. */
export function formatLocalDevDiagnostic(diagnostic: LocalDevDiagnostic): string {
  const rule = LOCAL_DEV_DIAGNOSTIC_RULES[diagnostic.code];
  return `${diagnostic.subject}: [${diagnostic.code}] ${rule.label} — ${diagnostic.detail} (fix owner: ${rule.fixOwner}${rule.blocksLocalDevelopment ? ", blocks local development" : ""})`;
}

export function formatLocalDevDiagnostics(diagnostics: readonly LocalDevDiagnostic[]): string {
  return diagnostics.map(formatLocalDevDiagnostic).join("\n");
}

// ---------------------------------------------------------------------------
// Auditing a local configuration
// ---------------------------------------------------------------------------

export interface LocalDevAuditInput {
  readonly resolutions?: readonly LocalDevModuleResolution[];
  readonly mappings?: readonly HostBridgeMapping[];
  /** The decisions the project's lock carries, when the caller knows them. */
  readonly decisions?: readonly DependencyDecision[];
  /**
   * What the project decided about each of its `extension` dependencies.
   *
   * Both of #22's branches arrive here — a substitute and a `real-runtime-only`
   * acknowledgement are the same field with different modes — because a project that
   * chose the second branch is not missing a value, and an input shape that could not
   * express its choice would report a recorded decision as an omission.
   *
   * The declared type is the contract; the list is still inspected at runtime rather
   * than trusted, because a project config read from JSON reaches the audit through
   * a cast. Each package may appear **at most once**: two entries for one package are
   * two readings of one decision, and the audit refuses the pair instead of letting
   * the array's order pick a branch.
   */
  readonly extensionChoices?: readonly LocalDevExtensionChoice[];
  /** The versions the local process actually resolved, keyed by package name. */
  readonly installedVersions?: Readonly<Record<string, string>>;
  /** The mock host surface, when one is configured. */
  readonly mockBindings?: RuntimeFacadeHostBindings;
  /**
   * The specifiers the cell source references, when the caller knows them.
   *
   * Omitting it means "the caller did not say", not "the cell references nothing":
   * with no list there is nothing to say about deferred modules, and the audit
   * reports nothing rather than reporting a clean result for a question it did not
   * ask.
   */
  readonly referencedSpecifiers?: readonly string[];
}

export interface LocalDevAudit {
  readonly diagnostics: readonly LocalDevDiagnostic[];
  /**
   * The module ids the harness can stand in for.
   *
   * A row contributes here only when it makes that claim: it declares a stand-in and names
   * the package or shim path it resolves to ({@link standsInForModuleId}). Readable is not
   * the claim, so a row the guard refused for naming nothing to resolve is absent here even
   * though the row is present in the table.
   */
  readonly resolvable: readonly string[];
  /**
   * The module ids whose row declares no local stand-in (`unsupported`).
   *
   * Not the complement of {@link resolvable} when a table is broken: a row that declares a
   * stand-in and names none contributes to *neither* list, because "nothing stands in for
   * this module" is a statement that row did not make. `local-dev-mapping-coverage` is the
   * one report about it, and it names the row rather than the module ids it would have
   * covered.
   */
  readonly unresolved: readonly string[];
  /** The version comparisons the harness has to make, with #5's expected values. */
  readonly alignment: readonly LocalDevAlignmentExpectation[];
  /**
   * The packages the project deliberately left to real-runtime validation.
   *
   * Separate from {@link diagnostics} because it is not a problem: it is the list of
   * dependencies the local loop provably cannot exercise, which a report has to be
   * able to print without calling them findings.
   */
  readonly realRuntimeOnly: readonly string[];
  /** Everything the local loop cannot establish, for a report. */
  readonly owed: readonly LocalDevOwedCheck[];
}

/**
 * Everything wrong with a local configuration, in one pass.
 *
 * Built the way #9's `planHostBridge` is, and for the same reason: a configuration
 * error should come back as a finding the caller can print, not as an exception
 * that abandons the rest of the audit. So the table guards are called and their
 * throws converted, and the checks that need a caller-supplied input abstain when
 * it was not supplied rather than treating "not stated" as "empty".
 *
 * The no-throw promise covers the *whole* function, not only the guards it calls
 * explicitly, and that is a stronger statement than it looks: an input bad enough
 * to trip the coverage guard is exactly the input the derivations below still have
 * to survive, which is why they go through `moduleIdsOfExistingRow` rather than
 * through `localDevModuleIdsOf`. A report that throws while describing a problem has
 * replaced its own diagnostic with a stack trace.
 *
 * The scope of that promise, stated exactly, because two earlier wordings claimed
 * more than the code did. It covers the **members** of every caller-supplied list.
 * Those lists arrive from a JSON config through a cast, so a member can be anything:
 * `extensionChoices` members go through `localDevExtensionChoiceProblem`, which takes
 * `unknown` and answers with a finding; `resolutions` and `mappings` members are put
 * through a shape predicate before any helper reads a field off them; `decisions` and
 * `referencedSpecifiers` members are skipped when they do not carry the one field the
 * reader touches, since a value that is not a decision or not a specifier cannot
 * answer the question being asked of it.
 *
 * What it does not cover is a **container** whose own declared type is violated —
 * `extensionChoices: 42`, `resolutions: null`, `installedVersions: null` — where
 * iteration or indexing fails before there is any member to inspect. That boundary is
 * the declared type's job, and the audit names it rather than pretending to a totality
 * it could only have by re-declaring every input as `unknown`.
 */
export function auditLocalDevConfiguration(input: LocalDevAuditInput = {}): LocalDevAudit {
  const resolutions = input.resolutions ?? LOCAL_DEV_MODULE_RESOLUTIONS;
  const mappings = input.mappings ?? HOST_BRIDGE_MAPPINGS;
  const diagnostics: LocalDevDiagnostic[] = [];

  try {
    assertLocalDevResolutionsCoverHostBridge(resolutions, mappings);
  } catch (error) {
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-mapping-coverage",
        "local-resolution-table",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const unsupported = localDevUnsupportedModuleIds(resolutions, mappings);
  for (const moduleId of unsupported) {
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-no-local-stand-in",
        moduleId,
        "This module id is bridged for the page and has no local stand-in, so nothing exercises it during development.",
      ),
    );
  }

  // Deferred modules are reached through the ordinary npm path locally, which is
  // why the finding is about what a local render proves rather than about
  // resolution failing.
  const deferred = localDevDeferredHostModules();
  for (const specifier of input.referencedSpecifiers ?? []) {
    // A member that is not a string is not a specifier, so it cannot be a deferred
    // module either: the question this loop asks has the answer "no" for it, and
    // saying so by skipping is the only reading that neither throws nor invents a
    // finding about a value the audit has no vocabulary for.
    if (typeof specifier !== "string") continue;
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : (specifier.split("/")[0] ?? specifier);
    const deferredModule = deferred.find(candidate => candidate.specifier === packageName);
    if (deferredModule === undefined) continue;
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-deferred-host-module",
        specifier,
        `#9 deferred this mapping rather than deciding it (${deferredModule.reason} What it still requires: ${deferredModule.requires}) It resolves locally through the ordinary npm path, so a local render says nothing about how it will bind on the page.`,
      ),
    );
  }

  // Two properties of the declaration list, both checked before anything reads it:
  // every entry has to be a decision, and no package may carry two.
  //
  // Neither check trusts the declared type. A config read from JSON arrives as
  // `unknown` and the cast that turns it into `LocalDevExtensionChoice[]` is the
  // caller's, so every member is inspected before it is touched — and an entry the
  // validator rejects never becomes a map key, which is what stops the duplicate
  // check from being the place a number gets used as a package name.
  const wellFormedChoices: LocalDevExtensionChoice[] = [];
  const reportedChoices = new Set<string>();
  for (const choice of input.extensionChoices ?? []) {
    const problem = localDevExtensionChoiceProblem(choice);
    if (problem === undefined) {
      wellFormedChoices.push(choice);
      continue;
    }
    const subject = localDevChoiceSubject(choice);
    reportedChoices.add(subject);
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-extension-choice-malformed",
        subject,
        `The declared choice is not a decision: ${problem}. An entry that has learned the vocabulary but not the content is an omission, so it is reported as one rather than counted as the branch it names.`,
      ),
    );
  }

  const choiceOccurrences = new Map<string, number>();
  for (const choice of wellFormedChoices) {
    choiceOccurrences.set(choice.packageName, (choiceOccurrences.get(choice.packageName) ?? 0) + 1);
  }

  const declaredChoices = new Map<string, LocalDevExtensionChoice>();
  for (const choice of wellFormedChoices) {
    const occurrences = choiceOccurrences.get(choice.packageName) ?? 0;
    if (occurrences > 1) {
      if (reportedChoices.has(choice.packageName)) continue;
      reportedChoices.add(choice.packageName);
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-choice-duplicated",
          choice.packageName,
          `Declared ${occurrences} times. Neither entry is used: with both present, which branch applies would depend on the order of the list, so the decision is reported as unresolved rather than resolved by position.`,
        ),
      );
      continue;
    }
    declaredChoices.set(choice.packageName, choice);
  }

  // The other direction of the same coverage question, and only when the caller
  // stated the decisions at all: a choice whose package the decision list does not
  // carry as `extension` is the local half of a decision that no longer exists —
  // what is left behind when a package moves from `extension` to `inline`. Checked as
  // a pair with the loop below, for the reason the resolution table is checked both
  // ways: "every extension decision has a choice" and "every choice has an extension
  // decision" are different statements, and asking only the first reads as a pass for
  // a record that disagrees with itself. No `decisions` means the caller did not say,
  // so the cross-check abstains rather than guessing.
  if (input.decisions !== undefined) {
    const extensionDecisions = new Set(
      input.decisions
        .filter(canReadDecision)
        .filter(decision => decision.strategy === "extension")
        .map(decision => decision.packageName),
    );
    for (const choice of declaredChoices.values()) {
      if (extensionDecisions.has(choice.packageName)) continue;
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-choice-unmatched",
          choice.packageName,
          "A choice is the local half of a dependency decision, and no decision in the supplied list carries this package as an `extension` — the decision moved to another strategy, or it is gone. The entry is used for nothing and nothing else would report it, so it is surfaced here rather than left for someone to trust later.",
        ),
      );
    }
  }

  const realRuntimeOnly: string[] = [];
  for (const decision of input.decisions ?? []) {
    // A member whose strategy is not a string cannot be an `extension` decision, so
    // it has no local half to check and nothing to contribute to the coverage
    // question. Same reading as a non-string specifier above. A member that names no
    // package is left out with it: `packageName` is both the key this loop matches
    // choices by and the subject of the findings it raises, so reading a decision that
    // lacks one would put `undefined` in a report. What that leaves uncovered is the
    // record's own shape, which is `core`'s question (`validateDependencyDecisionShape`)
    // rather than this audit's — and a local finding about it would report one mistake
    // twice, once here and once from the validator that owns it.
    if (!canReadDecision(decision)) continue;
    if (decision.strategy !== "extension") continue;
    // The package already carries a finding about the choice it declared, so saying
    // "no choice is declared" next to it would be a second finding for one mistake.
    if (reportedChoices.has(decision.packageName)) continue;

    const choice = declaredChoices.get(decision.packageName);
    if (choice === undefined) {
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-needs-substitute",
          decision.packageName,
          "The decision is `extension` and no local choice is declared, so the cell cannot be exercised locally as written. Declaring a substitute records why the published package or shim is an acceptable stand-in; declaring `real-runtime-only` records that validation happens on the page instead.",
        ),
      );
      continue;
    }

    if (choice.mode === "real-runtime-only") {
      realRuntimeOnly.push(choice.packageName);
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-real-runtime-only",
          choice.packageName,
          `Recorded as needing real-runtime validation: ${choice.reason} Consequently ${choice.consequence}`,
        ),
      );
    }
  }

  const alignment = localDevAlignmentChecks(resolutions);
  const installed = input.installedVersions;
  if (installed !== undefined) {
    for (const expectation of alignment) {
      const actual = installed[expectation.localPackage];
      if (actual === undefined || actual === expectation.expected) continue;
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-host-version-mismatch",
          expectation.localPackage,
          `Resolved ${actual}, and #5 recorded ${expectation.field} as ${expectation.expected} for this target.`,
        ),
      );
    }
  }

  if (input.mockBindings !== undefined) {
    try {
      assertLocalDevMockSuppliesEveryBaseProp(input.mockBindings);
    } catch (error) {
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-mock-surface-incomplete",
          "cell-props",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return {
    diagnostics,
    resolvable: localDevResolvableModuleIds(resolutions, mappings),
    unresolved: unsupported,
    alignment,
    realRuntimeOnly,
    owed: localDevRealRuntimeOwedChecks(),
  };
}

/** A report block for a CI log, a terminal or a PR body. */
export function formatLocalDevAudit(audit: LocalDevAudit): string {
  return [
    `Local dev resolvable module ids: ${audit.resolvable.join(", ") || "(none)"}`,
    // A statement about what the rows declared, which is the stronger claim this audit can
    // make: a table the guard refused is reported by its findings, and a row that resolved
    // by nothing is one of them rather than an entry in a list. "No module id lacks a local
    // stand-in" would have been the stronger sentence and an unsayable one — it asserted
    // something about every module id, beside a finding that denied it for one of them.
    audit.unresolved.length === 0
      ? "No bridged module id is declared without a local stand-in."
      : `Declared without a local stand-in: ${audit.unresolved.join(", ")}`,
    audit.alignment.length === 0
      ? "No version check is available."
      : `Version checks: ${audit.alignment.map(entry => `${entry.localPackage}===${entry.expected}`).join(", ")}`,
    audit.realRuntimeOnly.length === 0
      ? "No extension dependency is left to real-runtime validation."
      : `Left to real-runtime validation by decision: ${audit.realRuntimeOnly.join(", ")}`,
    audit.diagnostics.length === 0
      ? "No local dev diagnostics."
      : `${audit.diagnostics.length} local dev diagnostic(s):\n${formatLocalDevDiagnostics(audit.diagnostics)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Authoring patterns the local loop must not reward
// ---------------------------------------------------------------------------

export const LOCAL_DEV_FORBIDDEN_PATTERN_IDS = [
  "local-only-source-branch",
  "global-installed-for-convenience",
  "mock-wider-than-the-host",
  "swallowed-render-error",
  "second-local-component",
] as const;

export type LocalDevForbiddenPatternId = (typeof LOCAL_DEV_FORBIDDEN_PATTERN_IDS)[number];

export interface LocalDevForbiddenPattern {
  readonly id: LocalDevForbiddenPatternId;
  /** The construct to look for, described so a reviewer or a future lint can match it. */
  readonly lookFor: string;
  readonly reason: string;
  readonly use: string;
}

export const LOCAL_DEV_FORBIDDEN_PATTERNS: readonly LocalDevForbiddenPattern[] = [
  {
    id: "local-only-source-branch",
    lookFor: "A branch on the environment inside Cell source: `if (import.meta.env.DEV)`, `if (isLocal)`, or a flag threaded in from the harness.",
    reason:
      "#22 requires the same authored source to be reused, with no separate local-only implementation, and #27 already records host-branching as the pattern that turns a mock from a stand-in into a second code path. A branch on the environment is the same mistake with the sign flipped: the branch that only runs locally is the one that never runs on the page.",
    use: "Install a mock provider and keep one code path. The provider is selected by the harness, and authored source never learns which one it got.",
  },
  {
    id: "global-installed-for-convenience",
    lookFor: "The harness assigning a host name onto `globalThis` or `window` so authored source can reach it without an import.",
    reason:
      "Two ways to be wrong, and the second is the nastier one. #5 records that `ForguncyReactHelper` is an injected parameter and deliberately *not* a window property, so a harness global can make a name reachable that the page does not expose. And for a name the page *does* install — `antd`, `dayjs` — it teaches a pattern whose only justification is that the platform happens to provide it, which is exactly what #4's `host` strategy is supposed to be a decision about rather than an assumption. The compile path binds module ids, not globals, so a global-reading cell is also a cell the bridge cannot bind.",
    use: "Import the module and let the tables decide what it resolves to: #9's mapping on the page, this projection's published package locally.",
  },
  {
    id: "mock-wider-than-the-host",
    lookFor: "A mock that supplies a capability #5 never recorded — a navigation function, a business-state store, an auth helper.",
    reason:
      "#5's user-scope and props records are the whole surface a cell can reach, and #27's capability registry admits only what those records back. A mock that adds something makes a cell that cannot work on the page render perfectly locally, and it does so on the one class of capability — application-owned navigation, state and permissions — where #4 says the cell must not implement it itself.",
    use: "Keep the mock to `RuntimeFacadeHostBindings`. A capability that is missing there is a capability the cell does not have, and #27's registry is where adding one is argued.",
  },
  {
    id: "swallowed-render-error",
    lookFor: "An error boundary, a `try`/`catch` around the mount, or a fallback element installed by the harness.",
    reason:
      "#5 records that on the page a failing cell renders `null` into its own root and writes to `console.error`. Modelling that locally would reproduce the silence without reproducing the reason for it, and #22's fourth acceptance criterion asks for the opposite: errors visible through the browser's and Vite's own tooling. A swallowed error is also the failure this whole module is about — a cell that is broken and green.",
    use: "Let it throw. `LOCAL_DEV_ERROR_SURFACING` records the channels it should reach.",
  },
  {
    id: "second-local-component",
    lookFor: "A `.dev.tsx` twin of a Cell, a harness-only wrapper component, or a storybook-style reimplementation of the entry.",
    reason:
      "#22's responsibilities end with \"reuse the same authored source; no separate local-only component implementation\". A twin is worse than a branch because it stays plausible: it renders, it looks right, and it drifts from the artifact's source one edit at a time with nothing failing.",
    use: "Mount the Cell entry itself. If the entry cannot be mounted, that is a fact about the entry worth fixing rather than working around.",
  },
];

// ---------------------------------------------------------------------------
// Guards' error type
// ---------------------------------------------------------------------------

export const LOCAL_DEV_CONTRACT_ERROR_CODES = [
  "boundary-not-admissible",
  "loop-stage-not-admissible",
  "mapping-coverage",
  "strategy-handling-coverage",
  "extension-choice-not-declared",
  "extension-choice-duplicated",
  "claim-not-local",
  "mock-surface-incomplete",
  "provider-is-not-a-mock",
] as const;

export type LocalDevContractErrorCode = (typeof LOCAL_DEV_CONTRACT_ERROR_CODES)[number];

/** Thrown by the guards above. Distinct from the diagnostic vocabulary on purpose. */
export class LocalDevRuntimeContractError extends Error {
  readonly code: LocalDevContractErrorCode;

  constructor(code: LocalDevContractErrorCode, message: string) {
    super(message);
    this.name = "LocalDevRuntimeContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

export const LOCAL_DEV_NON_GOALS = [
  "Reproduce the Forguncy designer. #22's first non-goal, and the reason the six boundaries above exist as records rather than as a paragraph: a pixel- or lifecycle-accurate clone would have to decide questions #5 left open.",
  "Implement every Forguncy API offline. The local surface is #27's confirmed capability set and nothing else, so a capability the harness cannot serve is a capability the cell does not have.",
  "Replace real runtime validation. #20 owns it and #25 gates v0.1 on it; the local loop cannot discharge a single `real-runtime` check from `#4`'s table, which `localDevRealRuntimeOwedChecks` prints rather than assumes.",
  "Validate the generated host bridge. The interposed modules and the JSX runtime adapter are compiler output (#7) with their own evidence; the dev harness resolves the published packages instead, so a green local render says nothing about them.",
] as const;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to the local dev contract has to cite.
 *
 * The architecture decisions first, then the three downstream Specs this module
 * is built on: #9 because the host mapping table is reused rather than replaced,
 * #27 because the mock surface is its provider port, and #22 itself.
 *
 * Kept separate from `RUNTIME_GOVERNING_DECISIONS` rather than added to it, and
 * for the same reason `core` keeps `GOVERNING_ARCHITECTURE_DECISIONS` short: that
 * list is the *façade* Spec's answer to "which architecture Spec governs #27", and
 * folding #22 into it would relabel a dev-runtime Spec as part of the façade's
 * contract.
 */
export const LOCAL_DEV_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
  RUNTIME_FACADE_DECISION,
  LOCAL_DEV_RUNTIME_DECISION,
];

export const LOCAL_DEV_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  LOCAL_DEV_GOVERNING_DECISIONS,
);
