export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

/** Persist this complete payload once so retries never change its contents. */
export function notification(service, transition, result, timestamp, config) {
  const down = transition === "DOWN";
  const title = down ? "Service outage detected" : "Service restored";
  const rows = [
    ["Service", service.name],
    ["Status", transition],
    ["Endpoint", service.url],
    ["HTTP status", result.statusCode || "No response"],
    ["Response time", `${result.responseTimeMs} ms`],
    ["Check detail", result.error ?? "Healthy response"],
    ["Detected at (UTC)", timestamp],
  ];
  return {
    from: config.fromEmail,
    to: config.notifyEmail,
    subject: `${down ? "🔴 ALERT" : "🟢 RECOVERED"}: ${service.name} is ${down ? "DOWN" : "ONLINE"}`,
    text: `${title}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nAutomated notification from Home Server Heartbeat. Detection time is not the exact outage start.`,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#0b1220;color:#e2e8f0;font-family:Arial,sans-serif;padding:24px">
<div style="max-width:680px;margin:24px auto;border:1px solid #334155;border-radius:16px;overflow:hidden;background:#111c30">
<div style="padding:28px;border-top:5px solid ${down ? "#f87171" : "#34d399"}"><p style="color:#94a3b8;font-size:12px;letter-spacing:2px">HOME SERVER HEARTBEAT</p><h1 style="font-size:26px;margin:12px 0">${title}</h1><p>Threshold confirmed. ${down ? "Your service needs attention." : "Your service is responding again."}</p></div>
<div style="padding:0 20px 20px"><table style="width:100%;border-collapse:collapse;font-size:14px"><caption style="text-align:left;padding:8px;color:#94a3b8">Health check details</caption><tbody>${rows.map(([label, value]) => `<tr><th scope="row" style="text-align:left;vertical-align:top;padding:12px 8px;border-top:1px solid #334155;width:34%">${escapeHtml(label)}</th><td style="padding:12px 8px;border-top:1px solid #334155;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>
<p style="padding:0 28px 24px;color:#94a3b8;font-size:12px;line-height:1.6">Cloudflare Workers · KV · Resend<br>Detection time is not the exact outage start. A delayed notification may describe an earlier incident.</p>
</div></body></html>`,
  };
}
