import { rename } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadSnapshotPair,
  filesWithDiagnostics,
} from "../../../src/project/program.js";
import { compareManifests } from "../../../src/project/run.js";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 60_000;

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

async function loadCase(name: string) {
  const repo = await openCase(name);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  return { repo, pair };
}

function reasonKinds(
  pair: Awaited<ReturnType<typeof loadCase>>["pair"],
): string[] {
  return pair.run.reasons.map((reason) => reason.kind).sort();
}

describe("config discovery", () => {
  it(
    "uses a committed tsconfig.json and reports an ok run",
    async () => {
      const { pair } = await loadCase("config-tsconfig");

      expect(pair.head.analysisMode).toBe("tsconfig");
      expect(pair.head.config.configPath).toBe("tsconfig.json");
      expect(pair.run.status).toBe("ok");
      expect(pair.run.reasons).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "uses a committed jsconfig.json and honours its path aliases",
    async () => {
      const { pair } = await loadCase("config-jsconfig-paths");

      expect(pair.head.analysisMode).toBe("jsconfig");
      expect(pair.run.status).toBe("ok");

      // The alias has to have resolved: if `@/lib/slug.js` had not, the import would be
      // an unresolved module and the symbol would be missing from the program.
      const page = pair.head.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/page.js"),
      );
      const [declaration] = page.getImportDeclarations();
      expect(declaration?.getModuleSpecifierValue()).toBe("@/lib/slug.js");
      expect(
        declaration?.getModuleSpecifierSourceFile()?.getFilePath(),
      ).toMatch(/\/src\/lib\/slug\.js$/);
    },
    TIMEOUT_MS,
  );

  it(
    "infers a configuration when none is committed, and says so",
    async () => {
      const { pair } = await loadCase("config-absent");

      expect(pair.head.analysisMode).toBe("inferred");
      expect(pair.head.config.configPath).toBeUndefined();
      expect(pair.run.status).toBe("degraded");
      expect(reasonKinds(pair)).toContain("inferred-config");
    },
    TIMEOUT_MS,
  );

  it(
    "keeps the user's compiler options, overriding only allowJs",
    async () => {
      const { pair } = await loadCase("config-tsconfig");
      const options = pair.head.config.compilerOptions;

      // Written in the fixture's tsconfig and must survive untouched.
      expect(options.strict).toBe(true);
      expect(options.noEmit).toBe(true);
      // The one documented exception: omen analyzes .js whether or not the project does.
      expect(options.allowJs).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("program loading", () => {
  it(
    "loads each snapshot with its own content",
    async () => {
      const { pair } = await loadCase("overlay-basic");

      const base = pair.base.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/format.ts"),
      );
      const head = pair.head.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/format.ts"),
      );

      expect(base.getFullText()).not.toContain("toLowerCase");
      expect(head.getFullText()).toContain("toLowerCase");
    },
    TIMEOUT_MS,
  );

  it(
    "type-checks against dependencies resolved from the working tree",
    async () => {
      const { pair } = await loadCase("layout-pnpm");

      const card = pair.head.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/card.tsx"),
      );
      const [declaration] = card.getImportDeclarations();

      // tiny-ui lives only under .pnpm, reachable through a link, and its own types import
      // tiny-dep. Resolving the declaration proves the whole chain worked.
      expect(declaration?.getModuleSpecifierValue()).toBe("tiny-ui");
      expect(
        declaration?.getModuleSpecifierSourceFile()?.getFilePath(),
      ).toContain(".pnpm");
      expect(filesWithDiagnostics(pair.head, [card.getFilePath()])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "reports diagnostics only for the files it was asked about",
    async () => {
      const { pair } = await loadCase("config-tsconfig");
      const greet = pair.head.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/greet.ts"),
      );

      // A clean fixture: the point is that the query is scoped, not that it finds nothing.
      expect(filesWithDiagnostics(pair.head, [greet.getFilePath()])).toEqual(
        [],
      );
      expect(filesWithDiagnostics(pair.head, [])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "never admits a working-tree file into the program",
    async () => {
      const { pair } = await loadCase("leak-uncommitted");

      const paths = pair.head.project
        .getSourceFiles()
        .map((file) => file.getFilePath());
      expect(paths.some((path) => path.endsWith("/src/untracked.ts"))).toBe(
        false,
      );

      const calc = pair.head.project.getSourceFileOrThrow((file) =>
        file.getFilePath().endsWith("/src/calc.ts"),
      );
      expect(calc.getFullText()).toContain("* 2");
      expect(calc.getFullText()).not.toContain("999");
    },
    TIMEOUT_MS,
  );
});

describe("run status", () => {
  it(
    "degrades when node_modules is missing, naming the reason",
    async () => {
      const repo = await openCase("layout-npm");
      // Simulate an uninstalled project by moving the directory aside rather than
      // deleting it, so the fixture's own files are untouched.
      await rename(
        join(repo.path, "node_modules"),
        join(repo.path, "node_modules_away"),
      );

      const pair = await loadSnapshotPair({
        repoRoot: repo.path,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
      });

      expect(pair.run.status).toBe("degraded");
      expect(pair.run.reasons.map((reason) => reason.kind)).toContain(
        "dependencies-not-installed",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "stays ok when dependencies are installed",
    async () => {
      const { pair } = await loadCase("layout-npm");

      expect(pair.run.reasons.map((reason) => reason.kind)).not.toContain(
        "dependencies-not-installed",
      );
      expect(pair.run.status).toBe("ok");
    },
    TIMEOUT_MS,
  );

  it(
    "reports a shared reason once, not once per snapshot",
    async () => {
      const { pair } = await loadCase("config-absent");

      // Both snapshots infer from the same absent file. Reporting it twice would make the
      // report depend on how many snapshots were loaded rather than on what went wrong.
      const inferred = pair.run.reasons.filter(
        (reason) => reason.kind === "inferred-config",
      );
      expect(inferred).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    "is degraded exactly when there is a reason",
    async () => {
      const clean = await loadCase("config-tsconfig");
      const inferred = await loadCase("config-absent");

      expect(clean.pair.run.reasons).toEqual([]);
      expect(clean.pair.run.status).toBe("ok");
      expect(inferred.pair.run.reasons.length).toBeGreaterThan(0);
      expect(inferred.pair.run.status).toBe("degraded");
    },
    TIMEOUT_MS,
  );
});

describe("dependency manifest drift", () => {
  it(
    "warns and names the changed package without degrading the run",
    async () => {
      const { pair } = await loadCase("manifest-changed");

      expect(pair.run.warnings).toEqual([
        { kind: "dependency-manifest-changed", packages: ["ms"] },
      ]);
      // A warning is not a reason: the analysis is still valid, just caveated.
      expect(pair.run.status).toBe("ok");
      expect(pair.run.reasons).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "says nothing when the manifests agree",
    async () => {
      const { pair } = await loadCase("layout-npm");

      expect(pair.run.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each([
    [
      "a changed version",
      '{"dependencies":{"a":"1.0.0"}}',
      '{"dependencies":{"a":"2.0.0"}}',
      ["a"],
    ],
    ["a removed package", '{"dependencies":{"a":"1.0.0"}}', "{}", ["a"]],
    ["a dev dependency", '{"devDependencies":{"b":"1.0.0"}}', "{}", ["b"]],
    [
      "a package moved between fields",
      '{"dependencies":{"c":"1.0.0"}}',
      '{"devDependencies":{"c":"1.0.0"}}',
      [],
    ],
  ])("detects %s", (_label, base, head, expected) => {
    const warning = compareManifests(base, head);
    expect(warning?.packages ?? []).toEqual(expected);
  });

  it("ignores an unparsable manifest rather than throwing", () => {
    expect(compareManifests("{ not json", "{ not json")).toBeUndefined();
  });
});
