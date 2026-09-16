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

Do not introduce application routers, a second application-wide state system, authentication frameworks, or a second business-data source of truth inside React cells.

## Workflow

1. Every design/specification is a GitHub Issue.
2. Every implementation plan is represented by an Issue or Epic Issue.
3. Implementation is delivered through a PR that references or closes its Issue.
4. Do not add `specs/` or `plans/` documentation directories.
5. Do not claim Forguncy runtime compatibility without an executed validation path.
