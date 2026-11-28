// GET /api/push-key: the public half of the push key, needed by the browser to turn on alerts.
import { getVapid } from './_push.js';
import { hasServiceAccount } from './_fs.js';

export default async function handler(req, res) {
  try {
    if (!process.env.VAPID_PUBLIC_KEY && !hasServiceAccount()) return res.status(503).json({ error: 'Alerts are not switched on yet. The app owner needs to finish the alert setup (SETUP.md, step 5).' });
    const { publicKey } = await getVapid();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ key: publicKey });
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message }); }
}
