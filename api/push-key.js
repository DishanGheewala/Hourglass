// GET /api/push-key: the public half of the VAPID key pair, needed by the browser to turn on push alerts.
export default function handler(req, res) {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push alerts are not set up yet: add VAPID_PUBLIC_KEY in Vercel (SETUP.md, step 5).' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({ key });
}
