# Operations and deployment

## Before deploying

1. Run `npm ci`, `npm test`, `npm run check`, and `npm run build` with Node 22+.
2. Confirm the target Cloudflare account and existing `HEARTBEAT_KV` binding in `wrangler.json`. The namespace ID is an identifier, not a secret. Forks must create their own namespace and replace it; never use the maintainer's namespace.
3. Check Workers Builds in the Cloudflare dashboard. A GitHub integration may deploy `main` automatically; this repository's GitHub Actions only test/build and do not deploy. Pause or restrict an existing automatic deployment until these migration steps are ready.
4. Keep one production writer: this Worker's single five-minute Cron Trigger. Do not point staging, preview Workers, or manual scheduled tests at production KV.
5. Confirm each endpoint's actual response. Immich currently uses the **existing** `/api/server-info/ping` address and expects `{"res":"pong"}`. Recent installations may use `/api/server/ping`; confirm against your installed version and override the URL using `SERVICES_JSON` if needed. Nextcloud must return `installed: true`, `maintenance: false`, and `needsDbUpgrade: false`. A login redirect, maintenance page, or schema change can now trigger an alert instead of a false healthy result.
6. Confirm the sender domain is verified in Resend, the recipient is correct, and the account permits sending to it. Store secrets interactively, not in shell arguments or committed files:

   ```sh
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put MONITOR_TOKEN
   ```

   Use a randomly generated `MONITOR_TOKEN` of at least 32 characters. Optional variables are listed in the [README](../README.md). Do not replace an existing valid Resend secret unnecessarily.

7. Review the quota section below. Deploy deliberately with `npm run deploy`, or your existing reviewed Workers Builds pipeline. This command changes the live Worker; `npm run build` does not.
8. Verify `/health`, then authenticated `/status`; wait for the next scheduled run. Review Worker logs for `monitor_run` and `service_check_failed`. Inspect `lastChecked`, `stale`, and `notificationError` rather than assuming a successful deployment proves monitoring works. Confirm one real outage/recovery notification only in an approved maintenance window or an isolated staging deployment.

## HTTP interface

| Request                                                    | Meaning                                                                | Status                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /` or `GET /health`                                   | Worker responds; no KV reads or service probes                         | 200                                                      |
| `GET /status` with valid bearer token                      | Cached observations, counters, latency, freshness, pending alert count | 200 when all UP, fresh, no pending alerts; otherwise 503 |
| `GET /status` without valid token                          | No infrastructure details disclosed                                    | 401                                                      |
| `GET /status` without a configured token of 32+ characters | Detailed status disabled                                               | 503                                                      |
| Other path / non-GET method on a known route               | Not found / method not allowed                                         | 404 / 405                                                |

Set the `Authorization: Bearer <MONITOR_TOKEN>` header in your HTTP client, not a query parameter. Do not paste a real token into public examples or screenshots. `/status` never refreshes observations or sends email. New deployments can report UNKNOWN/stale until a cron has completed, and KV propagation may briefly lag. A pending outbox event can cause 503 even after the provider accepted the first attempt, until its next-cron acknowledgement.

## Safe local testing

`npm test` is entirely offline and uses mocked requests/KV. `npm run build` creates a dry-run Worker bundle, without deployment. `npm run preview` serves synthetic outage/recovery emails at `http://127.0.0.1:8789` and makes no outbound requests.

For runtime development, copy `.dev.vars.example` to ignored `.dev.vars`, override **all** endpoints with controlled test services using `SERVICES_JSON`, and leave `RESEND_API_KEY` unset. Run `npm run dev`. The normal HTTP routes are read-only. Wrangler's local scheduled-event test route executes real outbound probes, so only use it after checking the override. Local KV is separate; outbound traffic is **not** automatically mocked. Never use `--remote` for an unreviewed test.

For staging, use a separate Worker name, KV namespace, recipient, token, and controlled endpoints. Do not upload the production `wrangler.json` unchanged as a staging setup.

## State and delivery semantics

