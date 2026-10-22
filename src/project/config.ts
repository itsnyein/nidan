import { ts } from "ts-morph";

import { isWithin, joinPosix, toPosixPath } from "./paths.js";
import type { SnapshotFileSystem } from "./snapshot-file-system.js";

/** Which configuration a run analyzed with. Reported in `run.analysisMode`. */
export type AnalysisMode = "tsconfig" | "jsconfig" | "inferred";

/**
 * `invalid-config-path` means the user named a config nidan cannot use, which is their
 * input to fix. `unreadable-config` means the committed config itself is broken, which
 * is a failed run.
 */
export type ConfigErrorKind = "invalid-config-path" | "unreadable-config";

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    readonly kind: ConfigErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface DiscoveredConfig {
  readonly mode: AnalysisMode;
  /** Repository-relative POSIX path, absent when the configuration was inferred. */
  readonly configPath?: string;
  readonly compilerOptions: ts.CompilerOptions;
  /** Absolute POSIX paths of the files the configuration selects. */
  readonly fileNames: readonly string[];
  /** Diagnostics raised while reading the configuration itself. */
  readonly errors: readonly string[];
}

const CONFIG_FILES: ReadonlyArray<{ name: string; mode: AnalysisMode }> = [
  { name: "tsconfig.json", mode: "tsconfig" },
  { name: "jsconfig.json", mode: "jsconfig" },
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/**
 * Options used when no configuration is committed.
 *
 * Chosen to be permissive rather than opinionated: an inferred run should fail to resolve
 * as little as possible, because the user never asked for these settings and every
 * resolution failure becomes a gap they cannot act on. The run is marked `degraded` so
 * the reader knows these were not their choices.
 */
const INFERRED_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: false,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * Finds and parses the project's configuration inside the snapshot.
 *
 * The configuration is read from the commit, not from disk: a run describes the refs it
 * was asked about, and a working-tree `tsconfig.json` is not what either ref contained.
 */
export function discoverConfig(
  snapshot: SnapshotFileSystem,
  repoRoot: string,
  explicitConfigPath?: string,
): DiscoveredConfig {
  const root = toPosixPath(repoRoot);

  if (explicitConfigPath !== undefined) {
    const absolute = toPosixPath(explicitConfigPath);
    if (!isWithin(root, absolute)) {
      throw new ConfigError(
        "invalid-config-path",
        `config ${absolute} is outside the repository`,
      );
    }
    if (!snapshot.host.fileExistsSync(absolute)) {
      throw new ConfigError(
        "invalid-config-path",
        `config ${absolute} is not in this snapshot`,
      );
    }
    return parseConfig(snapshot, root, absolute, modeForPath(absolute));
  }

  for (const candidate of CONFIG_FILES) {
    const absolute = joinPosix(root, candidate.name);
    if (snapshot.host.fileExistsSync(absolute)) {
      return parseConfig(snapshot, root, absolute, candidate.mode);
    }
  }

  return {
    mode: "inferred",
    compilerOptions: { ...INFERRED_OPTIONS },
    fileNames: snapshot.files
      .filter((file) =>
        SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)),
      )
      .map((file) => joinPosix(root, file))
      .sort(),
    errors: [],
  };
}

function modeForPath(absolute: string): AnalysisMode {
  return absolute.endsWith("jsconfig.json") ? "jsconfig" : "tsconfig";
}

function parseConfig(
  snapshot: SnapshotFileSystem,
  root: string,
  absolute: string,
  mode: AnalysisMode,
): DiscoveredConfig {
  const text = snapshot.host.readFileSync(absolute);
  const parsed = ts.parseConfigFileTextToJson(absolute, text);
  if (parsed.error !== undefined) {
    throw new ConfigError(
      "unreadable-config",
      `${absolute} is not valid JSON: ${messageOf(parsed.error)}`,
    );
  }

  const basePath = absolute.slice(0, absolute.lastIndexOf("/"));
  const result = ts.parseJsonConfigFileContent(
    parsed.config,
    createParseConfigHost(snapshot, root),
    basePath,
    undefined,
    absolute,
  );

  return {
    mode,
    configPath: absolute.slice(root.length + 1),
    // The user's options are kept as written. `allowJs` is the single documented
    // exception, because nidan analyzes .js and .jsx whether or not the project compiles
    // them, and without it those files would silently leave the program.
    compilerOptions: { ...result.options, allowJs: true },
    fileNames: result.fileNames.map(toPosixPath).sort(),
    errors: result.errors.map(messageOf),
  };
}

function messageOf(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

/**
 * The host TypeScript uses to expand `include` and `exclude`. It sees the snapshot only,
 * so a file present in the working tree but absent from the commit cannot join the
 * program.
 */
function createParseConfigHost(
  snapshot: SnapshotFileSystem,
  root: string,
): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => snapshot.host.fileExistsSync(path),
    readFile: (path) =>
      snapshot.host.fileExistsSync(path)
        ? snapshot.host.readFileSync(path)
        : undefined,
    readDirectory: (rootDir, extensions, excludes, includes) =>
      readSnapshotDirectory(
        snapshot,
        root,
        rootDir,
        extensions,
        excludes,
        includes,
      ),
  };
}

function readSnapshotDirectory(
  snapshot: SnapshotFileSystem,
  root: string,
  rootDir: string,
  extensions: readonly string[],
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
): string[] {
  const base = toPosixPath(rootDir);
  const candidates = snapshot.files
    .map((file) => joinPosix(root, file))
    .filter((file) => isWithin(base, file))
    .filter((file) => extensions.some((extension) => file.endsWith(extension)));

  const included =
    includes === undefined || includes.length === 0
      ? candidates
      : candidates.filter((file) =>
          includes.some((pattern) => matches(base, pattern, file)),
        );

  if (excludes === undefined || excludes.length === 0) return included.sort();
  return included
    .filter((file) => !excludes.some((pattern) => matches(base, pattern, file)))
    .sort();
}

/**
 * Matches one `include`/`exclude` entry against an absolute path.
 *
 * A pattern with no wildcard names a directory or file and covers everything beneath it,
 * which is how `"exclude": ["node_modules"]` keeps a whole tree out. Patterns with
 * wildcards are matched segment-wise, with `**` spanning directories.
 */
function matches(base: string, pattern: string, filePath: string): boolean {
  const absolutePattern = pattern.startsWith("/")
    ? toPosixPath(pattern)
    : joinPosix(base, pattern);

  if (!/[*?]/.test(absolutePattern)) {
    return filePath === absolutePattern || isWithin(absolutePattern, filePath);
  }

  const expression = absolutePattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:[^/]+(?:/[^/]+)*)?";
      return segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    })
    .join("/")
    // `a/**/b` must also match `a/b`, so collapse the empty directory span.
    .replace(/\/\(\?:\[\^\/\]\+\(\?:\/\[\^\/\]\+\)\*\)\?\//g, "/(?:[^/]+/)*");

  return new RegExp(`^${expression}$`).test(filePath);
}
