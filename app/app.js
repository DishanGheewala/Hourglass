import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot, addDoc,
  serverTimestamp, getDocs, writeBatch, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, RESEARCH_URL, STUDY_KEY, ID_DOMAIN } from './config.js';
import {
  esc, pad, todayISO, addDays, fromISO, fmtDate, fmtHM, fmtTime12, normalizeId, validId, genCode, windowStats
} from './util.js';
import { chartSVG } from './charts.js';
import { buildICS } from './ics.js';
import * as G from './google.js';
import * as AI from './ai.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const CATS = {
  sleep: { label: 'Sleep', icon: 'moon', dateLabel: 'Date you woke up', ratingKey: 'Sleepiness', ratingQ: 'How sleepy did you feel this morning?', lo: '1 wide awake', hi: '10 very sleepy', blurb: 'How long you slept, and how sleepy you felt.' },
  work: { label: 'Study / Work', icon: 'work', dateLabel: 'Date', ratingKey: 'Productivity', ratingQ: 'How productive did you feel?', lo: '1 not at all', hi: '10 very productive', blurb: 'Homework, studying and work time.' },
  free: { label: 'Free time', icon: 'sun', dateLabel: 'Date', ratingKey: null, ratingQ: null, blurb: 'Time that was just yours.' }
};
const TABS = [
  { id: 'log', label: 'Log', long: 'Log your day', icon: 'log' },
  { id: 'sleep', label: 'Sleep', long: 'Sleep trend', icon: 'moon', cat: 'sleep' },
  { id: 'work', label: 'Study', long: 'Study / Work trend', icon: 'work', cat: 'work' },
  { id: 'free', label: 'Free', long: 'Free time trend', icon: 'sun', cat: 'free' },
  { id: 'calendar', label: 'Calendar', long: 'Calendar', icon: 'cal' },
  { id: 'ai', label: 'AI', long: 'AI assistant', icon: 'ai' },
  { id: 'settings', label: 'Settings', long: 'Settings', icon: 'set' }
];
const SERVICES = {
  calendar: { name: 'Google Calendar', icon: 'cal', note: 'The assistant can read your calendar and add deadlines and study sessions.' },
  gmail: { name: 'Gmail', icon: 'mail', note: 'The assistant can read and summarize your email, write emails for you to send, and tell you when someone replies.' },
  drive: { name: 'Google Drive', icon: 'drive', note: 'The assistant can read your Docs, Slides, Sheets, PDFs and Word files to make study material, and save new Docs.' }
};
const DEFAULT_ALERT = { time: '20:30', label: 'Time to log your day: sleep, study/work and free time.' };
const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const state = {
  user: null, profile: null, logs: [], deadlines: [], alerts: [], pushOn: false,
  tab: 'log', cat: 'sleep', range: { sleep: '30', work: '30', free: '30' },
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1), calSel: todayISO()
};

// ---------- small UI helpers ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 4200);
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
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch {} };

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

