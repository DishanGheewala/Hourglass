// The Hourglass assistant: a Claude-powered chat that can use the student's data and linked Google accounts.
// The conversation and the notes it learns are saved in Firestore so it remembers across sessions.
import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import * as G from './google.js';
import * as Local from './local-ai.js';
import { esc, todayISO, addDays, fmtDate, fmtHM, fmtTime12 } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const MAX_STEPS = 25;
const MAX_SAVED_CHARS = 700000; // keep the saved chat under Firestore's 1 MB document limit
const GREETING = 'Hi, how can I help?';

let D; // dependencies from app.js
let chat = { messages: [], display: [], pending: [] };
let notes = [];
let busy = false;
let loadedFor = null;
let replyTimer = null;

const chatRef = () => doc(D.db, 'users', D.state.user.uid, 'ai', 'chat');
const memRef = () => doc(D.db, 'users', D.state.user.uid, 'ai', 'memory');
// If the database rules for chat storage are not published yet, the chat is kept on this device instead.
const localKey = () => 'hg_ai_' + D.state.user.uid;
function localSave() { try { localStorage.setItem(localKey(), JSON.stringify({ messages: chat.messages, display: chat.display, pending: chat.pending, notes })); } catch {} }
function localLoad() {
  try {
    const l = JSON.parse(localStorage.getItem(localKey()) || 'null');
    if (l) { chat = { messages: l.messages || [], display: l.display || [], pending: l.pending || [] }; notes = l.notes || []; }
  } catch {}
}

export function initAI(deps) { D = deps; }

// ---------- saving and loading ----------
export async function loadAI() {
  const uid = D.state.user.uid;
  if (loadedFor === uid) return;
  loadedFor = uid;
  chat = { messages: [], display: [], pending: [] };
  notes = [];
  try {
    const [c, m] = await Promise.all([getDoc(chatRef()), getDoc(memRef())]);
    if (c.exists()) {
      const d = c.data();
      chat.messages = JSON.parse(d.messages || '[]');
      chat.display = JSON.parse(d.display || '[]');
      chat.pending = d.pending || [];
    }
    if (m.exists()) notes = m.data().notes || [];
  } catch (e) { console.warn('Could not load chat from the database, using this device', e); localLoad(); }
  if (!chat.display.length) chat.display.push({ kind: 'ai', text: GREETING });
  render();
  startReplyWatch();
}
export function resetAI() {
  loadedFor = null; chat = { messages: [], display: [], pending: [] }; notes = [];
  clearInterval(replyTimer); replyTimer = null;
  const log = $('#ai-log'); if (log) log.innerHTML = '';
}
async function saveChat() {
  try {
    await setDoc(chatRef(), { messages: JSON.stringify(chat.messages), display: JSON.stringify(chat.display), pending: chat.pending, updatedAt: serverTimestamp() });
  } catch (e) { console.warn('Could not save chat to the database, keeping it on this device', e); localSave(); }
}
async function saveNotes() {
  try { await setDoc(memRef(), { notes, updatedAt: serverTimestamp() }); }
  catch (e) { console.warn('Could not save notes to the database, keeping them on this device', e); localSave(); }
}
export async function newChat() {
  chat = { messages: [], display: [{ kind: 'ai', text: GREETING }], pending: [] };
  await saveChat();
  render();
}
export const getNotes = () => notes;
export async function removeNote(i) { notes.splice(i, 1); await saveNotes(); }

// ---------- rendering ----------
// Small, safe Markdown: paragraphs, **bold**, *italic*, `code`, links, headings, bullet and numbered lists.
function md(src) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<p><b>${inline(m[1])}</b></p>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

const emailOnly = from => (String(from).match(/<([^>]+)>/) || [, from])[1].trim();

