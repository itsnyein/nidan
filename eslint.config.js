import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Fixture source is data, not code. Cases deliberately contain patterns omen must
    // handle and lint would reject — an `any` receiver, an unused export, a dynamic
    // require — and they are frozen, so they could not be fixed in place anyway.
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "tests/fixtures/*/base/",
      "tests/fixtures/*/head/",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // eslint.config.js is JavaScript and is not part of the TypeScript program,
    // so type-aware rules cannot run on it.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
