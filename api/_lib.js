// Shared server helpers for the Vercel functions in /api.
// Files starting with "_" are not turned into endpoints by Vercel.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// FIREBASE_SERVICE_ACCOUNT holds the whole service-account JSON (SETUP.md, step 4).
export function admin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel.');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

// Checks the Firebase ID token the browser sends as "Authorization: Bearer <token>".
export async function requireUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  try {
    return await admin().auth.verifyIdToken(token);
  } catch {
    throw Object.assign(new Error('Your sign-in expired. Refresh the page.'), { status: 401 });
  }
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