// ---------- research spreadsheet (only with consent) ----------
// Logs from students who said yes go to the Google Sheet in the project owner's Drive (apps-script.gs).
// Each item waits in a queue on the device until the sheet confirms it got it.
const researchReady = () => RESEARCH_URL && !String(RESEARCH_URL).startsWith('PASTE');
const qKey = () => 'hg_queue_' + state.user.uid;
const readQ = key => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
function sendResearch(item) {
  if (!state.user || !researchReady() || !state.profile?.consent) return;
  const key = qKey();
  const q = readQ(key);
  q.push({ ...item, code: state.profile.participantCode, ts: new Date().toISOString() });
  lsSet(key, JSON.stringify(q));
  flushQueue();
}
async function postResearch(item) {
  const body = JSON.stringify({ ...item, key: STUDY_KEY });
  try {
    const r = await fetch(RESEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
    const j = await r.json().catch(() => ({ ok: r.ok }));
    lsSet('hg_research_status', j.ok ? `ok ${new Date().toLocaleString()}` : `error: ${j.error || r.status}`);
    if (!j.ok) console.warn('Research sheet did not accept a row:', j.error);
    return true; // a rejected row is a bug to fix, not something to retry forever
  } catch {
    try { // some browsers hide the reply: send without reading it
      await fetch(RESEARCH_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
      lsSet('hg_research_status', `sent (unconfirmed) ${new Date().toLocaleString()}`);
      return true;
    } catch { return false; } // offline: keep it in the queue
  }
}
let flushing = false;
async function flushQueue() {
  if (flushing || !state.user || !researchReady()) return;
  flushing = true;
  const key = qKey();
  try {
    let q;
    while ((q = readQ(key)).length) {
      if (!(await postResearch(q[0]))) break;
      lsSet(key, JSON.stringify(readQ(key).slice(1)));
    }
  } finally { flushing = false; }
}
// Sends every existing log once, so logs saved before the sheet worked get copied too.
function backfillResearch() {
  const flag = 'hg_backfill_v2_' + state.user.uid;
  if (!state.profile?.consent || lsGet(flag)) return;
  sendResearch({ action: 'consent' });
  state.logs.forEach(l => sendResearch({ action: 'upsert', category: l.category, date: l.date, hours: l.hours, rating: l.rating ?? null }));
  lsSet(flag, '1');
}

// ---------- consent & password dialogs ----------
function askConsent() {
  return new Promise(resolve => {
    openModal(`
      <h2>Research consent</h2>
      <p>Hourglass is also a school research project about how students spend their time.</p>
      <p><b>If you say yes:</b> your sleep, study/work and free-time logs (hours, sleepiness and productivity ratings, and dates) are copied to a private research spreadsheet. The spreadsheet uses a random study code, never your User ID, and we collect no name, email or school account. Results are only reported as group totals, so <b>your identity will not be disclosed</b>.</p>
      <p>Your calendar, emails, files and anything you ask the AI assistant are never shared.</p>
      <p><b>It's your choice.</b> The app works exactly the same if you say no. You can stop sharing any time in Settings. Logs that were already shared stay in the study, anonymously, under your random code.</p>
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
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
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
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; }

AI.initAI({
  db, state, CATS, toast, patchProfile: p => patchProfile(p),
  saveLog: (c, d, h, r) => saveLog(c, d, h, r),
  deleteLog: l => deleteLog(l),
  addDeadline: d => addDeadline(d),
  deleteDeadline: d => deleteDoc(doc(dlCol(), d.id)),
  setAlerts: a => saveAlerts(a),
  pushEnabled: () => state.pushOn,
  notify: (title, body) => notify(title, body),
  markAI: () => { if (state.tab !== 'ai') $$('[data-tab="ai"]').forEach(b => b.classList.add('badge')); }
});

if (auth) {
  onAuthStateChanged(auth, async user => {
    stopListeners();
    if (!user) {
      state.user = null; state.profile = null; state.logs = []; state.deadlines = []; state.alerts = [];
      AI.resetAI();
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
          consent, consentAt: serverTimestamp(), theme: document.documentElement.dataset.theme,
          displayName: '', linked: {}, createdAt: serverTimestamp()
        }, { merge: true });
        snap = await getDoc(uref());
      }
      state.profile = snap.data();
      applyTheme(state.profile.theme || document.documentElement.dataset.theme);
      await loadAlerts();
      renderNav();
      show('app');
      startListeners();
      setTab(state.tab);
      flushQueue();
      checkPushOn();
      AI.loadAI();
    } catch (e) {
      console.error(e);
      toast('Could not load your account. Check your connection and refresh.');
    }
  });
} else {
  $('#boot').hidden = true;
  $('#setup-banner').hidden = false;
  show('auth');
  setAuthMode('login');
}

let firstLogs = true;
let feedTimer;
function startListeners() {
  firstLogs = true;
  unsubs.push(onSnapshot(logsCol(), snap => {
    state.logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (firstLogs) { firstLogs = false; backfillResearch(); }
    renderData();
  }, () => toast('Could not load your logs.')));
  unsubs.push(onSnapshot(dlCol(), snap => {
    state.deadlines = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    renderData();
    scheduleFeed();
  }, () => toast('Could not load your deadlines.')));
}

// ---------- navigation ----------
function navHTML(side) {
  return TABS.map(t => `<button class="navb" role="tab" data-tab="${t.id}" ${t.cat ? `data-cat="${t.cat}"` : ''} aria-selected="${t.id === state.tab}">${ic(t.icon)}<span>${esc(side ? t.long : t.label)}</span></button>`).join('');
}
function renderNav() {
  $('#nav-side').innerHTML = navHTML(true);
  $('#nav-bottom').innerHTML = navHTML(false);
  $('#who').innerHTML = `<b>${esc(state.profile.displayName || state.profile.userId)}</b><span>@${esc(state.profile.userId)}</span>`;
  $('#topdate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function setTab(tab) {
  state.tab = tab;
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  if (tab === 'log') { renderLogSkeleton(); renderLogTop(); renderLogForm(); renderLogList(); }
  else if (CATS[tab]) renderTrend(tab);
  else if (tab === 'calendar') renderCalendar();
  else if (tab === 'ai') { $$('[data-tab="ai"]').forEach(b => b.classList.remove('badge')); const l = $('#ai-log'); l.scrollTop = l.scrollHeight; }
  else if (tab === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}
function renderData() {
  if (state.tab === 'log') { renderLogTop(); renderLogList(); }
  else if (CATS[state.tab]) renderTrend(state.tab);
  else if (state.tab === 'calendar') renderCalendar();
}

// ---------- log tab ----------
const todayLog = c => state.logs.find(l => l.id === `${c}_${todayISO()}`);
function renderLogSkeleton() {
  if ($('#log-top')) return;
  $('#tab-log').innerHTML = '<div id="log-top"></div><div id="log-form"></div><div id="log-list"></div>';
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function renderLogTop() {
  const name = (state.profile.displayName || '').split(' ')[0];
  const done = Object.keys(CATS).filter(c => todayLog(c)).length;
  $('#log-top').innerHTML = `
    <div class="hello"><p class="eyebrow">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
      <h2>${greeting()}${name ? ', ' + esc(name) : ''}</h2>
      <p>${done === 3 ? 'All three logged for today. Nice work!' : done === 0 ? 'Log your day in under a minute.' : `${done} of 3 logged today. Keep going!`}</p></div>
    <div class="tiles">${Object.entries(CATS).map(([k, c]) => {
      const l = todayLog(k);
      return `<button class="tile ${state.cat === k ? 'sel' : ''}" data-cat="${k}" data-action="cat" data-c="${k}"><span class="ti">${ic(c.icon)}</span><b class="${l ? 'done' : ''}">${l ? esc(fmtHM(l.hours)) : '—'}</b><small>${esc(c.label)}${l ? ' ✓' : ''}</small></button>`;
    }).join('')}</div>`;
}
function renderLogForm() {
  const c = CATS[state.cat];
  const date = $('#f-date')?.value || todayISO();
  $('#log-form').innerHTML = `
    <form data-form="log" class="card formcard" data-cat="${state.cat}">
      <div class="formhead"><span class="ti">${ic(c.icon)}</span><div><h3>Log ${esc(c.label.toLowerCase())}</h3><p class="muted">${esc(c.blurb)}</p></div></div>
      <label for="f-date">${esc(c.dateLabel)}</label>
      <input id="f-date" type="date" name="date" value="${esc(date)}" max="${todayISO()}" required>
      <div class="dayq"><button type="button" class="chip" data-action="day" data-d="0">Today</button><button type="button" class="chip" data-action="day" data-d="-1">Yesterday</button></div>
      <div class="row big" style="margin-top:6px">
        <div><label for="f-h">Hours</label><input id="f-h" name="h" type="number" min="0" max="24" step="1" inputmode="numeric" placeholder="0" required></div>
        <div><label for="f-m">Minutes</label><input id="f-m" name="m" type="number" min="0" max="59" step="1" inputmode="numeric" value="0"></div>
      </div>
      ${c.ratingQ ? `<label>${esc(c.ratingQ)} <span class="muted">(optional)</span></label>
        <input type="hidden" name="rating" value="">
        <div class="scale" role="group" aria-label="${esc(c.ratingKey)}">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-action="rate" data-v="${i + 1}" aria-label="${i + 1}">${i + 1}</button>`).join('')}</div>
        <div class="scalehint"><span>${esc(c.lo)}</span><span>${esc(c.hi)}</span></div>` : ''}
      <p class="muted" id="f-note" style="margin-top:12px"></p>
      <button class="primary">${ic('check')} Save</button>
    </form>`;
  prefillLog();
}
function setRating(f, v) {
  if (!f.rating) return;
  f.rating.value = v || '';
  $$('.scale button', f).forEach(b => b.classList.toggle('on', +b.dataset.v === +v));
}
function prefillLog() {
  const f = $('#log-form form');
  if (!f) return;
  const ex = state.logs.find(l => l.id === `${state.cat}_${f.date.value}`);
  if (ex) {
    const t = Math.round(ex.hours * 60);
    f.h.value = Math.floor(t / 60); f.m.value = t % 60;
    setRating(f, ex.rating);
  }
  $('#f-note').textContent = ex ? 'You already logged this day. Saving will update it.' : '';
}
function renderLogList() {
  const c = CATS[state.cat];
  const rows = state.logs.filter(l => l.category === state.cat).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  $('#log-list').innerHTML = `<div class="card" data-cat="${state.cat}"><h3>${ic(c.icon)} Your ${esc(c.label.toLowerCase())} logs</h3>${rows.length
    ? rows.map(l => `<div class="logrow"><div><b>${esc(fmtDate(l.date))}</b>: ${esc(fmtHM(l.hours))}${c.ratingKey && l.rating != null ? `<small>${esc(c.ratingKey)} ${l.rating}/10</small>` : ''}</div><button class="icon-btn" data-action="del-log" data-id="${esc(l.id)}" aria-label="Delete log for ${esc(fmtDate(l.date))}">${ic('trash', 'sm')}</button></div>`).join('')
    : `<div class="empty">${ic('chart')}<p>Nothing logged yet.</p></div>`}</div>`;
}
async function saveLog(cat, date, hours, rating) {
  await setDoc(doc(logsCol(), `${cat}_${date}`), { category: cat, date, hours, rating: rating ?? null, updatedAt: serverTimestamp() });
  sendResearch({ action: 'upsert', category: cat, date, hours, rating: rating ?? null });
}
// Deleting a log removes it from the app. In the research sheet the row is kept and only marked
// "Deleted in app", so data that was already collected is never lost.
async function deleteLog(l) {
  await deleteDoc(doc(logsCol(), l.id));
  sendResearch({ action: 'delete', category: l.category, date: l.date });
}

// ---------- trend tabs ----------
function renderTrend(cat) {
  const c = CATS[cat];
  const today = todayISO();
  const pts = state.logs.filter(l => l.category === cat);
  const range = state.range[cat];
  const stats = windowStats(pts, range === 'all' ? null : +range, today);
  const rangeBtns = [['7', '7 days'], ['30', '30 days'], ['all', 'All time']].map(([v, t]) => `<button class="${range === v ? 'on' : ''}" data-action="range" data-cat="${cat}" data-range="${v}">${t}</button>`).join('');
  const hoursSVG = chartSVG({ points: pts, range, today, field: 'hours', tone: cat, label: `${c.label} hours per day` });
  const rateSVG = c.ratingKey ? chartSVG({ points: pts, range, today, field: 'rating', tone: 'rating', label: `${c.ratingKey} per day` }) : '';
  const win = pts.filter(p => range === 'all' || (p.date >= addDays(today, -(+range - 1)) && p.date <= today)).sort((a, b) => b.date.localeCompare(a.date));
  const insight = cat === 'sleep' && stats.avgHours != null
    ? (stats.avgHours < 8 ? `Teens need about 8–10 hours of sleep. You average ${fmtHM(stats.avgHours)}, so there's room to sleep a bit more.` : `You average ${fmtHM(stats.avgHours)}, which is in the healthy 8–10 hour range for teens. Nice.`) : '';
  $('#tab-' + cat).innerHTML = `
    <div class="pagehead" data-cat="${cat}"><span class="ico">${ic(c.icon)}</span><div><h2>${esc(c.label)}</h2><p>${esc(c.blurb)}</p></div></div>
    <div class="seg" role="group" aria-label="Time range">${rangeBtns}</div>
    <div class="stats" data-cat="${cat}">
      <div class="stat"><b>${stats.avgHours == null ? '–' : esc(fmtHM(stats.avgHours))}</b><span>Average per day</span></div>
      <div class="stat"><b>${stats.count}</b><span>Days logged</span></div>
      ${c.ratingKey ? `<div class="stat" data-cat="rating"><b>${stats.avgRating == null ? '–' : stats.avgRating.toFixed(1)}</b><span>Avg ${esc(c.ratingKey.toLowerCase())} /10</span></div>` : '<div class="stat"><b>' + (pts.length) + '</b><span>Total days</span></div>'}
    </div>
    ${insight ? `<div class="insight" data-cat="${cat}">${ic('info')}<span>${esc(insight)}</span></div>` : ''}
    ${hoursSVG ? `<div class="card chartwrap"><h3>Hours per day</h3>${hoursSVG}</div>` : `<div class="card"><div class="empty">${ic('chart')}<p>No ${esc(c.label.toLowerCase())} logs in this range yet.</p><button class="btn small" style="margin-top:10px" data-action="goto" data-t="log">Add a log</button></div></div>`}
    ${rateSVG ? `<div class="card chartwrap"><h3>${esc(c.ratingKey)} (1–10)</h3>${rateSVG}</div>` : ''}
    ${win.length ? `<details><summary>Show as a table</summary><table><thead><tr><th>Date</th><th>Time</th>${c.ratingKey ? `<th>${esc(c.ratingKey)}</th>` : ''}</tr></thead><tbody>${win.map(l => `<tr><td>${esc(fmtDate(l.date))}</td><td>${esc(fmtHM(l.hours))}</td>${c.ratingKey ? `<td>${l.rating ?? '–'}</td>` : ''}</tr>`).join('')}</tbody></table></details>` : ''}`;
}

// ---------- calendar ----------
function renderCalendar() {
  const L = state.profile.linked || {};
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
  const row = d => {
    const dt = fromISO(d.date);
    const soon = d.date >= today && d.date <= addDays(today, 3);
    return `<div class="dl ${soon ? 'soon' : ''}"><div class="when"><b>${dt.getDate()}</b><span>${dt.toLocaleDateString(undefined, { month: 'short' })}</span></div><div><b>${esc(d.title)}</b><small>${esc(fmtDate(d.date))}${d.time ? ' · ' + esc(fmtTime12(d.time)) : ''}</small></div><button class="icon-btn" data-action="del-deadline" data-id="${esc(d.id)}" aria-label="Delete ${esc(d.title)}">${ic('trash', 'sm')}</button></div>`;
  };
  const up = state.deadlines.filter(d => d.date >= today);
  const old = state.deadlines.filter(d => d.date < today).slice(-5).reverse();
  // Keep what the student is typing if the list refreshes while the form is open.
  const keep = { t: $('#d-title')?.value || '', time: $('#d-time')?.value || '' };
  $('#tab-calendar').innerHTML = `
    <div class="pagehead"><span class="ico">${ic('cal')}</span><div><h2>Calendar</h2><p>Deadlines and due dates.</p></div></div>
    <div class="card"><div class="calhead"><button class="icon-btn" data-action="cal-prev" aria-label="Previous month">${ic('left')}</button>
      <b>${esc(state.calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</b>
      <span><button class="btn small" data-action="cal-today">Today</button> <button class="icon-btn" style="display:inline-grid;vertical-align:middle" data-action="cal-next" aria-label="Next month">${ic('right')}</button></span></div>
      <div class="cal">${cells}</div></div>
    <form data-form="deadline" class="card"><h3>${ic('plus')} Add a deadline</h3>
      <label for="d-title">What is due?</label><input id="d-title" name="title" maxlength="100" placeholder="Bio test, essay draft…" value="${esc(keep.t)}" required>
      <div class="row"><div><label for="d-date">Date</label><input id="d-date" type="date" name="date" value="${esc(state.calSel)}" required></div>
      <div><label for="d-time">Time (optional)</label><input id="d-time" type="time" name="time" value="${esc(keep.time)}"></div></div>
      ${L.calendar ? '<label class="check"><input type="checkbox" name="gcal" checked> Also add a copy to my Google Calendar</label>' : ''}
      <button class="primary">${ic('plus')} Add deadline</button></form>
    <div class="card"><h3>Upcoming</h3>${up.length ? up.map(row).join('') : `<div class="empty">${ic('cal')}<p>No upcoming deadlines.</p></div>`}</div>
    ${old.length ? `<div class="card"><h3>Past</h3>${old.map(row).join('')}</div>` : ''}
    <p class="muted" style="text-align:center">Want these on your iPhone? Settings → Apple Calendar.</p>`;
}
async function addDeadline({ title, date, time, gcal }) {
  await addDoc(dlCol(), { title, date, time: time || '', createdAt: serverTimestamp() });
  if (gcal) await G.addCalendarEvent({ title: `Due: ${title}`, date, time });
}

// ---------- reminder alerts (push notifications that work when the app is closed) ----------
// Everything lives on the student's own profile document, so no extra database setup is needed.
async function loadAlerts() {
  if (Array.isArray(state.profile.alerts)) { state.alerts = state.profile.alerts; return; }
  state.alerts = [{ ...DEFAULT_ALERT, time: state.profile.reminderTime || DEFAULT_ALERT.time }];
  try { await patchProfile({ alerts: state.alerts, tz: tzName() }); } catch (e) { console.warn('alerts', e); }
}
async function saveAlerts(alerts) {
  const clean = [...new Map(alerts.filter(a => /^\d{2}:\d{2}$/.test(a.time)).map(a => [a.time, a])).values()].sort((a, b) => a.time.localeCompare(b.time));
  await patchProfile({ alerts: clean, tz: tzName() });
  state.alerts = clean;
  if (state.tab === 'settings') renderSettings();
}
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const swReg = () => navigator.serviceWorker.register('sw.js', { scope: './' });
async function saveSub(sub) {
  await updateDoc(uref(), { subs: arrayUnion(JSON.parse(JSON.stringify(sub))), tz: tzName() });
}
async function checkPushOn() {
  state.pushOn = false;
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await swReg();
    const sub = await reg.pushManager.getSubscription();
    state.pushOn = !!sub;
    if (sub) await saveSub(sub);
  } catch {}
  if (state.tab === 'settings') renderSettings();
}
const b64ToBytes = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
async function enablePush() {
  if (isIOS() && !isStandalone()) {
    openModal(`<h2>One step first on iPhone</h2><p>Apple only allows alerts for apps on your Home Screen.</p><ol><li>Tap the <b>Share</b> button in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open Hourglass from your Home Screen, log in, and turn on alerts here again.</li></ol><button class="primary" data-action="close-modal">Got it</button>`);
    return;
  }
  if (!pushSupported()) return toast('This browser does not support alerts. Try Chrome, Edge, Firefox or Safari.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Alerts were blocked. Allow notifications for this site in your browser settings.');
  const kr = await fetch('/api/push-key');
  const kj = await kr.json().catch(() => ({}));
  if (!kr.ok) throw new Error(kj.error || 'Alerts are not set up on the server yet (SETUP.md, step 5).');
  const reg = await swReg();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(kj.key) });
  await saveSub(sub);
  state.pushOn = true;
  toast('Alerts are on for this device.');
  renderSettings();
}
async function testPush() {
  const token = await state.user.getIdToken();
  const r = await fetch('/api/push-test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  toast(r.ok ? `Test alert sent to ${j.sent} device${j.sent === 1 ? '' : 's'}.` : j.error || 'Could not send a test alert.');
}
async function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { const reg = await swReg(); await reg.showNotification(title, { body, icon: 'icon.svg', tag: 'hg-reply' }); return; } catch {}
  }
  toast(title);
}
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

