// POST /api/push-test: sends a test alert to the signed-in student's devices.
import { sendNotification } from 'web-push';
import { admin, requireUser, sendError } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const user = await requireUser(req);
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw Object.assign(new Error('Alerts are not set up on the server yet (SETUP.md, step 5).'), { status: 503 });
    const ref = (await admin()).db.doc(`users/${user.uid}`);
    const snap = await ref.get();
    const subs = snap.exists ? snap.data().subs || [] : [];
    if (!subs.length) throw Object.assign(new Error('Turn on alerts for this device first.'), { status: 400 });
    const vapidDetails = { subject: VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
    const payload = JSON.stringify({ title: 'Hourglass', body: 'Test alert: reminders are working.', url: '/app/', tag: 'hg-test' });
    let sent = 0; const dead = new Set();
    for (const s of subs) {
      try { await sendNotification(s, payload, { vapidDetails, TTL: 600 }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint); else console.error('push failed', e.statusCode, e.body); }
    }
    if (dead.size) await ref.update({ subs: subs.filter(s => !dead.has(s.endpoint)) });
    res.status(200).json({ ok: true, sent });
  } catch (err) { sendError(res, err); }
}
