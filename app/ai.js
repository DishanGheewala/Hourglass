// The Hourglass assistant: a Claude-powered chat that can use the student's data and linked Google accounts.
// The conversation and the notes it learns are saved in Firestore so it remembers across sessions.
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, orderBy, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import * as G from './google.js';
import * as Local from './local-ai.js';
import { esc, todayISO, addDays, fmtDate, fmtHM, fmtTime12 } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const MAX_STEPS = 25;
const MAX_SAVED_CHARS = 500000; // keep one saved chat under Firestore's 1 MB document limit
const MAX_DOC_CHARS = 900000;
const GREETING = 'Hi, how can I help?';
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 3500000; // total base64 size of images sent in one message (the server accepts about 4.5 MB)

let D; // dependencies from app.js
const blankChat = () => ({ id: null, title: '', titled: false, messages: [], display: [{ kind: 'ai', text: GREETING }], pending: [], createdAt: Date.now(), updatedAt: 0 });
let chat = blankChat();
let chats = []; // saved chats: { id, title, updatedAt }
const cache = {}; // id -> saved chat data
let attach = []; // images waiting to be sent: { data, mime, thumb }
let notes = [];
let busy = false;
let loadedFor = null;
let replyTimer = null;
let turnStart = 0;

const aiCol = () => collection(D.db, 'users', D.state.user.uid, 'ai');
const chatDoc = id => doc(D.db, 'users', D.state.user.uid, 'ai', id);
const memRef = () => doc(D.db, 'users', D.state.user.uid, 'ai', 'memory');
// If the database rules for chat storage are not published yet, chats are kept on this device instead.
const localKey = () => 'hg_chats_' + D.state.user.uid;
const curKey = () => 'hg_ai_cur_' + D.state.user.uid;
const localAll = () => { try { return JSON.parse(localStorage.getItem(localKey()) || '{}'); } catch { return {}; } };
function localPut(id, data) { try { const m = localAll(); m[id] = data; localStorage.setItem(localKey(), JSON.stringify(m)); } catch {} }
function localDrop(id) { try { const m = localAll(); delete m[id]; localStorage.setItem(localKey(), JSON.stringify(m)); } catch {} }
function localNotes(n) { try { if (n) localStorage.setItem('hg_notes_' + D.state.user.uid, JSON.stringify(n)); else return JSON.parse(localStorage.getItem('hg_notes_' + D.state.user.uid) || '[]'); } catch { return []; } }
const ms = t => (t && t.toMillis ? t.toMillis() : Number(t) || 0);
const makeId = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function initAI(deps) {
  D = deps;
  document.addEventListener('change', e => {
    if (e.target.matches('.vocab select')) syncVocab(e.target.closest('.vocab'));
    if (e.target.id === 'ai-file') { addFiles([...e.target.files]); e.target.value = ''; }
  });
  document.addEventListener('paste', e => {
    if (!e.target.closest?.('#tab-ai')) return;
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  document.addEventListener('dragover', e => { if (e.target.closest?.('#tab-ai') && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!e.target.closest?.('#tab-ai')) return;
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
}

// ---------- saving and loading chats ----------
// Images are never stored in the database (too big): saved chats keep a note instead.
const stripImages = messages => messages.map(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image')
  ? { ...m, content: m.content.map(b => (b.type === 'image' ? { type: 'text', text: '[The student shared an image here. It is no longer available.]' } : b)) } : m);

function toData(c) {
  const d = { title: c.title || 'New chat', titled: !!c.titled, messages: JSON.stringify(stripImages(c.messages)), display: JSON.stringify(c.display), pending: c.pending, createdAt: c.createdAt, updatedAt: c.updatedAt };
  while (JSON.stringify(d).length > MAX_DOC_CHARS && c.display.length > 20) { c.display.shift(); d.display = JSON.stringify(c.display); }
  return d;
}
function fromData(id, d) {
  return { id, title: d.title || (id === 'chat' ? 'Earlier chat' : 'Chat'), titled: !!d.titled || id === 'chat', messages: JSON.parse(d.messages || '[]'), display: JSON.parse(d.display || '[]'), pending: d.pending || [], createdAt: ms(d.createdAt) || ms(d.updatedAt), updatedAt: ms(d.updatedAt) };
}
function indexOf(id, d) { return { id, title: d.title || (id === 'chat' ? 'Earlier chat' : 'Chat'), updatedAt: ms(d.updatedAt) }; }

export async function loadAI() {
  const uid = D.state.user.uid;
  if (loadedFor === uid) return;
  loadedFor = uid;
  chat = blankChat(); chats = []; notes = [];
  let docs = {};
  try {
    const [m, snap] = await Promise.all([getDoc(memRef()), getDocs(query(aiCol(), orderBy('updatedAt', 'desc'), limit(60)))]);
    if (m.exists()) notes = m.data().notes || [];
    snap.docs.forEach(d => { if (d.id !== 'memory') docs[d.id] = d.data(); });
  } catch (e) { console.warn('Could not load chats from the database, using this device', e); docs = {}; }
  // Chats kept on this device (used when the database rules for chats are not published yet).
  const local = localAll();
  for (const [id, d] of Object.entries(local)) if (!docs[id] || ms(d.updatedAt) > ms(docs[id].updatedAt)) docs[id] = d;
  if (!notes.length) notes = localNotes();
  try { // chat from before there were several chats
    const old = JSON.parse(localStorage.getItem('hg_ai_' + uid) || 'null');
    if (old && !docs.chat && (old.messages || []).length) docs.chat = { title: 'Earlier chat', messages: JSON.stringify(old.messages), display: JSON.stringify(old.display || []), pending: old.pending || [], updatedAt: 1 };
  } catch {}
  for (const [id, d] of Object.entries(docs)) { if (!d.messages) continue; cache[id] = d; chats.push(indexOf(id, d)); }
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  let want = null; try { want = localStorage.getItem(curKey()); } catch {}
  const pick = chats.find(c => c.id === want) || chats[0];
  if (pick) { try { chat = fromData(pick.id, cache[pick.id]); } catch { chat = blankChat(); } }
  if (!chat.display.length) chat.display.push({ kind: 'ai', text: GREETING });
  render(); renderSide();
  startReplyWatch();
}
export function resetAI() {
  loadedFor = null; chat = blankChat(); chats = []; notes = []; attach = [];
  for (const k of Object.keys(cache)) delete cache[k];
  clearInterval(replyTimer); replyTimer = null;
  const log = $('#ai-log'); if (log) log.innerHTML = '';
  const side = $('#ai-side'); if (side) side.innerHTML = '';
  renderAttach();
}
async function saveChat(c = chat) {
  if (!c.messages.length) return; // a blank chat is not saved until something is said
  if (!c.id) c.id = makeId();
  c.updatedAt = Date.now();
  const data = toData(c);
  cache[c.id] = data;
  const entry = indexOf(c.id, data);
  const i = chats.findIndex(x => x.id === c.id);
  if (i >= 0) chats[i] = entry; else chats.push(entry);
  chats.sort((x, y) => y.updatedAt - x.updatedAt);
  if (c === chat) { try { localStorage.setItem(curKey(), c.id); } catch {} }
  renderSide();
  try { await setDoc(chatDoc(c.id), data); localDrop(c.id); }
  catch (e) { console.warn('Could not save the chat to the database, keeping it on this device', e); localPut(c.id, data); }
}
async function saveNotes() {
  try { await setDoc(memRef(), { notes, updatedAt: serverTimestamp() }); }
  catch (e) { console.warn('Could not save notes to the database, keeping them on this device', e); }
  localNotes(notes);
}
export async function newChat() {
  if (busy) return D.toast('Wait for the answer to finish first.');
  if (!chat.messages.length) { closeSide(); return; } // already a new chat
  chat = blankChat(); attach = [];
  try { localStorage.removeItem(curKey()); } catch {}
  render(); renderSide(); renderAttach(); closeSide();
}
async function openChat(id) {
  if (busy) return D.toast('Wait for the answer to finish first.');
  if (!cache[id]) return;
  try { chat = fromData(id, cache[id]); } catch { return; }
  if (!chat.display.length) chat.display.push({ kind: 'ai', text: GREETING });
  attach = [];
  try { localStorage.setItem(curKey(), id); } catch {}
  render(); renderSide(); renderAttach(); closeSide();
}
async function deleteChat(id) {
  const c = chats.find(x => x.id === id);
  if (!c || busy) return;
  if (!confirm(`Delete the chat “${c.title}”? This can't be undone.`)) return;
  try { await deleteDoc(chatDoc(id)); } catch (e) { console.warn('Could not delete the chat from the database', e); }
  localDrop(id); delete cache[id];
  chats = chats.filter(x => x.id !== id);
  if (chat.id === id) {
    const next = chats[0];
    if (next) { chat = fromData(next.id, cache[next.id]); try { localStorage.setItem(curKey(), next.id); } catch {} }
    else { chat = blankChat(); try { localStorage.removeItem(curKey()); } catch {} }
    render();
  }
  renderSide();
}
export const getNotes = () => notes;
export async function removeNote(i) { notes.splice(i, 1); await saveNotes(); }

// ---------- chat list ----------
const when = t => { if (!t) return ''; const d = new Date(t), n = new Date(); const days = Math.floor((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? d.toLocaleDateString(undefined, { weekday: 'long' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
function renderSide() {
  const el = $('#ai-side'); if (!el) return;
  const rows = chats.map(c => `<div class="chatrow ${c.id === chat.id ? 'on' : ''}" data-action="ai-open" data-id="${esc(c.id)}" role="button" tabindex="0"><span class="ct">${esc(c.title)}</span><small>${esc(when(c.updatedAt))}</small><button class="icon-btn" data-action="ai-del" data-id="${esc(c.id)}" aria-label="Delete chat ${esc(c.title)}"><svg class="i sm" aria-hidden="true"><use href="#i-trash"/></svg></button></div>`).join('');
  el.innerHTML = `<div class="sidehead"><b>Chats</b><button class="btn small" data-action="ai-new">+ New chat</button></div>
    <div class="chatlist">${chat.id ? '' : '<div class="chatrow on"><span class="ct">New chat</span></div>'}${rows || (chat.id ? '' : '<p class="muted" style="padding:6px 4px">Your chats are saved here.</p>')}</div>`;
  const t = $('#ai-title'); if (t) t.textContent = chat.title || 'New chat';
}
const closeSide = () => $('#ai-wrap')?.classList.remove('open');

// A first name for the chat right away, then a better one written by the AI after the first answer.
const quickTitle = text => { const w = String(text).replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' '); return (w.length > 42 ? w.slice(0, 40) + '…' : w) || 'New chat'; };
async function refineTitle(chatRef, userText, aiText) {
  try {
    const token = await D.state.user.getIdToken();
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ title: true, messages: [{ role: 'user', content: `Student: ${userText.slice(0, 400)}\nAssistant: ${aiText.slice(0, 600)}` }] }) });
    if (!res.ok) return;
    const j = await res.json();
    let t = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').split('\n')[0].replace(/["“”*#]/g, '').replace(/[.!]+$/, '').trim();
    if (t && t.length <= 60) { chatRef.title = t; chatRef.titled = true; if (chatRef.id) await saveChat(chatRef); renderSide(); }
  } catch { /* keep the quick title */ }
}

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
    case 'user': return `<div class="msg user">${(it.imgs || []).length ? `<div class="imgs">${it.imgs.map(u => `<img src="${esc(u)}" alt="Image you shared">`).join('')}</div>` : ''}${it.text ? esc(it.text).replace(/\n/g, '<br>') : ''}</div>`;
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
    case 'vocab': return vocabHTML(it, i);
    default: return '';
  }
}
function vocabHTML(it, i) {
  const done = !!it.submitted;
  const used = new Set((it.answers || []).filter(Boolean));
  const rows = it.items.map((q, n) => {
    const given = it.answers?.[n] ?? '';
    const right = done && norm(given) === norm(q.answer);
    const parts = String(q.scenario).split(/_{3,}/);
    const blank = done ? `<span class="blank filled ${right ? 'ok' : 'bad'}">${esc(given || '—')}</span>` : '<span class="blank">______</span>';
    const scenario = parts.map(esc).join(blank);
    const sel = `<select name="v${n}" ${done ? 'disabled' : ''} aria-label="Answer for question ${n + 1}"><option value="">Choose…</option>${it.bank.map(t => `<option value="${esc(t)}" ${given === t ? 'selected' : ''} ${!done && used.has(t) && given !== t ? 'disabled' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const res = done ? `<div class="qres ${right ? 'ok' : 'bad'}">${right ? '✓ Correct' : `✗ Correct answer: <b>${esc(q.answer)}</b>`}<br><span>${esc(q.explanation)}</span></div>` : '';
    return `<div class="vrow"><div class="vsc"><span class="vn">${n + 1}.</span> ${scenario}</div><div class="vans">${sel}</div>${res ? `<div class="vres">${res}</div>` : ''}</div>`;
  }).join('');
  return `<div class="msg ai vocab" data-i="${i}"><p><b>${esc(it.title)}</b></p>${done ? `<p><b>Score: ${it.score}/${it.items.length}</b></p>` : ''}
    <div class="bank"><small>Word bank (use each word once)</small><div class="chips">${it.bank.map(t => `<span class="chip ${used.has(t) ? 'used' : ''}" data-term="${esc(t)}">${esc(t)}</span>`).join('')}</div></div>
    ${rows}${done ? '' : `<button class="primary" data-action="vocab-submit" data-i="${i}">Submit answers</button>`}</div>`;
}
function syncVocab(card) { // each word can be used only once
  if (!card) return;
  const sels = [...card.querySelectorAll('select')];
  const used = new Set(sels.map(x => x.value).filter(Boolean));
  sels.forEach(x => [...x.options].forEach(o => { o.disabled = !!o.value && used.has(o.value) && o.value !== x.value; }));
  card.querySelectorAll('.bank .chip').forEach(c => c.classList.toggle('used', used.has(c.dataset.term)));
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
  const suggest = !busy && chat.display.length <= 1 && !chat.messages.length ? `<div class="suggest">${[
    ['How did I sleep this week, and what should I change?', 'How is my sleep?'],
    ['Help me plan my study time for my upcoming deadlines.', 'Plan my week'],
    ['Summarize my unread emails from the last 3 days.', 'Summarize my emails'],
    ['Make me a practice quiz from my notes in Google Drive.', 'Quiz me from Drive']
  ].map(([t, l]) => `<button class="chip" data-action="chip" data-text="${esc(t)}">${esc(l)}</button>`).join('')}</div>` : '';
  log.innerHTML = chat.display.map(itemHTML).join('') + suggest + (busy ? '<div class="msg status" id="ai-working"><span class="typing"><i></i><i></i><i></i></span> <span id="ai-wtext"></span></div>' : '');
  log.scrollTop = log.scrollHeight;
  const t = $('#ai-title'); if (t) t.textContent = chat.title || 'New chat';
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
    const tidy = c => String(c ?? '').replace(/\s*@\s*/g, ' ').replace(/^\s*\(?[A-Ha-h1-9][).:]\s+/, '').replace(/\s+/g, ' ').trim();
    const qs = [];
    for (const [n, q] of questions.slice(0, 40).entries()) {
      const choices = Array.isArray(q.choices) ? [...new Set(q.choices.map(tidy).filter(Boolean))] : [];
      if (choices.length) {
        if (choices.length < 3) throw new Error(`Question ${n + 1} needs 4 distinct plain-text choices.`);
        const a = tidy(q.answer);
        const hit = choices.find(c => c === a) || choices.find(c => norm(c) === norm(a));
        if (!hit) throw new Error(`Question ${n + 1}: the answer "${q.answer}" must be copied exactly from its choices.`);
        qs.push({ question: String(q.question).trim(), choices, answer: hit, explanation: String(q.explanation || '').trim() });
      } else qs.push({ question: String(q.question).trim(), answer: tidy(q.answer), explanation: String(q.explanation || '').trim() });
    }
    show({ kind: 'quiz', title: tidy(title) || 'Quiz', questions: qs, submitted: false });
    return { shown_to_student: true, note: 'Results will be sent to you after the student submits.' };
  },
  async show_vocab_test({ title, terms, items }) {
    if (!Array.isArray(terms) || !Array.isArray(items)) throw new Error('Provide "terms" and "items" lists.');
    const clean = t => String(t ?? '').replace(/\s+/g, ' ').trim();
    const list = [...new Set(terms.map(clean).filter(Boolean))];
    if (list.length < 3) throw new Error('A vocabulary test needs at least 3 terms.');
    if (items.length !== list.length) throw new Error(`There are ${list.length} terms but ${items.length} items. Write exactly one item per term.`);
    const seen = new Set(), out = [];
    for (const [n, it] of items.entries()) {
      const hit = list.find(t => t === clean(it.answer)) || list.find(t => norm(t) === norm(it.answer));
      if (!hit) throw new Error(`Item ${n + 1}: the answer "${it.answer}" is not in the terms list. Copy it exactly.`);
      if (seen.has(hit)) throw new Error(`The term "${hit}" is used more than once. Each term must be used exactly once.`);
      seen.add(hit);
      let sc = String(it.scenario || '').trim();
      const blanks = sc.match(/_{3,}/g) || [];
      if (blanks.length !== 1) throw new Error(`Item ${n + 1}: the scenario needs exactly one blank written as _____ .`);
      out.push({ scenario: sc, answer: hit, explanation: String(it.explanation || '').trim() });
    }
    if (seen.size !== list.length) throw new Error('Every term must be used exactly once.');
    const bank = [...list];
    for (let i = bank.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bank[i], bank[j]] = [bank[j], bank[i]]; }
    show({ kind: 'vocab', title: clean(title) || 'Vocabulary test', bank, items: out, answers: [], submitted: false });
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
// Images are sent only with the turn they belong to; earlier ones are replaced by a note (keeps requests small).
const forServer = messages => messages.map((m, i) => i < turnStart && Array.isArray(m.content) && m.content.some(b => b.type === 'image')
  ? { ...m, content: m.content.map(b => (b.type === 'image' ? { type: 'text', text: '[Image shared earlier: no longer shown]' } : b)) } : m);
async function callServer() {
  const token = await D.state.user.getIdToken();
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: forServer(chat.messages), linked: D.state.profile?.linked || {} }), signal: AbortSignal.timeout(75000) }).catch(e => { throw new Error(e && e.name === 'TimeoutError' ? 'The AI took too long to answer. Please try again.' : 'Could not reach the AI server. Check your connection.'); });
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

