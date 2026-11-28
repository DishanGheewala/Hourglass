// Shared server helpers for the Vercel functions in /api (files starting with "_" are not endpoints).
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'hourglass-4f6f9';

// The service account (optional) is only needed for alerts and the AI daily limit; see _fs.js.
export const hasAdmin = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;

// Checks the Firebase sign-in token the browser sends. Needs no secret: only Google's public keys.
const KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com'));
export async function verifyToken(token, keys = KEYS) {
  const { payload } = await jwtVerify(token, keys, { issuer: `https://securetoken.google.com/${PROJECT_ID}`, audience: PROJECT_ID, algorithms: ['RS256'], clockTolerance: 60 });
  if (!payload.sub) throw new Error('no subject');
  return { ...payload, uid: payload.sub };
}
export async function requireUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  try { return await verifyToken(token); }
  catch (e) { const why = [e.code, e.claim].filter(Boolean).join(' ') || e.message; console.error('verifyToken', why); throw Object.assign(new Error(`Your sign-in could not be verified (${why}). Refresh the page and try again.`), { status: 401 }); }
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
