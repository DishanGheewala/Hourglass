// POST /api/push-test: sends a test alert to the signed-in student's devices.
import { sendNotification } from 'web-push';
import { requireUser, sendError } from './_lib.js';
import { getData, patchData, hasServiceAccount } from './_fs.js';
import { getVapid, vapidSubject } from './_push.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const user = await requireUser(req);
    if (!hasServiceAccount() && !process.env.VAPID_PRIVATE_KEY) throw Object.assign(new Error('Alerts are not switched on yet (SETUP.md, step 5).'), { status: 503 });
    const me = (await getData(`users/${user.uid}`)) || {};
    const subs = Array.isArray(me.subs) ? me.subs : [];
    if (!subs.length) throw Object.assign(new Error('Turn on alerts for this device first.'), { status: 400 });
    const v = await getVapid();
    const vapidDetails = { subject: vapidSubject(), publicKey: v.publicKey, privateKey: v.privateKey };
    const payload = JSON.stringify({ title: 'Hourglass', body: 'Test alert: reminders are working.', url: '/app/', tag: 'hg-test' });
    let sent = 0; const dead = new Set();
    for (const s of subs) {
      try { await sendNotification(s, payload, { vapidDetails, TTL: 600 }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint); else console.error('push failed', e.statusCode, e.body); }
    }
    if (dead.size) await patchData(`users/${user.uid}`, { subs: subs.filter(s => !dead.has(s.endpoint)) });
    res.status(200).json({ ok: true, sent });
  } catch (err) { sendError(res, err); }
}
