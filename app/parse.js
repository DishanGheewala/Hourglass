// Turns what the user types into the AI tab into a command. Pure functions (no browser code).
import { toISO, addDays, pad, capFirst } from './util.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const cut = (text, m) => (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();

export function parseDateText(text, now = new Date()) {
  const today = toISO(now);
  let m;
  if ((m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getMonth() === +m[2] - 1) return { iso: toISO(d), rest: cut(text, m) };
  }
  if ((m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    let d = new Date(y, +m[1] - 1, +m[2]);
    if (d.getMonth() === +m[1] - 1 && d.getDate() === +m[2]) {
      if (!m[3] && toISO(d) < today) d = new Date(y + 1, +m[1] - 1, +m[2]);
      return { iso: toISO(d), rest: cut(text, m) };
    }
  }
  if ((m = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
    let d = new Date(now.getFullYear(), mon, +m[2]);
    if (d.getMonth() === mon && d.getDate() === +m[2]) {
      if (toISO(d) < today) d = new Date(now.getFullYear() + 1, mon, +m[2]);
      return { iso: toISO(d), rest: cut(text, m) };
    }
  }
  if ((m = text.match(/\byesterday\b/i))) return { iso: addDays(today, -1), rest: cut(text, m) };
  if ((m = text.match(/\b(?:today|tonight)\b/i))) return { iso: today, rest: cut(text, m) };
  if ((m = text.match(/\btomorrow\b/i))) return { iso: addDays(today, 1), rest: cut(text, m) };
  if ((m = text.match(/\bin\s+(\d{1,2})\s+days?\b/i))) return { iso: addDays(today, +m[1]), rest: cut(text, m) };
  if ((m = text.match(/\b(?:(?:next|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b/i))) {
    const target = WEEKDAYS[m[1].toLowerCase().slice(0, 3)];
    const diff = (target - now.getDay() + 7) % 7 || 7;
    return { iso: addDays(today, diff), rest: cut(text, m) };
  }
  return { iso: null, rest: text };
}

export function parseTimeText(text) {
  let m = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +(m[2] || 0) < 60) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    return { time: `${pad(h)}:${pad(+(m[2] || 0))}`, rest: cut(text, m) };
  }
  m = text.match(/\bat\s+(\d{1,2}):(\d{2})\b/i);
  if (m && +m[1] < 24 && +m[2] < 60) return { time: `${pad(+m[1])}:${m[2]}`, rest: cut(text, m) };
  return { time: null, rest: text };
}

const detectCategory = low =>
  /\b(sleep|slept)\b/.test(low) ? 'sleep'
  : /\b(free\s*time|free|relax(?:ed|ing)?|chill(?:ed|ing)?)\b/.test(low) ? 'free'
  : /\b(study|studied|studying|homework|work|worked|working)\b/.test(low) ? 'work'
  : null;

function parseLog(text, category, now) {
  let t = text;
  let rating = null;
  const rm =
    t.match(/(?:sleepiness|sleepy|productivity|productive|rating|rated|felt)\D{0,15}?(\d{1,2})(?:\s*(?:\/|out of)\s*10)?\b/i) ||
    t.match(/\b(\d{1,2})\s*\/\s*10\b/);
  if (rm) { rating = +rm[1]; t = cut(t, rm); }
  const dm = parseDateText(t, now);
  const date = dm.iso || toISO(now);
  t = dm.rest;

  let hours = null, m;
  if ((m = t.match(/\b(\d+)h(\d{1,2})\b/i))) hours = +m[1] + +m[2] / 60;
  else if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b\s*(?:and\s*)?(?:(\d{1,2})\s*(?:m|mins?|minutes?)\b)?/i))) hours = +m[1] + (m[2] ? +m[2] / 60 : 0);
  else if ((m = t.match(/(\d+)\s*(?:m|mins?|minutes?)\b/i))) hours = +m[1] / 60;
  else if ((m = t.match(/\b(\d+(?:\.\d+)?)\b/))) hours = +m[1];

  if (hours == null) return { type: 'error', message: 'How long? Try: “log sleep 7.5 hours sleepiness 4”.' };
  if (hours < 0 || hours > 24) return { type: 'error', message: 'Hours must be between 0 and 24.' };
  if (rating != null && (rating < 1 || rating > 10)) return { type: 'error', message: 'Ratings are from 1 to 10.' };
  return { type: 'log', category, hours: Math.round(hours * 100) / 100, rating: category === 'free' ? null : rating, date };
}

