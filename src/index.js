/**
 * Cloudflare Worker: Home Server Heartbeat Monitor (Parallel Execution Fix)
 */

const SERVICES_TO_MONITOR = [
  { name: "Photos (Immich)", url: "https://photos.parmar.homes" },
  { name: "Drive (Nextcloud)", url: "https://drive.parmar.homes" },
  { name: "Vaultwarden Passwords", url: "https://pass.parmar.homes" },
  { name: "Glance Dashboard", url: "https://dash.parmar.homes" }
];

const NOTIFY_EMAIL = "rahulsinghparmar4@gmail.com";
const FROM_EMAIL = "alerts@parmar.homes";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthCheck(env));
  },

  async fetch(request, env, ctx) {
    const results = await runHealthCheck(env);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

async function checkSingleService(service, env) {
  let isUp = false;
  let statusCode = 0;
  let responseTime = 0;

  const startTime = Date.now();
  try {
    // Lower timeout to 4 seconds to prevent Worker socket choking
    const response = await fetch(service.url, {
      method: "GET",
      headers: { "User-Agent": "Cloudflare-Heartbeat-Worker/1.0" },
      signal: AbortSignal.timeout(4000)
    });
    responseTime = Date.now() - startTime;
    statusCode = response.status;
    isUp = response.ok || (statusCode >= 300 && statusCode < 400);
  } catch (err) {
    responseTime = Date.now() - startTime;
    isUp = false;
    statusCode = 504;
  }

  const kvKey = `STATE_${service.name.replace(/\s+/g, "_")}`;
  const previousState = (await env.HEARTBEAT_KV?.get(kvKey)) || "UP";
  const currentStatus = isUp ? "UP" : "DOWN";

  // Trigger alert ONLY on state change
  if (previousState === "UP" && currentStatus === "DOWN") {
    const sent = await sendEmailAlert(
      env,
      `🔴 ALERT: ${service.name} is DOWN!`,
      buildAlertHTML(service.name, service.url, "DOWN", statusCode, responseTime)
    );
    // Only update KV if email was sent successfully or attempt completed
    if (env.HEARTBEAT_KV) await env.HEARTBEAT_KV.put(kvKey, "DOWN");
  } else if (previousState === "DOWN" && currentStatus === "UP") {
    await sendEmailAlert(
      env,
      `🟢 RECOVERED: ${service.name} is back ONLINE`,
      buildAlertHTML(service.name, service.url, "RECOVERED", statusCode, responseTime)
    );
    if (env.HEARTBEAT_KV) await env.HEARTBEAT_KV.put(kvKey, "UP");
  }

  return {
    service: service.name,
    status: currentStatus,
    statusCode,
    responseTime: `${responseTime}ms`
  };
}

async function runHealthCheck(env) {
  // Run all service checks concurrently using Promise.all
  return await Promise.all(SERVICES_TO_MONITOR.map(s => checkSingleService(s, env)));
}

async function sendEmailAlert(env, subject, htmlBody) {
  const resendApiKey = env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("RESEND_API_KEY environment variable is missing!");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: NOTIFY_EMAIL,
        subject: subject,
        html: htmlBody
      })
    });

    if (!res.ok) {
      console.error("Resend API error:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Failed to send email via Resend:", err);
    return false;
  }
}

function buildAlertHTML(serviceName, url, status, statusCode, responseTime) {
  const color = status === "DOWN" ? "#e53e3e" : "#38a169";
  const statusLabel = status === "DOWN" ? "CRITICAL OUTAGE DETECTED" : "SERVICE RECOVERED";

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px;">
      <h2 style="color: ${color}; margin-top: 0;">${statusLabel}</h2>
      <p>Cloudflare Heartbeat Worker detected a status change on your home server.</p>
      <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
        <tr><td style="padding: 8px; font-weight: bold;">Service:</td><td style="padding: 8px;">${serviceName}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">URL:</td><td style="padding: 8px;"><a href="${url}">${url}</a></td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">HTTP Status:</td><td style="padding: 8px;">${statusCode}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Response Time:</td><td style="padding: 8px;">${responseTime}ms</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Timestamp:</td><td style="padding: 8px;">${new Date().toISOString()}</td></tr>
      </table>
    </div>
  `;
}