// ---------- Apple Calendar (free): a private subscription link ----------
function randomToken() { const b = new Uint8Array(24); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function writeFeed() {
  const t = state.profile?.calToken;
  if (!t) return;
  await setDoc(doc(db, 'feeds', t), { uid: state.user.uid, ics: buildICS(state.deadlines), updatedAt: serverTimestamp() });
}
function scheduleFeed() {
  if (!state.profile?.calToken) return;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => writeFeed().catch(e => console.warn('calendar feed', e)), 700);
}
async function calFeedUrl(proto = 'webcal') {
  if (!state.profile.calToken) await patchProfile({ calToken: randomToken() });
  try { await writeFeed(); }
  catch (e) { console.warn(e); throw new Error('Could not create the calendar link. Publish the new Firebase rules first (SETUP.md, step 1).'); }
  return `${proto}://${location.host}/api/calendar?token=${state.profile.calToken}`;
}

// ---------- settings ----------
function renderSettings() {
  const p = state.profile, L = p.linked || {};
  const theme = document.documentElement.dataset.theme;
  const notes = AI.getNotes();
  const status = lsGet('hg_research_status');
  $('#tab-settings').innerHTML = `
    <div class="pagehead"><span class="ico">${ic('set')}</span><div><h2>Settings</h2><p>Signed in as @${esc(p.userId)}</p></div></div>

    <p class="setgrp">You</p>
    <div class="card"><h3>${ic('user')} Your name</h3>
      <p class="muted">The assistant uses this to sign your emails (for example "Priya Shah").</p>
      <form data-form="name"><div class="row" style="margin-top:8px"><input name="name" maxlength="60" value="${esc(p.displayName || '')}" autocomplete="name" aria-label="Your name"><button class="primary">Save</button></div></form></div>
    <div class="card"><h3>Appearance</h3><div class="seg" role="group" aria-label="Theme">
      <button class="${theme === 'light' ? 'on' : ''}" data-action="theme" data-t="light">☀️ Light</button>
      <button class="${theme === 'dark' ? 'on' : ''}" data-action="theme" data-t="dark">🌙 Dark</button></div></div>

    <p class="setgrp">Reminders</p>
    <div class="card"><h3>${ic('bell')} Reminder alerts</h3>
      <p class="muted">Add as many as you like. The first one is your nightly reminder to log sleep, homework/study time and free time.</p>
      <form data-form="alerts">
        ${state.alerts.map((a, i) => `<div class="alertrow"><input type="time" name="t${i}" value="${esc(a.time)}" aria-label="Alert time" required><input name="l${i}" value="${esc(a.label || '')}" maxlength="120" placeholder="Message" aria-label="Alert message"><button type="button" class="icon-btn" data-action="alert-del" data-i="${i}" aria-label="Remove alert">${ic('trash', 'sm')}</button></div>`).join('') || '<p class="muted">No alerts yet.</p>'}
        <div class="row" style="margin-top:12px"><button type="button" class="btn" data-action="alert-add">${ic('plus', 'sm')} Add an alert</button><button class="primary">Save alerts</button></div>
      </form>
      <div class="stack">
        ${state.pushOn
          ? `<p class="okline">${ic('check', 'sm')} Alerts are on for this device, even when the app is closed.</p><button class="btn" data-action="push-test">Send me a test alert</button>`
          : `<button class="primary" style="margin-top:4px" data-action="push-on">${ic('bell')} Turn on alerts for this device</button>`}
        ${isIOS() && !isStandalone() ? '<p class="muted">On iPhone, add Hourglass to your Home Screen first (Share → Add to Home Screen).</p>' : ''}
        <button class="btn" data-action="ics">Also add the nightly reminder to my phone's calendar</button>
      </div></div>

    <p class="setgrp">Connections</p>
    <div class="card"><h3>Linked Google accounts</h3>
      <p class="muted">Optional. Link these so the assistant can use them when it needs to. You can unlink any time.</p>
      ${Object.entries(SERVICES).map(([k, s]) => `<div class="svcrow"><div class="si">${ic(s.icon)}</div><div><b>${esc(s.name)}</b><small>${esc(s.note)}</small></div>
        ${L[k] ? `<button class="btn small danger" data-action="unlink" data-svc="${k}">Unlink</button>` : `<button class="btn small" data-action="link" data-svc="${k}">Link</button>`}</div>`).join('')}
      <p class="muted" style="margin-top:8px">Google may ask you to confirm again about once an hour. That's normal.</p></div>
    <div class="card"><h3>${ic('cal')} Apple Calendar (iPhone, iPad, Mac)</h3>
      <p class="muted">Free. Your Hourglass deadlines show up in Apple Calendar and update by themselves, with an alert the day before.</p>
      <div class="stack"><button class="btn" data-action="apple-sub">Subscribe on this device</button><button class="btn" data-action="apple-copy">Copy the calendar link</button></div>
      <details><summary>How to add it by hand</summary><p class="muted">On iPhone: Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar, then paste the link. Keep the link private: anyone with it can see your deadlines.</p></details></div>
    <div class="card"><h3>${ic('ai')} What the assistant remembers</h3>
      ${notes.length ? notes.map((n, i) => `<div class="logrow"><span>${esc(n)}</span><button class="btn small" data-action="note-del" data-i="${i}">Forget</button></div>`).join('') : '<p class="muted">Nothing yet. It saves short notes as it learns how you work.</p>'}
      <button class="btn" data-action="ai-new" style="margin-top:12px">Start a new chat</button></div>

    <p class="setgrp">Account</p>
    <div class="card"><h3>${ic('lock')} Change password</h3>
      <form data-form="password" autocomplete="off">
        <label for="s-cur">Current password</label><input id="s-cur" type="password" name="cur" autocomplete="current-password" required>
        <label for="s-new">New password (8+ characters)</label><input id="s-new" type="password" name="nw" autocomplete="new-password" required>
        <label for="s-new2">Confirm new password</label><input id="s-new2" type="password" name="nw2" autocomplete="new-password" required>
        <button class="primary">Change password</button></form></div>
    <div class="card"><h3>Research sharing</h3>
      <p>${p.consent ? 'You agreed to share your logs for research, under a random study code.' : 'You are not sharing data for research.'}</p>
      <p class="muted">Your study code: <b>${esc(p.participantCode)}</b> (used instead of your name or User ID).${p.consent && status ? ` Last sync: ${esc(status)}.` : ''}</p>
      <div class="stack">${p.consent ? '<button class="btn" data-action="research-test">Test the spreadsheet connection</button><button class="btn" data-action="research-stop">Stop sharing new logs</button>' : '<button class="btn" data-action="research-start">I agree to share my logs for research</button>'}</div></div>
    <div class="card"><h3>Account</h3>
      <div class="stack"><button class="btn" data-action="logout">Log out</button><button class="btn danger" data-action="delete-account">Delete my account and data</button></div></div>`;
}

