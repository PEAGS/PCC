// Runs once a day (see vercel.json for the schedule). Checks every saved
// subscription's reminders and sends a real push notification for anything
// due within that phone's chosen lead time.

import { Redis } from "@upstash/redis";
import webpush from "web-push";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  // Optional light protection so random visitors can't trigger this endpoint.
  // Set a CRON_SECRET env var to enable this check; leave it unset to skip it.
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const vapidPublicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublicKey || !vapidPrivateKey) {
    res.status(500).json({ error: "VAPID keys not configured" });
    return;
  }
  webpush.setVapidDetails("mailto:notifications@peags.app", vapidPublicKey, vapidPrivateKey);

  let ids = [];
  try {
    ids = (await redis.smembers("push:index")) || [];
  } catch (e) {
    res.status(500).json({ error: "Couldn't read subscriptions. Make sure a Redis database is connected to this project." });
    return;
  }

  let checked = 0;
  let sent = 0;

  for (const id of ids) {
    const data = await redis.get(`push:${id}`);
    if (!data) continue;
    checked++;

    const { subscription, leadDays, reminders } = data;
    const now = Date.now();

    for (const item of reminders || []) {
      const due = new Date(item.dueDate).getTime();
      if (Number.isNaN(due)) continue;
      const daysLeft = Math.ceil((due - now) / DAY_MS);

      // Notify once it's within the lead window, and for a few days after it's overdue.
      if (daysLeft <= (leadDays || 7) && daysLeft >= -3) {
        const body =
          daysLeft < 0
            ? `${item.title} is overdue`
            : daysLeft === 0
            ? `${item.title} is due today`
            : `${item.title} due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

        try {
          await webpush.sendNotification(subscription, JSON.stringify({ title: "PEAGS Car Companion", body }));
          sent++;
        } catch (e) {
          // Subscription expired or was revoked — clean it up.
          if (e.statusCode === 404 || e.statusCode === 410) {
            await redis.del(`push:${id}`);
            await redis.srem("push:index", id);
          }
        }
      }
    }
  }

  res.status(200).json({ ok: true, checked, sent });
}
