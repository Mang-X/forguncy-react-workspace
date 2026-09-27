/**
 * A Cell entry for the member-project fixture: a project that sits *inside* a workspace rather
 * than being one.
 *
 * No alias and no import, deliberately: this fixture's subject is which `pnpm-workspace.yaml` the
 * build finds, so the Cell itself is the minimum that compiles. The alias assertions live in
 * `alias-project`, where they cannot be confused with what is under test here.
 */
export function App() {
  return "member-project-cell";
}
