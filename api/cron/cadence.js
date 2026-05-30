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
const RENEWAL_DAILY_CAP = 0;    // PAUSED — set to 100 once email is approved

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
  return data.contact?.id || data.id || null;
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

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

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
  const leads = all.filter(r => r.data?.status === 'pending');
  const confirmedHistorical = all.filter(r => r.data?.status === 'confirmed' && r.data?.source === 'historical_import' && r.data?.past_due_email_sent !== 'yes');

  const summary = { t2hr: 0, t24hr: 0, d5email: 0, d5sms: 0, d7sms: 0, renewal: 0, errors: [] };

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
    };
    const isAclsPals = /acls|pals/i.test(d.course_type || '');

    // T+2hr email — proven webhook
    if (age >= 2 && age <= 168 && d.nudge2_sent !== 'yes') {
      if (await fireWebhook(T2HR_HOOK, payload)) summary.t2hr++;
      else summary.errors.push(`t2hr: ${payload.first_name}`);
    }

    // T+24hr SMS — direct GHL
    if (age >= 24 && age <= 168 && d.nudge_t24hr_sent !== 'yes') {
      const contactId = await ghlUpsertContact(payload);
      if (contactId) {
        const msg = `Hi ${payload.first_name}, Caroline from CPR West Covina. Your spot for ${courseLabel(payload.course_type)} on ${payload.date_formatted} is still open. Want me to lock it in? Reply YES or call (626) 605-2067. STOP to opt out.`;
        const r = await ghlSendSMS(contactId, msg);
        if (r.ok) {
          await patchFlag(lead.key, d, { nudge_t24hr_sent: 'yes', lead_stage: 'text2' });
          summary.t24hr++;
        } else {
          summary.errors.push(`t24hr: ${payload.first_name} (${r.status})`);
        }
      }
    }

    // Day 5 email — fire webhook + PATCH flag directly (don't rely on Make scenario to flag)
    if (age >= 120 && age <= 720 && d.comeback30_sent !== 'yes') {
      if (await fireWebhook(D5_EMAIL_HOOK, payload)) {
        await patchFlag(lead.key, d, { comeback30_sent: 'yes', lead_stage: 'email2' });
        summary.d5email++;
      }
    }

    // Day 5 SMS
    if (age >= 120 && age <= 720 && d.nudge_d5sms_sent !== 'yes') {
      const contactId = await ghlUpsertContact(payload);
      if (contactId) {
        const msg = `Hey ${payload.first_name}, Caroline. I held a seat for ${courseLabel(payload.course_type)} on ${payload.date_formatted}. Use code COMEBACK30 at checkout for $30 off — expires soon. Reply STOP to opt out.`;
        const r = await ghlSendSMS(contactId, msg);
        if (r.ok) {
          await patchFlag(lead.key, d, { nudge_d5sms_sent: 'yes' });
          summary.d5sms++;
        }
      }
    }

    // Day 7 ACLS/PALS SMS
    if (isAclsPals && age >= 156 && age <= 180 && d.nudge_d7sms_sent !== 'yes') {
      const contactId = await ghlUpsertContact(payload);
      if (contactId) {
        const code = /pals/i.test(d.course_type) ? 'PALS25' : 'ACLS25';
        const msg = `Hi ${payload.first_name}, Caroline. Final reminder for ${courseLabel(payload.course_type)} on ${payload.date_formatted}. Use code ${code} for $25 off. Call (626) 605-2067 to confirm. STOP to opt out.`;
        const r = await ghlSendSMS(contactId, msg);
        if (r.ok) {
          await patchFlag(lead.key, d, { nudge_d7sms_sent: 'yes' });
          summary.d7sms++;
        }
      }
    }
  }

  // === Past-due renewal outreach — runs once daily (9-10 AM PT window), capped at 100/day ===
  // Cadence cron fires every 2hr (12x/day). Only do renewal outreach on the 16:00 UTC run
  // (= 9 AM PT in summer, 8 AM in winter — close enough). That way: 100/day, not 1200/day.
  const utcHour = new Date().getUTCHours();
  const doRenewalToday = (utcHour === 16 || req.query?.force_renewal === '1');
  const renewalEligible = confirmedHistorical
    .filter(r => {
      const cd = r.data.date;
      if (!cd) return false;
      const yearsAgo = (Date.now() - new Date(cd + 'T00:00:00').getTime()) / (365.25 * 86400000);
      return yearsAgo >= 2;
    })
    .sort((a, b) => (a.data.date || '').localeCompare(b.data.date || ''));

  const renewalBatch = doRenewalToday ? renewalEligible.slice(0, RENEWAL_DAILY_CAP) : [];
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

  return res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
    totalRecords: all.length,
    totalPending: leads.length,
    renewalEligible: renewalEligible.length,
    touched: summary,
  });
}
