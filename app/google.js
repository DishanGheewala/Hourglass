// Optional Google linking (Calendar, Gmail send-only, Drive read-only).
// Access tokens live only in memory (they expire in about an hour and are never saved).
import { GOOGLE_CLIENT_ID } from './config.js';
import { addDays, localDT } from './util.js';

const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  gmail: 'https://www.googleapis.com/auth/gmail.send', // send only: it cannot read your inbox
  drive: 'https://www.googleapis.com/auth/drive.readonly' // read only
};
const tokens = {};
let gsi;

export const googleConfigured = () => GOOGLE_CLIENT_ID && !String(GOOGLE_CLIENT_ID).startsWith('PASTE');

function loadGsi() {
  if (!gsi) {
    gsi = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(s);
    });
  }
  return gsi;
}

export async function getToken(service) {
  const t = tokens[service];
  if (t && t.exp > Date.now() + 30000) return t.token;
  if (!googleConfigured()) throw new Error('Google linking is not set up yet (SETUP.md, step 3).');
  await loadGsi();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES[service],
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        tokens[service] = { token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: e => reject(new Error(e?.message || 'Google sign-in was closed.'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function revoke(service) {
  const t = tokens[service];
  delete tokens[service];
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.token, () => {});
}

async function gfetch(service, url, { method = 'GET', body, raw = false } = {}) {
  const token = await getToken(service);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body
  });
  if (res.status === 401) { delete tokens[service]; throw new Error('Google sign-in expired. Please try again.'); }
  if (!res.ok) throw new Error(`Google returned ${res.status}`);
  if (res.status === 204) return {};
  return raw ? res.text() : res.json();
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export function addCalendarEvent({ title, date, time }) {
  let body;
  if (time) {
    const s = new Date(`${date}T${time}:00`);
    const e = new Date(s.getTime() + 3600000);
    body = { summary: title, start: { dateTime: localDT(s), timeZone: tz() }, end: { dateTime: localDT(e), timeZone: tz() } };
  } else {
    body = { summary: title, start: { date }, end: { date: addDays(date, 1) } };
  }
  return gfetch('calendar', CAL, { method: 'POST', body: JSON.stringify(body) });
}

export async function upsertDailyReminder(time, existingId) {
  const [hh, mm] = time.split(':').map(Number);
  const now = new Date();
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  if (s < now) s.setDate(s.getDate() + 1);
  const e = new Date(s.getTime() + 15 * 60000);
  const body = JSON.stringify({
    summary: 'Hourglass: log your day',
    description: 'Log your sleep, study/work and free time in Hourglass.',
    start: { dateTime: localDT(s), timeZone: tz() },
    end: { dateTime: localDT(e), timeZone: tz() },
    recurrence: ['RRULE:FREQ=DAILY'],
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
  });
  if (existingId) {
    try { return (await gfetch('calendar', `${CAL}/${encodeURIComponent(existingId)}`, { method: 'PATCH', body })).id; }
    catch (err) { if (!/404|410/.test(err.message)) throw err; }
  }
  return (await gfetch('calendar', CAL, { method: 'POST', body })).id;
}

const utf8 = s => { let bin = ''; new TextEncoder().encode(s).forEach(b => (bin += String.fromCharCode(b))); return bin; };
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function sendEmail({ to, subject, body }) {
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) throw new Error('That email address does not look right.');
  const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 150);
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(utf8(cleanSubject))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(utf8(body))
  ].join('\r\n');
  return gfetch('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw: b64url(mime) }) });
}

const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export async function findFolder(name) {
  const params = new URLSearchParams({
    pageSize: '10',
    fields: 'files(id,name)',
    q: `mimeType='application/vnd.google-apps.folder' and name contains '${q(name)}' and trashed=false`
  });
  const r = await gfetch('drive', `${DRIVE}?${params}`);
  const files = r.files || [];
  return files.find(f => f.name.toLowerCase() === name.toLowerCase()) || files[0] || null;
}

export async function listStudyFiles(folderId) {
  const params = new URLSearchParams({
    pageSize: '10',
    fields: 'files(id,name,mimeType)',
    q: `'${q(folderId)}' in parents and trashed=false and (mimeType='application/vnd.google-apps.document' or mimeType='text/plain')`
  });
  return (await gfetch('drive', `${DRIVE}?${params}`)).files || [];
}

export function readFileText(f) {
  const url = f.mimeType === 'application/vnd.google-apps.document'
    ? `${DRIVE}/${encodeURIComponent(f.id)}/export?mimeType=text/plain`
    : `${DRIVE}/${encodeURIComponent(f.id)}?alt=media`;
  return gfetch('drive', url, { raw: true });
}