export async function ask(text, images = []) {
  if (busy) return;
  text = String(text || '').trim();
  if (!text && !images.length) return;
  busy = true;
  // Start a fresh thread (keeping the visible history) when the saved one gets too large.
  if (JSON.stringify(stripImages(chat.messages)).length > MAX_SAVED_CHARS) {
    chat.messages = [];
    chat.display.push({ kind: 'status', text: 'Started a fresh conversation thread. I still remember the notes I saved about you.' });
  }
  if (chat.display.length > 150) chat.display = chat.display.slice(-150);
  const startLen = chat.messages.length;
  turnStart = startLen;
  const firstTurn = !chat.messages.length && !chat.titled;
  if (firstTurn) chat.title = quickTitle(text || 'Image chat');
  const notices = chat.pending.map(t => ({ type: 'text', text: `[Automatic notice from the app, not typed by the student] ${t}` }));
  const blocks = [...notices, ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text: text || 'Please look at the image I shared.' }];
  chat.messages.push({ role: 'user', content: blocks });
  chat.messages.push({ role: 'system', content: contextText() });
  chat.display.push({ kind: 'user', text, imgs: images.map(im => im.thumb) });
  render(); renderSide();
  let ok = false, firstReply = '';
  try {
    for (let step = 0; step < (useLocal ? 6 : MAX_STEPS); step++) {
      const r = await callModel();
      const content = r.content?.length ? r.content : [{ type: 'text', text: '…' }];
      chat.messages.push({ role: 'assistant', content });
      const said = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (said && said !== '…') { show({ kind: 'ai', text: said }); if (!firstReply) firstReply = said; }
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
    if (ok && firstTurn && !useLocal) refineTitle(chat, text || 'Image chat', firstReply || 'Done.');
  }
}

