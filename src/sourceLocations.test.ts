import { describe, expect, it } from "vitest";
import {
  extractExactSourceLocation,
  extractSourceLocationMatches,
  extractSourceLocations,
  hasSourceLocation,
  isLikelySourcePath,
  sourceLocationLabel,
} from "./sourceLocations";

describe("source location extraction", () => {
  it("extracts POSIX references with and without a column", () => {
    expect(
      extractSourceLocations("Check src/components/App.tsx:404 and src-tauri/src/lib.rs:321:9."),
    ).toEqual([
      { path: "src/components/App.tsx", line: 404 },
      { path: "src-tauri/src/lib.rs", line: 321, column: 9 },
    ]);
  });

  it("extracts the Windows shapes the same tools print there", () => {
    expect(
      extractSourceLocations(
        String.raw`At C:\proj\script.ps1:12 char:5; C:/proj/src/a.ts:12:3; .\src\x.ts:7; src\foo.ts:42; ..\lib\y.rs:9`,
      ),
    ).toEqual([
      { path: String.raw`C:\proj\script.ps1`, line: 12 },
      { path: "C:/proj/src/a.ts", line: 12, column: 3 },
      { path: String.raw`.\src\x.ts`, line: 7 },
      { path: String.raw`src\foo.ts`, line: 42 },
      { path: String.raw`..\lib\y.rs`, line: 9 },
    ]);
  });

  it("reads tsc's file(line,col) form", () => {
    expect(extractSourceLocationMatches("src/a.ts(12,5): error TS2322")).toEqual([
      {
        location: { path: "src/a.ts", line: 12, column: 5 },
        start: 0,
        end: 14,
        text: "src/a.ts(12,5)",
      },
    ]);
  });

  it("accepts a reference followed by a colon, as gcc, clang and eslint print them", () => {
    expect(extractSourceLocations("src/main.c:10:5: error: expected ';'")).toEqual([
      { path: "src/main.c", line: 10, column: 5 },
    ]);
  });

  it("returns link ranges and skips urls", () => {
    const line = "see src/terminalLinks.ts:294 and http://localhost:3000/src/App.tsx:12";
    expect(extractSourceLocationMatches(line)).toEqual([
      {
        location: { path: "src/terminalLinks.ts", line: 294 },
        start: 4,
        end: 28,
        text: "src/terminalLinks.ts:294",
      },
    ]);
  });

  it("handles wrapping punctuation without including it in the range", () => {
    const line = "(src/App.tsx:1346), then ./src/viz/LogPanel.tsx:89:7;";
    expect(extractSourceLocationMatches(line)).toEqual([
      {
        location: { path: "src/App.tsx", line: 1346 },
        start: 1,
        end: 17,
        text: "src/App.tsx:1346",
      },
      {
        location: { path: "./src/viz/LogPanel.tsx", line: 89, column: 7 },
        start: 25,
        end: 52,
        text: "./src/viz/LogPanel.tsx:89:7",
      },
    ]);
  });

  it("does not link times, bare words, directories or extensionless binaries", () => {
    expect(hasSourceLocation("12:30:45 build started")).toBe(false);
    expect(hasSourceLocation("npm:build")).toBe(false);
    expect(hasSourceLocation("node_modules/.bin/vite:1")).toBe(false);
    expect(hasSourceLocation("/opt/homebrew/bin/tmux")).toBe(false);
    expect(hasSourceLocation("https://example.com/apps/desktop/src/App.tsx:1346")).toBe(false);
  });

  it("links extensionless build files by name", () => {
    expect(extractSourceLocations("docker/Dockerfile:3 and ./Makefile:12")).toEqual([
      { path: "docker/Dockerfile", line: 3 },
      { path: "./Makefile", line: 12 },
    ]);
  });

  it("rejects UNC shares and protocol-relative paths", () => {
    expect(isLikelySourcePath(String.raw`\\server\share\a.ts`)).toBe(false);
    expect(isLikelySourcePath("//cdn.example.com/a.js")).toBe(false);
    expect(isLikelySourcePath(String.raw`C:\a\b.ts`)).toBe(true);
  });

  it("deduplicates repeated references and labels them", () => {
    const locations = extractSourceLocations("src/a.ts:1", "again src/a.ts:1 and src/a.ts:1:2");
    expect(locations.map(sourceLocationLabel)).toEqual(["src/a.ts:1", "src/a.ts:1:2"]);
  });

  it("recognises an exact reference and nothing looser", () => {
    expect(extractExactSourceLocation("  src/a.ts:12  ")).toEqual({ path: "src/a.ts", line: 12 });
    expect(extractExactSourceLocation("see src/a.ts:12")).toBeNull();
    expect(extractExactSourceLocation("pnpm test")).toBeNull();
  });

  it("refuses absurd positions", () => {
    expect(hasSourceLocation("src/a.ts:0")).toBe(false);
    expect(hasSourceLocation("src/a.ts:12:0")).toBe(false);
    expect(hasSourceLocation("src/a.ts:99999999")).toBe(false);
  });
});
