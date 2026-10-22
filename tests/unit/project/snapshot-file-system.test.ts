import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSnapshotFileSystem,
  SnapshotFileSystemError,
} from "../../../src/project/snapshot-file-system.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 30_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openCase(name: string): Promise<FixtureRepo> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);
  return repo;
}

/** The snapshot host for a fixture's head commit. */
async function headSnapshot(name: string) {
  const repo = await openCase(name);
  const snapshot = await createSnapshotFileSystem({
    repoRoot: repo.path,
    commitSha: repo.headSha,
  });
  return { repo, snapshot };
}

describe("snapshot routing", () => {
  it(
    "serves repository source from the commit, not from disk",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      const text = snapshot.host.readFileSync(join(repo.path, "src/format.ts"));
      expect(text).toContain("toLowerCase");
      expect(
        snapshot.host.fileExistsSync(join(repo.path, "src/format.ts")),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "serves each commit its own content",
    async () => {
      const repo = await openCase("overlay-basic");

      const base = await createSnapshotFileSystem({
        repoRoot: repo.path,
        commitSha: repo.baseSha,
      });
      const head = await createSnapshotFileSystem({
        repoRoot: repo.path,
        commitSha: repo.headSha,
      });

      const path = join(repo.path, "src/format.ts");
      expect(base.host.readFileSync(path)).not.toContain("toLowerCase");
      expect(head.host.readFileSync(path)).toContain("toLowerCase");
    },
    TIMEOUT_MS,
  );

  it(
    "never falls back to disk for repository source",
    async () => {
      const { repo, snapshot } = await headSnapshot("leak-uncommitted");

      // The fixture's overlay put a third variant of calc.ts in the work tree and added an
      // untracked file. Neither may be visible: a disk fallback here would silently make
      // results depend on uncommitted state.
      expect(
        snapshot.host.readFileSync(join(repo.path, "src/calc.ts")),
      ).toContain("* 2");
      expect(
        snapshot.host.readFileSync(join(repo.path, "src/calc.ts")),
      ).not.toContain("999");
      expect(
        snapshot.host.fileExistsSync(join(repo.path, "src/untracked.ts")),
      ).toBe(false);
      expect(() =>
        snapshot.host.readFileSync(join(repo.path, "src/untracked.ts")),
      ).toThrow(SnapshotFileSystemError);
    },
    TIMEOUT_MS,
  );

  it(
    "reads node_modules from the working tree",
    async () => {
      const { repo, snapshot } = await headSnapshot("layout-npm");

      const pkg = snapshot.host.readFileSync(
        join(repo.path, "node_modules/tiny-ui/package.json"),
      );
      expect(JSON.parse(pkg)).toMatchObject({ name: "tiny-ui" });
      // ...and node_modules is in no commit, so a snapshot-only route would find nothing.
      expect(
        snapshot.files.some((file) => file.startsWith("node_modules/")),
      ).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "finds a nested transitive dependency under a yarn layout",
    async () => {
      const { repo, snapshot } = await headSnapshot("layout-yarn");

      expect(
        snapshot.host.fileExistsSync(
          join(
            repo.path,
            "node_modules/tiny-ui/node_modules/tiny-dep/index.d.ts",
          ),
        ),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "resolves pnpm links so a package can reach its own dependencies",
    async () => {
      const { repo, snapshot } = await headSnapshot("layout-pnpm");

      const linked = join(repo.path, "node_modules/tiny-ui");
      const real = snapshot.host.realpathSync(linked);

      expect(real).toContain(".pnpm");
      // tiny-dep sits beside the *real* tiny-ui, not beside the link, so only a resolver
      // that follows the link can reach it.
      expect(
        snapshot.host.fileExistsSync(`${real}/../tiny-dep/index.d.ts`),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "denies paths outside the repository",
    async () => {
      const { snapshot } = await headSnapshot("overlay-basic");

      expect(snapshot.host.fileExistsSync("/etc/hosts")).toBe(false);
      expect(() => {
        snapshot.host.readFileSync("/etc/hosts");
      }).toThrow(/outside the repository/);
    },
    TIMEOUT_MS,
  );

  it(
    "denies a path outside the repository even when it exists on disk",
    async () => {
      const repo = await openCase("overlay-basic");
      const outside = join(repo.path, "..", "libs");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "lib.d.ts"), "declare const x: number;\n");
      cleanups.push(() => rm(outside, { recursive: true, force: true }));

      const snapshot = await createSnapshotFileSystem({
        repoRoot: repo.path,
        commitSha: repo.headSha,
      });

      // There is no escape hatch. ts-morph serves its own bundled lib files internally,
      // so nothing legitimate needs to read outside the repository.
      expect(snapshot.host.fileExistsSync(join(outside, "lib.d.ts"))).toBe(
        false,
      );
      expect(() => {
        snapshot.host.readFileSync(join(outside, "lib.d.ts"));
      }).toThrow(/outside the repository/);
    },
    TIMEOUT_MS,
  );
});

describe("snapshot directory surface", () => {
  it(
    "reports directories that exist only in the commit",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      expect(snapshot.host.directoryExistsSync(join(repo.path, "src"))).toBe(
        true,
      );
      expect(snapshot.host.directoryExistsSync(join(repo.path, "nope"))).toBe(
        false,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "lists a directory's immediate children with full paths",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      const names = snapshot.host
        .readDirSync(join(repo.path, "src"))
        .map((entry) => entry.name);
      expect(names.some((name) => name.endsWith("/src/format.ts"))).toBe(true);
      // Compared against the host's own root: it canonicalizes symlinked paths, so the
      // caller's spelling of the root is not what comes back.
      expect(
        names.every((name) =>
          name.startsWith(snapshot.host.getCurrentDirectory()),
        ),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "matches tsconfig-style globs against snapshot files only",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      const matched = snapshot.host.globSync([join(repo.path, "src/**/*.ts")]);
      expect(matched.some((path) => path.endsWith("/src/format.ts"))).toBe(
        true,
      );
      expect(matched.every((path) => !path.includes("node_modules"))).toBe(
        true,
      );
    },
    TIMEOUT_MS,
  );
});

describe("glob support is bounded and says so", () => {
  it.each([
    ["a character class", "src/[abc].ts"],
    ["a brace expansion", "src/*.{ts,tsx}"],
    ["an extglob group", "src/+(a|b).ts"],
  ])(
    "rejects %s rather than matching nothing",
    async (_label, pattern) => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      // Silently escaping an unsupported construct would make it match nothing, so a
      // tsconfig using it would analyze an empty file set and report no impact. For a
      // tool whose empty result is meant to be meaningful, failing loudly is the only
      // honest option.
      expect(() => {
        snapshot.host.globSync([join(repo.path, pattern)]);
      }).toThrow(/unsupported syntax/);
    },
    TIMEOUT_MS,
  );

  it(
    "still supports the documented subset",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      expect(
        snapshot.host.globSync([join(repo.path, "src/**/*.ts")]).length,
      ).toBeGreaterThan(0);
      expect(
        snapshot.host.globSync([join(repo.path, "src/*.ts")]).length,
      ).toBeGreaterThan(0);
      expect(
        snapshot.host.globSync([join(repo.path, "src/forma?.ts")]).length,
      ).toBe(1);
      expect(
        snapshot.host.globSync([
          join(repo.path, "src/**/*.ts"),
          `!${join(repo.path, "src/format.ts")}`,
        ]),
      ).not.toContain(join(repo.path, "src/format.ts"));
    },
    TIMEOUT_MS,
  );
});

describe("case sensitivity", () => {
  it(
    "does not resolve an import whose case differs from the committed path",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");

      // Deliberate: a case-insensitive filesystem would resolve this, so a repository
      // that builds on macOS could fail on Linux. nidan reports it as missing on every
      // platform rather than varying by host, which is what keeps output deterministic.
      expect(
        snapshot.host.fileExistsSync(join(repo.path, "src/FORMAT.ts")),
      ).toBe(false);
      expect(
        snapshot.host.fileExistsSync(join(repo.path, "src/format.ts")),
      ).toBe(true);
      expect(snapshot.host.isCaseSensitive()).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("snapshot write protection", () => {
  it(
    "refuses every mutation rather than ignoring it",
    async () => {
      const { repo, snapshot } = await headSnapshot("overlay-basic");
      const path = join(repo.path, "src/format.ts");

      expect(() => {
        snapshot.host.writeFileSync(path, "x");
      }).toThrow(/read-only/);
      expect(() => {
        snapshot.host.deleteSync(path);
      }).toThrow(/read-only/);
      expect(() => {
        snapshot.host.mkdirSync(join(repo.path, "new"));
      }).toThrow(/read-only/);
      expect(() => {
        snapshot.host.moveSync(path, `${path}.moved`);
      }).toThrow(/read-only/);
      expect(() => {
        snapshot.host.copySync(path, `${path}.copy`);
      }).toThrow(/read-only/);
      await expect(snapshot.host.writeFile(path, "x")).rejects.toThrow(
        /read-only/,
      );
    },
    TIMEOUT_MS,
  );
});

describe("entries a snapshot cannot represent", () => {
  it(
    "skips symlinks and records them",
    async () => {
      const caseDir = join("tests", "fixtures", "overlay-basic");
      const repo = await createFixtureRepo(caseDir);
      cleanups.push(repo.cleanup);
      const snapshot = await createSnapshotFileSystem({
        repoRoot: repo.path,
        commitSha: repo.headSha,
      });

      // No fixture commits a symlink, so the expectation is an empty, present list rather
      // than an absent one — the field exists so a run can report what it skipped.
      expect(snapshot.skipped.symlinks).toEqual([]);
      expect(snapshot.skipped.submodules).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
