import test from "node:test";
import assert from "node:assert/strict";
import { createMonitor, decodeState, probe } from "../src/index.js";
import { DEFAULT_SERVICES, readConfig, stateKey } from "../src/config.js";
import { escapeHtml, notification } from "../src/notification.js";

const SERVICE = {
  name: "Test service",
  url: "https://service.example/health",
  check: "http",
};
const TOKEN = "0123456789abcdef0123456789abcdef";
const START = Date.parse("2026-01-01T00:00:00Z");

function harness(services = [SERVICE]) {
  const data = new Map();
  const calls = [];
  const logs = [];
  let clock = START;
  let sequence = 0;
  let healthy = true;
  let emailStatus = 200;
  let failWrite = false;
  let failRead = null;
  let emailThrows = false;
  let writesThisRun = new Set();
  const env = {
    SERVICES_JSON: JSON.stringify(services),
    MONITOR_TOKEN: TOKEN,
    RESEND_API_KEY: "test-only-not-a-real-key",
    HEARTBEAT_KV: {
      async get(key) {
        calls.push({ kind: "read", key });
        if (key === failRead) throw new Error("private error");
        return data.get(key) ?? null;
      },
      async put(key, value) {
        calls.push({ kind: "write", key });
        if (failWrite) throw new Error("private error");
        assert.equal(
          writesThisRun.has(key),
          false,
          "Only one write per service per cron run",
        );
        writesThisRun.add(key);
        data.set(key, value);
      },
    },
  };
  const monitor = createMonitor({
    now: () => clock,
    uuid: () => `event-${++sequence}`,
    logger: {
      info: (value) => logs.push(value),
      error: (value) => logs.push(value),
    },
    fetch: async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        calls.push({ kind: "email", options });
        if (emailThrows) throw new Error("private provider error");
        return new Response("provider-private-details", {
          status: emailStatus,
        });
      }
      assert.ok(
        services.some((service) => service.url === url),
        "No unexpected or real network requests",
      );
      calls.push({ kind: "probe", url, options });
      return new Response("ok", { status: healthy ? 200 : 503 });
    },
  });
  return {
    monitor,
    env,
    data,
    calls,
    logs,
    set healthy(value) {
      healthy = value;
    },
    set emailStatus(value) {
      emailStatus = value;
    },
    set failWrite(value) {
      failWrite = value;
    },
    set failRead(value) {
      failRead = value;
    },
    set emailThrows(value) {
      emailThrows = value;
    },
    advance(ms) {
      clock += ms;
    },
    async run() {
      writesThisRun = new Set();
      const result = await monitor.run(env);
      clock += 300000;
      return result;
    },
    state(name = SERVICE.name) {
      return JSON.parse(data.get(stateKey(name)));
    },
    fetch(path = "/status", token = TOKEN, method = "GET") {
      return monitor.fetch(
        new Request(`https://worker.example${path}`, {
          method,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        env,
      );
    },
    emails() {
      return calls.filter((call) => call.kind === "email");
    },
  };
}

test("healthy baseline starts UNKNOWN, becomes UP without a recovery email", async () => {
  const h = harness();
  assert.equal((await (await h.fetch()).json()).services[0].state, "UNKNOWN");
  assert.equal((await h.run())[0].state, "UP");
  assert.equal(h.emails().length, 0);
  assert.equal((await h.fetch()).status, 200);
});

test("three consecutive failures emit one outage; two successes emit recovery", async () => {
  const h = harness();
  h.healthy = false;
  assert.equal((await h.run())[0].state, "UNKNOWN");
  assert.equal((await h.run())[0].state, "UNKNOWN");
  assert.equal((await h.run())[0].state, "DOWN");
  assert.equal(h.state().pending.length, 1);
  assert.equal(h.emails().length, 1);
  const first = h.emails()[0];
  assert.ok(
    h.calls.findIndex((call) => call.kind === "write") < h.calls.indexOf(first),
  );
  await h.run(); // Replays the same request, then durably acknowledges it.
  assert.deepEqual(h.emails()[1].options, {
    ...first.options,
    signal: h.emails()[1].options.signal,
  });
  assert.equal(h.state().pending.length, 0);
  for (let i = 0; i < 4; i++) await h.run();
  assert.equal(
    h.emails().length,
    2,
    "Sustained downtime produces no new incident emails",
  );
  h.healthy = true;
  assert.equal((await h.run())[0].state, "DOWN");
  assert.equal((await h.run())[0].state, "UP");
  assert.match(JSON.parse(h.emails().at(-1).options.body).subject, /RECOVERED/);
  assert.notEqual(
    h.emails().at(-1).options.headers["Idempotency-Key"],
    first.options.headers["Idempotency-Key"],
  );
});

test("intermittent results reset consecutive counters and counters are bounded", async () => {
  const h = harness();
  await h.run();
  h.healthy = false;
  await h.run();
  await h.run();
  h.healthy = true;
  await h.run();
  h.healthy = false;
  await h.run();
  assert.equal(h.state().failures, 1);
  assert.equal(h.state().successes, 0);
  for (let i = 0; i < 5; i++) await h.run();
  assert.equal(h.state().failures, 3);
});

test("failed provider response retries the exact original payload despite changed configuration", async () => {
  const h = harness();
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  h.emailStatus = 429;
  assert.equal((await h.run())[0].notificationError, "resend_http_429");
  const first = h.emails()[0].options;
  h.env.NOTIFY_EMAIL = "changed@example.com";
  h.env.FROM_EMAIL = "changed-sender@example.com";
  h.emailStatus = 200;
  await h.run();
  assert.equal(h.emails()[1].options.body, first.body);
  assert.equal(
    h.emails()[1].options.headers["Idempotency-Key"],
    first.headers["Idempotency-Key"],
  );
  assert.equal(h.state().pending.length, 0);
  assert.ok(!h.logs.join().includes("provider-private-details"));
});

test("missing Resend secret queues alerts without sending; adding it drains pending", async () => {
  const h = harness();
  delete h.env.RESEND_API_KEY;
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  assert.equal((await h.run())[0].notificationError, "missing_resend_api_key");
  assert.equal(h.emails().length, 0);
  assert.equal(h.state().pending.length, 1);
  h.env.RESEND_API_KEY = "test-key";
  await h.run();
  assert.equal(h.state().pending.length, 0);
});

test("network failure keeps the outbox and does not expose provider errors", async () => {
  const h = harness();
  h.emailThrows = true;
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  assert.equal((await h.run())[0].notificationError, "resend_request_failed");
  assert.equal(h.state().pending.length, 1);
  assert.ok(!h.logs.join().includes("private provider error"));
});

test("recovery is queued behind a failed outage notification", async () => {
  const h = harness();
  h.env.FAILURE_THRESHOLD = "1";
  h.env.SUCCESS_THRESHOLD = "1";
  h.healthy = false;
  h.emailStatus = 500;
  await h.run();
  h.healthy = true;
  await h.run();
  assert.equal(h.state().state, "UP");
  assert.equal(h.state().pending.length, 2);
  h.emailStatus = 200;
  await h.run();
  await h.run();
  assert.match(JSON.parse(h.emails().at(-1).options.body).subject, /RECOVERED/);
  assert.equal(h.state().pending.length, 0);
});

test("events outside the safe retry window remain visible, but are not resent", async () => {
  const h = harness();
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  await h.run();
  h.advance(23 * 60 * 60 * 1000);
  assert.equal((await h.run())[0].notificationError, "retry_window_expired");
  assert.equal(h.emails().length, 1);
  assert.equal(h.state().pending.length, 1);
  assert.equal((await h.fetch()).status, 503);
});

test("a full outbox is retained and pauses only that service, without unbounded growth", async () => {
  const h = harness();
  h.env.FAILURE_THRESHOLD = "1";
  h.env.SUCCESS_THRESHOLD = "1";
  h.emailStatus = 500;
  for (let i = 0; i < 12; i++) {
    h.healthy = i % 2 !== 0;
    await h.run();
  }
  assert.equal(h.state().pending.length, 12);
  const lastChecked = h.state().lastChecked;
  assert.equal((await h.run())[0].error, "notification_backlog");
  assert.equal(h.state().lastChecked, lastChecked);
  h.emailStatus = 200;
  await h.run();
  assert.notEqual(h.state().lastChecked, lastChecked);
});

test("failed KV persistence prevents new email delivery", async () => {
  const h = harness();
  h.failWrite = true;
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  assert.equal((await h.run())[0].error, "state_unavailable");
  assert.equal(h.emails().length, 0);
});

test("accepted delivery followed by failed KV acknowledgement safely replays", async () => {
  const h = harness();
  h.env.FAILURE_THRESHOLD = "1";
  h.healthy = false;
  await h.run();
  const original = h.emails()[0].options;
  h.failWrite = true;
  await h.run();
  h.failWrite = false;
  await h.run();
  for (const call of h.emails()) {
    assert.equal(call.options.body, original.body);
    assert.equal(
      call.options.headers["Idempotency-Key"],
      original.headers["Idempotency-Key"],
    );
  }
  assert.equal(h.state().pending.length, 0);
});

test("legacy state migrates without resetting DOWN or counters", async () => {
  const h = harness();
  h.data.set(
    stateKey(SERVICE.name),
    JSON.stringify({
      state: "DOWN",
      failures: 3,
      successes: 1,
      lastChange: new Date(START).toISOString(),
    }),
  );
  await h.run();
  assert.equal(h.state().version, 2);
  assert.equal(h.state().state, "UP");
  assert.match(JSON.parse(h.emails()[0].options.body).subject, /RECOVERED/);
});

test("corrupt or unreadable state is isolated; other services still run", async () => {
  const second = { ...SERVICE, name: "Other", url: "https://other.example/" };
  const h = harness([SERVICE, second]);
  h.data.set(stateKey(SERVICE.name), "not-json");
  const results = await h.run();
  assert.equal(results[0].error, "state_unavailable");
  assert.equal(results[1].state, "UP");
  assert.equal(
    h.data.get(stateKey(SERVICE.name)),
    "not-json",
    "Do not silently overwrite corrupt production data",
  );
  h.failRead = stateKey(second.name);
  assert.ok((await h.run()).every((result) => result.error));
  assert.equal((await h.fetch()).status, 503);
});

test("public routes never read/write KV, probe endpoints, or expose details", async () => {
  const h = harness();
  for (const path of ["/", "/health"]) {
    const response = await h.fetch(path, null);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(await response.json(), {
      status: "ok",
      worker: "home-server-heartbeat",
    });
  }
  assert.equal(h.calls.length, 0);
});

test("status is authenticated, read-only, and does not leak secret/provider payloads", async () => {
  const h = harness();
  assert.equal((await h.fetch("/status", null)).status, 401);
  assert.equal((await h.fetch("/status", "wrong")).status, 401);
  assert.equal((await h.fetch("/status", "x".repeat(2000))).status, 401);
  assert.equal(h.calls.length, 0);
  await h.run();
  const writes = h.calls.filter((call) => call.kind !== "read").length;
  const response = await h.fetch();
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes(h.env.RESEND_API_KEY));
  assert.ok(!text.includes(SERVICE.url));
  assert.ok(!text.includes("payload"));
  assert.equal(h.calls.filter((call) => call.kind !== "read").length, writes);
});

