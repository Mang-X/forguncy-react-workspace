/**
 * Scan utilities: ANSI stripping, portability and deterministic walks.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — `PROBE_REPORT_MACHINE_READABILITY`: identical inputs
 * produce identical bytes, and a report must survive being read on another
 * machine (no absolute paths, no ANSI paint).
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareStrings,
  describeBuildFailureLines,
  portableText,
  safePathSegment,
  stripAnsi,
} from "./scan-utils.ts";

describe("compareStrings", () => {
  it("sorts by code units, not locale", () => {
    // localeCompare would order these differently across machines.
    expect(["b", "A", "a", "B"].sort(compareStrings)).toEqual(["A", "B", "a", "b"]);
  });
});

describe("stripAnsi", () => {
  it("removes colour sequences built from code points", () => {
    const esc = String.fromCharCode(0x1b);
    const painted = `${esc}[31merror${esc}[0m`;

    expect(stripAnsi(painted)).toBe("error");
  });

  it("removes a bracket form even when the escape byte was lost", () => {
    expect(stripAnsi("[31merror[0m")).toBe("error");
  });
});

describe("portableText", () => {
  it("strips the project root and normalizes separators", () => {
    const root = join("virtual", "project");

    expect(portableText(`failed at ${root}/src/App.tsx`, root)).toBe("failed at /src/App.tsx");
    expect(portableText("a\\b\\c.ts", root)).toBe("a/b/c.ts");
  });
});

describe("describeBuildFailureLines", () => {
  it("reduces a reported bundler error to a portable line", () => {
    const root = join("virtual", "project");
    const error = {
      errors: [
        {
          message: "Could not resolve ./missing.js",
          loc: { file: join(root, "src", "entry.js"), line: 3, column: 10 },
        },
      ],
    };

    const lines = describeBuildFailureLines(error, root);

    expect(lines).toEqual(["Could not resolve ./missing.js (src/entry.js:3:10)"]);
  });

  it("never returns an empty diagnostics array for a bare Error", () => {
    const lines = describeBuildFailureLines(new Error("boom"), "/virtual/project");

    expect(lines).toEqual(["boom"]);
  });

  it("collapses duplicates and drops empty lines", () => {
    const lines = describeBuildFailureLines(new Error("boom\n\nboom\n"), "/virtual/project");

    expect(lines).toEqual(["boom"]);
  });

  it("produces a diagnostic when the failure has no readable text", () => {
    const lines = describeBuildFailureLines(undefined, "/virtual/project");

    expect(lines).toEqual(["The bundler failed without a readable message."]);
  });
});

describe("safePathSegment", () => {
  it("makes a package name safe as a directory component", () => {
    expect(safePathSegment("@fixture/date-picker")).toBe("_fixture_date-picker");
    expect(safePathSegment("tiny-math")).toBe("tiny-math");
  });
});