function itemHTML(it, i) {
  switch (it.kind) {
    case 'user': return `<div class="msg user">${esc(it.text).replace(/\n/g, '<br>')}</div>`;
    case 'ai': return `<div class="msg ai">${md(it.text)}</div>`;
    case 'status': return `<div class="msg status">${esc(it.text)}</div>`;
    case 'error': return `<div class="msg ai err-msg">${esc(it.text)}</div>`;
    case 'notice': return `<div class="msg ai notice"><p><b>${esc(emailOnly(it.from))}</b> responded to your email${it.subject ? ` “${esc(it.subject)}”` : ''}:</p><blockquote>${esc(it.body).replace(/\n/g, '<br>')}</blockquote></div>`;
    case 'draft': {
      if (it.status === 'sent') return `<div class="msg ai"><p>✉️ Sent to ${esc(it.to)}: “${esc(it.subject)}”.</p></div>`;
      if (it.status === 'cancelled') return `<div class="msg ai"><p>Draft to ${esc(it.to)} cancelled. Nothing was sent.</p></div>`;
      return `<div class="msg ai emailcard" data-i="${i}"><p><b>Email draft</b>: check it, edit anything, then press Send.</p>
        <label>To<input name="to" value="${esc(it.to)}"></label>
        <label>CC<input name="cc" value="${esc(it.cc || '')}" placeholder="Optional"></label>
        <label>Subject<input name="subject" value="${esc(it.subject)}" maxlength="200"></label>
        <label>Message<textarea name="body" rows="10" maxlength="20000">${esc(it.body)}</textarea></label>
        <div class="row"><button class="primary" data-action="email-send" data-i="${i}">Send</button><button class="btn" data-action="email-cancel" data-i="${i}">Cancel</button></div></div>`;
    }
    case 'quiz': return quizHTML(it, i);
    default: return '';
  }
}
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
function quizHTML(it, i) {
  const done = !!it.submitted;
  const qs = it.questions.map((q, n) => {
    const given = it.answers?.[n] ?? '';
    const right = done && norm(given) === norm(q.answer);
    const field = q.choices?.length
      ? q.choices.map(c => `<label class="check"><input type="radio" name="q${n}" value="${esc(c)}" ${given === c ? 'checked' : ''} ${done ? 'disabled' : ''}> ${esc(c)}</label>`).join('')
      : `<input name="q${n}" value="${esc(given)}" ${done ? 'disabled' : ''} placeholder="Your answer">`;
    const result = done ? `<div class="qres ${right ? 'ok' : 'bad'}">${right ? '✓ Correct' : `✗ Correct answer: <b>${esc(q.answer)}</b>`}<br><span>${esc(q.explanation)}</span></div>` : '';
    return `<li><p>${esc(q.question)}</p>${field}${result}</li>`;
  }).join('');
  const score = done ? `<p><b>Score: ${it.score}/${it.questions.length}</b></p>` : '';
  return `<div class="msg ai quiz" data-i="${i}"><p><b>${esc(it.title)}</b></p>${score}<ol>${qs}</ol>${done ? '' : `<button class="primary" data-action="quiz-submit" data-i="${i}">Submit answers</button>`}</div>`;
}

function render() {
  const log = $('#ai-log');
  if (!log) return;
  const suggest = !busy && chat.display.length <= 1 ? `<div class="suggest">${[
    ['How did I sleep this week, and what should I change?', 'How is my sleep?'],
    ['Help me plan my study time for my upcoming deadlines.', 'Plan my week'],
    ['Summarize my unread emails from the last 3 days.', 'Summarize my emails'],
    ['Make me a practice quiz from my notes in Google Drive.', 'Quiz me from Drive']
  ].map(([t, l]) => `<button class="chip" data-action="chip" data-text="${esc(t)}">${esc(l)}</button>`).join('')}</div>` : '';
  log.innerHTML = chat.display.map(itemHTML).join('') + suggest + (busy ? '<div class="msg status" id="ai-working"><span class="typing"><i></i><i></i><i></i></span> <span id="ai-wtext"></span></div>' : '');
  log.scrollTop = log.scrollHeight;
}
function setWorking(text) { const w = $('#ai-wtext'); if (w) w.textContent = text; }
function show(item) { chat.display.push(item); render(); }