test("missing/short status token disables detailed status", async () => {
  const h = harness();
  delete h.env.MONITOR_TOKEN;
  assert.equal((await h.fetch()).status, 503);
  h.env.MONITOR_TOKEN = "short";
  assert.equal((await h.fetch()).status, 503);
  assert.equal(h.calls.length, 0);
});

test("unknown routes and HTTP writes are rejected without side effects", async () => {
  const h = harness();
  assert.equal((await h.fetch("/check")).status, 404);
  const response = await h.fetch("/status", TOKEN, "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
  assert.equal(h.calls.length, 0);
});

test("status marks missing, DOWN, or stale observations degraded", async () => {
  const h = harness();
  assert.equal((await h.fetch()).status, 503);
  await h.run();
  h.advance(900001);
  const response = await h.fetch();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).services[0].stale, true);
  h.healthy = false;
  h.env.FAILURE_THRESHOLD = "1";
  await h.run();
  assert.equal((await h.fetch()).status, 503);
});

test("invalid configuration fails closed without performing probes", async () => {
  const h = harness();
  h.env.REQUEST_TIMEOUT_MS = "oops";
  await assert.rejects(h.monitor.run(h.env));
  assert.equal((await h.fetch()).status, 503);
  assert.equal(h.calls.length, 0);
  delete h.env.REQUEST_TIMEOUT_MS;
  delete h.env.HEARTBEAT_KV;
  await assert.rejects(h.monitor.run(h.env));
  assert.equal((await h.fetch()).status, 503);
});

