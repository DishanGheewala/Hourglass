// Google linking: Calendar, Gmail (read + send) and Drive (read all file types + save new Docs).
// Access tokens last about an hour. They are kept on this device only (never in the database).
import { GOOGLE_CLIENT_ID } from './config.js';
import { addDays, localDT } from './util.js';

const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  drive: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'
};
const TOKEN_KEY = 'hg_gtokens';
let tokens = (() => { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}'); } catch { return {}; } })();
const saveTokens = () => { try { localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens)); } catch {} };
let gsi;

export const googleConfigured = () => GOOGLE_CLIENT_ID && !String(GOOGLE_CLIENT_ID).startsWith('PASTE');

function loadScript(src, globalName) {
  return new Promise((resolve, reject) => {
    if (globalName && window[globalName]) return resolve(window[globalName]);
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(globalName ? window[globalName] : undefined);
    s.onerror = () => reject(new Error('Could not load a helper library. Check your connection.'));
    document.head.appendChild(s);
  });
}
const loadGsi = () => (gsi ||= window.google?.accounts?.oauth2 ? Promise.resolve() : loadScript('https://accounts.google.com/gsi/client'));

// True when a still-valid token is already on this device (no pop-up needed).
export const hasToken = service => !!(tokens[service] && tokens[service].exp > Date.now() + 60000);

export async function getToken(service) {
  if (hasToken(service)) return tokens[service].token;
  if (!googleConfigured()) throw new Error('Google linking is not set up yet (SETUP.md, step 3).');
  await loadGsi();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES[service],
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES[service].split(' '))) {
          return reject(new Error('Please tick every permission box Google shows, then try again.'));
        }
        tokens[service] = { token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        saveTokens();
        resolve(r.access_token);
      },
      error_callback: e => reject(new Error(e?.type === 'popup_closed' ? 'The Google window was closed.' : e?.message || 'Google sign-in was blocked. Allow pop-ups and try again.'))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function revoke(service) {
  const t = tokens[service];
  delete tokens[service];
  saveTokens();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.token, () => {});
}
export function forgetAllTokens() { tokens = {}; saveTokens(); }

