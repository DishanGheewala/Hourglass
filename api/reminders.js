// GET /api/reminders?key=CRON_SECRET: sends any reminder alerts that are due right now.
// Called every 5 minutes by a free timer (the Apps Script trigger in apps-script.gs, SETUP.md step 5),
// so alerts arrive even when the app is closed.
import { sendNotification } from 'web-push';
import { admin, sendError } from './_lib.js';

export const config = { maxDuration: 60 };
const WINDOW_MIN = 45; // send a missed alert up to 45 minutes late, never twice in one day

function localNow(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  } catch {
    return localNow('UTC');
  }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = req.query.key || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!secret || given !== secret) return res.status(401).json({ error: 'bad key' });
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('VAPID keys are not set in Vercel.');
    const vapidDetails = { subject: VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };

    const { db } = admin();
    const snap = await db.collection('push').get();
    let sent = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const subs = Array.isArray(d.subs) ? d.subs : [];
      if (!subs.length || !Array.isArray(d.alerts)) continue;
      const now = localNow(d.tz || 'UTC');
      const done = { ...(d.sent || {}) };
      const due = d.alerts.filter(a => {
        const m = toMin(a.time);
        return Number.isFinite(m) && now.minutes >= m && now.minutes - m < WINDOW_MIN && done[a.time] !== now.date;
      });
      if (!due.length) continue;
      const dead = new Set();
      for (const a of due) {
        const payload = JSON.stringify({ title: 'Hourglass', body: a.label || 'Time to log your day: sleep, study/work and free time.', url: '/app/', tag: 'hg-' + a.time });
        for (const s of subs) {
          try { await sendNotification(s, payload, { vapidDetails, TTL: 3600 }); sent++; }
          catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint); else console.error('push failed', e.statusCode, e.body); }
        }
        done[a.time] = now.date;
      }
      const update = { sent: done };
      if (dead.size) update.subs = subs.filter(s => !dead.has(s.endpoint));
      await doc.ref.update(update);
    }
    res.status(200).json({ ok: true, sent });
  } catch (err) { sendError(res, err); }
}