// ---------- context sent with each message ----------
function contextText() {
  const st = D.state, p = st.profile || {};
  const now = new Date();
  const today = todayISO();
  const start = addDays(today, -13);
  const logs = st.logs.filter(l => l.date >= start).sort((a, b) => a.date.localeCompare(b.date));
  const byDay = {};
  for (const l of logs) (byDay[l.date] ||= {})[l.category] = l;
  const fmt = (l, k) => !l ? '-' : `${fmtHM(l.hours)}${l.rating != null ? ` (${k} ${l.rating}/10)` : ''}`;
  const rows = Object.keys(byDay).sort().map(d => `${d}: sleep ${fmt(byDay[d].sleep, 'sleepiness')}; study/work ${fmt(byDay[d].work, 'productivity')}; free ${fmt(byDay[d].free)}`);
  const dls = st.deadlines.filter(d => d.date >= today).slice(0, 15).map(d => `${d.date}${d.time ? ' ' + d.time : ''}: ${d.title} [id ${d.id}]`);
  const L = p.linked || {};
  const linked = ['calendar', 'gmail', 'drive'].filter(k => L[k]).join(', ') || 'none';
  return [
    `Context from the Hourglass app (updated for this message):`,
    `Today: ${now.toLocaleDateString('en-US', { weekday: 'long' })} ${today}, local time ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    `Student's name: ${p.displayName || 'unknown (ask before signing an email)'}. User ID: ${p.userId}.`,
    `Linked Google services: ${linked}.`,
    `Reminder alerts: ${(st.alerts || []).map(a => `${a.time}${a.label ? ` "${a.label}"` : ''}`).join(', ') || 'none'}.`,
    `Logs, last 14 days:\n${rows.join('\n') || 'none yet'}`,
    `Total days ever logged: ${new Set(st.logs.map(l => l.date)).size}.`,
    `Upcoming deadlines:\n${dls.join('\n') || 'none'}`,
    `Notes you saved about the student:\n${notes.map(n => '- ' + n).join('\n') || 'none yet'}`
  ].join('\n\n');
}

// ---------- tools (run in the browser) ----------
const needs = svc => { if (!D.state.profile?.linked?.[svc]) throw new Error(`${{ gmail: 'Gmail', drive: 'Google Drive', calendar: 'Google Calendar' }[svc]} is not linked. The student can link it in Settings.`); };
const validDate = d => { if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new Error('Date must be YYYY-MM-DD.'); return d; };

// Makes sure every email has a greeting and a closing with the student's name, whichever AI wrote it.
function polishEmail(body) {
  let b = String(body || '').trim();
  const name = (D.state.profile?.displayName || '').trim();
  if (!/^(dear|hi|hello|hey|good (morning|afternoon|evening))\b/i.test(b)) b = 'Hello,\n\n' + b;
  if (!/(best regards|kind regards|regards|sincerely|best wishes|thank you|thanks|cheers)[,.!]?\s*[\s\S]{0,60}$/i.test(b.slice(-160))) b += '\n\nBest regards,' + (name ? '\n' + name : '');
  return b;
}

