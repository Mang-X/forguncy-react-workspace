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

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareStrings,
  describeBuildFailureLines,
  portableText,
  relativePortablePath,
  safePathSegment,
  stripAnsi,
  walkPackageSourceFiles,
} from "./scan-utils";

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

describe("walkPackageSourceFiles", () => {
  it("returns source files in sorted order, skipping node_modules and hidden dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-scan-utils-"));
    const paths = [
      "index.js",
      "lib/b.js",
      "lib/a.js",
      "types.d.ts",
      "node_modules/dep/index.js",
      ".git/config",
      "styles.css",
    ];
    for (const relative of paths) {
      const absolute = join(root, ...relative.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, "// x\n", "utf8");
    }

    const found = await walkPackageSourceFiles(root);
    const relatives = found.map(absolute => absolute.slice(root.length + 1).split("\\").join("/"));

    expect(relatives).toEqual(["index.js", "lib/a.js", "lib/b.js"]);
  });
});

describe("relativePortablePath", () => {
  it("returns a path relative to the base with forward slashes", () => {
    expect(relativePortablePath(join("a", "b"), join("a", "b", "c", "d.js"))).toBe("c/d.js");
  });

  it("falls back to the basename when the file escaped the base", () => {
    expect(relativePortablePath(join("a", "b"), join("x", "y", "d.js"))).toBe("d.js");
  });
});

describe("safePathSegment", () => {
  it("makes a package name safe as a directory component", () => {
    expect(safePathSegment("@fixture/date-picker")).toBe("_fixture_date-picker");
    expect(safePathSegment("tiny-math")).toBe("tiny-math");
  });
});
