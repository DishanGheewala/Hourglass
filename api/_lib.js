// Shared server helpers for the Vercel functions in /api (files starting with "_" are not endpoints).
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'hourglass-4f6f9';

// Full admin access (needed only for push alerts and the AI daily limit). Optional.
export const hasAdmin = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;
export function admin() {
  if (!hasAdmin()) throw Object.assign(new Error('Alerts need FIREBASE_SERVICE_ACCOUNT in Vercel (SETUP.md, step 5).'), { status: 503 });
  let app = getApps().find(a => a.name === '[DEFAULT]');
  if (!app) app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return { auth: getAuth(app), db: getFirestore(app) };
}

// Checks the Firebase sign-in token the browser sends. Needs no secret: only the public project id.
function verifier() {
  const app = getApps().find(a => a.name === 'hg-verify') || initializeApp({ projectId: PROJECT_ID }, 'hg-verify');
  return getAuth(app);
}
export async function requireUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  try { return await verifier().verifyIdToken(token); }
  catch (e) { console.error('verifyIdToken', e.code || e.message); throw Object.assign(new Error('Your sign-in expired. Refresh the page.'), { status: 401 }); }
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