async function stopResearch() {
  if (!confirm('Stop sharing new logs for research? Logs you already shared stay in the study, anonymously.')) return;
  lsDel(qKey());
  await patchProfile({ consent: false });
  toast('Sharing stopped. New logs will stay private.');
  renderSettings();
}
async function startResearch() {
  const yes = await askConsent();
  if (!yes) return;
  await patchProfile({ consent: true });
  sendResearch({ action: 'consent' });
  state.logs.forEach(l => sendResearch({ action: 'upsert', category: l.category, date: l.date, hours: l.hours, rating: l.rating ?? null }));
  toast('Thank you. Sharing is on.');
  renderSettings();
}
// Deletes everything in the app. Rows already in the research spreadsheet are not touched.
async function deleteAccount() {
  const pw = await askPassword('Delete your account?', 'This permanently deletes your logs, deadlines, chats, reminders and account from Hourglass. It cannot be undone. Enter your password to continue.');
  if (!pw) return;
  const user = state.user;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
  const uid = user.uid;
  const feedToken = state.profile?.calToken;
  stopListeners();
  lsDel(qKey());
  for (const name of ['logs', 'deadlines', 'ai']) {
    try {
      const snap = await getDocs(collection(db, 'users', uid, name));
      let batch = writeBatch(db), n = 0;
      for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
      await batch.commit();
    } catch (e) { console.warn('delete', name, e); }
  }
  if (feedToken) await deleteDoc(doc(db, 'feeds', feedToken)).catch(() => {});
  await deleteDoc(doc(db, 'users', uid));
  try { const reg = await navigator.serviceWorker?.getRegistration(); const s = await reg?.pushManager.getSubscription(); await s?.unsubscribe(); } catch {}
  G.forgetAllTokens();
  await deleteUser(user);
  toast('Your account and app data were deleted.');
}

