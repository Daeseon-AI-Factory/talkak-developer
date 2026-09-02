/**
 * `path:line[:column]` references in text — the shape compilers, test runners and agents print.
 *
 * Pure: the matcher knows nothing about the filesystem. It accepts POSIX paths (`src/a.ts:12`,
 * `./x.rs:3:4`, `/abs/f.py:9`, `~/p/f.go:1`) and the Windows shapes those same tools print there
 * (`C:\proj\a.ts:12`, `C:/proj/a.ts:12`, `.\src\x.ts:12`, `src\foo.ts:42`), plus the `file(line,col)`
 * form tsc uses. URLs never match: inside `http://host:3000/a/b.ts:1` every candidate start is
 * preceded by `/` or `:`, which are not boundaries.
 */

export interface SourceLocation {
  path: string;
  line: number;
  column?: number;
}

export interface SourceLocationMatch {
  location: SourceLocation;
  /** The span of the reference as it appears in the text, 0-based, end exclusive. */
  start: number;
  end: number;
  /** The reference exactly as written. */
  text: string;
}

// Group 1: the boundary before the path. Group 2: the path — a prefix that proves it is a path
// (drive letter, ./ ../ / ~/ or a segment followed by a separator), then a lazy body that stops at
// whitespace, quotes, brackets and colons. Group 3/4: `:line[:column]`. Group 5/6: `(line,col)`.
const SOURCE_REF_PATTERN =
  /(^|[\s([{<"'`])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z0-9_.@-]+[\\/])[^\s"'`<>:()]*?)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))(?=$|[\s)\]},.;:'"`])/g;

const MAX_SOURCE_LINE = 1_000_000;
const MAX_SOURCE_COLUMN = 100_000;
const EXTENSIONLESS_SOURCE_FILENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Justfile",
  "Brewfile",
  "CMakeLists",
]);

/** Whether a matched span is a file path rather than a URL, a time, or a bare word. */
export function isLikelySourcePath(path: string): boolean {
  if (!path || path.includes("://") || path.includes("\0")) return false;
  // Protocol-relative URLs and UNC shares: neither is a file this app opens.
  if (path.startsWith("//") || path.startsWith("\\\\")) return false;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.includes("/")) return false;
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!filename || filename === "." || filename === "..") return false;
  if (EXTENSIONLESS_SOURCE_FILENAMES.has(filename)) return true;
  return filename.includes(".");
}

function isValidSourcePosition(line: number, column?: number): boolean {
  if (!Number.isInteger(line) || line <= 0 || line > MAX_SOURCE_LINE) return false;
  if (column === undefined) return true;
  return Number.isInteger(column) && column > 0 && column <= MAX_SOURCE_COLUMN;
}

export function sourceLocationLabel(location: SourceLocation): string {
  return location.column
    ? `${location.path}:${location.line}:${location.column}`
    : `${location.path}:${location.line}`;
}

export function extractSourceLocationMatches(
  text: string | null | undefined,
): SourceLocationMatch[] {
  if (!text) return [];
  const matches: SourceLocationMatch[] = [];
  for (const match of text.matchAll(SOURCE_REF_PATTERN)) {
    const prefix = match[1] ?? "";
    const path = match[2] ?? "";
    const line = Number.parseInt(match[3] ?? match[5] ?? "", 10);
    const columnText = match[4] ?? match[6];
    const column = columnText ? Number.parseInt(columnText, 10) : undefined;
    if (!isLikelySourcePath(path) || !isValidSourcePosition(line, column)) continue;
    const start = (match.index ?? 0) + prefix.length;
    const reference = match[0].slice(prefix.length);
    matches.push({
      location: column ? { path, line, column } : { path, line },
      start,
      end: start + reference.length,
      text: reference,
    });
  }
  return matches;
}

/** Every distinct location across the given texts, first occurrence first. */
export function extractSourceLocations(
  ...texts: Array<string | null | undefined>
): SourceLocation[] {
  const seen = new Set<string>();
  const locations: SourceLocation[] = [];
  for (const text of texts) {
    for (const { location } of extractSourceLocationMatches(text)) {
      const key = sourceLocationLabel(location);
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(location);
    }
  }
  return locations;
}

export function hasSourceLocation(text: string | null | undefined): boolean {
  return extractSourceLocationMatches(text).length > 0;
}

/** The location when the whole (trimmed) text is exactly one reference, else null. */
export function extractExactSourceLocation(text: string | null | undefined): SourceLocation | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const matches = extractSourceLocationMatches(trimmed);
  if (matches.length !== 1) return null;
  const [match] = matches;
  return match.start === 0 && match.end === trimmed.length ? match.location : null;
}