test("cron attaches work to waitUntil", async () => {
  const h = harness();
  let work;
  h.monitor.scheduled({}, h.env, {
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  assert.equal(h.state().state, "UP");
});

test("service checks use bounded concurrency, preserving service order", async () => {
  const services = Array.from({ length: 9 }, (_, i) => ({
    name: `Service ${i}`,
    url: `https://example.com/${i}`,
  }));
  const h = harness(services);
  let active = 0;
  let maximum = 0;
  const monitor = createMonitor({
    logger: { info() {}, error() {} },
    fetch: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return new Response("ok");
    },
  });
  const results = await monitor.run(h.env);
  assert.equal(maximum, 4);
  assert.deepEqual(
    results.map((result) => result.service),
    services.map((service) => service.name),
  );
});

test("probes reject redirects, HTTP errors, network failures, and malformed/oversized JSON", async () => {
  for (const status of [301, 302, 401, 403, 429, 500, 503]) {
    const result = await probe(SERVICE, 1000, async (_url, options) => {
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal);
      return new Response("error", { status });
    });
    assert.equal(result.isUp, false);
    assert.equal(result.error, `http_${status}`);
  }
  const network = await probe(SERVICE, 1000, async () => {
    throw new Error("private network details");
  });
  assert.equal(network.statusCode, 0);
  assert.equal(network.error, "request_or_payload_failed");
  for (const body of [
    "html login page",
    "",
    "null",
    JSON.stringify({ res: "nope" }),
    "x".repeat(17000),
  ]) {
    assert.equal(
      (
        await probe(
          { ...SERVICE, check: "immich" },
          1000,
          async () => new Response(body),
        )
      ).isUp,
      false,
    );
  }
});

