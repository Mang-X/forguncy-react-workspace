/**
 * The `build` step's scratch entry: unique per (package, specifier) so two
 * concurrent probes of one package cannot overwrite each other's synthetic entry.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 */

import { basename, dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { probeEntryPath } from "./build";

describe("probeEntryPath", () => {
  it("keys the entry path by package name and specifier hash, not package name alone", () => {
    const root = "/proj";
    const a = probeEntryPath(root, "pkg", "pkg/feature-a");
    const b = probeEntryPath(root, "pkg", "pkg/feature-b");

    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(dirname(b));
    expect(basename(a)).toMatch(/^[0-9a-f]{16}\.js$/);
    expect(basename(b)).toMatch(/^[0-9a-f]{16}\.js$/);
  });

  it("is stable for the same inputs", () => {
    const first = probeEntryPath("/proj", "tiny-math", "tiny-math");
    const second = probeEntryPath("/proj", "tiny-math", "tiny-math");

    expect(first).toBe(second);
  });

  it("sanitizes package names that are unsafe as directory segments", () => {
    const path = probeEntryPath("/proj", "@scope/pkg", "@scope/pkg");

    expect(path).toContain("_scope_pkg");
    expect(path.split(/[/\\]/).some(segment => segment.includes(".."))).toBe(false);
  });
});
