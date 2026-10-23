# Changelog

## 2.1.0 — pending production rollout

### Security

- Removed side effects from HTTP requests: public liveness and authenticated, cached status replace the old public trigger endpoint.
- Added no-store/security headers, ignored local secret files, validated configuration, escaped email HTML, and sanitized runtime error reporting.

### Reliability

- Added a persistent notification outbox with fixed Resend idempotency keys/payloads, bounded retries, ordered incident/recovery messages, and visible delivery errors.
- Limited KV writes to one per service per scheduled invocation. Newly created alerts are attempted immediately and acknowledged on the following cron after an idempotent replay.
- Added bounded concurrency, request timeouts, redirect rejection, bounded JSON validation for Immich/Nextcloud, counter limits, stale-status detection, and per-service fault isolation.
- Preserved the production KV binding, legacy state key convention, service addresses, cron expression, thresholds, and compatibility date. Legacy counters migrate on their next successful write.

### Maintenance

- Updated Wrangler from v3 to pinned v4 tooling, added a lockfile and formatter, offline regression tests, CI, CodeQL, and dependency update configuration.
- Added configuration, operations, migration, rollback, security, and contribution documentation, plus an architecture image and reproducible synthetic email preview.

### Deployment notes

- Set `MONITOR_TOKEN` for the new `/status` endpoint; update any clients that depended on GET-triggered checks. There is intentionally no HTTP replacement for manual production checks.
- Confirm the existing Immich endpoint and Nextcloud status payload before rollout: validation is stricter, and redirects no longer count as healthy.
- Review KV quota: four services checked every five minutes require approximately 1,152 writes/day, exceeding the currently documented free KV allowance. See [operations](docs/OPERATIONS.md).
- Production deployment, real alert delivery, and historical uptime have not been validated by offline tests.