test("timeouts abort outbound requests", async () => {
  // Keep the Node event loop alive: AbortSignal.timeout's timer is unref'ed.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await probe(
      SERVICE,
      10,
      async (_url, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    assert.equal(result.error, "timeout");
  } finally {
    clearInterval(keepAlive);
  }
});

test("application probes distinguish real health from a successful maintenance page", async () => {
  assert.equal(
    (
      await probe({ ...SERVICE, check: "immich" }, 1000, async () =>
        Response.json({ res: "pong" }),
      )
    ).isUp,
    true,
  );
  for (const fields of [
    { installed: true, maintenance: false, needsDbUpgrade: false },
    { installed: true, maintenance: true, needsDbUpgrade: false },
    { installed: true, maintenance: false, needsDbUpgrade: true },
    { installed: false, maintenance: false, needsDbUpgrade: false },
  ]) {
    const result = await probe(
      { ...SERVICE, check: "nextcloud" },
      1000,
      async () => Response.json(fields),
    );
    assert.equal(
      result.isUp,
      fields.installed && !fields.maintenance && !fields.needsDbUpgrade,
    );
  }
});

test("health JSON may be streamed across chunks", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"res":'));
      controller.enqueue(new TextEncoder().encode('"pong"}'));
      controller.close();
    },
  });
  assert.equal(
    (
      await probe(
        { ...SERVICE, check: "immich" },
        1000,
        async () => new Response(stream),
      )
    ).isUp,
    true,
  );
});

