import type { Report } from "../model.js";

/**
 * Serializes a report deterministically.
 *
 * Keys are emitted in a fixed order rather than insertion order, so two runs of the same
 * input produce byte-identical bytes regardless of how the object was assembled. A
 * trailing newline makes the output a well-formed text file.
 */
export function renderJson(report: Report): string {
  return `${JSON.stringify(report, orderedKeys, 2)}\n`;
}

const KEY_ORDER: readonly string[] = [
  "schemaVersion",
  "run",
  "status",
  "analysisMode",
  "reasons",
  "warnings",
  "counts",
  "seeds",
  "usages",
  "valueReferences",
  "gaps",
  "repoWideGaps",
  "refs",
  "base",
  "head",
  "baseSha",
  "headSha",
  "mergeBaseSha",
  "analysisTypeScriptVersion",
  "coverage",
  "kind",
  "messages",
  "files",
  "paths",
  "packages",
];

function orderedKeys(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(
    ([left], [right]) => rank(left) - rank(right) || (left < right ? -1 : 1),
  );
  return Object.fromEntries(entries);
}

function rank(key: string): number {
  const index = KEY_ORDER.indexOf(key);
  // Unknown keys sort after known ones, alphabetically among themselves, so adding a
  // field cannot reorder the fields already published.
  return index === -1 ? KEY_ORDER.length : index;
}
