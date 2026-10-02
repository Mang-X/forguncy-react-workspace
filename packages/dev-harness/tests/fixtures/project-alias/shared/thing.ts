/**
 * The module the project alias in this fixture points at.
 *
 * The marker exists only here, so a test can ask "did the dev server resolve the alias to this
 * file" by looking for it rather than by comparing paths — the same technique
 * `cell-compiler`'s cross-path fixture uses, so the two halves of #97 are asserted the same way.
 */
export const WHICH = "resolved-via-project-alias";
