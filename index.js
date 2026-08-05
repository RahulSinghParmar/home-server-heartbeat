/**
 * Cloudflare Worker: Home Server Heartbeat Monitor
 */

const SERVICES_TO_MONITOR = [
  { name: "Photos (Immich)", url: "https://photos.parmar.homes" },
  { name: "Drive (Nextcloud)", url: "https://drive.parmar.homes" },
  { name: "Vaultwarden Passwords", url: "https://pass.parmar.homes" },
  { name: "Glance Dashboard", url: "https://dash.parmar.homes" }
];

const NOTIFY_EMAIL = "rahulsinghparmar4@gmail.com";     // Your destination email
const FROM_EMAIL = "alerts@parmar.homes";               // Verified Resend sender domain

export default {
  // Cron Trigger Execution (runs every 5 minutes)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthCheck(env));
  },

  // Manual Browser Trigger (for instant testing)
  async fetch(request, env, ctx) {
    const results = await runHealthCheck(env);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

async function runHealthCheck(env) {
  const checkResults = [];

  for (const service of SERVICES_TO_MONITOR) {
    let isUp = false;
    let statusCode = 0;
    let responseTime = 0;

    const startTime = Date.now();
    try {
      const response = await fetch(service.url, {
        method: "GET",
        headers: { "User-Agent": "Cloudflare-Heartbeat-Worker/1.0" },
        signal: AbortSignal.timeout(10000)
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

    // Alert only on state transition (UP -> DOWN or DOWN -> UP)
    if (previousState === "UP" && currentStatus === "DOWN") {
      await sendEmailAlert(
        env,
        `🔴 ALERT: ${service.name} is DOWN!`,
        buildAlertHTML(service.name, service.url, "DOWN", statusCode, responseTime)
      );
      if (env.HEARTBEAT_KV) await env.HEARTBEAT_KV.put(kvKey, "DOWN");
    } else if (previousState === "DOWN" && currentStatus === "UP") {
      await sendEmailAlert(
        env,
        `🟢 RECOVERED: ${service.name} is back ONLINE`,
        buildAlertHTML(service.name, service.url, "RECOVERED", statusCode, responseTime)
      );
      if (env.HEARTBEAT_KV) await env.HEARTBEAT_KV.put(kvKey, "UP");
    }

    checkResults.push({
      service: service.name,
      status: currentStatus,
      statusCode,
      responseTime: `${responseTime}ms`
    });
  }

  return checkResults;
}

async function sendEmailAlert(env, subject, htmlBody) {
  const resendApiKey = env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("RESEND_API_KEY environment variable is missing!");
    return;
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

    if (!res.ok) console.error("Resend API error:", await res.text());
  } catch (err) {
    console.error("Failed to send email via Resend:", err);
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