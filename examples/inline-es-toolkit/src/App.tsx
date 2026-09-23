import { chunk, groupBy } from "es-toolkit";

const POINTS = [1, 2, 3, 4, 5, 6, 7];

const ROWS = [
  { player: "ada", team: "blue", points: 3 },
  { player: "lin", team: "red", points: 5 },
  { player: "kim", team: "blue", points: 2 },
  { player: "zoe", team: "red", points: 4 },
];

const EXPECTED_CHUNKS = "[[1,2,3],[4,5,6],[7]]";
const EXPECTED_GROUP_KEYS = "blue,red";
const EXPECTED_GROUP_SIZES = "blue:2,red:2";

function selfCheck(): string {
  const batches = chunk(POINTS, 3);
  const byTeam = groupBy(ROWS, row => row.team);
  const keys = Object.keys(byTeam).sort().join(",");
  const sizes = keys
    .split(",")
    .filter(key => key.length > 0)
    .map(key => `${key}:${byTeam[key]?.length ?? 0}`)
    .join(",");

  const results = [
    `chunk=${JSON.stringify(batches) === EXPECTED_CHUNKS ? "pass" : "fail"}`,
    `groupByKeys=${keys === EXPECTED_GROUP_KEYS ? "pass" : "fail"}`,
    `groupBySizes=${sizes === EXPECTED_GROUP_SIZES ? "pass" : "fail"}`,
  ];
  return results.join(" | ");
}

export function App() {
  const report = selfCheck();
  const verdict = report.includes("fail") ? "fail" : "pass";

  return (
    <section data-inline-es-toolkit="self-check">
      <h1>inline es-toolkit PoC</h1>
      <output>{report}</output>
      <data value={verdict}>{verdict}</data>
    </section>
  );
}
