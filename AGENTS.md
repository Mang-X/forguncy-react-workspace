# Agent rules

This repository is managed Issue-first and PR-first.

## Architecture

**Forguncy owns the application. React owns the island.**

Forguncy owns application routing, page/global state, data sources, server commands, permissions, page lifecycle, and cross-cell communication.

React cells own component-local UI, local interaction state, forms, visualization, animation, drag-and-drop, charts, maps, 3D, editors, and other browser UI concerns.

## Dependency strategies

Every non-workspace dependency used by generated cell code must resolve to one of:

- `host`: provided by the ReactCellType host, e.g. React or built-in globals.
- `inline`: bundled into the generated cell artifact; this is the default for compatible browser-first libraries.
- `extension`: provided by a Forguncy frontend extension when shared module identity, cross-cell singleton semantics, or deliberate reuse is required.
- `replace`: the selected package is unsuitable; prefer a modern browser-first/ESM alternative instead of building a permanent adapter.

**Local workspace packages are source, not runtime modules.** A cell may import a shared workspace package such as `@app/ui` by name; the compiler flattens that source into each consuming cell artifact like any other source file. Development-stage source sharing does not imply deployed module sharing. Two cells importing the same package each carry their own copy, a React Context declared there is local to each cell, and module-scope state is per cell. Cross-cell state has to be delegated to a module the page or an extension provides, and workspace packages never receive a dependency decision and never appear in `frontendLibraries`.

The workspace graph is read from the project's own `pnpm-workspace.yaml` and each member's `package.json` (`loadPnpmWorkspaceGraph` in `packages/cell-compiler/src/workspace-graph.ts`), never hand-written. A `package.json` dependency key is a *name*, so it becomes a graph edge by name: whether that name is local source or a published package is then the graph's answer, and what a published one resolves to is still `fgc.lock.json`'s. Reading a manifest decides nothing — a dependency being declared as `workspace:*` says it is local, not that it is `inline`.

Pass that graph to `compileCell` as `options.workspace` and the compile reports the workspace-source audit beside the artifact. The graph audits, it never resolves: modules still resolve through the bundler and `node_modules`, and supplying the graph changes no artifact byte. A circular workspace dependency is the one workspace finding that rejects a compile, because it is the only one with no artifact-side counterpart — the others ("a workspace import survived", "a workspace package reached `frontendLibraries`") are already rejected from the output side and are reported rather than restated.

Do not introduce application routers, a second application-wide state system, authentication frameworks, or a second business-data source of truth inside React cells.

A rejected dependency is reported either as an **architectural rejection** (the capability belongs to Forguncy, so no replacement package can fix it) or as a **technical bundling failure** (the right role, the wrong artifact). These are different answers and must not be reported as one another. React Router `BrowserRouter` and application-wide duplicate business stores are platform conflicts, not packages to adapt.

Ownership boundaries are role-sensitive: a state library used for one cell's local state is fine, the same library used as the cross-cell business-state source of truth is a platform conflict.

## Local development

`vp dev` — the bare command, no flags — in a Cell project mounts one Cell's authored source as
ordinary React, with the project's `fixture` installed as a mock provider. It is the fast loop:
edit, see, no sync.

That it needs no flag is a property of this repository's *source*, not of the harness: every
relative import in `packages/**` and `examples/**` names its file with a `.ts`/`.tsx` extension,
so Node's ESM loader can resolve a `vite.config.ts` that imports workspace TypeScript after
Vite's default config bundler externalizes it. Write relative imports with the extension, and do
not remove `allowImportingTsExtensions` from the root `tsconfig.json` — a single extensionless
import among them breaks bare `vp dev` before Vite starts. A project with extensionless workspace
imports will not get bare `vp dev` for free; the rest of the reasoning is in
`examples/dev-harness/package.json` under `//scripts`.

Three checks in `dev-harness` hold that up, at three different scopes — do not delete one
because another looks like it covers the case:

| test | what it fails on |
| --- | --- |
| `vp-dev-command.test.ts` | the `vp dev` **command** no longer serving the harness (spawns it, expects the plugin's mount node and entry) |
| `bare-vp-dev.test.ts` | Vite's default **loader** no longer resolving the example's config graph, which is the mechanism the convention exists for |
| `relative-import-extension.test.ts` | any **extensionless relative import anywhere** under `packages/**` or `examples/**`, including `.tsx` |

It is **not** a Forguncy emulator, and its output is `local` evidence only. In particular a
green local render says nothing about: whether the designer accepts the source (it refuses
`import`/`export` declarations outright, which is what authored source is made of), page
lifecycle, routing, permissions, extension load order, cross-Cell isolation, or the generated
host bridge — the harness resolves the *published* packages and never runs the bridge.

An `extension` dependency has no local equivalent the harness could infer, because the reason a
package is an `extension` is that its module identity or cross-cell singleton semantics matter — so
the project declares one of two branches per package (`extensionChoices` in `devHarness`'s options):
a substitute with its justification, or a `real-runtime-only` acknowledgement with a reason *and* a
consequence. Both branches are **enforced**, not merely recorded: a substitute resolves the id to the
named package or shim file, and `real-runtime-only` resolves it to a module that throws, so the
dependency is never exercised by an npm copy the project said it could not validate. A declaration
that cannot be honoured — a shim that is not there, a package that is not installed — throws for the
same reason: resolving somewhere else is worse than failing, because the Cell renders and the
developer concludes the substitute ran.

`vp dev` audits the same declaration at server start and **refuses to start** on an undeclared one.
Both branches, the finding, and whether it blocks belong to the runtime package
(`LOCAL_DEV_DIAGNOSTIC_RULES`); `dev-harness` reads `blocksLocalDevelopment` off that table rather
than keeping a list of its own, so a rule the contract marks blocking cannot be downgraded here by
omission. Matching is exact, not a prefix, so a subpath the extension does not provide is not
answered locally — the same rule the compiler's extension table applies.

Where the loop is *more* permissive than the page it is recorded rather than smoothed over:
locally `react-dom/client` is the whole published module, while the page narrows it to the
members the runtime contract observed. So a local pass must never be reported as a stronger
result than it is.

Run the runtime package's `formatLocalDevValidationDistinction()` to print what is still owed to
a real page, instead of enumerating it from memory. The harness prints it at server start for the
same reason — a green local render is when a reader is most likely to mistake local for
compatible.

## Workflow

1. Every design/specification is a GitHub Issue.
2. Every implementation plan is represented by an Issue or Epic Issue.
3. Implementation is delivered through a PR that references or closes its Issue.
4. A Spec that decides ownership or dependency strategy must name the architecture Spec Issue that governs it.
5. Do not add `specs/` or `plans/` documentation directories.
6. Do not claim Forguncy runtime compatibility without an executed validation path.
7. State local checks separately from real Forguncy runtime validation; a green local build is not runtime compatibility.

