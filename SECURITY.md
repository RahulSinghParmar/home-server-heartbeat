# Security policy

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/RahulSinghParmar/home-server-heartbeat/security/advisories/new), if enabled. Otherwise contact the maintainer through the profile contact details. Do not publish credentials or private infrastructure information in issues.

Security fixes target the latest code on `main`; there is no guaranteed response time or long-term support policy.

## Threat model

- The Worker URL is public. `/` and `/health` only report process liveness; `/status` requires a bearer token of at least 32 characters. No HTTP route starts checks or sends email.
- Keep `RESEND_API_KEY` and `MONITOR_TOKEN` in Cloudflare secrets. Never put them in `wrangler.json`, issue reports, screenshots, or URLs. Rotate either secret if exposed.
- Configuration and KV are trusted administrative inputs. Anyone able to change `SERVICES_JSON` can cause outbound HTTPS requests; this is not a multi-tenant monitoring API. Endpoint URLs must not contain credentials, query-string secrets, or access tokens.
- Email includes the configured endpoint URL, service name, and detection time. KV contains email payloads and recipient addresses until acknowledgement. Restrict Cloudflare account access accordingly.
- Service probes never follow redirects. A Cloudflare Access redirect is a failed probe, not proof the origin is down. Use an appropriate dedicated health endpoint or a future scoped Access integration; do not disable Access globally.
- Runtime logs contain event names, service names, and generic failure codes, not bearer tokens, raw exception messages, provider responses, or email payloads.

## Limits

This is a small, best-effort HTTP monitor, not an SLA, security scanner, intrusion detector, or complete backup strategy. KV is eventually consistent and does not provide atomic locks. Keep exactly one production cron writer. Idempotent email retries reduce duplicate delivery but cannot guarantee exactly-once notifications under overlapping invocations or a prolonged outage. See [operations](docs/OPERATIONS.md) for recovery procedures.