const TOOLS = {
  async log_time({ category, date, hours, rating }) {
    validDate(date);
    if (!D.CATS[category]) throw new Error('Unknown category.');
    if (date > todayISO()) throw new Error('Cannot log a future day.');
    hours = Math.round(Number(hours) * 100) / 100;
    if (!(hours >= 0 && hours <= 24)) throw new Error('Hours must be between 0 and 24.');
    const r = category === 'free' || rating == null ? null : Math.min(10, Math.max(1, Math.round(rating)));
    const had = D.state.logs.some(l => l.id === `${category}_${date}`);
    await D.saveLog(category, date, hours, r);
    show({ kind: 'status', text: `Logged ${fmtHM(hours)} of ${D.CATS[category].label.toLowerCase()} for ${fmtDate(date)}${r != null ? ` (${D.CATS[category].ratingKey.toLowerCase()} ${r}/10)` : ''}.` });
    return { saved: true, replaced_earlier_entry: had };
  },
  async delete_log({ category, date }) {
    const l = D.state.logs.find(x => x.id === `${category}_${validDate(date)}`);
    if (!l) return { deleted: false, reason: 'No log for that day.' };
    await D.deleteLog(l);
    show({ kind: 'status', text: `Deleted the ${D.CATS[category].label.toLowerCase()} log for ${fmtDate(date)}.` });
    return { deleted: true };
  },
  async get_logs({ start_date, end_date, category }) {
    return D.state.logs.filter(l => l.date >= start_date && l.date <= end_date && (!category || l.category === category))
      .sort((a, b) => a.date.localeCompare(b.date)).map(l => ({ date: l.date, category: l.category, hours: l.hours, rating: l.rating ?? null }));
  },
  async add_deadline({ title, date, time }) {
    validDate(date);
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw new Error('Time must be HH:MM.');
    const gcal = !!D.state.profile?.linked?.calendar;
    let calendarNote = gcal ? 'Also added to Google Calendar.' : 'Google Calendar is not linked, so it is only in Hourglass.';
    try { await D.addDeadline({ title, date, time, gcal }); }
    catch (e) { if (!gcal) throw e; calendarNote = `Saved in Hourglass, but Google Calendar failed: ${e.message}`; }
    show({ kind: 'status', text: `Added deadline “${title}” on ${fmtDate(date)}${time ? ' at ' + fmtTime12(time) : ''}.` });
    return { added: true, note: calendarNote };
  },
  async list_deadlines({ include_past }) {
    const t = todayISO();
    return D.state.deadlines.filter(d => include_past || d.date >= t).map(d => ({ id: d.id, title: d.title, date: d.date, time: d.time || null }));
  },
  async delete_deadline({ id }) {
    const d = D.state.deadlines.find(x => x.id === id);
    if (!d) return { deleted: false, reason: 'No deadline with that id.' };
    await D.deleteDeadline(d);
    show({ kind: 'status', text: `Deleted deadline “${d.title}”.` });
    return { deleted: true };
  },
  async set_reminders({ alerts }) {
    const clean = (alerts || []).filter(a => /^\d{2}:\d{2}$/.test(a.time)).map(a => ({ time: a.time, label: String(a.label || '').slice(0, 120) }));
    await D.setAlerts(clean);
    show({ kind: 'status', text: `Reminders set: ${clean.map(a => fmtTime12(a.time)).join(', ') || 'none'}.` });
    return { saved: clean, push_enabled_on_this_device: D.pushEnabled() };
  },
  async remember({ note }) {
    note = String(note).trim().slice(0, 300);
    if (note && !notes.includes(note)) { notes.push(note); if (notes.length > 80) notes.shift(); await saveNotes(); }
    return { saved: true };
  },
  async forget({ note }) {
    const i = notes.findIndex(n => n === note || n.toLowerCase().includes(String(note).toLowerCase()));
    if (i < 0) return { deleted: false };
    notes.splice(i, 1); await saveNotes();
    return { deleted: true };
  },
  async gmail_search({ query: q, max_results }) { needs('gmail'); setWorking('Searching Gmail…'); return G.gmailSearch(q, max_results); },
  async gmail_read({ message_id }) { needs('gmail'); setWorking('Reading an email…'); return G.gmailRead(message_id); },
  async draft_email({ to, cc, subject, body, reply_to_message_id }) {
    needs('gmail');
    body = polishEmail(body);
    show({ kind: 'draft', to, cc: cc || '', subject, body, replyToId: reply_to_message_id || null, status: 'draft' });
    return { shown_to_student: true, note: 'The student will review it and press Send. It has not been sent yet.' };
  },
  async calendar_list_events({ start_date, end_date }) { needs('calendar'); setWorking('Checking your calendar…'); return G.listCalendarEvents(validDate(start_date), validDate(end_date)); },
  async calendar_create_event({ title, date, start_time, end_time, description }) {
    needs('calendar');
    const r = await G.addCalendarEvent({ title, date: validDate(date), time: start_time, endTime: end_time, description });
    show({ kind: 'status', text: `Added “${title}” to Google Calendar on ${fmtDate(date)}${start_time ? ' at ' + fmtTime12(start_time) : ''}.` });
    return { created: true, link: r.htmlLink };
  },
  async drive_search(input) { needs('drive'); setWorking('Searching Google Drive…'); return G.driveSearch(input); },
  async drive_read_file({ file_id }) {
    needs('drive'); setWorking('Reading a file from Drive…');
    const r = await G.driveRead(file_id);
    show({ kind: 'status', text: r.error ? `Couldn't read “${r.name}”.` : `Read “${r.name}”.` });
    return r;
  },
  async drive_create_doc({ title, content }) {
    needs('drive');
    const r = await G.driveCreateDoc(title, content);
    show({ kind: 'status', text: `Saved “${r.name}” to your Google Drive.` });
    return r;
  },
  async show_quiz({ title, questions }) {
    if (!Array.isArray(questions) || !questions.length) throw new Error('A quiz needs questions.');
    show({ kind: 'quiz', title, questions: questions.slice(0, 40), submitted: false });
    return { shown_to_student: true, note: 'Results will be sent to you after the student submits.' };
  }
};

