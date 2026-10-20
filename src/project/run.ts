import { existsSync } from "node:fs";

import { joinPosix, toPosixPath } from "./paths.js";
import type { SkippedEntries } from "./snapshot-file-system.js";

/**
 * How the analysis executed. It describes tool execution only — never how complete the
 * impact analysis is. An `ok` run is still bounded by the supported patterns and the
 * coverage statement.
 */
export type RunStatus = "ok" | "degraded" | "failed";

/** Why a run is degraded. Every degraded run carries at least one. */
export type RunReason =
  | { readonly kind: "inferred-config" }
  | { readonly kind: "dependencies-not-installed" }
  | { readonly kind: "config-errors"; readonly messages: readonly string[] }
  | {
      readonly kind: "diagnostics-in-analyzed-files";
      readonly files: readonly string[];
    }
  | { readonly kind: "skipped-symlinks"; readonly paths: readonly string[] }
  | { readonly kind: "skipped-submodules"; readonly paths: readonly string[] };

/** Reported alongside results without affecting status. */
export type RunWarning = {
  readonly kind: "dependency-manifest-changed";
  readonly packages: readonly string[];
};

export interface RunState {
  readonly status: RunStatus;
  readonly reasons: readonly RunReason[];
  readonly warnings: readonly RunWarning[];
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Derives run status from the reasons collected during loading.
 *
 * Status is a function of the reasons rather than something set at each site, so a reason
 * can never be recorded without affecting status, and a run can never be degraded without
 * saying why.
 */
export function deriveRunState(
  reasons: readonly RunReason[],
  warnings: readonly RunWarning[],
): RunState {
  // Deduplicated because a reason describes the run, not a snapshot. Both snapshots
  // infer their configuration from the same absent file, and reporting
  // `inferred-config` twice would say nothing extra while making the report depend on
  // how many snapshots happened to be loaded.
  const deduplicated = dedupe(reasons);
  return {
    status: deduplicated.length === 0 ? "ok" : "degraded",
    reasons: deduplicated,
    warnings: dedupe(warnings),
  };
}

function dedupe<T>(items: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(JSON.stringify(item), item);
  }
  return [...seen.values()];
}

/** Symlinks and submodules a snapshot could not represent become reasons. */
export function skippedEntryReasons(skipped: SkippedEntries): RunReason[] {
  const reasons: RunReason[] = [];
  if (skipped.symlinks.length > 0) {
    reasons.push({ kind: "skipped-symlinks", paths: skipped.symlinks });
  }
  if (skipped.submodules.length > 0) {
    reasons.push({ kind: "skipped-submodules", paths: skipped.submodules });
  }
  return reasons;
}

/**
 * Dependencies are read from the working tree, so their absence is a real limit on what
 * can be resolved — but not a failure: the analysis still runs and reports what it could
 * not resolve as gaps.
 */
export function dependenciesInstalled(repoRoot: string): boolean {
  return existsSync(joinPosix(toPosixPath(repoRoot), "node_modules"));
}

/**
 * Compares the dependency fields of the two snapshots' manifests.
 *
 * A difference means the types resolved from the working tree may not match what either
 * commit actually used. That is worth saying and not worth degrading the run over: the
 * analysis is still valid, just caveated.
 */
export function compareManifests(
  basePackageJson: string | undefined,
  headPackageJson: string | undefined,
): RunWarning | undefined {
  const base = readDependencies(basePackageJson);
  const head = readDependencies(headPackageJson);

  const changed = new Set<string>();
  for (const name of new Set([...base.keys(), ...head.keys()])) {
    if (base.get(name) !== head.get(name)) changed.add(name);
  }

  if (changed.size === 0) return undefined;
  return {
    kind: "dependency-manifest-changed",
    packages: [...changed].sort(),
  };
}

function readDependencies(
  packageJson: string | undefined,
): Map<string, string> {
  const versions = new Map<string, string>();
  if (packageJson === undefined) return versions;

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    // An unparsable manifest is not this function's problem to report; it simply
    // contributes no dependencies, and the compiler will raise its own errors.
    return versions;
  }
  if (typeof parsed !== "object" || parsed === null) return versions;

  for (const field of DEPENDENCY_FIELDS) {
    const section = (parsed as Record<string, unknown>)[field];
    if (typeof section !== "object" || section === null) continue;
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === "string")
        versions.set(`${field}:${name}`, version);
    }
  }

  // Keys carry their field so a package moved between fields registers as a change; the
  // reported name does not.
  return new Map(
    [...versions].map(([key, value]) => [
      key.slice(key.indexOf(":") + 1),
      value,
    ]),
  );
}
