# omen

omen is a command-line tool that compares two Git refs in a JavaScript/TypeScript
repository, finds the named callables that changed, and reports their direct usages
with evidence from the TypeScript compiler. Anything it cannot confirm statically is
reported as a gap rather than guessed. Results mean "potentially affected" — they are
never a guarantee of real-world impact.

## Status

Early development. omen is not yet functional and is not published. The command-line
interface currently supports only `--version` and `--help`.

## Requirements

- Node.js 22 or newer (see `.node-version` for the version used in development)
- pnpm (pinned in the `packageManager` field of `package.json`)

## Development

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
