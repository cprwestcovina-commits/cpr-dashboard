// Vercel Cron — runs every 2 hours, processes the entire cadence directly in JS.
// Bypasses Make's flaky scheduler AND its quirky webhook scenarios.
//
// Flow per execution:
//   1. Fetch all pending leads from Make datastore
//   2. For each lead, determine which touches it's eligible for based on age + nudge flags
//   3. T+2hr email → fire the proven Make webhook (5212589)
//   4. T+24hr SMS, Day 5 SMS, Day 7 SMS → call GHL API directly from Node.js, PATCH flag
//   5. Day 5 COMEBACK30 email → fire dedicated email webhook
//   6. Return JSON summary
//
// Idempotent: each lead's nudge flag prevents re-sending.

import { signToken } from '../../lib/recovery-token.js';

const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
// GHL v2 Private Integration Token (created 2026-05-30) — v1 SMS endpoint was deprecated
const GHL_PIT = process.env.GHL_PIT || 'pit-8be319e0-c309-420e-a75c-c9b6d701d994';
const GHL_LOCATION = '75cqxc1YAW73gbcufjk8';
const GHL_API = 'https://services.leadconnectorhq.com';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';
const T2HR_HOOK = 'https://hook.us2.make.com/qnq2sx9vj7t6csh97lsdovav9j98jz7a';
const D5_EMAIL_HOOK = 'https://hook.us2.make.com/oxlc4vhndmrcj8x95cdoxje83akkhoih';
const RENEWAL_HOOK = 'https://hook.us2.make.com/zshj7d7mbz2y5glqxo3mka3w2q9irlms';
const RENEWAL_CADENCE_HOOK = 'https://hook.us2.make.com/lpatwdhpp1aprx4h5gqi4hv1xdjiy5mc';
const BROADCAST_HOOK = 'https://hook.us2.make.com/hsrr8ei1zmvaphnujn46fwmv9s16hj01';
const BROADCAST_CAP = 150;  // max broadcast emails per day (Gmail-safe for a personal account)
const UNSUB_BASE = 'https://cpr-dashboard-cprwc.vercel.app/api/unsubscribe';
const RENEWAL_DAILY_CAP = 0;    // PAUSED past-due (already-expired) outreach until approved
const RENEWAL_CADENCE_CAP = 25; // upcoming-renewal cadence: max students contacted per day, closest-to-expiry first
const RENEWAL_SMS_ENABLED = false; // PAUSED — high opt-out rate (non-consented imported contacts). Email-only renewals until A2P + consent are sorted.
// Upcoming-renewal touch days (before expiration). Tolerance: each lead matches if days_until ∈ [target-1, target+1].
const RENEWAL_TOUCHES = [
  { days: 90, flag: 'renewal_t90_sent' },
  { days: 60, flag: 'renewal_t60_sent' },
  { days: 30, flag: 'renewal_t30_sent' },
  { days: 15, flag: 'renewal_t15_sent' },
  { days: 7,  flag: 'renewal_t7_sent'  },
  { days: 0,  flag: 'renewal_t0_sent'  },
];

// ─── Recovery cadence v2 (personalized discount links) ──────────────────────────────
// Gated OFF until go-live: needs the prod Square token, the /api/recovery-checkout endpoint,
// and recovery mode live on every course widget. Until RECOVERY_V2_ENABLED=1, the old cadence runs.
const RECOVERY_V2 = process.env.RECOVERY_V2_ENABLED === '1';
// Reuse the (now-freed) Day-5 email hook + scenario 5235916 as the recovery-email sender —
// the old Day-5 path is disabled under v2, so no conflict and no new webhook needed.
const RCV_EMAIL_HOOK = process.env.RCV_EMAIL_HOOK || D5_EMAIL_HOOK;
const SHORT_BASE = 'https://cpr-dashboard-cprwc.vercel.app'; // host for the short SMS redirect (/api/r)
const BIZ_START = 9, BIZ_END = 19; // business-hours window for texts (9 AM–7 PM PT)
// Tier windows by lead age (hrs). Backfill-safe: a lead only ever gets the tier its age falls into.
const RECOVERY_TIERS = [
  { idx: 0, key: 't1', from: 24,  to: 48,  validDays: 3, final: false },
  { idx: 1, key: 't2', from: 48,  to: 96,  validDays: 3, final: false },
  { idx: 2, key: 't3', from: 96,  to: 168, validDays: 3, final: false },
  { idx: 3, key: 't4', from: 168, to: 360, validDays: 2, final: true  },
];
// Per-course discount ladders (cents), index = tier.
const RECOVERY_LADDER = {
  bls:         [1500, 2000, 3000, 4000],
  bls_renewal: [1500, 2000, 3000, 4000],
  heartsaver:  [1000, 1500, 2000, 3000],
  acls:        [2500, 3500, 4000, 5000],
  pals:        [2500, 3500, 4000, 5000],
};
function rcvNormCourse(ct) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  if (c === 'rnw' || c === 'renewal' || c === 'bls_renewal') return 'bls_renewal';
  if (c === 'hs') return 'heartsaver';
  if (['bls', 'heartsaver', 'acls', 'pals'].includes(c)) return c;
  return 'bls';
}
function recoveryAmount(ct, idx) { return (RECOVERY_LADDER[rcvNormCourse(ct)] || RECOVERY_LADDER.bls)[idx]; }
function recoveryWidget(ct) {
  const c = rcvNormCourse(ct);
  if (c === 'heartsaver') return 'https://cpr-dashboard-cprwc.vercel.app/heartsaver.html';
  if (c === 'acls') return 'https://cpr-dashboard-cprwc.vercel.app/acls.html';
  if (c === 'pals') return 'https://cpr-dashboard-cprwc.vercel.app/pals.html';
  return 'https://cprwestcovina-commits.github.io/bls-booking/bls-booking.html';
}
function ptHourNow() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date()));
}
// Flat fields for the Make recovery-email scenario (dumb fill-in-the-blank — no formulas).
function recoveryEmailFields(d, tier, amount, url) {
  const first = d.first_name || 'there';
  const course = courseLabel(d.course_type);
  const amt = `$${Math.round(amount / 100)}`;
  if (tier.final) {
    return {
      course_label: course,
      subject: `Final chance, ${first} - ${amt} off your ${course} (expires in 48 hrs)`,
      headline: `Your last chance &mdash; ${amt} off`,
      subhead: `This is the best offer we can do. With this code you won't find AHA certification cheaper in SoCal &mdash; and reschedules are always free. Pick any date that works.`,
      cta_label: 'Claim my discount &rarr;',
      book_url: url,
      expiry_text: 'Expires in 48 hours',
      backup_text: 'Even after the deadline, your link still saves you $20 &mdash; so you never miss out.',
    };
  }
  return {
    course_label: course,
    subject: `${first}, here's ${amt} off your ${course}`,
    headline: `${amt} off &mdash; just for you`,
    subhead: `Your discount is already applied &mdash; just pick any date that works. Reschedules are always free.`,
    cta_label: 'Pick my date &rarr;',
    book_url: url,
    expiry_text: 'Valid for 3 days',
    backup_text: '',
  };
}
function recoverySms(d, tier, amount, shortUrl) {
  const first = d.first_name || 'there';
  const course = courseLabel(d.course_type);
  const amt = `$${Math.round(amount / 100)}`;
  if (tier.final) {
    return `${first}, last chance - ${amt} off your ${course} on ${d.date_formatted}, expires in 48 hrs. Best price we can do: ${shortUrl}  Reply STOP to opt out.`;
  }
  return `Hi ${first}, Caroline from CPR West Covina - here's ${amt} off your ${course} on ${d.date_formatted}. Pick any date: ${shortUrl}  Reply STOP to opt out.`;
}

