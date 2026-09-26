/**
 * The walkthrough Cell's authored source.
 *
 * It imports `es-toolkit` by name and uses enough of the package that the composed Cell is
 * over the `capped` Cell's declared ceiling — the measurement the oversize recipe in
 * `SKILL.md` is *about*. The attribution rule in `scripts/select_dependency.mjs` refuses a
 * rejection for a package the Cell does not actually carry, so an entry that merely rendered
 * its own markup would make every oversize rejection unattributable: correct behaviour, but
 * not the path this fixture exists to exercise.
 *
 * Written as an ordinary ESM import — no Forguncy extension, no `frontendLibraries`
 * reference — which is what makes it an `inline` decision rather than an `extension` one.
 *
 * The bodies are type-correct rather than illustrative: this repository's root `tsconfig.json`
 * includes `examples/**`, so a fixture that only *compiles* would still add type errors to the
 * one file in the repository that is both an example and part of the Skill's own evidence.
 * (The `react/jsx-runtime` diagnostic every example carries is the pre-existing gap that
 * project records; it is not introduced here.)
 */
import { chunk, debounce, groupBy, orderBy, uniqBy, zip } from "es-toolkit";

interface Row {
  readonly player: string;
  readonly team: string;
  readonly points: number;
}

const ROWS: readonly Row[] = [
  { player: "ada", team: "blue", points: 3 },
  { player: "lin", team: "red", points: 5 },
  { player: "kim", team: "blue", points: 2 },
  { player: "zoe", team: "red", points: 4 },
];

const TEAMS = uniqBy(ROWS, row => row.team).map(row => row.team);
const BY_TEAM = groupBy(ROWS, row => row.team);
const RANKED = orderBy(ROWS, [row => row.points], ["desc"]);
const PAIRS = zip(TEAMS, chunk(TEAMS, 2));
// Called for its side effect rather than its return value: `debounce` is typed
// `(...args) => void` (`DebouncedFunction`), so rendering `later()` would be a type error in a
// file the root `tsconfig.json` type-checks. The import is what puts the module in the bundle.
const announce = debounce((rows: readonly Row[]) => rows.length, 10);

export default function App() {
  announce(RANKED);
  return (
    <ul>
      {RANKED.map(row => (
        <li key={row.player}>
          {row.player}: {String(BY_TEAM[row.team]?.length ?? 0)} rows, {String(PAIRS.length)} pairs
        </li>
      ))}
    </ul>
  );
}
