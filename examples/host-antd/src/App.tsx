import React, { createContext, useContext, useState } from "react";
import { Button, Card } from "antd";

const HostVersion = createContext("context-unavailable");

const ROWS = [
  { key: "row-alpha", label: "alpha" },
  { key: "row-beta", label: "beta" },
  { key: "row-gamma", label: "gamma" },
];

const EXPECTED_KEYS = "row-alpha,row-beta,row-gamma";

/**
 * The example's own deterministic self-check — the oracle `host-antd-poc.test.ts`
 * asserts against.
 *
 * Each check is computed from values the artifact can only have if the host
 * bridge did its job:
 * - `identity`: the imported React must be the page's `globalThis.React`. A
 *   bundled second React would be a different object and answer `fail`.
 * - `antd`: the imported `Button` must be the page's `globalThis.antd.Button`,
 *   with a presence guard so an absent global cannot pass by comparing
 *   `undefined` to itself.
 * - `useState` / `useContext`: hooks only run when the renderer executing this
 *   cell and the React the cell imports are the same identity — a second React
 *   copy fails with an invalid-hook-call, not with `fail` text, so reaching this
 *   line at all is half the proof; the comparison is the other half.
 */
function selfCheck(version: string, initial: number): string {
  const page = globalThis as typeof globalThis & { React?: unknown; antd?: { Button?: unknown } };
  const results = [
    `identity=${React === page.React ? "pass" : "fail"}`,
    `antd=${Button !== undefined && Button === page.antd?.Button ? "pass" : "fail"}`,
    `useState=${initial === 1 ? "pass" : "fail"}`,
    `useContext=${version === React.version ? "pass" : "fail"}`,
    `keys=${ROWS.map(row => row.key).join(",") === EXPECTED_KEYS ? "pass" : "fail"}`,
  ];
  return results.join(" | ");
}

function Report({ initial }: { readonly initial: number }) {
  const version = useContext(HostVersion);
  const report = selfCheck(version, initial);
  const verdict = report.includes("fail") ? "fail" : "pass";

  return (
    <Card title="host antd PoC">
      <section data-host-antd="self-check">
        <h1>host antd PoC</h1>
        <output>{report}</output>
        <data value={verdict}>{verdict}</data>
        <Button type="primary">self-check</Button>
        <ul>
          {ROWS.map(row => (
            <li key={row.key}>{row.label}</li>
          ))}
        </ul>
        <footer>
          <small>{version}</small>
        </footer>
      </section>
    </Card>
  );
}

export function App() {
  const [initial] = useState(1);
  return (
    <HostVersion.Provider value={React.version}>
      <Report initial={initial} />
    </HostVersion.Provider>
  );
}
