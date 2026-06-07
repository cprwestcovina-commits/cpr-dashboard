// Recovery checkout: the booking widget calls this when a recovered lead (arriving with a signed
// ?rcv= token) picks a date and hits Pay. It verifies the token, mints a one-time Square payment
// link with the tier discount applied for the chosen class date, updates the lead's record so the
// calendar event lands on the right date, and returns the checkout URL.
//
// Expiry is enforced HERE (server-side) regardless of what the widget countdown shows:
//   valid + not expired → tier discount (e.g. $15 off)
//   valid + expired     → BACKUP_DISCOUNT ($20 off) fallback, never a dead end
//   invalid/tampered    → rejected (full-price booking only)
import { verifyToken } from '../lib/recovery-token.js';

const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';

const BACKUP_DISCOUNT_CENTS = 2000; // SAVE20 equivalent when the tier offer has lapsed

// Full course prices (cents) — the line item the discount comes off of.
const COURSE_PRICE = { bls: 8900, bls_renewal: 8900, heartsaver: 9800, acls: 25000, pals: 25000 };
const COURSE_NAME = {
  bls: 'AHA BLS Certification', bls_renewal: 'AHA BLS Renewal',
  heartsaver: 'AHA Heartsaver First Aid CPR AED', acls: 'AHA ACLS', pals: 'AHA PALS',
};
function normCourse(ct) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  if (c === 'rnw' || c === 'renewal' || c === 'bls_renewal') return 'bls_renewal';
  if (c === 'hs') return 'heartsaver';
  if (['bls', 'heartsaver', 'acls', 'pals'].includes(c)) return c;
  return 'bls';
}

function sqBase() {
  return process.env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SQ_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
  if (!SQ_TOKEN || !LOCATION_ID) return res.status(500).json({ error: 'Square not configured' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { token, date, date_formatted, time_label, time_end } = body;
  if (!token) return res.status(400).json({ error: 'missing token' });

  const v = verifyToken(token);
  if (!v.valid) return res.status(403).json({ error: 'invalid token' });

  const course = normCourse(v.payload.c);
  const fullPrice = COURSE_PRICE[course] || COURSE_PRICE.bls;
  // Expired → backup discount; otherwise the tier amount baked into the token (capped at price).
  const discount = v.expired
    ? BACKUP_DISCOUNT_CENTS
    : Math.min(Number(v.payload.a) || 0, fullPrice - 100);
  const appliedLabel = v.expired ? 'Backup offer (SAVE20)' : (v.payload.t || 'Recovery discount');

  try {
    // 1) Update the lead's record so the calendar event uses the date they just picked.
    if (date) {
      await fetch(`${DS_URL}/${encodeURIComponent(v.payload.k)}?teamId=${TEAM_ID}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, date_formatted, time_label, time_end, status: 'pending' }),
      }).catch(() => {});
    }

    // 2) Mint the discounted one-time Square payment link.
    const idem = `rcv-${v.payload.k}-${Date.now()}`;
    const order = {
      location_id: LOCATION_ID,
      line_items: [{ name: COURSE_NAME[course], quantity: '1', base_price_money: { amount: fullPrice, currency: 'USD' } }],
      discounts: [{ name: `${appliedLabel} (−$${(discount / 100).toFixed(0)})`, amount_money: { amount: discount, currency: 'USD' }, scope: 'ORDER' }],
    };
    const r = await fetch(`${sqBase()}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: { 'Square-Version': '2025-01-23', 'Authorization': `Bearer ${SQ_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: idem, order, checkout_options: { allow_tipping: false }, payment_note: `Recovery ${appliedLabel} · lead ${v.payload.k}` }),
    });
    const data = await r.json();
    if (!r.ok || !data.payment_link) return res.status(502).json({ error: 'square link failed', detail: data.errors || data });

    return res.status(200).json({
      url: data.payment_link.url,
      order_id: data.payment_link.order_id,
      discount_cents: discount,
      expired: v.expired,
      applied: appliedLabel,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
