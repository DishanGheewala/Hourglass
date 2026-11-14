// Small shared helpers (no browser or network code, so they can be tested anywhere).

export const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayISO = () => toISO(new Date());
export const addDays = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
export const localDT = d => `${toISO(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

export const fmtDate = iso => fromISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const shortDate = iso => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; };

export function fmtHM(hours) {
  const t = Math.round(hours * 60);
  const h = Math.floor(t / 60), m = t % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

export function fmtTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export const capFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nl = s => esc(s).replace(/\n/g, '<br>');

export const normalizeId = s => String(s || '').trim().toLowerCase();
export const validId = s => /^[a-z0-9._]{3,20}$/.test(s);

// Random study code used in the research sheet instead of the User ID.
export function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return 'P-' + [...bytes].map(b => chars[b % chars.length]).join('');
}

// Averages over the last `days` days (or all time when days is falsy).
export function windowStats(points, days, today) {
  const start = days ? addDays(today, -(days - 1)) : '0000-00-00';
  const w = points.filter(p => p.date >= start && p.date <= today);
  const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    count: w.length,
    avgHours: avg(w.map(p => p.hours)),
    avgRating: avg(w.filter(p => p.rating != null).map(p => p.rating))
  };
}
