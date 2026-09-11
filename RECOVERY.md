# Final Call — Recovery & Operations Runbook

Last updated: September 11, 2026

This document is what you need to rebuild or repair finalcallpro.com.
**It contains no secrets.** Where a secret is needed, it says where to get it.
Keep this in the repo. Keep the secrets in a password manager (see §2).

---

## 1. System map

| Layer | Service | What it holds | Recoverable from |
|---|---|---|---|
| Code / hosting | Vercel | Static site + serverless API routes + cron jobs | GitHub (full history) |
| Source of truth (code) | GitHub `lmbdssp/Final-call-site` | All files | — |
| Database / auth | Supabase project — see password manager | `daily_picks`, `subscriptions`, `rate_limits`, auth users | Supabase daily backups (7-day retention, Pro plan) |
| Payments | Stripe account — see password manager ("Final Call") | Customers, subscriptions, invoices | Stripe is its own source of truth |
| Odds data | The Odds API (paid plan) | Game lines | Re-fetchable daily |
| Email | Resend (domain `finalcallpro.com`, verified) | Transactional + digest sending | — |
| Domain / DNS | Namecheap | `finalcallpro.com`, BasicDNS, email forwarder | — |

**Support email:** `support@finalcallpro.com` → Namecheap forwarder → personal Gmail.

---

## 2. Environment variables (the real single point of failure)

These live **only** in Vercel → Project → Settings → Environment Variables (Production).
They are not in GitHub and not in any backup. If the Vercel project is lost, every
one of these must be regenerated.

| Variable | Where to regenerate it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Create secret key ("Powering an integration you built") |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → the `finalcallpro.com/api/webhooks/stripe` destination → Signing secret → copy icon |
| `STRIPE_PRICE_MONTHLY` | Stripe → Product catalog → Final Call Pro → $14.99/mo price → copy ID |
| `STRIPE_PRICE_ANNUAL` | Stripe → Product catalog → Final Call Pro → $124.99/yr price → copy ID |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (**full DB access — treat as root**) |
| `ODDS_API_KEY` | the-odds-api.com account dashboard |
| `RESEND_API_KEY` | Resend → API Keys → Create |
| `ALERT_EMAIL` | Your own inbox address — cron failure alerts go here |
| `CRON_SECRET` | Any long random string. Also signs unsubscribe tokens — **changing it invalidates every existing unsubscribe link** |

> **Do this once:** copy the current values into a password manager entry called
> "Final Call — env vars". That is the single highest-value backup action available,
> and nothing automated can do it for you (Vercel hides secret values after saving).

**Always copy IDs and keys with the copy icon, never by retyping.** Several of these
contain characters that look identical in common fonts (lowercase `l` vs digit `1`,
`O` vs `0`). Mistyped price IDs and a mistyped webhook secret each caused an outage
during setup.

---