// ---------- pictures and screenshots ----------
const loadImg = file => new Promise((res, rej) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('bad image')); }; im.src = u; });
async function shrink(file, max, q) {
  let src;
  try { src = await createImageBitmap(file); } catch { src = await loadImg(file); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
async function addFiles(files) {
  const room = MAX_IMAGES - attach.length;
  if (room <= 0) return D.toast(`You can attach up to ${MAX_IMAGES} images at a time.`);
  for (const f of files.slice(0, room)) {
    try {
      if (!f.type.startsWith('image/')) throw new Error('not an image');
      if (f.size > 25 * 1024 * 1024) { D.toast('That image is too big (over 25 MB).'); continue; }
      const full = await shrink(f, 1280, 0.82), thumb = await shrink(f, 140, 0.55);
      const data = full.split(',')[1];
      if (attach.reduce((n, a) => n + a.data.length, 0) + data.length > MAX_IMAGE_CHARS) { D.toast('Those images are too large together. Remove one.'); continue; }
      attach.push({ data, mime: 'image/jpeg', thumb });
    } catch { D.toast("Couldn't read that image. Try a PNG or JPG."); }
  }
  if (files.length > room) D.toast(`Only the first ${MAX_IMAGES} images were attached.`);
  renderAttach();
}
function renderAttach() {
  const el = $('#ai-attach'); if (!el) return;
  el.hidden = !attach.length;
  el.innerHTML = attach.map((a, i) => `<div class="thumb"><img src="${esc(a.thumb)}" alt="Attached image ${i + 1}"><button type="button" data-action="ai-unattach" data-i="${i}" aria-label="Remove image ${i + 1}">×</button></div>`).join('');
}
export function takeAttachments() { const a = attach; attach = []; renderAttach(); return a; }
export const hasAttachments = () => attach.length > 0;

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
  'vocab-submit': async b => {
    const i = +b.dataset.i, it = chat.display[i], card = b.closest('.vocab');
    const answers = it.items.map((q, n) => card.querySelector(`[name=v${n}]`)?.value || '');
    const blanks = answers.filter(a => !a).length;
    if (blanks && !confirm(`You left ${blanks} blank${blanks > 1 ? 's' : ''}. Submit anyway?`)) return;
    it.answers = answers; it.submitted = true;
    it.score = it.items.filter((q, n) => norm(answers[n]) === norm(q.answer)).length;
    const missed = it.items.map((q, n) => (norm(answers[n]) === norm(q.answer) ? null : `"${q.scenario}" (answered "${answers[n] || 'blank'}", correct "${q.answer}")`)).filter(Boolean);
    chat.pending.push(`The student submitted the vocabulary test "${it.title}": ${it.score}/${it.items.length}.${missed.length ? ' Missed: ' + missed.join('; ') : ''}`);
    render(); await saveChat();
  },
  'ai-new': () => newChat(),
  'ai-history': () => $('#ai-wrap')?.classList.toggle('open'),
  'ai-open': b => openChat(b.dataset.id),
  'ai-del': b => deleteChat(b.dataset.id),
  'ai-attach': () => $('#ai-file')?.click(),
  'ai-unattach': b => { attach.splice(+b.dataset.i, 1); renderAttach(); }
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
