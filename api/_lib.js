// Shared server helpers for the Vercel functions in /api (files starting with "_" are not endpoints).
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'hourglass-4f6f9';

// Full admin access (needed only for push alerts and the AI daily limit). Optional.
// firebase-admin is loaded only when needed, so the AI chat never depends on it.
export const hasAdmin = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;
export async function admin() {
  if (!hasAdmin()) throw Object.assign(new Error('Alerts need FIREBASE_SERVICE_ACCOUNT in Vercel (SETUP.md, step 5).'), { status: 503 });
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  let app = getApps().find(a => a.name === '[DEFAULT]');
  if (!app) app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return { db: getFirestore(app) };
}

// Checks the Firebase sign-in token the browser sends. Needs no secret: only Google's public keys.
const KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_account/v1/jwk/securetoken@system.gserviceaccount.com'));
export async function verifyToken(token, keys = KEYS) {
  const { payload } = await jwtVerify(token, keys, { issuer: `https://securetoken.google.com/${PROJECT_ID}`, audience: PROJECT_ID, algorithms: ['RS256'] });
  if (!payload.sub) throw new Error('no subject');
  return { ...payload, uid: payload.sub };
}
export async function requireUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  try { return await verifyToken(token); }
  catch (e) { console.error('verifyToken', e.code || e.message); throw Object.assign(new Error('Your sign-in expired. Refresh the page.'), { status: 401 }); }
}

export function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
