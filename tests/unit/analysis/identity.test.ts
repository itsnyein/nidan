import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enumerateCallables,
  type CallableIndex,
} from "../../../src/analysis/identity.js";
import { loadSnapshotPair } from "../../../src/project/program.js";
import { createFixtureRepo } from "../../helpers/fixture-repo.js";

const TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Enumerated {
  readonly base: CallableIndex;
  readonly head: CallableIndex;
  readonly repoPath: string;
}

async function enumerateCase(name: string): Promise<Enumerated> {
  const repo = await createFixtureRepo(join("tests", "fixtures", name));
  cleanups.push(repo.cleanup);
  const pair = await loadSnapshotPair({
    repoRoot: repo.path,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
  });
  return {
    base: enumerateCallables(pair.base.project.getSourceFiles(), repo.path),
    head: enumerateCallables(pair.head.project.getSourceFiles(), repo.path),
    repoPath: repo.path,
  };
}

/** The keys an approved fixture's `expected.json` freezes, in sorted order. */
function expectedKeys(name: string): string[] {
  const raw = readFileSync(
    join("tests", "fixtures", name, "expected.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as {
    expect: { seeds?: Array<{ key: string }> };
  };
  return (parsed.expect.seeds ?? []).map((seed) => seed.key).sort();
}

describe("keys match the approved fixtures", () => {
  // The fixtures are the contract. Reading the keys out of `expected.json` rather than
  // restating them here means this test cannot drift from what was approved: if a key
  // changes, the fixture has to change, which is an `E` task.
  it.each([
    "identity-overload",
    "identity-re-export",
    "identity-static-vs-instance",
    "identity-constructor",
    "seed-comment-change",
    "seed-declaration-form-change",
  ])(
    "%s produces the frozen key",
    async (name) => {
      const { head } = await enumerateCase(name);
      const keys = head.callables.map((callable) => callable.key);
      const expected = expectedKeys(name);

      // Asserted first: a fixture whose `expected.json` listed no seeds would make the
      // loop below pass without checking anything.
      expect(expected.length).toBeGreaterThan(0);
      for (const key of expected) {
        expect(keys).toContain(key);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "keys a named default, an anonymous default, and an aliased default distinctly",
    async () => {
      const { head } = await enumerateCase("identity-default-exports");
      const keys = head.callables.map((callable) => callable.key);
      const expected = expectedKeys("identity-default-exports");

      expect(expected).toHaveLength(3);
      for (const key of expected) {
        expect(keys).toContain(key);
      }
      // `export default toSlug` is an alias, not a declaration: the identity stays
      // `toSlug`, and nothing is keyed `default` in that file.
      expect(keys).not.toContain(
        "src/aliased-default.ts :: :: function :: default",
      );
    },
    TIMEOUT_MS,
  );
});

describe("the key form", () => {
  it(
    "collapses overloads and their implementation into one callable",
    async () => {
      const { head } = await enumerateCase("identity-overload");

      // Three overload signatures plus one implementation. Four entries would be wrong,
      // and would collide with each other.
      const parses = head.callables.filter(
        (callable) => callable.name === "parse",
      );
      expect(parses).toHaveLength(1);
      expect(head.collisions).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "separates nested callables that share a name by their container",
    async () => {
      const { head } = await enumerateCase("identity-nested");
      const keys = head.callables.map((callable) => callable.key);

      expect(keys).toContain("src/outer.ts :: alpha :: function :: helper");
      expect(keys).toContain("src/outer.ts :: beta :: function :: helper");
      // Without the container chain these collapse to one key and collide.
      expect(head.collisions).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "separates a static from an instance method by the trailing marker",
    async () => {
      const { head } = await enumerateCase("identity-static-vs-instance");
      const keys = head.callables.map((callable) => callable.key);

      expect(keys).toContain("src/registry.ts :: Registry :: method :: create");
      expect(keys).toContain(
        "src/registry.ts :: Registry :: method :: create :: static",
      );
      expect(head.collisions).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "keys a declaration-form change identically in both snapshots",
    async () => {
      // A function declaration in base, an arrow-expression variable in head. The whole
      // point of a closed `declarationKind` set is that these match.
      const { base, head } = await enumerateCase(
        "seed-declaration-form-change",
      );
      const key = "src/format.ts :: :: function :: formatRow";

      expect(base.callables.map((callable) => callable.key)).toContain(key);
      expect(head.callables.map((callable) => callable.key)).toContain(key);
    },
    TIMEOUT_MS,
  );
});

describe("collisions are reported, never resolved", () => {
  it(
    "drops a duplicated key from the callables and records it",
    async () => {
      const { head } = await enumerateCase("identity-collision");

      expect(head.collisions).toHaveLength(1);
      expect(head.collisions[0]?.key).toBe(
        "src/dup.js :: :: function :: handle",
      );
      expect(head.collisions[0]?.filePath).toBe("src/dup.js");
      expect(head.collisions[0]?.lines).toHaveLength(2);

      // Choosing either declaration would be a guess, and a guessed identity reports on
      // the wrong code.
      expect(head.callables.map((callable) => callable.key)).not.toContain(
        "src/dup.js :: :: function :: handle",
      );
    },
    TIMEOUT_MS,
  );
});

describe("unsupported forms are absent, not guessed", () => {
  it(
    "omits anonymous callbacks while keeping their enclosing callable",
    async () => {
      const { head } = await enumerateCase("overlay-basic");
      const keys = head.callables.map((callable) => callable.key);

      // `render` contains `rows.map((row) => formatRow(row))`. The arrow is an anonymous
      // callback: unsupported, so it is not a callable and contributes no container.
      expect(keys).toContain("src/main.ts :: :: function :: render");
      // The arrow contributes no container, so the callable it encloses is attributed to
      // `render`. Asserted as an exact key list, because "no key contains X" passes for
      // any X that nothing produces and so proves nothing.
      expect(keys).toEqual([
        "src/format.ts :: :: function :: formatRow",
        "src/main.ts :: :: function :: render",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "omits declaration files entirely",
    async () => {
      const { head } = await enumerateCase("layout-pnpm");

      // tiny-ui ships only .d.ts, so this covers the declaration-file rule alone. The
      // node_modules rule needs a dependency with real source, which
      // identity-edge-cases.test.ts supplies — asserting it here too would pass
      // whether or not that rule exists.
      expect(
        head.callables.some((callable) => callable.filePath.endsWith(".d.ts")),
      ).toBe(false);
      expect(head.callables.map((callable) => callable.key)).toEqual([
        "src/app.tsx :: :: function :: App",
        "src/card.tsx :: :: function :: Card",
      ]);
    },
    TIMEOUT_MS,
  );
});

describe("line spans", () => {
  it(
    "covers the leading JSDoc, so a comment change falls inside the callable",
    async () => {
      const { head } = await enumerateCase("seed-comment-change");
      const total = head.callables.find(
        (callable) => callable.name === "total",
      );

      // The JSDoc is line 1 and the declaration starts at line 2. A span starting at 2
      // would put the comment change outside every callable, turning a modification into
      // an unmapped change.
      expect(total?.startLine).toBe(1);
      expect(total?.endLine).toBeGreaterThan(2);
    },
    TIMEOUT_MS,
  );

  it(
    "measures the whole statement for a variable holding a function",
    async () => {
      const { head } = await enumerateCase("seed-declaration-form-change");
      const formatRow = head.callables.find(
        (callable) => callable.name === "formatRow",
      );

      expect(formatRow?.startLine).toBe(1);
      expect(formatRow?.endLine).toBe(3);
    },
    TIMEOUT_MS,
  );
});

describe("determinism", () => {
  it(
    "returns callables and collisions in key order",
    async () => {
      const { head } = await enumerateCase("identity-default-exports");

      const keys = head.callables.map((callable) => callable.key);
      expect(keys).toEqual([...keys].sort());
    },
    TIMEOUT_MS,
  );
});
