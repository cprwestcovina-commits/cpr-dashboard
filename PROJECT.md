# CPR West Covina — Booking System
## Handoff Document (read this first)

## What this project is
End-to-end booking + payment + automation pipeline for **all AHA courses offered**: BLS, BLS Renewal, Heartsaver, ACLS, and PALS. Customer fills a widget → pays Square → automated confirmation, reminders, calendar invites, admin alerts. Team dashboard reads from the Make data store.

**One pipeline, all courses.** The scenarios are course-agnostic: `course_type` is derived dynamically from the booking_id prefix at the pay-click step, then every downstream email (confirmation, reminders, roster, abandoned, renewal) renders the correct label via a `switch()` formula on `course_type`.

---

## Live URLs

| Asset | URL |
|---|---|
| Homepage (all courses, inline widget) | `https://cprwestcovina.com/` |
| BLS landing widget (paid ad) | `https://cprwestcovina-commits.github.io/bls-booking/bls-booking.html` |
| Renewal landing widget (paid ad) | `https://cprwestcovina-commits.github.io/bls-booking/bls-renewal.html` |
| Dashboard | `https://cpr-dashboard-cprwc.vercel.app/dashboard.html` (password: CPRWC) |
| Square webhook (Production, all payments) | `https://hook.us2.make.com/p7de9utoegxeoqgrbf3xd1equxsk0n77` |
| Pay-click webhook (BLS landing + homepage, all courses) | `https://hook.us2.make.com/cuw7w3u2o2r2vtumh9x9gog7dxi0b8f9` |
| Renewal Pay-click webhook (renewal landing only) | `https://hook.us2.make.com/o2kwxhf1dx7ie4tcs7wz0od2i17e3x51` |

### Square Payment Links (per course)

| Course | Square URL | Price |
|---|---|---|
| AHA BLS | `https://square.link/u/1OV7zGhW` | $89 |
| AHA BLS Renewal | `https://square.link/u/1OV7zGhW` | $89 |
| AHA Heartsaver First Aid CPR AED | `https://square.link/u/eQNLjlhp` | $98 |
| AHA ACLS | `https://square.link/u/J1bpzGQ8` | $250 |
| AHA PALS | `https://square.link/u/SVa0s9hf` | $250 |

Square's `payment.updated` webhook is account-level and fires for **all** payment links, so a single Square webhook subscription covers every course.

---

## Make resources

### Team / Connections
- Team ID: **2313459**
- Org ID: **7710362**
- Gmail connection: **8951891** (cprwestcovina@gmail.com)
- Google (Calendar) connection: **8957688**
- API token (for dashboard, HTTP modules, debug): `4317021d-3786-4640-8265-34e63c0aaa2e` — **rotate periodically; token is hardcoded inside HTTP module auth headers in scenarios 5124029 and 5126180, so any rotation requires updating those modules too**

### Webhooks (hooks)
- **2328890** Square Payment Confirmed → scenario 5113311
- **2328721** Pay-click (all courses) → scenario 5124029
- **2334736** Renewal Pay-click (legacy renewal widget only) → scenario 5126180

### Data Store
- ID **100809** "BLS Bookings"
- Data structure ID **374486**
- Schema fields: `email, first_name, last_name, phone, date, date_formatted, time_label, time_end, location, booking_id, submitted_at, status, square_payment_id, course_type, source`
- **Anchor record `__bootstrap_anchor__`** must exist (status=anchor) — required for the Anchor+Search+HTTP pattern to work. Do not delete.
- **booking_id prefix encodes course type**: `bls-…`, `bls_renewal-…`, `rnw-…`, `heartsaver-…`, `acls-…`, `pals-…`. This is the single source of truth — pay-click scenarios derive `course_type` from this prefix.
- **`course_type` values stored** (any of these): `bls`, `bls_renewal`, `rnw`, `renewal`, `heartsaver`, `acls`, `pals`. The label switch formula handles every alias (plus `aha_*` prefixed variants) and falls back to the raw value if unknown.