- Keys remain `STATE_` plus the service name with non-word characters replaced by `_`. Renaming a service creates a new identity and leaves the old key behind. Duplicate/colliding names are rejected.
- Legacy UP/DOWN records are read without resetting counters. Successful checks write version-2 records. Missing state starts UNKNOWN; its first healthy response establishes UP without a recovery email. Three initial failures still produce an outage alert.
- Each service is processed independently, with at most four service tasks in flight. A malformed/unreadable KV record is preserved for operator review, rather than silently reset.
- Three consecutive failures confirm DOWN; two consecutive successes after DOWN confirm RECOVERED. With five-minute cron and no execution delays, detection is approximately 10–15 minutes after an outage and 5–10 minutes after recovery, plus request/delivery time. These are not real-time guarantees or exact incident start times.
- A transition and its complete email payload are persisted **before** its first send. A new event is attempted immediately if no older event was attempted in that run. Existing events are retried oldest-first, at most one send per service per run. Sustained downtime does not create new events.
- Each invocation writes a service's KV key at most once. After an immediate send, the queued event stays persisted. The next cron repeats the identical request using the same `Idempotency-Key`, then acknowledges it in that run's write. Changing sender/recipient configuration does not alter an already queued payload.
- Resend's [idempotency window is 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). The Worker stops resending an event 23 hours after creation, leaving it pending with `retry_window_expired` for operator review. This avoids automatically replaying old events outside the deduplication window. It does not guarantee delivery.
- A failed outage notification does not erase a later recovery: both queue in order. A queue of 12 pending events pauses probing for that service until an event can drain or an operator resolves the backlog. Other services continue. The cached check becomes stale.
- Error codes include `missing_resend_api_key`, `resend_http_429`, `resend_http_5xx` (the actual numeric code), `resend_request_failed`, and `retry_window_expired`. Fresh post-send errors are logged/returned to the scheduled runner; because there is no second KV write, cached status may show only a pending event until the following cron.

KV is [eventually consistent, with last-write-wins concurrency](https://developers.cloudflare.com/kv/api/write-key-value-pairs/). This design is for one scheduled writer, not exactly-once distributed execution. An overlapping cron or stale read can still affect counters/events. A Durable Object coordinator plus a dedicated notification queue is the next architectural step if strict serialization, many services, or stronger delivery guarantees become necessary; it is not silently added to this small Worker.

## Quota and cost

The original “zero-cost” claim is not a guarantee. This implementation writes the latest snapshot once per service per cron: `services × runs/day`. Four services at five minutes means **1,152 KV writes/day**, plus status reads and provider email usage. Cloudflare currently documents [1,000 writes/day on free KV and one write/second per key](https://developers.cloudflare.com/kv/platform/limits/).

Check your actual plan and other Workers sharing the account. Options include a paid KV plan or a ten-minute cron (`*/10 * * * *`, approximately 576 writes/day for four services), with correspondingly slower detection and a longer `STALE_AFTER_MS` such as `1800000`. The production cron is intentionally preserved; choose the tradeoff before rollout. Provider limits, availability, and pricing can change.

## Incident runbook

| Symptom                                     | Safe investigation                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health` works, `/status` is stale         | Check Cron Trigger configuration, last execution/logs, KV binding/quota, and invalid configuration. Public liveness does not verify cron.                                                                                                                                                                                                                                                                                                                                        |
| Unexpected DOWN                             | Check HTTP status, redirect/Cloudflare Access, timeout, maintenance response, and installed app API version from an authorized client. Do not simply lower thresholds or accept login pages as healthy.                                                                                                                                                                                                                                                                          |
| `missing_resend_api_key` / provider 401/403 | Verify the secret, verified sender domain, and recipient permissions. Do not expose the key in logs.                                                                                                                                                                                                                                                                                                                                                                             |
| Provider 429 / request failure              | Review provider quotas/status. Pending events retry on later crons within their safe window.                                                                                                                                                                                                                                                                                                                                                                                     |
| `state_unavailable`                         | Check binding, KV quota, record shape/version, and access permissions. Preserve the record before any repair.                                                                                                                                                                                                                                                                                                                                                                    |
| Expired outbox or full backlog              | Pause the one production cron, securely export the specific affected record, and review Resend's delivery history for each event ID. Do not blindly replay after 24 hours. If delivered or intentionally discarded, remove only the reviewed event from `pending`; preserve counters and other queued events. Clear `notificationError` only after resolving the cause, write the repaired record once, then resume cron. Never delete the entire namespace or commit an export. |

Monitor the monitor: an independent checker should authenticate to `/status` and alert on stale/degraded observations. Without an independent path, a stopped Worker cannot email you about its own failure. Do not connect that checker to a side-effecting scheduled test endpoint.

## Rollback

Record the previous Worker deployment/version before rollout. If needed, pause the cron and restore that version through Cloudflare's deployment history. Version-2 records retain the old `state`, `failures`, `successes`, and `lastChange` fields, but the old Worker ignores `pending`; rolling back can abandon queued alerts and re-expose the old public trigger. Review/export pending records privately first and restrict the old public endpoint. Restore the reviewed version/configuration when ready; do not erase production KV as a rollback step.