## 3. Cron jobs (`vercel.json`)

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/fetch-picks` | `0 9 * * *` | Pull odds, compute picks, upsert into `daily_picks` |
| `/api/cron/grade-picks` | `0 10 * * *` | Grade finished games against final scores |
| `/api/cron/send-digest` | `30 9 * * *` | Email top picks to active, non-opted-out subscribers |

Manual run: Vercel → Project → Settings → Cron Jobs → **Run**.
All three authenticate with `Bearer ${CRON_SECRET}`.

---

## 4. Database schema essentials

**Tables:** `daily_picks`, `subscriptions`, `rate_limits`. RLS enabled on all three.

**Policies:**
- `daily_picks` — "Anyone can view daily picks" (SELECT, `true`)
- `subscriptions` — "Users can view their own subscription" (SELECT, `(select auth.email()) = user_email`)
- `rate_limits` — RLS on, no policies (service-role only, by design)

**Constraints that matter:**
- `daily_picks_unique_game` — UNIQUE `(sport, away_team, home_team, commence_time)`.
  **`game_date` is deliberately excluded.** It is derived from `commence_time`; including
  it caused duplicate rows whenever the date computation changed.
- `subscriptions_user_email_key` — UNIQUE `(user_email)`. The webhook upsert depends on this.

**Function:** `check_rate_limit(text, int, int)` — sliding-window limiter used by the
checkout and portal endpoints. Has `search_path` pinned to `public, pg_temp`.

**Owner comp account:** `subscriptions` holds a row for `lmbdssp@gmail.com` with
`status='active'`, `plan='pro'`, and **null Stripe IDs**. This is intentional — it grants
Pro access without a real subscription. No webhook will ever touch it. Do not "clean it
up" as stale test data. Note that "Manage subscription" will error on this account,
since there is no Stripe customer behind it.

---

## 5. Business logic worth knowing before you change it

**Odds caps.** Straight game cards never feature a pick worse than **-200**; the parlay
bundle allows up to **-500**. When a Moneyline is too lopsided it is dropped and the
Spread or Total (whichever has higher confidence) is featured instead. Set in
`api/cron/fetch-picks.js` as `MAX_STRAIGHT_ODDS` / `MAX_PARLAY_ODDS`.

**Published stats are filtered.** `api/stats.js` excludes graded picks worse than -200.
This matters: unfiltered, the record reads ~91% because early NCAAF picks were moneylines
averaging about -6,780. Filtered, it is roughly **65%** — a real, defensible number.
If you ever change this filter, understand you are changing a public accuracy claim.

**Sample sizes are uneven.** As of this writing MLB has ~62 graded bettable picks;
NCAAF has 8, NFL 3. Per-sport percentages outside MLB are not yet meaningful.

**Games with no Moneyline still appear.** A game is skipped only if it has no h2h *and*
no spread *and* no total. This exists so lopsided mismatches (e.g. FBS vs FCS), where
books often post no moneyline, don't silently vanish from the site.

**Timezone.** All date logic is US Eastern. `game_date` is derived from `commence_time`
in `America/New_York`, not UTC.

---

## 6. Recovery procedures

### Database restore
Supabase → Project → Database → Backups → pick a date → Restore.
Retention is **7 days**. A problem discovered on day 8 is not recoverable this way —
which is why the weekly export in §7 exists.

### Rebuild `subscriptions` from Stripe
Stripe is authoritative. For each active subscription, write a row with:
`user_email` (customer email), `stripe_customer_id`, `stripe_subscription_id`,
`status`, `plan` (monthly/annual by price ID), `current_period_end`
(from `subscription.items.data[0].current_period_end`).
Then re-add the owner comp row from §4.

### Rebuild `daily_picks`
Don't restore it — just run `/api/cron/fetch-picks` manually. History of *graded*
results is the only part that can't be re-fetched, so prefer a DB restore if the
results archive matters.

### Full Vercel project loss
1. Re-import `lmbdssp/Final-call-site` from GitHub into a new Vercel project.
2. Re-add every variable in §2.
3. Point the `finalcallpro.com` domain at the new project (Namecheap DNS).
4. Update the Stripe webhook destination URL if the domain changed.
5. Verify all three crons appear under Settings → Cron Jobs.

---

## 7. Weekly database export

`/api/cron/backup-db` runs Sundays at 08:00 UTC and emails a JSON snapshot of
`subscriptions` (and pick metadata) to `ALERT_EMAIL`. This exists to cover the
window past Supabase's 7-day retention. Keep those emails.

---

## 8. Known issues / deliberate choices

- **Leaked-password protection is off** in Supabase Auth. Harmless: auth is magic-link only, no passwords exist.
- **No CI or staging.** Every change goes straight to `main` and auto-deploys. There is no automated test and no review gate.
- **Vercel Hobby plan.** Hobby is for non-commercial projects; this site takes payments. Pro is $20/mo per seat and also unlocks Web Analytics and Speed Insights.
- **Service-role key is used by every API route.** It bypasses RLS entirely. Anyone with Vercel account access effectively has full database access — so 2FA on Vercel, Supabase, Stripe, and GitHub is the real security boundary. Verify it is enabled on all four.
- **267 older rows have null `parlay_*` fields** (written before those columns existed). The parlay widget may look thin on older dates.

---

## 9. Open business items (not technical)

- **Florida DR-15** — dormant LLC (Mia Global Sales LLC) with an old sales-tax registration. One overdue $0 return filed via guest filing. Still to do: confirm no other overdue periods, pay any penalty, and formally close the registration. Business Partner Number and Certificate Number: see password manager. DOR phone: (850) 488-6800. The registration does not auto-expire; penalties accrue while it sits open.
- **LLC vs sole proprietorship** — undecided. `terms.html` currently hedges between the two. Once resolved, decide whether to switch Stripe's business type to the LLC (requires re-verification and likely a new business bank account).
- **Vercel Pro upgrade** — pending decision (see §8).
