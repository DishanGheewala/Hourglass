import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot, addDoc,
  serverTimestamp, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, RESEARCH_URL, STUDY_KEY, ID_DOMAIN } from './config.js';
import {
  esc, nl, pad, todayISO, addDays, fromISO, toISO, fmtDate, fmtHM, fmtTime12, normalizeId, validId, genCode, windowStats
} from './util.js';
import { chartSVG } from './charts.js';
import { parseCommand, makeQuiz } from './parse.js';
import * as G from './google.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const CATS = {
  sleep: { label: 'Sleep', dateLabel: 'Date you woke up', ratingKey: 'Sleepiness', ratingQ: 'How sleepy did you feel this morning? (1 = wide awake, 10 = very sleepy)' },
  work: { label: 'Study / Work', dateLabel: 'Date', ratingKey: 'Productivity', ratingQ: 'How productive did you feel? (1 = not at all, 10 = very productive)' },
  free: { label: 'Free time', dateLabel: 'Date', ratingKey: null, ratingQ: null }
};
const SERVICES = {
  calendar: { name: 'Google Calendar', note: 'Add deadlines and a daily reminder to your Google Calendar.' },
  gmail: { name: 'Gmail (send only)', note: 'Lets the assistant send an email you approve. It cannot read your inbox.' },
  drive: { name: 'Google Drive (read only)', note: 'Lets the assistant read a folder you name, for example to build a practice quiz.' }
};

const state = {
  user: null, profile: null, logs: [], deadlines: [],
  tab: 'log', cat: 'sleep', range: { sleep: '30', work: '30', free: '30' },
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1), calSel: todayISO(),
  aiStarted: false
};

// ---------- small UI helpers ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3800);
}
function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  m.querySelector('input,button')?.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
function show(view) {
  $('#boot').hidden = true;
  $('#auth').hidden = view !== 'auth';
  $('#app').hidden = view !== 'app';
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('hg_theme', t); } catch {}
}
applyTheme((() => { try { return localStorage.getItem('hg_theme'); } catch { return null; } })() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- Firebase ----------
const configured = !String(firebaseConfig.apiKey).startsWith('PASTE');
let auth, db;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}
const uref = () => doc(db, 'users', state.user.uid);
const logsCol = () => collection(db, 'users', state.user.uid, 'logs');
const dlCol = () => collection(db, 'users', state.user.uid, 'deadlines');
async function patchProfile(p) { await updateDoc(uref(), p); state.profile = { ...state.profile, ...p }; }

// ---------- research sharing (only with consent) ----------
const researchReady = () => RESEARCH_URL && !String(RESEARCH_URL).startsWith('PASTE');
const qKey = () => 'hg_queue_' + state.user.uid;
const readQ = key => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
function sendResearch(item, { force = false } = {}) {
  if (!state.user || !researchReady() || (!force && !state.profile?.consent)) return;
  const key = qKey();
  const q = readQ(key);
  q.push({ ...item, code: state.profile.participantCode, ts: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(q));
  flushQueue();
}
let flushing = false;
async function flushQueue() {
  if (flushing || !state.user || !researchReady()) return;
  flushing = true;
  const key = qKey();
  try {
    let q;
    while ((q = readQ(key)).length) {
      await fetch(RESEARCH_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...q[0], key: STUDY_KEY })
      });
      localStorage.setItem(key, JSON.stringify(readQ(key).slice(1)));
    }
  } catch { /* offline: try again next time */ } finally { flushing = false; }
}

// ---------- consent ----------
function askConsent() {
  return new Promise(resolve => {
    openModal(`
      <h2 style="margin-top:0">Research consent</h2>
      <p>Hourglass is also a school research project about how students spend their time.</p>
      <p><b>If you say yes:</b> your sleep, study/work and free-time logs (hours, sleepiness and productivity ratings, and dates) are copied to a private research spreadsheet. The spreadsheet uses a random study code, never your User ID, and we collect no name, email or school account. Results are only reported as group totals, so <b>your identity will not be disclosed</b>.</p>
      <p>Your calendar deadlines and anything you ask the AI assistant are never shared.</p>
      <p><b>It's your choice.</b> The app works exactly the same if you say no. You can change your mind any time in Settings, which stops the sharing and removes your rows from the spreadsheet.</p>
      <label class="check"><input type="checkbox" id="c-age"> I'm 18 or older, or my parent/guardian says I can take part.</label>
      <div class="stack">
        <button class="primary" id="c-yes" disabled>I consent: share my logs for research</button>
        <button class="btn" id="c-no">No thanks: keep my data private</button>
      </div>`);
    $('#c-age').addEventListener('change', e => { $('#c-yes').disabled = !e.target.checked; });
    $('#c-yes').onclick = () => { closeModal(); resolve(true); };
    $('#c-no').onclick = () => { closeModal(); resolve(false); };
  });
}
function askPassword(title, text) {
  return new Promise(resolve => {
    openModal(`<h2 style="margin-top:0">${esc(title)}</h2><p>${esc(text)}</p>
      <label for="pw-ask">Your password</label><input id="pw-ask" type="password" autocomplete="current-password">
      <div class="stack"><button class="primary" id="pw-ok">Continue</button><button class="btn" id="pw-cancel">Cancel</button></div>`);
    $('#pw-ok').onclick = () => { const v = $('#pw-ask').value; closeModal(); resolve(v || null); };
    $('#pw-cancel').onclick = () => { closeModal(); resolve(null); };
  });
}

