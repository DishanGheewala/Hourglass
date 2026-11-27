// Area/line charts as SVG strings. One y-axis per chart (hours and ratings are separate charts on purpose).
import { addDays, daysBetween, fmtHM, shortDate } from './util.js';

const W = 640, H = 250, L = 44, R = 14, T = 14, B = 30;

// field: 'hours' | 'rating'.  tone: 'sleep' | 'work' | 'free' | 'rating' (colours come from CSS via data-cat).
export function chartSVG({ points, range, today, field = 'hours', tone = 'sleep', label = '' }) {
  const sorted = [...points].filter(p => p[field] != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!sorted.length) return '';
  let n = range === '7' ? 7 : range === '30' ? 30 : 0;
  if (!n) n = Math.max(7, daysBetween(sorted[0].date, today) + 1);
  const start = addDays(today, -(n - 1));
  const win = sorted.filter(p => p.date >= start && p.date <= today);
  if (!win.length) return '';

  const pw = W - L - R, ph = H - T - B;
  const x = i => L + (i * pw) / (n - 1);
  let yMax, ticks;
  if (field === 'rating') { yMax = 10; ticks = [0, 5, 10]; }
  else {
    const maxH = Math.max(...win.map(p => p.hours));
    const step = maxH <= 5 ? 1 : maxH <= 10 ? 2 : 4;
    yMax = Math.max(step * 3, Math.ceil((maxH + 0.01) / step) * step);
    ticks = []; for (let t = 0; t <= yMax; t += step) ticks.push(t);
  }
  const y = v => T + ph - (v / yMax) * ph;
  const fmtTick = t => (field === 'rating' ? String(t) : `${t}h`);
  const fmtVal = v => (field === 'rating' ? `${v}/10` : fmtHM(v));
  const base = y(0).toFixed(1);

  const grid = ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="axis" x="${L - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtTick(t)}</text>`).join('');

  // Runs of consecutive logged days are joined; a gap breaks the line.
  const runs = []; let cur = [];
  for (const p of win) {
    const i = daysBetween(start, p.date);
    if (cur.length && i !== cur[cur.length - 1].i + 1) { runs.push(cur); cur = []; }
    cur.push({ i, v: p[field] });
  }
  runs.push(cur);
  const gid = `g-${tone}-${field}`;
  let line = '', area = '';
  for (const r of runs) {
    const pts = r.map(q => `${x(q.i).toFixed(1)} ${y(q.v).toFixed(1)}`);
    line += `M${pts.join(' L')} `;
    if (r.length > 1) area += `M${x(r[0].i).toFixed(1)} ${base} L${pts.join(' L')} L${x(r[r.length - 1].i).toFixed(1)} ${base} Z `;
  }

  const dots = win.map(p => {
    const i = daysBetween(start, p.date);
    const cx = x(i).toFixed(1), cy = y(p[field]).toFixed(1);
    return `<g><circle class="hit" cx="${cx}" cy="${cy}" r="13"/><circle class="dot" cx="${cx}" cy="${cy}" r="${n > 31 ? 3 : 4.5}"/><title>${shortDate(p.date)}: ${fmtVal(p[field])}</title></g>`;
  }).join('');

  const every = Math.ceil(n / 6);
  let xl = '';
  for (let i = 0; i < n; i += every) xl += `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${shortDate(addDays(start, i))}</text>`;
  if ((n - 1) % every) xl += `<text class="axis" x="${x(n - 1).toFixed(1)}" y="${H - 8}" text-anchor="middle">${shortDate(today)}</text>`;

  return `<svg class="chart" data-cat="${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}, chart of ${win.length} logged days"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c);stop-opacity:.32"/><stop offset="1" style="stop-color:var(--c);stop-opacity:0"/></linearGradient></defs><g>${grid}</g><path d="${area.trim()}" fill="url(#${gid})"/><path class="line" d="${line.trim()}"/>${dots}${xl}</svg>`;
}
