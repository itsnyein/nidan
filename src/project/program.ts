import { Project, ts } from "ts-morph";

import {
  discoverConfig,
  type AnalysisMode,
  type DiscoveredConfig,
} from "./config.js";
import { toPosixPath } from "./paths.js";
import {
  createSnapshotFileSystem,
  type SnapshotFileSystem,
} from "./snapshot-file-system.js";
import {
  compareManifests,
  dependenciesInstalled,
  deriveRunState,
  skippedEntryReasons,
  type RunReason,
  type RunState,
  type RunWarning,
} from "./run.js";

export class ProgramLoadError extends Error {
  override readonly name = "ProgramLoadError";
}

export interface LoadedSnapshot {
  readonly project: Project;
  readonly snapshot: SnapshotFileSystem;
  readonly config: DiscoveredConfig;
  readonly analysisMode: AnalysisMode;
}

export interface LoadedPair {
  readonly base: LoadedSnapshot;
  readonly head: LoadedSnapshot;
  readonly run: RunState;
}

export interface LoadPairOptions {
  readonly repoRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Absolute path to an explicit config file, inside the repository. */
  readonly configPath?: string;
}

/**
 * Loads both snapshots as full, type-checked programs and reports how the run went.
 *
 * Both are loaded eagerly rather than lazily. A lazily loaded base program answers
 * differently at the edges, and the edges are where the core guarantee lives — see
 * ADR-0006. Whether the cost justifies optimizing is a baseline question.
 */
export async function loadSnapshotPair(
  options: LoadPairOptions,
): Promise<LoadedPair> {
  const repoRoot = toPosixPath(options.repoRoot);
  const reasons: RunReason[] = [];

  const base = await loadSnapshot(
    repoRoot,
    options.baseSha,
    options.configPath,
    reasons,
  );
  const head = await loadSnapshot(
    repoRoot,
    options.headSha,
    options.configPath,
    reasons,
  );

  // Only when something actually needs them. A project that imports no package resolves
  // perfectly well without `node_modules`, and degrading it would be a false alarm that
  // teaches readers to ignore the reason. See the handoff: this narrows the Addendum's
  // literal wording to match the approved fixtures, which assert `ok` for exactly this
  // shape.
  if (!dependenciesInstalled(repoRoot) && hasUnresolvedPackageImport(head)) {
    reasons.push({ kind: "dependencies-not-installed" });
  }

  const warnings: RunWarning[] = [];
  const manifestChange = compareManifests(
    readIfPresent(base.snapshot, repoRoot, "package.json"),
    readIfPresent(head.snapshot, repoRoot, "package.json"),
  );
  if (manifestChange !== undefined) warnings.push(manifestChange);

  return { base, head, run: deriveRunState(reasons, warnings) };
}

async function loadSnapshot(
  repoRoot: string,
  commitSha: string,
  configPath: string | undefined,
  reasons: RunReason[],
): Promise<LoadedSnapshot> {
  let snapshot: SnapshotFileSystem;
  try {
    snapshot = await createSnapshotFileSystem({ repoRoot, commitSha });
  } catch (error) {
    // A snapshot that cannot be read is a failed run, not a degraded one: there is
    // nothing to analyze.
    throw new ProgramLoadError(`could not read the snapshot at ${commitSha}`, {
      cause: error,
    });
  }

  reasons.push(...skippedEntryReasons(snapshot.skipped));

  const config = discoverConfig(snapshot, repoRoot, configPath);
  if (config.mode === "inferred") {
    reasons.push({ kind: "inferred-config" });
  }
  if (config.errors.length > 0) {
    reasons.push({ kind: "config-errors", messages: config.errors });
  }

  const project = new Project({
    fileSystem: snapshot.host,
    compilerOptions: config.compilerOptions,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: false,
  });
  for (const fileName of config.fileNames) {
    project.addSourceFileAtPath(fileName);
  }
  project.resolveSourceFileDependencies();

  return { project, snapshot, config, analysisMode: config.mode };
}

/**
 * True when an analyzed file imports a package specifier that did not resolve.
 *
 * Resolution is the test, not the spelling. A path alias such as `@/lib/slug.js` looks
 * bare but is mapped by `paths` and needs no `node_modules`; only a specifier that failed
 * to resolve is evidence that missing dependencies actually cost something.
 */
function hasUnresolvedPackageImport(loaded: LoadedSnapshot): boolean {
  for (const sourceFile of loaded.project.getSourceFiles()) {
    const declarations = [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ];
    for (const declaration of declarations) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier === undefined) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (declaration.getModuleSpecifierSourceFile() === undefined) return true;
    }
  }
  return false;
}

function readIfPresent(
  snapshot: SnapshotFileSystem,
  repoRoot: string,
  relativePath: string,
): string | undefined {
  const absolute = `${repoRoot}/${relativePath}`;
  return snapshot.host.fileExistsSync(absolute)
    ? snapshot.host.readFileSync(absolute)
    : undefined;
}

/**
 * Files among `filePaths` that carry compiler errors.
 *
 * Kept separate from loading because the set that matters is the seed and usage files,
 * which are not known until the diff has been mapped. A run degrades on diagnostics in
 * files it actually analyzed, not on unrelated errors elsewhere in the repository.
 */
export function filesWithDiagnostics(
  loaded: LoadedSnapshot,
  filePaths: readonly string[],
): string[] {
  const wanted = new Set(filePaths.map(toPosixPath));
  const affected = new Set<string>();

  for (const diagnostic of loaded.project.getPreEmitDiagnostics()) {
    const sourceFile = diagnostic.getSourceFile();
    if (sourceFile === undefined) continue;
    if (diagnostic.getCategory() !== ts.DiagnosticCategory.Error) continue;
    const path = toPosixPath(sourceFile.getFilePath());
    if (wanted.has(path)) affected.add(path);
  }

  return [...affected].sort();
}
