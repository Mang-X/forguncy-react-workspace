/**
 * The module a project alias points at, for Issue #97's cross-path proof.
 *
 * The marker is the whole point: it is a string that exists *only* in this file, so both engines
 * can be asked "did you resolve the alias to this file" by looking for it — the dev server through
 * its resolver, the compiler through the artifact it emits. A path comparison alone would answer
 * "did both agree on a path"; a content marker answers "did both ship this file's code", which is
 * the claim #97 actually makes.
 */
export const WHICH = "resolved-via-project-alias";
