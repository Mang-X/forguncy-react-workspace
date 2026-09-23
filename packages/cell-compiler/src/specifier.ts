/**
 * The specifier and decision-lookup primitives two layers have to agree on.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6), whose artifact
 * boundary is the first consumer, and #14 — "Spec: local workspace packages are
 * source dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14), whose workspace
 * contract is the second. Both are downstream of #4 "application ownership
 * boundaries and dependency strategy semantics"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/4).
 *
 * ## Why these four functions are here rather than in `artifact.ts`
 *
 * They were in `artifact.ts`, and the workspace contract imported them from there
 * because restating them would be two answers to one question — which is exactly
 * the drift #9's fourth review round found in `findDecision`. That import worked
 * while the dependency ran one way. It stopped working when the boundary had to
 * *consume* the workspace audit: `artifact.ts` would then import
 * `workspace-source.ts`, which imports `artifact.ts`, and the two modules would
 * form a cycle.
 *
 * A cycle is survivable in ESM when the members are function declarations, and it
 * was verified to be — but "survivable" is not the standard for a boundary that
 * decides whether a module id is a file or a package. What a cycle *does* guarantee
 * is that one module's initialization order depends on which module is entered
 * first, so a constant one of them reads at load time could be `undefined` in one
 * entry order and defined in the other. None of these four reads another module's
 * constant today, which is the only reason the cycle would be invisible; the
 * extraction makes that property structural rather than coincidental.
 *
 * So the shared half became a leaf: it imports nothing but types from `core`, and
 * both layers import it. `artifact.ts` re-exports all four, so its public surface
 * and every existing caller are unchanged, and there is still exactly one
 * implementation of each rule.
 *
 * ## What belongs here, and what does not
 *
 * The test is "would the workspace contract and the artifact contract have to give
 * the same answer to this question". A specifier's package name and whether it is
 * a file, and which decisions govern it, all pass. Assembly, audits, the banner,
 * the wrapper and the entry shape are the artifact boundary's alone and stay there
 * — a leaf that collected them would be the same module it was extracted from.
 */

import type { DependencyDecision } from "@forguncy-react-workspace/core";

/**
 * The package a bare or scoped specifier resolves to, so decisions can be matched by package.
 *
 * A path is returned unchanged, which is what makes it safe to call on a specifier
 * that has not been classified yet: there is no package to fold out of `./Button`,
 * and inventing one would let a decision match a file.
 */
export function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return specifier;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? specifier;
}

/**
 * True when a specifier names a file rather than a module id.
 *
 * Exported because two layers have to give the same answer: the artifact boundary
 * decides between "a leftover import" and "an unresolved decision" with it, and the
 * workspace contract (#14) decides between "workspace source" and "a published
 * dependency" with the same test. Restating it in the second place would be two
 * answers to one question, which is the shape #9's fourth review round found in
 * `findDecision` — and the reason both layers now import this one function.
 *
 * Exact for relative and absolute paths, which is the whole claim: a *named*
 * workspace package (`@scope/ui`) is indistinguishable here from a published one,
 * because this test has no workspace manifest — #14's contract asks that question
 * with `workspacePackageFor` instead, which is what holding a manifest buys. A
 * specifier the bundler resolves through an alias (`#internal`, a `resolve.alias`
 * target) is outside this test in either direction: it is not a path, so both
 * layers treat it as a module id, which is why a graph that carries one has to
 * carry the id the bundler actually resolves rather than the alias.
 */
export function isSourceSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * Every decision at the level that governs a specifier: the exact records, else the
 * package's.
 *
 * The whole point of returning a list rather than one record: a lock can hold more
 * than one record for one module, and a caller that needs to know whether there is a
 * *single* provider has to be able to see the conflict instead of being handed
 * whichever record came first. The artifact audit already refuses such a list as
 * `unresolved-dependency-decision`; this is how a downstream audit — including #14's
 * workspace delegation check — asks the same question without restating the precedence.
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
