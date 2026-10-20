import { ts } from "ts-morph";

import {
  findMergeBase,
  findRepositoryRoot,
  resolveCommit,
} from "./git/refs.js";
import { COVERAGE_STATEMENT, SCHEMA_VERSION, type Report } from "./model.js";
import { toPosixPath } from "./project/paths.js";
import { loadSnapshotPair } from "./project/program.js";

export type OutputFormat = "text" | "json";

export interface AnalyzeOptions {
  readonly base: string;
  readonly head: string;
  /** Directory inside the repository to analyze. Defaults to the current directory. */
  readonly directory?: string;
  /** Explicit `tsconfig.json` or `jsconfig.json`, inside the repository. */
  readonly config?: string;
}

/**
 * Runs an analysis and returns the report.
 *
 * Never exits the process and never writes to stdout: this is the API boundary, and a
 * library that terminates its caller is not reusable. The CLI owns both.
 */
export async function analyze(options: AnalyzeOptions): Promise<Report> {
  const repoRoot = await findRepositoryRoot(options.directory ?? process.cwd());

  const baseCommit = await resolveCommit(repoRoot, options.base);
  const headCommit = await resolveCommit(repoRoot, options.head);
  // Merge-base semantics, matching a pull request diff: the report describes what head
  // changed, not what base moved on to.
  const mergeBaseSha = await findMergeBase(repoRoot, baseCommit, headCommit);

  const pair = await loadSnapshotPair({
    repoRoot,
    baseSha: mergeBaseSha,
    headSha: headCommit,
    ...(options.config === undefined
      ? {}
      : { configPath: toPosixPath(options.config) }),
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      status: pair.run.status,
      analysisMode: pair.head.analysisMode,
      reasons: pair.run.reasons,
      warnings: pair.run.warnings,
      // Zero until M2 maps seeds. Reported rather than omitted so the shape is stable and
      // a consumer can tell "nothing found" from "not implemented" only by the version.
      counts: {
        seeds: 0,
        usages: 0,
        valueReferences: 0,
        gaps: 0,
        repoWideGaps: 0,
      },
      refs: {
        base: options.base,
        head: options.head,
        baseSha: baseCommit,
        headSha: headCommit,
        mergeBaseSha,
      },
      analysisTypeScriptVersion: ts.version,
    },
    coverage: COVERAGE_STATEMENT,
    seeds: [],
    repoWideGaps: [],
  };
}

export type { Report } from "./model.js";