// ---------- auth ----------
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $$('[data-action="authmode"]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#confirm-row').hidden = m !== 'signup';
  $('#auth-hint').hidden = m !== 'signup';
  $('#auth-submit').textContent = m === 'signup' ? 'Create account' : 'Log in';
  $('#auth-error').textContent = '';
  $('#a-pw').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
}
function authMessage(e) {
  switch (e.code) {
    case 'auth/email-already-in-use': return 'That User ID is already taken. Try another.';
    case 'auth/invalid-credential': case 'auth/user-not-found': case 'auth/wrong-password': return 'User ID or password is wrong.';
    case 'auth/weak-password': return 'Choose a stronger password (8+ characters).';
    case 'auth/network-request-failed': return 'No internet connection. Try again.';
    case 'auth/too-many-requests': return 'Too many tries. Wait a few minutes and try again.';
    case 'auth/operation-not-allowed': return 'Email/Password sign-in is not turned on in Firebase (SETUP.md step 1).';
    default: return 'Something went wrong. Please try again.';
  }
}
async function doAuth(form) {
  const err = $('#auth-error');
  err.textContent = '';
  if (!auth) { err.textContent = 'The app is not connected to its database yet (see SETUP.md).'; return; }
  const id = normalizeId(form.userid.value);
  const pw = form.password.value;
  if (!validId(id)) { err.textContent = 'User ID must be 3–20 letters, numbers, dots or underscores.'; return; }
  if (authMode === 'signup') {
    if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
    if (pw !== form.confirm.value) { err.textContent = 'The two passwords do not match.'; return; }
  }
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const email = `${id}@${ID_DOMAIN}`;
    if (authMode === 'signup') await createUserWithEmailAndPassword(auth, email, pw);
    else await signInWithEmailAndPassword(auth, email, pw);
    form.reset();
  } catch (e) { err.textContent = authMessage(e); } finally { btn.disabled = false; }
}

let unsubs = [];
let reminderTimer = null;
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; clearInterval(reminderTimer); }

if (auth) {
  onAuthStateChanged(auth, async user => {
    stopListeners();
    if (!user) {
      state.user = null; state.profile = null; state.logs = []; state.deadlines = [];
      state.aiStarted = false; $('#ai-log').innerHTML = '';
      setAuthMode('login');
      show('auth');
      return;
    }
    state.user = user;
    try {
      let snap = await getDoc(uref());
      if (!snap.exists() || typeof snap.data().consent !== 'boolean') {
        show('auth');
        const consent = await askConsent();
        await setDoc(uref(), {
          userId: user.email.split('@')[0], participantCode: snap.exists() && snap.data().participantCode ? snap.data().participantCode : genCode(),
          consent, consentAt: serverTimestamp(), reminderTime: '20:30', theme: document.documentElement.dataset.theme,
          approved: [], linked: {}, reminderEventId: null, createdAt: serverTimestamp()
        }, { merge: true });
        snap = await getDoc(uref());
      }
      state.profile = snap.data();
      applyTheme(state.profile.theme || document.documentElement.dataset.theme);
      show('app');
      startListeners();
      setTab(state.tab);
      flushQueue();
      reminderTimer = setInterval(checkReminder, 60000);
      checkReminder();
    } catch (e) {
      toast('Could not load your account. Check your connection and refresh.');
    }
  });
} else {
  $('#boot').hidden = true;
  $('#setup-banner').hidden = false;
  show('auth');
  setAuthMode('login');
}

function startListeners() {
  unsubs.push(onSnapshot(logsCol(), snap => {
    state.logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderData();
  }, () => toast('Could not load your logs.')));
  unsubs.push(onSnapshot(dlCol(), snap => {
    state.deadlines = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    renderData();
  }, () => toast('Could not load your deadlines.')));
}

