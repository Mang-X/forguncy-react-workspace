/**
 * The shape of what the dev server mounts.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * ## Why these types live in their own module
 *
 * The harness has a node half (the Vite plugin: it reads the project, resolves host
 * substitutions and generates the mount module) and a browser half (`mount.ts`, which
 * imports `react-dom/client`). Both have to agree on the contract between them, and that
 * contract is *data*: the browser half must never import the node half, because doing so
 * would pull `node:module` into the page's graph — the defect `core/browser` exists to fix,
 * reintroduced one layer up.
 *
 * So the seam is described here, in a module with no imports at all. The node half generates
 * a module satisfying {@link DevHarnessMountableCell}; the browser half consumes it. Neither
 * can reach the other, so nothing about the seam can drift.
 *
 * ## The contract is a *Cell*, not an entry path
 *
 * `Cell` is the resolved component and `fixture` is the fixture module's default export as a
 * *value*. That is deliberate, and it is why this harness is not a second compiler:
 * `virtual:forguncy/cell/<id>` (#28) already answers "which source entry is this Cell, is it
 * exported as the platform expects, and does it declare a fixture" — including refusing an
 * entry that exposes no component, naming the exports it does have. Re-deriving any of that
 * here would be a second answer to one question, and the two would eventually disagree about
 * which file a Cell is.
 */

/**
 * What `virtual:forguncy/cell/<id>` must export for the harness to mount it.
 *
 * A structural description of #28's generated module rather than a copy of it: that module is
 * generated source the dev server evaluates, so it satisfies this shape by construction, and
 * a test asserts the generated module really does. Keeping it as the harness's *requirement*
 * — rather than importing the generator's return type — is also what lets a test supply a
 * hand-built Cell without standing up a project.
 */
export interface DevHarnessMountableCell {
  /** Logical Cell id from the registry, so the fixture context can name it. */
  readonly cellId: string;
  /** The resolved component: the entry's default export, else its `App` export. */
  readonly Cell: unknown;
  /**
   * The Cell's fixture default export, or `undefined` when it declares no `fixturePath`.
   *
   * `undefined` is passed through to `runtime`'s contract rather than interpreted, which is
   * #28's rule: with a `fixturePath` declared, `undefined` means the fixture module failed to
   * default-export and must fail as `fixture-absent`; with none declared, it means the Cell
   * declares no fixture. The harness tells the two apart by whether
   * {@link DevHarnessMountTarget.fixturePath} is present.
   */
  readonly fixture: unknown;
}

/** Where and how the harness mounts a Cell. */
export interface DevHarnessMountTarget {
  /** The element the Cell's React root is created against. */
  readonly element: Element;
  /**
   * The absolute fixture path the registry resolved, when the Cell declares one.
   *
   * Absent means the Cell declares no fixture, which is a different statement from "the
   * fixture is `undefined`" — see {@link DevHarnessMountableCell.fixture}.
   */
  readonly fixturePath?: string;
  /**
   * Value props to merge over the fixture's `cellProps`, when the harness was given any.
   *
   * A shallow merge *into the mock's options*, so the overlay goes through the same
   * validation as the fixture's own values: a key #5 never verified is refused by
   * `mock-provider` there, rather than being handed to the Cell here. That is the whole point
   * of routing it through the provider instead of passing a second props object to
   * `createElement` — a Cell must not be able to observe a difference between the props it is
   * handed and the host surface it reaches through the façade.
   */
  readonly propsOverlay?: Readonly<Record<string, unknown>>;
}
