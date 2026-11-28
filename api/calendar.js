// GET /api/calendar?token=...: a private calendar feed of one student's deadlines.
// The app stores a ready-made calendar file under an unguessable token in Firestore ("feeds"),
// and this function just hands it to Apple Calendar / Google Calendar / Outlook. No secrets needed.
import { PROJECT_ID } from './_lib.js';

export default async function handler(req, res) {
  const token = String(req.query.token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).send('Not found');
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/feeds/${token}`);
    if (r.status === 404) return res.status(404).send('Not found');
    if (!r.ok) return res.status(503).send('The calendar is not ready yet. Publish the Firebase rules (SETUP.md, step 1).');
    const ics = (await r.json()).fields?.ics?.stringValue;
    if (!ics) return res.status(404).send('Not found');
    // ?view=1 shows the feed as plain text in the browser (handy for checking what Apple Calendar will get)
    res.setHeader('Content-Type', req.query.view ? 'text/plain; charset=utf-8' : 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).send(ics);
  } catch (err) {
    console.error(err);
    res.status(500).send('Calendar feed error');
  }
}