function ageHours(submittedAt) {
  if (!submittedAt) return -1;
  return (Date.now() - new Date(submittedAt).getTime()) / 3600000;
}
function courseLabel(ct) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  if (c === 'renewal' || c === 'rnw' || c === 'bls_renewal') return 'BLS Renewal';
  if (c === 'heartsaver' || c === 'hs') return 'Heartsaver';
  if (c === 'acls') return 'ACLS';
  if (c === 'pals') return 'PALS';
  return 'BLS';
}
// Per-certification recovery promo codes (abandoned-checkout, $30 off) — personable, cert-tailored.
// Customers see a code that matches the class they were booking.
function recoveryCode(ct) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  if (c === 'heartsaver' || c === 'hs') return 'SAVERBACK30';
  if (c === 'acls') return 'ACLSBACK30';
  if (c === 'pals') return 'PALSBACK30';
  return 'BLSBACK30';
}
// Booking page per cert, tagged so we know which recovery touch drove the click.
function recoveryBookUrl(ct, touch) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  const base = (c === 'heartsaver' || c === 'hs') ? 'https://cpr-dashboard-cprwc.vercel.app/heartsaver.html'
    : c === 'acls' ? 'https://cpr-dashboard-cprwc.vercel.app/acls.html'
    : c === 'pals' ? 'https://cpr-dashboard-cprwc.vercel.app/pals.html'
    : 'https://cprwestcovina-commits.github.io/bls-booking/bls-booking.html';
  return `${base}?src=recovery&rc=${touch}`;
}
// Build all the renewal-email fields in JS so the Make template stays a dumb fill-in-the-blank
// (no switch/if formulas in Make → nothing to corrupt). `days` is the touch milestone.
function renewalEmailFields(courseType, days, firstName) {
  const c = (courseType || 'bls').toLowerCase().replace(/^aha_/, '');
  const isHS   = c === 'heartsaver' || c === 'hs';
  const isACLS = c === 'acls';
  const isPALS = c === 'pals';
  const courseShort = isHS ? 'Heartsaver' : isACLS ? 'ACLS' : isPALS ? 'PALS' : 'BLS';
  const courseName  = isHS ? 'Heartsaver First Aid CPR AED' : isACLS ? 'ACLS' : isPALS ? 'PALS' : 'BLS Provider';
  const bookBase = isHS ? 'https://cpr-dashboard-cprwc.vercel.app/heartsaver.html'
    : isACLS ? 'https://cpr-dashboard-cprwc.vercel.app/acls.html'
    : isPALS ? 'https://cpr-dashboard-cprwc.vercel.app/pals.html'
    : 'https://cprwestcovina-commits.github.io/bls-booking/bls-renewal.html';
  // Tag the link so a booking from this email is attributable as a renewal conversion
  const bookUrl = `${bookBase}?src=renewal&rc=t${days}`;
  const price = (isHS) ? '$98' : (isACLS || isPALS) ? '$250' : '$89';
  const fn = firstName || 'there';
  const headlineByDay = {
    90: `Hey ${fn}, 3 months out`, 60: `Hey ${fn}, 2 months out`, 30: `Hey ${fn}, 1 month out`,
    15: `Hey ${fn}, 2 weeks left`, 7: `Hey ${fn}, 1 week left`, 0: `Hey ${fn}, today's the day`,
  };
  const subheadByDay = {
    90: `Heads up — your ${courseShort} certification expires in about 3 months. Plenty of time to lock it in early.`,
    60: `Two months until your ${courseShort} certification expires. Easy to grab a renewal slot now while there's flexibility.`,
    30: `One month until your ${courseShort} certification lapses. Pick a date this month and you're set.`,
    15: `Two weeks until your ${courseShort} expires. Don't let it lapse.`,
    7:  `One week to renew your ${courseShort}. After this, you'll be uncertified.`,
    0:  `Your ${courseShort} expires today. Renew now to stay current.`,
  };
  return {
    course_name: courseName,
    headline: headlineByDay[days] || `Hey ${fn}, time to renew`,
    subhead: subheadByDay[days] || `Time to renew your ${courseShort}.`,
    book_url: bookUrl,
    cta_label: days === 0 ? 'Renew Today' : 'Pick a Date',
    subject: days === 0 ? `${fn}, your ${courseShort} expires TODAY` : `${fn}, renew your ${courseShort} before it expires`,
    // Inbox preview text (preheader) — promo only; the headline already says renewal
    preheader: `$30 off with code "30BEATS"`,
  };
}

