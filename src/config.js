export const DEFAULT_SERVICES = [
  {
    name: "Photos (Immich)",
    url: "https://photos.parmar.homes/api/server-info/ping",
    check: "immich",
  },
  {
    name: "Drive (Nextcloud)",
    url: "https://drive.parmar.homes/status.php",
    check: "nextcloud",
  },
  {
    name: "Vaultwarden Passwords",
    url: "https://pass.parmar.homes/alive",
    check: "http",
  },
  {
    name: "Glance Dashboard",
    url: "https://dash.parmar.homes/",
    check: "http",
  },
];

// Retain the production key convention to avoid resetting existing counters.
export const stateKey = (name) => `STATE_${name.replace(/\W/g, "_")}`;

function integer(value, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error("Invalid numeric configuration");
  return parsed;
}

function email(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
  )
    throw new Error("Invalid email configuration");
  return value;
}

export function readConfig(env) {
  const services =
    env.SERVICES_JSON === undefined
      ? DEFAULT_SERVICES
      : JSON.parse(env.SERVICES_JSON);
  if (!Array.isArray(services) || services.length < 1 || services.length > 20)
    throw new Error("Configure 1–20 services");
  const keys = new Set();
  const validated = services.map((service) => {
    if (
      !service ||
      typeof service.name !== "string" ||
      !service.name.trim() ||
      service.name.length > 100 ||
      /[\r\n]/.test(service.name)
    )
      throw new Error("Invalid service name");
    const url = new URL(service.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Use HTTPS URLs without credentials or fragments");
    const key = stateKey(service.name);
    if (keys.has(key))
      throw new Error("Service names must have distinct KV keys");
    keys.add(key);
    const check = service.check ?? "http";
    if (!["http", "immich", "nextcloud"].includes(check))
      throw new Error("Unsupported health check");
    return { name: service.name, url: url.href, check };
  });
  return {
    services: validated,
    notifyEmail: email(env.NOTIFY_EMAIL ?? "rahulsinghparmar4@gmail.com"),
    fromEmail: email(env.FROM_EMAIL ?? "alerts@parmar.homes"),
    failureThreshold: integer(env.FAILURE_THRESHOLD, 3, 1, 100),
    successThreshold: integer(env.SUCCESS_THRESHOLD, 2, 1, 100),
    timeoutMs: integer(env.REQUEST_TIMEOUT_MS, 10000, 250, 30000),
    staleAfterMs: integer(env.STALE_AFTER_MS, 900000, 300000, 86400000),
  };
}
