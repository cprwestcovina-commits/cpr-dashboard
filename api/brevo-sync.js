// Sync student contacts from the Make datastore into a Brevo contact list.
// Creates the list if needed (stores its id in a __brevo__ datastore record). Idempotent: re-running
// just upserts contacts. Skips opted-out + synthetic records.
const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';
const BREVO_KEY = process.env.BREVO_API_KEY;
const BREVO = 'https://api.brevo.com/v3';
const LIST_NAME = 'CPR West Covina Students';

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

async function fetchAllRecords() {
  let all = [], off = 0;
  while (true) {
    const r = await fetch(`${DS_URL}?teamId=${TEAM_ID}&pg[limit]=100&pg[offset]=${off}`, { headers: { 'Authorization': `Token ${MAKE_TOKEN}` } });
    const d = await r.json(); const b = d.records || [];
    all = all.concat(b); if (b.length < 100) break; off += 100; if (off > 20000) break;
  }
  return all;
}
async function getStored() {
  const all = await fetchAllRecords();
  const rec = all.find(r => r.key === '__brevo__' || r.data?.status === 'brevo');
  return { all, cfg: rec && rec.data?.landing_url ? JSON.parse(rec.data.landing_url) : null };
}
async function storeCfg(cfg) {
  const h = { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' };
  await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'DELETE', headers: h, body: JSON.stringify({ keys: ['__brevo__'] }) }).catch(() => {});
  await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'POST', headers: h, body: JSON.stringify({ key: '__brevo__', data: { status: 'brevo', landing_url: JSON.stringify(cfg) } }) });
}

export default async function handler(req, res) {
  if (!BREVO_KEY) return res.status(200).json({ error: 'BREVO_API_KEY not set in Vercel env.' });
  try {
    const { all, cfg } = await getStored();
    let listId = cfg?.listId;
    // Ensure list exists
    if (!listId) {
      const lists = await brevo('/contacts/lists?limit=50', 'GET');
      const found = (lists.json?.lists || []).find(l => l.name === LIST_NAME);
      if (found) listId = found.id;
      else {
        // need a folder id; use/create default folder 1
        const created = await brevo('/contacts/lists', 'POST', { name: LIST_NAME, folderId: 1 });
        if (!created.ok) return res.status(500).json({ error: 'create list failed', detail: created.text });
        listId = created.json.id;
      }
      await storeCfg({ ...(cfg || {}), listId });
    }
    // Build unique, reachable contacts
    const seen = new Set(), contacts = [];
    for (const r of all) {
      const e = (r.data?.email || '').toLowerCase().trim();
      if (!e || !e.includes('@') || seen.has(e)) continue;
      if (['campaign', 'watchdog', 'templates', 'brevo'].includes(r.data?.status)) continue;
      if (r.data?.email_optout === 'yes') continue;
      seen.add(e);
      contacts.push({ email: e, attributes: { FIRSTNAME: r.data.first_name || '', LASTNAME: r.data.last_name || '' } });
    }
    // Brevo import: batches of 1000 via the import endpoint
    let imported = 0;
    for (let i = 0; i < contacts.length; i += 1000) {
      const batch = contacts.slice(i, i + 1000);
      const r = await brevo('/contacts/import', 'POST', { listIds: [listId], updateExistingContacts: true, emptyContactsAttributes: false, jsonBody: batch });
      if (r.ok) imported += batch.length;
    }
    return res.status(200).json({ ok: true, listId, totalContacts: contacts.length, imported });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
