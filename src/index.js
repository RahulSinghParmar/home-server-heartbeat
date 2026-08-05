/**
 * ==========================================================
 * Parmar Home Infrastructure Monitor
 * Cloudflare Worker + KV + Resend
 * Version 2.0
 * ==========================================================
 */

const CONFIG = {
  notifyEmail: "rahulsinghparmar4@gmail.com",
  fromEmail: "alerts@parmar.homes",

  failureThreshold: 3,
  successThreshold: 2,

  requestTimeoutMs: 10000
};

const SERVICES = [
  {
    name: "Photos (Immich)",
    url: "https://photos.parmar.homes/api/server-info/ping"
  },
  {
    name: "Drive (Nextcloud)",
    url: "https://drive.parmar.homes/status.php"
  },
  {
    name: "Vaultwarden Passwords",
    url: "https://pass.parmar.homes/alive"
  },
  {
    name: "Glance Dashboard",
    url: "https://dash.parmar.homes"
  }
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthChecks(env));
  },

  async fetch(request, env) {
    const results = await runHealthChecks(env);

    return Response.json({
      timestamp: new Date().toISOString(),
      worker: "Parmar Home Infrastructure Monitor",
      services: results
    });
  }
};

/**
 * ----------------------------------------------------------
 * Main Health Check Runner
 * ----------------------------------------------------------
 */

async function runHealthChecks(env) {
  const results = [];

  for (const service of SERVICES) {
    const result = await checkService(service, env);
    results.push(result);
  }

  return results;
}

/**
 * ----------------------------------------------------------
 * Individual Service Check
 * ----------------------------------------------------------
 */

async function checkService(service, env) {
  const kvKey = createStateKey(service.name);

  const state = await getServiceState(env, kvKey);

  const checkResult = await performRequest(service.url);

  updateCounters(state, checkResult.isUp);

  const transition = detectStateTransition(state);

  if (transition) {
    await sendStatusNotification(
      env,
      service,
      transition,
      checkResult,
      state
    );
  }

  await saveServiceState(env, kvKey, state);

  return {
    service: service.name,
    state: state.state,
    failures: state.failures,
    successes: state.successes,
    statusCode: checkResult.statusCode,
    responseTime: `${checkResult.responseTime}ms`
  };
}

/**
 * ----------------------------------------------------------
 * HTTP Request Handler
 * ----------------------------------------------------------
 */

async function performRequest(url) {
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Parmar-Monitor/2.0"
      },
      signal: AbortSignal.timeout(
        CONFIG.requestTimeoutMs
      )
    });

    return {
      isUp:
        response.ok ||
        (
          response.status >= 300 &&
          response.status < 400
        ),
      statusCode: response.status,
      responseTime: Date.now() - started,
      error: null
    };
  } catch (error) {
    return {
      isUp: false,
      statusCode: 0,
      responseTime: Date.now() - started,
      error: error.message
    };
  }
}

/**
 * ----------------------------------------------------------
 * KV State Management
 * ----------------------------------------------------------
 */

async function getServiceState(env, key) {
  const stored =
    await env.HEARTBEAT_KV.get(key);

  if (stored) {
    return JSON.parse(stored);
  }

  return {
    state: "UP",
    failures: 0,
    successes: 0,
    lastChange:
      new Date().toISOString()
  };
}

async function saveServiceState(env, key, state) {
  await env.HEARTBEAT_KV.put(
    key,
    JSON.stringify(state)
  );
}

function createStateKey(serviceName) {
  return `STATE_${serviceName.replace(
    /\W/g,
    "_"
  )}`;
}

/**
 * ----------------------------------------------------------
 * Status Logic
 * ----------------------------------------------------------
 */

function updateCounters(state, isUp) {
  if (isUp) {
    state.successes++;
    state.failures = 0;
  } else {
    state.failures++;
    state.successes = 0;
  }
}

function detectStateTransition(state) {
  if (
    state.state === "UP" &&
    state.failures >=
      CONFIG.failureThreshold
  ) {
    state.state = "DOWN";
    state.lastChange =
      new Date().toISOString();

    return "DOWN";
  }

  if (
    state.state === "DOWN" &&
    state.successes >=
      CONFIG.successThreshold
  ) {
    state.state = "UP";
    state.lastChange =
      new Date().toISOString();

    return "RECOVERED";
  }

  return null;
}

/**
 * ----------------------------------------------------------
 * Notifications
 * ----------------------------------------------------------
 */

async function sendStatusNotification(
  env,
  service,
  transition,
  result,
  state
) {
  const subject =
    transition === "DOWN"
      ? `🔴 ALERT: ${service.name} is DOWN`
      : `🟢 RECOVERED: ${service.name} is ONLINE`;

  const html = buildEmailTemplate({
    service,
    transition,
    result,
    state
  });

  await sendEmail(
    env,
    subject,
    html
  );
}

async function sendEmail(
  env,
  subject,
  html
) {
  try {
    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          from: CONFIG.fromEmail,
          to: CONFIG.notifyEmail,
          subject,
          html
        })
      }
    );

    if (!response.ok) {
      console.error(
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      "Resend Error:",
      error
    );
  }
}

/**
 * ----------------------------------------------------------
 * Email Template
 * ----------------------------------------------------------
 */

function buildEmailTemplate(data) {
  const isDown =
    data.transition === "DOWN";

  const color = isDown
    ? "#dc2626"
    : "#16a34a";

  const icon = isDown
    ? "🔴"
    : "🟢";

  const title = isDown
    ? "Service Outage Detected"
    : "Service Restored";

  return `

<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
</head>

<body style="margin:0;background:#0f172a;font-family:Segoe UI,Arial,sans-serif;">

<div style="max-width:720px;margin:40px auto;background:#111827;border-radius:16px;overflow:hidden;color:#ffffff;">

<div style="background:${color};padding:24px;">
<h1 style="margin:0;">
${icon} ${title}
</h1>

<p style="margin-top:10px;">
Parmar Home Infrastructure Monitor
</p>
</div>

<div style="padding:30px;">

<table width="100%" cellpadding="8">

<tr>
<td><strong>Service</strong></td>
<td>${data.service.name}</td>
</tr>

<tr>
<td><strong>Status</strong></td>
<td>${data.transition}</td>
</tr>

<tr>
<td><strong>URL</strong></td>
<td>${data.service.url}</td>
</tr>

<tr>
<td><strong>HTTP Status</strong></td>
<td>${data.result.statusCode}</td>
</tr>

<tr>
<td><strong>Response Time</strong></td>
<td>${data.result.responseTime} ms</td>
</tr>

<tr>
<td><strong>Timestamp</strong></td>
<td>${new Date().toLocaleString("en-IN")}</td>
</tr>

</table>

</div>

<div style="background:#0b1220;padding:20px;text-align:center;color:#94a3b8;font-size:12px;">
Docker Desktop • Cloudflare Workers • KV • Resend • Traefik
</div>

</div>

</body>
</html>
`;
}