function parseDeadline(text, now) {
  let t = text;
  const tm = parseTimeText(t); t = tm.rest;
  const dm = parseDateText(t, now); t = dm.rest;
  t = t
    .replace(/^(?:please\s+)?(?:(?:can|could) you\s+)?(?:add|create|set|make|put|schedule|remind me(?: to| about)?)\s+/i, '')
    .replace(/^(?:(?:a|an|the|new|my)\s+)*(?:deadline|due date|reminder|event)\b\s*(?:for|called|named|to|:|-)?\s*/i, '')
    .replace(/\s+(?:on|by|due|at|for|is due)\s*$/i, '')
    .replace(/\s*(?:to|in|on)\s+(?:my\s+)?calendar\.?$/i, '')
    .replace(/^(?:due|by|on|for)\s+/i, '')
    .replace(/\s+(?:on|by|due|at|for|is due)\s*$/i, '')
    .replace(/^[\s.:;,-]+|[\s.:;,-]+$/g, '');
  return { type: 'deadline', title: capFirst(t) || 'Deadline', date: dm.iso, time: tm.time };
}

function parseEmail(text, addr) {
  const to = addr[0];
  let rest = text.replace(to, ' ').replace(/\s+/g, ' ').trim();
  let subject = null, body = null;
  const sm = rest.match(/\bsubject\s*(?:is|:|-)?\s*["“]?(.+?)["”]?\s*(?=\b(?:body|saying|says|message|text)\b|$)/i);
  if (sm) { subject = sm[1].trim(); rest = rest.replace(sm[0], ' ').replace(/\s+/g, ' ').trim(); }
  const bm = rest.match(/\b(?:body|saying|says|say|message|text)\s*(?:is|:|-|that)?\s*["“]?(.+?)["”]?\s*$/is);
  if (bm) body = bm[1].trim();
  else body = rest.replace(/^\s*(?:please\s+)?(?:send\s+(?:an?\s+)?)?(?:e-?mail|mail|write)\s*(?:to)?\s*/i, '').trim();
  return { type: 'email', to, subject: subject || '', body: body || '' };
}

export function parseCommand(input, now = new Date()) {
  const text = String(input || '').trim();
  const low = text.toLowerCase();
  if (!text) return { type: 'empty' };

  const addr = text.match(/[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+/);
  if (addr && /\b(email|e-mail|mail|send|write)\b/i.test(text)) return parseEmail(text, addr);

  if (/\bquiz\b/.test(low) && /\b(folder|drive|from)\b/.test(low)) {
    const fm =
      text.match(/\b(?:folder|drive)\s+(?:called\s+|named\s+)?["“]?(.+?)["”]?\s*$/i) ||
      text.match(/\bfrom\s+(?:my\s+|the\s+)?(?:folder\s+)?["“]?(.+?)["”]?\s*$/i);
    const count = text.match(/(\d{1,2})\s*questions?/i);
    return { type: 'quiz', folder: fm ? fm[1].replace(/^(?:called|named)\s+/i, '').trim() : '', count: count ? Math.min(20, +count[1]) : 8 };
  }
  if (/\b(help|what can you do|commands)\b/.test(low)) return { type: 'help' };
  if (/\b(list|show|what|upcoming|view)\b/.test(low) && /\b(deadlines?|due|calendar)\b/.test(low) && !/\badd\b/.test(low)) return { type: 'list' };
  if (/\b(summary|summarize|my week|this week|average|trend|how am i doing|how have i)\b/.test(low) && !/\b(log|record)\b/.test(low)) return { type: 'summary' };

  const cat = detectCategory(low);
  const hasHours = /\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)\b/.test(low) || /\b\d+h\d+\b/.test(low);
  const startsLog = /^(?:please\s+)?(?:log|record|track|i\s+(?:slept|studied|worked)|slept|studied|worked)\b/.test(low);
  if (cat && (startsLog || hasHours) && !/\b(deadline|due)\b/.test(low)) return parseLog(text, cat, now);
  if (/\b(deadline|due|remind me|calendar|exam|assignment|project)\b/.test(low) || /^\s*(add|create|schedule|set|put)\b/.test(low)) return parseDeadline(text, now);
  return { type: 'unknown' };
}

// ---- Simple fill-in-the-blank quiz from study text (no AI model involved).
const STOP = new Set('about above after again also because before being between could during each other should their there these they this those through under until where which while would your have from into than then them were what when with will that'.split(' '));

export function makeQuiz(text, n = 8) {
  const clean = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(s => { const w = s.split(' ').length; return w >= 8 && w <= 40; });
  const items = [];
  for (const s of sentences) {
    const parts = s.split(' ');
    const words = parts
      .map((raw, i) => ({ i, word: raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') }))
      .filter(o => o.word.length >= 6 && !STOP.has(o.word.toLowerCase()) && /^[A-Za-z][A-Za-z-]*$/.test(o.word));
    if (!words.length) continue;
    const caps = words.filter(o => o.i > 0 && /^[A-Z]/.test(o.word));
    const pick = (caps.length ? caps : words).reduce((a, b) => (b.word.length > a.word.length ? b : a));
    items.push({ q: parts.map((w, i) => (i === pick.i ? w.replace(pick.word, '_____') : w)).join(' '), a: pick.word });
  }
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, k) => items[Math.floor(k * step)]);
}
