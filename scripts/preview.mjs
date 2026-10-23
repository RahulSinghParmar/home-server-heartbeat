import { createServer } from "node:http";
import { notification } from "../src/notification.js";

const config = {
  fromEmail: "alerts@example.com",
  notifyEmail: "operator@example.com",
};
const service = {
  name: "Home lab · photo library",
  url: "https://photos.example.com/health",
};
createServer((request, response) => {
  const recovery =
    new URL(request.url, "http://localhost").pathname === "/recovery";
  const payload = notification(
    service,
    recovery ? "RECOVERED" : "DOWN",
    {
      statusCode: recovery ? 200 : 503,
      responseTimeMs: recovery ? 84 : 102,
      error: recovery ? null : "http_503",
    },
    "2026-01-01T12:30:00.000Z",
    config,
  );
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(payload.html);
}).listen(8789, "127.0.0.1", () => {
  console.info(
    "Synthetic email previews: http://127.0.0.1:8789 and http://127.0.0.1:8789/recovery (no outbound requests)",
  );
});
