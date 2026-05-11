import crypto from "node:crypto";
import { config } from "./config.js";

export function verifyLinearSignature(headerSignature: string | undefined, rawBody: Buffer): boolean {
  if (!headerSignature) return false;

  let provided: Buffer;
  try {
    provided = Buffer.from(headerSignature, "hex");
  } catch {
    return false;
  }

  const computed = crypto
    .createHmac("sha256", config.LINEAR_WEBHOOK_SECRET)
    .update(rawBody)
    .digest();

  if (provided.length !== computed.length) return false;
  return crypto.timingSafeEqual(provided, computed);
}

export function isFreshWebhookTimestamp(timestamp: unknown, maxSkewMs = 60_000): boolean {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  return Math.abs(Date.now() - timestamp) <= maxSkewMs;
}
