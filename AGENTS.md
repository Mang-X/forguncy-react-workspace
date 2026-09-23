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

Do not introduce application routers, a second application-wide state system, authentication frameworks, or a second business-data source of truth inside React cells.

A rejected dependency is reported either as an **architectural rejection** (the capability belongs to Forguncy, so no replacement package can fix it) or as a **technical bundling failure** (the right role, the wrong artifact). These are different answers and must not be reported as one another. React Router `BrowserRouter` and application-wide duplicate business stores are platform conflicts, not packages to adapt.

Ownership boundaries are role-sensitive: a state library used for one cell's local state is fine, the same library used as the cross-cell business-state source of truth is a platform conflict.

## Local development

`vp run dev` in a Cell project mounts one Cell's authored source as ordinary React, with the
project's `fixture` installed as a mock provider. It is the fast loop: edit, see, no sync.

It is **not** a Forguncy emulator, and its output is `local` evidence only. In particular a
green local render says nothing about: whether the designer accepts the source (it refuses
`import`/`export` declarations outright, which is what authored source is made of), page
lifecycle, routing, permissions, extension load order, cross-Cell isolation, or the generated
host bridge — the harness resolves the *published* packages and never runs the bridge.

Where the loop is *more* permissive than the page it is recorded rather than smoothed over:
locally `react-dom/client` is the whole published module, while the page narrows it to the
members the runtime contract observed. So a local pass must never be reported as a stronger
result than it is.

Run `runtime`'s `formatLocalDevValidationDistinction()` to print what is still owed to a real
page, instead of enumerating it from memory.

## Workflow

1. Every design/specification is a GitHub Issue.
2. Every implementation plan is represented by an Issue or Epic Issue.
3. Implementation is delivered through a PR that references or closes its Issue.
4. A Spec that decides ownership or dependency strategy must name the architecture Spec Issue that governs it.
5. Do not add `specs/` or `plans/` documentation directories.
6. Do not claim Forguncy runtime compatibility without an executed validation path.
7. State local checks separately from real Forguncy runtime validation; a green local build is not runtime compatibility.

