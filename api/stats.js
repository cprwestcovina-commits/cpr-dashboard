// Advisor stats — computes live business metrics from the Make datastore for the command-center
// Advisor screen. Read-only, on-demand. CORS-open so the (locally-served) dashboard can fetch it.
const MAKE_TOKEN = process.env.MAKE_API_TOKEN || '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM = '2313459';

const PRICE = { bls: 8900, bls_renewal: 8900, rnw: 8900, renewal: 8900, heartsaver: 9800, hs: 9800, acls: 25000, pals: 25000 };
const LABEL = { bls: 'BLS', bls_renewal: 'BLS Renewal', rnw: 'BLS Renewal', renewal: 'BLS Renewal', heartsaver: 'Heartsaver', hs: 'Heartsaver', acls: 'ACLS', pals: 'PALS' };
const norm = (c) => (c || 'bls').toLowerCase().replace(/^aha_/, '');
const priceOf = (d) => {
  const a = parseInt(d.amount_paid_cents || '0', 10);
  return a > 0 ? a : (PRICE[norm(d.course_type)] || 8900);
};
const DAY = 86400000;

async function fetchAll() {
  const headers = { Authorization: `Token ${MAKE_TOKEN}`, 'User-Agent': 'Mozilla/5.0' };
  const out = []; let off = 0;
  while (true) {
    const r = await fetch(`${DS}?teamId=${TEAM}&pg[limit]=100&pg[offset]=${off}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    const recs = j.records || (j.response && j.response.records) || [];
    out.push(...recs);
    if (recs.length < 100) break;
    off += 100;
    if (off > 6000) break;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const recs = await fetchAll();
    const now = Date.now();
    const SYS = new Set(['__brevo__', '__templates__', '__watchdog__', '__cronlog__']);
    const leads = recs.map(r => r.data || {}).filter(d => d && d.status && !SYS.has(d.email));
    const real = leads.filter(d => d.source !== 'historical_import'); // website/ad bookings, not the legacy import

    const ts = (d) => { const t = Date.parse(d.submitted_at || ''); return isNaN(t) ? 0 : t; };
    const inWin = (d, days) => ts(d) && (now - ts(d)) <= days * DAY;

    function window(days) {
      const w = real.filter(d => inWin(d, days));
      const confirmed = w.filter(d => d.status === 'confirmed');
      const pending = w.filter(d => d.status === 'pending');
      const revenue = confirmed.reduce((s, d) => s + priceOf(d), 0);
      const byCourse = {}, bySource = {};
      confirmed.forEach(d => { const k = LABEL[norm(d.course_type)] || norm(d.course_type); byCourse[k] = (byCourse[k] || 0) + 1; });
      w.forEach(d => { const s = d.source || 'unknown'; bySource[s] = (bySource[s] || 0) + 1; });
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ k, v }));
      return {
        leads: w.length, bookings: confirmed.length, pending: pending.length,
        revenue_cents: revenue, conv_rate: w.length ? Math.round(1000 * confirmed.length / w.length) / 10 : 0,
        courses: top(byCourse), sources: top(bySource),
      };
    }

    // Recovery
    const touchFlags = ['rcv_t1_email','rcv_t2_email','rcv_t3_email','rcv_t4_email','rcv_t1_sms','rcv_t2_sms','rcv_t3_sms','rcv_t4_sms','comeback30_sent','nudge2_sent','nudge_t24hr_sent','nudge_d5sms_sent'];
    const touched = real.filter(d => touchFlags.some(f => d[f] === 'yes'));
    const recovered = touched.filter(d => d.status === 'confirmed');

    // Renewals due — UNIQUE students (latest class per email) whose 2yr expiry lands in next N days.
    // Dedupe by email so we count people, not duplicate rows.
    const lastClass = {};
    leads.filter(d => d.status === 'confirmed' && d.date && d.email).forEach(d => {
      const t = Date.parse(d.date + 'T00:00:00'); if (isNaN(t)) return;
      const e = d.email.toLowerCase().trim();
      if (!lastClass[e] || t > lastClass[e]) lastClass[e] = t;
    });
    const expiries = Object.values(lastClass).map(t => t + 730 * DAY);
    const due = (n) => expiries.filter(e => e > now && e <= now + n * DAY).length;

    const pendingNow = real.filter(d => d.status === 'pending').length;

    res.status(200).json({
      generated_at: new Date(now).toISOString(),
      day: window(1), week: window(7), quarter: window(90),
      recovery: { touched: touched.length, recovered: recovered.length, rate: touched.length ? Math.round(1000 * recovered.length / touched.length) / 10 : 0 },
      renewals_due: { d30: due(30), d60: due(60), d90: due(90) },
      pending_now: pendingNow,
      totals: { confirmed_all: leads.filter(d => d.status === 'confirmed').length },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
