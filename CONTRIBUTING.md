# Contributing

Thanks for improving `platform-shared`. This package is consumed by `social`,
`travel`, `workout`, and `basa`, so changes must stay backward compatible or be
released with a clear migration note.

## Requirements

- Node.js 22 or newer (`engines.node` is `>=22`).
- No runtime dependencies. New third-party runtime dependencies are rejected by
  default; open an issue first if you believe one is unavoidable.

## Local workflow

```bash
npm test        # Node's built-in test runner
npm run build   # syntax check across src, tests, examples, scripts
npm run check   # build + test
```

## Pull requests

1. Keep changes focused; one behavioral change per pull request.
2. Add or update tests in `tests/` for every behavior change.
3. Update `README.md` and `docs/index.html` when public behavior changes.
4. Update the relevant example in `examples/` when an API surface changes;
   examples are executed by `tests/examples.test.js`.
5. Ensure `npm run check` passes before requesting review.

## Coding conventions

- ES modules only (`"type": "module"`), Node built-ins only.
- Throw `PlatformError` with a stable `code` instead of bare `Error`.
- Keep guards and revocation stores synchronous.
- Constructor-inject stores, schedulers, and channel adapters; never reach for
  globals or module-level mutable state.
- Two-space indentation, single quotes, semicolons.

## Releasing

1. Update the version in `package.json` following semantic versioning.
2. Confirm CI (tests, CodeQL) is green on `main`.
3. Tag the release; GitHub Pages is published from `docs/` automatically.