function normPhone(p) {
  const digits = (p || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('1') && digits.length === 11) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

async function ghlUpsertContact(lead) {
  const phone = normPhone(lead.phone);
  if (!phone) return null;
  const resp = await fetch(`${GHL_API}/contacts/upsert`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_PIT}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION,
      phone,
      firstName: lead.first_name || '',
      lastName: lead.last_name || '',
      email: lead.email || '',
      tags: ['cpr-pending', lead.course_type || 'bls'],
      source: 'CPR West Covina booking widget',
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const c = data.contact || data;
  const id = c?.id || null;
  if (!id) return null;
  // dnd:true blocks all channels; dndSettings.SMS.status==='active' blocks SMS specifically
  const smsBlocked = c.dnd === true || c?.dndSettings?.SMS?.status === 'active';
  return { id, dnd: !!smsBlocked };
}

// Upsert + send SMS, but skip gracefully if the contact opted out (STOP / DND).
// Returns: 'sent' | 'optout' | 'fail'
// COMPLIANCE: only text contacts who explicitly opted in (sms_consent === 'yes'). Anyone else is
// treated like an opt-out (skipped + marked done, never messaged) — protects the SMS sender reputation.
async function sendSmsIfAllowed(payload, message) {
  if (payload.sms_consent !== 'yes') return 'optout';
  const c = await ghlUpsertContact(payload);
  if (!c || !c.id) return 'fail';
  if (c.dnd) return 'optout';
  const r = await ghlSendSMS(c.id, message);
  return r.ok ? 'sent' : 'fail';
}

async function ghlSendSMS(contactId, message) {
  if (!contactId) return { ok: false, err: 'no contactId' };
  const resp = await fetch(`${GHL_API}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_PIT}`,
      'Version': '2021-04-15',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'SMS', contactId, message }),
  });
  return { ok: resp.ok, status: resp.status };
}

