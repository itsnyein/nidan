import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { diffCommits, type Hunk } from "../../../src/analysis/diff.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * Builds a throwaway case outside `tests/fixtures/`, which is frozen. These cases exist
 * to attack the diff invocation rather than to describe analysis behavior, so they are
 * test scaffolding rather than approved expectations.
 */
async function buildRepo(files: {
  base: Record<string, string>;
  head: Record<string, string>;
}): Promise<FixtureRepo> {
  const caseDir = await mkdtemp(join(tmpdir(), "omen-harden-"));
  cleanups.push(() => rm(caseDir, { recursive: true, force: true }));
  for (const [snapshot, entries] of Object.entries(files)) {
    for (const [path, contents] of Object.entries(entries)) {
      const absolute = join(caseDir, snapshot, path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, contents);
    }
  }
  const repo = await createFixtureRepo(caseDir);
  cleanups.push(repo.cleanup);
  return repo;
}

/** Sets a repository-local config value, the way a real project would. */
async function setRepoConfig(
  repo: FixtureRepo,
  key: string,
  value: string,
): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  await execFileAsync("git", ["config", "--local", key, value], {
    cwd: repo.path,
    env,
  });
}

/** A nine-line module whose first and last lines differ between snapshots. */
const NINE_LINES = (first: string, last: string): string =>
  [
    `export const first = ${first};`,
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
    "const d = 4;",
    "const e = 5;",
    "const f = 6;",
    "const g = 7;",
    `export const last = ${last};`,
  ].join("\n") + "\n";

async function hunksOf(repo: FixtureRepo, path: string): Promise<Hunk[]> {
  const result = await diffCommits(repo.path, repo.baseSha, repo.headSha);
  return [...(result.files.find((file) => file.path === path)?.hunks ?? [])];
}