// ---------- tabs ----------
function setTab(tab) {
  state.tab = tab;
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  if (tab === 'log') { renderLogForm(); renderLogList(); }
  else if (CATS[tab]) renderTrend(tab);
  else if (tab === 'calendar') { renderCalForm(); renderCalendar(); }
  else if (tab === 'ai') startAI();
  else if (tab === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}
function renderData() {
  if (state.tab === 'log') renderLogList();
  else if (CATS[state.tab]) renderTrend(state.tab);
  else if (state.tab === 'calendar') renderCalendar();
}

// ---------- log tab ----------
const missingToday = () => Object.keys(CATS).filter(c => !state.logs.some(l => l.category === c && l.date === todayISO()));
function renderLogForm() {
  const c = CATS[state.cat];
  const date = $('#f-date')?.value || todayISO();
  $('#log-form').innerHTML = `
    <div class="seg" role="group" aria-label="What are you logging?">
      ${Object.entries(CATS).map(([k, v]) => `<button type="button" class="${k === state.cat ? 'on' : ''}" data-action="cat" data-cat="${k}">${esc(v.label)}</button>`).join('')}
    </div>
    <form data-form="log" class="card">
      <label for="f-date">${esc(c.dateLabel)}</label>
      <input id="f-date" type="date" name="date" value="${esc(date)}" max="${todayISO()}" required>
      <div class="row">
        <div><label for="f-h">Hours</label><input id="f-h" name="h" type="number" min="0" max="24" step="1" inputmode="numeric" required></div>
        <div><label for="f-m">Minutes</label><input id="f-m" name="m" type="number" min="0" max="59" step="1" inputmode="numeric" value="0"></div>
      </div>
      ${c.ratingQ ? `<label for="f-r">${esc(c.ratingQ)}</label><select id="f-r" name="rating"><option value="">Skip</option>${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>` : ''}
      <p class="muted" id="f-note"></p>
      <button class="primary">Save</button>
    </form>`;
  prefillLog();
}
function prefillLog() {
  const f = $('#log-form form');
  if (!f) return;
  const ex = state.logs.find(l => l.id === `${state.cat}_${f.date.value}`);
  if (ex) {
    const t = Math.round(ex.hours * 60);
    f.h.value = Math.floor(t / 60); f.m.value = t % 60;
    if (f.rating) f.rating.value = ex.rating ?? '';
  }
  $('#f-note').textContent = ex ? 'You already logged this day. Saving will update it.' : '';
}
function renderLogList() {
  const miss = missingToday();
  const past = state.profile && new Date() >= reminderToday();
  $('#log-banner').innerHTML = `<div class="banner ${miss.length && past ? 'due' : ''}">${miss.length
    ? `Today: ${3 - miss.length} of 3 logged. Still to add: ${miss.map(c => esc(CATS[c].label)).join(', ')}.`
    : 'All three logged for today. Nice work.'}</div>`;
  const c = CATS[state.cat];
  const rows = state.logs.filter(l => l.category === state.cat).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  $('#log-list').innerHTML = `<div class="card"><h3>Your ${esc(c.label.toLowerCase())} logs</h3>${rows.length
    ? rows.map(l => `<div class="logrow"><div><b>${esc(fmtDate(l.date))}</b>: ${esc(fmtHM(l.hours))}${c.ratingKey && l.rating != null ? `<small>${esc(c.ratingKey)} ${l.rating}/10</small>` : ''}</div><button class="btn small danger" data-action="del-log" data-id="${esc(l.id)}" aria-label="Delete log for ${esc(fmtDate(l.date))}">Delete</button></div>`).join('')
    : '<p class="muted">Nothing logged yet.</p>'}</div>`;
}
async function saveLog(cat, date, hours, rating) {
  await setDoc(doc(logsCol(), `${cat}_${date}`), { category: cat, date, hours, rating: rating ?? null, updatedAt: serverTimestamp() });
  sendResearch({ action: 'upsert', category: cat, date, hours, rating: rating ?? null });
}

// ---------- trend tabs ----------
function renderTrend(cat) {
  const c = CATS[cat];
  const today = todayISO();
  const pts = state.logs.filter(l => l.category === cat);
  const range = state.range[cat];
  const stats = windowStats(pts, range === 'all' ? null : +range, today);
  const rangeBtns = [['7', '7 days'], ['30', '30 days'], ['all', 'All']].map(([v, t]) => `<button class="${range === v ? 'on' : ''}" data-action="range" data-cat="${cat}" data-range="${v}">${t}</button>`).join('');
  const hoursSVG = chartSVG({ points: pts, range, today, field: 'hours', tone: 'c1', label: `${c.label} hours per day` });
  const rateSVG = c.ratingKey ? chartSVG({ points: pts, range, today, field: 'rating', tone: 'c2', label: `${c.ratingKey} per day` }) : '';
  const win = pts.filter(p => range === 'all' || (p.date >= addDays(today, -(+range - 1)) && p.date <= today)).sort((a, b) => b.date.localeCompare(a.date));
  $('#tab-' + cat).innerHTML = `
    <h2>${esc(c.label)} trend</h2>
    <div class="seg" role="group" aria-label="Time range">${rangeBtns}</div>
    <div class="stats">
      <div class="stat"><b>${stats.avgHours == null ? '–' : esc(fmtHM(stats.avgHours))}</b><span>Average per day logged</span></div>
      <div class="stat"><b>${stats.count}</b><span>Days logged</span></div>
      ${c.ratingKey ? `<div class="stat"><b>${stats.avgRating == null ? '–' : stats.avgRating.toFixed(1) + '/10'}</b><span>Average ${esc(c.ratingKey.toLowerCase())}</span></div>` : ''}
    </div>
    ${hoursSVG ? `<div class="card chartwrap"><h3>Hours of ${esc(c.label.toLowerCase())} per day</h3>${hoursSVG}</div>` : `<div class="card"><p class="muted">No ${esc(c.label.toLowerCase())} logs in this range yet. Add one in the Log tab.</p></div>`}
    ${rateSVG ? `<div class="card chartwrap"><h3>${esc(c.ratingKey)} (1–10)</h3>${rateSVG}</div>` : ''}
    ${win.length ? `<details><summary>Show as a table</summary><table><thead><tr><th>Date</th><th>Time</th>${c.ratingKey ? `<th>${esc(c.ratingKey)}</th>` : ''}</tr></thead><tbody>${win.map(l => `<tr><td>${esc(fmtDate(l.date))}</td><td>${esc(fmtHM(l.hours))}</td>${c.ratingKey ? `<td>${l.rating ?? '–'}</td>` : ''}</tr>`).join('')}</tbody></table></details>` : ''}`;
}

// ---------- calendar ----------
function renderCalForm() {
  const L = state.profile.linked || {};
  $('#cal-form').innerHTML = `<form data-form="deadline" class="card"><h3>New deadline</h3>
    <label for="d-title">What is due?</label><input id="d-title" name="title" maxlength="100" required>
    <div class="row"><div><label for="d-date">Date</label><input id="d-date" type="date" name="date" value="${esc(state.calSel)}" required></div>
    <div><label for="d-time">Time (optional)</label><input id="d-time" type="time" name="time"></div></div>
    ${L.calendar ? '<label class="check"><input type="checkbox" name="gcal"> Also add a copy to my Google Calendar</label>' : ''}
    <button class="primary">Add deadline</button></form>`;
}
function renderCalendar() {
  const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
  const offset = new Date(y, m, 1).getDay();
  const dim = new Date(y, m + 1, 0).getDate();
  const today = todayISO();
  const has = new Set(state.deadlines.map(d => d.date));
  let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < offset; i++) cells += '<button class="day blank" tabindex="-1" aria-hidden="true"></button>';
  for (let d = 1; d <= dim; d++) {
    const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
    cells += `<button class="day ${iso === today ? 'today' : ''} ${iso === state.calSel ? 'sel' : ''}" data-action="cal-pick" data-date="${iso}" aria-label="${esc(fmtDate(iso))}${has.has(iso) ? ', has a deadline' : ''}">${d}${has.has(iso) ? '<span class="dot"></span>' : ''}</button>`;
  }
  $('#cal-grid').innerHTML = `<div class="card"><div class="calhead"><button class="btn small" data-action="cal-prev" aria-label="Previous month">‹</button>
    <b>${esc(state.calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</b>
    <span><button class="btn small" data-action="cal-today">Today</button> <button class="btn small" data-action="cal-next" aria-label="Next month">›</button></span></div>
    <div class="cal">${cells}</div></div>`;
  const row = d => `<div class="logrow"><div><b>${esc(d.title)}</b><small>${esc(fmtDate(d.date))}${d.time ? ' · ' + esc(fmtTime12(d.time)) : ''}</small></div><button class="btn small danger" data-action="del-deadline" data-id="${esc(d.id)}" aria-label="Delete ${esc(d.title)}">Delete</button></div>`;
  const up = state.deadlines.filter(d => d.date >= today);
  const old = state.deadlines.filter(d => d.date < today).slice(-5).reverse();
  $('#cal-list').innerHTML = `<div class="card"><h3>Upcoming</h3>${up.length ? up.map(row).join('') : '<p class="muted">No upcoming deadlines.</p>'}</div>${old.length ? `<div class="card"><h3>Past</h3>${old.map(row).join('')}</div>` : ''}`;
}
async function addDeadline({ title, date, time, gcal }) {
  await addDoc(dlCol(), { title, date, time: time || '', createdAt: serverTimestamp() });
  if (gcal) await G.addCalendarEvent({ title, date, time });
}

// ---------- reminders ----------
const reminderToday = () => {
  const [h, m] = (state.profile?.reminderTime || '20:30').split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0); return d;
};
function checkReminder() {
  if (!state.profile) return;
  renderLogBannerOnly();
  const flag = 'hg_notified_' + todayISO();
  if (new Date() < reminderToday() || localStorage.getItem(flag) || !missingToday().length) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Hourglass', { body: 'Time to log your day: sleep, study/work and free time.' }); } catch {}
    localStorage.setItem(flag, '1');
  }
}
function renderLogBannerOnly() { if (state.tab === 'log') renderLogList(); }
function downloadReminderICS(time) {
  const [hh, mm] = time.split(':');
  const d = new Date();
  const start = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${hh}${mm}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hourglass//EN', 'BEGIN:VEVENT', `UID:hourglass-reminder-${Date.now()}@hourglass`, `DTSTAMP:${stamp}`, `DTSTART:${start}`, 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'SUMMARY:Hourglass: log your day', 'DESCRIPTION:Log your sleep\\, study time and free time.', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Log your day', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'hourglass-reminder.ics';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- AI assistant ----------
function addMsg(role, html) {
  const log = $('#ai-log');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
const HELP = `Here's what I can do:<ol>
<li><b>Log time:</b> “log sleep 7.5 hours sleepiness 4”, “log study 2 hours productivity 7 yesterday”, “log free time 3 hours”</li>
<li><b>Deadlines:</b> “add deadline Bio test on Friday at 3pm”</li>
<li><b>Summary:</b> “summary of my week” or “list my deadlines”</li>
<li><b>Email</b> (Gmail linked): “email ms.lee@school.org subject: Survey body: Can we meet Friday?”. I show a draft and send only after you press Send, and only to approved recipients.</li>
<li><b>Quiz</b> (Drive linked): “make a quiz from my folder Bio Unit 2”</li></ol>
I follow set commands; I'm not a chatbot that understands everything.`;
function startAI() {
  if (state.aiStarted) return;
  state.aiStarted = true;
  addMsg('ai', `Hi! ${HELP}`);
}
async function runAI(text) {
  addMsg('user', esc(text));
  const cmd = parseCommand(text);
  const L = state.profile.linked || {};
  try {
    switch (cmd.type) {
      case 'help': addMsg('ai', HELP); break;
      case 'error': addMsg('ai', esc(cmd.message)); break;
      case 'log': {
        const had = state.logs.some(l => l.id === `${cmd.category}_${cmd.date}`);
        await saveLog(cmd.category, cmd.date, cmd.hours, cmd.rating);
        const c = CATS[cmd.category];
        addMsg('ai', `Done: logged ${esc(fmtHM(cmd.hours))} of ${esc(c.label.toLowerCase())} for ${esc(fmtDate(cmd.date))}${cmd.rating != null && c.ratingKey ? `, ${esc(c.ratingKey.toLowerCase())} ${cmd.rating}/10` : ''}.${had ? ' (This replaced your earlier entry for that day.)' : ''}`);
        break;
      }
      case 'deadline': {
        if (!cmd.date) { addMsg('ai', 'Which day is it due? Try: “add deadline Bio test on Friday at 3pm”.'); break; }
        let note = '';
        let gcal = false;
        if (L.calendar) gcal = true;
        try { await addDeadline({ title: cmd.title, date: cmd.date, time: cmd.time, gcal }); if (gcal) note = ' I also added it to your Google Calendar.'; }
        catch (e) { if (!gcal) throw e; note = ` It's saved here, but I couldn't add it to Google Calendar (${esc(e.message)}).`; }
        addMsg('ai', `Added “${esc(cmd.title)}” on ${esc(fmtDate(cmd.date))}${cmd.time ? ' at ' + esc(fmtTime12(cmd.time)) : ''}.${note}`);
        break;
      }
      case 'list': {
        const up = state.deadlines.filter(d => d.date >= todayISO()).slice(0, 8);
        addMsg('ai', up.length ? `Coming up:<ol>${up.map(d => `<li>${esc(d.title)}: ${esc(fmtDate(d.date))}${d.time ? ' ' + esc(fmtTime12(d.time)) : ''}</li>`).join('')}</ol>` : 'No upcoming deadlines.');
        break;
      }
      case 'summary': {
        const lines = Object.entries(CATS).map(([k, c]) => {
          const s = windowStats(state.logs.filter(l => l.category === k), 7, todayISO());
          return s.count ? `<li>${esc(c.label)}: ${esc(fmtHM(s.avgHours))} per day over ${s.count} day${s.count > 1 ? 's' : ''}${s.avgRating != null ? `, average ${esc(c.ratingKey.toLowerCase())} ${s.avgRating.toFixed(1)}/10` : ''}</li>` : `<li>${esc(c.label)}: nothing logged in the last 7 days</li>`;
        });
        addMsg('ai', `Your last 7 days:<ol>${lines.join('')}</ol>`);
        break;
      }
      case 'email': await handleEmail(cmd, L); break;
      case 'quiz': await handleQuiz(cmd, L); break;
      default: addMsg('ai', `I didn't understand that. ${HELP}`);
    }
  } catch (e) { addMsg('ai', `Something went wrong: ${esc(e.message || e)}`); }
}
async function handleEmail(cmd, L) {
  if (!L.gmail) { addMsg('ai', 'Link Gmail in Settings first. I can only send, never read, your email.'); return; }
  const to = cmd.to.toLowerCase();
  if (!(state.profile.approved || []).includes(to)) {
    addMsg('ai', `${esc(to)} isn't on your approved recipients list, so I won't email it. <button class="btn small" data-action="approve-addr" data-addr="${esc(to)}">Approve this address</button>`);
    return;
  }
  addMsg('ai', `<div class="emailcard" data-to="${esc(to)}"><p><b>Draft email</b>: nothing is sent until you press Send.</p><p>To: ${esc(to)}</p>
    <label>Subject<input name="subject" value="${esc(cmd.subject || 'Hello')}" maxlength="150"></label>
    <label>Message<textarea name="body" rows="6" maxlength="3000">${esc(cmd.body)}</textarea></label>
    <div class="row"><button class="primary" data-action="email-send">Send</button><button class="btn" data-action="email-cancel">Cancel</button></div></div>`);
}
async function handleQuiz(cmd, L) {
  if (!L.drive) { addMsg('ai', 'Link Google Drive in Settings first.'); return; }
  if (!cmd.folder) { addMsg('ai', 'Which folder? Try: “make a quiz from my folder Bio Unit 2”.'); return; }
  addMsg('ai', `Looking for a folder named “${esc(cmd.folder)}”…`);
  const folder = await G.findFolder(cmd.folder);
  if (!folder) { addMsg('ai', `I couldn't find a folder named “${esc(cmd.folder)}”.`); return; }
  const files = await G.listStudyFiles(folder.id);
  if (!files.length) { addMsg('ai', `“${esc(folder.name)}” has no Google Docs or text files I can read.`); return; }
  let text = '';
  for (const f of files.slice(0, 5)) { text += '\n' + (await G.readFileText(f)); if (text.length > 80000) break; }
  const qs = makeQuiz(text, cmd.count);
  if (!qs.length) { addMsg('ai', 'I couldn\'t find enough full sentences in those files to make questions.'); return; }
  const plain = qs.map((x, i) => `${i + 1}. ${x.q}`).join('\n') + '\n\nAnswers\n' + qs.map((x, i) => `${i + 1}. ${x.a}`).join('\n');
  const url = URL.createObjectURL(new Blob([plain], { type: 'text/plain' }));
  addMsg('ai', `Quiz from “${esc(folder.name)}” (${files.slice(0, 5).length} file${files.length > 1 ? 's' : ''}). Fill in the blanks:<ol>${qs.map(x => `<li>${esc(x.q)}</li>`).join('')}</ol><details><summary>Show answers</summary><ol>${qs.map(x => `<li>${esc(x.a)}</li>`).join('')}</ol></details><p class="muted">This is a simple fill-in-the-blank quiz built from your notes. Check it against your notes.</p><a class="btn small" href="${url}" download="hourglass-quiz.txt">Download as text</a>`);
}

// ---------- settings ----------
function renderSettings() {
  const p = state.profile, L = p.linked || {};
  const theme = document.documentElement.dataset.theme;
  $('#tab-settings').innerHTML = `
    <h2>Settings</h2>
    <div class="card"><h3>Appearance</h3><div class="seg" role="group" aria-label="Theme">
      <button class="${theme === 'light' ? 'on' : ''}" data-action="theme" data-t="light">Light</button>
      <button class="${theme === 'dark' ? 'on' : ''}" data-action="theme" data-t="dark">Dark</button></div></div>

    <div class="card"><h3>Nightly reminder</h3>
      <form data-form="reminder"><label for="s-time">Remind me to log my day at</label>
        <div class="row"><input id="s-time" type="time" name="time" value="${esc(p.reminderTime || '20:30')}" required><button class="primary" style="margin-top:0">Save time</button></div></form>
      <p class="muted">Free websites can't send background notifications, so pick what works for you:</p>
      <div class="stack">
        <button class="btn" data-action="ics">Add a daily reminder to my phone's calendar</button>
        <button class="btn" data-action="notify">Turn on alerts while the app is open</button>
        ${L.calendar ? '<button class="btn" data-action="gcal-reminder">Create or update the daily reminder in Google Calendar</button>' : ''}
      </div></div>

    <div class="card"><h3>Linked Google accounts</h3>
      <p class="muted">Optional. You choose what the assistant can reach, and can unlink any time.</p>
      ${Object.entries(SERVICES).map(([k, s]) => `<div class="logrow"><div><b>${esc(s.name)}</b><small>${esc(s.note)}</small></div>
        ${L[k] ? `<button class="btn small danger" data-action="unlink" data-svc="${k}">Unlink</button>` : `<button class="btn small" data-action="link" data-svc="${k}">Link</button>`}</div>`).join('')}
      <p class="muted">You may be asked to confirm with Google again each hour or so. That's normal.</p></div>

    <div class="card"><h3>Approved email recipients</h3>
      <p class="muted">The assistant can only draft emails to these addresses (for example a teacher or mentor).</p>
      ${(p.approved || []).map(a => `<div class="logrow"><span>${esc(a)}</span><button class="btn small danger" data-action="del-approved" data-addr="${esc(a)}">Remove</button></div>`).join('') || ''}
      <form data-form="recipient"><label for="s-addr">Add an address</label><div class="row"><input id="s-addr" type="email" name="addr" required><button class="primary" style="margin-top:0">Add</button></div></form></div>

    <div class="card"><h3>Change password</h3>
      <form data-form="password" autocomplete="off">
        <label for="s-cur">Current password</label><input id="s-cur" type="password" name="cur" autocomplete="current-password" required>
        <label for="s-new">New password (8+ characters)</label><input id="s-new" type="password" name="nw" autocomplete="new-password" required>
        <label for="s-new2">Confirm new password</label><input id="s-new2" type="password" name="nw2" autocomplete="new-password" required>
        <button class="primary">Change password</button></form></div>

    <div class="card"><h3>Research sharing</h3>
      <p>${p.consent ? 'You agreed to share your logs for research, under a random study code.' : 'You are not sharing data for research.'}</p>
      <p class="muted">Your study code: <b>${esc(p.participantCode)}</b> (used instead of your name or User ID).</p>
      ${p.consent ? '<button class="btn danger" data-action="research-stop">Stop sharing and remove my rows from the study sheet</button>' : '<button class="btn" data-action="research-start">I agree to share my logs for research</button>'}</div>

    <div class="card"><h3>Account</h3>
      <p class="muted">Signed in as <b>${esc(p.userId)}</b></p>
      <div class="stack"><button class="btn" data-action="logout">Log out</button><button class="btn danger" data-action="delete-account">Delete my account and data</button></div></div>`;
}

async function stopResearch() {
  if (!confirm('Stop sharing and remove all your rows from the study spreadsheet?')) return;
  localStorage.removeItem(qKey());
  await patchProfile({ consent: false });
  sendResearch({ action: 'withdraw' }, { force: true });
  toast('Sharing stopped. Your rows will be removed from the study sheet.');
  renderSettings();
}
async function startResearch() {
  const yes = await askConsent();
  if (!yes) return;
  await patchProfile({ consent: true });
  state.logs.forEach(l => sendResearch({ action: 'upsert', category: l.category, date: l.date, hours: l.hours, rating: l.rating ?? null }));
  toast('Thank you. Sharing is on.');
  renderSettings();
}
async function deleteAccount() {
  const pw = await askPassword('Delete your account?', 'This permanently deletes your logs, deadlines and account. It cannot be undone. Enter your password to continue.');
  if (!pw) return;
  const user = state.user;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
  const consented = state.profile.consent;
  const refs = [logsCol(), dlCol()];
  const docRef = uref();
  stopListeners();
  if (consented) { localStorage.removeItem(qKey()); sendResearch({ action: 'withdraw' }, { force: true }); await flushQueue(); }
  for (const col of refs) {
    const snap = await getDocs(col);
    let batch = writeBatch(db), n = 0;
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
    await batch.commit();
  }
  await deleteDoc(docRef);
  await deleteUser(user);
}

// ---------- actions (buttons) ----------
const actions = {
  authmode: b => setAuthMode(b.dataset.mode),
  cat: b => { state.cat = b.dataset.cat; renderLogForm(); renderLogList(); },
  range: b => { state.range[b.dataset.cat] = b.dataset.range; renderTrend(b.dataset.cat); },
  'del-log': async b => {
    const l = state.logs.find(x => x.id === b.dataset.id);
    if (!l || !confirm(`Delete the ${CATS[l.category].label.toLowerCase()} log for ${fmtDate(l.date)}?`)) return;
    await deleteDoc(doc(logsCol(), l.id));
    sendResearch({ action: 'delete', category: l.category, date: l.date });
    toast('Log deleted.');
  },
  'cal-prev': () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); },
  'cal-next': () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); },
  'cal-today': () => { const n = new Date(); state.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); state.calSel = todayISO(); renderCalendar(); const i = $('#d-date'); if (i) i.value = state.calSel; },
  'cal-pick': b => { state.calSel = b.dataset.date; renderCalendar(); const i = $('#d-date'); if (i) i.value = state.calSel; },
  'del-deadline': async b => {
    const d = state.deadlines.find(x => x.id === b.dataset.id);
    if (!d || !confirm(`Delete “${d.title}”?`)) return;
    await deleteDoc(doc(dlCol(), d.id));
  },
  chip: b => { const i = $('#tab-ai input[name=q]'); i.value = b.dataset.text; i.focus(); },
  theme: async b => { applyTheme(b.dataset.t); await patchProfile({ theme: b.dataset.t }); renderSettings(); },
  ics: () => downloadReminderICS(state.profile.reminderTime || '20:30'),
  notify: async () => {
    if (!('Notification' in window)) return toast('This browser does not support notifications.');
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? 'Alerts on. They only appear while the app is open.' : 'Notifications were not allowed.');
  },
  'gcal-reminder': async () => {
    const id = await G.upsertDailyReminder(state.profile.reminderTime || '20:30', state.profile.reminderEventId);
    await patchProfile({ reminderEventId: id });
    toast('Daily reminder saved in Google Calendar.');
  },
  link: async b => {
    await G.getToken(b.dataset.svc);
    await patchProfile({ linked: { ...(state.profile.linked || {}), [b.dataset.svc]: true } });
    toast(`${SERVICES[b.dataset.svc].name} linked.`);
    renderSettings();
  },
  unlink: async b => {
    G.revoke(b.dataset.svc);
    await patchProfile({ linked: { ...(state.profile.linked || {}), [b.dataset.svc]: false } });
    renderSettings();
  },
  'del-approved': async b => { await patchProfile({ approved: (state.profile.approved || []).filter(a => a !== b.dataset.addr) }); renderSettings(); },
  'approve-addr': async b => {
    const a = b.dataset.addr;
    await patchProfile({ approved: [...new Set([...(state.profile.approved || []), a])] });
    b.disabled = true;
    addMsg('ai', `${esc(a)} is approved. Ask me again to draft the email.`);
  },
  'email-send': async b => {
    const card = b.closest('.emailcard');
    const to = card.dataset.to;
    const subject = card.querySelector('[name=subject]').value.trim();
    const body = card.querySelector('[name=body]').value.trim();
    if (!subject || !body) return toast('Add a subject and a message first.');
    if (!(state.profile.approved || []).includes(to)) return toast('That address is no longer approved.');
    card.querySelectorAll('button').forEach(x => (x.disabled = true));
    try {
      await G.sendEmail({ to, subject, body });
      card.innerHTML = `<p>Sent to ${esc(to)}.</p>`;
    } catch (e) {
      card.querySelectorAll('button').forEach(x => (x.disabled = false));
      throw e;
    }
  },
  'email-cancel': b => { b.closest('.emailcard').innerHTML = '<p>Draft cancelled. Nothing was sent.</p>'; },
  'research-stop': stopResearch,
  'research-start': startResearch,
  logout: () => signOut(auth),
  'delete-account': deleteAccount
};