test("configuration preserves production names/keys and validates custom endpoints", () => {
  assert.deepEqual(readConfig({}).services, DEFAULT_SERVICES);
  assert.equal(stateKey("Photos (Immich)"), "STATE_Photos__Immich_");
  assert.equal(
    readConfig({
      SERVICES_JSON: JSON.stringify([{ ...SERVICE, check: undefined }]),
    }).services[0].check,
    "http",
  );
  for (const SERVICES_JSON of [
    "not-json",
    "null",
    "[]",
    JSON.stringify(Array(21).fill(SERVICE)),
    JSON.stringify([SERVICE, SERVICE]),
    JSON.stringify([
      { ...SERVICE, name: "A-B" },
      { ...SERVICE, name: "A B" },
    ]),
    ...[
      "http://example.com",
      "https://user:password@example.com",
      "https://example.com/#secret",
      "not-a-url",
    ].map((url) => JSON.stringify([{ ...SERVICE, url }])),
    ...[
      null,
      { ...SERVICE, name: "" },
      { ...SERVICE, name: "bad\nname" },
      { ...SERVICE, check: "unsupported" },
    ].map((service) => JSON.stringify([service])),
  ])
    assert.throws(() => readConfig({ SERVICES_JSON }));
  for (const config of [
    { FAILURE_THRESHOLD: "0" },
    { SUCCESS_THRESHOLD: "1.5" },
    { REQUEST_TIMEOUT_MS: "30001" },
    { STALE_AFTER_MS: "1" },
    { NOTIFY_EMAIL: "bad" },
    { FROM_EMAIL: "x\r\n@example.com" },
  ])
    assert.throws(() => readConfig(config));
});

test("corrupt persisted data fails closed rather than resetting counters", () => {
  const base = {
    state: "UP",
    failures: 0,
    successes: 1,
    lastChange: new Date(START).toISOString(),
  };
  for (const value of [
    null,
    [],
    { ...base, version: 99 },
    { ...base, failures: -1 },
    { ...base, state: "BAD" },
    { ...base, lastChange: "invalid" },
    { ...base, lastChecked: "bad" },
    {
      ...base,
      lastResult: {
        isUp: true,
        statusCode: 999,
        responseTimeMs: 5,
        error: null,
      },
    },
    { ...base, notificationError: { private: "details" } },
    { ...base, pending: {} },
    { ...base, pending: [null] },
    {
      ...base,
      pending: [{ id: "bad\r\n", createdAt: base.lastChange, payload: {} }],
    },
  ]) {
    assert.throws(() => decodeState(JSON.stringify(value), base.lastChange));
  }
});

test("emails include escaped HTML, plain text and a deterministic UTC timestamp", () => {
  const service = {
    name: "<script>\"&'</script>",
    url: "https://example.com/?a=1&b=2",
  };
  const payload = notification(
    service,
    "DOWN",
    { statusCode: 0, responseTimeMs: 50, error: "timeout" },
    "2026-01-01T00:00:00.000Z",
    readConfig({}),
  );
  assert.ok(!payload.html.includes("<script>"));
  assert.match(payload.html, /&lt;script&gt;/);
  assert.match(payload.html, /a=1&amp;b=2/);
  assert.match(payload.text, /timeout/);
  assert.match(payload.html, /2026-01-01T00:00:00.000Z/);
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  assert.match(
    notification(
      SERVICE,
      "RECOVERED",
      { statusCode: 200, responseTimeMs: 1, error: null },
      "2026-01-01",
      readConfig({}),
    ).text,
    /Service restored/,
  );
});