describe("pathspec metacharacters", () => {
  it(
    "attaches each file's hunks to that file, even when a name looks like a pattern",
    async () => {
      // `foo[1].ts` is a character class that also matches `foo1.ts`. Without literal
      // pathspecs, one file's hunks arrive under the other's name and every line
      // coordinate used for callable mapping is wrong.
      const repo = await buildRepo({
        base: {
          "foo[1].ts": "export const bracket = 1;\n",
          "foo1.ts": "export const plain = 1;\nconst x = 1;\nconst y = 2;\n",
        },
        head: {
          "foo[1].ts": "export const bracket = 2;\n",
          "foo1.ts": "export const plain = 9;\nconst x = 9;\nconst y = 9;\n",
        },
      });

      const result = await diffCommits(repo.path, repo.baseSha, repo.headSha);
      const bracket = result.files.find((file) => file.path === "foo[1].ts");
      const plain = result.files.find((file) => file.path === "foo1.ts");

      expect(bracket?.hunks).toEqual([
        { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
      ]);
      expect(plain?.hunks).toEqual([
        { base: { start: 1, count: 3 }, head: { start: 1, count: 3 } },
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("the environment cannot redirect or reshape a diff", () => {
  it(
    "ignores GIT_DIR and friends rather than analyzing another repository",
    async () => {
      const repo = await buildRepo({
        base: { "a.ts": "export const value = 1;\n" },
        head: { "a.ts": "export const value = 2;\n" },
      });
      const expected = await hunksOf(repo, "a.ts");

      // Running omen from a Git hook, a rebase, or a wrapper script exports these. They
      // point Git at a different repository entirely, and no flag overrides them — only
      // dropping them from the child environment does.
      const decoy = await mkdtemp(join(tmpdir(), "omen-decoy-"));
      cleanups.push(() => rm(decoy, { recursive: true, force: true }));
      process.env["GIT_DIR"] = join(decoy, "not-a-repo");
      process.env["GIT_WORK_TREE"] = decoy;
      process.env["GIT_INDEX_FILE"] = join(decoy, "index");
      try {
        expect(await hunksOf(repo, "a.ts")).toEqual(expected);
      } finally {
        delete process.env["GIT_DIR"];
        delete process.env["GIT_WORK_TREE"];
        delete process.env["GIT_INDEX_FILE"];
      }
    },
    TIMEOUT_MS,
  );
});

describe("diff drivers cannot erase or fabricate changes", () => {
  it(
    "reports real hunks for a file the attributes mark as non-diffable",
    async () => {
      // `-diff` makes Git treat a text file as binary, which reports the file as changed
      // with no hunks at all. That reads as "nothing changed here" rather than as a
      // failure — a silent drop, which the core guarantee forbids.
      const attributes = "*.ts -diff\n";
      const repo = await buildRepo({
        base: {
          ".gitattributes": attributes,
          "a.ts": "export const value = 1;\n",
        },
        head: {
          ".gitattributes": attributes,
          "a.ts": "export const value = 2;\n",
        },
      });

      expect(await hunksOf(repo, "a.ts")).toEqual([
        { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "ignores GIT_EXTERNAL_DIFF rather than running it",
    async () => {
      const repo = await buildRepo({
        base: { "a.ts": "export const value = 1;\n" },
        head: { "a.ts": "export const value = 2;\n" },
      });
      const expected = await hunksOf(repo, "a.ts");

      // Points at a program that does not exist. If Git honoured it, the diff would
      // either fail or return nothing; either way the hunks would not survive. omen must
      // never run a program the environment chose.
      process.env["GIT_EXTERNAL_DIFF"] = join(
        tmpdir(),
        "omen-no-such-diff-driver",
      );
      process.env["GIT_DIFF_OPTS"] = "--unified=20";
      try {
        expect(await hunksOf(repo, "a.ts")).toEqual(expected);
        expect(expected).toEqual([
          { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
        ]);
      } finally {
        delete process.env["GIT_EXTERNAL_DIFF"];
        delete process.env["GIT_DIFF_OPTS"];
      }
    },
    TIMEOUT_MS,
  );
});

describe("config cannot change the reported ranges", () => {
  it(
    "keeps separate edits separate despite diff.interHunkContext",
    async () => {
      // With an inherited inter-hunk context, two distant one-line edits merge into one
      // range covering everything between them. Unchanged code would then be attributed
      // to a changed callable.
      const repo = await buildRepo({
        base: { "a.ts": NINE_LINES("1", "1") },
        head: { "a.ts": NINE_LINES("2", "2") },
      });
      const expected: Hunk[] = [
        { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
        { base: { start: 9, count: 1 }, head: { start: 9, count: 1 } },
      ];

      expect(await hunksOf(repo, "a.ts")).toEqual(expected);

      await setRepoConfig(repo, "diff.interHunkContext", "20");
      expect(await hunksOf(repo, "a.ts")).toEqual(expected);
    },
    TIMEOUT_MS,
  );

  it(
    "pins the hunk boundary against diff.indentHeuristic",
    async () => {
      // A real divergence, not a hypothetical: with the indent heuristic on, Git reports
      // this deletion as `-1,3 +0,0`; with it off, `-2,3 +1,0`. The heuristic shifts the
      // boundary to a visually nicer place, which moves the lines omen attributes the
      // change to. Whichever is prettier, it must not depend on the reader's config.
      const repo = await buildRepo({
        base: { "a.ts": "{\n  foo();\n}\n{\n  bar();\n}\n" },
        head: { "a.ts": "{\n  bar();\n}\n" },
      });
      const expected = await hunksOf(repo, "a.ts");
      expect(expected).toEqual([
        { base: { start: 2, count: 3 }, head: { start: 1, count: 0 } },
      ]);

      await setRepoConfig(repo, "diff.indentHeuristic", "true");

      expect(await hunksOf(repo, "a.ts")).toEqual(expected);
    },
    TIMEOUT_MS,
  );

  /**
   * Input on which the algorithms genuinely disagree, found by searching rather than
   * guessed: the repeated `send();` lines give the matchers more than one defensible
   * alignment. Myers and minimal report three hunks; histogram and patience report two,
   * covering different lines entirely. Most edits produce identical output under all
   * four, which is why a naive case cannot test this at all.
   */
  const DIVERGENT_BASE = "  log();\n  send();\n  return 1;\n  send();\n";
  const DIVERGENT_HEAD =
    "  init();\n  send();\n  send();\n  return 1;\n  init();\n";

  /** What Myers reports, which is what the pin selects. */
  const MYERS_HUNKS: Hunk[] = [
    { base: { start: 1, count: 1 }, head: { start: 1, count: 1 } },
    { base: { start: 3, count: 1 }, head: { start: 2, count: 0 } },
    { base: { start: 4, count: 0 }, head: { start: 4, count: 2 } },
  ];

  it.each([["histogram"], ["patience"], ["minimal"]])(
    "reports the pinned algorithm's ranges despite diff.algorithm=%s",
    async (algorithm) => {
      const repo = await buildRepo({
        base: { "a.ts": DIVERGENT_BASE },
        head: { "a.ts": DIVERGENT_HEAD },
      });

      // Asserted before the config is set, so a failure here says the pin is wrong rather
      // than that the config won.
      expect(await hunksOf(repo, "a.ts")).toEqual(MYERS_HUNKS);

      await setRepoConfig(repo, "diff.algorithm", algorithm);

      // Unchanged. Without the pin, histogram and patience return two hunks at
      // -1 +1,2 and -4 +5 — different ranges, so a callable would be attributed a change
      // it never received while one that did would be missed.
      expect(await hunksOf(repo, "a.ts")).toEqual(MYERS_HUNKS);
    },
    TIMEOUT_MS,
  );

  it(
    "is unaffected by diff.external, diff.noprefix, and indent heuristics",
    async () => {
      const repo = await buildRepo({
        base: { "a.ts": NINE_LINES("1", "1") },
        head: { "a.ts": NINE_LINES("2", "2") },
      });
      const expected = await hunksOf(repo, "a.ts");

      await setRepoConfig(
        repo,
        "diff.external",
        join(tmpdir(), "omen-no-such-external"),
      );
      await setRepoConfig(repo, "diff.noprefix", "true");
      await setRepoConfig(repo, "diff.indentHeuristic", "true");
      await setRepoConfig(repo, "diff.context", "10");

      expect(await hunksOf(repo, "a.ts")).toEqual(expected);
    },
    TIMEOUT_MS,
  );
});