document.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const b = e.target.closest('[data-action]');
  if (!b || !actions[b.dataset.action]) return;
  try { await actions[b.dataset.action](b, e); } catch (err) { toast(err.message || 'Something went wrong.'); }
});

// ---------- forms ----------
const forms = {
  auth: doAuth,
  log: async f => {
    const date = f.date.value;
    const hours = Math.round(((+f.h.value || 0) + (+f.m.value || 0) / 60) * 100) / 100;
    if (!date || date > todayISO()) return toast('Pick a date that is today or earlier.');
    if (hours < 0 || hours > 24) return toast('Time must be between 0 and 24 hours.');
    const rating = f.rating && f.rating.value ? +f.rating.value : null;
    await saveLog(state.cat, date, hours, rating);
    toast('Saved.');
    f.h.value = ''; f.m.value = '0'; if (f.rating) f.rating.value = '';
    prefillLog();
  },
  deadline: async f => {
    const title = f.title.value.trim();
    if (!title) return;
    let msg = 'Deadline added.';
    try { await addDeadline({ title, date: f.date.value, time: f.time.value, gcal: !!f.gcal?.checked }); }
    catch (e) { msg = `Saved here, but Google Calendar failed: ${e.message}`; }
    f.title.value = ''; f.time.value = '';
    toast(msg);
  },
  reminder: async f => { await patchProfile({ reminderTime: f.time.value }); localStorage.removeItem('hg_notified_' + todayISO()); toast('Reminder time saved.'); },
  recipient: async f => {
    const a = f.addr.value.trim().toLowerCase();
    await patchProfile({ approved: [...new Set([...(state.profile.approved || []), a])] });
    renderSettings();
  },
  password: async f => {
    if (f.nw.value.length < 8) return toast('New password must be at least 8 characters.');
    if (f.nw.value !== f.nw2.value) return toast('The new passwords do not match.');
    try {
      await reauthenticateWithCredential(state.user, EmailAuthProvider.credential(state.user.email, f.cur.value));
      await updatePassword(state.user, f.nw.value);
      f.reset();
      toast('Password changed.');
    } catch (e) { toast(e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' ? 'Your current password is wrong.' : 'Could not change the password.'); }
  },
  ai: async f => { const t = f.q.value.trim(); f.q.value = ''; if (t) await runAI(t); }
};
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  try { await forms[f.dataset.form](f); } catch (err) { toast(err.message || 'Something went wrong.'); }
});
document.addEventListener('change', e => { if (e.target.id === 'f-date') prefillLog(); });
