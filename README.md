# PEAGS Car Companion

A ready-to-deploy version of the app with a real "PCC" logo baked in as the
home screen icon (icons already generated in `public/`).

## Easiest path: deploy with Vercel (no local setup needed)

1. Go to https://github.com/new and create a new repository (e.g. `peags-car-companion`).
2. On the new repo page, click **uploading an existing file**, then drag in
   every file/folder from this project (keep the folder structure: `public/`,
   `src/`, `index.html`, `package.json`, etc). Commit the files.
3. Go to https://vercel.com and sign up / log in (you can use your GitHub account).
4. Click **Add New… → Project**, select the repo you just created.
5. Vercel will detect it's a Vite project automatically. Click **Deploy**.
6. After a minute you'll get a live URL like `peags-car-companion.vercel.app`.

## Alternative: Netlify Drop (if you have a computer with Node.js installed)

1. Open a terminal in this project folder.
2. Run:
   ```
   npm install
   npm run build
   ```
3. This creates a `dist/` folder.
4. Go to https://app.netlify.com/drop and drag the `dist/` folder in.
5. You'll get a live URL instantly.

## Adding it to your iPhone home screen with the real icon

1. Open your new live URL in **Safari** on your iPhone (not Chrome — Add to
   Home Screen icon support is best in Safari).
2. Tap the **Share** icon.
3. Tap **Add to Home Screen**.
4. You'll now see the "PCC" chrome badge as the app icon, and it opens
   full-screen without Safari's address bar.

## Notes

- The icons in `public/` (`icon-180.png`, `icon-192.png`, `icon-512.png`,
  `favicon.png`) are already generated to match the in-app logo — no extra
  design work needed.
- `manifest.json` covers Android "Add to Home Screen" / Chrome install too.
- Because this is now a real hosted page (not a Claude artifact), browser
  notifications for reminders will work properly here, unlike inside the
  Claude preview sandbox.
- The "Save" buttons in each section persist your data so it's still there
  next time you open the app. Inside a Claude artifact this uses Claude's
  built-in per-user storage; once deployed to your own hosting (like this
  project), it automatically falls back to the browser's `localStorage`
  instead — no setup needed, but note that means the data is tied to that
  specific browser/device, not synced across devices.
- The "Cost of ownership" page adds up everything you've logged elsewhere in
  the app (fuel, repairs, insurance, road tax) into one total — it's a pure
  client-side calculation, no setup needed, works everywhere immediately.
- The "Get a free valuation" (resale page), "Find a garage / MOT test centre"
  (Service reminders and MOT pages), and "Compare insurance sites" (Insurance
  page) features are all free, zero-setup direct links out to real,
  well-known sites (Google Maps, WeBuyAnyCar, Motorway, Compare the Market,
  etc.) — no API key, no billing, no backend needed. They work immediately
  on any deployment.

## Enable phone notifications

The "Enable phone notifications" button on the Reminders & notifications page
sends a real notification to the user's phone even when the app isn't open —
this needs a bit of one-time setup since it involves a proper backend.

**1. Create a Redis database** (stores who's subscribed and what they're
tracking). Vercel's own "KV" product was retired, so this now goes through
Vercel's Marketplace instead:
- In your Vercel project, go to **Storage** → look for **Marketplace
  Database Providers** (or similar wording — Vercel's Storage tab has been
  changing, so the exact label may differ from this)
- Choose **Upstash** (a Redis provider) and follow the prompts to create a
  free database and connect it to this project
- Vercel should automatically add `KV_REST_API_URL` and `KV_REST_API_TOKEN`
  environment variables once it's connected — check **Settings →
  Environment Variables** to confirm they're there. If they're named
  differently (e.g. `UPSTASH_REDIS_REST_URL`), the code already checks for
  both naming patterns, so either will work.

**2. Add the VAPID keys** (used to authenticate the push messages)
- Go to **Settings → Environment Variables** in your Vercel project
- Add these two (a fresh key pair — safe to use as-is, or generate your own
  with `npx web-push generate-vapid-keys` if you'd rather):
  - `VITE_VAPID_PUBLIC_KEY` = `BFGGSSYHDu562z2m_Id4QVFRKxTJeZRuTGRlLPnOuONkjQSgwJ0vnXBTFCMv91QT2SSyrU_0cFjpHKchKMEriQQ`
  - `VAPID_PRIVATE_KEY` = `il7yA_L9G93NLtKrS1cxjguUWkUKbsR6uQYy-wWqHYA`
- The `VITE_` prefix on the public key is required — that's what makes it
  available to the frontend code at build time. The private key must **not**
  have that prefix, so it stays server-side only.

**3. Redeploy** so the new environment variables and the KV connection take
effect (Vercel → Deployments → Redeploy).

**4. That's it.** Once deployed:
- Users tap "Enable phone notifications" on the Reminders & notifications page
- A cron job (`vercel.json`, already configured) checks everyone's due dates
  once a day at 8am UTC and sends a push notification for anything due
  within their chosen lead time
- On iPhone specifically, push notifications for web apps only work if the
  user has added the app to their Home Screen first (Share → Add to Home
  Screen) and opened it from there, rather than from a regular Safari tab —
  this is an Apple restriction, not something the app can work around

**Notes:**
- This only works on the real deployed site — it can't work inside the
  Claude.ai artifact preview at all, since service workers need a real,
  stable origin to register against.
- The Vercel Hobby (free) plan supports cron jobs, but only once-per-day at
  minimum — which is exactly what this uses, so no paid plan is needed for
  this to work as built.
- The VAPID keys above were generated fresh for this project and aren't used
  anywhere else — they're yours. If you'd rather generate your own, run
  `npx web-push generate-vapid-keys` in a terminal.
- Heads up: Vercel's storage products have been changing recently (their
  original "KV" offering was retired in favour of Marketplace integrations
  like Upstash), so the exact screens you see in step 1 may not match this
  description exactly. If you get stuck, search Vercel's docs for "connect a
  Redis database" or ask for help — the underlying code just needs a Redis
  connection URL and token, however you get there.
