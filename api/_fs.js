// Server-side access to Firestore using the service account, over plain REST (no firebase-admin).
// Needs FIREBASE_SERVICE_ACCOUNT (the JSON key file contents) in Vercel. Used for alerts and the AI daily limit.
import { importPKCS8, SignJWT } from 'jose';
import { PROJECT_ID } from './_lib.js';

export const hasServiceAccount = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;
const account = () => {
  if (!hasServiceAccount()) throw Object.assign(new Error('Alerts need FIREBASE_SERVICE_ACCOUNT in Vercel (SETUP.md, step 5).'), { status: 503 });
  try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
  catch { throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT in Vercel is not valid JSON. Paste the whole file contents.'), { status: 503 }); }
};

let cached = { token: null, exp: 0 };
export async function accessToken(fetchImpl = fetch) {
  if (cached.token && cached.exp > Date.now() + 60000) return cached.token;
  const a = account();
  const key = await importPKCS8(String(a.private_key).replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/datastore' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(a.client_email).setSubject(a.client_email)
    .setAudience('https://oauth2.googleapis.com/token').setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Google rejected the service account: ' + (j.error_description || j.error || r.status)), { status: 503 });
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// Firestore's typed JSON <-> plain values
export function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
}
export function decode(f) {
  if (!f) return null;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return f.timestampValue;
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(decode);
  if ('mapValue' in f) return Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  return null;
}
const decodeFields = fields => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decode(v)]));

const base = () => `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
async function call(url, opts = {}, fetchImpl = fetch) {
  const r = await fetchImpl(url, { ...opts, headers: { Authorization: `Bearer ${await accessToken(fetchImpl)}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Firestore said ${r.status}: ${j.error?.message || ''}`.trim()), { status: 502 });
  return j;
}

export async function listDocs(collection, fields = [], fetchImpl = fetch) {
  const out = [];
  let pageToken = '';
  do {
    const qs = ['pageSize=300', ...fields.map(f => 'mask.fieldPaths=' + encodeURIComponent(f)), pageToken ? 'pageToken=' + encodeURIComponent(pageToken) : ''].filter(Boolean).join('&');
    const j = await call(`${base()}/${collection}?${qs}`, {}, fetchImpl);
    for (const d of j?.documents || []) out.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields) });
    pageToken = j?.nextPageToken || '';
  } while (pageToken);
  return out;
}
export async function getData(path, fetchImpl = fetch) {
  const j = await call(`${base()}/${path}`, {}, fetchImpl);
  return j ? decodeFields(j.fields) : null;
}
// Changes only the named fields (creates the document if it does not exist).
export async function patchData(path, data, fetchImpl = fetch) {
  const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return call(`${base()}/${path}?${mask}`, { method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) }) }, fetchImpl);
}
export const _test = { resetToken: () => { cached = { token: null, exp: 0 }; } };
