import { readConfig, stateKey } from "./config.js";
import { notification } from "./notification.js";

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_PENDING = 12;
const MAX_BODY_BYTES = 16 * 1024;

/** Inject dependencies for offline tests. Production uses the Workers runtime. */
export function createMonitor({
  fetch: request = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  logger = console,
} = {}) {
  const timestamp = () => new Date(now()).toISOString();
  const save = (env, key, state) =>
    env.HEARTBEAT_KV.put(key, JSON.stringify(state));

  async function deliver(env, event) {
    if (now() - Date.parse(event.createdAt) >= RETRY_WINDOW_MS) {
      return "retry_window_expired";
    } else if (!env.RESEND_API_KEY) {
      return "missing_resend_api_key";
    } else {
      try {
        const response = await request("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": event.id,
          },
          body: JSON.stringify(event.payload),
          signal: AbortSignal.timeout(10000),
        });
        const accepted = response.ok;
        const status = response.status;
        await response.body?.cancel();
        if (accepted) {
          return null;
        } else {
          return `resend_http_${status}`;
        }
      } catch {
        return "resend_request_failed";
      }
    }
  }

  async function check(service, env, config) {
    const key = stateKey(service.name);
    const state = decodeState(await env.HEARTBEAT_KV.get(key), timestamp());
    const attemptedPending = state.pending.length > 0;
    if (attemptedPending) {
      state.notificationError = await deliver(env, state.pending[0]);
      if (!state.notificationError) state.pending.shift();
    }
    if (state.pending.length >= MAX_PENDING) {
      await save(env, key, state);
      return {
        ...snapshot(service, state, config, now()),
        error: "notification_backlog",
      };
    }
    const result = await probe(service, config.timeoutMs, request, now);
    state.failures = result.isUp
      ? 0
      : Math.min(state.failures + 1, config.failureThreshold);
    state.successes = result.isUp
      ? Math.min(state.successes + 1, config.successThreshold)
      : 0;
    let transition;
    if (state.state !== "DOWN" && state.failures >= config.failureThreshold) {
      state.state = "DOWN";
      transition = "DOWN";
    } else if (
      state.state === "DOWN" &&
      state.successes >= config.successThreshold
    ) {
      state.state = "UP";
      transition = "RECOVERED";
    } else if (state.state === "UNKNOWN" && result.isUp) {
      state.state = "UP"; // Establish a baseline, not a false recovery alert.
    }
    if (transition) state.lastChange = timestamp();
    state.lastChecked = timestamp();
    state.lastResult = result;
    if (transition) {
      state.pending.push({
        id: uuid(),
        createdAt: state.lastChange,
        payload: notification(
          service,
          transition,
          result,
          state.lastChange,
          config,
        ),
      });
    }
    // Persist the transition and outbox BEFORE attempting delivery.
    await save(env, key, state);
    if (!attemptedPending && transition) {
      state.notificationError = await deliver(env, state.pending[0]);
      // Do not write this key a second time within one second (KV limit).
      // Keep the event persisted: next cron safely replays its fixed key and
      // payload to Resend, then acknowledges it in that run's single KV write.
    }
    return snapshot(service, state, config, now());
  }

  async function run(env) {
    let config;
    try {
      config = readConfig(env);
      requireKV(env);
    } catch {
      logger.error(JSON.stringify({ event: "monitor_configuration_invalid" }));
      throw new Error("Invalid monitor configuration or missing KV binding");
    }
    const services = await pool(config.services, async (service) => {
      try {
        return await check(service, env, config);
      } catch {
        logger.error(
          JSON.stringify({
            event: "service_check_failed",
            service: service.name,
          }),
        );
        return {
          service: service.name,
          state: "UNKNOWN",
          error: "state_unavailable",
        };
      }
    });
    const degraded = services.some(
      (service) => service.error || service.notificationError,
    );
    logger[degraded ? "error" : "info"](
      JSON.stringify({
        event: "monitor_run",
        timestamp: timestamp(),
        degraded,
        services: services.map(
          ({ service, state, error, notificationError }) => ({
            service,
            state,
            error,
            notificationError,
          }),
        ),
      }),
    );
    return services;
  }

  return {
    run,
    scheduled(_event, env, ctx) {
      ctx.waitUntil(run(env));
    },
    async fetch(req, env) {
      const path = new URL(req.url).pathname;
      if (!["/", "/health", "/status"].includes(path))
        return json({ error: "not_found" }, 404);
      if (req.method !== "GET")
        return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
      // Liveness only: no probes, KV access, notifications, or infrastructure details.
      if (path !== "/status")
        return json({ status: "ok", worker: "home-server-heartbeat" });
      if (
        typeof env.MONITOR_TOKEN !== "string" ||
        env.MONITOR_TOKEN.length < 32
      ) {
        return json({ error: "status_not_configured" }, 503);
      }
      if (
        !(await authorized(req.headers.get("Authorization"), env.MONITOR_TOKEN))
      ) {
        return json({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }
      try {
        const config = readConfig(env);
        requireKV(env);
        const services = await pool(config.services, async (service) => {
          try {
            return snapshot(
              service,
              decodeState(
                await env.HEARTBEAT_KV.get(stateKey(service.name)),
                timestamp(),
              ),
              config,
              now(),
            );
          } catch {
            return {
              service: service.name,
              state: "UNKNOWN",
              error: "state_unavailable",
            };
          }
        });
        const healthy = services.every(
          (service) =>
            service.state === "UP" &&
            !service.stale &&
            !service.error &&
            !service.pendingNotifications,
        );
        return json(
          {
            timestamp: timestamp(),
            status: healthy ? "healthy" : "degraded",
            services,
          },
          healthy ? 200 : 503,
        );
      } catch {
        return json({ error: "monitor_not_configured" }, 503);
      }
    },
  };
}

export default createMonitor();

function requireKV(env) {
  if (!env.HEARTBEAT_KV?.get || !env.HEARTBEAT_KV?.put)
    throw new Error("Missing HEARTBEAT_KV binding");
}

export function decodeState(raw, timestamp) {
  if (raw === null || raw === undefined) {
    return {
      version: 2,
      state: "UNKNOWN",
      failures: 0,
      successes: 0,
      lastChange: timestamp,
      lastChecked: null,
      lastResult: null,
      pending: [],
      notificationError: null,
    };
  }
  const value = JSON.parse(raw);
  if (
    !value ||
    !["UP", "DOWN", "UNKNOWN"].includes(value.state) ||
    ![value.failures, value.successes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !validDate(value.lastChange) ||
    (value.version !== undefined && value.version !== 2)
  ) {
    throw new Error("Invalid stored state; operator review required");
  }
  // Existing STATE_* keys and UP/DOWN counters are preserved on first write.
  const pending = value.pending ?? [];
  if (
    !Array.isArray(pending) ||
    pending.length > MAX_PENDING ||
    pending.some(
      (event) =>
        !event ||
        typeof event.id !== "string" ||
        !/^[\w-]{1,128}$/.test(event.id) ||
        !validDate(event.createdAt) ||
        !event.payload ||
        !["from", "to", "subject", "html", "text"].every(
          (key) => typeof event.payload[key] === "string",
        ),
    )
  ) {
    throw new Error("Invalid notification outbox");
  }
  if (value.lastChecked != null && !validDate(value.lastChecked))
    throw new Error("Invalid last check");
  if (
    value.lastResult != null &&
    (typeof value.lastResult.isUp !== "boolean" ||
      !Number.isInteger(value.lastResult.statusCode) ||
      value.lastResult.statusCode < 0 ||
      value.lastResult.statusCode > 599 ||
      !Number.isFinite(value.lastResult.responseTimeMs) ||
      value.lastResult.responseTimeMs < 0 ||
      (value.lastResult.error !== null &&
        typeof value.lastResult.error !== "string"))
  )
    throw new Error("Invalid stored result");
  if (
    value.notificationError != null &&
    typeof value.notificationError !== "string"
  )
    throw new Error("Invalid delivery error");
  return {
    ...value,
    version: 2,
    pending,
    lastChecked: value.lastChecked ?? null,
    lastResult: value.lastResult ?? null,
    notificationError: value.notificationError ?? null,
  };
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function snapshot(service, state, config, now) {
  return {
    service: service.name,
    state: state.state,
    failures: state.failures,
    successes: state.successes,
    lastChange: state.lastChange,
    lastChecked: state.lastChecked,
    stale:
      !state.lastChecked ||
      now - Date.parse(state.lastChecked) > config.staleAfterMs,
    lastResult: state.lastResult,
    pendingNotifications: state.pending.length,
    notificationError: state.notificationError,
  };
}

async function authorized(header, token) {
  if (!header?.startsWith("Bearer ") || header.length > 1100) return false;
  const hash = async (value) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [provided, expected] = await Promise.all([
    hash(header.slice(7)),
    hash(token),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= provided[i] ^ expected[i];
  return difference === 0;
}

function json(data, status = 200, extra = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      ...extra,
    },
  });
}

async function pool(items, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

export async function probe(service, timeoutMs, request, now = Date.now) {
  const started = now();
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let error = null;
  try {
    response = await request(service.url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "Parmar-Monitor/2.1",
        "Cache-Control": "no-cache",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) error = `http_${response.status}`;
    else if (service.check !== "http") {
      const data = JSON.parse(await readSmallBody(response));
      const valid =
        service.check === "immich"
          ? data?.res === "pong"
          : data?.installed === true &&
            data.maintenance === false &&
            data.needsDbUpgrade === false;
      if (!valid) error = "unhealthy_payload";
    }
  } catch {
    error = signal.aborted ? "timeout" : "request_or_payload_failed";
  } finally {
    try {
      if (response?.body && !response.body.locked) await response.body.cancel();
    } catch {
      /* Already closed. */
    }
  }
  return {
    isUp: error === null,
    statusCode: response?.status ?? 0,
    responseTimeMs: Math.max(0, now() - started),
    error,
  };
}

async function readSmallBody(response) {
  if (!response.body) throw new Error("Empty body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("Health response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
