/**
 * A Cell whose entry exposes no component, for the build entry's strict/lenient split.
 *
 * `export const helper` and no `default`/`App` export: the compiler refuses the artifact as
 * `rejected-cell-entry-shape`, which is the failure #5's entry contract exists to catch. It is here
 * rather than in the alias fixture because that project's tests assert its exact Cell set.
 */
export const helper = "not a component";
