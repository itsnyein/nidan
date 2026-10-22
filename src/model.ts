import type { AnalysisMode } from "./project/config.js";
import type { RunReason, RunStatus, RunWarning } from "./project/run.js";

/**
 * Version of the JSON report shape.
 *
 * Versioned independently of the package version: a schema change and a release are not
 * the same event and neither implies the other. It stays at `0` until T5.2 freezes the
 * schema, so nothing can mistake the current shape for a stable contract.
 */
export const SCHEMA_VERSION = 0;

/**
 * Categories nidan does not analyze, by design. Included in every report so a reader
 * always has the bounds of the result in front of them, rather than having to remember
 * them.
 */
export const COVERAGE_STATEMENT: readonly string[] = [
  "Runtime reflection",
  "Framework conventions",
  "Dependency injection, events, and context",
  "Configuration and environment-driven wiring",
  "Network, API, and database boundaries",
  "Transitive impact",
  "Impact of type-only changes",
  "Historical dependency accuracy is not guaranteed",
];

export interface ComparedRefs {
  /** The ref as the user spelled it. */
  readonly base: string;
  readonly head: string;
  /**
   * The commits actually compared. `baseSha` is the merge base, not the base ref's own
   * commit, so a report shows what head changed rather than what base moved on to.
   */
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
}

export interface RunCounts {
  readonly seeds: number;
  readonly usages: number;
  readonly valueReferences: number;
  readonly gaps: number;
  readonly repoWideGaps: number;
}

export interface RunReport {
  readonly status: RunStatus;
  readonly analysisMode: AnalysisMode;
  readonly reasons: readonly RunReason[];
  readonly warnings: readonly RunWarning[];
  readonly counts: RunCounts;
  readonly refs: ComparedRefs;
  /** The TypeScript the analysis ran on, which is the one ts-morph bundles. */
  readonly analysisTypeScriptVersion: string;
}

export interface Report {
  readonly schemaVersion: number;
  readonly run: RunReport;
  readonly coverage: readonly string[];
  /** Empty until M2 implements seed mapping. */
  readonly seeds: readonly never[];
  /** Empty until M4 implements gap reporting. */
  readonly repoWideGaps: readonly never[];
}
