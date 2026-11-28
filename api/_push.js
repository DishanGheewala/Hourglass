// Web-push keys (VAPID). They are made once by the server and kept in the database, so there is nothing to paste.
// If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set in Vercel they are used instead.
import { generateVAPIDKeys } from 'web-push';
import { getData, patchData } from './_fs.js';

let cache = null;
export async function getVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (cache) return cache;
  let d = await getData('config/vapid');
  if (!d || !d.publicKey || !d.privateKey) {
    const k = generateVAPIDKeys();
    await patchData('config/vapid', { publicKey: k.publicKey, privateKey: k.privateKey });
    d = (await getData('config/vapid')) || k; // if two requests raced, use whichever was stored
  }
  cache = { publicKey: d.publicKey, privateKey: d.privateKey };
  return cache;
}
export function vapidSubject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  try { return 'mailto:' + JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT).client_email; } catch { return 'mailto:admin@example.com'; }
}
