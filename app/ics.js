// Builds the private calendar file (iCalendar) of a student's deadlines for Apple Calendar & friends.
const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = line => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };
const nextDay = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export function buildICS(deadlines) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hourglass//Deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Hourglass deadlines', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const d of deadlines) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) continue;
    const day = d.date.replace(/-/g, '');
    L.push('BEGIN:VEVENT', `UID:${d.id}@hourglass`, `DTSTAMP:${stamp}`, `SUMMARY:${esc('Due: ' + d.title)}`);
    if (/^\d{2}:\d{2}$/.test(d.time || '')) L.push(`DTSTART:${day}T${d.time.replace(':', '')}00`, 'DURATION:PT30M');
    else L.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(d.date).replace(/-/g, '')}`);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(d.title + ' is due tomorrow')}`, 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n');
}