async function patchFlag(key, fullData, additions) {
  const body = { ...fullData, ...additions };
  const resp = await fetch(`${DS_URL}/${encodeURIComponent(key)}?teamId=${TEAM_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.ok;
}

const CONFIRM_HOOK = 'https://hook.us2.make.com/v4uxgw7pstxpcjmg63iii2dcy837kcwj';
async function makeGet(path) {
  const r = await fetch(`https://us2.make.com/api/v2${path}`, { headers: { 'Authorization': `Token ${MAKE_TOKEN}` } });
  return r.json();
}
function to24(s) {
  const m = (s || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return '10:00';
  let h = parseInt(m[1], 10); const min = m[2]; const p = m[3].toUpperCase();
  if (p === 'PM' && h !== 12) h += 12;
  if (p === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + min;
}
// Match completed Square payments (from the payment webhook log) to pending leads and confirm them.
// Mirrors the dashboard's auto-reconcile, including the ≥130-point match threshold.
async function reconcileSquarePayments(all, summary) {
  const known = new Set(all.filter(r => r.data?.status === 'confirmed' && r.data?.square_payment_id).map(r => r.data.square_payment_id));
  const logs = (await makeGet(`/hooks/2328890/logs?teamId=${TEAM_ID}&limit=40`)).hookLogs || [];
  const seen = new Set();
  const payments = [];
  for (const h of logs) {
    let p; try { p = await makeGet(`/hooks/2328890/logs/${h.id}?teamId=${TEAM_ID}`); } catch (e) { continue; }
    const parsed = p?.hookLog?.data?.parsed;
    if (!parsed || parsed.type !== 'payment.updated') continue;
    const pay = parsed.data?.object?.payment;
    if (!pay || pay.status !== 'COMPLETED' || known.has(pay.id) || seen.has(pay.id)) continue;
    seen.add(pay.id);
    payments.push({
      id: pay.id,
      orderId: pay.order_id || '',
      email: (pay.buyer_email_address || '').toLowerCase(),
      firstName: (pay.billing_address && pay.billing_address.first_name) || '',
      lastName: (pay.billing_address && pay.billing_address.last_name) || '',
      paidAt: parsed.created_at || h.loggedAt,
    });
  }
  const pending = all.filter(r => r.data?.status === 'pending');
  for (const u of payments) {
    const scored = pending.map(r => {
      const d = r.data; let s = 0;
      // Exact recovery match: a discounted recovery link carries our order_id → unambiguous.
      if (d.recovery_order_id && u.orderId && d.recovery_order_id === u.orderId) s += 1000;
      if (d.email && u.email && d.email.toLowerCase() === u.email) s += 100;
      if (d.first_name && u.firstName && d.first_name.toLowerCase() === u.firstName.toLowerCase()) s += 30;
      if (d.last_name && u.lastName && d.last_name.toLowerCase() === u.lastName.toLowerCase()) s += 30;
      if (d.submitted_at && u.paidAt && Math.abs(new Date(u.paidAt).getTime() - new Date(d.submitted_at).getTime()) < 30 * 60000) s += 20;
      return { r, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (!scored[0] || scored[0].s < 130) continue;  // not confident enough → leave for manual review
    const r = scored[0].r, d = r.data;
    // Shared idempotency: re-read the record live right before firing. If the dashboard's
    // auto-reconcile (or a prior run) already confirmed + emailed this person, the
    // confirm_email_sent flag will be set — skip the webhook so we never double-send.
    try {
      const fresh = await makeGet(`/data-stores/100809/data/${encodeURIComponent(r.key)}?teamId=${TEAM_ID}`);
      const fd = (fresh && (fresh.record?.data || fresh.data)) || null;
      if (fd && fd.confirm_email_sent === 'yes') {
        r.data = fd;
        const idx0 = pending.indexOf(r); if (idx0 >= 0) pending.splice(idx0, 1);
        continue;
      }
    } catch (e) { /* if the lookup fails, fall through cautiously */ }
    // Claim it in the same write that confirms — sets the flag BEFORE firing so a racing
    // dashboard re-read sees it and bails.
    // If the payment matched our recovery order_id, this conversion came from a discount link.
    const isRecovery = !!(d.recovery_order_id && u.orderId && d.recovery_order_id === u.orderId);
    const extra = isRecovery ? { recovery_redeemed: 'yes' } : {};
    const ok = await patchFlag(r.key, d, { status: 'confirmed', square_payment_id: u.id, confirm_email_sent: 'yes', ...extra });
    if (!ok) { summary.errors.push(`reconcile patch failed ${u.email}`); continue; }
    r.data = { ...d, status: 'confirmed', square_payment_id: u.id, confirm_email_sent: 'yes', ...extra };
    if (isRecovery) summary.rcvRedeemed = (summary.rcvRedeemed || 0) + 1;
    summary.events.push({ ts: new Date().toISOString(), level: 'info', src: 'payment', msg: `confirmed ${u.email || d.email}${isRecovery ? ' 🎟️ via recovery link' : ''}` });
    const idx = pending.indexOf(r); if (idx >= 0) pending.splice(idx, 1);
    await fireWebhook(CONFIRM_HOOK, { ...r.data, time_label_24: to24(r.data.time_label), time_end_24: to24(r.data.time_end) });
    summary.reconciled++;
  }
}

// Delete recovery payment links once they're spent (paid → single-use) or the lead is long dead,
// so the Square account doesn't accumulate dead links.
async function cleanupRecoveryLinks(all, summary) {
  const SQ_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  if (!SQ_TOKEN) return;
  const base = process.env.SQUARE_ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  for (const r of all) {
    const d = r.data; if (!d || !d.recovery_link_id) continue;
    const paid = d.status === 'confirmed';
    const old = d.submitted_at && (Date.now() - new Date(d.submitted_at).getTime()) > 10 * 86400000;
    if (!paid && !old) continue;
    await fetch(`${base}/v2/online-checkout/payment-links/${d.recovery_link_id}`, {
      method: 'DELETE', headers: { 'Square-Version': '2025-01-23', 'Authorization': `Bearer ${SQ_TOKEN}` },
    }).catch(() => {});
    await patchFlag(r.key, d, { recovery_link_id: '' });
    summary.rcvLinksCleaned = (summary.rcvLinksCleaned || 0) + 1;
  }
}

// Self-monitor the recovery funnel each run so a broken link surfaces in the Logs feed automatically.
async function recoveryMonitor(all, summary, logEvent) {
  // Active probe: the SMS short-link MUST redirect to a course widget, never the homepage fallback.
  try {
    const tok = signToken({ k: '__monitor__', c: 'bls', a: 1500, t: '$15 off', ti: 't1', ch: 'sms', x: Date.now() + 3600000 });
    const r = await fetch(`${SHORT_BASE}/api/r?t=${tok}`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    if (loc.includes('rcv=') && !/cprwestcovina\.com\/?$/.test(loc)) {
      summary.recoveryLinkOk = true;
      logEvent('info', 'monitor', 'recovery link healthy ✓ (SMS short-link → widget)');
    } else {
      summary.recoveryLinkOk = false;
      logEvent('error', 'monitor', `🚨 recovery SMS link BROKEN — /api/r redirects to "${loc.slice(0, 70)}"`);
    }
  } catch (e) { summary.recoveryLinkOk = false; logEvent('error', 'monitor', 'recovery link check failed: ' + e.message); }
  // Funnel health: sent → link-clicked → reached checkout (minted).
  const flags = ['rcv_t1_email','rcv_t1_sms','rcv_t2_email','rcv_t2_sms','rcv_t3_email','rcv_t3_sms','rcv_t4_email','rcv_t4_sms'];
  const sent = all.filter(r => flags.some(f => r.data?.[f] === 'yes')).length;
  const linkClicks = all.filter(r => r.data?.recovery_clicked === 'yes').length;
  const minted = all.filter(r => r.data?.recovery_order_id).length;
  summary.rcvSent = sent; summary.rcvLinkClicks = linkClicks; summary.rcvClicked = minted;
  // Diagnose where the funnel is leaking (only once there's enough volume to be meaningful).
  if (sent >= 30 && linkClicks === 0) logEvent('warning', 'monitor', `${sent} links sent, 0 link clicks — check email deliverability (spam/promotions)`);
  else if (linkClicks >= 5 && minted === 0) logEvent('warning', 'monitor', `${linkClicks} clicked the link but 0 reached checkout — check the widget/offer`);
}

// Upsert a record by key via delete-then-create. The datastore enforces a STRICT schema that
// rejects PATCH with non-schema fields ("Unexpected parameter"), but POST (add) tolerates extra
// fields. So we delete any existing record and re-add it fresh.
async function upsertRecord(key, data) {
  const h = { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'DELETE', headers: h, body: JSON.stringify({ keys: [key] }) });
  } catch (e) { /* fine if it didn't exist */ }
  const resp = await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'POST', headers: h, body: JSON.stringify({ key, data }) });
  return resp.ok;
}

async function fireWebhook(url, payload) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

// Self-heal: make sure a Make scenario is active; restart it if it has stopped/errored.
// Returns one of: 'ok' (already running) | 'healed' (was down, restarted) | 'failed:<msg>'
async function ensureScenarioActive(scenarioId) {
  const h = { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const resp = await fetch(`https://us2.make.com/api/v2/scenarios/${scenarioId}?teamId=${TEAM_ID}`, { headers: h });
    if (!resp.ok) return `failed:status ${resp.status}`;
    const s = (await resp.json()).scenario || {};
    if (s.isActive) return 'ok';
    const start = await fetch(`https://us2.make.com/api/v2/scenarios/${scenarioId}/start?teamId=${TEAM_ID}`, { method: 'POST', headers: h });
    return start.ok ? 'healed' : `failed:start ${start.status}`;
  } catch (e) {
    return 'failed:' + e.message;
  }
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  // Safe self-test: confirms the function loads (incl. the recovery-token import) and reports
  // env/flag readiness — WITHOUT processing any leads or sending anything.
  if (req.query?.selftest) {
    return res.status(200).json({
      ok: true,
      recovery_v2: RECOVERY_V2,
      tokenLibLoaded: typeof signToken === 'function',
      env: {
        square_token: !!process.env.SQUARE_ACCESS_TOKEN,
        square_env: process.env.SQUARE_ENV || null,
        square_location: !!process.env.SQUARE_LOCATION_ID,
        recovery_secret: !!process.env.RECOVERY_SECRET,
      },
    });
  }

  // === Self-heal: ensure the customer-email scenarios are running (restart any that stopped/errored).
  // Always-on, free, every 2hr — covers the failure mode where a Make scenario crashes off. ===
  const SELF_HEAL_SCENARIOS = {
    renewalEmail: 5237696,   // Renewal Cadence Email
    t2hr: 5212589,           // On-Demand Catch-up (T+2hr recovery)
    day5: 5235916,           // Bulk Day 5 COMEBACK30
    confirmation: 5137480,   // Booking/Manual Confirmation
  };
  const selfHeal = {};
  for (const [k, sid] of Object.entries(SELF_HEAL_SCENARIOS)) {
    selfHeal[k] = await ensureScenarioActive(sid);
    if (selfHeal[k] && selfHeal[k] !== 'ok') logEvent('warning', 'self-heal', `${k} scenario was ${selfHeal[k]} → restarted`);
  }
  selfHeal.renewalEmailScenario = selfHeal.renewalEmail;  // backcompat for dashboard

  // Fetch ALL records (pending + confirmed) — pagination via offset
  let all = [];
  try {
    let offset = 0;
    while (true) {
      const resp = await fetch(`${DS_URL}?teamId=${TEAM_ID}&pg[limit]=100&pg[offset]=${offset}`, {
        headers: { 'Authorization': `Token ${MAKE_TOKEN}` },
      });
      const data = await resp.json();
      const batch = data.records || [];
      all = all.concat(batch);
      if (batch.length < 100) break;
      offset += 100;
      if (offset > 5000) break; // safety
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'datastore fetch failed: ' + e.message });
  }
  const summary = { t2hr: 0, t24hr: 0, d5email: 0, d5sms: 0, d7sms: 0, renewal: 0, reconciled: 0, errors: [], events: [] };
  // Timestamped event logger → feeds the dashboard's live Logs feed.
  const logEvent = (level, src, msg) => { summary.events.push({ ts: new Date().toISOString(), level, src, msg }); };
  logEvent('info', 'cron', `run started · ${all.length} records, ${all.filter(r => r.data?.status === 'pending').length} pending`);

  // === Server-side Square reconciliation ===
  // Match completed Square payments to pending leads and confirm them (fire confirmation + calendar)
  // — so customers get confirmed within ~2hr of paying, even when nobody has the dashboard open.
  try { await reconcileSquarePayments(all, summary); } catch (e) { summary.errors.push('reconcile: ' + e.message); }
  if (RECOVERY_V2) { try { await cleanupRecoveryLinks(all, summary); } catch (e) { summary.errors.push('cleanup: ' + e.message); } }
  if (RECOVERY_V2) { try { await recoveryMonitor(all, summary, logEvent); } catch (e) { summary.errors.push('monitor: ' + e.message); } }

  const leads = all.filter(r => r.data?.status === 'pending');
  const confirmedHistorical = all.filter(r => r.data?.status === 'confirmed' && r.data?.source === 'historical_import' && r.data?.past_due_email_sent !== 'yes');

  for (const lead of leads) {
    const d = lead.data;
    const age = ageHours(d.submitted_at);
    if (age < 0) continue;
    const payload = {
      booking_id: d.booking_id || lead.key,
      first_name: d.first_name || '',
      last_name: d.last_name || '',
      email: d.email || '',
      phone: d.phone || '',
      date: d.date || '',
      date_formatted: d.date_formatted || '',
      time_label: d.time_label || '',
      course_type: d.course_type || 'bls',
      sms_consent: d.sms_consent,
    };
    const isAclsPals = /acls|pals/i.test(d.course_type || '');

    if (RECOVERY_V2) {
      // ─── Recovery cadence v2: 4 tiers, personalized signed ?rcv= discount links ───
      // Only the single tier whose window contains the lead's age fires (backfill-safe: a lead
      // who enters mid-cadence gets only its current tier, never a stale "24h" offer).
      const tier = RECOVERY_TIERS.find(t => age >= t.from && age < t.to);
      if (tier) {
        const amount = recoveryAmount(d.course_type, tier.idx);
        const expiry = Date.now() + tier.validDays * 86400000;
        const flagE = `rcv_${tier.key}_email`, flagS = `rcv_${tier.key}_sms`;

        // EMAIL
        if (RCV_EMAIL_HOOK && d[flagE] !== 'yes') {
          const tok = signToken({ k: lead.key, c: rcvNormCourse(d.course_type), a: amount, t: `$${Math.round(amount/100)} off`, ti: tier.key, ch: 'email', x: expiry });
          // Route through /api/r so the email click is tracked (then it redirects to the widget).
          const url = `${SHORT_BASE}/api/r?t=${tok}`;
          if (await fireWebhook(RCV_EMAIL_HOOK, { ...payload, ...recoveryEmailFields(d, tier, amount, url) })) {
            await patchFlag(lead.key, d, { [flagE]: 'yes', recovery_tier: tier.key });
            summary.rcvEmail = (summary.rcvEmail || 0) + 1;
            logEvent('info', 'recovery', `${tier.key.toUpperCase()} email → ${payload.email} ($${Math.round(amount/100)} off ${courseLabel(d.course_type)})`);
          } else { summary.errors.push(`rcv ${tier.key} email: ${payload.first_name}`); logEvent('error', 'recovery', `email FAILED → ${payload.email} (${tier.key})`); }
        }

        // SMS — consented + business hours (9 AM–7 PM PT). Outside hours → hold for next run.
        if (d[flagS] !== 'yes') {
          const hr = ptHourNow();
          if (hr >= BIZ_START && hr < BIZ_END) {
            const tok = signToken({ k: lead.key, c: rcvNormCourse(d.course_type), a: amount, t: `$${Math.round(amount/100)} off`, ti: tier.key, ch: 'sms', x: expiry });
            // Token rides in the short link (/api/r?t=) — no datastore lookup (GET-by-key is unreliable).
            const shortUrl = `${SHORT_BASE}/api/r?t=${tok}`;
            const r = await sendSmsIfAllowed(payload, recoverySms(d, tier, amount, shortUrl));
            if (r === 'sent') {
              await patchFlag(lead.key, d, { [flagS]: 'yes', recovery_tier: tier.key, recovery_channel: 'sms' });
              summary.rcvSms = (summary.rcvSms || 0) + 1;
              logEvent('info', 'recovery', `${tier.key.toUpperCase()} text → ${payload.phone || payload.email} ($${Math.round(amount/100)} off)`);
            } else if (r === 'optout') {
              await patchFlag(lead.key, d, { [flagS]: 'yes' });
              logEvent('warning', 'recovery', `text skipped (opted out) → ${payload.email}`);
            } else { summary.errors.push(`rcv ${tier.key} sms: ${payload.first_name} (send failed)`); logEvent('error', 'recovery', `text FAILED → ${payload.email} (${tier.key})`); }
          }
        }
      }
    } else {
    // T+2hr email — proven webhook
    if (age >= 2 && age <= 168 && d.nudge2_sent !== 'yes') {
      if (await fireWebhook(T2HR_HOOK, payload)) summary.t2hr++;
      else summary.errors.push(`t2hr: ${payload.first_name}`);
    }

    // T+24hr SMS — direct GHL
    if (age >= 24 && age <= 168 && d.nudge_t24hr_sent !== 'yes') {
      const msg = `Hi ${payload.first_name}, Caroline from CPR West Covina. Your spot for ${courseLabel(payload.course_type)} on ${payload.date_formatted} is still open. Want me to lock it in? Reply YES or call (626) 605-2067. STOP to opt out.`;
      const r = await sendSmsIfAllowed(payload, msg);
      if (r === 'sent') {
        await patchFlag(lead.key, d, { nudge_t24hr_sent: 'yes', lead_stage: 'text2' });
        summary.t24hr++;
      } else if (r === 'optout') {
        await patchFlag(lead.key, d, { nudge_t24hr_sent: 'yes' });
      } else {
        summary.errors.push(`t24hr: ${payload.first_name} (send failed)`);
      }
    }

    // Day 5 email — fire webhook + PATCH flag directly (don't rely on Make scenario to flag)
    if (age >= 120 && age <= 720 && d.comeback30_sent !== 'yes') {
      const d5Payload = { ...payload, promo_code: recoveryCode(d.course_type), book_url: recoveryBookUrl(d.course_type, 'd5email') };
      if (await fireWebhook(D5_EMAIL_HOOK, d5Payload)) {
        await patchFlag(lead.key, d, { comeback30_sent: 'yes', lead_stage: 'email2' });
        summary.d5email++;
      }
    }

    // Day 5 SMS
    if (age >= 120 && age <= 720 && d.nudge_d5sms_sent !== 'yes') {
      const msg = `Hey ${payload.first_name}, Caroline. I held a seat for ${courseLabel(payload.course_type)} on ${payload.date_formatted}. Use code ${recoveryCode(payload.course_type)} at checkout for $30 off — expires soon. Reply STOP to opt out.`;
      const r = await sendSmsIfAllowed(payload, msg);
      if (r === 'sent') {
        await patchFlag(lead.key, d, { nudge_d5sms_sent: 'yes' });
        summary.d5sms++;
      } else if (r === 'optout') {
        await patchFlag(lead.key, d, { nudge_d5sms_sent: 'yes' });
      }
    }

    // Day 7 ACLS/PALS SMS
    if (isAclsPals && age >= 156 && age <= 180 && d.nudge_d7sms_sent !== 'yes') {
      const code = /pals/i.test(d.course_type) ? 'PALS25' : 'ACLS25';
      const msg = `Hi ${payload.first_name}, Caroline. Final reminder for ${courseLabel(payload.course_type)} on ${payload.date_formatted}. Use code ${code} for $25 off. Call (626) 605-2067 to confirm. STOP to opt out.`;
      const r = await sendSmsIfAllowed(payload, msg);
      if (r === 'sent') {
        await patchFlag(lead.key, d, { nudge_d7sms_sent: 'yes' });
        summary.d7sms++;
      } else if (r === 'optout') {
        await patchFlag(lead.key, d, { nudge_d7sms_sent: 'yes' });
      }
    }
    }
  }

  // === Past-due renewal outreach — runs once daily (9-10 AM PT window), capped at 100/day ===
  // Renewal/broadcast outreach runs ONCE PER DAY at ~9 AM PT. With the GitHub-Actions pinger
  // hitting this endpoint every 2 hr, we fire on the FIRST run at/after 16:00 UTC (≈9 AM PT)
  // that hasn't already sent today — tracked via a dedicated `renewalDate` marker (not the
  // watchdog ts, which updates every run).
  const todayUTC = new Date().toISOString().slice(0, 10);
  const utcHour = new Date().getUTCHours();
  let lastRenewalDate = null;
  try {
    const wdPrev = all.find(r => r.key === '__watchdog__' || r.data?.status === 'watchdog');
    if (wdPrev?.data?.landing_url) lastRenewalDate = JSON.parse(wdPrev.data.landing_url).renewalDate || null;
  } catch (e) {}
  const doRenewalToday = (utcHour >= 16 && lastRenewalDate !== todayUTC) || req.query?.force_renewal === '1';
  const renewalEligible = confirmedHistorical
    .filter(r => {
      const cd = r.data.date;
      if (!cd) return false;
      const yearsAgo = (Date.now() - new Date(cd + 'T00:00:00').getTime()) / (365.25 * 86400000);
      return yearsAgo >= 2;
    })
    .sort((a, b) => (a.data.date || '').localeCompare(b.data.date || ''));

  const renewalBatch = doRenewalToday ? renewalEligible.slice(0, RENEWAL_DAILY_CAP) : [];

  // === Upcoming-renewal cadence: 6 touches at 90/60/30/15/7/0 days before expiration ===
  // Runs every cron tick (every 2hr) but each lead only gets fired once per touch (flag check).
  // Both email + SMS per touch.
  summary.renewalCadenceEmail = 0;
  summary.renewalCadenceSMS = 0;
  summary.renewalEmailFail = 0;
  summary.renewalSmsFail = 0;
  // Dedup by email → keep ONLY each student's LATEST confirmed class as their renewal anchor.
  // This guarantees that once someone pays for a new class, their newer booking (730 days out)
  // becomes the anchor and they are NOT bothered about renewing again for ~2 years.
  const anchorByEmail = new Map();
  for (const r of all) {
    if (r.data?.status !== 'confirmed' || !r.data?.date) continue;
    const e = (r.data.email || '').toLowerCase();
    const k = e || ('__noemail__' + r.key);  // emailless records kept individually
    const ex = anchorByEmail.get(k);
    if (!ex || r.data.date > ex.data.date) anchorByEmail.set(k, r);
  }
  const confirmedAll = [...anchorByEmail.values()];
  // Build the in-window list (0–90 days to expiry, not yet expired), CLOSEST-TO-EXPIRY FIRST.
  const inWindow = confirmedAll
    .map(lead => {
      const expiresMs = new Date(lead.data.date + 'T00:00:00').getTime() + (2 * 365.25 * 86400000);
      return { lead, expiresMs, du: Math.round((expiresMs - Date.now()) / 86400000) };
    })
    .filter(x => x.du >= 0 && x.du <= 90)
    .sort((a, b) => a.du - b.du);   // soonest expiry first
  // Run once daily (16:00 UTC window) and cap per day so the initial backlog rolls out closest-first.
  summary.renewalWindowTotal = inWindow.length;
  let cadenceSent = 0;
  for (const { lead, expiresMs, du } of (doRenewalToday ? inWindow : [])) {
    if (cadenceSent >= RENEWAL_CADENCE_CAP) { summary.renewalCadenceCapped = true; break; }
    const d = lead.data;
    // Milestones already reached (days-to-expiry has dropped to/below them) and not yet handled.
    // Flag values: 'yes' = sent, 'skipped' = window passed before launch (don't backdate-blast).
    const reachedUnsent = RENEWAL_TOUCHES.filter(t => t.days >= du && !d[t.flag]);
    if (!reachedUnsent.length) continue;
    const touch = reachedUnsent[reachedUnsent.length - 1];            // smallest day = most recent
    const olderSkips = reachedUnsent.slice(0, reachedUnsent.length - 1); // earlier missed → mark skipped
    const expiresLabel = new Date(expiresMs).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const payload = {
      first_name: d.first_name || 'there',
      last_name: d.last_name || '',
      email: d.email || '',
      phone: d.phone || '',
      course_type: (d.course_type || 'bls').toLowerCase(),
      sms_consent: d.sms_consent,
      last_class_date: d.date_formatted || d.date,
      expires_label: expiresLabel,
      days_until: String(touch.days),
      // Flat pre-rendered fields → Make template has zero formulas
      ...renewalEmailFields(d.course_type, touch.days, d.first_name),
    };
    // Email via renewal cadence webhook
    let emailOk = false;
    if (payload.email) {
      emailOk = await fireWebhook(RENEWAL_CADENCE_HOOK, payload);
      if (emailOk) summary.renewalCadenceEmail++;
      else { summary.renewalEmailFail++; summary.errors.push(`renewal-email T-${touch.days} ${payload.email}`); }
    }
    // SMS via GHL direct — skips gracefully if the contact opted out (STOP/DND)
    let smsOk = false, smsOptout = false;
    if (RENEWAL_SMS_ENABLED && payload.phone) {
      const courseShort = courseLabel(payload.course_type);
      const msg = touch.days === 0
        ? `Hi ${payload.first_name}, Caroline from CPR West Covina. Your ${courseShort} expires today — renew now to stay current: https://cprwestcovina.com  Use code 30BEATS for $30 off. STOP to opt out.`
        : `Hi ${payload.first_name}, Caroline from CPR West Covina. Your ${courseShort} expires in ${touch.days} days. Want to lock in a renewal slot? Use code 30BEATS for $30 off. Call (626) 605-2067 or reply YES. STOP to opt out.`;
      const r = await sendSmsIfAllowed(payload, msg);
      if (r === 'sent') { smsOk = true; summary.renewalCadenceSMS++; }
      else if (r === 'optout') { smsOptout = true; summary.renewalSmsOptout = (summary.renewalSmsOptout||0) + 1; }
      else { summary.renewalSmsFail++; summary.errors.push(`renewal-sms T-${touch.days} ${payload.phone} (send failed)`); }
    }
    // Always retire the older missed windows so we never backdate-blast them. Mark the current
    // touch 'yes' only if a channel landed (or SMS opt-out with no email to fall back on).
    const additions = {};
    olderSkips.forEach(t => { additions[t.flag] = 'skipped'; });
    if (emailOk || smsOk || (smsOptout && !payload.email)) additions[touch.flag] = 'yes';
    if (Object.keys(additions).length) await patchFlag(lead.key, d, additions);
    if (emailOk || smsOk) cadenceSent++;   // count only real sends against the daily cap
  }
  for (const lead of renewalBatch) {
    const d = lead.data;
    const lastClassDate = d.date_formatted || d.date || 'a few years ago';
    const payload = {
      first_name: d.first_name || 'there',
      last_name: d.last_name || '',
      email: d.email || '',
      last_class_date: lastClassDate,
      course_type: (d.course_type || 'bls').toLowerCase(),
    };
    if (!payload.email) continue;
    if (await fireWebhook(RENEWAL_HOOK, payload)) {
      await patchFlag(lead.key, d, { past_due_email_sent: 'yes' });
      summary.renewal++;
    } else {
      summary.errors.push(`renewal: ${payload.first_name}`);
    }
  }

  // === Broadcast campaign drip (newsletter to all students) — throttled, opt-out aware ===
  // Reads the active campaign from a __campaign__ record (written by the dashboard). Sends to up to
  // BROADCAST_CAP unique emails/day that haven't received THIS campaign and haven't opted out.
  summary.broadcastSent = 0;
  let campaign = null;
  try {
    const crec = all.find(r => r.key === '__campaign__' || r.data?.status === 'campaign');
    if (crec && crec.data?.landing_url) campaign = JSON.parse(crec.data.landing_url);
  } catch (e) {}
  if (campaign && campaign.active && campaign.id && doRenewalToday) {
    // Emails already sent this campaign (any record carrying this campaign id)
    const sentEmails = new Set(all.filter(r => r.data?.last_broadcast_id === campaign.id && r.data?.email).map(r => r.data.email.toLowerCase()));
    const seen = new Set();
    const recipients = [];
    for (const r of all) {
      const e = (r.data?.email || '').toLowerCase();
      if (!e || seen.has(e)) continue;
      if (r.data.status === 'campaign' || r.data.status === 'watchdog' || r.data.status === 'cronlog') continue;
      seen.add(e);
      if (sentEmails.has(e) || r.data.email_optout === 'yes') continue;
      recipients.push(r);
    }
    for (const r of recipients.slice(0, BROADCAST_CAP)) {
      const unsub = `${UNSUB_BASE}?e=${encodeURIComponent(r.data.email)}`;
      const footer = `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #eee;font-size:11px;color:#999;text-align:center;">CPR West Covina · 100 Barranca St #255-B, West Covina, CA 91791<br><a href="${unsub}" style="color:#999;">Unsubscribe</a></div>`;
      const html = (campaign.html || '') + footer;
      if (await fireWebhook(BROADCAST_HOOK, { email: r.data.email, subject: campaign.subject || 'News from CPR West Covina', html })) {
        await patchFlag(r.key, r.data, { last_broadcast_id: campaign.id });
        summary.broadcastSent++;
      } else {
        summary.errors.push(`broadcast: ${r.data.email}`);
      }
    }
  }

  // === Watchdog: compute health metrics over the deduped renewal anchors and persist them
  // to a special datastore record (__watchdog__) so the dashboard can show real cron status,
  // send failures, and data-integrity issues even when nothing is on screen. ===
  let activeWindow = 0, dueNowBacklog = 0, missingEmailActive = 0, missingPhoneActive = 0, missedTouches = 0;
  for (const lead of confirmedAll) {
    const d = lead.data;
    const exp = new Date(d.date + 'T00:00:00').getTime() + (2 * 365.25 * 86400000);
    const du = Math.round((exp - Date.now()) / 86400000);
    if (du < 0 || du > 91) continue;          // only students inside the active 90-day window
    activeWindow++;
    if (!d.email) missingEmailActive++;
    if (!d.phone) missingPhoneActive++;
    // A touch is "due" if its window is open and the flag isn't set yet
    let isDue = false;
    for (const t of RENEWAL_TOUCHES) {
      if (Math.abs(du - t.days) <= 1 && d[t.flag] !== 'yes') { isDue = true; break; }
    }
    if (isDue) dueNowBacklog++;
    // "missed": already past the 7-day mark but the earlier touches never fired (slipped through)
    if (du <= 7 && d.renewal_t90_sent !== 'yes' && d.renewal_t60_sent !== 'yes' && d.renewal_t30_sent !== 'yes') missedTouches++;
  }
  const health = {
    type: 'watchdog',
    ts: new Date().toISOString(),
    renewalDate: doRenewalToday ? todayUTC : lastRenewalDate,  // marks the day renewals last fired
    recoveryLinkOk: summary.recoveryLinkOk,   // false = SMS recovery link is broken (auto-probed each run)
    rcvSent: summary.rcvSent, rcvLinkClicks: summary.rcvLinkClicks, rcvClicked: summary.rcvClicked,
    totalRecords: all.length,
    confirmedAnchors: confirmedAll.length,
    activeWindow,
    dueNowBacklog,            // should be ~0 right after a healthy run
    missingEmailActive,       // active-window students with no email (won't get cadence email)
    missingPhoneActive,       // active-window students with no phone (won't get cadence SMS)
    missedTouches,            // close to expiry but earlier touches never fired
    sent: {
      t2hr: summary.t2hr, t24hr: summary.t24hr, d5email: summary.d5email, d5sms: summary.d5sms,
      renewalEmail: summary.renewalCadenceEmail, renewalSms: summary.renewalCadenceSMS,
    },
    fails: { renewalEmail: summary.renewalEmailFail, renewalSms: summary.renewalSmsFail },
    optouts: { renewalSms: summary.renewalSmsOptout || 0 },
    selfHeal,                 // {renewalEmailScenario: 'ok'|'healed'|'failed:...'}
    errors: summary.errors.slice(0, 25),
  };
  // Surface an auto-heal as a visible note so the dashboard/agent knows it happened
  if (selfHeal.renewalEmailScenario === 'healed') health.errors.unshift('AUTO-HEALED: renewal email scenario was stopped — restarted it');
  else if ((selfHeal.renewalEmailScenario || '').startsWith('failed')) health.errors.unshift(`SELF-HEAL FAILED: renewal email scenario (${selfHeal.renewalEmailScenario})`);
  let watchdogWritten = false;
  // The datastore schema only allows its predefined text fields, so we stash the health blob
  // (as JSON) inside an existing text field: status='watchdog', ts in submitted_at, blob in landing_url.
  try {
    watchdogWritten = await upsertRecord('__watchdog__', {
      status: 'watchdog',
      submitted_at: health.ts,
      landing_url: JSON.stringify(health),
    });
  } catch (e) {}

  // Run summary + any errors → event log, then persist a rolling event log for the dashboard feed.
  (summary.errors || []).forEach(e => summary.events.push({ ts: health.ts, level: 'error', src: 'cron', msg: e }));
  logEvent('info', 'cron', `run done · ${summary.rcvEmail || 0} recovery emails, ${summary.rcvSms || 0} texts, ${summary.reconciled || 0} confirmed, ${(summary.errors || []).length} errors`);
  try {
    let prev = [];
    try { prev = (JSON.parse(all.find(r => r.key === '__cronlog__')?.data?.landing_url || '{}').entries) || []; } catch (_) {}
    const merged = [...prev, ...summary.events].slice(-400);
    await upsertRecord('__cronlog__', {
      status: 'cronlog',
      submitted_at: health.ts,
      landing_url: JSON.stringify({ entries: merged }),
    });
  } catch (e) {}

  return res.status(200).json({
    ok: true,
    ts: health.ts,
    totalRecords: all.length,
    totalPending: leads.length,
    confirmedTotal: confirmedAll.length,
    renewalEligible: renewalEligible.length,
    touched: summary,
    health,
    watchdogWritten,
  });
}
