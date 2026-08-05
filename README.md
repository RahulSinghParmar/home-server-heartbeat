# 🫀 Home Server Heartbeat Monitor

A zero-cost, edge-automated **Server Health Check Worker** deployed on **Cloudflare Workers**. It continuously monitors the status of self-hosted HTTP services behind Cloudflare Tunnels (e.g., `photos.parmar.homes`, `drive.parmar.homes`, `pass.parmar.homes`).

When an endpoint experiences an outage or recovers, the Worker automatically dispatches a formatted HTML alert email to your inbox using the **Resend API**.

---

## ⚡ Features

* **⏱ Automated Cron Checks:** Runs automatically every 5 minutes on Cloudflare Edge locations.
* **🧠 Smart State Tracking:** Leverages Cloudflare KV storage so alerts are only dispatched on **state transitions** (*UP ➔ DOWN* or *DOWN ➔ UP*), preventing inbox spam during extended downtime.
* **📧 High-Deliverability Emails:** Uses Resend API for transactional email delivery.
* **🚀 Continuous Deployment:** Integrated with Cloudflare Workers Builds via GitHub CI/CD—every git push deploys updates automatically.

---

## 📁 Repository Structure

```text
home-server-heartbeat/
├── src/
│   └── index.js       # Main worker logic & health check engine
├── wrangler.json      # Cloudflare worker configuration & cron triggers
├── package.json       # Project dependencies & scripts
└── README.md          # Repository documentation