async function runTool(block) {
  try {
    const fn = TOOLS[block.name];
    if (!fn) throw new Error(`Unknown tool ${block.name}`);
    const out = await fn(block.input || {});
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out ?? { ok: true }) };
  } catch (e) {
    return { type: 'tool_result', tool_use_id: block.id, content: String(e.message || e), is_error: true };
  }
}

// ---------- the conversation loop ----------
// Which AI answers: the cloud AI when the server has a key, otherwise the free on-device AI.
let useLocal = false;
async function callServer() {
  const token = await D.state.user.getIdToken();
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: chat.messages }), signal: AbortSignal.timeout(75000) }).catch(e => { throw new Error(e && e.name === 'TimeoutError' ? 'The AI took too long to answer. Please try again.' : 'Could not reach the AI server. Check your connection.'); });
  let data = {};
  try { data = await res.json(); } catch {}
  if ((res.status === 503 && /not set up/i.test(data.error || '')) || res.status === 404) throw Object.assign(new Error('not set up'), { notSetUp: true, detail: res.status === 404 ? 'the AI server was not found (404)' : (data.error || 'no key set') });
  if (!res.ok) throw new Error(data.error || `The AI server returned ${res.status}.`);
  return data;
}
async function callLocal() {
  if (!Local.supported()) throw new Error("This browser can't run the free on-device AI (it needs WebGPU). Try Chrome or Edge on a computer or a recent Android phone, or ask the app's owner to switch on the full AI.");
  if (!Local.isReady()) {
    if (localStorage.getItem('hg_local_ready') !== '1' && !confirm('The free AI runs privately on your device. It needs a one-time download of about 1 GB (use Wi-Fi) and is simpler than the full AI. Download it now?')) {
      throw new Error('No problem. The AI stays off until you allow the download.');
    }
    setWorking('Starting the on-device AI…');
    await Local.load(r => setWorking(`Downloading the AI… ${Math.round((r.progress || 0) * 100)}%`));
    try { localStorage.setItem('hg_local_ready', '1'); } catch {}
  }
  setWorking('Thinking…');
  const raw = await Local.generate(Local.buildPrompt(chat.messages, D.state.profile?.linked || {}), {
    onToken: t => setWorking(`Writing… ${t.trim().split(/\s+/).length} words`)
  });
  const { text, calls } = Local.parseOutput(raw);
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls) content.push({ type: 'tool_use', id: 'call_' + Math.random().toString(36).slice(2, 12), name: c.name, input: c.input });
  return { content, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_details: null };
}
async function callModel() {
  if (!useLocal) {
    try { return await callServer(); }
    catch (e) {
      if (!e.notSetUp) throw e;
      useLocal = true;
      show({ kind: 'status', text: `The cloud AI is not available (${e.detail}). Using the simpler on-device AI instead.` });
    }
  }
  return callLocal();
}

