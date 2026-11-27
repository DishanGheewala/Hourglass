// GET /api/calendar?token=...: a private calendar feed of a student's Hourglass deadlines.
// iPhone/Mac: Settings > Calendar > Accounts > Add Account > Other > Add Subscribed Calendar.
// Google Calendar and Outlook can subscribe to the same link.
import { admin } from './_lib.js';

const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = line => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };
const nextDay = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export default async function handler(req, res) {
  const token = String(req.query.token || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).send('Not found');
  try {
    const { db } = admin();
    const users = await db.collection('users').where('calToken', '==', token).limit(1).get();
    if (users.empty) return res.status(404).send('Not found');
    const dl = await users.docs[0].ref.collection('deadlines').get();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hourglass//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Hourglass deadlines', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    for (const doc of dl.docs) {
      const d = doc.data();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) continue;
      const day = d.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:${doc.id}@hourglass`, `DTSTAMP:${stamp}`, `SUMMARY:${esc('Due: ' + d.title)}`);
      if (/^\d{2}:\d{2}$/.test(d.time || '')) {
        const t = d.time.replace(':', '') + '00';
        lines.push(`DTSTART:${day}T${t}`, 'DURATION:PT30M'); // floating time: shown in the phone's own time zone
      } else {
        lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(d.date).replace(/-/g, '')}`);
      }
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(d.title + ' is due tomorrow')}`, 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(lines.map(fold).join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Calendar feed error');
  }
}
