import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The smallest JSX runtime a `.tsx` case built at test time can type-check against.
 *
 * Such a case needs `jsx` and `jsxImportSource` set *and* something for the latter to
 * resolve to. Without both, every tag is an error and the references returned come from a
 * program that did not type-check — not the thing those tests mean to measure.
 *
 * The `layout-*` fixtures carry their own copy of this package. That is not duplication to
 * remove: a fixture is frozen data, and an approved case must keep producing the result it
 * was approved for even if this file changes. This module serves cases built at test time,
 * which have no such guarantee and had grown two copies of it.
 */

const PACKAGE_NAME = "tiny-ui";

/** The compiler options a case needs in order to contain JSX. */
export const JSX_COMPILER_OPTIONS = {
  jsx: "react-jsx",
  jsxImportSource: PACKAGE_NAME,
} as const;

/**
 * Writes the shim package into `caseDir/node_modules`.
 *
 * At the case root rather than inside a snapshot, because both snapshots resolve against
 * the same installed dependency — dependencies come from the working tree, never from a
 * snapshot.
 */
export async function writeJsxShim(caseDir: string): Promise<void> {
  const shim = join(caseDir, "node_modules", PACKAGE_NAME);
  await mkdir(shim, { recursive: true });
  await writeFile(
    join(shim, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: "1.0.0",
        types: "./index.d.ts",
        exports: {
          ".": { types: "./index.d.ts" },
          "./jsx-runtime": { types: "./jsx-runtime.d.ts" },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(shim, "jsx-runtime.d.ts"),
    "export namespace JSX {\n" +
      "  interface Element {\n    readonly rendered: unique symbol;\n  }\n" +
      "  interface IntrinsicElements {\n    [name: string]: unknown;\n  }\n}\n" +
      "export declare function jsx(type: unknown, props: unknown): JSX.Element;\n" +
      "export declare function jsxs(type: unknown, props: unknown): JSX.Element;\n" +
      "export declare const Fragment: unique symbol;\n",
  );
  await writeFile(
    join(shim, "index.d.ts"),
    'export type { JSX } from "./jsx-runtime.js";\n',
  );
}