export async function ask(text) {
  if (busy) return;
  busy = true;
  // Start a fresh thread (keeping the visible history) when the saved one gets too large.
  if (JSON.stringify(chat.messages).length > MAX_SAVED_CHARS) {
    chat.messages = [];
    chat.display.push({ kind: 'status', text: 'Started a fresh conversation thread. I still remember the notes I saved about you.' });
  }
  if (chat.display.length > 150) chat.display = chat.display.slice(-150);
  const startLen = chat.messages.length;
  const notices = chat.pending.map(t => ({ type: 'text', text: `[Automatic notice from the app, not typed by the student] ${t}` }));
  chat.messages.push({ role: 'user', content: [...notices, { type: 'text', text }] });
  chat.messages.push({ role: 'system', content: contextText() });
  chat.display.push({ kind: 'user', text });
  render();
  let ok = false;
  try {
    for (let step = 0; step < (useLocal ? 6 : MAX_STEPS); step++) {
      const r = await callModel();
      const content = r.content?.length ? r.content : [{ type: 'text', text: '…' }];
      chat.messages.push({ role: 'assistant', content });
      const said = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (said && said !== '…') show({ kind: 'ai', text: said });
      if (r.stop_reason === 'refusal') { if (!said) show({ kind: 'ai', text: "I can't help with that one, but I'm happy to help with something else." }); break; }
      if (r.stop_reason === 'pause_turn') continue;
      if (r.stop_reason === 'tool_use') {
        const uses = content.filter(b => b.type === 'tool_use');
        const results = [];
        for (const u of uses) results.push(await runTool(u)); // in order, so pop-ups and drafts appear in sequence
        chat.messages.push({ role: 'user', content: results });
        setWorking('Thinking…');
        continue;
      }
      if (r.stop_reason === 'max_tokens') show({ kind: 'status', text: 'That answer was cut off for length. Ask me to continue.' });
      break;
    }
    ok = true;
  } catch (e) {
    // Undo the unfinished turn so the saved conversation stays valid, but keep what was shown.
    chat.messages.length = startLen;
    show({ kind: 'error', text: e.message || 'Something went wrong. Try again.' });
  } finally {
    busy = false;
    if (ok) chat.pending = [];
    render();
    await saveChat();
  }
}

