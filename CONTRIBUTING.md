# Contributing

Use Node.js 22 or newer, create a branch, then run:

```sh
npm ci
npm test
npm run check
npm run build
```

`npm run format` applies the repository formatter. Tests mock HTTP, time, and KV: they must never contact the maintainer's real services or send real alerts. Add regression tests for state transitions, delivery changes, and security-sensitive routes.

Use `npm run preview` for a local email preview with synthetic data. See [operations](docs/OPERATIONS.md) before testing Cron Triggers: `wrangler dev --local` isolates KV, but outbound HTTP requests can still reach real services.

Keep changes focused. Explain configuration, state migration, cost, and rollback implications in the pull request. Never commit `.dev.vars`, credentials, production KV exports, or screenshots containing secrets. Discuss licensing with the maintainer before substantial third-party contributions; no open-source license has been selected for this repository yet.
