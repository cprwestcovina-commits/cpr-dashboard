// Weekly email-template generator — calls Claude to produce 3 broadcast templates for CPR West Covina.
// GET (no params): regenerate all 3 and store. GET ?slot=N: reroll just that one. Stored in the
// datastore __templates__ record (status='templates', JSON in landing_url) for the dashboard to read.
const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const BRAND = `You write email marketing for CPR West Covina, an AHA-certified CPR/first-aid training center in West Covina, CA (100 Barranca St #255-B). Courses: BLS, Heartsaver, ACLS, PALS, and 2-year renewals. Renewal promo code is 30BEATS ($30 off).
Voice: upbeat, warm, community-focused — "your neighborhood CPR team." Conversational, encouraging, never stiff or clinical. Short paragraphs.
Audience: past and current students (healthcare workers, lifeguards, teachers, parents, job-seekers needing certification).
Socials: YouTube https://www.youtube.com/@cprwestcovina · Instagram https://www.instagram.com/cprwestcovina/ · Facebook https://web.facebook.com/profile.php?id=61587989711336
App (a free AHA study guide / pocketbook): "SOS First Aid · BLS ACLS PALS" https://apps.apple.com/us/app/sos-first-aid-bls-acls-pals/id6767118957
Rules: Do NOT include an unsubscribe line or email footer (added automatically). Keep each body 2-4 short paragraphs. No fake statistics or medical claims. Output must be valid JSON only.`;

// Every email follows the same 3-section structure; variations differ in the "What's Happening" focus.
const ANGLES = [
  { key: 'seasonal', brief: "What's Happening section: tie to the current season/holiday and relevant safety (e.g. summer/pool, winter, back-to-school)." },
  { key: 'classes',  brief: "What's Happening section: highlight upcoming class availability (BLS, Heartsaver, ACLS, PALS) and easy 2-year renewals with code 30BEATS." },
  { key: 'community',brief: "What's Happening section: a local/community angle (jobs needing certification, family preparedness, a recent milestone or thank-you to students)." },
  { key: 'app',      brief: "What's Happening section: spotlight our free study-guide app 'SOS First Aid · BLS ACLS PALS' — a handy AHA pocketbook to review algorithms anytime." },
];

async function genOne(angle, dateLabel, appWeek) {
  const connectLine = appWeek
    ? "Stay Connected section: 1-2 short, brief sentences — invite them to follow our socials AND download our free study-guide app, AND warmly encourage them to tell a friend, family member, or coworker who should get CPR-certified."
    : "Stay Connected section: 1-2 short, brief sentences — invite them to follow our socials (Instagram, Facebook, YouTube), AND warmly encourage them to share with a friend, family member, or coworker who should get CPR-certified. Keep it light and community-minded.";
  const prompt = `${BRAND}\n\nToday is ${dateLabel}.\nWrite ONE short, skimmable newsletter email with EXACTLY these three sections, in order, using these exact header lines (with the emoji), each on its own line followed by 1-2 sentences:\n\n💡 Fun Fact\n(a genuinely interesting CPR/first-aid/AED fun fact)\n\n📅 What's Happening\n(${angle.brief})\n\n📲 Stay Connected\n(${connectLine})\n\nDo NOT add other sections, links, or an unsubscribe line.\n\nReturn your answer in EXACTLY this plain-text format (no markdown, no JSON):\nSUBJECT: <one catchy line>\nHEADLINE: <one line>\nBODY:\n💡 Fun Fact\n<text>\n\n📅 What's Happening\n<text>\n\n📲 Stay Connected\n<text>`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Anthropic ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  const text = (data.content?.[0]?.text || '').trim();
  const subjM = text.match(/SUBJECT:\s*(.+)/i);
  const headM = text.match(/HEADLINE:\s*(.+)/i);
  const bodyM = text.match(/BODY:\s*([\s\S]*)$/i);
  return {
    angle: angle.key,
    subject: (subjM ? subjM[1] : '').trim(),
    headline: (headM ? headM[1] : '').trim(),
    body: (bodyM ? bodyM[1] : text).trim(),
  };
}

async function readStored() {
  try {
    let all = [], off = 0;
    while (true) {
      const r = await fetch(`${DS_URL}?teamId=${TEAM_ID}&pg[limit]=100&pg[offset]=${off}`, { headers: { 'Authorization': `Token ${MAKE_TOKEN}` } });
      const d = await r.json(); const b = d.records || [];
      all = all.concat(b); if (b.length < 100) break; off += 100; if (off > 10000) break;
    }
    const rec = all.find(r => r.key === '__templates__' || r.data?.status === 'templates');
    return rec && rec.data?.landing_url ? JSON.parse(rec.data.landing_url) : null;
  } catch (e) { return null; }
}
async function store(obj) {
  const h = { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' };
  await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'DELETE', headers: h, body: JSON.stringify({ keys: ['__templates__'] }) }).catch(() => {});
  await fetch(`${DS_URL}?teamId=${TEAM_ID}`, { method: 'POST', headers: h, body: JSON.stringify({ key: '__templates__', data: { status: 'templates', submitted_at: obj.generatedAt, landing_url: JSON.stringify(obj) } }) });
}

export default async function handler(req, res) {
  if (!ANTHROPIC_KEY) return res.status(200).json({ error: 'ANTHROPIC_API_KEY not set in Vercel env. Add it under Project → Settings → Environment Variables, then redeploy.' });
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const firstWeekOfMonth = now.getUTCDate() <= 7;   // push the app once a month (first week)
  // Third angle is "app" during the first week of the month, otherwise "social"
  const set = [ANGLES[0], ANGLES[1], firstWeekOfMonth ? ANGLES[3] : ANGLES[2]];
  try {
    const slot = req.query?.slot;
    if (slot !== undefined && slot !== '') {
      const i = parseInt(slot, 10);
      const existing = (await readStored()) || { templates: [] };
      const angle = set[i] || ANGLES[(i + 1) % ANGLES.length] || ANGLES[0];
      const one = await genOne(angle, dateLabel, firstWeekOfMonth);
      existing.templates = existing.templates || [];
      existing.templates[i] = one;
      existing.generatedAt = now.toISOString();
      await store(existing);
      return res.status(200).json({ template: one, slot: i });
    }
    const templates = [];
    for (const a of set) templates.push(await genOne(a, dateLabel, firstWeekOfMonth));
    const obj = { templates, generatedAt: now.toISOString() };
    await store(obj);
    return res.status(200).json(obj);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