// ---------- buttons inside the chat ----------
export const aiActions = {
  'email-send': async b => {
    const i = +b.dataset.i, it = chat.display[i], card = b.closest('.emailcard');
    const v = n => card.querySelector(`[name=${n}]`).value.trim();
    const draft = { to: v('to'), cc: v('cc'), subject: v('subject'), body: v('body') };
    if (!G.addrsValid(draft.to)) return D.toast('Check the To address.');
    if (draft.cc && !G.addrsValid(draft.cc)) return D.toast('Check the CC address.');
    if (!draft.subject || !draft.body) return D.toast('Add a subject and a message first.');
    card.querySelectorAll('button').forEach(x => (x.disabled = true));
    try {
      const r = await G.sendEmail({ ...draft, replyToId: it.replyToId });
      Object.assign(it, draft, { status: 'sent' });
      try { // remember the thread so we can tell the student when someone replies (stored on their profile)
        const watched = [...(D.state.profile.watched || []), { threadId: r.threadId, to: draft.to, subject: draft.subject, sentAt: Date.now(), seen: [r.id] }].slice(-30);
        await D.patchProfile({ watched });
      } catch (err) { console.warn('Could not watch for replies', err); }
      chat.pending.push(`The student pressed Send: the email "${draft.subject}" to ${draft.to} was sent${draft.body !== it.body ? ' (after their edits)' : ''}.`);
      render(); await saveChat();
      startReplyWatch();
      D.toast('Email sent.');
    } catch (e) {
      card.querySelectorAll('button').forEach(x => (x.disabled = false));
      throw e;
    }
  },
  'email-cancel': async b => {
    const it = chat.display[+b.dataset.i];
    it.status = 'cancelled';
    chat.pending.push(`The student cancelled the email draft "${it.subject}" to ${it.to}. Nothing was sent.`);
    render(); await saveChat();
  },
  'quiz-submit': async b => {
    const i = +b.dataset.i, it = chat.display[i], card = b.closest('.quiz');
    const answers = it.questions.map((q, n) => q.choices?.length ? (card.querySelector(`[name=q${n}]:checked`)?.value || '') : (card.querySelector(`[name=q${n}]`)?.value.trim() || ''));
    const blanks = answers.filter(a => !a).length;
    if (blanks && !confirm(`You left ${blanks} question${blanks > 1 ? 's' : ''} blank. Submit anyway?`)) return;
    it.answers = answers; it.submitted = true;
    it.score = it.questions.filter((q, n) => norm(answers[n]) === norm(q.answer)).length;
    const missed = it.questions.map((q, n) => (norm(answers[n]) === norm(q.answer) ? null : `"${q.question}" (answered "${answers[n] || 'blank'}", correct "${q.answer}")`)).filter(Boolean);
    chat.pending.push(`The student submitted the quiz "${it.title}": ${it.score}/${it.questions.length}.${missed.length ? ' Missed: ' + missed.join('; ') : ''} (Typed answers are auto-graded by exact match, so a close answer may be marked wrong; judge those yourself.)`);
    render(); await saveChat();
  },
  'ai-new': async () => { if (!busy && confirm('Start a new chat? The notes I saved about you are kept.')) await newChat(); }
};

// ---------- watching for replies to emails sent from Hourglass ----------
export function startReplyWatch() {
  if (replyTimer || !D.state.user) return;
  replyTimer = setInterval(checkReplies, 120000);
  checkReplies();
}
let checking = false;
async function checkReplies() {
  if (checking || !D.state.user || !D.state.profile?.linked?.gmail || !G.hasToken('gmail')) return;
  checking = true;
  try {
    const me = await G.myEmail();
    const since = Date.now() - 30 * 86400000;
    const watched = (D.state.profile.watched || []).filter(w => w.sentAt >= since);
    let found = 0, changed = false;
    for (const e of watched) {
      if (!e.threadId) continue;
      const msgs = await G.gmailThread(e.threadId);
      const seen = new Set(e.seen || []);
      const fresh = msgs.filter(m => !seen.has(m.id) && !emailOnly(m.from).toLowerCase().includes(me));
      msgs.forEach(m => seen.add(m.id));
      for (const m of fresh) {
        const body = G.stripQuoted(m.body) || m.snippet || '';
        chat.display.push({ kind: 'notice', from: m.from, subject: e.subject, body: body.slice(0, 5000) });
        chat.pending.push(`${emailOnly(m.from)} replied to the student's email "${e.subject}" (Gmail message id ${m.id}). Their reply:\n${body.slice(0, 8000)}`);
        found++;
        D.notify(`${emailOnly(m.from)} responded to your email`, body.slice(0, 140));
      }
      if (seen.size !== (e.seen || []).length) { e.seen = [...seen]; changed = true; }
    }
    if (changed) await D.patchProfile({ watched });
    if (found) { render(); await saveChat(); D.markAI(); }
  } catch (e) { console.warn('Reply check failed', e); } finally { checking = false; }
}
