import crypto from "node:crypto";
import { config } from "./config.js";

const webhookUrl = process.env.WEBHOOK_SMOKE_URL ?? `http://127.0.0.1:${config.PORT}/linear/webhook`;
const body = Buffer.from(JSON.stringify({
  type: "WebhookSmoke",
  action: "test",
  webhookTimestamp: Date.now(),
}));
const signature = crypto
  .createHmac("sha256", config.LINEAR_WEBHOOK_SECRET)
  .update(body)
  .digest("hex");

const response = await fetch(webhookUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "linear-signature": signature,
  },
  body,
});

const json = await response.json() as { ok?: boolean; accepted?: boolean; error?: string };

if (!response.ok || json.ok !== true) {
  throw new Error(`Webhook smoke failed: HTTP ${response.status} ${JSON.stringify(json)}`);
}

console.log(JSON.stringify({ ok: true, status: response.status, accepted: json.accepted, url: webhookUrl }, null, 2));
