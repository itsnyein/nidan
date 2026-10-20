import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
  /**
   * Project directory to analyze, resolved against the current directory. The repository
   * root is then discovered upward from it, so a subdirectory is a valid starting point.
   */
  readonly directory?: string;
  /**
   * Explicit `tsconfig.json` or `jsconfig.json`. A relative path resolves against
   * `directory`, not against the current directory — the same "as if started there"
   * semantics git gives `-C`.
   */
  readonly config?: string;
}

/**
 * Runs an analysis and returns the report.
 *
 * Never exits the process and never writes to stdout: this is the API boundary, and a
 * library that terminates its caller is not reusable. The CLI owns both.
 */
export async function analyze(options: AnalyzeOptions): Promise<Report> {
  // `directory` is where omen behaves as though it were started. Everything relative —
  // including `--config` — is resolved against it, so moving the invocation without
  // moving the paths cannot silently change which files are read.
  const projectDirectory = canonicalDirectory(
    resolve(process.cwd(), options.directory ?? "."),
  );
  const repoRoot = await findRepositoryRoot(projectDirectory);

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
      : {
          configPath: toPosixPath(
            isAbsolute(options.config)
              ? options.config
              : resolve(projectDirectory, options.config),
          ),
        }),
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

/**
 * Resolves symlinks in the project directory so paths derived from it line up with the
 * repository root, which Git reports with symlinks already resolved. Without this, a
 * relative `--config` under a symlinked path would look like it sits outside the
 * repository.
 */
function canonicalDirectory(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Let the repository lookup produce the error; it has better context.
    return path;
  }
}

export type { Report } from "./model.js";