### Scenarios (all active)
| ID | Name | Trigger | Purpose |
|---|---|---|---|
| 5113311 | Integration Webhooks | Square webhook | Paid → Search booking (email + status=pending, limit 1) → Gmail customer + Calendar + Gmail admin + HTTP PATCH status=confirmed. **Route filter:** only fires when `type==payment.updated` AND `payment.status==COMPLETED` (kills the ×2 duplicates from Square's multi-event lifecycle). |
| 5124029 | Pay-click Alert (all courses) | Pay-click webhook | Widget pay-click → Gmail nudge + Gmail admin alert + Search anchor + HTTP PATCH (creates pending record, course_type derived from booking_id prefix). Despite legacy "BLS" in name, handles every course. |
| 5126180 | Renewal Pay-click | Renewal webhook | Same as above for the legacy renewal landing page only |
| 5118287 | 24hr Reminder | Daily 9 AM PT | Emails students whose date = tomorrow. Subject + body show actual course name. |
| 5118320 | Today's Class Roster | Daily 7 AM PT | Emails admin today's roster. Subject shows course per record. |
| 5118321 | Abandoned Booking - $30 Off Recovery | Daily 10 AM PT | Emails COMEBACK30 to status=pending records older than 5 days, where class date is in future. Course-aware. |
| 5118322 | Renewal Reminder | Daily 11 AM PT | Emails students at 90/60/30/15/7/3/1 days before 2yr expiration. Course-aware. |
| 5126033 | Daily Health Check | Daily 8 AM PT | Emails admin a system health report (scenario status, queue counts, record count) |
| 5127186 | Reschedule Notification | On-demand webhook | Reschedule emails + calendar update |
| 5128031 | Scenario Error Watchdog | Daily 8 AM PT | Alerts if any scenario is offline |

All hardened with `maxErrors: 50` and email recipient filters (won't auto-deactivate from empty payloads).

> **Naming note:** scenarios 5118287/20/21/22, 5124029, 5126180 still have "BLS" in their names from the original BLS-only build. They are now course-agnostic. Renaming them is cosmetic and optional.

---

## How the pipeline works (unified for all courses)

```
Widget (homepage / bls-booking.html / bls-renewal.html)
   │ fills form, clicks Pay
   │
   │ booking_id format: <course>-<timestamp>-<random>
   │   e.g. bls-1779…, pals-1779…, acls-1779…, heartsaver-1779…, bls_renewal-1779…, rnw-1779…
   │
   ├─POST→ Make webhook 2328721 (or 2334736 for legacy renewal widget)
   │       └─ scenario 5124029 / 5126180:
   │              ├─ Gmail customer (course-specific nudge to pay)
   │              ├─ Gmail admin (course-specific "🟡 pay-click pending")
   │              ├─ SearchRecord (anchor) ← bootstraps the chain
   │              └─ HTTP PATCH → writes record to data store
   │                                 course_type = lower(substring(booking_id; 0; indexOf("-")))
   │                                 status      = pending
   │
   └─opens→ Square Payment Link for that course (new tab)
            │ customer pays
            └─Square webhook→ Make webhook 2328890
                              └─ scenario 5113311:
                                    ├─ Route filter: type=payment.updated AND status=COMPLETED
                                    ├─ SearchRecord by buyer_email + status=pending, sort by submitted_at desc, limit 1
                                    ├─ Gmail customer (confirmation — course label from datastore course_type)
                                    ├─ Calendar event w/ student as attendee
                                    ├─ Gmail admin ("💰 paid booking" — course-specific)
                                    └─ HTTP PATCH → status=confirmed, payment_id stored

Dashboard (dashboard.html) reads data store via Make API
```

### Course label rendering (in every email subject + body)

Make switch formula resolves `course_type` → human label:

```
switch(course_type;
  "aha_bls";"BLS"; "bls";"BLS";
  "aha_bls_renewal";"BLS Renewal"; "bls_renewal";"BLS Renewal"; "renewal";"BLS Renewal"; "rnw";"BLS Renewal";
  "aha_heartsaver";"Heartsaver First Aid CPR AED"; "heartsaver";"Heartsaver First Aid CPR AED"; "hs";"Heartsaver First Aid CPR AED";
  "aha_acls";"ACLS"; "acls";"ACLS";
  "aha_pals";"PALS"; "pals";"PALS";
  course_type)   ← raw value if no match (visible-not-silent fallback)
```

---

## The "Anchor + Search + HTTP" pattern (critical to understand)

**Discovery**: Make's `Data store > Add a record` modules and `HTTP > Make a request` modules built via API do NOT actually fire when added to scenarios that only have a Webhook trigger. They report success and increment ops count but silently skip. This is a Make platform quirk that cost hours of debugging.

**The workaround**: an HTTP module fires correctly *only if* a preceding `SearchRecord` module returns at least one result. Solution:
1. Keep one permanent "anchor" record in the data store (`__bootstrap_anchor__`)
2. In any scenario that needs to PATCH the data store, include `SearchRecord` searching for `first_name = ANCHOR` (always returns 1 result)
3. Place HTTP PATCH module after the SearchRecord — it now fires correctly
4. HTTP PATCH uses `{{1.X}}` references to the webhook bundle, which Make resolves at runtime

This pattern is used in scenarios 5124029 and 5126180.

---

## Files in `/Users/j/Desktop/Booking Calendars/`

| File | Purpose |
|---|---|
| `bls-booking.html` | BLS booking widget (deployed on GitHub Pages) |
| `bls-renewal.html` | Renewal booking widget (deployed on GitHub Pages) |
| `BlsWestCovinaLandingPage.txt` | React component for BLS landing page |
| `BlsRenewalLandingPage.txt` | React component for Renewal landing page (iframe points to bls-booking repo) |
| `dashboard.html` | Team dashboard (open locally or deploy to GitHub Pages) |
| `PROJECT.md` | This file |
| `serve.py` | Local CORS proxy (port 8788) for dashboard dev |

Homepage components (`Hero.jsx`, `MainBody.jsx`) live **only in Hostinger Horizons**, not on disk or in GitHub. Back them up before any major changes.

---

## Dashboard

Open `dashboard.html` locally (double-click) or deploy to GitHub Pages / Vercel. On first load asks for Make API token, stores in browser localStorage. Tabs: Dashboard, Calendar, Leads, Revenue, Students, Renewals, Logs & Debug. Use `?mock=1` query param to load demo data without an API token.

---

## Settings confirmed with owner

- Time zone: **America/Los_Angeles**
- Promo code (homepage widget): **HEALTHCARE10** ($10 off) — created in Square ✅
- Promo code (abandoned): **COMEBACK30** ($30 off) — created in Square ✅
- Promo code (renewal widget): **RENEWAL25** ($25 off)
- Admin email: **cprwestcovina@gmail.com**
- Send-from email: **cprwestcovina@gmail.com**
- Class duration: **2 hours** (10 AM – 12 PM and 6 PM – 8 PM weekdays; 10 AM – 12 PM Saturday; closed Sunday). ACLS/PALS run 4–6 hours.
- Class capacity: **12 seats per slot**
- Class prices: BLS/Renewal **$89**, Heartsaver **$98**, ACLS/PALS **$250**
- Location: **100 Barranca St #255-B, West Covina, CA 91791** (West Covina only — Arcadia removed from booking widget)

---

## Owner working preferences

- Wants full copy-paste code blocks, not snippets, when iterating
- Updates GitHub via web UI (Add file → Upload), not local git
- Square uses Sandbox vs Production split — confirm env when adding webhooks
- Prefers condensed, minimal UI on widgets — content above the fold on mobile
- "Stop telling me to walk thru it. You do everything that you have api access too" — bias toward API automation over UI guidance
- Approved sharing Make API token in chat for one-off admin sessions; rotate periodically

---

## Known quirks / things to watch

1. **Anchor record must exist in data store** — pay-click scenarios fail silently without it
2. **Make's API has CORS-locked endpoints** — browsers cannot directly write to data store from anywhere except the dashboard host. Always route through a Make scenario for production widgets.
3. **Status flip works** via HTTP PATCH module in scenario 5113311 (PATCH endpoint serves 200 even on non-existent keys; record IS created/updated)
4. **Square Payment Link is shared** between BLS and Renewal — `course_type` is what differentiates them in the data store, written by the pay-click scenarios
5. **Square fires multiple webhook events per payment** (`payment.created`, multiple `payment.updated` with status APPROVED → COMPLETED). Scenario 5113311 filters to `type=payment.updated AND status=COMPLETED` to avoid duplicate emails. Don't remove that filter.
6. **SearchRecord must filter by status=pending** in scenario 5113311 with limit 1 + sort `submitted_at` desc — otherwise repeat customers get N confirmation emails (one per past booking record).
7. **Google Calendar attendee invites** are sent automatically on event create with `sendUpdates: all`. Rescheduling or deleting the event auto-notifies the student
8. **Course label fallback** — if `course_type` ever ends up as an unknown value, the switch formula returns the raw string instead of silently defaulting to "BLS" (the old behavior, which caused PALS bookings to show as BLS in emails).
9. **Homepage widget uses `bls_renewal` prefix; legacy renewal widget uses `rnw` prefix** for the same course. Both map to "BLS Renewal" via the switch. Inconsistent but functional.

---

## Deferred / future work

- 2-hour day-of SMS via Twilio
- Post-class review request (auto-fire 2hr after class end)
- eCard delivery email with course-specific cross-sell (e.g. BLS grad → ACLS, PALS pitch)
- Rename scenarios to drop "BLS" prefix now that they're course-agnostic (cosmetic)
- Per-course Square webhook subscriptions if Square ever scopes them per-link (not currently needed)
- Push Hero.jsx + MainBody.jsx to GitHub as a backup (currently lives only in Hostinger Horizons)
- Password gate on dashboard (currently anyone with the URL + a valid Make token sees data)
- Rotate Make API token + update embedded auth headers in scenarios 5124029, 5126180