async function gfetch(service, url, { method = 'GET', body, headers = {}, as = 'json' } = {}) {
  const token = await getToken(service);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body
  });
  if (res.status === 401) { delete tokens[service]; saveTokens(); throw new Error('Google sign-in expired. Ask again and approve the Google window.'); }
  if (!res.ok) {
    let msg = `Google returned ${res.status}`;
    try { const j = await res.json(); if (j.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return {};
  if (as === 'text') return res.text();
  if (as === 'buffer') return res.arrayBuffer();
  return res.json();
}

// ---------- Calendar ----------
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export function addCalendarEvent({ title, date, time, endTime, description }) {
  let body;
  if (time) {
    const s = new Date(`${date}T${time}:00`);
    const e = endTime ? new Date(`${date}T${endTime}:00`) : new Date(s.getTime() + 3600000);
    body = { summary: title, description, start: { dateTime: localDT(s), timeZone: tz() }, end: { dateTime: localDT(e > s ? e : new Date(s.getTime() + 3600000)), timeZone: tz() } };
  } else {
    body = { summary: title, description, start: { date }, end: { date: addDays(date, 1) } };
  }
  return gfetch('calendar', CAL, { method: 'POST', body: JSON.stringify(body) });
}

export async function listCalendarEvents(start, end) {
  const p = new URLSearchParams({
    timeMin: new Date(`${start}T00:00:00`).toISOString(),
    timeMax: new Date(`${addDays(end, 1)}T00:00:00`).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '100'
  });
  const r = await gfetch('calendar', `${CAL}?${p}`);
  return (r.items || []).map(e => ({ title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || undefined }));
}

// ---------- Gmail ----------
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
const utf8 = s => { let bin = ''; new TextEncoder().encode(s).forEach(b => (bin += String.fromCharCode(b))); return bin; };
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
const header = (m, name) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const ADDR = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const splitAddrs = s => String(s || '').split(/[,;]/).map(a => a.trim()).filter(Boolean);
export const addrsValid = s => splitAddrs(s).length > 0 && splitAddrs(s).every(a => ADDR.test(a));

let myAddress;
export async function myEmail() {
  if (!myAddress) myAddress = (await gfetch('gmail', `${GM}/profile`)).emailAddress?.toLowerCase();
  return myAddress;
}

function bodyText(payload) {
  if (!payload) return '';
  const walk = (p, type) => {
    if (p.mimeType === type && p.body?.data) return fromB64url(p.body.data);
    for (const c of p.parts || []) { const t = walk(c, type); if (t) return t; }
    return '';
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script').forEach(n => n.remove());
  return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
// Removes the quoted earlier message ("On Mon, ... wrote:") from a reply.
export function stripQuoted(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .+wrote:\s*$/.test(l) || (/^On .+/.test(l) && /wrote:\s*$/.test(lines[i + 1] || '')) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && out.length > 2) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

const summarize = m => ({ id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet, unread: (m.labelIds || []).includes('UNREAD') });

export async function gmailSearch(query, max = 10) {
  const p = new URLSearchParams({ q: query || '', maxResults: String(Math.min(Math.max(max || 10, 1), 25)) });
  const list = await gfetch('gmail', `${GM}/messages?${p}`);
  const ids = (list.messages || []).map(m => m.id);
  const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
  return Promise.all(ids.map(id => gfetch('gmail', `${GM}/messages/${id}?${meta}`).then(summarize)));
}

export async function gmailRead(id) {
  const m = await gfetch('gmail', `${GM}/messages/${encodeURIComponent(id)}?format=full`);
  return { ...summarize(m), cc: header(m, 'Cc'), messageIdHeader: header(m, 'Message-ID'), body: bodyText(m.payload).slice(0, 60000) };
}

export async function gmailThread(threadId) {
  const t = await gfetch('gmail', `${GM}/threads/${encodeURIComponent(threadId)}?format=full`);
  return (t.messages || []).map(m => ({ ...summarize(m), body: bodyText(m.payload) }));
}

export async function sendEmail({ to, cc, subject, body, replyToId }) {
  if (!addrsValid(to)) throw new Error('That email address does not look right.');
  if (cc && !addrsValid(cc)) throw new Error('A CC address does not look right.');
  const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const extra = [];
  let threadId;
  if (replyToId) {
    const orig = await gfetch('gmail', `${GM}/messages/${encodeURIComponent(replyToId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    const mid = header(orig, 'Message-ID');
    threadId = orig.threadId;
    if (mid) extra.push(`In-Reply-To: ${mid}`, `References: ${(header(orig, 'References') + ' ' + mid).trim()}`);
  }
  const mime = [
    `To: ${splitAddrs(to).join(', ')}`,
    ...(cc ? [`Cc: ${splitAddrs(cc).join(', ')}`] : []),
    `Subject: =?UTF-8?B?${btoa(utf8(cleanSubject))}?=`,
    ...extra,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(utf8(body)).replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');
  return gfetch('gmail', `${GM}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(mime), ...(threadId ? { threadId } : {}) }) });
}

// ---------- Drive ----------
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const MIME = {
  doc: 'application/vnd.google-apps.document',
  slides: 'application/vnd.google-apps.presentation',
  sheet: 'application/vnd.google-apps.spreadsheet',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  powerpoint: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const KIND = Object.fromEntries(Object.entries(MIME).map(([k, v]) => [v, k]));
const kindOf = mime => KIND[mime] || (mime?.startsWith('text/') ? 'text' : mime?.startsWith('image/') ? 'image' : mime || 'file');

export async function driveSearch({ query = '', type = 'any', in_folder_id } = {}) {
  const parts = ['trashed=false'];
  if (query) parts.push(`(name contains '${q(query)}' or fullText contains '${q(query)}')`);
  if (type && type !== 'any' && MIME[type]) parts.push(`mimeType='${MIME[type]}'`);
  if (in_folder_id) parts.push(`'${q(in_folder_id)}' in parents`);
  const p = new URLSearchParams({
    q: parts.join(' and '), pageSize: '25',
    fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink,size)',
    includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', corpora: 'allDrives',
    ...(query ? {} : { orderBy: 'modifiedTime desc' })
  });
  const r = await gfetch('drive', `${DRIVE}?${p}`);
  return (r.files || []).map(f => ({ id: f.id, name: f.name, type: kindOf(f.mimeType), modified: f.modifiedTime, link: f.webViewLink }));
}

let pdfjs, mammothLib, jszipLib;
async function pdfText(buf) {
  pdfjs ||= await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages && out.length < 400000; i++) {
    const page = await doc.getPage(i);
    const c = await page.getTextContent();
    out += `\n--- Page ${i} ---\n` + c.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('');
  }
  return out;
}
async function wordText(buf) {
  mammothLib ||= await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', 'mammoth');
  return (await mammothLib.extractRawText({ arrayBuffer: buf })).value;
}
async function pptxText(buf) {
  jszipLib ||= await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'JSZip');
  const zip = await jszipLib.loadAsync(buf);
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  let out = '';
  for (const [i, n] of slides.entries()) {
    const xml = await zip.file(n).async('string');
    const words = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    out += `\n--- Slide ${i + 1} ---\n` + words.join(' ');
  }
  return out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

const LIMIT = 150000;
export async function driveRead(fileId) {
  const id = encodeURIComponent(fileId);
  const f = await gfetch('drive', `${DRIVE}/${id}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`);
  const kind = kindOf(f.mimeType);
  const base = { id: f.id, name: f.name, type: kind, link: f.webViewLink };
  let text;
  if (kind === 'folder') return { ...base, files: await driveSearch({ in_folder_id: f.id }) };
  if (kind === 'doc' || kind === 'slides') text = await gfetch('drive', `${DRIVE}/${id}/export?mimeType=text/plain`, { as: 'text' });
  else if (kind === 'sheet') text = await gfetch('drive', `${DRIVE}/${id}/export?mimeType=text/csv`, { as: 'text' }) + '\n(Only the first tab of a spreadsheet can be read.)';
  else if (f.mimeType?.startsWith('application/vnd.google-apps.')) return { ...base, error: 'This kind of Google file (for example a Form or Drawing) cannot be read as text.' };
  else {
    if (Number(f.size) > 30 * 1024 * 1024) return { ...base, error: 'This file is larger than 30 MB, too big to read here.' };
    const media = `${DRIVE}/${id}?alt=media&supportsAllDrives=true`;
    if (kind === 'pdf') text = await pdfText(await gfetch('drive', media, { as: 'buffer' }));
    else if (kind === 'word') text = await wordText(await gfetch('drive', media, { as: 'buffer' }));
    else if (kind === 'powerpoint') text = await pptxText(await gfetch('drive', media, { as: 'buffer' }));
    else if (kind === 'text' || /json|csv|xml|markdown/.test(f.mimeType || '')) text = await gfetch('drive', media, { as: 'text' });
    else return { ...base, error: `Files of type ${f.mimeType} can't be read as text. Docs, Slides, Sheets, PDF, Word, PowerPoint and text files work.` };
  }
  text = String(text || '').trim();
  if (!text) return { ...base, error: 'No readable text was found (it may be a scanned image).' };
  const truncated = text.length > LIMIT;
  return { ...base, characters: text.length, ...(truncated ? { note: `File is long: showing the first ${LIMIT} of ${text.length} characters.` } : {}), text: truncated ? text.slice(0, LIMIT) : text };
}

export async function driveCreateDoc(title, content) {
  const boundary = 'hg' + Math.random().toString(36).slice(2);
  const meta = { name: title, mimeType: MIME.doc };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const r = await gfetch('drive', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', body: new Blob([body]), headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }
  });
  return { id: r.id, name: r.name, link: r.webViewLink };
}