// ---------- actions (buttons) ----------
const actions = {
  authmode: b => setAuthMode(b.dataset.mode),
  goto: b => setTab(b.dataset.t),
  cat: b => { state.cat = b.dataset.c; renderLogTop(); renderLogForm(); renderLogList(); },
  day: b => { const i = $('#f-date'); i.value = addDays(todayISO(), +b.dataset.d); prefillLog(); },
  rate: b => { const f = b.closest('form'); setRating(f, +f.rating.value === +b.dataset.v ? 0 : +b.dataset.v); },
  range: b => { state.range[b.dataset.cat] = b.dataset.range; renderTrend(b.dataset.cat); },
  'del-log': async b => {
    const l = state.logs.find(x => x.id === b.dataset.id);
    if (!l || !confirm(`Delete the ${CATS[l.category].label.toLowerCase()} log for ${fmtDate(l.date)}?`)) return;
    await deleteLog(l);
    toast('Log deleted.');
  },
  'cal-prev': () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderCalendar(); },
  'cal-next': () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderCalendar(); },
  'cal-today': () => { const n = new Date(); state.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); state.calSel = todayISO(); renderCalendar(); },
  'cal-pick': b => { state.calSel = b.dataset.date; renderCalendar(); },
  'del-deadline': async b => {
    const d = state.deadlines.find(x => x.id === b.dataset.id);
    if (!d || !confirm(`Delete “${d.title}”?`)) return;
    await deleteDoc(doc(dlCol(), d.id));
  },
  chip: b => AI.ask(b.dataset.text),
  theme: async b => { applyTheme(b.dataset.t); await patchProfile({ theme: b.dataset.t }); renderSettings(); },
  ics: () => downloadReminderICS(state.alerts[0]?.time || DEFAULT_ALERT.time),
  'push-on': enablePush,
  'push-test': testPush,
  'alert-add': () => { readAlertForm(); state.alerts.push({ time: '07:00', label: '' }); renderSettings(); },
  'alert-del': async b => { readAlertForm(); state.alerts.splice(+b.dataset.i, 1); await saveAlerts(state.alerts); toast('Alert removed.'); },
  'close-modal': closeModal,
  'apple-sub': async () => { location.href = await calFeedUrl('webcal'); },
  'apple-copy': async () => {
    const url = await calFeedUrl('https');
    try { await navigator.clipboard.writeText(url); toast('Link copied. Keep it private.'); } catch { prompt('Copy this link:', url); }
  },
  'note-del': async b => { await AI.removeNote(+b.dataset.i); renderSettings(); },
  link: async b => {
    await G.getToken(b.dataset.svc);
    await patchProfile({ linked: { ...(state.profile.linked || {}), [b.dataset.svc]: true } });
    toast(`${SERVICES[b.dataset.svc].name} linked.`);
    if (b.dataset.svc === 'gmail') AI.startReplyWatch();
    renderSettings();
  },
  unlink: async b => {
    G.revoke(b.dataset.svc);
    await patchProfile({ linked: { ...(state.profile.linked || {}), [b.dataset.svc]: false } });
    renderSettings();
  },
  'research-test': async () => {
    if (!state.profile.consent) throw new Error('Turn on research sharing first.');
    if (!researchReady()) throw new Error('RESEARCH_URL is not set in config.js.');
    let j;
    try {
      const r = await fetch(RESEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify({ action: 'consent', code: state.profile.participantCode, key: STUDY_KEY }) });
      j = await r.json();
    } catch { throw new Error('Could not reach the spreadsheet script. In Apps Script: Deploy → Manage deployments → check "Who has access" is Anyone, then deploy a New version.'); }
    if (j.ok) { lsSet('hg_research_status', `ok ${new Date().toLocaleString()}`); toast('Connected ✓ The spreadsheet script is working.'); backfillResearch(); renderSettings(); }
    else if (j.error === 'bad key') throw new Error('The spreadsheet script answered "bad key": the live version is old or its STUDY_KEY differs. Deploy → Manage deployments → pencil → New version → Deploy.');
    else throw new Error('The spreadsheet script answered: ' + (j.error || 'unknown error'));
  },
  'research-stop': stopResearch,
  'research-start': startResearch,
  logout: () => { G.forgetAllTokens(); signOut(auth); },
  'delete-account': deleteAccount,
  ...AI.aiActions
};
function readAlertForm() {
  const f = $('form[data-form="alerts"]');
  if (!f) return;
  state.alerts = state.alerts.map((a, i) => ({ time: f[`t${i}`]?.value || a.time, label: f[`l${i}`]?.value.trim() ?? a.label }));
}

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
    toast('Saved ✓');
    f.h.value = ''; f.m.value = '0'; setRating(f, 0);
    prefillLog();
  },
  deadline: async f => {
    const title = f.title.value.trim();
    if (!title) return;
    let msg = 'Deadline added ✓';
    try { await addDeadline({ title, date: f.date.value, time: f.time.value, gcal: !!f.gcal?.checked }); }
    catch (e) { msg = `Saved here, but Google Calendar failed: ${e.message}`; }
    f.title.value = ''; f.time.value = '';
    toast(msg);
  },
  name: async f => { await patchProfile({ displayName: f.name.value.trim() }); renderNav(); toast('Name saved.'); },
  alerts: async () => { readAlertForm(); await saveAlerts(state.alerts); toast(state.pushOn ? 'Alerts saved.' : 'Alerts saved. Turn on alerts for this device to get them.'); },
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
  ai: async f => { const t = f.q.value.trim(); f.q.value = ''; f.q.style.height = ''; if (t) await AI.ask(t); }
};
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  try { await forms[f.dataset.form](f); } catch (err) { toast(err.message || 'Something went wrong.'); }
});
document.addEventListener('change', e => { if (e.target.id === 'f-date') prefillLog(); });
// Chat box: Enter sends, Shift+Enter makes a new line; the box grows as you type.
document.addEventListener('keydown', e => {
  if (e.target.matches('#tab-ai textarea[name=q]') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
});
document.addEventListener('input', e => {
  if (e.target.matches('#tab-ai textarea[name=q]')) { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px'; }
});
window.addEventListener('online', () => state.user && flushQueue());
