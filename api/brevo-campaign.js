// Create a scheduled Brevo email campaign from composed content.
// POST body: { subject, html, sendDate (YYYY-MM-DD), senderName?, senderEmail? }
// Brevo sends to the synced student list on that date and handles unsubscribes/deliverability.
const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO = 'https://api.brevo.com/v3';

async function brevo(path, method, body) {
  const r = await fetch(`${BREVO}${path}`, {
    method,
    headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', 'accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, json, text };
}
async function getListId() {
  let all = [], off = 0;
  while (true) {
    const r = await fetch(`${DS_URL}?teamId=${TEAM_ID}&pg[limit]=100&pg[offset]=${off}`, { headers: { 'Authorization': `Token ${MAKE_TOKEN}` } });
    const d = await r.json(); const b = d.records || [];
    all = all.concat(b); if (b.length < 100) break; off += 100; if (off > 20000) break;
  }
  const rec = all.find(r => r.key === '__brevo__' || r.data?.status === 'brevo');
  const cfg = rec && rec.data?.landing_url ? JSON.parse(rec.data.landing_url) : null;
  return cfg?.listId || null;
}

export default async function handler(req, res) {
  if (!BREVO_KEY) return res.status(200).json({ error: 'BREVO_API_KEY not set in Vercel env.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { subject, html, sendDate, senderName, senderEmail } = body;
    if (!subject || !html || !sendDate) return res.status(400).json({ error: 'subject, html, sendDate required' });
    const listId = await getListId();
    if (!listId) return res.status(400).json({ error: 'No Brevo list yet — run contact sync first.' });

    // Scheduled time: 9 AM Pacific on the chosen date (16:00 UTC in summer). Brevo wants ISO8601.
    const scheduledAt = `${sendDate}T16:00:00.000Z`;
    // Pick a sender: provided, else the first verified sender on the account
    let sender = senderEmail ? { name: senderName || 'CPR West Covina', email: senderEmail } : null;
    if (!sender) {
      const s = await brevo('/senders', 'GET');
      const first = (s.json?.senders || []).find(x => x.active) || (s.json?.senders || [])[0];
      if (!first) return res.status(400).json({ error: 'No verified sender in Brevo. Add & verify one under Senders & Domains.' });
      sender = { name: first.name || 'CPR West Covina', email: first.email };
    }
    const campaign = {
      name: `${subject} — ${sendDate}`,
      subject,
      sender,
      type: 'classic',
      htmlContent: html,
      recipients: { listIds: [listId] },
      scheduledAt,
    };
    const r = await brevo('/emailCampaigns', 'POST', campaign);
    if (!r.ok) return res.status(500).json({ error: 'Brevo campaign create failed', detail: r.text });
    return res.status(200).json({ ok: true, campaignId: r.json.id, scheduledAt, listId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
