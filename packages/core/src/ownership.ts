/**
 * Application ownership boundary.
 *
 * Decision source: GitHub Issue #4, "Spec: application ownership boundaries and
 * dependency strategy semantics". Specs live in Issues, so this module is the
 * executable projection of that decision rather than a copied document.
 *
 * The invariant is deliberately one sentence long. Everything a React cell is
 * allowed to depend on follows from it: if a capability is already owned by
 * Forguncy, a React cell that re-implements it is not "a package decision", it
 * is a platform conflict.
 */

export const APPLICATION_OWNERSHIP_INVARIANT = "Forguncy owns the application. React owns the island." as const;

export type ApplicationOwner = "forguncy" | "react-cell";

/**
 * Capabilities that are cheap to name but expensive to duplicate. Each one has
 * exactly one owner; a second implementation inside a cell is a boundary
 * violation regardless of how well it bundles.
 */
export type OwnershipConcernId =
  // Forguncy-owned.
  | "application-navigation"
  | "application-state"
  | "business-data-source"
  | "server-commands"
  | "permissions"
  | "page-lifecycle"
  | "cross-cell-communication"
  // React-cell-owned.
  | "cell-ui"
  | "cell-interaction-state"
  | "cell-forms"
  | "cell-visualization"
  | "cell-animation"
  | "cell-editors"
  | "cell-local-remote-data";

export interface OwnershipConcern {
  readonly id: OwnershipConcernId;
  readonly owner: ApplicationOwner;
  readonly label: string;
  /** Why this owner, in one sentence. Used verbatim in rejection reports. */
  readonly rationale: string;
}

const FORGUNCY_CONCERNS: readonly OwnershipConcern[] = [
  {
    id: "application-navigation",
    owner: "forguncy",
    label: "Application/page navigation and browser-history semantics",
    rationale:
      "Navigation is page state owned by the Forguncy application shell; a cell-local router would create a second history the host cannot observe.",
  },
  {
    id: "application-state",
    owner: "forguncy",
    label: "Page/global state shared across ReactCellType cells",
    rationale: "Shared state must have one source of truth, and that source is the Forguncy page, not a cell-mounted store.",
  },
  {
    id: "business-data-source",
    owner: "forguncy",
    label: "Business data sources",
    rationale: "Business data is owned by Forguncy DataSources so that permissions and server-side rules stay authoritative.",
  },
  {
    id: "server-commands",
    owner: "forguncy",
    label: "Server commands and business workflows",
    rationale: "Server commands encapsulate business rules and must stay in the Forguncy command layer.",
  },
  {
    id: "permissions",
    owner: "forguncy",
    label: "Permissions/auth context exposed by the host",
    rationale: "The host already resolved the user's permissions before the page rendered; a cell must consume that context, not recompute it.",
  },
  {
    id: "page-lifecycle",
    owner: "forguncy",
    label: "Page lifecycle",
    rationale: "Cell mounting and disposal are driven by the host page lifecycle.",
  },
  {
    id: "cross-cell-communication",
    owner: "forguncy",
    label: "Cross-cell communication",
    rationale: "Cells are peers in one page; the host owns the channel between them.",
  },
];

const REACT_CELL_CONCERNS: readonly OwnershipConcern[] = [
  {
    id: "cell-ui",
    owner: "react-cell",
    label: "Component-local UI",
    rationale: "Render trees inside one cell are the cell's own business.",
  },
  {
    id: "cell-interaction-state",
    owner: "react-cell",
    label: "Local interaction state",
    rationale: "State that no other cell can observe stays local to the cell.",
  },
  {
    id: "cell-forms",
    owner: "react-cell",
    label: "Forms and client-side validation",
    rationale: "Form UX and pre-submit validation are browser UI concerns; server-side validation stays in Forguncy.",
  },
  {
    id: "cell-visualization",
    owner: "react-cell",
    label: "Charts, maps, Canvas/WebGL/3D",
    rationale: "Rich rendering is exactly the browser capability cells exist to provide.",
  },
  {
    id: "cell-animation",
    owner: "react-cell",
    label: "Drag/drop, animation, virtualization",
    rationale: "Interaction-heavy rendering has no Forguncy equivalent and should not be forced through the host.",
  },
  {
    id: "cell-editors",
    owner: "react-cell",
    label: "Rich text/code/media viewers and editors",
    rationale: "Embedded editors are third-party browser UI mounted inside one cell.",
  },
  {
    id: "cell-local-remote-data",
    owner: "react-cell",
    label: "Cell-local remote data, only when not already owned by a Forguncy DataSource",
    rationale:
      "A cell may fetch data nothing else depends on; the moment it becomes the business-data source of truth it belongs to Forguncy instead.",
  },
];

export const OWNERSHIP_CONCERNS: readonly OwnershipConcern[] = [...FORGUNCY_CONCERNS, ...REACT_CELL_CONCERNS];

const OWNERSHIP_BY_CONCERN: ReadonlyMap<OwnershipConcernId, OwnershipConcern> = new Map(
  OWNERSHIP_CONCERNS.map(concern => [concern.id, concern]),
);

export class OwnershipViolationError extends Error {
  readonly concern: OwnershipConcernId;
  readonly expectedOwner: ApplicationOwner;
  readonly actualOwner: ApplicationOwner;

  constructor(concern: OwnershipConcernId, expectedOwner: ApplicationOwner, actualOwner: ApplicationOwner) {
    super(
      `Ownership violation for "${concern}": it is owned by "${expectedOwner}" but was treated as owned by "${actualOwner}". ${APPLICATION_OWNERSHIP_INVARIANT}`,
    );
    this.name = "OwnershipViolationError";
    this.concern = concern;
    this.expectedOwner = expectedOwner;
    this.actualOwner = actualOwner;
  }
}

export function findOwnershipConcern(concern: OwnershipConcernId): OwnershipConcern | undefined {
  return OWNERSHIP_BY_CONCERN.get(concern);
}

/** The single owner of a concern. Throws for unknown ids so typos cannot pass silently. */
export function ownerOf(concern: OwnershipConcernId): ApplicationOwner {
  const entry = OWNERSHIP_BY_CONCERN.get(concern);
  if (!entry) {
    throw new Error(`Unknown ownership concern "${concern}".`);
  }
  return entry.owner;
}

/** True when the concern belongs to Forguncy and therefore may not be duplicated by a cell. */
export function isApplicationOwned(concern: OwnershipConcernId): boolean {
  return ownerOf(concern) === "forguncy";
}

export function concernsOwnedBy(owner: ApplicationOwner): readonly OwnershipConcernId[] {
  return OWNERSHIP_CONCERNS.filter(concern => concern.owner === owner).map(concern => concern.id);
}

export function assertOwnedBy(concern: OwnershipConcernId, owner: ApplicationOwner): void {
  const actualOwner = ownerOf(concern);
  if (actualOwner !== owner) {
    throw new OwnershipViolationError(concern, actualOwner, owner);
  }
}
