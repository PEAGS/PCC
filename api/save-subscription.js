// Stores a push subscription (one per phone/browser that enables phone
// notifications) along with a snapshot of its current due dates, so the
// daily cron job in send-reminders.js knows what to check and where to send it.
//
// Requires a Redis database connected to this project via Vercel Marketplace
// (Vercel dashboard → Storage → Marketplace Database Providers → Upstash →
// create/connect one). Vercel sets KV_REST_API_URL / KV_REST_API_TOKEN
// automatically when you connect it — no manual env var entry needed for these two.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { subscription, leadDays, reminders } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ error: "Missing subscription" });
    return;
  }

  try {
    const id = Buffer.from(subscription.endpoint).toString("base64url").slice(0, 120);
    await redis.set(`push:${id}`, {
      subscription,
      leadDays: leadDays || 7,
      reminders: reminders || [],
      updatedAt: Date.now(),
    });
    await redis.sadd("push:index", id);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Couldn't save subscription. Make sure a Redis database is connected to this project." });
  }
}
